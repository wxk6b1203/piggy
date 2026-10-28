//! IPC 命令层（docs/03 §1 原则 2）：参数校验 + 转发，不含业务逻辑。

use crate::config::{app, paths, pi_files};
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
    /// 用户通过**原生**对话框/确认过的工作区根与预览文件（webview 改不了）。
    pub trusted: Arc<tokio::sync::Mutex<TrustedPaths>>,
}

/// 可信路径表：只有用户经由原生 picker / 原生确认框批准过的路径才进来。
///
/// `roots`：`pick_directory` 选过的目录、已有会话文件头里的 cwd、以及用户第一次预览
/// 某个新工作区时确认过的根。
/// `previews`：`fs_preview_read` / `fs_image_data` 对主目录/temp 里非工作区文件确认过的路径。
#[derive(Default)]
pub struct TrustedPaths {
    pub roots: std::collections::HashSet<PathBuf>,
    pub previews: std::collections::HashSet<PathBuf>,
    /// 本次 app 运行里用户已经批准过「完全权限」一次；之后的切档/新 tab 不再重复弹框。
    /// 不是持久化选择：重启后还会再确认一次。
    pub full_permission_confirmed: bool,
}

/// 解析为真实路径；不存在/无权限时退回原路径（调用方随后会自己报错）。
fn canonical_or_self(p: &Path) -> PathBuf {
    std::fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

/// 这个路径是否已被用户批准过（两边 canonicalize 后比较）。
///
/// 批准一个**根**等于批准它的子树：原生 picker 选 `~/proj` 后，`~/proj/sub` 也是
/// 用户选过的项目内部目录，不该再弹一次。
fn is_trusted(paths: &std::collections::HashSet<PathBuf>, p: &Path) -> bool {
    let real = canonical_or_self(p);
    paths.iter().any(|approved| {
        crate::config::paths::same_path(approved, &real) || crate::config::paths::is_under(approved, &real)
    })
}

/// 本次运行内「完全权限」只确认一次：第一次弹原生框，批准后记住；重启后重新确认。
///
/// 完全权限会移除 pi 的工具白名单，是安全语义的跃迁，不能由 webview 静默请求；
/// 但每次切档都弹也很烦——用户批准一次等于对本次运行的所有 full 切档授权。
async fn confirm_full_permission_once(
    app: &AppHandle,
    state: &State<'_, AppState>,
    title: &str,
    message: &str,
) -> bool {
    // 设置项关掉 = 完全静默（用户显式承担风险；关闭动作本身也要原生确认，见 perf_config_save）
    let enabled = state.perf.read().map(|c| c.confirm_full_permission).unwrap_or(true);
    if !enabled {
        return true;
    }
    if state.trusted.lock().await.full_permission_confirmed {
        return true;
    }
    let ok = crate::ui_confirm::confirm(app, title, message).await;
    if ok {
        state.trusted.lock().await.full_permission_confirmed = true;
    }
    ok
}

/// sessionDir 改动是否需要原生确认（纯函数）：只有"变成一个新的非空目录"才需要。
/// 清空/删键 = 回落到默认会话根，不扩大读取面。
pub fn session_dir_change_needs_confirmation(old: &Value, new: &Value) -> bool {
    let old_dir = old
        .get("sessionDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let new_dir = new
        .get("sessionDir")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    new_dir.is_some() && new_dir != old_dir
}

/// watcher 监听根：agent 目录（含 settings.json）+ 生效会话根。
/// 自定义 sessionDir 在 agent 目录之外时必须单独监听，否则新会话不刷新侧栏。
///
/// agent 目录直接取 [`paths::agent_dir`]：老代码在这里自己拼 HOME + `.pi/agent`，
/// Windows 上（不设 HOME）会拼出**相对**的 `.pi/agent` → 监听了一个不存在的目录，
/// 侧栏再也不自动刷新。
pub fn watcher_roots() -> Vec<PathBuf> {
    let agent_root = paths::agent_dir();
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

/// 取一个可用的 worker（必要时复活）——**绝大多数命令的入口**。
///
/// 两条路，都必须**短**：
/// 1. 快路径：标签页已有 `Ready`/`Busy`/`Spawning` 的 worker → 持锁只做一次查表 + 触碰活跃时间；
/// 2. 慢路径：需要复活 → 交给 `revive_unlocked`，它**自己在三段之间取锁**，
///    握手（可达 40s 预算）与补游标都在**锁外**跑。
///
/// 改造前这里是"持锁 → `ensure_worker` → 需要复活就地 spawn + 握手"，
/// 于是一次慢启动会把**所有标签页**的命令一起卡住（同一把全局锁）。
async fn worker_of(
    app: &AppHandle,
    state: &State<'_, AppState>,
    tab_id: &str,
) -> Result<crate::pi::client::Worker, String> {
    let ready = {
        let mut reg = state.registry.lock().await;
        reg.ready_worker(tab_id)? // 顺带刷新活跃时间（05 §4.1）
    };
    if let Some(w) = ready {
        return Ok(w);
    }
    crate::sessions::registry::revive_unlocked(&state.registry, &sink(app), tab_id).await
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
    state: State<'_, AppState>,
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
    let picked = rx.await.map_err(|e| format!("目录选择框关闭异常: {e}"))?;
    if let Some(dir) = picked.as_deref() {
        // 原生 picker 是可信 UI：选过的目录直接进入 tab_create/cwd 的白名单。
        state
            .trusted
            .lock()
            .await
            .roots
            .insert(canonical_or_self(Path::new(dir)));
    }
    Ok(picked)
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
        let dir = if pb.is_dir() {
            Some(pb)
        } else {
            pb.parent().map(Path::to_path_buf)
        };
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
    // 空串/纯空白 = 未提供（回退用户主目录）；`~` 前缀展开（用户手输路径的常态）
    let mut cwd = tab_cwd(cwd.as_deref()).ok_or_else(|| {
        "无法确定 cwd：Home 目录解析失败（HOME / USERPROFILE / HOMEDRIVE+HOMEPATH 均为空），\
         请在新建会话时显式填写项目目录"
            .to_string()
    })?;
    /* 打开**已有会话**时，cwd 以会话文件头为准，而不是前端传的字符串：
    前端（被攻破时）可以传一个合法会话文件 + `cwd: C:\`，让 tab 的工作区变成整盘。
    会话文件必须先在生效会话根下（`session_file_gate`），所以文件头里的 cwd 是用户
    此前用过的目录；把它加入可信工作区（预览不再逐次确认）。 */
    if let Some(p) = session_path.as_deref() {
        session_file_gate(p)?;
        if let Some(meta) = list::parse_session_file(Path::new(p)) {
            if let Some(header_cwd) = meta.cwd.as_deref().map(PathBuf::from) {
                if header_cwd.is_dir() {
                    cwd = header_cwd;
                    state.trusted.lock().await.roots.insert(canonical_or_self(&cwd));
                }
            }
        }
    }
    if !cwd.is_dir() {
        return Err(format!(
            "SESSION_CWD_MISSING: 项目目录不存在: {}（请先创建该目录）",
            cwd.display()
        ));
    }
    /* 新 cwd **静默**（用户要求：不要在每次开新会话时弹框）。工作区是否"可信"不在这里
    判定：它只影响文件预览，第一次预览某个新工作区的文件时再一次性确认（见
    `preview_access_gate`）——把确认放在真正发生读取的时刻，而不是建 tab 的时刻。 */
    // 权限档位：显式传入 > 持久化默认。
    // 非法值**直接报错**而不是静默回落——权限档悄悄降级成更宽松的一档，
    // 是本项目最不能接受的失败方式（用户会以为限制还在）。
    let default_permission = state.registry.lock().await.default_permission;
    let permission = match permission.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => PermissionMode::parse(s)?,
        None => default_permission,
    };
    /* 完全权限 = 无 --tools 白名单 = bash/powershell + 任意文件。这是安全语义的跃迁，
    不能由 webview 静默请求；但**本次运行确认过一次后不再重复弹**（用户明确抱怨每次切档
    都弹框）。确认状态在 `TrustedPaths.full_permission_confirmed`，只存内存。 */
    if permission == PermissionMode::Full
        && !confirm_full_permission_once(
            &app,
            &state,
            "启用完全权限？",
            "完全权限会移除 pi 的工具白名单：它可以执行任意命令、读写任意文件。\n\n\
             本次运行内只会询问这一次；之后的完全权限切档/新建不再弹框。",
        )
        .await
    {
        return Err("已取消：完全权限需要用户原生确认".to_string());
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
    /* maxWorkers 上限（05 §4.2）：超限报错，前端提示"一键回收最闲"。
    检查与 spawn 一起放进 `create_tab_unlocked`（它自己在锁内做这两件事），
    而**握手在锁外** —— 见那里的三段式说明。 */
    let max = state.perf.read().map(|p| p.max_workers).unwrap_or(8) as usize;
    let snapshot = match crate::sessions::registry::create_tab_unlocked(
        &state.registry,
        &sink(&app),
        cwd,
        target,
        name,
        permission,
        max,
    )
    .await
    {
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
    };
    // 初始游标在后台补（`get_entries` 不带 since 会把整段会话发回来，长会话实测 73ms，
    // 不该压在打开路径上 —— 见 `sessions::registry::spawn_cursor_init` 的说明）
    crate::sessions::registry::spawn_cursor_init(state.registry.clone(), snapshot.tab_id.clone());
    spawn_tab_watcher(state.registry.clone(), sink(&app), snapshot.tab_id.clone());
    Ok(snapshot)
}

/// 切换某标签页的权限档位。
///
/// `--tools` / `-e` 都是 pi 的 CLI 参数，RPC 没有运行期改工具的接口，
/// 所以实现是「停旧进程 → 按新档复活」，会话文件与游标不变（复用崩溃复活路径）。
/// **整条路径都不持 registry 锁**（复活要握手，40s 预算不能卡住别的标签页）。
/// 同时把该档记为新标签页的默认值并持久化到 `~/.piggy/config.json`。
#[tauri::command]
pub async fn pi_set_permission_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    mode: String,
) -> Result<Value, String> {
    let mode = PermissionMode::parse(&mode)?;
    if mode == PermissionMode::Full
        && !confirm_full_permission_once(
            &app,
            &state,
            "切换到这个标签页的完全权限？",
            "完全权限会移除 pi 的工具白名单：它可以执行任意命令、读写任意文件。\n\n\
             切换会重启这个标签页的 pi 进程。本次运行内只会询问这一次。",
        )
        .await
    {
        return Err("已取消：完全权限需要用户原生确认".to_string());
    }
    let out = crate::sessions::registry::set_permission_unlocked(&state.registry, &sink(&app), &tab_id, mode).await?;
    save_default_permission(&state, mode);
    Ok(out)
}

/// 设置页用：只改**新标签页的默认权限档位**，不动任何正在运行的会话。
///
/// 与 `pi_set_permission_mode` 的区别：那个是"切这个标签页的档位"（要重启它的 worker），
/// 这个是"以后新开的会话默认用哪一档"。设置页里传 `tabId: ''` 去调前者会直接报错。
#[tauri::command]
pub async fn pi_set_default_permission(
    app: AppHandle,
    state: State<'_, AppState>,
    mode: String,
) -> Result<Value, String> {
    let parsed = PermissionMode::parse(&mode)?;
    if parsed == PermissionMode::Full
        && !confirm_full_permission_once(
            &app,
            &state,
            "把「完全权限」设为默认？",
            "以后新开的每个会话都会默认使用完全权限（可执行任意命令、读写任意文件）。\n\n\
             本次运行内只会询问这一次。",
        )
        .await
    {
        return Err("已取消：默认完全权限需要用户原生确认".to_string());
    }
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
    let modes: Vec<Value> = [
        PermissionMode::ReadOnly,
        PermissionMode::Workspace,
        PermissionMode::Full,
    ]
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
pub async fn tab_close(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let mut reg = state.registry.lock().await;
    reg.close_tab(&sink(&app), &tab_id).await
}

/* ---------------- M2：性能（05 §4 空闲回收 / maxWorkers / 休眠标签） ---------------- */

/// 休眠标签（05 §4.3）：回收 worker，保留 tab 与游标；再交互自动复活。
#[tauri::command]
pub async fn tab_sleep(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
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

/// 保存 Piggy 自己的运行设置（读-改-写）。
///
/// `allow(too_many_arguments)`：**参数个数是 IPC 界面决定的**——前端送的是一个扁平对象
/// （`{maxWorkers, idleTimeoutMin, piSource, …, transcriptRail}`），每个字段对应一个开关。
/// 合并成一个 patch 结构体当然更"优雅"，但那是**线格式变更**：前端、mock、契约测试
/// 都要跟着改，而收益只是少一个 lint。这里显式放行并留痕，好过为了让 lint 闭嘴
/// 去动一个"存错就静默丢设置"的路径。
/// 随包带的 pi 插件全貌（docs/06 §7）：名字、说明、申报的工具/命令、**这次装不装**。
///
/// `skipped` 那一栏是这一层最要紧的东西：用户自己装过同名扩展时 Piggy 会主动不注入
/// （两份同名扩展会让 pi 因为工具名冲突直接不进会话），但"为什么我的插件没生效"
/// 必须能从界面上读到，而不是让人去翻日志。
///
/// @param project_dir - 前端传当前工作目录（活动标签页的 cwd）。**必须传**：
///   项目级 `<cwd>/.pi/extensions` 里的同名扩展同样会让 pi 直接退出，
///   少了它界面上就会说"可以注入"而真实 spawn 时被跳过。
#[tauri::command]
pub async fn plugin_bundled(
    state: State<'_, AppState>,
    project_dir: Option<String>,
) -> Result<serde_json::Value, String> {
    let reg = state.registry.lock().await;
    let enabled = crate::config::app::perf_config_load().bundled_plugins;
    let cwd = project_dir.as_deref().map(std::path::PathBuf::from);
    let resolved = crate::pi::plugins::resolve(
        &reg.bundled_plugins,
        &enabled,
        crate::pi::plugins::home_dir().as_deref(),
        cwd.as_deref(),
    );
    let items: Vec<serde_json::Value> = resolved
        .into_iter()
        .map(|p| {
            // 目录缺失时清单读不出来（`read_manifest(None)`）—— 那是"这一份安装不完整"，
            // 不是"插件坏了"，原因已经写在 skipped 里
            let m = p
                .dir
                .as_deref()
                .and_then(crate::pi::plugins::read_manifest)
                .unwrap_or_default();
            // ⚠️ `enabled`（配置里开着吗）与 `inject`（这次真的注入了吗）**不是一回事**：
            // 用户自己装过同名扩展时配置是开着的、但 Piggy 主动不注入（否则 pi 会因为
            // 工具名冲突根本不进会话）。界面上的勾选框要跟着**配置**走，跳过原因单独显示。
            let enabled_in_config = enabled.iter().any(|n| n == &p.name);
            serde_json::json!({
                "name": p.name,
                "title": if m.title.is_empty() { p.name.clone() } else { m.title },
                "description": m.description,
                "license": m.license,
                "tools": m.tools,
                "commands": m.commands,
                "dir": p.dir.as_ref().map(|d| d.to_string_lossy().into_owned()),
                // 这份目录从哪儿找到的：`source_tree` = 开发态（打包产物里出现它 =
                // bundle.resources 漏登记了，那样换台机器就会整个消失）
                "origin": p.origin.map(|o| o.label()),
                "originKind": p.origin,
                "bundled": true,
                "enabled": enabled_in_config,
                "inject": p.inject,
                "skipped": p.skipped,
            })
        })
        .collect();
    Ok(serde_json::json!({ "plugins": items }))
}

#[allow(clippy::too_many_arguments)]
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
    // 会话预览滚动条位置（off / left / right）。不传 = 保持既有值。
    transcript_rail: Option<String>,
    // 工作步骤展示档位（compact / standard / detailed / verbose，docs/04 §2.1.6）。
    // 不传 = 保持既有值。
    transcript_detail: Option<String>,
    // 要注入哪些捆绑插件（docs/06 §7）。不传 = 保持既有值。
    bundled_plugins: Option<Vec<String>>,
    // 切到完全权限前是否弹原生确认（默认开）。不传 = 保持既有值。
    confirm_full_permission: Option<bool>,
) -> Result<(), String> {
    // 读-改-写：config.json 里还有 permission_mode 等字段，
    // 从零构造会让「在设置里改并发数」顺手把权限档位重置——必须保留既有值。
    let mut cfg = app::perf_config_load();
    cfg.max_workers = max_workers;
    cfg.idle_timeout_min = idle_timeout_min;
    if let Some(v) = confirm_full_permission {
        /* 关闭确认本身也是安全语义变更：不许 webview 静默改。 */
        if !v && cfg.confirm_full_permission {
            let ok = crate::ui_confirm::confirm(
                &app,
                "关闭「完全权限」确认？",
                "关闭后，切到完全权限 / 新建完全权限会话将不再弹原生确认框。\n\n\
                 完全权限下的 pi 可以执行任意命令、读写任意文件；只在你明确接受这个风险时关闭。",
            )
            .await;
            if !ok {
                return Err("已取消：关闭完全权限确认需要用户原生确认".to_string());
            }
        }
        cfg.confirm_full_permission = v;
    }
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

    if let Some(r) = transcript_rail.as_deref() {
        cfg.transcript_rail = crate::config::app::RailPlacement::parse(r)?;
    }
    if let Some(d) = transcript_detail.as_deref() {
        cfg.transcript_detail = crate::config::app::TranscriptDetail::parse(d)?;
    }
    if let Some(list) = bundled_plugins {
        // 只认随包带的那些名字：写进来一个不存在的插件名没有意义（而且会让界面显示一条
        // "已启用"却什么都不发生的东西）
        let known = crate::config::app::default_bundled_plugins();
        cfg.bundled_plugins = list.into_iter().filter(|n| known.contains(n)).collect();
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
        discover(*next_source, next_path.as_deref().map(Path::new), builtin.as_deref())
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
        let dir = crate::pi::resources::plain_resource_dir(app.path().resource_dir().ok().as_deref());
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
    app::perf_config_save(&cfg).map_err(|e| format!("config.json 写入失败: {e}"))?;
    if let Ok(mut p) = state.perf.write() {
        *p = cfg.clone();
    }

    // 4) 同步到 registry 并让缓存路径失效（已在跑的 worker 仍持旧二进制，直到被重启）
    {
        let mut reg = state.registry.lock().await;
        let changed =
            reg.pi_source != cfg.pi_source || reg.pi_custom_path.as_deref() != cfg.pi_path.as_deref().map(Path::new);
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
        (
            reg.pi_source,
            reg.pi_custom_path.clone(),
            reg.builtin.clone(),
            reg.pi_bin.clone(),
        )
    };
    let builtin_available = builtin.as_ref().map(|b| b.is_file()).unwrap_or(false);
    let current = resolved.or_else(|| discover(source, custom.as_deref(), builtin.as_deref()).ok());
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
pub async fn pi_abort(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.abort().await.map(|_| ())
}

#[tauri::command]
pub async fn pi_clear_queue(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.clear_queue().await
}

#[tauri::command]
pub async fn pi_get_state(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.get_state().await
}

#[tauri::command]
pub async fn pi_get_messages(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.get_messages().await
}

#[tauri::command]
pub async fn pi_get_session_stats(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
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
pub async fn pi_new_session(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
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
pub async fn ui_reply(state: State<'_, AppState>, tab_id: String, response: Value) -> Result<(), String> {
    /* ⚠️ 这里**只认活着的 worker**，不走 `worker_of`（那条路会按需复活）。
    回答一个"已经不存在的提问"绝不该拉起新进程：复活出来的 pi 从来没发过那个
    `extension_ui_request` id，`extension_ui_response` 会被它静默忽略 ——
    用户点了提交、界面什么都不发生，而进程白起一个（2026-10-09 复查发现的缝；
    前端那边崩溃/休眠时也会把待答卡片清掉，两条一起把这条路堵死）。 */
    let ready = {
        let mut reg = state.registry.lock().await;
        reg.ready_worker(&tab_id)?
    };
    let Some(worker) = ready else {
        return Err("这个提问所属的会话已经不在了（pi 已崩溃或被休眠回收），回答无法送出".to_string());
    };
    worker.ui_response(response).await
}

#[tauri::command]
pub async fn pi_stderr_tail(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
    let worker = worker_of(&app, &state, &tab_id).await?;
    let tail: Vec<String> = worker.stderr_tail.lock().await.iter().cloned().collect();
    serde_json::to_value(tail).map_err(|e| e.to_string())
}

/// `tab_create` 的 cwd 解析（抽成函数是为了可测：这是用户报「无法确定 cwd」的那条路）。
///
/// - 空/纯空白 = 未提供 → 用户主目录（**不是**只看 `HOME`：Windows 默认不设 `HOME`，
///   老代码在这里直接失败，见 [`paths`] 的模块注释）
/// - `~` / `~/x`（Windows 上还有 `~\x`）展开
fn tab_cwd(input: Option<&str>) -> Option<PathBuf> {
    tab_cwd_with(input, paths::home_dir(), cfg!(windows))
}

/// 主目录与平台由调用方注入（纯函数，便于在任意平台上验证 Windows 形状）。
fn tab_cwd_with(input: Option<&str>, home: Option<PathBuf>, windows: bool) -> Option<PathBuf> {
    match input.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => Some(paths::expand_home_in(s, home.as_deref(), windows)),
        None => home,
    }
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

/// session_* 命令的路径闸门（纯函数，`root` 注入便于测试）：
/// 只认**生效会话根下的 `.jsonl` 文件**。
///
/// 这些命令直接读文件、甚至把文件移进回收站（`session_delete`）/ 写会话元数据
/// （`session_rename` / `session_title_generate`），路径来自前端，不可信
/// （2026-10-28 审查收敛：此前 `trash_session` 收到任意路径都会执行）。
/// canonicalize 只做闸门——**后续操作仍用前端原路径**（canonicalize 在 Windows 上带
/// `\\?\` 前缀，把它传给 pi 的 `--session` 会让 pi 起不来，见 `plain_path` 的说明）。
fn session_file_gate_under(root: &Path, path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("会话路径必须是绝对路径: {path}"));
    }
    if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return Err("只允许操作会话 .jsonl 文件".into());
    }
    if p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("会话路径包含 `..`".into());
    }
    let root_real = std::fs::canonicalize(root).map_err(|e| format!("会话根无法解析: {e}"))?;
    let p_real = std::fs::canonicalize(p).map_err(|e| format!("会话文件不存在或无法解析: {e}"))?;
    if !p_real.starts_with(&root_real) {
        return Err(format!("路径不在生效会话根 {} 内（收到 {path}）", root.display()));
    }
    Ok(())
}

/// [`session_file_gate_under`] 的生产入口：生效会话根由 settings.json / 环境变量决定。
fn session_file_gate(path: &str) -> Result<(), String> {
    session_file_gate_under(&pi_files::sessions_root(), path)
}

#[tauri::command]
pub async fn session_delete(path: String) -> Result<(), String> {
    session_file_gate(&path)?;
    list::trash_session(&path)
}

/// 整段会话的**轮次轮廓**（docs/03 §2.19）：刻度梯要"预览全部、载入部分"。
///
/// 单独一条命令而不是塞进 `session_page`：轮廓是"一次扫描、整个会话"，
/// 页码是"按需一页"——两者的生命周期不同（轮廓只在打开/复活时取一次）。
#[tauri::command]
pub async fn session_outline(path: String) -> Result<Value, String> {
    session_file_gate(&path)?;
    tokio::task::spawn_blocking(move || {
        let o = crate::sessions::transcript::outline(std::path::Path::new(&path))?;
        Ok::<Value, String>(o.to_json())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 会话里的**任务清单投影**（docs/03 §2.20）：最新一次整表写入 = 当前计划。
///
/// 为什么不由前端从已载入的行里推：分页只载入尾部一页，而清单可能写在很久以前那一轮
/// （DSH 的原话是 "The list survives across turns and reopened sessions"，
/// `packages/todo/tool-todo/README.md:12`）。所以这里跟 `session_outline` 一样，
/// 是"一次扫描、整个会话"的投影，单独一条命令。
///
/// **只在探测到 todo 能力时才会被调用**（`plugin_capability`）—— 没装插件就没有这次扫描。
#[tauri::command]
pub async fn session_todo(path: String) -> Result<Value, String> {
    session_file_gate(&path)?;
    tokio::task::spawn_blocking(move || {
        let p = crate::sessions::transcript::todo_projection(std::path::Path::new(&path))?;
        Ok::<Value, String>(p.to_json())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 会话转录**分页**读（docs/03 §2.19）。
///
/// 不起 worker、不依赖 pi 进程：直接读会话 JSONL 的尾部一页。这样打开长会话
/// 不必等 pi 载入整段历史，也不必把 10 MB 的旧工具输出搬过 IPC。
/// 语义与一致性论证见 `sessions/transcript.rs` 的模块头。
#[tauri::command]
pub async fn session_page(
    path: String,
    before: Option<u64>,
    after: Option<u64>,
    limit: Option<usize>,
) -> Result<Value, String> {
    session_file_gate(&path)?;
    session_page_routed(path, before, after, limit).await
}

/// [`session_page`] 的分页路由（`after` 优先于 `before`）。抽成 pub 是因为
/// `sessions/transcript.rs` 有"命令有没有接上"的接线测试——路径闸门留在命令层
/// （IPC 边界的事），路由本身是纯逻辑、测试直调这一层。
pub async fn session_page_routed(
    path: String,
    before: Option<u64>,
    after: Option<u64>,
    limit: Option<usize>,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let limit = limit.unwrap_or(crate::sessions::transcript::DEFAULT_LIMIT);
        // `after` 优先：它是"向下续页"（换窗之后往下滚），`before` 是"往上翻/换窗"
        let page = match after {
            Some(a) => crate::sessions::transcript::read_after(std::path::Path::new(&path), a, limit)?,
            None => crate::sessions::transcript::read_page(std::path::Path::new(&path), before, limit)?,
        };
        Ok::<Value, String>(page.to_json())
    })
    .await
    .map_err(|e| e.to_string())?
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
    // 这个临时 worker 只为调一次 set_session_name：cwd 用主目录（让 pi 读到全局配置），
    // 主目录拿不到时退临时目录——老代码退 `"/"`，在 Windows 上是"当前盘根"，语义全错。
    let cwd = paths::home_dir_or_temp();
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
                // 改名的临时 worker 不需要任何插件
                bundled_extensions: Vec::new(),
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
    session_file_gate(&path)?;
    set_session_name_via_worker(&app, &state, path, name).await
}

/// 生成标题**会拿什么去生成**（不调用模型）。界面用它做预览与排查。
#[tauri::command]
pub async fn session_title_source(path: String) -> Result<Value, String> {
    session_file_gate(&path)?;
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
pub async fn title_model_options(state: State<'_, AppState>) -> Result<Value, String> {
    let pi_bin = {
        let mut reg = state.registry.lock().await;
        reg.resolve_bin()?
    };
    // cwd 用主目录：pi 会顺带读 `<cwd>/.pi/…` 的项目级配置，而"列出模型"这件事
    // 属于全局设置页，不该跟着某个项目走（项目级模型仍可手动填，见 docs/15 缺口）。
    // 老代码这里退 `"/"`，Windows 上是"当前盘根"——现在退临时目录，至少是个真目录。
    let cwd = paths::home_dir_or_temp();
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
    session_file_gate(&path)?;
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
    let (provider, model_id) = crate::sessions::title::pick_model(cfg.title_model.as_deref(), &source)?;
    // 会话自己的目录优先（跟着会话的项目配置走）；目录没了或没记录 → 主目录。
    let cwd = source
        .cwd
        .as_deref()
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_dir())
        .unwrap_or_else(paths::home_dir_or_temp);

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
    worker_of(&app, &state, &tab_id)
        .await?
        .get_entries(since.as_deref())
        .await
}

#[tauri::command]
pub async fn pi_get_tree(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.get_tree().await
}

#[tauri::command]
pub async fn pi_get_fork_messages(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
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
pub async fn pi_clone(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
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
    worker_of(&app, &state, &tab_id)
        .await?
        .get_available_thinking_levels()
        .await
}

#[tauri::command]
pub async fn pi_cycle_thinking(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.cycle_thinking_level().await
}

#[tauri::command]
pub async fn pi_get_commands(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.get_commands().await
}

#[tauri::command]
pub async fn pi_export_html(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    _output_path: Option<String>,
) -> Result<Value, String> {
    /* 前端从未传 output_path（`/export` 只发 tabId），但 IPC 参数是可伪造的：一个
    webview 传 `C:\Users\x\.ssh\authorized_keys` 就能让 pi 往任意路径写 HTML。
    没有调用方需要这个参数 → 一律用 pi 的默认落点（工作目录），不转发前端路径。
    将来要做"另存为"，必须走原生保存对话框并把路径登记成可信路径，不能直接收字符串。 */
    let worker = worker_of(&app, &state, &tab_id).await?;
    worker.export_html(None).await
}

/// 预览的**硬拒绝**：目标落在敏感目录（home 四件套 + 实际 agent 目录）里时，连确认框都不弹。
///
/// 判定前两边都已 canonicalize：home 里的符号链接/junction 指向界外时，
/// `canonicalize` 得到的是真实位置，前缀比较才可靠。
fn preview_gate(home_real: &Path, target_real: &Path) -> Result<(), String> {
    if paths::sensitive_under(home_real, target_real) {
        return Err("敏感目录（.pi / .ssh / .aws / .gnupg / agent）不允许预览：API key 与私钥所在".into());
    }
    if let Ok(agent) = std::fs::canonicalize(paths::agent_dir()) {
        if paths::is_under(&agent, target_real) {
            return Err("pi 的 agent 目录（auth.json 所在）不允许预览".into());
        }
    }
    Ok(())
}

/// 预览的**工作区口径**：可信工作区直接放行；新工作区第一次预览时确认一次；
/// home/temp 里的非工作区文件逐文件确认；其它位置拒绝。
///
/// 这是 H3 的收敛，同时把确认从 `tab_create` 挪到**真正发生读取**的时刻：用户不再
/// 每次开新会话都弹框，但被攻破的 webview 也不能靠 `tab_create({cwd:"~"})` 把整个 home
/// 变成静默可读区——第一次预览时才问，且用户看得到具体目录。
async fn preview_access_gate(app: &AppHandle, state: &State<'_, AppState>, path: &str) -> Result<PathBuf, String> {
    let home = paths::home_dir().ok_or("无法确定用户目录（HOME / USERPROFILE 均为空），预览已禁用")?;
    let home_real = std::fs::canonicalize(&home).map_err(|e| format!("无法确定用户目录的真实位置: {e}"))?;
    let target_real = std::fs::canonicalize(path).map_err(|e| format!("路径无法解析（不存在或无权限）: {e}"))?;
    preview_gate(&home_real, &target_real)?;

    // 已经由原生 picker / 已有会话文件头 / 用户此前确认过的工作区 → 直接放行
    {
        let trusted = state.trusted.lock().await;
        if is_trusted(&trusted.roots, &target_real) {
            return Ok(target_real);
        }
    }

    // 目标在某个已打开 tab 的 cwd 下，但这个 cwd 还没被信任：第一次预览时确认这个工作区
    let containing = {
        let reg = state.registry.lock().await;
        reg.tabs.values().find_map(|t| {
            let cwd = std::fs::canonicalize(&t.cwd).unwrap_or_else(|_| t.cwd.clone());
            if paths::is_under(&cwd, &target_real) {
                Some(cwd)
            } else {
                None
            }
        })
    };
    if let Some(root) = containing {
        let ok = crate::ui_confirm::confirm(
            app,
            "把这个目录作为可信工作区？",
            &format!(
                "目录：{}\n\n\
                 这是当前会话的工作区。确认后，本次运行内该目录下的文件预览不再逐次询问；\
                 「工作区内修改」档的写入边界也以它为准。",
                root.display()
            ),
        )
        .await;
        if !ok {
            return Err(format!("已取消：未确认把 {} 作为可信工作区", root.display()));
        }
        state.trusted.lock().await.roots.insert(root);
        return Ok(target_real);
    }
    // 主目录之外还有系统临时目录：工具输出/截图经常落在 $TMP（macOS 的 /var/folders、
    // Linux 的 /tmp 都不在 home 下）。只允许这三类位置，且 home/temp 里的非工作区文件
    // 仍需一次原生确认；任意其它盘符路径直接拒。
    let temp_in_scope = std::env::temp_dir()
        .canonicalize()
        .ok()
        .map(|t| paths::is_under(&t, &target_real))
        .unwrap_or(false);
    if !paths::is_under(&home_real, &target_real) && !temp_in_scope {
        return Err("预览只允许工作区、用户主目录或系统临时目录内的文件".into());
    }
    {
        let trusted = state.trusted.lock().await;
        if trusted.previews.iter().any(|p| paths::same_path(p, &target_real)) {
            return Ok(target_real);
        }
    }
    let ok = crate::ui_confirm::confirm(
        app,
        "预览工作区外的文件？",
        &format!(
            "文件：{}\n\n这个文件不在任何已打开会话的工作区内。确认只允许本次预览读取它。",
            target_real.display()
        ),
    )
    .await;
    if !ok {
        return Err("已取消：未确认预览工作区外文件".into());
    }
    state.trusted.lock().await.previews.insert(target_real.clone());
    Ok(target_real)
}

/// 文件预览读取（文本）：可信工作区直接放行；新工作区首次预览确认一次；
/// home/temp 内非工作区文件逐文件确认；敏感目录硬拒。
#[tauri::command]
pub async fn fs_preview_read(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Value, String> {
    let pb_real = preview_access_gate(&app, &state, &path).await?;
    let md = std::fs::metadata(&pb_real).map_err(|e| e.to_string())?;
    if md.len() > 5 * 1024 * 1024 {
        return Err("文件超过 5MB，暂不支持预览".into());
    }
    let body = std::fs::read_to_string(&pb_real).map_err(|e| format!("读取失败（二进制文件?）: {e}"))?;
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

/// 图片预览的**内容闸门**：只接受带真实魔数的 PNG/JPEG/GIF/WebP。
///
/// 不按扩展名判断：`auth.json` 改个 `.png` 后缀不能变成图片；反过来只返回图片字节也
/// 不会把文本密钥回流给 webview。SVG 不支持——它是 XML，可能带脚本/外部引用。
fn image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

/// 读取一张图片并返回 data URL（`<img src>` 用），替代已移除的 `asset://` 协议。
///
/// 与文本预览共用 `preview_access_gate`（工作区/确认/敏感目录），但额外要求魔数匹配，
/// 因此 webview 拿不到非图片文件的内容。大小上限 20MB。
#[tauri::command]
pub async fn fs_image_data(app: AppHandle, state: State<'_, AppState>, path: String) -> Result<Value, String> {
    const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
    let real = preview_access_gate(&app, &state, &path).await?;
    let md = std::fs::metadata(&real).map_err(|e| e.to_string())?;
    if !md.is_file() {
        return Err("不是文件".into());
    }
    if md.len() > MAX_IMAGE_BYTES {
        return Err("图片超过 20MB，暂不支持预览".into());
    }
    let bytes = std::fs::read(&real).map_err(|e| format!("读取图片失败: {e}"))?;
    let mime = image_mime(&bytes).ok_or("不是受支持的图片格式（仅 PNG / JPEG / GIF / WebP）")?;
    Ok(serde_json::json!({
        "mimeType": mime,
        "dataUrl": format!("data:{mime};base64,{}", crate::open_in_app::base64(&bytes)),
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

/// `models_read` 里替换内联 `apiKey` 的哨兵。前端原样保存时由 `models_write` 还原。
pub const REDACTED_API_KEY: &str = "__PIGGY_REDACTED__";

/// 把 models.json 里的内联密钥替换成哨兵，再交给 webview。
///
/// 为什么必须做：`AdvancedSection` 的 raw JSON 编辑器读的是 `models_read`；而
/// `provider_set_key(store:"models")` 会把明文写进 `providers.*.apiKey`。
/// 不脱敏的话，H3 的"auth_list 掩码"被 `models_read` 整体绕过（webview 直接读明文）。
fn redact_models(mut v: Value) -> Value {
    if let Some(providers) = v.get_mut("providers").and_then(Value::as_object_mut) {
        for cfg in providers.values_mut() {
            if let Some(obj) = cfg.as_object_mut() {
                let has_key = obj
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .map(|s| !s.trim().is_empty())
                    .unwrap_or(false);
                if has_key {
                    obj.insert("apiKey".into(), Value::String(REDACTED_API_KEY.into()));
                }
            }
        }
    }
    v
}

/// raw 编辑器把哨兵原样存回来时，恢复旧的 `apiKey`（没有旧值就删键）。
fn restore_redacted_api_keys(old: &Value, new: &mut Value) {
    let old_providers = old.get("providers").and_then(Value::as_object);
    let Some(providers) = new.get_mut("providers").and_then(Value::as_object_mut) else {
        return;
    };
    for (name, cfg) in providers.iter_mut() {
        let Some(obj) = cfg.as_object_mut() else { continue };
        if obj.get("apiKey").and_then(Value::as_str) != Some(REDACTED_API_KEY) {
            continue;
        }
        let old_key = old_providers
            .and_then(|p| p.get(name))
            .and_then(|c| c.get("apiKey"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        match old_key {
            Some(key) => {
                obj.insert("apiKey".into(), Value::String(key));
            }
            None => {
                obj.remove("apiKey");
            }
        }
    }
}

/// `models_write` 这次改动里，哪些 provider 的 baseUrl 变了且已有已存密钥。
fn models_base_changes(old: &Value, new: &Value) -> Vec<String> {
    let Some(providers) = new.get("providers").and_then(Value::as_object) else {
        return Vec::new();
    };
    let agent = paths::agent_dir();
    let mut changed = Vec::new();
    for (name, cfg) in providers {
        let Some(new_base) = cfg
            .get("baseUrl")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let old_base = old
            .get("providers")
            .and_then(|p| p.get(name))
            .and_then(|c| c.get("baseUrl"))
            .and_then(Value::as_str);
        let has_stored_key = !crate::provider::resolve_key(&agent, name, "").0.trim().is_empty();
        if crate::provider::base_change_needs_confirm(old_base, new_base, has_stored_key) {
            changed.push(name.clone());
        }
    }
    changed
}

#[tauri::command]
pub async fn models_read() -> Result<Value, String> {
    let v = tokio::task::spawn_blocking(pi_files::models_read)
        .await
        .map_err(|e| e.to_string())??;
    Ok(redact_models(v))
}

/// 保存 models.json（高级页 raw 编辑器）。
///
/// 两条安全处理：
/// 1. `__PIGGY_REDACTED__` 还原成真实内联密钥（raw 编辑器看不到明文，也不会把它删掉）；
/// 2. 改了某个已存密钥 provider 的 baseUrl → 原生确认（否则 webview 可以先改地址再发密钥）。
#[tauri::command]
pub async fn models_write(app: AppHandle, value: Value) -> Result<(), String> {
    let old = pi_files::models_read().unwrap_or_else(|_| json!({}));
    let mut value = value;
    restore_redacted_api_keys(&old, &mut value);
    let changed = models_base_changes(&old, &value);
    if !changed.is_empty() {
        let ok = crate::ui_confirm::confirm(
            &app,
            "更改 API 地址？",
            &format!(
                "以下提供商的 API 地址被改动，且已存有密钥：{}\n\n\
                 继续会把密钥发往新地址。",
                changed.join("、")
            ),
        )
        .await;
        if !ok {
            return Err("已取消：更改 API 地址需要用户原生确认".to_string());
        }
    }
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
pub async fn settings_write(app: AppHandle, state: State<'_, AppState>, value: Value) -> Result<(), String> {
    /* sessionDir 是 session_* 闸门的根：webview 若能静默把它改成 C:\，
    `session_delete`/`session_page` 就又能操作任意 `.jsonl`。改这个键必须走原生确认；
    其它设置（主题、标题模型…）不弹，避免把设置页变成确认地狱。 */
    let old = pi_files::settings_read().unwrap_or_else(|_| json!({}));
    if session_dir_change_needs_confirmation(&old, &value) {
        let new_dir = value.get("sessionDir").and_then(Value::as_str).unwrap_or("");
        let ok = crate::ui_confirm::confirm(
            &app,
            "更改 pi 会话目录？",
            &format!(
                "新的会话目录：{new_dir}\n\n\
                 这会让 Piggy 把该目录下的 `.jsonl` 当作可列出/分页/删除的会话文件。\
                 只在你确实要迁移会话目录时继续。"
            ),
        )
        .await;
        if !ok {
            return Err("已取消：更改会话目录需要用户原生确认".to_string());
        }
    }
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
pub async fn pi_abort_bash(app: AppHandle, state: State<'_, AppState>, tab_id: String) -> Result<Value, String> {
    worker_of(&app, &state, &tab_id).await?.abort_bash().await
}

/* ---------------- M4：资源浏览器（只读；root 由 tab_id 决定，不再由前端指定） ---------------- */

/// 列出某个**已打开标签页**工作目录下的一个目录。
///
/// `tab_id` 而不是 `root`：root 来自视图状态，webview 可以伪造成 `C:\`；tab_id 的 cwd
/// 是 Rust 侧 registry 持有的。符号链接/junction 逃逸由 `ensure_within_resolved` 负责。
#[tauri::command]
pub async fn fs_list_dir(state: State<'_, AppState>, tab_id: String, path: String) -> Result<Value, String> {
    let root = {
        let reg = state.registry.lock().await;
        reg.tabs
            .get(&tab_id)
            .map(|t| t.cwd.clone())
            .ok_or_else(|| format!("标签页不存在或已关闭: {tab_id}"))?
    };
    list_dir_under(&root, &path)
}

/// [`fs_list_dir`] 的核心（纯函数便于契约测试直调）。
pub fn list_dir_under(root: &Path, path: &str) -> Result<Value, String> {
    let root = crate::fs_guard::validate_root(root)?;
    let p = Path::new(path);
    crate::fs_guard::ensure_within_resolved(&root, p).map_err(|e| e.to_string())?;
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
        let dir = b["isDir"]
            .as_bool()
            .unwrap_or(false)
            .cmp(&a["isDir"].as_bool().unwrap_or(false));
        dir.then(a["name"].as_str().cmp(&b["name"].as_str()))
    });
    Ok(serde_json::json!({ "entries": entries }))
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
            let Some(run) = state.fleet.get(run_id) else {
                return hit_capacity;
            };
            let Some(lane) = run.lane(&lane_key).cloned() else {
                continue;
            };
            let prompt = crate::fleet::render_prompt(&lane.prompt, &run.task, &run, &lane);
            let cwd = if lane.worktree {
                match crate::fleet::create_worktree(&run.cwd, &format!("{}-{}", run.id[..8].replace('-', ""), lane_key))
                {
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
            let lane_label = format!("fleet:{}/{}", &run_id[..8], lane_key);
            // lane 继承当前默认档位：Fleet 是"替用户跑任务"，不该偷偷提权
            let lane_permission = { state.registry.lock().await.default_permission };
            let max = state.perf.read().map(|p| p.max_workers).unwrap_or(8) as usize;
            // 同样走"锁外握手"那条路：lane 是并发拉起的，握着锁握手会互相卡
            match crate::sessions::registry::create_tab_unlocked(
                &state.registry,
                &sink(app),
                cwd.clone(),
                SessionTarget::NoSession,
                Some(lane_label),
                lane_permission,
                max,
            )
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
        // 游标同样后台补（lane 的会话是空的，几乎不花时间；保持与 UI 那条路径一致）
        crate::sessions::registry::spawn_cursor_init(state.registry.clone(), tab_id.clone());
        state.fleet.bind_tab(run_id, &lane_key, &tab_id);
        let worker = state
            .registry
            .lock()
            .await
            .tabs
            .get(&tab_id)
            .and_then(|t| t.worker.clone());
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
fn watch_lane(app: AppHandle, run_id: String, tab_id: String, worker: crate::pi::client::Worker) {
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
                        .and_then(|m| crate::fleet::last_assistant_text(&m))
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
    let run = crate::fleet::build_run(run_id.clone(), &template_id, template, task.trim(), PathBuf::from(&cwd))?;
    state.fleet.insert(run);
    fleet_emit(&app, &state);
    schedule_run(app, run_id.clone()).await;
    Ok(run_id)
}

#[tauri::command]
pub async fn fleet_abort(app: AppHandle, state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    let live_tabs = state
        .fleet
        .abort(&run_id)
        .ok_or_else(|| format!("run 不存在: {run_id}"))?;
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
    let streaming = matches!(worker.state(), crate::pi::client::WorkerState::Busy);
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
pub async fn pty_open(app: AppHandle, state: State<'_, AppState>, cwd: Option<String>) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let cwd = cwd
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| paths::expand_home(&s).to_string_lossy().into_owned())
        .unwrap_or_else(|| paths::home_dir_or_temp().to_string_lossy().into_owned());
    let handle = crate::pty::open_pty(&state.pty, &app, &id, &cwd, 24, 80)?;
    Ok(serde_json::json!({ "id": handle.id, "rows": handle.rows, "cols": handle.cols }))
}

#[tauri::command]
pub async fn pty_write(state: State<'_, AppState>, id: String, data: String) -> Result<(), String> {
    crate::pty::write_pty(&state.pty, &id, &data)
}

#[tauri::command]
pub async fn pty_resize(state: State<'_, AppState>, id: String, rows: u16, cols: u16) -> Result<(), String> {
    crate::pty::resize_pty(&state.pty, &id, rows, cols)
}

#[tauri::command]
pub async fn pty_close(state: State<'_, AppState>, id: String) -> Result<(), String> {
    crate::pty::close_pty(&state.pty, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    /* ---------------- tab_create 的 cwd 解析 ---------------- */

    /// Windows 形状：只设了 USERPROFILE（没有 HOME）时也必须解析出主目录。
    /// 这正是用户报「无法确定 cwd」的场景——老代码只看 HOME，于是返回 None。
    #[test]
    fn tab_cwd_uses_userprofile_home_on_windows() {
        let windows_home = PathBuf::from(r"C:\Users\x");
        assert_eq!(
            tab_cwd_with(None, Some(windows_home.clone()), true),
            Some(windows_home.clone())
        );
        // 显式路径照旧
        assert_eq!(
            tab_cwd_with(Some(r"D:\proj"), Some(windows_home.clone()), true),
            Some(PathBuf::from(r"D:\proj"))
        );
        // 空白 = 未提供
        assert_eq!(
            tab_cwd_with(Some("   "), Some(windows_home.clone()), true),
            Some(windows_home.clone())
        );
        // Windows 上 `~\proj` 也要展开（POSIX 上它是普通文件名）
        assert_eq!(
            tab_cwd_with(Some(r"~\proj"), Some(windows_home), true),
            Some(PathBuf::from(r"C:\Users\x").join("proj"))
        );
    }

    #[test]
    fn tab_cwd_expands_tilde_and_keeps_absolute() {
        let home = PathBuf::from("/h/u");
        assert_eq!(tab_cwd_with(Some("~"), Some(home.clone()), false), Some(home.clone()));
        assert_eq!(
            tab_cwd_with(Some("~/proj"), Some(home.clone()), false),
            Some(home.join("proj"))
        );
        assert_eq!(
            tab_cwd_with(Some("/abs/p"), Some(home), false),
            Some(PathBuf::from("/abs/p"))
        );
    }

    /// 主目录与 cwd 都拿不到时返回 None（调用方给出可操作的报错）。
    #[test]
    fn tab_cwd_none_without_home() {
        assert_eq!(tab_cwd_with(None, None, true), None);
        // 但用户显式给了路径就还能干活
        assert_eq!(tab_cwd_with(Some("/p"), None, false), Some(PathBuf::from("/p")));
    }

    /// 接线：生产入口必须和 `paths::home_dir()` 同源（两边漂移 = 又回到 HOME-only）。
    #[test]
    fn tab_cwd_wired_to_shared_home_resolver() {
        assert_eq!(tab_cwd(None), paths::home_dir());
        assert_eq!(tab_cwd(Some("")), paths::home_dir());
    }

    /* ---------------- fs_preview_read / session_* 的边界闸门 ---------------- */

    /// 预览硬闸门：敏感目录（含实际 agent 目录）全拒；同前缀兄弟目录不碰瓷。
    #[test]
    fn preview_gate_blocks_sensitive_dirs() {
        // 用真实 tempdir 当主目录：is_under 要求绝对路径，POSIX 形状的字面量
        // 在 Windows 上 is_absolute() 为假，会让断言测到别的分支。
        let home = tempfile::tempdir().unwrap();
        let home = home.path();
        for d in [".pi", ".ssh", ".aws", ".gnupg"] {
            let err = preview_gate(home, &home.join(d).join("agent").join("auth.json")).unwrap_err();
            assert!(err.contains("敏感目录"), "{d}: {err}");
        }
        // 同前缀兄弟目录（`.pipelines`）不是 `.pi`，不碰瓷
        assert!(preview_gate(home, &home.join(".pipelines").join("x.json")).is_ok());
        // 普通文件照常放行（"是否在工作区/home"由 preview_access_gate 判，不在这一层）
        assert!(preview_gate(home, &home.join("project").join("a.ts")).is_ok());
    }

    /// 图片魔数闸门：只认真实 PNG/JPEG/GIF/WebP，文本/JSON 改后缀进不来。
    #[test]
    fn image_mime_requires_real_magic_bytes() {
        assert_eq!(
            image_mime(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
            Some("image/png")
        );
        assert_eq!(image_mime(&[0xff, 0xd8, 0xff, 0xe0]), Some("image/jpeg"));
        assert_eq!(image_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(image_mime(b"RIFF0000WEBP...."), Some("image/webp"));
        assert_eq!(image_mime(b"{\"deepseek\":{\"key\":\"sk-x\"}}"), None);
        assert_eq!(image_mime(b"<svg xmlns=\"http://www.w3.org/2000/svg\">"), None);
    }

    /// models 内联密钥脱敏 + raw 编辑器回写时还原。
    #[test]
    fn models_redaction_round_trips_inline_keys() {
        let old = json!({"providers": {"relay": {"baseUrl": "https://r.example/v1", "apiKey": "sk-inline"}}});
        let shown = redact_models(old.clone());
        assert_eq!(shown["providers"]["relay"]["apiKey"], REDACTED_API_KEY);
        assert!(!shown.to_string().contains("sk-inline"));
        let mut saved = shown;
        restore_redacted_api_keys(&old, &mut saved);
        assert_eq!(saved["providers"]["relay"]["apiKey"], "sk-inline");
        // 没有旧值：删键，而不是把哨兵写回去
        let mut fresh = json!({"providers": {"relay": {"apiKey": REDACTED_API_KEY}}});
        restore_redacted_api_keys(&json!({}), &mut fresh);
        assert!(fresh["providers"]["relay"].get("apiKey").is_none());
    }

    /// baseUrl 改动 + 已存密钥 → 需要原生确认；没密钥/同地址/删地址 → 不弹。
    #[test]
    fn models_base_changes_only_when_a_stored_key_is_redirected() {
        // 用一个假 agent 目录跑 resolve_key：临时设置 PI_CODING_AGENT_DIR 会污染并行用例，
        // 所以这里只测纯函数 base_change_needs_confirm 与"无密钥不触发"这一支。
        assert!(!crate::provider::base_change_needs_confirm(
            Some("https://a.example"),
            "https://b.example",
            false
        ));
        assert!(crate::provider::base_change_needs_confirm(
            Some("https://a.example"),
            "https://b.example",
            true
        ));
        assert!(!crate::provider::base_change_needs_confirm(
            Some("https://a.example"),
            "https://a.example/",
            true
        ));
        assert!(!crate::provider::base_change_needs_confirm(
            Some("https://a.example"),
            "",
            true
        ));
        let old = json!({"providers": {"no-key": {"baseUrl": "https://a.example"}}});
        let new = json!({"providers": {"no-key": {"baseUrl": "https://b.example"}}});
        assert!(
            models_base_changes(&old, &new).is_empty(),
            "没有已存密钥时改地址不该弹确认"
        );
    }

    /// 可信工作区根覆盖子树；sessionDir 变更判据。
    #[test]
    fn trusted_roots_cover_subtrees_and_session_dir_confirmation() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(home.join("proj").join("sub")).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let empty = std::collections::HashSet::new();
        assert!(!is_trusted(&empty, &home.join("proj")));
        let mut approved = std::collections::HashSet::new();
        approved.insert(canonical_or_self(&home.join("proj")));
        // 批准父目录 = 批准子树；兄弟/界外不碰瓷
        assert!(is_trusted(&approved, &home.join("proj").join("sub")));
        assert!(!is_trusted(&approved, &outside));
        assert!(!is_trusted(&approved, &home.join("project-other")));

        // sessionDir：从无到有/换目录要确认；清空/不变不确认
        assert!(session_dir_change_needs_confirmation(
            &json!({}),
            &json!({"sessionDir": "C:\\s"})
        ));
        assert!(session_dir_change_needs_confirmation(
            &json!({"sessionDir": "C:\\a"}),
            &json!({"sessionDir": "C:\\b"})
        ));
        assert!(!session_dir_change_needs_confirmation(
            &json!({"sessionDir": "C:\\a"}),
            &json!({"sessionDir": "C:\\a"})
        ));
        assert!(!session_dir_change_needs_confirmation(
            &json!({"sessionDir": "C:\\a"}),
            &json!({})
        ));
    }

    /// 会话路径闸门：生效会话根下的 .jsonl 放行；界外/异扩展名/相对路径/`..` 全拒。
    #[test]
    fn session_file_gate_only_accepts_jsonl_under_the_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("sessions");
        std::fs::create_dir_all(root.join("--proj--")).unwrap();
        let session = root.join("--proj--").join("2026-10-28_x.jsonl");
        std::fs::write(&session, "{}\n").unwrap();
        std::fs::write(tmp.path().join("outside.jsonl"), "{}\n").unwrap();

        // 根下的 .jsonl（含嵌套布局）放行
        assert!(session_file_gate_under(&root, &session.to_string_lossy()).is_ok());

        // 界外的 .jsonl：这是审查发现的回收站原语（trash 任意路径），必须拒
        let err = session_file_gate_under(&root, &tmp.path().join("outside.jsonl").to_string_lossy()).unwrap_err();
        assert!(err.contains("不在生效会话根"), "{err}");
        // 异扩展名 / 相对路径 / `..` / 不存在
        assert!(session_file_gate_under(&root, &session.to_string_lossy().replace(".jsonl", ".txt")).is_err());
        assert!(session_file_gate_under(&root, "relative/x.jsonl").is_err());
        assert!(session_file_gate_under(
            &root,
            &format!("{}/../escape.jsonl", root.join("--proj--").to_string_lossy())
        )
        .is_err());
        assert!(session_file_gate_under(&root, &root.join("ghost.jsonl").to_string_lossy()).is_err());
    }

    /// `fs_list_dir` 的 root 由 tab cwd 决定；path 必须落在子树内。
    #[test]
    fn list_dir_under_stays_inside_the_tab_cwd() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(ws.join("sub")).unwrap();
        std::fs::write(ws.join("a.txt"), "a").unwrap();
        let ws_str = ws.to_string_lossy().into_owned();

        let out = list_dir_under(&ws, &ws_str).unwrap();
        assert_eq!(out["entries"].as_array().unwrap().len(), 2);
        assert!(list_dir_under(&ws, &tmp.path().join("outside").to_string_lossy()).is_err());
        assert!(list_dir_under(&ws, &ws.join("ghost").to_string_lossy()).is_err());
    }
}
