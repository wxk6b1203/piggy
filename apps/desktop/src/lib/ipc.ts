/**
 * IPC 封装（docs/03 §3.1）：
 * - Tauri 环境：invoke/listen 直通；
 * - 浏览器环境（无 __TAURI_INTERNALS__，Playwright UI E2E / 纯前端调试）：切 mockBackend。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isMock, mockInvoke, mockOn } from '@/lib/mockBackend';

export async function cmd<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  if (isMock) return mockInvoke<T>(name, args);
  return invoke<T>(name, args);
}

export function on<T = unknown>(channel: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (isMock) {
    return Promise.resolve(mockOn(channel, handler as (p: unknown) => void));
  }
  return listen(channel, (e) => handler(e.payload as T));
}
