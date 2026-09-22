import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** invoke 封装：统一错误为 string（docs/03 §3.1） */
export async function cmd<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(name, args);
}

/** 事件订阅封装：返回取消函数 */
export function on(channel: string, handler: (payload: any) => void): Promise<UnlistenFn> {
  return listen(channel, (e) => handler(e.payload));
}
