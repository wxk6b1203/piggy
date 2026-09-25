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
  elapsedMs: number;
  promptChars: number;
  applied: boolean;
  source: TitleSourceInfo;
}

export async function loadTitleSource(path: string): Promise<TitleSourceInfo> {
  return await cmd<TitleSourceInfo>('session_title_source', { path });
}

/**
 * 生成并（默认）写入会话名。
 *
 * 会抛错的两种情况都要让用户看见原因：模型没给出可用标题（此时**保留原名字**），
 * 以及 pi 进程失败（密钥过期、模型名写错——原因在 pi 的 stderr 最后一行里）。
 */
export async function generateTitle(path: string, apply = true): Promise<TitleResult> {
  return await cmd<TitleResult>('session_title_generate', { path, apply });
}

/** 一句话说明"这次是谁生成的"——用户对标题不满意时要知道该去改哪儿。 */
export function describeRun(r: TitleResult): string {
  const who = r.modelUsed ?? 'pi 的默认模型';
  const secs = (r.elapsedMs / 1000).toFixed(1);
  const applied = r.applied ? '' : '（未写入）';
  return `${who} · ${secs}s · 素材 ${r.promptChars} 字${applied}`;
}
