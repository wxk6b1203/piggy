/**
 * 休眠标签（05 §4.3，M2）：worker 被回收之后，前端这边的**标记与透明唤醒**。
 *
 * 三个入口：Rust 空闲回收（`pi:state = 'sleeping'` → `markSleeping`）、
 * 以及发送前的 `wakeIfNeeded`（休眠标签：发送即透明唤醒）。
 *
 * ⚠️ **没有"手动休眠"入口**（2026-10-17 核实）：`tab_sleep` 命令在 Rust 侧可用，但前端
 * 从来没有登记过那个动作 —— `DEFAULT_KEYS` 里曾经留着 `session.sleep: cmd+shift+s`，
 * 而没有任何 `registerCommand`，按下去静默无反应。那个死绑定与 `sleepTab()` 一起删掉了
 * （见 docs/15 规矩 154）。要恢复手动休眠，顺序是：先给 `tab_sleep` 加上"这一轮在跑就拒绝"
 * 的守卫，再登记命令与键位。
 *
 * 重建走**分页装载**（docs/03 §2.19）：唤醒只需要会话文件尾部的当前状态，
 * 没有理由把整段历史再搬一遍。
 */
import { useTabs } from '@/stores/tabs';
import { loadTail } from '@/lib/transcriptPage';

const sleeping = new Set<string>();

/** 标记休眠（本地主动调用或 Rust 空闲回收事件触发） */
export function markSleeping(tabId: string): void {
  sleeping.add(tabId);
  useTabs.getState().patch(tabId, { workerState: 'sleeping' });
}

/** 休眠：回收 worker + 丢弃内存态（tab 与游标保留在 Rust registry） */

/** 唤醒：worker_of 自动复活 + 游标补齐；前端重建消息（尾页） */
export async function wakeIfNeeded(tabId: string): Promise<void> {
  if (!sleeping.has(tabId)) return;
  sleeping.delete(tabId);
  useTabs.getState().patch(tabId, { workerState: 'spawning' });
  try {
    await loadTail(tabId, useTabs.getState().tabs[tabId]?.sessionFile ?? null);
    useTabs.getState().patch(tabId, { workerState: 'ready' });
  } catch {
    useTabs.getState().patch(tabId, { workerState: 'crashed' });
  }
}
