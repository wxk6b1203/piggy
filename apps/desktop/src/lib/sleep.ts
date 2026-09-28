/**
 * 休眠标签（05 §4.3，M2）：主动回收 worker 并丢弃内存消息（保留会话指针 + 游标），
 * 激活/交互时透明唤醒——Rust ensure_worker 复活 worker + 游标补齐，前端重建消息。
 *
 * 重建走**分页装载**（docs/03 §2.19）：唤醒只需要会话文件尾部的当前状态，
 * 没有理由把整段历史再搬一遍。
 */
import { cmd } from '@/lib/ipc';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { useTrajectory } from '@/stores/trajectory';
import { useBash } from '@/stores/bash';
import { loadTail } from '@/lib/transcriptPage';

const sleeping = new Set<string>();

export function isSleeping(tabId: string): boolean {
  return sleeping.has(tabId);
}

/** 标记休眠（本地主动调用或 Rust 空闲回收事件触发） */
export function markSleeping(tabId: string): void {
  sleeping.add(tabId);
  useTabs.getState().patch(tabId, { workerState: 'sleeping' });
}

/** 休眠：回收 worker + 丢弃内存态（tab 与游标保留在 Rust registry） */
export async function sleepTab(tabId: string): Promise<void> {
  await cmd('tab_sleep', { tabId });
  markSleeping(tabId);
  useMessages.getState().remove(tabId);
  useTrajectory.getState().clear(tabId);
  useBash.getState().clear(tabId);
}

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
