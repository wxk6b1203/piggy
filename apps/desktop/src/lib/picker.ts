/**
 * 系统目录选择框（WP5，docs/08 §6）：经 Rust `pick_directory` 命令唤起
 * tauri-plugin-dialog 原生目录框；取消/失败返回 null（调用方保持原值）。
 * mock（浏览器）环境由 mockBackend 返回 null。
 */
import { cmd } from '@/lib/ipc';

export async function pickDirectory(title: string, startDir?: string): Promise<string | null> {
  try {
    const picked = await cmd<string | null>('pick_directory', { title, start: startDir });
    return picked ?? null;
  } catch (e) {
    console.error('[picker] 目录选择失败', e);
    return null;
  }
}
