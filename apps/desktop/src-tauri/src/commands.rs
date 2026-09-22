//! IPC 命令层（docs/03 §1 原则 2）：参数校验 + 转发，不含业务逻辑。

use crate::config::{app, pi_files};
use crate::events::{EventSink, TauriSink};
use crate::pi::discovery::discover;
use crate::pi::process::{self, SessionTarget};
use crate::sessions::list;
use crate::sessions::registry::{spawn_tab_watcher, Registry, SharedRegistry, TabSnapshot};
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, State};

pub struct AppState {
    pub registry: SharedRegistry,
    pub watcher: Arc<tokio::sync::Mutex<Option<Arc<dyn notify::Watcher + Send + Sync>>>>,
}

/// 启动/重启会话目录 watcher（settings_write 变更 sessionDir 后调用）
pub async fn restart_sessions_watcher(app: &AppHandle, state: &State<'_, AppState>) {
    let new_watcher = {
        let mut slot = state.watcher.lock().await;
        if let Some(old) = slot.take() {
            drop(old); // 旧 watcher 停止
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let root = std::path::PathBuf::from(home).join(".pi/agent"); // 根下含 settings.json 变更
        let handle = app.clone();
        match list::spawn_sessions_watcher(root, move || {
            use tauri::Emitter;
            let _ = handle.emit("sessions:changed", serde_json::json!({ "at": now_ms() }));
        }) {
            Ok(w) => {
                *slot = Some(w);
                eprintln!("[piggy] sessions watcher 已启动");
            }
            Err(e) => eprintln!("[piggy] watcher 启动失败: {e}"),
        }
    };
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn sink(app: &AppHandle) -> Arc<dyn EventSink> {
    Arc::new(TauriSink { app: app.clone() })
}

async fn worker_of(
    app: &AppHandle,
    state: &State<'_, AppState>,
    tab_id: &str,
) -> Result<crate::pi::client::Worker, String> {
    let mut reg = state.registry.lock().await;
    reg.ensure_worker(&sink(app), tab_id).await
}

#[tauri::command]
pub async fn pi_discover() -> Result<Value, String> {
    let bin = discover(None).map_err(|e| e.to_string())?;
    serde_json::to_value(bin).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tab_create(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: Option<String>,
    session_path: Option<String>,
    name: Option<String>,
) -> Result<TabSnapshot, String> {
    let cwd = cwd
        .map(PathBuf::from)
        .or_else(home_dir)
        .ok_or_else(|| "无法确定 cwd".to_string())?;
    let target = match session_path {
        Some(p) => SessionTarget::Path(p),
        None => SessionTarget::New,
    };
    let snapshot = {
        let mut reg = state.registry.lock().await;
        match reg.create_tab(&sink(&app), cwd, target, name).await {
            Ok(s) => {
                eprintln!("[piggy] tab_create ok: {}", s.tab_id);
                s
            }
            Err(e) => {
                eprintln!("[piggy] tab_create FAILED: {e}");
                return Err(e);
            }
        }
    };
    spawn_tab_watcher(
        state.registry.clone(),
        sink(&app),
        snapshot.tab_id.clone(),
    );
    Ok(snapshot)
}

#[tauri::command]
pub async fn tab_close(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let mut reg = state.registry.lock().await;
    reg.close_tab(&sink(&app), &tab_id).await
}

#[tauri::command]
pub async fn pi_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    message: String,
    images: Option<Vec<Value>>,
    streaming_behavior: Option<String>,
) -> Result<bool, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.prompt(&message, images, streaming_behavior.as_deref()).await?;
    Ok(true)
}

#[tauri::command]
pub async fn pi_abort(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.abort().await.map(|_| ())
}

#[tauri::command]
pub async fn pi_clear_queue(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.clear_queue().await
}

#[tauri::command]
pub async fn pi_get_state(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.get_state().await
}

#[tauri::command]
pub async fn pi_get_messages(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.get_messages().await
}

#[tauri::command]
pub async fn pi_get_session_stats(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.get_session_stats().await
}

#[tauri::command]
pub async fn pi_set_model(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    provider: String,
    model_id: String,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.set_model(&provider, &model_id).await
}

#[tauri::command]
pub async fn pi_get_available_models(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.get_available_models().await
}

#[tauri::command]
pub async fn pi_new_session(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    let out = worker.new_session().await?;
    let mut reg = state.registry.lock().await;
    if let Ok(st) = worker.get_state().await {
        if let Some(tab) = reg.tabs.get_mut(&tab_id) {
            tab.session_file = st["sessionFile"].as_str().map(String::from);
            tab.session_id = st["sessionId"].as_str().map(String::from);
        }
    }
    Ok(out)
}

#[tauri::command]
pub async fn pi_set_session_name(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    name: String,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    let out = worker.set_session_name(&name).await;
    if out.is_ok() {
        let mut reg = state.registry.lock().await;
        if let Some(tab) = reg.tabs.get_mut(&tab_id) {
            tab.session_name = Some(name);
        }
    }
    out
}

/// Extension UI 应答（docs/02 §8）：前端弹窗交互后写回 stdin。
#[tauri::command]
pub async fn ui_reply(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    response: Value,
) -> Result<(), String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.ui_response(response).await
}

#[tauri::command]
pub async fn pi_stderr_tail(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    let tail: Vec<String> = worker.stderr_tail.lock().await.iter().cloned().collect();
    serde_json::to_value(tail).map_err(|e| e.to_string())
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

/* ---------------- M1：会话列表 / 布局 / thinking / tree / fork / commands ---------------- */

/// webview 重载（HMR/刷新）后由新 JS 上下文首先调用：
/// 清理上一上下文遗留的全部 worker/registry（单窗口 M1 语义；多窗口需按窗口归属，见 docs/09 M1 修正记录）。
#[tauri::command]
pub async fn boot_reset(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    let tab_ids = {
        let reg = state.registry.lock().await;
        reg.tab_ids()
    };
    for id in tab_ids {
        let mut reg = state.registry.lock().await;
        let _ = reg.close_tab(&sink(&app), &id).await;
    }
    Ok(())
}

#[tauri::command]
pub async fn session_list() -> Result<Vec<list::SessionMeta>, String> {
    tokio::task::spawn_blocking(list::scan_sessions)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn session_delete(path: String) -> Result<(), String> {
    list::trash_session(&path)
}

/// 关闭会话重命名：临时 worker → set_session_name → 关闭。
#[tauri::command]
pub async fn session_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<(), String> {
    let cwd = std::path::PathBuf::from(
        std::env::var("HOME").unwrap_or_else(|_| "/".into()),
    );
    let worker = {
        let mut reg = state.registry.lock().await;
        let pi_bin = reg.resolve_bin()?;
        crate::pi::process::spawn_worker(
            &format!("rename-{}", uuid::Uuid::new_v4()),
            crate::pi::process::SpawnArgs {
                cwd,
                pi_bin,
                session: SessionTarget::Path(path),
                name: None,
            },
            sink(&app),
        )
        .await?
    };
    let out = worker.set_session_name(&name).await;
    worker.shutdown().await;
    out.map(|_| ())
}

#[tauri::command]
pub async fn layout_load() -> Result<Value, String> {
    app::layout_load()
}

#[tauri::command]
pub async fn layout_save(value: Value) -> Result<(), String> {
    app::layout_save(&value)
}

#[tauri::command]
pub async fn pi_get_entries(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    since: Option<String>,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.get_entries(since.as_deref()).await
}

#[tauri::command]
pub async fn pi_get_tree(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.get_tree().await
}

#[tauri::command]
pub async fn pi_get_fork_messages(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.get_fork_messages().await
}

#[tauri::command]
pub async fn pi_fork(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    entry_id: String,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.fork(&entry_id).await
}

#[tauri::command]
pub async fn pi_clone(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.clone_session().await
}

#[tauri::command]
pub async fn pi_set_thinking_level(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    level: String,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.set_thinking_level(&level).await
}

#[tauri::command]
pub async fn pi_get_available_thinking_levels(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.get_available_thinking_levels().await
}

#[tauri::command]
pub async fn pi_cycle_thinking(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.cycle_thinking_level().await
}

#[tauri::command]
pub async fn pi_get_commands(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.get_commands().await
}

#[tauri::command]
pub async fn pi_export_html(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    output_path: Option<String>,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.export_html(output_path.as_deref()).await
}

/// 文件预览读取（M1 限定 $HOME 子树；docs/08 §6 scope 收敛）。
#[tauri::command]
pub async fn fs_preview_read(path: String) -> Result<Value, String> {
    use std::os::unix::fs::MetadataExt;
    let home = std::env::var("HOME").unwrap_or_default();
    let pb = std::path::PathBuf::from(&path);
    if !pb.starts_with(&home) {
        return Err("路径越界（仅限用户目录）".into());
    }
    let md = std::fs::metadata(&pb).map_err(|e| e.to_string())?;
    if md.len() > 5 * 1024 * 1024 {
        return Err("文件超过 5MB，暂不支持预览".into());
    }
    let body = std::fs::read_to_string(&pb)
        .map_err(|e| format!("读取失败（二进制文件?）: {e}"))?;
    Ok(serde_json::json!({
        "path": path,
        "size": md.size(),
        "lines": body.lines().count(),
        "content": body,
    }))
}

/* ---------------- M1 WP5：pi 配置文件（auth/models/settings） ---------------- */

#[tauri::command]
pub async fn auth_list() -> Result<Value, String> {
    tokio::task::spawn_blocking(pi_files::auth_list)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn auth_set_key(provider: String, api_key: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || pi_files::auth_set_key(&provider, &api_key))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn auth_remove(provider: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || pi_files::auth_remove(&provider))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn models_read() -> Result<Value, String> {
    tokio::task::spawn_blocking(pi_files::models_read)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn models_write(value: Value) -> Result<(), String> {
    tokio::task::spawn_blocking(move || pi_files::models_write(&value))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn settings_read() -> Result<Value, String> {
    tokio::task::spawn_blocking(pi_files::settings_read)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn settings_write(
    app: AppHandle,
    state: State<'_, AppState>,
    value: Value,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || pi_files::settings_write(&value))
        .await
        .map_err(|e| e.to_string())??;
    // 会话目录可能变更：重启 watcher（根目录随 sessionDir）+ 通知前端
    restart_sessions_watcher(&app, &state).await;
    use tauri::Emitter;
    let _ = app.emit("sessions:changed", serde_json::json!({ "reason": "settings" }));
    Ok(())
}

#[tauri::command]
pub async fn session_dir_effective() -> Result<Value, String> {
    tokio::task::spawn_blocking(pi_files::session_dir_effective)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn pi_compact(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    custom_instructions: Option<String>,
) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.compact(custom_instructions.as_deref()).await
}

#[tauri::command]
pub async fn pi_abort_bash(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.abort_bash().await
}

#[tauri::command]
pub async fn pi_bash(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    command: String,
) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.bash(&command).await
}
