/**
 * 剪贴板（全应用唯一入口，2026-10-17 合并）。
 *
 * 合并前有 7 处各自写 `navigator.clipboard.writeText`，**4 套反馈口径**：
 * 静默、图标翻 1s、图标翻 1.2s、toast；其中两处（代码块、助手操作行）连失败都不管 ——
 * 剪贴板被拒（无权限 / 非安全上下文 / 焦点不在文档上）时用户会去粘贴然后发现是空的。
 *
 * 这里只统一**行为与失败反馈**：
 *  - 成功返回 `true`，失败 return `false` 并 toast 出原因；
 *  - **成功提示各留各的**：有的地方是图标翻一下，有的是 toast「已复制」，
 *    有的是「许可与第三方声明已复制」——那是各处的措辞，不该被统一成一句。
 *
 * 为什么不用 `navigator.clipboard?.writeText` 的静默兜底：`clipboard` 不存在同样是失败
 * （Tauri 的 webview 在非安全上下文下就是 undefined），静默等于骗人。
 */
import { toast } from './feedback';

/**
 * 复制一段文本。
 *
 * @param text - 要复制的原文（不做任何加工）
 * @returns 是否真的写进了剪贴板（失败时已弹过错误提示）
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard) throw new Error('当前环境不可用（非安全上下文或缺少权限）');
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    toast.error(`复制失败：${String(e)}`);
    return false;
  }
}
