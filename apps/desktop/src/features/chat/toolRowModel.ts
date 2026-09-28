/**
 * 工具行的**行模型**（窄行摘要取自调用参数，不放渲染）。
 *
 * 对齐 DSH `ui-tool/src/client/tool/models/tool-call-model.ts`：
 *   · `TOOL_VARIANTS` → {@link toolVariant}（工具名归一成 7 种行变体）
 *   · `VARIANT_TITLE_KEYS` → {@link TOOL_TITLES}（`tool.title.*`，中文口径逐条照抄）
 *   · `SUMMARY_KEYS` + `deriveSummary` → {@link toolSummary}（按变体挑参数键，
 *     取不到就退到"第一个非空字符串参数"，再退到首行原文）
 *   · `firstLine` → {@link firstLine}（摘要只占一行，换行处截断）
 *
 * 参数键按 **pi 的工具 schema** 写（`dist/core/tools/*.d.ts`，2026-09-23 核对 0.87.1）：
 *
 * | 工具 | 参数 |
 * |---|---|
 * | `bash` / `powershell` | `command`（+`timeout`） |
 * | `read` | `path`（+`offset`/`limit`） |
 * | `write` | `path`、`content` |
 * | `edit` | `path`、`edits[]` |
 * | `grep` / `find` | `pattern`（+`path`/`glob`/…） |
 * | `ls` | `path`（可选） |
 *
 * DSH 的 `bash` 摘要优先 `description`（它自己的工具带这个字段），pi 的 bash **没有**
 * `description` —— 保留在首选位是为了兼容带该字段的扩展工具，取不到自然落到 `command`。
 *
 * ⚠️ 拿不到参数时（例如分页窗口从半途开始、上一条助手消息不在内存里）**不算错**：
 * 退到工具结果的首行（{@link fallbackSummary}），并如实显示"结果首行"而不是编一个命令出来。
 */

/** DSH 的 7 种行变体（`ToolRowVariant`）。 */
export type ToolVariant = 'search' | 'read' | 'bash' | 'write' | 'edit' | 'code' | 'others';

/** 变体 → 标题（DSH `ui-conversation/locales.ts:290-296` 的中文口径）。 */
export const TOOL_TITLES: Record<ToolVariant, string> = {
  search: '搜索',
  read: '读取',
  bash: '运行命令',
  write: '写入',
  edit: '编辑',
  code: '代码',
  others: '工具调用',
};

/**
 * 工具名 → 变体（DSH `TOOL_VARIANTS` 的表 + pi 的真实工具名）。
 *
 * pi 的核心工具只有 8 个：`bash` / `powershell` / `read` / `write` / `edit` /
 * `grep` / `find` / `ls`（`dist/core/tools/*.d.ts`）。扩展工具按 DSH 的同名条目走：
 * `subagent` → 委派任务、`web_search` → 搜索、`web_fetch` → 读取。
 */
const TOOL_VARIANTS: Record<string, ToolVariant> = {
  bash: 'bash',
  powershell: 'bash',
  read: 'read',
  write: 'write',
  edit: 'edit',
  grep: 'search',
  find: 'search',
  glob: 'search',
  ls: 'read',
  web_fetch: 'read',
  web_search: 'search',
};

/** 工具名 → 标题覆盖（DSH `TOOL_TITLE_KEYS`；没列到的用变体标题）。 */
const TOOL_TITLE_OVERRIDES: Record<string, string> = {
  powershell: '运行命令',
  ls: '列目录',
  web_fetch: '访问网页',
  web_search: '搜索网页',
  subagent: '委派任务',
  task: '委派任务',
};

/** DSH `SUMMARY_KEYS`：每个变体优先取哪些参数键。 */
const SUMMARY_KEYS: Record<ToolVariant, readonly string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['pattern', 'query', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
};

/** 摘要只占一行：到第一个换行为止（DSH `firstLine`）。 */
export function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

/** 工具名 → 行变体。 */
export function toolVariant(toolName: string | undefined): ToolVariant {
  const n = (toolName ?? '').trim().toLowerCase();
  return TOOL_VARIANTS[n] ?? (n === 'subagent' || n === 'task' ? 'others' : 'others');
}

/** 工具名 → 行标题（`运行命令` / `读取` / …）。 */
export function toolTitle(toolName: string | undefined, variant = toolVariant(toolName)): string {
  const n = (toolName ?? '').trim().toLowerCase();
  return TOOL_TITLE_OVERRIDES[n] ?? TOOL_TITLES[variant];
}

function pickString(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const v = args[key];
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

/**
 * 从调用参数推一行摘要（DSH `deriveSummary`）。
 *
 * @param variant - 行变体
 * @param args - 调用参数（拿不到就是 `undefined`）
 * @returns 摘要（单行、已 trim）；推不出来时返回 `''`（调用方退到结果首行）
 */
export function toolSummary(variant: ToolVariant, args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const picked = pickString(args, SUMMARY_KEYS[variant]);
  if (picked !== undefined) return firstLine(picked);
  // DSH 的兜底：参数里第一个非空字符串。工具变体不知道、但参数里有个像样的值时用它
  for (const v of Object.values(args)) {
    if (typeof v === 'string' && v.trim() !== '') return firstLine(v);
  }
  return '';
}

/**
 * 拿不到参数时的兜底：工具**结果**的首行。
 *
 * DSH 只在**错误行**用结果首行（`errorSummary`）；Piggy 的转录是分页读的，
 * 窗口可能从半途开始（上一条助手消息不在内存里），此时宁可显示结果首行，
 * 也不要显示一个空摘要或编出来的命令。
 */
export function fallbackSummary(text: string | undefined): string {
  return firstLine(text ?? '');
}

/** 一行里显示的东西（标题 + 摘要 + 变体 + 状态）。 */
export interface ToolRowModel {
  variant: ToolVariant;
  title: string;
  summary: string;
  /** 摘要是从结果首行退回来的（没有调用参数）——界面据此不加"命令"语气 */
  summaryFromResult: boolean;
  state: 'ok' | 'error';
}

/**
 * 组装一行。
 *
 * @param toolName - `toolResult` 的 `toolName`（扩展工具也在内）
 * @param args - 调用参数（`toolCalls` 索引；拿不到传 `undefined`）
 * @param resultText - 结果正文（兜底摘要与错误行要用）
 * @param isError - `toolResult.isError`
 */
export function toolRowModel(
  toolName: string | undefined,
  args: Record<string, unknown> | undefined,
  resultText: string | undefined,
  isError: boolean,
): ToolRowModel {
  const variant = toolVariant(toolName);
  const title = toolTitle(toolName, variant);
  // 错误行：摘要 = 结果首行（DSH `errorSummary`）——失败原因比"当时想跑什么"重要
  if (isError) {
    return { variant, title, summary: fallbackSummary(resultText), summaryFromResult: true, state: 'error' };
  }
  const fromArgs = toolSummary(variant, args);
  if (fromArgs) return { variant, title, summary: fromArgs, summaryFromResult: false, state: 'ok' };
  return { variant, title, summary: fallbackSummary(resultText), summaryFromResult: true, state: 'ok' };
}
