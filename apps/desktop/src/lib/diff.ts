/**
 * 统一 diff 的解析与排版（DSH `ui-deliverables/src/client/FileDiff.tsx` 的同构物）。
 *
 * ## 数据从哪来（这一段是本仓与 DSH 的关键差别）
 *
 * DSH 的 diff 由**宿主服务**给出：`ChangesSummary` 说这一轮改了哪些文件、各加删几行，
 * `ChangesDiff` 按需把某个文件的**逐块 hunk** 送过来（宿主读的是工作区快照）。
 * Piggy 没有那套服务，但 **pi 自己就把 diff 算好了**：`edit` 工具的
 * `ToolResultMessage.details` 是 `EditToolDetails`
 * （`pi-coding-agent/dist/core/tools/edit.d.ts`）：
 *
 * ```ts
 * { diff: string          // 给人看的带行号 diff（TUI 直接用这个）
 *   patch: string         // 标准统一 patch（createTwoFilesPatch，含 ---/+++ 与 @@）
 *   firstChangedLine?: number }
 * ```
 *
 * 这是**实际落盘的结果**（模糊匹配、行尾归一化、`replace_all` 都已经算进去了），
 * 比"拿调用参数自己推一份"可靠 —— 后者是猜（DSH 在工具还没返回时只能这么猜，
 * 它把那份叫 *intended* diff）。所以本仓统一从 `details.patch` 解析，
 * 行内块与标签页两个视图共用同一份 hunk（`parseUnifiedPatch`）。
 *
 * 没有 patch 的工具（pi 的 `write` 结果 `details` 是 `undefined`）**不显示 diff**：
 * 覆盖写看不出"原先是什么"，硬凑一份"全部新增"会骗人。
 */
import type { ContentBlock } from '@piggy/pi-protocol';

/** 一个 hunk（`@@ -a,b +c,d @@` 头 + 逐行原文）。字段名与 DSH `WorkspaceDiffHunk` 同形。 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** 行首带符号的原文：`' 上下文'` / `'-删除'` / `'+新增'` */
  lines: string[];
}

/** 一个文件的统一 diff。 */
export interface ParsedPatch {
  /** patch 头里的路径（`--- <path>`）；取不到就是 null */
  path: string | null;
  hunks: DiffHunk[];
}

/** 行内 diff 块的一行（DSH `DiffBlock` 的 `DiffRow`）。 */
export interface DiffBlockRow {
  kind: 'path' | 'del' | 'add' | 'context' | 'gap';
  text: string;
}

/** 统一视图的一行：两侧行号 + 原文（DSH `FileDiff` 的 `DiffRow`）。 */
export interface DiffRow {
  kind: 'add' | 'del' | 'context';
  old: number | undefined;
  new: number | undefined;
  text: string;
}

/** 并排视图的一行（DSH `FileDiff` 的 `SplitRow`）。 */
export interface SplitRow {
  left?: { no: number; text: string; kind: 'del' | 'context' };
  right?: { no: number; text: string; kind: 'add' | 'context' };
}

/** 一次比较最多画多少行（DSH `MAX_RENDERED_LINES`）。 */
export const MAX_RENDERED_LINES = 5000;

/** 行内 diff 块折叠前的行数（DSH `CHAT_DIFF_MAX_LINES`）。 */
export const CHAT_DIFF_MAX_LINES = 9;

/** 折行/换行差异不该出现在行号里：`--- a/x<TAB>2026-01-01` 只取路径。 */
function headerPath(line: string): string | null {
  const raw = line.slice(4).replace(/\t.*$/, '').trim();
  if (!raw) return null;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  // git 风格的 a/ b/ 前缀（pi 不用，但别的工具可能给）
  return unquoted.replace(/^[ab]\//, '');
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 解析统一 patch（`createTwoFilesPatch` 的输出）。
 *
 * 认不出的行**不当成错误**：`---`/`+++` 头、"No newline at end of file" 这些
 * 元信息跳过；hunk 里第一个字符不认识的按上下文行处理（宁可多显示一行，
 * 也不要因为一个古怪的空格把整块 diff 吞掉 —— 界面上"什么都没有"最难查）。
 *
 * @returns 没有 hunk 时返回 null（空 patch / 纯元信息 → 调用方按"没有 diff"处理）
 */
export function parseUnifiedPatch(patch: string): ParsedPatch | null {
  if (!patch) return null;
  const all = patch.split('\n');
  const hunks: DiffHunk[] = [];
  let path: string | null = null;
  let current: DiffHunk | null = null;
  for (let i = 0; i < all.length; i += 1) {
    const line = all[i]!;
    // split 出来的最后一个空串是结尾换行，不是内容行
    if (i === all.length - 1 && line === '') continue;
    if (line.startsWith('--- ')) {
      path ??= headerPath(line);
      current = null;
      continue;
    }
    if (line.startsWith('+++ ')) {
      current = null;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = HUNK_HEAD.exec(line);
      if (!m) {
        current = null;
        continue;
      }
      current = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('\\')) continue; // \ No newline at end of file
    current.lines.push(line === '' || /^[ +-]/.test(line) ? (line === '' ? ' ' : line) : ` ${line}`);
  }
  if (hunks.length === 0) return null;
  return { path, hunks };
}

/** 一个 hunk 的 `@@ … @@` 头。 */
export function hunkHeader(hunk: DiffHunk): string {
  return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/**
 * 给 hunk 的每一行编号（DSH `hunkRows`）：上下文行两侧都数，
 * 删除只数旧侧，新增只数新侧。
 */
export function hunkRows(hunk: DiffHunk): DiffRow[] {
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  return hunk.lines.map((line) => {
    const text = line.slice(1);
    switch (line[0]) {
      case '+':
        return { kind: 'add' as const, old: undefined, new: newNo++, text };
      case '-':
        return { kind: 'del' as const, old: oldNo++, new: undefined, text };
      default:
        return { kind: 'context' as const, old: oldNo++, new: newNo++, text };
    }
  });
}

/**
 * 并排视图的配对（DSH `splitRows`）：一段连续删除与紧跟其后的连续新增**逐行对齐**，
 * 上下文行两侧都有。
 */
export function splitRows(hunk: DiffHunk): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: NonNullable<SplitRow['left']>[] = [];
  let adds: NonNullable<SplitRow['right']>[] = [];
  const flush = (): void => {
    for (let at = 0; at < Math.max(dels.length, adds.length); at += 1) {
      const left = dels[at];
      const right = adds[at];
      rows.push({ ...(left === undefined ? {} : { left }), ...(right === undefined ? {} : { right }) });
    }
    dels = [];
    adds = [];
  };
  for (const row of hunkRows(hunk)) {
    if (row.kind === 'del') dels.push({ no: row.old as number, text: row.text, kind: 'del' });
    else if (row.kind === 'add') adds.push({ no: row.new as number, text: row.text, kind: 'add' });
    else {
      flush();
      rows.push({
        left: { no: row.old as number, text: row.text, kind: 'context' },
        right: { no: row.new as number, text: row.text, kind: 'context' },
      });
    }
  }
  flush();
  return rows;
}

/** 一个 hunk 里加/删了几行（`+++`/`---` 头不在 `lines` 里，不会误计）。 */
export function hunkTotals(hunk: DiffHunk): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

/** 一份 patch 的加/删总计（改动卡片的 `+N −M`）。 */
export function diffTotals(hunks: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    const t = hunkTotals(hunk);
    added += t.added;
    removed += t.removed;
  }
  return { added, removed };
}

/**
 * 要画出来的 hunk（DSH `renderedHunks`）：总计超过 {@link MAX_RENDERED_LINES} 行时
 * 截断最后一个 hunk。
 */
export function renderedHunks(hunks: readonly DiffHunk[]): { hunks: DiffHunk[]; truncated: boolean } {
  let budget = MAX_RENDERED_LINES;
  const kept: DiffHunk[] = [];
  for (const hunk of hunks) {
    if (budget === 0) return { hunks: kept, truncated: true };
    kept.push(hunk.lines.length <= budget ? hunk : { ...hunk, lines: hunk.lines.slice(0, budget) });
    budget -= Math.min(budget, hunk.lines.length);
  }
  return { hunks: kept, truncated: hunks.some((hunk, at) => kept[at] !== hunk) };
}

/**
 * 行内 diff 块的行（DSH `buildRows` 的等价物）：
 * **路径行开头**，hunk 之间插一条 `⋯`。
 *
 * 与 DSH 的差别只有一处：DSH 按"同一路径的连续 hunk"分组，Piggy 的 patch 只有一个文件
 * （`edit` 一次改一个），所以路径行最多一条。
 */
export function diffBlockRows(parsed: ParsedPatch): DiffBlockRow[] {
  const rows: DiffBlockRow[] = [];
  if (parsed.path) rows.push({ kind: 'path', text: parsed.path });
  parsed.hunks.forEach((hunk, index) => {
    if (index > 0) rows.push({ kind: 'gap', text: '⋯' });
    for (const line of hunk.lines) {
      const kind = line.startsWith('-') ? 'del' : line.startsWith('+') ? 'add' : 'context';
      rows.push({ kind, text: line.slice(1) });
    }
  });
  return rows;
}

/**
 * 从一条工具结果里取出 diff。
 *
 * @param toolName - 调用名（只认会改动文件的那几个）
 * @param details - `ToolResultMessage.details`（形状不可信：外面进来的 JSON）
 * @returns 解析好的 patch，或 null（不是文件改动 / 没有 patch / patch 里没有 hunk）
 */
export function patchOfResult(toolName: string, details: unknown): ParsedPatch | null {
  if (!EDIT_TOOLS.has(toolName)) return null;
  if (!details || typeof details !== 'object') return null;
  const patch = (details as { patch?: unknown }).patch;
  return typeof patch === 'string' ? parseUnifiedPatch(patch) : null;
}

/**
 * 会改动文件的工具名（与 `ChangedFiles.tsx` 的 `WRITE_TOOLS` 同一份口径）。
 *
 * ⚠️ pi 的 `edit` 参数是 `{ path, edits: [{ oldText, newText }] }`，
 * **不是** `old_string` / `new_string`（那是 Claude Code 的形状）。
 */
export const EDIT_TOOLS = new Set(['edit', 'write', 'multi_edit', 'apply_patch', 'create', 'notebook_edit']);

/** 从调用参数里取被改动的文件路径（各家的键名都认一遍）。 */
export function editedPathOf(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null;
  const a = args as Record<string, unknown>;
  for (const key of ['path', 'file_path', 'filePath', 'filename']) {
    const v = a[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** 助手消息里被改动的那些调用（`toolCall` 块 → `{path, callId}`，按出现顺序去重）。 */
export function editedCallsOf(blocks: readonly ContentBlock[]): Array<{ path: string; callId: string }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; callId: string }> = [];
  for (const block of blocks) {
    const b = block as { type?: string; name?: string; id?: string; arguments?: unknown };
    if (b.type !== 'toolCall' || !b.name || !EDIT_TOOLS.has(b.name) || !b.id) continue;
    const path = editedPathOf(b.arguments);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, callId: b.id });
  }
  return out;
}
