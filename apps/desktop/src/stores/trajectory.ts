/** 轨迹（WP7，docs/04 §1.10）：get_entries 快照 + 实时 commit 追加，per-tab 行缓冲 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { cmd } from '@/lib/ipc';
import { turnFailure } from '@/lib/turnFailure';
import { formatExactTokens, formatTokens } from '@/lib/tokenFormat';
import type { AgentMessage } from '@piggy/pi-protocol';

export type TrajKind =
  | 'user'
  | 'assistant'
  | 'tool'
  | 'system'
  | 'context_edit'
  | 'compaction'
  | 'label'
  | 'other';

export interface TrajRow {
  id: string;
  kind: TrajKind;
  /** 单行摘要（表格里永远一行，超长省略号） */
  text: string;
  /** 展开后的正文；有它才可展开 */
  detail?: string;
  ts?: number;
  running?: boolean;
  /** 有 detail 可展开（system 的 sections 正文、超长的助手回复） */
  expandable?: boolean;
  /** 这一轮以失败告终（pi `stopReason:"error"`）——表格里标红，见 lib/turnFailure.ts */
  failed?: boolean;
}

interface TrajectoryState {
  rows: Record<string, TrajRow[]>;
  loaded: Record<string, boolean>;
  /** 正在进行的压缩占位行 id（`compaction_start` 建、`compaction_end` 收）——
   *  一次压缩的三个事件据此落在**同一行**上（见 `appendCommit`）。 */
  pendingCompaction: Record<string, string | undefined>;
  load(tabId: string): Promise<void>;
  appendCommit(tabId: string, ev: { type: string } & Record<string, unknown>): void;
  clear(tabId: string): void;
}

let seq = 0;
const rid = () => `traj-${Date.now()}-${seq++}`;

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const t = (b as { type?: string }).type;
        if (t === 'text') return (b as { text?: string }).text ?? '';
        if (t === 'toolCall')
          return `${(b as { name?: string }).name} ${JSON.stringify((b as { arguments?: unknown }).arguments ?? {}).slice(0, 160)}`;
        return '';
      })
      .filter(Boolean)
      .join('  ');
  }
  return '';
}

/**
 * system 消息正文提取：pi 的 system 消息 content 常为空串，
 * 实际上下文在 `sections`（preamble/tools/rules/docs/project_context/skills/cwd…）。
 */
function systemParts(m: AgentMessage | undefined): { text: string; detail?: string } {
  const sm = (m ?? {}) as { content?: unknown; sections?: Record<string, string> };
  const sections = sm.sections ?? {};
  const keys = Object.keys(sections).filter((k) => sections[k]);
  const primary = textOf(sm.content).trim() || (sections['preamble'] ?? '').trim() || keys.map((k) => sections[k]!).join('\n').trim();
  if (!primary && keys.length === 0) return { text: '(系统上下文)' };
  const summary =
    primary.slice(0, 200) + (primary.length > 200 ? '…' : '') + (keys.length > 0 ? `（${keys.length} 节：${keys.join('/')}）` : '');
  const detail =
    keys.length > 0
      ? keys.map((k) => `【${k}】\n${sections[k]!}`).join('\n\n')
      : textOf(sm.content) || undefined;
  return { text: summary, detail };
}

function systemRow(e: Record<string, unknown>): TrajRow {
  const m = e.message as AgentMessage | undefined;
  const { text, detail } = systemParts(m);
  const ts = Date.parse(String(e.timestamp ?? '')) || undefined;
  return { id: rid(), kind: 'system', text, detail, ts, expandable: !!detail };
}

/** 表格里一行放得下的宽度（约 160 个半角字符）——超过才值得展开。 */
const ASSISTANT_INLINE_MAX = 160;

/**
 * 助手行。
 *
 * 这里以前只产出 `{id, kind, text, ts}`，**从不设置 `detail`/`expandable`**，
 * 于是 `TrajectoryView` 里那条 `isAssistant && row.expandable` 的折叠分支永远不成立、
 * 工具栏的「调用」开关也没有任何东西可折。现在长回复给出 `detail`（完整正文），
 * 表格里保留一行摘要。
 *
 * 失败/中断回合（`content` 为空、只有 `stopReason` + `errorMessage`）也必须在这里落地：
 * 否则轨迹里同样只会出现一行空白——转写与轨迹是两套渲染，两处都得管。
 */
function assistantRow(m: AgentMessage | undefined, ts: number | undefined): TrajRow {
  const failure = turnFailure(m);
  if (failure) {
    // 摘要行给结论 + 原始错误的第一行；展开看全文与可能原因。
    const detail = [failure.hint ? `可能原因：${failure.hint}` : '', failure.detail]
      .filter(Boolean)
      .join('\n\n');
    const head = failure.detail || failure.hint || '';
    return {
      id: rid(),
      kind: 'assistant',
      text: head ? `${failure.title}：${head}` : failure.title,
      detail: detail || undefined,
      ts,
      expandable: !!detail,
      failed: failure.kind === 'error',
    };
  }
  const full = textOf(m?.content);
  const long = full.length > ASSISTANT_INLINE_MAX;
  return {
    id: rid(),
    kind: 'assistant',
    text: long ? `${full.slice(0, ASSISTANT_INLINE_MAX)}…` : full,
    detail: long ? full : undefined,
    ts,
    expandable: long,
  };
}

/**
 * 压缩行（用户 2026-09-23："上下文压缩的轨迹无法看到细节"）。
 *
 * 此前这里只有一行 `{kind:'compaction', text:'上下文压缩'}` —— **没有 `detail`、
 * 也没有 `expandable`**，所以轨迹里那一行连点都点不开；而 pi 的 `CompactionEntry`
 * （pi `docs/compaction.md` §CompactionEntry Structure）本来带着能回答
 * "这次压缩到底做了什么"的全部字段：
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `summary` | 摘要正文（结构化 markdown） |
 * | `tokensBefore` | 压缩前的上下文 token |
 * | `firstKeptEntryId` | 保留边界：从哪一条起**原样保留**，之前都被摘要取代 |
 * | `details` | 默认实现记录 `readFiles` / `modifiedFiles` |
 * | `usage` | 生成摘要那次 LLM 调用的用量与花费 |
 * | `fromHook` | 摘要来自扩展而不是 pi 自己生成 |
 *
 * 实时路径还多一个 `estimatedTokensAfter`（只存在于 `compaction_end.result`，
 * 不落盘）——有就一起显示。
 *
 * 数字口径：token 数走 `lib/tokenFormat` 的 `formatTokens`（3 位小数，与状态行同源），
 * **不在这里自己 `toLocaleString`**（同一组数字只允许有一个格式化出口）。
 */
interface CompactionLike {
  summary?: unknown;
  tokensBefore?: unknown;
  firstKeptEntryId?: unknown;
  estimatedTokensAfter?: unknown;
  usage?: unknown;
  details?: unknown;
  fromHook?: unknown;
}

/** 触发原因（pi `compaction_start/end` 的 `reason`，`agent-session.d.ts:55`）。 */
const COMPACT_REASON: Record<string, string> = {
  manual: '手动 /compact',
  threshold: '超出阈值自动压缩',
  overflow: '上下文溢出恢复',
};

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** 一行摘要：`上下文压缩 · 此前 561.660K tok → 约 18.204K tok`。 */
function compactionHead(c: CompactionLike, opts: { running?: boolean; reason?: string } = {}): string {
  if (opts.running) {
    const why = opts.reason ? COMPACT_REASON[opts.reason] ?? opts.reason : '';
    return `正在压缩上下文…${why ? `（${why}）` : ''}`;
  }
  const before = asNumber(c.tokensBefore);
  const after = asNumber(c.estimatedTokensAfter);
  const parts = ['上下文已压缩'];
  if (before != null) parts.push(`此前 ${formatTokens(before)} tok`);
  if (after != null) parts.push(`→ 约 ${formatTokens(after)} tok`);
  return parts.join(' · ');
}

/** 展开后的正文：把上面那张表逐条摊开，最后接摘要全文。 */
function compactionDetail(c: CompactionLike, opts: { reason?: string; fromHook?: boolean } = {}): string {
  const lines: string[] = [];
  if (opts.reason) lines.push(`触发：${COMPACT_REASON[opts.reason] ?? opts.reason}`);
  const fromHook = opts.fromHook ?? c.fromHook === true;
  if (fromHook) lines.push('摘要来源：扩展提供（fromHook=true）');
  const before = asNumber(c.tokensBefore);
  if (before != null) lines.push(`压缩前上下文：${formatExactTokens(before)} tok`);
  const after = asNumber(c.estimatedTokensAfter);
  if (after != null) lines.push(`压缩后估计：${formatExactTokens(after)} tok`);
  const kept = typeof c.firstKeptEntryId === 'string' && c.firstKeptEntryId ? c.firstKeptEntryId : '';
  if (kept) lines.push(`保留边界：从 ${kept} 起原样保留，之前的条目被摘要取代`);

  const u = (c.usage ?? {}) as { totalTokens?: unknown; input?: unknown; output?: unknown; cost?: unknown };
  const total = asNumber(u.totalTokens) ?? asNumber(u.input);
  if (total != null) {
    const cost = asNumber((u.cost ?? {}) as unknown) ?? asNumber((u.cost as { total?: unknown } | undefined)?.total);
    lines.push(
      `摘要调用用量：${formatExactTokens(total)} tok${cost != null && cost > 0 ? ` · $${cost.toFixed(4)}` : ''}`,
    );
  }

  const d = (c.details ?? {}) as { readFiles?: unknown; modifiedFiles?: unknown };
  const read = asStringArray(d.readFiles);
  const modified = asStringArray(d.modifiedFiles);
  if (read.length || modified.length) {
    lines.push(`涉及文件：读 ${read.length} / 改 ${modified.length}`);
    if (read.length) lines.push(`  读：${read.join('\n      ')}`);
    if (modified.length) lines.push(`  改：${modified.join('\n      ')}`);
  }

  const summary = typeof c.summary === 'string' ? c.summary.trim() : '';
  if (summary) lines.push('', '摘要：', summary);
  return lines.join('\n');
}

/** 压缩条目 / 实时 result → 轨迹行（两处共用，避免"实时与重载后长得不一样"）。 */
function compactionRow(c: CompactionLike, ts?: number): TrajRow {
  const text = compactionHead(c);
  const detail = compactionDetail(c);
  return {
    id: rid(),
    kind: 'compaction',
    text,
    detail: detail || undefined,
    ts,
    expandable: !!detail,
  };
}

function entryToRow(e: Record<string, unknown>): TrajRow | null {
  const type = String(e.type ?? '');
  const ts = Date.parse(String(e.timestamp ?? '')) || undefined;
  if (type === 'message') {
    const m = e.message as AgentMessage | undefined;
    const role = (m as { role?: string })?.role;
    if (role === 'system') return systemRow(e);
    if (role === 'user') return { id: rid(), kind: 'user', text: textOf(m?.content), ts };
    if (role === 'assistant') return assistantRow(m, ts);
    if (role === 'toolResult') {
      const rm = m as { toolName?: string; content?: unknown; isError?: boolean };
      return {
        id: rid(),
        kind: 'tool',
        text: `${rm.toolName ?? 'tool'} ${textOf(rm.content).slice(0, 200)}`,
        ts,
      };
    }
    return { id: rid(), kind: 'other', text: `(message role=${role})`, ts };
  }
  if (type === 'compaction') return compactionRow(e as CompactionLike, ts);
  if (type === 'context_edit')
    return {
      id: rid(),
      kind: 'context_edit',
      text: `上下文编辑 → ${String(e.targetId ?? '').slice(0, 8)}${e.replacement ? '（替换）' : '（省略）'}`,
      ts,
    };
  if (type === 'session_info')
    return { id: rid(), kind: 'label', text: `命名：${String(e.name ?? '')}`, ts };
  if (type === 'label') return { id: rid(), kind: 'label', text: String(e.label ?? e.id ?? ''), ts };
  return { id: rid(), kind: 'other', text: `(${type})`, ts };
}

export const useTrajectory = create<TrajectoryState>()(
  immer((set) => ({
  rows: {},
  loaded: {},
  pendingCompaction: {},

  async load(tabId) {
    try {
      const data = await cmd<{ entries?: Array<Record<string, unknown>> }>('pi_get_entries', { tabId });
      const rows = (data.entries ?? []).map(entryToRow).filter((r): r is TrajRow => r !== null);
      set((s) => {
        s.rows[tabId] = rows;
        s.loaded[tabId] = true;
        // 整表重载：正在进行的压缩占位行也随之作废（否则下一个 compaction_end 会找不到它）
        delete s.pendingCompaction[tabId];
      });
    } catch (e) {
      console.error('轨迹加载失败', e);
      set((s) => {
        s.loaded[tabId] = true;
      });
    }
  },

  appendCommit(tabId, ev) {
    const e = ev as { type: string } & Record<string, unknown>;
    let row: TrajRow | null = null;
    switch (e.type) {
      case 'message_end': {
        const m = e.message as AgentMessage;
        const role = (m as { role?: string }).role;
        if (role === 'user') row = { id: rid(), kind: 'user', text: textOf(m?.content), ts: (m as { timestamp?: number }).timestamp };
        else if (role === 'assistant')
          // 必须与 `load()` 走**同一个**构造器：这里曾内联成 `{text: textOf(content)}`，
          // 于是实时追加的行永远不可展开，重新打开会话后又变了样。
          row = assistantRow(m, (m as { timestamp?: number }).timestamp);
        else if (role === 'system') row = systemRow(e);
        else if (role === 'toolResult') {
          const rm = m as { toolName?: string; content?: unknown };
          row = { id: rid(), kind: 'tool', text: `${rm.toolName ?? 'tool'} ${textOf(rm.content).slice(0, 200)}` };
        }
        break;
      }
      case 'tool_execution_start': {
        const t = e as unknown as { toolCallId: string; toolName: string };
        row = { id: rid(), kind: 'tool', text: `${t.toolName} (运行中…)`, running: true };
        break;
      }
      /* 一次压缩在实时流里会出现**三个**事件（pi `agent-session.js:2171/2242` +
         `entry_appended`）：`compaction_start` →（条目落盘 → `entry_appended`）→
         `compaction_end {result}`。它们必须是**同一行**：早先每个事件各推一行，
         于是轨迹里一次压缩留下三行，而且第一行永远是「上下文压缩…」、
         最后一行永远是「上下文压缩完成」—— 中间那两个带着真实字段的事件根本没被读。 */
      case 'compaction_start': {
        const reason = String((e as { reason?: unknown }).reason ?? '');
        const startRow: TrajRow = {
          id: rid(),
          kind: 'compaction',
          text: compactionHead({}, { running: true, reason }),
          running: true,
        };
        set((s) => {
          (s.rows[tabId] ??= []).push(startRow);
          s.pendingCompaction[tabId] = startRow.id;
        });
        return;
      }
      case 'entry_appended': {
        // 落盘条目才是权威形状（summary / details / usage / firstKeptEntryId 都在这里）
        const entry = (e as { entry?: Record<string, unknown> }).entry;
        if (!entry || entry.type !== 'compaction') return;
        const entryRow = compactionRow(
          entry as CompactionLike,
          Date.parse(String(entry.timestamp ?? '')) || undefined,
        );
        entryRow.running = true; // 还在压缩流程里，等 compaction_end 收尾
        set((s) => {
          const rows = (s.rows[tabId] ??= []);
          const id = s.pendingCompaction[tabId];
          const i = id ? rows.findIndex((r) => r.id === id) : -1;
          // 复用占位行：一次压缩只留一行，且保持它在列表里的位置
          if (i >= 0) rows[i] = { ...entryRow, id: id! };
          else rows.push(entryRow);
        });
        return;
      }
      case 'compaction_end': {
        const end = e as unknown as {
          reason?: string;
          result?: CompactionLike;
          aborted?: boolean;
          willRetry?: boolean;
          errorMessage?: string;
        };
        /* 失败与中断**绝不能**说成"完成"：pi 在 `aborted` / `errorMessage` 时不会落盘条目，
           而旧实现无条件写「上下文压缩完成」—— 一次失败的压缩在轨迹里看起来像成功了。 */
        const failed = !!end.errorMessage;
        const finalRow: TrajRow = failed
          ? { id: rid(), kind: 'compaction', text: `上下文压缩失败：${end.errorMessage}`, failed: true }
          : end.aborted
            ? { id: rid(), kind: 'compaction', text: '上下文压缩在完成前被中断' }
            : end.result
              ? compactionRow(end.result)
              : { id: rid(), kind: 'compaction', text: '上下文已压缩' };
        if (end.result) {
          finalRow.detail = compactionDetail(end.result, { reason: end.reason }) || finalRow.detail;
          finalRow.expandable = !!finalRow.detail;
        } else {
          const detail = [
            end.reason ? `触发：${COMPACT_REASON[end.reason] ?? end.reason}` : '',
            failed ? 'pi 没有落盘压缩条目（失败时不会写），所以没有摘要与计数。' : '',
            end.willRetry ? '随后会自动重试。' : '',
          ]
            .filter(Boolean)
            .join('\n');
          finalRow.detail = detail || undefined;
          finalRow.expandable = !!detail;
        }
        if (end.willRetry && end.result) finalRow.text += '（随后重试）';
        finalRow.running = false; // 显式收尾：界面据此不再画"…"、也不再当作进行中
        set((s) => {
          const rows = (s.rows[tabId] ??= []);
          const id = s.pendingCompaction[tabId];
          delete s.pendingCompaction[tabId];
          const i = id ? rows.findIndex((r) => r.id === id) : -1;
          if (i >= 0) rows[i] = { ...finalRow, id: id! };
          else rows.push(finalRow);
        });
        return;
      }
      default:
        return;
    }
    if (!row) return;
    set((s) => {
      (s.rows[tabId] ??= []).push(row!);
    });
  },

  clear(tabId) {
    set((s) => {
      delete s.rows[tabId];
      delete s.loaded[tabId];
      delete s.pendingCompaction[tabId];
    });
  },  }))
);