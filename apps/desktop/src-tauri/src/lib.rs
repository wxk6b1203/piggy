pub mod commands;
pub mod config;
pub mod events;
pub mod fleet;
pub mod fs_guard;
pub mod pi;
pub mod pty;
pub mod sessions;

use crate::commands::AppState;
use crate::events::TauriSink;
use crate::pi::discovery::discover;
use crate::sessions::registry::Registry;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::Manager;

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// panic hook（docs/09 M4）：崩溃转储到 ~/.piggy/logs/（Rust panic hook → 本地日志），
/// 再交回默认 hook（保留原 stderr 行为）。
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = std::env::var_os("HOME").map(PathBuf::from).map(|h| h.join(".piggy/logs")) {
            let _ = std::fs::create_dir_all(&dir);
            let ts = now_ms();
            let msg = format!(
                "panic @{ts}: {info}\nlocation: {:?}\n---\n",
                info.location()
            );
            let _ = std::fs::write(dir.join(format!("panic-{ts}.log")), msg);
        }
        default(info);
    }));
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 内置 pi 路径启发式（08 §7.1）：macOS bundle = Contents/Resources/resources/pi/pi，
/// windows/linux = exe 同级 resources/pi/pi。setup 里会以 resource_dir 权威值覆盖。
fn builtin_pi_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let base = if cfg!(target_os = "macos") {
        exe.parent()?.parent()?.join("Resources")
    } else {
        exe.parent()?.to_path_buf()
    }
    .join("resources/pi");
    Some(if cfg!(windows) { base.join("pi.exe") } else { base.join("pi") })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook(); // M4：崩溃安全
    // 启动时 pi 缺失不再炸 app：引导横幅 + 每次建 tab 时按发现链重试（02 §2.1）
    let pi_bin = match discover(None, builtin_pi_path().as_deref()) {
        Ok(b) => {
            eprintln!("[piggy] pi: {} ({})", b.path.display(), b.version);
            Some(b)
        }
        Err(e) => {
            eprintln!("[piggy] pi 未找到（{e}）；将随首次会话创建重试");
            None
        }
    };
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // 托盘（docs/09 M4）：显示/隐藏 + 退出
            use tauri::{
                menu::{Menu, MenuItem},
                tray::TrayIconBuilder,
            };
            let show_hide = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_hide, &quit])?;
            TrayIconBuilder::with_id("piggy-tray")
                .icon(app.default_window_icon().cloned().ok_or_else(|| tauri::Error::AssetNotFound("icon".into()))?)
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "toggle" => {
                        if let Some(w) = app.get_webview_window("main") {
                            if w.is_visible().unwrap_or(false) {
                                let _ = w.hide();
                            } else {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;
            // 全局唤起（docs/09 M4）：Cmd/Ctrl+Shift+P 显示并聚焦主窗
            #[cfg(desktop)]
            {
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_shortcuts(["CmdOrCtrl+Shift+P"])?
                        .with_handler(|app, _shortcut, _event| {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                        })
                        .build(),
                )?;
            }
            APP_HANDLE.set(app.handle().clone()).ok();
            // 内置 pi（08 §7.1）：以 resource_dir 为权威，覆盖 run() 时的启发式
            let app4 = app.handle().clone();
            tauri::async_runtime::block_on(async move {
                let state = app4.state::<crate::commands::AppState>();
                match app4.path().resource_dir() {
                    Ok(rd) => eprintln!("[piggy] resource_dir = {}", rd.display()),
                    Err(e) => eprintln!("[piggy] resource_dir 不可用: {e}"),
                }
                let resource_dir = app4.path().resource_dir().ok();
                if let Some(rd) = resource_dir.as_ref() {
                    let builtin = if cfg!(windows) {
                        rd.join("resources/pi/pi.exe")
                    } else {
                        rd.join("resources/pi/pi")
                    };
                    let mut reg = state.registry.lock().await;
                    reg.builtin = Some(builtin);
                    // 权限守卫脚本 + 持久化的默认档位（「工作区内修改」缺脚本会拒绝启动）
                    reg.guard_script = crate::pi::permission::guard_script_path(resource_dir.as_deref());
                    reg.default_permission = state
                        .perf
                        .read()
                        .map(|p| p.permission_mode)
                        .unwrap_or_default();
                    match &reg.guard_script {
                        Some(p) => eprintln!("[piggy] 权限守卫: {}", p.display()),
                        None => eprintln!(
                            "[piggy] 权限守卫脚本缺失：档位「工作区内修改」将拒绝启动（仅可查看/完全权限不受影响）"
                        ),
                    }
                } else {
                    // resource_dir 拿不到时也必须初始化守卫与档位：
                    // 之前整块都在 `if let Some(rd)` 里，于是 resource_dir 一失败，
                    // guard_script 就静默保持 None → 默认档位拒绝启动一切会话（实测踩到）
                    let mut reg = state.registry.lock().await;
                    reg.guard_script = crate::pi::permission::guard_script_path(None);
                    reg.default_permission = state
                        .perf
                        .read()
                        .map(|p| p.permission_mode)
                        .unwrap_or_default();
                    eprintln!(
                        "[piggy] 权限守卫（resource_dir 回退）: {}",
                        reg.guard_script
                            .as_ref()
                            .map(|p| p.display().to_string())
                            .unwrap_or_else(|| "未找到".into())
                    );
                }
            });
            // 会话目录 watcher：变化 → sessions:changed（根目录随 sessionDir，见 commands::restart_sessions_watcher）
            let app2 = app.handle().clone();
            let state = app.state::<crate::commands::AppState>();
            tauri::async_runtime::block_on(async move {
                let watcher_slot = state.watcher.clone();
                let handle = app2.clone();
                match crate::sessions::list::spawn_sessions_watcher(
                    crate::commands::watcher_roots(),
                    move || {
                        use tauri::Emitter;
                        let _ = handle.emit("sessions:changed", serde_json::json!({ "at": 0 }));
                    },
                ) {
                    Ok(w) => {
                        *watcher_slot.lock().await = Some(w);
                        eprintln!("[piggy] sessions watcher 已启动");
                    }
                    Err(e) => eprintln!("[piggy] sessions watcher 不可用: {e}"),
                }
            });
            // 空闲回收定时器（05 §3.1/§4.1）：全应用唯一周期任务，60s 一 tick
            //
            // ⚠️ 必须留在**这一个** setup 闭包内：`tauri::Builder::setup` 的语义是
            // `self.setup = Box::new(setup)`（tauri-2.11.6 src/app.rs:1777）——**后一次调用直接覆盖前一次**，
            // 不是追加。这里曾经有第二个 `.setup(...)`，于是托盘、内置 pi 接线、权限守卫、
            // 会话 watcher 全都被静默丢弃（实测：`[piggy] sessions watcher 已启动` 从未打印，
            // 且默认权限档位因拿不到守卫脚本而拒绝启动任何会话）。
            let app3 = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let state = app3.state::<crate::commands::AppState>();
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(60));
                loop {
                    tick.tick().await;
                    let timeout_min = state.perf.read().map(|p| p.idle_timeout_min).unwrap_or(10);
                    if timeout_min == 0 {
                        continue; // 0 = 永不回收
                    }
                    let mut reg = state.registry.lock().await;
                    let reaped = reg.reap_idle(timeout_min as u64 * 60).await;
                    for id in reaped {
                        eprintln!("[piggy] idle worker reaped: {id}");
                    }
                }
            });
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
            watcher: Arc::new(tokio::sync::Mutex::new(None)),
            perf: Arc::new(std::sync::RwLock::new(config::app::perf_config_load())),
            fleet: Arc::new(fleet::FleetManager::new()),
            pty: Arc::new(std::sync::Mutex::new(std::collections::HashMap::new())),
        })
        .invoke_handler(tauri::generate_handler![
            commands::boot_reset,
            commands::pi_discover,
            commands::pick_directory,
            commands::webview_log,
            commands::tab_create,
            commands::tab_close,
            commands::tab_sleep,
            commands::tab_sleep_idlest,
            commands::pi_set_permission_mode,
            commands::permission_modes,
            commands::perf_config_load,
            commands::perf_config_save,
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
            commands::session_dir_effective,
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
            commands::fs_list_dir,
            commands::fs_write_edit,
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
            commands::fleet_templates,
            commands::fleet_list,
            commands::fleet_start,
            commands::fleet_abort,
            commands::fleet_steer,
            commands::fleet_open_lane,
            commands::pty_open,
            commands::pty_write,
            commands::pty_resize,
            commands::pty_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
