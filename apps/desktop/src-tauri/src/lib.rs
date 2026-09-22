pub mod commands;
pub mod config;
pub mod events;
pub mod pi;
pub mod sessions;

use crate::commands::AppState;
use crate::events::{EventSink, TauriSink};
use crate::pi::discovery::discover;
use crate::sessions::registry::Registry;
use std::sync::{Arc, OnceLock};
use tauri::Manager;

static WATCHER: OnceLock<Arc<dyn notify::Watcher + Send + Sync>> = OnceLock::new();
static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pi_bin = discover(None).expect("未找到 pi 二进制：请安装 pi 或设置 PI_BIN");
    tauri::Builder::default()
        .setup(|app| {
            APP_HANDLE.set(app.handle().clone()).ok();
            // 会话目录 watcher：变化 → sessions:changed（docs/02 §6.2；pi 不随 stdin EOF 退出同理：句柄保活）
            let home = std::env::var("HOME").unwrap_or_default();
            let root = std::path::PathBuf::from(home).join(".pi/agent/sessions");
            let handle = app.handle().clone();
            match crate::sessions::list::spawn_sessions_watcher(root, move || {
                use tauri::Emitter;
                let sink = TauriSink { app: handle.clone() };
                sink.emit_json("sessions:changed", serde_json::json!({ "at": now_ms() }));
            }) {
                Ok(h) => {
                    WATCHER.set(h).ok();
                }
                Err(e) => {
                    eprintln!("[piggy] sessions watcher 不可用: {e}");
                }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // 契约事实：pi 不随 stdin EOF 退出——退出前显式关闭全部 worker（防孤儿）
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let sink: Arc<dyn crate::events::EventSink> = Arc::new(TauriSink { app: app.clone() });
                    let tab_ids = state.registry.lock().await.tab_ids();
                    for id in tab_ids {
                        let mut reg = state.registry.lock().await;
                        let _ = reg.close_tab(&sink, &id).await;
                    }
                });
            }
        })
        .manage(AppState {
            registry: Arc::new(tokio::sync::Mutex::new(Registry::new(pi_bin))),
        })
        .invoke_handler(tauri::generate_handler![
            commands::boot_reset,
            commands::pi_discover,
            commands::tab_create,
            commands::tab_close,
            commands::pi_prompt,
            commands::pi_abort,
            commands::pi_clear_queue,
            commands::pi_get_state,
            commands::pi_get_messages,
            commands::pi_get_session_stats,
            commands::pi_set_model,
            commands::pi_get_available_models,
            commands::pi_new_session,
            commands::pi_set_session_name,
            commands::ui_reply,
            commands::pi_stderr_tail,
            commands::session_list,
            commands::session_delete,
            commands::session_rename,
            commands::layout_load,
            commands::layout_save,
            commands::pi_get_entries,
            commands::pi_get_tree,
            commands::pi_get_fork_messages,
            commands::pi_fork,
            commands::pi_clone,
            commands::pi_set_thinking_level,
            commands::pi_get_available_thinking_levels,
            commands::pi_cycle_thinking,
            commands::pi_get_commands,
            commands::fs_preview_read,
            commands::pi_export_html,
            commands::auth_list,
            commands::auth_set_key,
            commands::auth_remove,
            commands::models_read,
            commands::models_write,
            commands::settings_read,
            commands::settings_write,
            commands::pi_compact,
            commands::pi_abort_bash,
            commands::pi_bash,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
