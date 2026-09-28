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
import { useTabs } from '@/stores/tabs';
import type { AgentMessage } from '@piggy/pi-protocol';

/** Rust `session_page` 的返回形状（`sessions/transcript.rs` 的 `Page::to_json`）。 */
export interface PageResponse {
  rows: Array<{ role: string; message: AgentMessage }>;
  startOffset: number;
  hasMore: boolean;
  branchy: boolean;
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
    useMessages.getState().hydratePage(
      tabId,
      page.rows.map((r) => r.message) as never[],
      { cursor: page.startOffset, hasMore: page.hasMore },
    );
  } catch (e) {
    // 读不出来就说清楚（控制台留证据），界面退回老路径，绝不静默留白
    console.warn('[piggy] 会话分页读失败，退回 get_messages：', e);
    await hydrateFromPi(tabId);
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
    return useMessages
      .getState()
      .prependPage(tabId, page.rows.map((r) => r.message) as never[], {
        cursor: page.startOffset,
        hasMore: page.hasMore,
      });
  } catch (e) {
    useMessages.getState().setLoadingOlder(tabId, false);
    toast.error(`加载更早的历史失败：${e}`);
    return 0;
  }
}
