/** 轨迹（WP7，docs/04 §1.10）：get_entries 快照 + 实时 commit 追加，per-tab 行缓冲 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { cmd } from '@/lib/ipc';
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
}

interface TrajectoryState {
  rows: Record<string, TrajRow[]>;
  loaded: Record<string, boolean>;
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
 */
function assistantRow(m: AgentMessage | undefined, ts: number | undefined): TrajRow {
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
  if (type === 'compaction') return { id: rid(), kind: 'compaction', text: '上下文压缩', ts };
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

  async load(tabId) {
    try {
      const data = await cmd<{ entries?: Array<Record<string, unknown>> }>('pi_get_entries', { tabId });
      const rows = (data.entries ?? []).map(entryToRow).filter((r): r is TrajRow => r !== null);
      set((s) => {
        s.rows[tabId] = rows;
        s.loaded[tabId] = true;
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
          row = { id: rid(), kind: 'assistant', text: textOf(m?.content), ts: (m as { timestamp?: number }).timestamp };
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
      case 'compaction_start':
        row = { id: rid(), kind: 'compaction', text: '上下文压缩…', running: true };
        break;
      case 'compaction_end':
        row = { id: rid(), kind: 'compaction', text: '上下文压缩完成' };
        break;
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
    });
  },  }))
);