pub mod commands;
pub mod config;
pub mod events;
pub mod fleet;
pub mod fs_guard;
pub mod legal;
pub mod open_in_app;
pub mod pi;
pub mod plugin;
pub mod provider;
pub mod pty;
pub mod sessions;

use crate::commands::AppState;
use crate::events::TauriSink;
use crate::pi::discovery::discover;
use crate::sessions::registry::Registry;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use tauri::{Emitter, Manager};

static APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();

/// panic hook（docs/09 M4）：崩溃转储到 ~/.piggy/logs/（Rust panic hook → 本地日志），
/// 再交回默认 hook（保留原 stderr 行为）。
///
/// 主目录解析走 `config::paths`：老代码只看 `HOME`，Windows 上拿不到 → panic 日志
/// 一个都不写（静默）。
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let dir = crate::config::paths::home_dir_or_temp()
            .join(".piggy")
            .join("logs");
        let _ = std::fs::create_dir_all(&dir);
        let ts = now_ms();
        let msg = format!(
            "panic @{ts}: {info}\nlocation: {:?}\n---\n",
            info.location()
        );
        let _ = std::fs::write(dir.join(format!("panic-{ts}.log")), msg);
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
    .join("resources")
    .join("pi");
    Some(if cfg!(windows) { base.join("pi.exe") } else { base.join("pi") })
}

/// 委派开关打开时返回策略文件路径（否则 None）。
///
/// 抽成函数是为了让「两个 resource_dir 分支」用同一套判据 —— 历史上这两处漂移过一次，
/// 结果是拿不到 resource_dir 的机器上守卫脚本静默为 None（docs/15 规矩 8）。
fn subagent_policy_for(
    state: &AppState,
    resource_dir: Option<&std::path::Path>,
) -> Option<PathBuf> {
    let on = state
        .perf
        .read()
        .map(|p| p.subagent_delegation)
        .unwrap_or(false);
    if !on {
        return None;
    }
    crate::pi::resources::subagent_policy_path(resource_dir)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook(); // M4：崩溃安全
    // 启动时 pi 缺失不再炸 app：引导横幅 + 每次建 tab 时按发现链重试（02 §2.1）
    // 启动时按持久化的来源解析（默认 system）；失败不阻断启动，
    // 由引导横幅 + 每次建 tab 时的重试兜底（02 §2.1）
    let boot_cfg = config::app::perf_config_load();
    let pi_bin = match discover(
        boot_cfg.pi_source,
        boot_cfg.pi_path.as_ref().map(std::path::Path::new),
        builtin_pi_path().as_deref(),
    ) {
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
        // 应用菜单的点击：把「许可与第三方声明」交给前端弹对话框
        // （不在这里自己拼窗口：文案与第三方表都在前端一处渲染，
        //   菜单项与应用内入口必须落到**同一个**界面上——规矩 36）
        .on_menu_event(|app, event| {
            if event.id().as_ref() == crate::legal::MENU_ID_LEGAL {
                // 窗口可能被托盘收起来了：先亮出来再发事件，否则用户点了菜单什么都不发生
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = app.emit("app:open-about", serde_json::json!({}));
            }
        })
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
            // 应用菜单（docs/04 §2.5）：默认菜单 + 「许可与第三方声明」。
            // 失败**不拦启动**（菜单没了应用照跑，而且应用内还有两个入口），
            // 但绝不静默——GPL §5(d) 要求交互界面显示这些声明。
            if let Err(e) = crate::legal::install_app_menu(app.handle()) {
                eprintln!("[piggy] 警告：安装应用菜单失败（许可条目将只在应用内可见）: {e}");
            }
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
                        rd.join("resources").join("pi").join("pi.exe")
                    } else {
                        rd.join("resources").join("pi").join("pi")
                    };
                    let mut reg = state.registry.lock().await;
                    reg.builtin = Some(builtin);
                    reg.pi_source = state.perf.read().map(|p| p.pi_source).unwrap_or_default();
                    reg.pi_custom_path = state
                        .perf
                        .read()
                        .ok()
                        .and_then(|p| p.pi_path.clone())
                        .map(PathBuf::from);
                    // 权限守卫脚本 + 持久化的默认档位（「工作区内修改」缺脚本会拒绝启动）
                    reg.guard_script = crate::pi::permission::guard_script_path(resource_dir.as_deref());
                    // 桥接扩展（docs/06 §4）：缺失只让 Fleet 面板显示"未安装"，不影响会话
                    reg.bridge_script = crate::pi::resources::bridge_script_path(resource_dir.as_deref());
                    // 子代理委派策略（docs/06 §6）：只在开关打开时记录。是否**真的**注入
                    // 还要看档位（限制档位下扩展工具不存在，注入等于让模型调不存在的工具）。
                    reg.subagent_policy = subagent_policy_for(&state, resource_dir.as_deref());
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
                    match &reg.bridge_script {
                        Some(p) => eprintln!("[piggy] 子代理桥接扩展: {}", p.display()),
                        None => eprintln!("[piggy] 子代理桥接扩展缺失：Fleet 面板的会话内子代理不可用"),
                    }
                    if let Some(p) = &reg.subagent_policy {
                        eprintln!(
                            "[piggy] 子代理委派已开启（仅「完全权限」档生效）: {}",
                            p.display()
                        );
                    }
                } else {
                    // resource_dir 拿不到时也必须初始化守卫与档位：
                    // 之前整块都在 `if let Some(rd)` 里，于是 resource_dir 一失败，
                    // guard_script 就静默保持 None → 默认档位拒绝启动一切会话（实测踩到）
                    let mut reg = state.registry.lock().await;
                    reg.guard_script = crate::pi::permission::guard_script_path(None);
                    reg.bridge_script = crate::pi::resources::bridge_script_path(None);
                    reg.subagent_policy = subagent_policy_for(&state, None);
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
            commands::pick_pi_binary,
            commands::webview_log,
            commands::tab_create,
            commands::tab_close,
            commands::tab_sleep,
            commands::tab_sleep_idlest,
            commands::pi_set_permission_mode,
            commands::pi_set_default_permission,
            commands::permission_modes,
            commands::pi_source_options,
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
            commands::session_title_source,
            commands::session_title_generate,
            commands::title_model_options,
            commands::legal_notices,
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
            open_in_app::open_in_app_list,
            open_in_app::open_in_app_icon,
            open_in_app::open_in_app_open,
            open_in_app::open_path_available,
            open_in_app::open_path_applications,
            open_in_app::open_path_open,
            commands::fs_list_dir,
            commands::fs_write_edit,
            commands::pi_export_html,
            provider::provider_overview,
            provider::provider_save,
            provider::provider_set_key,
            provider::provider_remove_key,
            provider::provider_remove,
            provider::provider_discover,
            plugin::plugin_overview,
            plugin::plugin_run,
            plugin::plugin_jobs,
            plugin::plugin_job_cancel,
            plugin::plugin_set_enabled,
            plugin::plugin_add_path,
            plugin::plugin_remove_path,
            plugin::plugin_delete_discovered,
            plugin::plugin_check_source,
            plugin::plugin_project_trust,
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
