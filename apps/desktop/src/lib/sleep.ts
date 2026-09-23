/**
 * 休眠标签（05 §4.3，M2）：主动回收 worker 并丢弃内存消息（保留会话指针 + 游标），
 * 激活/交互时透明唤醒——Rust ensure_worker 复活 worker + 游标补齐，前端重建消息。
 */
import { cmd } from '@/lib/ipc';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { useTrajectory } from '@/stores/trajectory';
import { useBash } from '@/stores/bash';

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

/** 唤醒：worker_of 自动复活 + 游标补齐；前端重建消息 */
export async function wakeIfNeeded(tabId: string): Promise<void> {
  if (!sleeping.has(tabId)) return;
  sleeping.delete(tabId);
  useTabs.getState().patch(tabId, { workerState: 'spawning' });
  try {
    const r = await cmd<{ messages: unknown[] }>('pi_get_messages', { tabId });
    useMessages.getState().hydrate(tabId, r.messages as never[]);
    useTabs.getState().patch(tabId, { workerState: 'ready' });
  } catch {
    useTabs.getState().patch(tabId, { workerState: 'crashed' });
  }
}
