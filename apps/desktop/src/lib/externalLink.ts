/**
 * 用**系统默认程序**打开一个外部 URL（markdown 链接、许可原文…）。
 *
 * 为什么不让 `<a href>` 自己跳：Tauri 的 webview 里点链接有两种坏法 ——
 * 要么什么都没发生（用户以为坏了），要么把**应用界面本身**导航走（回不来）。
 * 所以前端拦截点击，交宿主执行；Rust 侧 `open_external_url` 再按 scheme 白名单校验一次
 * （前端可被绕过，权限判定必须在宿主侧——docs/08 §6 的同一条纪律）。
 *
 * 不在 `open_in_app` 那套命令里：那些命令的参数是**工作区里的路径**，会走
 * `validate_directory` / `validate_path` 守卫，URL 过不去也不该过去。
 */
import { cmd } from '@/lib/ipc';
import { reportToHost } from '@/features/common/ErrorBoundary';

/** 允许的 scheme（与 Rust `open_external_url` 的白名单一致，改一处要改两处）。 */
export const EXTERNAL_URL_SCHEMES = ['http:', 'https:', 'mailto:'] as const;

/** 这个 URL 允不允许交给系统打开。 */
export function isExternalUrlAllowed(url: string): boolean {
  try {
    return (EXTERNAL_URL_SCHEMES as readonly string[]).includes(new URL(url.trim()).protocol);
  } catch {
    return false;
  }
}

/**
 * 打开外部 URL。
 *
 * @param url - 已经过白名单校验的 URL
 * @returns 宿主是否成功交出去（失败会记一条日志，不抛）
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  if (!isExternalUrlAllowed(url)) {
    reportToHost('warn', `[openExternalUrl] 拒绝非白名单 scheme: ${url}`);
    return false;
  }
  try {
    await cmd('open_external_url', { url });
    return true;
  } catch (e) {
    reportToHost('error', `[openExternalUrl] 打开失败: ${String(e)}`);
    return false;
  }
}
