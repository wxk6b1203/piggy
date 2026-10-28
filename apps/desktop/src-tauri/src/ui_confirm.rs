//! 原生确认框（可信 UI）。
//!
//! 为什么需要它：`settings_write` / `provider_save` / `models_write` / `tab_create` 的
//! 参数都来自 webview。如果 webview 被攻破，它可以直接改 `models.json` 的 baseUrl、
//! `settings.json` 的 sessionDir、或静默开一个 full 权限 tab——这些**不是文件读原语**，
//! 却能把已存密钥发到攻击者地址、或把会话闸门的根换掉。react 里的 `confirm` 也在这个
//! webview 里，攻破后可以伪造；只有 **Rust 侧调起的原生对话框**是 webview 改不了的。
//!
//! 用法：只在"这条操作会改变安全语义"时调用（改 baseUrl、改 sessionDir、开工作区外目录、
//! 升到完全权限）。普通设置保存不弹，避免打扰。

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

/// 弹一个原生 Ok/Cancel 确认框，返回用户是否点了 OK。
///
/// `show()` 是异步回调（不阻塞主线程）；取消/窗口关闭都按"否"处理（fail-closed）。
pub async fn confirm(app: &AppHandle, title: &str, message: &str) -> bool {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancel)
        .show(move |ok| {
            let _ = tx.send(ok);
        });
    rx.await.unwrap_or(false)
}
