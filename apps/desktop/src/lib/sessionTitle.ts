/**
 * 会话标题生成的数据层（docs/03 §2.16，docs/04 §2.4）。
 *
 * 后端会**另起一个一次性 pi 进程**去问模型（`-p --no-session -nt -nc`）：
 * provider/model/密钥全由 pi 自己解析，而且 `--no-session` 保证这段生成对话
 * 不进被命名那个会话的转录。前端只管发起与显示。
 *
 * 这里不缓存、不做本地合并：生成完重新拉会话列表，界面显示的必须就是磁盘上的。
 */
import { cmd } from '@/lib/ipc';

export type TitleStrategy = 'first' | 'recent' | 'both';

/** 生成标题**会拿什么去生成**（不调用模型，纯读会话文件）。 */
export interface TitleSourceInfo {
  cwd: string | null;
  provider: string | null;
  modelId: string | null;
  firstMessage: string | null;
  recentMessages: string[];
  userMessageCount: number;
  messageCount: number;
  currentName: string | null;
  strategy: TitleStrategy;
  maxChars: number;
  promptChars: number;
}

export interface TitleResult {
  /** 收拾干净、已按上限截断的标题 */
  title: string;
  /** 模型原样输出（排查用） */
  raw: string;
  provider: string | null;
  modelId: string | null;
  /** 实际用了哪个模型（`provider/modelId`）；null = 让 pi 用它自己的默认 */
  modelUsed: string | null;
  /** 耗时（毫秒）。**null = 后端没给**（形状漂移时不再渲染成 NaN） */
  elapsedMs: number | null;
  /** 送出去的提示词字数。**null = 后端没给** */
  promptChars: number | null;
  applied: boolean;
  source: TitleSourceInfo;
}

export async function loadTitleSource(path: string): Promise<TitleSourceInfo> {
  return await cmd<TitleSourceInfo>('session_title_source', { path });
}

/**
 * 把后端返回的形状归一化（docs/15 规矩 28：IPC 形状在边界处校验）。
 *
 * **这不是防御性编程，是补一次真实事故**：第一版 Rust 的 `Generated` 忘了
 * `rename_all = "camelCase"`，发出来的是 `elapsed_ms` / `prompt_chars`，
 * 而这里读的是 `elapsedMs` / `promptChars` —— 两边都不报错，
 * 用户看到的提示是「cc-switch-zhipu-glm/glm-5.3-flash · NaNs · 素材 undefined 字」。
 *
 * 根因已经在 Rust 侧修掉并用契约测试锁住；这里再兜一层，
 * 是为了让**任何**将来的字段漂移退化成"少说一句"，而不是把 `NaN` 送到用户眼前。
 * 漂移本身仍然要吵：缺字段时 `console.warn`，测试也会红。
 */
export function normalizeTitleResult(raw: unknown): TitleResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
  const elapsedMs = num(r.elapsedMs);
  const promptChars = num(r.promptChars);
  if (elapsedMs === null || promptChars === null) {
    console.warn('[sessionTitle] 形状漂移：后端没给出 elapsedMs/promptChars', r);
  }
  return {
    title: String(r.title ?? ''),
    raw: String(r.raw ?? ''),
    provider: str(r.provider),
    modelId: str(r.modelId),
    modelUsed: str(r.modelUsed),
    elapsedMs,
    promptChars,
    applied: r.applied === true,
    source: (r.source ?? {}) as TitleSourceInfo,
  };
}

/**
 * 生成并（默认）写入会话名。
 *
 * 会抛错的两种情况都要让用户看见原因：模型没给出可用标题（此时**保留原名字**），
 * 以及 pi 进程失败（密钥过期、模型名写错——原因在 pi 的 stderr 最后一行里）。
 */
export async function generateTitle(path: string, apply = true): Promise<TitleResult> {
  return normalizeTitleResult(await cmd<unknown>('session_title_generate', { path, apply }));
}

/**
 * 一句话说明"这次是谁生成的"——用户对标题不满意时要知道该去改哪儿。
 *
 * **每个部分都只在真的有值时才出现**：宁可少说一句，也不能出现
 * 「NaNs」或「素材 undefined 字」（那是真实发生过的事故文案）。
 */
export function describeRun(r: TitleResult): string {
  const parts: string[] = [r.modelUsed ?? 'pi 的默认模型'];
  if (r.elapsedMs !== null) parts.push(`${(r.elapsedMs / 1000).toFixed(1)}s`);
  if (r.promptChars !== null) parts.push(`素材 ${r.promptChars} 字`);
  if (!r.applied) parts.push('未写入');
  return parts.join(' · ');
}
