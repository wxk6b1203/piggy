pub mod commands;
pub mod events;
pub mod pi;
pub mod sessions;

use crate::commands::AppState;
use crate::events::TauriSink;
use crate::pi::discovery::discover;
use crate::sessions::registry::Registry;
use std::sync::Arc;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pi_bin = discover(None).expect("未找到 pi 二进制：请安装 pi 或设置 PI_BIN");
    tauri::Builder::default()
        .manage(AppState {
            registry: Arc::new(tokio::sync::Mutex::new(Registry::new(pi_bin))),
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // 契约事实：pi 不随 stdin EOF 退出——退出前显式关闭全部 worker（防孤儿）
                let app = window.app_handle().clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<AppState>();
                    let sink: Arc<dyn crate::events::EventSink> = Arc::new(TauriSink { app: app.clone() });
                    let tab_ids = {
                        let reg = state.registry.lock().await;
                        reg.tab_ids()
                    };
                    for id in tab_ids {
                        let mut reg = state.registry.lock().await;
                        let _ = reg.close_tab(&sink, &id).await;
                    }
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
