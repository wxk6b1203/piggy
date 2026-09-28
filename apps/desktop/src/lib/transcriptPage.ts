/**
 * 会话转录分页装载（docs/03 §2.19）。
 *
 * 打开会话 = 读**尾部一页**（Rust `session_page`，从文件尾往回解析），往上的历史
 * 由「加载更早」按需再读。这么做省的是**客户端的计算**（IPC 载荷、JSON 解析、
 * store 内存、刻度梯重建），**磁盘一个字节都不省**——会话文件始终是 pi 的
 * append-only JSONL，Piggy 只读不写（docs/02 §6.1）。
 *
 * 兜底顺序（重要，别把"文件读不到"变成"会话空白"）：
 *   1. 有会话文件 → `session_page` 尾页；
 *   2. 读失败（文件被删/不是 JSONL）→ 退回 `pi_get_messages`（pi 进程内存里的上下文），
 *      此时 `hasMore=false`，不显示「加载更早」；
 *   3. 没有会话文件（尚未落盘的会话）→ 直接走 2。
 */
import { cmd } from '@/lib/ipc';
import { toast } from '@/lib/feedback';
import { useMessages } from '@/stores/messages';
import { loadTodosForSession } from '@/stores/todo';
import { useTabs } from '@/stores/tabs';
import type { AgentMessage } from '@piggy/pi-protocol';
import type { OutlineTurn } from '@/features/chat/turnRailItems';

/** Rust `session_page` 的返回形状（`sessions/transcript.rs` 的 `Page::to_json`）。 */
export interface PageResponse {
  rows: Array<{ role: string; message: AgentMessage; offset: number }>;
  startOffset: number;
  /** 本页读完位置：向下续页的游标（`after`） */
  endOffset: number;
  hasMore: boolean;
  /** 本页不是文件尾部（换窗之后为 true） */
  hasNewer: boolean;
  branchy: boolean;
}

/** Rust `session_outline` 的返回形状（整段会话的轮次轮廓，刻度梯用）。 */
export interface OutlineResponse {
  turns: OutlineTurn[];
  totalBytes: number;
}

/** 退回一次性 hydrate：pi 进程内存里的当前上下文。 */
async function hydrateFromPi(tabId: string): Promise<void> {
  const r = await cmd<{ messages: unknown[] }>('pi_get_messages', { tabId });
  useMessages.getState().hydrate(tabId, r.messages as never[]);
}

/**
 * 装载会话的第一页（贴在结尾那一页）。
 *
 * @param tabId - 标签 id
 * @param sessionFile - 会话文件路径；缺失时退回 `pi_get_messages`
 */
export async function loadTail(tabId: string, sessionFile: string | null | undefined): Promise<void> {
  if (!sessionFile) {
    await hydrateFromPi(tabId);
    return;
  }
  try {
    const page = await cmd<PageResponse>('session_page', { path: sessionFile });
    useMessages.getState().hydratePage(tabId, page.rows as never[], {
      cursor: page.startOffset,
      hasMore: page.hasMore,
      hasNewer: page.hasNewer,
      end: page.endOffset,
    });
    // 轮廓与页码是两件事（整段会话的"形状" vs 一页内容），并行取、不互相等。
    // 轮廓失败不影响转录：刻度退化成"只画已载入的那部分"。
    void loadOutline(tabId, sessionFile);
    // 任务清单同理：它是"整段会话的最新一次 todo_write"，可能远在已载入的那一页之前。
    // 没探测到 todo 能力时 `loadTodosForSession` 直接返回，连扫描都不发生。
    void loadTodosForSession(tabId, sessionFile, useTabs.getState().tabs[tabId]?.cwd ?? null);
  } catch (e) {
    // 读不出来就说清楚（控制台留证据），界面退回老路径，绝不静默留白
    console.warn('[piggy] 会话分页读失败，退回 get_messages：', e);
    await hydrateFromPi(tabId);
  }
}

/**
 * 取**整段会话**的轮次轮廓（刻度梯要"预览全部、载入部分"，docs/03 §2.19）。
 *
 * 失败时把轮廓清空（不是保留旧值）：宁可让刻度只画已载入的那段，
 * 也不要拿一份对不上的旧轮廓去糊界面。
 *
 * @param tabId - 标签 id
 * @param sessionFile - 会话文件路径
 */
export async function loadOutline(tabId: string, sessionFile: string | null | undefined): Promise<void> {
  if (!sessionFile) {
    useMessages.getState().setOutline(tabId, null);
    return;
  }
  try {
    const r = await cmd<OutlineResponse>('session_outline', { path: sessionFile });
    useMessages.getState().setOutline(tabId, r.turns ?? []);
  } catch (e) {
    console.warn('[piggy] 轮次轮廓读取失败，刻度只画已载入的部分：', e);
    useMessages.getState().setOutline(tabId, null);
  }
}

/**
 * **换窗**：把已载入窗口换成"以 `before` 为右界的一页"（DSH 的 repage 同义）。
 *
 * 用于"跳到很久以前的某一轮"：只读目标那一页，中间那段**不读**——
 * 否则一次跳转就等于把整段历史读进来（用户 2026-09-23 问的正是这个）。
 * 换窗之后 `hasNewer=true`，界面给「回到最新」，点了重新装载尾部那一页。
 *
 * @param tabId - 标签 id
 * @param before - 右边界（不含）：目标轮用户消息的结束偏移
 * @returns 是否换窗成功
 */
export async function loadWindowAt(tabId: string, before: number): Promise<boolean> {
  const file = useTabs.getState().tabs[tabId]?.sessionFile;
  if (!file) return false;
  try {
    const page = await cmd<PageResponse>('session_page', { path: file, before });
    useMessages.getState().hydratePage(tabId, page.rows as never[], {
      cursor: page.startOffset,
      hasMore: page.hasMore,
      hasNewer: page.hasNewer,
      end: page.endOffset,
    });
    return true;
  } catch (e) {
    toast.error(`跳到那一轮失败：${e}`);
    return false;
  }
}

/**
 * **向下续页**：换窗之后窗口下面还有更新的内容时，把下一段读进来接到后面。
 *
 * 为什么需要它（用户 2026-09-23 第四轮）：换窗之后只有"加载更早"这一个方向，
 * 往下滚到底就撞墙，只能点「回到最新」跳回去。现在往下滚能一路续到会话尾部，
 * 续到尾部之后 `hasNewer=false`，实时消息也恢复追加（见 stores/messages.ts 的守卫）。
 *
 * @param tabId - 标签 id
 * @returns 真正新增的行数（0 = 没有更新的了，或正在加载）
 */
export async function loadNewer(tabId: string): Promise<number> {
  const store = useMessages.getState();
  const tab = store.tabs[tabId];
  if (!tab || !tab.hasNewer || tab.loadingNewer || tab.windowEnd == null) return 0;
  const file = useTabs.getState().tabs[tabId]?.sessionFile;
  if (!file) return 0;

  store.setLoadingNewer(tabId, true);
  try {
    const page = await cmd<PageResponse>('session_page', { path: file, after: tab.windowEnd });
    return useMessages.getState().appendPage(tabId, page.rows as never[], {
      end: page.endOffset,
      hasNewer: page.hasNewer,
    });
  } catch (e) {
    useMessages.getState().setLoadingNewer(tabId, false);
    toast.error(`加载更新的内容失败：${e}`);
    return 0;
  }
}

/**
 * 读更早的一页并接到转录最前面。
 *
 * @param tabId - 标签 id
 * @returns 真正新增的行数（0 = 没有更多，或这一页全是渲染不出来的条目）
 */
export async function loadOlder(tabId: string): Promise<number> {
  const store = useMessages.getState();
  const tab = store.tabs[tabId];
  if (!tab || !tab.hasMore || tab.loadingOlder || tab.pageCursor == null) return 0;
  const file = useTabs.getState().tabs[tabId]?.sessionFile;
  if (!file) return 0;

  store.setLoadingOlder(tabId, true);
  try {
    const page = await cmd<PageResponse>('session_page', {
      path: file,
      before: tab.pageCursor,
    });
    return useMessages.getState().prependPage(tabId, page.rows as never[], {
      cursor: page.startOffset,
      hasMore: page.hasMore,
    });
  } catch (e) {
    useMessages.getState().setLoadingOlder(tabId, false);
    toast.error(`加载更早的历史失败：${e}`);
    return 0;
  }
}
