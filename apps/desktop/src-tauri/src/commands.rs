//! IPC 命令层（docs/03 §1 原则 2）：参数校验 + 转发，不含业务逻辑。

use crate::config::{app, pi_files};
use crate::events::{EventSink, TauriSink};
use crate::pi::discovery::{discover, PiSource};
use crate::pi::permission::PermissionMode;
use crate::pi::process::SessionTarget;
use crate::sessions::list;
use crate::sessions::registry::{spawn_tab_watcher, SharedRegistry, TabSnapshot};
use serde_json::{json, Value};
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

/// 当前实际生效的 pi 二进制（按设置里的来源解析，含回退结果与 `PI_BIN` 覆盖）。
#[tauri::command]
pub async fn pi_discover(state: State<'_, AppState>) -> Result<Value, String> {
    let (source, custom, builtin) = {
        let reg = state.registry.lock().await;
        (reg.pi_source, reg.pi_custom_path.clone(), reg.builtin.clone())
    };
    let bin = discover(source, custom.as_deref(), builtin.as_deref()).map_err(|e| e.to_string())?;
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

/// 选一个可执行文件（用于指定自定义 pi）。
///
/// 与 `pick_directory` 分开是必须的：`pi_source = custom` 要的是**文件**，
/// 用选目录的对话框拿到文件夹只会被 `discover` 的 `is_file()` 拒绝。
/// macOS 上 `.app` 包里的可执行文件默认不可选，所以这里不禁用「显示包内容」之外的路径。
#[tauri::command]
pub async fn pick_pi_binary(app: AppHandle, start: Option<String>) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let mut builder = app
        .dialog()
        .file()
        .set_title("选择 pi 可执行文件")
        .add_filter("pi 可执行文件", &["", "exe", "cmd"]);
    if let Some(s) = start {
        let pb = PathBuf::from(&s);
        // 传进来的可能是文件本身（重新选择时）→ 取它所在目录作为起点
        let dir = if pb.is_dir() { Some(pb) } else { pb.parent().map(Path::to_path_buf) };
        if let Some(d) = dir.filter(|d| d.is_dir()) {
            builder = builder.set_directory(d);
        }
    }
    builder.pick_file(move |picked| {
        let path = picked.map(|p| p.to_string());
        let _ = tx.send(path);
    });
    rx.await.map_err(|e| format!("文件选择框关闭异常: {e}"))
}

#[tauri::command]
pub async fn tab_create(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: Option<String>,
    session_path: Option<String>,
    name: Option<String>,
    permission: Option<String>,
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
    // 权限档位：显式传入 > 持久化默认。
    // 非法值**直接报错**而不是静默回落——权限档悄悄降级成更宽松的一档，
    // 是本项目最不能接受的失败方式（用户会以为限制还在）。
    let permission = match permission.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => PermissionMode::parse(s)?,
        None => state.registry.lock().await.default_permission,
    };
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
        match reg.create_tab(&sink(&app), cwd, target, name, permission).await {
            Ok(s) => {
                eprintln!(
                    "[piggy] tab_create ok: {} (permission={})",
                    s.tab_id,
                    s.permission.as_str()
                );
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

/// 切换某标签页的权限档位。
///
/// `--tools` / `-e` 都是 pi 的 CLI 参数，RPC 没有运行期改工具的接口，
/// 所以实现是「停旧进程 → 按新档复活」，会话文件与游标不变（复用崩溃复活路径）。
/// 同时把该档记为新标签页的默认值并持久化到 `~/.piggy/config.json`。
#[tauri::command]
pub async fn pi_set_permission_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    mode: String,
) -> Result<Value, String> {
    let mode = PermissionMode::parse(&mode)?;
    let out = {
        let mut reg = state.registry.lock().await;
        reg.set_permission(&sink(&app), &tab_id, mode).await?
    };
    save_default_permission(&state, mode);
    Ok(out)
}

/// 设置页用：只改**新标签页的默认权限档位**，不动任何正在运行的会话。
///
/// 与 `pi_set_permission_mode` 的区别：那个是"切这个标签页的档位"（要重启它的 worker），
/// 这个是"以后新开的会话默认用哪一档"。设置页里传 `tabId: ''` 去调前者会直接报错。
#[tauri::command]
pub async fn pi_set_default_permission(
    state: State<'_, AppState>,
    mode: String,
) -> Result<Value, String> {
    let parsed = PermissionMode::parse(&mode)?;
    {
        let mut reg = state.registry.lock().await;
        reg.default_permission = parsed;
    }
    save_default_permission(&state, parsed);
    Ok(serde_json::json!({ "defaultPermission": parsed }))
}

/// 各档位的能力矩阵（前端渲染选择器用，避免 UI 文案与后端行为漂移）。
#[tauri::command]
pub fn permission_modes() -> Value {
    let modes: Vec<Value> =
        [PermissionMode::ReadOnly, PermissionMode::Workspace, PermissionMode::Full]
            .into_iter()
            .map(|m| {
                serde_json::json!({
                    "id": m.as_str(),
                    "label": m.label(),
                    "tools": m.tool_allowlist(),
                    "unrestricted": m.tool_allowlist().is_none(),
                    "pathGuard": m.needs_path_guard(),
                })
            })
            .collect();
    serde_json::json!({ "modes": modes })
}

/// 把档位写成新标签页的默认值（内存 + `~/.piggy/config.json`）。
fn save_default_permission(state: &State<'_, AppState>, mode: PermissionMode) {
    let snapshot = {
        let mut cfg = match state.perf.write() {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[piggy] 权限默认值写入失败（RwLock 中毒）: {e}");
                return;
            }
        };
        cfg.permission_mode = mode;
        cfg.clone()
    };
    if let Err(e) = app::perf_config_save(&snapshot) {
        eprintln!("[piggy] 权限默认值持久化失败: {e}");
    }
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
    app: AppHandle,
    state: State<'_, AppState>,
    max_workers: u32,
    idle_timeout_min: u32,
    // 可选：pi 来源（system / bundled / custom）与 custom 时的绝对路径。
    // 不传 = 保持既有值。（tauri::command 不允许参数上写文档注释，故用普通注释）
    pi_source: Option<String>,
    pi_path: Option<String>,
    // 子代理委派开关（docs/06 §6）。不传 = 保持既有值。
    subagent_delegation: Option<bool>,
    // 标题生成（docs/03 §2.16）。都不传 = 保持既有值。
    title_max_chars: Option<u32>,
    title_source: Option<String>,
    title_model: Option<String>,
    title_thinking: Option<String>,
) -> Result<(), String> {
    // 读-改-写：config.json 里还有 permission_mode 等字段，
    // 从零构造会让「在设置里改并发数」顺手把权限档位重置——必须保留既有值。
    let mut cfg = app::perf_config_load();
    cfg.max_workers = max_workers;
    cfg.idle_timeout_min = idle_timeout_min;
    if let Some(n) = title_max_chars {
        cfg.title_max_chars = n.clamp(1, 200);
    }
    if let Some(s) = title_source.as_deref() {
        cfg.title_source = crate::sessions::title::TitleStrategy::parse(s)?;
    }
    if let Some(m) = title_model.as_deref() {
        let m = m.trim();
        // 空串 = 清掉覆盖（回到"跟会话自己的模型"），不是"用一个空模型名"
        cfg.title_model = if m.is_empty() { None } else { Some(m.to_string()) };
    }
    if let Some(t) = title_thinking.as_deref() {
        let t = t.trim();
        // 空串 = 清掉（回到"用 pi/模型自己的默认档"）。
        // 不认识的值在这里**报错**（而不是像 clamp 那样默默丢掉）：
        // 界面只可能从固定清单里选，走到这里说明调用方写错了，应该吵。
        if t.is_empty() {
            cfg.title_thinking = None;
        } else if crate::sessions::title::is_valid_thinking(t) {
            cfg.title_thinking = Some(t.to_string());
        } else {
            return Err(format!(
                "未知的思考强度 {t:?}（可选：{}）",
                crate::sessions::title::THINKING_LEVELS.join(" / ")
            ));
        }
    }

    // 1) 先算出变更计划（纯函数；会拦住"custom 但没有路径"这种自相矛盾的组合）
    let plan = crate::pi::discovery::plan_source_change(
        cfg.pi_source,
        cfg.pi_path.as_deref(),
        pi_source.as_deref(),
        pi_path.as_deref(),
    )?;

    // 2) **落盘之前**先把新来源真的解析一遍。
    //    顺序很关键：以前是先写 config.json 再 resolve，于是"custom + 无路径"会被
    //    写进磁盘、然后 resolve 报错返回 —— config.json 停在一个解析不了的状态，
    //    之后每次建会话都失败，而界面上因为命令抛错没走到 reload，看起来只是"点了没反应"。
    if let Some((next_source, next_path)) = &plan {
        let builtin = state.registry.lock().await.builtin.clone();
        discover(
            *next_source,
            next_path.as_deref().map(Path::new),
            builtin.as_deref(),
        )
        .map_err(|e| format!("「{}」当前不可用，配置未改动：{e}", next_source.label()))?;
    }

    // 3) 验证通过才落盘 + 更新内存
    if let Some((next_source, next_path)) = plan {
        cfg.pi_source = next_source;
        cfg.pi_path = next_path;
    }
    // 开关打开前先确认策略文件真的在 —— 否则这次保存会写下一个"看起来生效、
    // 实际每次建会话都拒绝启动"的配置（cli_args 里 fail-closed）。
    if subagent_delegation == Some(true) {
        let dir = app.path().resource_dir().ok();
        if crate::pi::resources::subagent_policy_path(dir.as_deref()).is_none() {
            return Err(
                "SUBAGENT_POLICY_MISSING: 找不到子代理委派策略文件 piggy-subagent-policy.md，\
                 已拒绝打开该开关（否则每次建会话都会启动失败）。请重新安装 Piggy。"
                    .to_string(),
            );
        }
    }
    if let Some(on) = subagent_delegation {
        cfg.subagent_delegation = on;
    }
    cfg.clamp();
    app::perf_config_save(&cfg)
        .map_err(|e| format!("config.json 写入失败: {e}"))?;
    if let Ok(mut p) = state.perf.write() {
        *p = cfg.clone();
    }

    // 4) 同步到 registry 并让缓存路径失效（已在跑的 worker 仍持旧二进制，直到被重启）
    {
        let mut reg = state.registry.lock().await;
        let changed = reg.pi_source != cfg.pi_source || reg.pi_custom_path.as_deref() != cfg.pi_path.as_deref().map(Path::new);
        reg.pi_source = cfg.pi_source;
        reg.pi_custom_path = cfg.pi_path.as_ref().map(PathBuf::from);
        if changed {
            reg.pi_bin = None;
            let resolved = reg.resolve_bin()?;
            eprintln!(
                "[piggy] pi 来源已切换: {} → {}",
                cfg.pi_source.as_str(),
                resolved.display()
            );
        }
    }
    Ok(())
}

/// 设置页用：各来源选项 + 当前实际生效的二进制。
#[tauri::command]
pub async fn pi_source_options(state: State<'_, AppState>) -> Result<Value, String> {
    let (source, custom, builtin, resolved) = {
        let reg = state.registry.lock().await;
        (reg.pi_source, reg.pi_custom_path.clone(), reg.builtin.clone(), reg.pi_bin.clone())
    };
    let builtin_available = builtin.as_ref().map(|b| b.is_file()).unwrap_or(false);
    let current = resolved.or_else(|| {
        discover(source, custom.as_deref(), builtin.as_deref()).ok()
    });
    // 注意：不能把 `[..].into_iter().map(..)` 直接写进 json! 里——
    // 宏的 TT muncher 会把 `[...]` 当 JSON 数组字面量，随后的 `.` 就报 `no rules expected .`。
    let options: Vec<Value> = [PiSource::System, PiSource::Bundled, PiSource::Custom]
        .into_iter()
        .map(|s| {
            serde_json::json!({
                "id": s.as_str(),
                "label": s.label(),
                "available": match s {
                    PiSource::Bundled => builtin_available,
                    _ => true,
                },
            })
        })
        .collect();
    Ok(serde_json::json!({
        "source": source,
        "customPath": custom.map(|p| p.to_string_lossy().into_owned()),
        "builtinAvailable": builtin_available,
        "builtinPath": builtin.map(|p| p.to_string_lossy().into_owned()),
        "current": current,
        "options": options,
    }))
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
/// 起一个只读临时 worker，只为调一次 `set_session_name`。
///
/// 抽出来是因为**改名的两条入口**（手工重命名、生成标题）必须完全同一条路：
/// 自己往会话文件里塞 `session_info` 会与 pi 的写入格式分叉。
async fn set_session_name_via_worker(
    app: &AppHandle,
    state: &State<'_, AppState>,
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
                // 这个 worker 只用来调一次 set_session_name 改元数据，不该带任何工具能力
                permission: PermissionMode::ReadOnly,
                guard_script: None,
                // 改名的临时 worker 也不需要 Fleet 数据面
                bridge_script: None,
                envs: Vec::new(),
                // 只读档位，本来就不会走到委派（cli_args 里档位判定也会拦下）
                subagent_policy: None,
            },
            sink(app),
        )
        .await?
    };
    let out = worker.set_session_name(&name).await;
    worker.shutdown().await;
    out.map(|_| ())
}

#[tauri::command]
pub async fn session_rename(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    name: String,
) -> Result<(), String> {
    set_session_name_via_worker(&app, &state, path, name).await
}

/// 生成标题**会拿什么去生成**（不调用模型）。界面用它做预览与排查。
#[tauri::command]
pub async fn session_title_source(path: String) -> Result<Value, String> {
    let cfg = app::perf_config_load();
    tokio::task::spawn_blocking(move || {
        let src = crate::sessions::title::read_source(std::path::Path::new(&path))?;
        Ok::<Value, String>(crate::sessions::title::describe(
            &src,
            cfg.title_source,
            cfg.title_max_chars,
            cfg.title_model.as_deref(),
            cfg.title_thinking.as_deref(),
        ))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// pi 此刻**认为可用**的模型（"标题模型"下拉的数据源，docs/04 §2.2）。
///
/// 走 `pi --list-models`：与 `get_available_models` RPC 是同一份数据
/// （`ModelRuntime.getAvailable()`），但**不需要会话**——"标题模型"是全局设置，
/// 打开设置页时可能一个标签页都没有。真机实测 0.6s，所以由界面拉一次即可。
#[tauri::command]
pub async fn title_model_options(
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let pi_bin = {
        let mut reg = state.registry.lock().await;
        reg.resolve_bin()?
    };
    // cwd 用 HOME：pi 会顺带读 `<cwd>/.pi/…` 的项目级配置，而"列出模型"这件事
    // 属于全局设置页，不该跟着某个项目走（项目级模型仍可手动填，见 docs/15 缺口）。
    let cwd = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("/"));
    let opts = crate::sessions::title::list_models(&pi_bin, &cwd).await?;
    serde_json::to_value(&opts).map_err(|e| e.to_string())
}

/// 生成会话标题（docs/03 §2.16）。
///
/// 会**另起一个一次性 pi 进程**（`-p --no-session -nt -nc`）：
/// 用哪个 provider/model、哪把密钥、走不走代理都由 pi 自己解析，
/// 而且 `--no-session` 保证这段生成对话**不进被命名那个会话的转录**。
///
/// `apply` 默认 true：生成完直接写进会话名（走 `set_session_name`）。
/// 返回里同时给 `raw`（模型原样输出）与 `title`（收拾过的），
/// 以及"这次用的是哪个模型"——否则用户看到一个不满意的标题无从判断该换什么。
#[tauri::command]
pub async fn session_title_generate(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
    apply: Option<bool>,
) -> Result<Value, String> {
    let cfg = app::perf_config_load();
    let max_chars = cfg.title_max_chars.clamp(1, 200);
    let strategy = cfg.title_source;
    let source = {
        let path = path.clone();
        tokio::task::spawn_blocking(move || crate::sessions::title::read_source(std::path::Path::new(&path)))
            .await
            .map_err(|e| e.to_string())??
    };
    let (system, user) = crate::sessions::title::build_prompt(&source, strategy, max_chars);

    // 用哪个模型：设置里指定了就用它，否则**跟会话自己的**（会话文件里最后一次
    // model_change）。会话里也没有（新建还没发过消息）→ 都不传，让 pi 用它自己的默认。
    let (provider, model_id) =
        crate::sessions::title::pick_model(cfg.title_model.as_deref(), &source)?;
    let cwd = source
        .cwd
        .as_deref()
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(|| std::path::PathBuf::from(std::env::var("HOME").unwrap_or_else(|_| "/".into())));

    let pi_bin = {
        let mut reg = state.registry.lock().await;
        reg.resolve_bin()?
    };
    let generated = crate::sessions::title::generate(crate::sessions::title::GenRequest {
        pi_bin: &pi_bin,
        cwd: &cwd,
        provider: provider.as_deref(),
        model_id: model_id.as_deref(),
        thinking: cfg.title_thinking.as_deref(),
        system: &system,
        user: &user,
        max_chars,
    })
    .await?;

    if !generated.usable {
        // **不要**用空标题覆盖用户原来的名字。这是最容易发生的一种数据损坏：
        // 模型这次抽风返回空，用户原来手改的名字就没了。
        return Err(format!(
            "模型没有给出可用的标题（原样输出：{:?}）——已保留原来的名字",
            generated.raw.chars().take(80).collect::<String>()
        ));
    }

    let mut applied = false;
    if apply.unwrap_or(true) {
        set_session_name_via_worker(&app, &state, path.clone(), generated.title.clone()).await?;
        applied = true;
    }

    let mut out = serde_json::to_value(&generated).map_err(|e| e.to_string())?;
    out["applied"] = json!(applied);
    out["modelUsed"] = match (&provider, &model_id) {
        (Some(p), Some(m)) => json!(format!("{p}/{m}")),
        _ => Value::Null,
    };
    // 这次请求的思考强度（null = 没传 `--thinking`，用 pi/模型默认）。
    // 报的是**请求值**：pi 对不支持的档位会静默降级（`clampThinkingLevel`），
    // 客户端拿不到降级后的实际值，所以这里不假装知道（docs/15 已知缺口）。
    out["thinkingUsed"] = match cfg.title_thinking.as_deref() {
        Some(t) => json!(t),
        None => Value::Null,
    };
    out["source"] = crate::sessions::title::describe(
        &source,
        strategy,
        max_chars,
        cfg.title_model.as_deref(),
        cfg.title_thinking.as_deref(),
    );
    Ok(out)
}

/// 许可与第三方声明（docs/03 §2.17）。
///
/// 版本号取自 `package_info()`（= Cargo.toml），**不是**前端写死的那个字符串——
/// 「关于」里显示的版本必须是这个二进制真实的版本。
#[tauri::command]
pub async fn legal_notices(app: AppHandle) -> Result<Value, String> {
    let version = app.package_info().version.to_string();
    Ok(crate::legal::notices(&version))
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

/// 提取最后一条 assistant 消息文本（06 §3.3 结果收集）。
/// 实现已移到 `fleet::last_assistant_text`：那里有单测，也能被契约测试复用。
fn last_assistant_text(messages: &Value) -> Option<String> {
    crate::fleet::last_assistant_text(messages)
}

/// 调度：把就绪 lane 拉起来；**资源上限导致的排队在这里自愈**（06 §3.4）。
///
/// 为什么要有这个循环：`schedule_run` 的再次触发点是「某条 lane settle」。如果所有就绪
/// lane 都因 `MAX_WORKERS` 起不来，就永远不会有 settle —— run 会永久停在 Pending。
/// 所以撞上限时不能只 `continue`，必须自己等额度。整个 run 只有一个调度任务在跑
/// （settle 回调与 start 各自触发一次，但都走这个函数，不会递归）。
async fn schedule_run(app: AppHandle, run_id: String) {
    const POLL: std::time::Duration = std::time::Duration::from_millis(500);
    const MAX_WAIT: std::time::Duration = std::time::Duration::from_secs(30 * 60);
    let started = std::time::Instant::now();
    loop {
        let ready = {
            let state = app.state::<AppState>();
            let Some(run) = state.fleet.get(&run_id) else { return };
            if run.status != crate::fleet::RunStatus::Running {
                return;
            }
            run.ready_lanes()
        };
        if ready.is_empty() {
            return;
        }
        let hit_capacity = start_ready_lanes(&app, &run_id, ready).await;
        if !hit_capacity {
            // 全部起来了：后续推进由各 lane 的 settle 回调负责
            return;
        }
        let waited = started.elapsed();
        let (status, still_ready) = {
            let state = app.state::<AppState>();
            match state.fleet.get(&run_id) {
                Some(run) => (run.status.clone(), run.ready_lanes()),
                None => return,
            }
        };
        if !crate::fleet::should_keep_waiting(&status, still_ready.len(), waited, MAX_WAIT) {
            if waited >= MAX_WAIT {
                eprintln!(
                    "[fleet] run {run_id} 等待 worker 额度超过 {} 分钟，仍有 {} 条 lane 未启动",
                    MAX_WAIT.as_secs() / 60,
                    still_ready.len()
                );
            }
            return;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// 拉起给定的就绪 lane；返回是否撞到 worker 上限（撞到 = 还有 lane 没起来）。
async fn start_ready_lanes(app: &AppHandle, run_id: &str, ready: Vec<String>) -> bool {
    let state = app.state::<AppState>();
    let mut hit_capacity = false;
    for lane_key in ready {
        let (prompt, cwd) = {
            let Some(run) = state.fleet.get(run_id) else { return hit_capacity };
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
            // lane 继承当前默认档位：Fleet 是"替用户跑任务"，不该偷偷提权
            let lane_permission = reg.default_permission;
            match reg
                .create_tab(&sink(app), cwd.clone(), SessionTarget::NoSession, Some(lane_label), lane_permission)
                .await
            {
                Ok(snap) => snap.tab_id,
                Err(e) => {
                    eprintln!("[fleet] lane {lane_key} 启动失败: {e}");
                    if e.starts_with("MAX_WORKERS") {
                        hit_capacity = true;
                    } else {
                        state.fleet.fail_lane_by_key(run_id, &lane_key);
                        fleet_emit(app, &state);
                    }
                    continue;
                }
            }
        };
        state.fleet.bind_tab(run_id, &lane_key, &tab_id);
        let worker = state.registry.lock().await.tabs.get(&tab_id).and_then(|t| t.worker.clone());
        fleet_emit(app, &state);
        if let Some(worker) = worker.clone() {
            watch_lane(app.clone(), run_id.to_string(), tab_id, worker.clone());
            if let Err(e) = worker.prompt(&prompt, None, None).await {
                eprintln!("[fleet] lane {lane_key} prompt 失败: {e}");
                state.fleet.fail_lane_by_key(run_id, &lane_key);
                fleet_emit(app, &state);
            }
        }
    }
    hit_capacity
}

/// lane 状态监听：`fleet::lane_step` 判定终态（Busy→Ready = settle，崩溃 = 失败）。
///
/// 判定逻辑刻意放在 `fleet.rs` 的纯函数里：这里只做 IO（取消息、emit、驱动下游），
/// 而"什么算跑完"由纯函数定义——两侧都有测试（单测 + 契约测试跑真实 pi）。
fn watch_lane(
    app: AppHandle,
    run_id: String,
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
            let (now_busy, outcome) = crate::fleet::lane_step(was_busy, *rx.borrow());
            was_busy = now_busy;
            match outcome {
                Some(crate::fleet::LaneOutcome::Settled) => {
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
                Some(crate::fleet::LaneOutcome::Failed) => {
                    state.fleet.fail_lane(&tab_id);
                    fleet_emit(&app, &state);
                    return;
                }
                None => {}
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
