//! IPC 命令层（docs/03 §1 原则 2）：参数校验 + 转发，不含业务逻辑。

use crate::config::{app, pi_files};
use crate::events::{EventSink, TauriSink};
use crate::pi::discovery::discover;
use crate::pi::process::SessionTarget;
use crate::sessions::list;
use crate::sessions::registry::{spawn_tab_watcher, SharedRegistry, TabSnapshot};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

pub struct AppState {
    pub registry: SharedRegistry,
    pub watcher: Arc<tokio::sync::Mutex<Option<Arc<dyn notify::Watcher + Send + Sync>>>>,
    /// 性能配置（05 §4）：启动加载，config_save 后更新（M2）
    pub perf: Arc<std::sync::RwLock<app::PerfConfig>>,
    /// A 层 Fleet 编排（docs/06 §3，M3）
    pub fleet: crate::fleet::SharedFleet,
    /// 内嵌终端 PTY 会话表（M4）
    pub pty: crate::pty::SharedPtyMap,
}

/// watcher 监听根：agent 目录（含 settings.json）+ 生效会话根。
/// 自定义 sessionDir 在 agent 目录之外时必须单独监听，否则新会话不刷新侧栏。
pub fn watcher_roots() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let agent_root = PathBuf::from(home).join(".pi/agent");
    let sessions = pi_files::sessions_root();
    if sessions.starts_with(&agent_root) {
        vec![agent_root]
    } else {
        vec![agent_root, sessions]
    }
}

/// 启动/重启会话目录 watcher（settings_write 变更 sessionDir 后调用）
pub async fn restart_sessions_watcher(app: &AppHandle, state: &State<'_, AppState>) {
    {
        let mut slot = state.watcher.lock().await;
        if let Some(old) = slot.take() {
            drop(old); // 旧 watcher 停止
        }
        let handle = app.clone();
        match list::spawn_sessions_watcher(watcher_roots(), move || {
            use tauri::Emitter;
            let _ = handle.emit("sessions:changed", serde_json::json!({ "at": now_ms() }));
        }) {
            Ok(w) => {
                *slot = Some(w);
                eprintln!("[piggy] sessions watcher 已启动");
            }
            Err(e) => eprintln!("[piggy] watcher 启动失败: {e}"),
        }
    }
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
    let w = reg.ensure_worker(&sink(app), tab_id).await?;
    reg.touch(tab_id); // 05 §4.1：任意交互刷新活跃时间
    Ok(w)
}

#[tauri::command]
pub async fn pi_discover(state: State<'_, AppState>) -> Result<Value, String> {
    let builtin = state.registry.lock().await.builtin.clone();
    let bin = discover(None, builtin.as_deref()).map_err(|e| e.to_string())?;
    serde_json::to_value(bin).map_err(|e| e.to_string())
}

/// 前端错误上报出口（`ErrorBoundary` / 全局 handler → 这里 → 终端 stdout）。
///
/// 存在的理由：打包版与 `tauri dev` 里 DevTools 默认不可用，而 WebView 的 console
/// 拿不到——React 渲染期异常会卸载整棵树，表现为**全黑窗口且零线索**。
/// 把消息转发到 stdout（前缀 `[piggy][webview]`）后，终端里就能直接看到崩溃原因。
#[tauri::command]
pub fn webview_log(level: String, message: String) {
    let tag = match level.as_str() {
        "error" => "ERROR",
        "warn" => "WARN",
        _ => "INFO",
    };
    eprintln!("[piggy][webview][{tag}] {message}");
}

/// 系统目录选择框（WP5）：对话框由 Rust 侧经 tauri-plugin-dialog 唤起，
/// 不开放 webview → plugin 命令权限面（docs/08 §6 最小权限）。取消返回 None。
#[tauri::command]
pub async fn pick_directory(
    app: AppHandle,
    title: Option<String>,
    start: Option<String>,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let mut builder = app
        .dialog()
        .file()
        .set_title(title.unwrap_or_else(|| "选择目录".into()));
    if let Some(s) = start {
        let pb = PathBuf::from(&s);
        if pb.is_dir() {
            builder = builder.set_directory(pb);
        }
    }
    builder.pick_folder(move |picked| {
        let path = picked.map(|p| p.to_string());
        let _ = tx.send(path);
    });
    rx.await.map_err(|e| format!("目录选择框关闭异常: {e}"))
}

#[tauri::command]
pub async fn tab_create(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: Option<String>,
    session_path: Option<String>,
    name: Option<String>,
) -> Result<TabSnapshot, String> {
    // 空串/纯空白 = 未提供（回退 HOME）；`~` 前缀展开（用户手输路径的常态）
    let cwd = cwd
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| pi_files::expand_home(&s).to_string_lossy().into_owned())
        .map(PathBuf::from)
        .or_else(home_dir)
        .ok_or_else(|| "无法确定 cwd".to_string())?;
    if !cwd.is_dir() {
        return Err(format!(
            "SESSION_CWD_MISSING: 项目目录不存在: {}（请先创建该目录）",
            cwd.display()
        ));
    }
    let target = match session_path {
        Some(p) => SessionTarget::Path(p),
        // 新会话：预创建空文件并以 --session 打开 → pi 立即写 header 并置 flushed，
        // 绕过"首个 LLM 回合才落盘"的懒落盘（docs/02 §6.1），空白会话关掉后不再丢失。
        // 预创建失败（权限/磁盘）不阻断建 tab：回退 SessionTarget::New 走原懒落盘。
        None => match list::precreate_session_file(&cwd) {
            Ok(path) => SessionTarget::Path(path.to_string_lossy().into_owned()),
            Err(e) => {
                eprintln!("[piggy] 会话预落盘失败（回退懒落盘）: {e}");
                SessionTarget::New
            }
        },
    };
    let snapshot = {
        let mut reg = state.registry.lock().await;
        // maxWorkers 上限（05 §4.2）：超限报错，前端提示"一键回收最闲"
        let max = state.perf.read().map(|p| p.max_workers).unwrap_or(8) as usize;
        if reg.alive_worker_count() >= max {
            return Err(format!(
                "MAX_WORKERS: 活跃会话已达上限 {max}。可关闭或休眠不用的标签后重试。"
            ));
        }
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

/* ---------------- M2：性能（05 §4 空闲回收 / maxWorkers / 休眠标签） ---------------- */

/// 休眠标签（05 §4.3）：回收 worker，保留 tab 与游标；再交互自动复活。
#[tauri::command]
pub async fn tab_sleep(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
) -> Result<(), String> {
    let mut reg = state.registry.lock().await;
    reg.sleep_tab(&sink(&app), &tab_id).await
}

/// 一键回收最闲 worker（05 §4.2 超限建议动作）。返回被回收的 tabId。
#[tauri::command]
pub async fn tab_sleep_idlest(app: AppHandle, state: State<'_, AppState>) -> Result<Option<String>, String> {
    let mut reg = state.registry.lock().await;
    Ok(reg.sleep_idlest(&sink(&app)).await)
}

#[tauri::command]
pub async fn perf_config_load() -> Result<Value, String> {
    let cfg = app::perf_config_load();
    serde_json::to_value(cfg).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn perf_config_save(
    state: State<'_, AppState>,
    max_workers: u32,
    idle_timeout_min: u32,
) -> Result<(), String> {
    let mut cfg = app::PerfConfig { max_workers, idle_timeout_min };
    cfg.clamp();
    app::perf_config_save(&cfg)
        .map_err(|e| format!("config.json 写入失败: {e}"))?;
    if let Ok(mut p) = state.perf.write() {
        *p = cfg;
    }
    Ok(())
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
    let mtime_ms = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(serde_json::json!({
        "path": path,
        "size": md.len(),
        "lines": body.lines().count(),
        "mtimeMs": mtime_ms,
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

/* ---------------- M4：资源浏览器 + 快捷编辑（NG4：受限直写 + 冲突警示） ---------------- */

#[tauri::command]
pub async fn fs_list_dir(root: String, path: String) -> Result<Value, String> {
    let root = crate::fs_guard::validate_root(Path::new(&root))?;
    let p = Path::new(&path);
    crate::fs_guard::ensure_within(&root, p).map_err(|e| e.to_string())?;
    let rd = match std::fs::read_dir(p) {
        Ok(rd) => rd,
        Err(e) => return Err(format!("读取目录失败: {e}")),
    };
    let mut entries: Vec<Value> = Vec::new();
    for entry in rd.flatten() {
        let Ok(md) = entry.metadata() else { continue };
        // 必须显式转成 String：`entry.file_name()` 是 `OsString`，serde 在 Unix 上会把它
        // 序列化成 `{"Unix":[字节...]}` 这样的**对象**，前端直接渲染就炸
        // （"Objects are not valid as a React child"）。非 UTF-8 文件名按 lossy 处理，
        // 前端本来也只能按字符串展示。
        entries.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy().into_owned(),
            "isDir": md.is_dir(),
            "size": md.len(),
        }));
    }
    entries.sort_by(|a, b| {
        let dir = b["isDir"].as_bool().unwrap_or(false).cmp(&a["isDir"].as_bool().unwrap_or(false));
        dir.then(a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(serde_json::json!({ "entries": entries }))
}

/// 快捷编辑写入（NG4）：cwd 子树内 + ≤1MB + mtime 冲突拒绝。
#[tauri::command]
pub async fn fs_write_edit(
    root: String,
    path: String,
    content: String,
    base_mtime_ms: Option<u64>,
) -> Result<Value, String> {
    let root = crate::fs_guard::validate_root(Path::new(&root))?;
    let p = PathBuf::from(&path);
    crate::fs_guard::ensure_within(&root, &p).map_err(|e| e.to_string())?;
    if !p.is_file() {
        return Err("只允许编辑已存在的文件（NG4：不做新建/重命名）".into());
    }
    let md = std::fs::metadata(&p).map_err(|e| e.to_string())?;
    if md.len() > crate::fs_guard::MAX_EDIT_BYTES {
        return Err("文件超过 1MB，快捷编辑不适用".into());
    }
    if crate::fs_guard::mtime_conflicted(md.modified(), base_mtime_ms) {
        return Err(
            "CONFLICT: 文件已被外部修改（或无法确认修改时间）。请重新打开预览后再编辑。".into(),
        );
    }
    let bytes = content.as_bytes();
    if bytes.len() as u64 > crate::fs_guard::MAX_EDIT_BYTES {
        return Err("编辑后超过 1MB".into());
    }
    std::fs::write(&p, bytes).map_err(|e| format!("写入失败: {e}"))?;
    let new_mtime = std::fs::metadata(&p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    Ok(serde_json::json!({ "mtimeMs": new_mtime }))
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

/* ---------------- M3：A 层 Fleet 编排（docs/06 §3） ---------------- */

#[tauri::command]
pub async fn fleet_templates() -> Result<Value, String> {
    Ok(crate::fleet::builtin_templates())
}

#[tauri::command]
pub async fn fleet_list(state: State<'_, AppState>) -> Result<Value, String> {
    Ok(state.fleet.snapshot())
}

fn fleet_emit(app: &AppHandle, state: &State<'_, AppState>) {
    use tauri::Emitter;
    let _ = app.emit("fleet:changed", state.fleet.snapshot());
}

/// 提取最后一条 assistant 消息文本（06 §3.3 结果收集，无需新增 RPC）。
fn last_assistant_text(messages: &Value) -> Option<String> {
    let arr = messages.as_array()?;
    let text_of = |content: &Value| -> String {
        match content {
            Value::String(s) => s.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .filter_map(|b| {
                    if b["type"] == "text" {
                        b["text"].as_str().map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        }
    };
    arr.iter()
        .rev()
        .find(|m| m["role"] == "assistant" || m["message"]["role"] == "assistant")
        .map(|m| {
            if m.get("message").is_some() {
                text_of(&m["message"]["content"])
            } else {
                text_of(&m["content"])
            }
        })
        .filter(|s| !s.is_empty())
}

/// 调度一轮：把所有就绪 lane 拉起（资源上限由 create_tab 的 maxWorkers 兜底排队）。
async fn schedule_run(app: AppHandle, run_id: String) {
    let state = app.state::<AppState>();
    let ready = {
        let Some(run) = state.fleet.get(&run_id) else { return };
        if run.status != crate::fleet::RunStatus::Running {
            return;
        }
        run.ready_lanes()
    };
    for lane_key in ready {
        let (prompt, cwd) = {
            let Some(run) = state.fleet.get(&run_id) else { return };
            let Some(lane) = run.lane(&lane_key).cloned() else { continue };
            let prompt = crate::fleet::render_prompt(&lane.prompt, &run.task, &run, &lane);
            let cwd = if lane.worktree {
                match crate::fleet::create_worktree(&run.cwd, &format!("{}-{}", run.id[..8].replace('-', ""), lane_key)) {
                    Ok(p) => p,
                    Err(e) => {
                        eprintln!("[fleet] worktree 创建失败（回退主 cwd）: {e}");
                        run.cwd.clone()
                    }
                }
            } else {
                run.cwd.clone()
            };
            (prompt, cwd)
        };
        // 拉起 lane worker-tab（NoSession：不污染项目会话列表，06 §3.3）
        let tab_id = {
            let mut reg = state.registry.lock().await;
            let lane_label = format!("fleet:{}/{}", &run_id[..8], lane_key);
            match reg
                .create_tab(&sink(&app), cwd.clone(), SessionTarget::NoSession, Some(lane_label))
                .await
            {
                Ok(snap) => snap.tab_id,
                Err(e) => {
                    eprintln!("[fleet] lane {lane_key} 启动失败: {e}");
                    // MAX_WORKERS = 排队（下一次调度触发）；其余直接计失败
                    if !e.starts_with("MAX_WORKERS") {
                        state.fleet.fail_lane_by_key(&run_id, &lane_key);
                        fleet_emit(&app, &state);
                    }
                    continue;
                }
            }
        };
        state.fleet.bind_tab(&run_id, &lane_key, &tab_id);
        let worker = state.registry.lock().await.tabs.get(&tab_id).and_then(|t| t.worker.clone());
        fleet_emit(&app, &state);
        if let Some(worker) = worker.clone() {
            watch_lane(app.clone(), run_id.clone(), lane_key.clone(), tab_id, worker.clone());
            if let Err(e) = worker.prompt(&prompt, None, None).await {
                eprintln!("[fleet] lane {lane_key} prompt 失败: {e}");
                state.fleet.fail_lane_by_key(&run_id, &lane_key);
                fleet_emit(&app, &state);
            }
        }
    }
}

/// lane 状态监听：Busy→Ready 视为 settle（收集结果 + 驱动下游）；崩溃计失败。
fn watch_lane(
    app: AppHandle,
    run_id: String,
    _lane_key: String,
    tab_id: String,
    worker: crate::pi::client::Worker,
) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let mut rx = worker.subscribe_state();
        let mut was_busy = false;
        loop {
            if rx.changed().await.is_err() {
                return;
            }
            let s = *rx.borrow();
            match s {
                crate::pi::client::WorkerState::Busy => was_busy = true,
                crate::pi::client::WorkerState::Ready if was_busy => {
                    let text = worker
                        .get_messages()
                        .await
                        .ok()
                        .and_then(|m| last_assistant_text(&m))
                        .unwrap_or_default();
                    state.fleet.settle_lane(&tab_id, &text);
                    let finished = state.fleet.maybe_finish(&run_id);
                    fleet_emit(&app, &state);
                    if !finished {
                        schedule_run(app, run_id).await;
                    }
                    return;
                }
                crate::pi::client::WorkerState::Crashed | crate::pi::client::WorkerState::Stopped => {
                    state.fleet.fail_lane(&tab_id);
                    fleet_emit(&app, &state);
                    return;
                }
                _ => {}
            }
        }
    });
}

#[tauri::command]
pub async fn fleet_start(
    app: AppHandle,
    state: State<'_, AppState>,
    template_id: String,
    task: String,
    cwd: String,
) -> Result<String, String> {
    let templates = crate::fleet::builtin_templates();
    let template = templates
        .get(&template_id)
        .ok_or_else(|| format!("未知模板: {template_id}"))?;
    if task.trim().is_empty() {
        return Err("任务描述为空".into());
    }
    let run_id = uuid::Uuid::new_v4().to_string();
    let run = crate::fleet::build_run(
        run_id.clone(),
        &template_id,
        template,
        task.trim(),
        PathBuf::from(&cwd),
    )?;
    state.fleet.insert(run);
    fleet_emit(&app, &state);
    schedule_run(app, run_id.clone()).await;
    Ok(run_id)
}

#[tauri::command]
pub async fn fleet_abort(app: AppHandle, state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    let live_tabs = state.fleet.abort(&run_id).ok_or_else(|| format!("run 不存在: {run_id}"))?;
    {
        let reg = state.registry.lock().await;
        for tab_id in live_tabs {
            if let Some(w) = reg.tabs.get(&tab_id).and_then(|t| t.worker.clone()) {
                let _ = w.clear_queue().await;
                let _ = w.abort().await;
            }
        }
    }
    fleet_emit(&app, &state);
    Ok(())
}

#[tauri::command]
pub async fn fleet_steer(
    app: AppHandle,
    state: State<'_, AppState>,
    run_id: String,
    lane_key: String,
    message: String,
) -> Result<bool, String> {
    let tab_id = state
        .fleet
        .get(&run_id)
        .and_then(|r| r.lane(&lane_key).and_then(|l| l.tab_id.clone()))
        .ok_or_else(|| format!("lane 不存在: {lane_key}"))?;
    let worker = worker_of(&app, &state, &tab_id).await?;
    let streaming = matches!(
        worker.state(),
        crate::pi::client::WorkerState::Busy
    );
    let behavior = if streaming { Some("steer") } else { None };
    worker.prompt(&message, None, behavior).await?;
    Ok(streaming)
}

/// lane 提升为标签页（06 §3.5）：返回该 lane 的 TabSnapshot 供前端挂 dockview 面板。
#[tauri::command]
pub async fn fleet_open_lane(
    state: State<'_, AppState>,
    run_id: String,
    lane_key: String,
) -> Result<TabSnapshot, String> {
    let tab_id = state
        .fleet
        .get(&run_id)
        .and_then(|r| r.lane(&lane_key).and_then(|l| l.tab_id.clone()))
        .ok_or_else(|| format!("lane 不存在: {lane_key}"))?;
    state
        .registry
        .lock()
        .await
        .snapshot(&tab_id)
        .ok_or_else(|| format!("tab 不存在: {tab_id}"))
}

/* ---------------- M4：登录内嵌终端（pty.rs + 前端 xterm） ---------------- */

#[tauri::command]
pub async fn pty_open(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: Option<String>,
) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let cwd = cwd.unwrap_or_else(|| std::env::var("HOME").unwrap_or_else(|_| "/".into()));
    let handle = crate::pty::open_pty(&state.pty, &app, &id, &cwd, 24, 80)?;
    Ok(serde_json::json!({ "id": handle.id, "rows": handle.rows, "cols": handle.cols }))
}

#[tauri::command]
pub async fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    crate::pty::write_pty(&state.pty, &id, &data)
}

#[tauri::command]
pub async fn pty_resize(
    state: State<'_, AppState>,
    id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    crate::pty::resize_pty(&state.pty, &id, rows, cols)
}

#[tauri::command]
pub async fn pty_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    crate::pty::close_pty(&state.pty, &id)
}
