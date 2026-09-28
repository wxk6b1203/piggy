//! 插件管理（docs/03 §2.15，docs/04 §2.3）：设置页"插件"一节所需的全部后端能力。
//!
//! ## 为什么需要这一层（pi 没给）
//!
//! pi 的 RPC **没有**任何扩展管理命令——33 条命令里一条都不沾
//! （`modes/rpc/rpc-types.ts:20-74`），未知类型直接 `Unknown command`。
//! 所以插件页要么调 pi 的命令行，要么直接读写 pi 的文件。本模块两者都用，分工是：
//!
//! | 操作 | 走哪条路 | 理由 |
//! |---|---|---|
//! | 盘点（列出全部插件 + 启用状态） | 读文件 | 无命令可用；`pi list` 只列包且无 `--json` |
//! | 安装 / 删除 / 升级 | `pi install` / `remove` / `update` | 涉及 npm/git 落盘，自己实现必然与 pi 分叉 |
//! | 启用 / 停用 | 改 `settings.json` | pi 没有非交互命令，唯一入口是 `pi config` 那个 TUI |
//! | 登记 / 移除本地扩展路径 | 改 `settings.json` | 同上（`extensions[]`） |
//!
//! 所有写操作都落在 **pi 自己的配置文件**上（原子写 + `.bak`），Piggy 不新增私有存储：
//! 改完终端里的 `pi` 立刻就是同一个状态。
//!
//! ## 生效时机：必须告诉用户
//!
//! 已经跑起来的 worker 持有旧的扩展列表，`/reload` 只在交互式 TUI 里有效
//! （RPC 没有对应命令，`rpc-mode.ts` 里只有扩展命令处理器能拿到 `ctx.reload()`）。
//! 所以界面上明确写：**改动对新开的会话生效**；已经在跑的会话要重启。

pub mod builtins_generated;
pub mod cli;
pub mod inventory;

use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, State};

use crate::commands::AppState;
use crate::config::paths;
use crate::config::pi_files;
use crate::events::{EventSink, TauriSink};
use crate::pi::discovery;

use inventory::{Scope, ScopeDirs};

/// 插件全貌：分组 + 计数 + 警告。**返回形状由 `tests/ipc_contract.rs` 锁死。**
#[tauri::command]
pub async fn plugin_overview(project_dir: Option<String>) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let cwd = project_dir.map(PathBuf::from);
        inventory::overview(&paths::agent_dir(), cwd.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 解析这次用哪个 pi 二进制（插件命令必须在**同一个** pi 上跑，
/// 否则装到一半的包在另一个 pi 里看不到）。
async fn resolve_pi(state: &State<'_, AppState>) -> Result<PathBuf, String> {
    let (source, custom, builtin) = {
        let reg = state.registry.lock().await;
        (reg.pi_source, reg.pi_custom_path.clone(), reg.builtin.clone())
    };
    discovery::discover(source, custom.as_deref(), builtin.as_deref())
        .map(|b| b.path)
        .map_err(|e| format!("找不到可用的 pi 二进制：{e}"))
}

/// 安装 / 删除 / 升级：起一个后台任务，立刻返回 `jobId`。
///
/// 输出按行推 `plugin:log:<jobId>`，结束时推 `plugin:done:<jobId>`。
/// 不阻塞命令是因为 `npm install` 的时间尺度是分钟级——同步等会把界面钉死，
/// 而且失败原因（网络/权限/依赖冲突）只看退出码查不出来，必须让用户看到原始输出。
#[tauri::command]
pub async fn plugin_run(
    app: AppHandle,
    state: State<'_, AppState>,
    action: String,
    source: Option<String>,
    scope: String,
    project_dir: Option<String>,
) -> Result<Value, String> {
    let pi = resolve_pi(&state).await?;
    let cwd = match project_dir.as_deref() {
        Some(d) if !d.trim().is_empty() => PathBuf::from(d),
        _ => std::env::current_dir().map_err(|e| e.to_string())?,
    };
    let invocation = cli::plan(&action, source.as_deref(), &scope, project_dir.as_deref())?;
    // 项目作用域：pi 只认**被信任**的项目目录，信任记录在 ~/.pi/agent/trust.json。
    // 这里不代 pi 写信任表（那是安全决策），但把状态查出来让界面能提前提示。
    let sink: std::sync::Arc<dyn EventSink> = std::sync::Arc::new(TauriSink { app });
    let job_id = cli::spawn(sink, pi, invocation, cwd);
    Ok(json!({ "jobId": job_id }))
}

/// 正在跑/刚跑完的任务（界面刷新后重新拉一次，避免漏事件）。
#[tauri::command]
pub async fn plugin_jobs() -> Result<Value, String> {
    Ok(json!({ "jobs": cli::snapshot().await }))
}

/// 取消一个任务（杀子进程）。文件可能已经落了一部分——界面要如实说。
#[tauri::command]
pub async fn plugin_job_cancel(job_id: String) -> Result<(), String> {
    cli::request_cancel(&job_id);
    Ok(())
}

/// 项目是否已被 pi 信任（`~/.pi/agent/trust.json`，`trust-manager.ts:209-214`）。
///
/// 未信任时 pi 会**整份忽略** `.pi/settings.json`（`settings-manager.ts:410-413`）,
/// 于是项目里的插件一个都不会加载。界面必须提前说，而不是让用户对着空列表猜。
#[tauri::command]
pub async fn plugin_project_trust(project_dir: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let trust = pi_files::read_json(&paths::agent_dir().join("trust.json"))?;
        let dir = PathBuf::from(&project_dir);
        let mut trusted = false;
        let mut matched: Option<String> = None;
        if let Some(obj) = trust.as_object() {
            for (key, v) in obj {
                if v.as_bool() == Some(true) && same_dir(key, &project_dir) {
                    trusted = true;
                    matched = Some(key.clone());
                }
            }
        }
        Ok::<Value, String>(json!({
            "trusted": trusted,
            "matched": matched,
            "dir": dir.to_string_lossy(),
            "trustFile": paths::agent_dir().join("trust.json").to_string_lossy(),
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn same_dir(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        let p = paths::expand_home(s);
        std::fs::canonicalize(&p).unwrap_or(p).to_string_lossy().into_owned()
    };
    norm(a) == norm(b)
}

/* ============================ 启用 / 停用 ============================ */

/// 把 `settings.json` 的 `extensions[]` 读成 `Vec<String>`（并做一次形状校验）。
fn extension_array(settings: &Value) -> Result<Vec<String>, String> {
    match settings.get("extensions") {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(Value::Array(a)) => {
            let mut out = Vec::new();
            for item in a {
                match item.as_str() {
                    Some(s) => out.push(s.to_string()),
                    None => return Err("settings.json 的 extensions 里有非字符串项，已停止写入（请先在「高级」里修好）".into()),
                }
            }
            Ok(out)
        }
        Some(_) => Err("settings.json 的 extensions 不是数组，已停止写入（请先在「高级」里修好）".into()),
    }
}

/// 去掉与目标路径等价的那条规则（`-x` / `+x` / `!x` 与裸 `x` 都算）。
fn strip_rule(list: &[String], rel: &str, abs: &str) -> Vec<String> {
    let target = |p: &str| -> String {
        let p = p.replace('\\', "/");
        p.trim_start_matches("./").to_string()
    };
    list.iter()
        .filter(|entry| {
            let body = entry
                .strip_prefix('-')
                .or_else(|| entry.strip_prefix('+'))
                .or_else(|| entry.strip_prefix('!'))
                .unwrap_or(entry);
            let b = target(body);
            b != rel && b != abs
        })
        .cloned()
        .collect()
}

/// 启用/停用一个插件。
///
/// 两种来源，两种写法（都是 pi 自己的语义，`package-manager.ts:707-780`）：
///
/// * **发现目录 / 登记路径** → 往同作用域 settings 的 `extensions[]` 写
///   `-<相对路径>`（停用，精确匹配）或把它去掉（启用）。
///   这**正是** `pi config` 那个 TUI 干的事，所以终端里的 pi 会给出同样的结论。
/// * **包** → 把 `PackageSource` 换成对象形式并用 `autoload`：
///   启用 = `autoload:true` 且清掉所有 `-`/`!` 规则；
///   停用 = `autoload:false` 且清掉所有 `+` 规则（没有 `+` 就什么都不加载）。
#[tauri::command]
pub async fn plugin_set_enabled(
    key: String,
    enabled: bool,
    project_dir: Option<String>,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        set_enabled_at(&paths::agent_dir(), &key, enabled, project_dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 与命令同一份逻辑，但 **agent 目录显式传入**。
///
/// 命令层传 `paths::agent_dir()`；测试直接传临时目录。
/// 不这么做的话测试只能靠改 `PI_CODING_AGENT_DIR` 环境变量，
/// 而 Rust 的测试线程共享进程环境——并行跑会互相把对方的目录指走
/// （这不是假想：第一版就这么写，5 个用例里挂了 2 个）。
pub fn set_enabled_at(
    agent_dir: &std::path::Path,
    key: &str,
    enabled: bool,
    project_dir: Option<&str>,
) -> Result<Value, String> {
    // key = "<scope>:<kind>:<source>"（与 inventory::make_entry 拼的一致）。
    // source 里可能含 ':'（`npm:@a/b`、`git:host/x`），所以只切前两段。
    let mut parts = key.splitn(3, ':');
    let scope_s = parts.next().unwrap_or_default();
    let kind = parts.next().unwrap_or_default();
    let source = parts.next().unwrap_or_default();
    let scope = Scope::parse(scope_s)?;

    let cwd = project_dir.map(PathBuf::from);
    if scope == Scope::Project && cwd.is_none() {
        return Err("这是本项目的条目，但没有打开项目目录".into());
    }
    let dirs = ScopeDirs::new(agent_dir.to_path_buf(), cwd.clone().unwrap_or_default());
    let settings_path = dirs.settings_path(scope);
    let mut settings = inventory::read_settings(&dirs, scope)?;

    match kind {
        "discovered" | "path" => {
            let raw = if kind == "path" {
                inventory::resolve_local(source, &dirs.base_dir(scope))
            } else {
                PathBuf::from(source)
            };
            let base = dirs.base_dir(scope);
            let abs = raw.to_string_lossy().replace('\\', "/");
            let rel = relative_posix(&base, &raw);
            let mut list = extension_array(&settings)?;
            // 先把这条路径的既有规则全摘掉，避免 `-x` 与 `+x` 同时存在时
            // 出现"点了启用却没生效"（pi 的判定顺序是 `-` 最后赢）。
            let had_plain = list.iter().any(|e| {
                let body = e.trim_start_matches(['-', '+', '!']);
                body.replace('\\', "/").trim_start_matches("./") == rel
            });
            list = strip_rule(&list, &rel, &abs);
            if enabled {
                // 启用：如果原本连"这是扩展"都没声明过（只有 `-x`），要补一条裸路径，
                // 否则发现目录里的文件仍然会按无规则处理——那是启用的，
                // 但显式登记的路径必须有裸条目才会被收集（`resolveLocalEntries`）。
                if kind == "path" && !had_plain {
                    list.push(source.to_string());
                }
            } else {
                list.push(format!("-{rel}"));
            }
            set_or_clear(&mut settings, "extensions", list);
            inventory::write_settings(&dirs, scope, &settings)?;
            Ok(json!({ "ok": true, "wrote": settings_path.to_string_lossy(), "settings": settings }))
        }
        "package" => {
            let pkgs = settings
                .get("packages")
                .and_then(|p| p.as_array())
                .cloned()
                .unwrap_or_default();
            let mut found = false;
            let mut next: Vec<Value> = Vec::new();
            for pkg in pkgs {
                let (s, _autoload, _pats) = inventory::split_package(&pkg);
                if s != source {
                    next.push(pkg);
                    continue;
                }
                found = true;
                next.push(apply_package_enabled(&pkg, enabled));
            }
            if !found {
                return Err(format!("在 {} 的 packages 里找不到 {source}", settings_path.display()));
            }
            settings["packages"] = Value::Array(next);
            inventory::write_settings(&dirs, scope, &settings)?;
            Ok(json!({ "ok": true, "wrote": settings_path.to_string_lossy(), "settings": settings }))
        }
        other => Err(format!("这类条目不支持启停：{other}（发现目录里的文件要停用请直接删文件）")),
    }
}

/// 把一条 `PackageSource` 改成启用/停用后的形状。
///
/// * **启用** → `autoload: true` 并**清掉全部资源规则**。规则留着虽然无害，
///   但会在 settings.json 里堆成 `{"source":…,"autoload":true,"extensions":["+index.ts"]}`
///   这种谁也看不懂的形状；而且"启用这个插件"的语义就是"把它提供的都加载"。
///   只剩 `source` + `autoload:true` 时直接塌回字符串，与 `pi install` 写的形状一致。
/// * **停用** → `autoload: false` 并**丢掉 `+` 规则**。`autoload:false` + `+index.ts`
///   仍然会加载（`applyAutoloadDisabledPatterns`），不清就是"点了停用却没停"。
///   保留 `-`/`!` 规则，它们是"哪些本来就被排除"的记录。
fn apply_package_enabled(pkg: &Value, enabled: bool) -> Value {
    let source = match pkg {
        Value::String(s) => s.clone(),
        Value::Object(o) => o.get("source").and_then(|s| s.as_str()).unwrap_or_default().to_string(),
        _ => String::new(),
    };
    let mut obj = match pkg {
        Value::Object(o) => o.clone(),
        _ => serde_json::Map::new(),
    };
    obj.insert("source".into(), Value::String(source.clone()));
    obj.insert("autoload".into(), Value::Bool(enabled));
    for field in ["extensions", "skills", "prompts", "themes"] {
        let Some(arr) = obj.get(field).and_then(|v| v.as_array()).cloned() else {
            continue;
        };
        let kept: Vec<Value> = if enabled {
            Vec::new()
        } else {
            arr.into_iter()
                .filter(|v| !v.as_str().map(|s| s.starts_with('+')).unwrap_or(false))
                .collect()
        };
        if kept.is_empty() {
            obj.remove(field);
        } else {
            obj.insert(field.into(), Value::Array(kept));
        }
    }
    // 只剩 `source` + `autoload:true` = 默认行为，塌成字符串（与 pi install 一致）
    if enabled && obj.len() == 2 {
        return Value::String(source);
    }
    if obj.len() == 1 {
        return obj.get("source").cloned().unwrap_or(Value::Null);
    }
    Value::Object(obj)
}

/// 空数组就删掉这个键（settings.json 里不留 `"extensions": []` 这种噪声）。
fn set_or_clear(settings: &mut Value, key: &str, list: Vec<String>) {
    if list.is_empty() {
        if let Some(o) = settings.as_object_mut() {
            o.remove(key);
        }
    } else {
        settings[key] = Value::Array(list.into_iter().map(Value::String).collect());
    }
}

fn relative_posix(base: &std::path::Path, path: &std::path::Path) -> String {
    // 与 inventory 里的同名逻辑一致；这里单独放一份是为了不改 inventory 的可见性。
    let b: Vec<_> = base.components().collect();
    let p: Vec<_> = path.components().collect();
    let common = b.iter().zip(p.iter()).take_while(|(x, y)| x == y).count();
    if common == 0 {
        return path.to_string_lossy().replace('\\', "/");
    }
    let mut out: Vec<String> = Vec::new();
    for _ in common..b.len() {
        out.push("..".into());
    }
    for c in &p[common..] {
        out.push(c.as_os_str().to_string_lossy().into_owned());
    }
    out.join("/")
}

/* ============================ 登记本地扩展路径 ============================ */

/// 把一个本地路径登记为扩展（写 `extensions[]`）。
///
/// 与「安装」的区别：安装走 `pi install`（会把包记进 `packages[]`，npm/git 还会真的
/// 下载到 `~/.pi/agent/npm|git`）；登记只是"告诉 pi 去这个路径加载"，
/// 文件留在原地、不进 `pi list`。已经装好的本地目录用登记更轻。
#[tauri::command]
pub async fn plugin_add_path(
    path: String,
    scope: String,
    project_dir: Option<String>,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        add_path_at(&paths::agent_dir(), &path, &scope, project_dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn add_path_at(
    agent_dir: &std::path::Path,
    path: &str,
    scope: &str,
    project_dir: Option<&str>,
) -> Result<Value, String> {
    {
        let scope = Scope::parse(scope)?;
        let cwd = project_dir.map(PathBuf::from);
        if scope == Scope::Project && cwd.is_none() {
            return Err("要登记到本项目，得先打开一个项目目录".into());
        }
        let dirs = ScopeDirs::new(agent_dir.to_path_buf(), cwd.unwrap_or_default());
        let resolved = inventory::resolve_local(path, &dirs.base_dir(scope));
        if !resolved.exists() {
            return Err(format!("路径不存在：{}", resolved.display()));
        }
        // 必须是 pi 认得的扩展：文件得是 .ts/.js；目录得有 index.ts/js 或
        // package.json 的 pi.extensions（`loader.ts:670-744`）。
        let ok = if resolved.is_dir() {
            !inventory::extension_entries(&resolved).is_empty()
        } else {
            resolved
                .extension()
                .map(|e| e == "ts" || e == "js")
                .unwrap_or(false)
        };
        if !ok {
            return Err(format!(
                "pi 不会把这个路径当扩展加载：{}（文件要 .ts/.js，目录要有 index.ts/index.js 或 package.json 的 pi.extensions）",
                resolved.display()
            ));
        }
        let mut settings = inventory::read_settings(&dirs, scope)?;
        let mut list = extension_array(&settings)?;
        if list.iter().any(|e| e == path) {
            return Err("这个路径已经登记过了".into());
        }
        list.push(path.to_string());
        set_or_clear(&mut settings, "extensions", list);
        inventory::write_settings(&dirs, scope, &settings)?;
        Ok(json!({ "ok": true, "path": resolved.to_string_lossy(), "settings": settings }))
    }
}

/// 从 `extensions[]` 里移除一条登记（**不删文件**，只解除登记）。
#[tauri::command]
pub async fn plugin_remove_path(
    entry: String,
    scope: String,
    project_dir: Option<String>,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        remove_path_at(&paths::agent_dir(), &entry, &scope, project_dir.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

fn remove_path_at(
    agent_dir: &std::path::Path,
    entry: &str,
    scope: &str,
    project_dir: Option<&str>,
) -> Result<Value, String> {
    {
        let scope = Scope::parse(scope)?;
        let cwd = project_dir.map(PathBuf::from);
        if scope == Scope::Project && cwd.is_none() {
            return Err("这是本项目的条目，但没有打开项目目录".into());
        }
        let dirs = ScopeDirs::new(agent_dir.to_path_buf(), cwd.unwrap_or_default());
        let mut settings = inventory::read_settings(&dirs, scope)?;
        let list = extension_array(&settings)?;
        // 移除这一条**以及**它可能留下的 `+`/`-`/`!` 规则——只删裸条目会留下
        // 一条指向"已经不在列表里"的死规则，下次登记同一个路径时它会立刻把它排除掉。
        let resolved = inventory::resolve_local(entry, &dirs.base_dir(scope));
        let abs = resolved.to_string_lossy().replace('\\', "/");
        let rel = relative_posix(&dirs.base_dir(scope), &resolved);
        let before = list.len();
        let next: Vec<String> = strip_rule(&list, &rel, &abs)
            .into_iter()
            .filter(|e| e != entry)
            .collect();
        if next.len() == before {
            return Err("settings.json 里没有这条登记".into());
        }
        set_or_clear(&mut settings, "extensions", next);
        inventory::write_settings(&dirs, scope, &settings)?;
        Ok(json!({ "ok": true, "settings": settings }))
    }
}

/// 删除发现目录里的一个插件（**真的删文件**，走系统回收站而不是 `rm`）。
///
/// pi 对发现目录里的扩展没有"卸载"命令，删文件是唯一途径。用回收站是为了可撤销——
/// `trash` 已经在依赖里（`open_in_app` 用它）。
#[tauri::command]
pub async fn plugin_delete_discovered(key: String) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || {
        let mut parts = key.splitn(3, ':');
        let scope = Scope::parse(parts.next().unwrap_or_default())?;
        let kind = parts.next().unwrap_or_default();
        let path = PathBuf::from(parts.next().unwrap_or_default());
        if kind != "discovered" {
            return Err(format!("只有发现目录里的插件走删除文件：{kind}"));
        }
        if scope == Scope::Builtin {
            return Err("pi 内置扩展删不掉".into());
        }
        // 只允许删发现目录**里面**的东西，且必须真的是扩展——两道闸都是防止
        // 一个拼错的 key 把用户随便什么目录丢进回收站。
        let cwd = std::env::current_dir().unwrap_or_default();
        let dirs = ScopeDirs::new(paths::agent_dir(), cwd);
        let root = dirs.discovery_dir(scope);
        let canon_root = std::fs::canonicalize(&root).unwrap_or(root.clone());
        let canon = std::fs::canonicalize(&path).unwrap_or(path.clone());
        if !canon.starts_with(&canon_root) || canon == canon_root {
            return Err(format!("{} 不在发现目录 {} 里，拒绝删除", canon.display(), canon_root.display()));
        }
        let is_dir = canon.is_dir();
        let ok = if is_dir {
            !inventory::extension_entries(&canon).is_empty()
        } else {
            canon.extension().map(|e| e == "ts" || e == "js").unwrap_or(false)
        };
        if !ok {
            return Err(format!("{} 不是 pi 认得的扩展，拒绝删除", canon.display()));
        }
        trash::delete(&canon).map_err(|e| format!("移到回收站失败：{e}"))?;
        Ok(json!({ "ok": true, "deleted": canon.to_string_lossy() }))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 校验一个来源串**在 pi 眼里**是什么（安装对话框的即时反馈）。
///
/// 最重要的一条：裸包名会被 pi 当**本地路径**（`isLocalPath` 只看前缀，
/// `package-manager.ts:1446-1471`），实测 `pi install @scope/pkg` 报的是
/// `Path does not exist: …/@scope/pkg`。这个坑必须在这里拦住并给出正确写法。
#[tauri::command]
pub async fn plugin_check_source(source: String) -> Result<Value, String> {
    let s = source.trim().to_string();
    if s.is_empty() {
        return Ok(json!({ "ok": false, "problem": "请填写来源", "hint": "" }));
    }
    let kind = inventory::classify(&s);
    let mut problem = Value::Null;
    let mut hint = String::new();
    if kind == inventory::SourceKind::Local {
        // 裸名字：不带任何路径前缀，且形状像 npm 包名（`foo` / `@scope/foo`）。
        // pi 会把它当**本地路径**去 cwd 下找，实测报的是
        // `Path does not exist: …/@scope/pkg`——用户完全看不出要加 npm: 前缀。
        let no_path_prefix = !s.starts_with('/')
            && !s.starts_with('~')
            && !s.starts_with('.')
            && !s.starts_with("file:");
        let looks_bare = no_path_prefix && (is_plain_package_name(&s) || is_scoped_package_name(&s));
        if looks_bare {
            problem = json!("pi 会把裸名字当本地路径，而不是 npm 包名");
            hint = format!("想装 npm 包请写成 npm:{s}");
        } else {
            let resolved = inventory::resolve_local(&s, &std::env::current_dir().unwrap_or_default());
            if !resolved.exists() {
                problem = json!(format!("路径不存在：{}", resolved.display()));
                hint = "本地路径是相对当前项目目录解析的".into();
            }
        }
    }
    Ok(json!({
        "ok": problem.is_null(),
        "problem": problem,
        "hint": hint,
        "sourceKind": kind.as_str(),
        "sourceKindLabel": kind.label(),
    }))
}

/// `foo`：不含 `/`，且只由 npm 包名允许的字符组成。
fn is_plain_package_name(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('/')
        && s.chars().all(|c| c.is_ascii_alphanumeric() || ". _-~".contains(c))
        && s.chars().next().map(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).unwrap_or(false)
}

/// `@scope/foo`：一个 `@`、恰好一个 `/`，两段都非空。
fn is_scoped_package_name(s: &str) -> bool {
    let Some(rest) = s.strip_prefix('@') else { return false };
    match rest.split_once('/') {
        Some((scope, name)) => !scope.is_empty() && !name.is_empty() && !name.contains('/'),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(p: &std::path::Path, v: &Value) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, serde_json::to_string_pretty(v).unwrap()).unwrap();
    }

    /// 停用发现目录里的扩展 = 写一条精确排除规则，**这正是 pi 自己的做法**
    /// （`config-selector.ts:542` 的 `-${pattern}`）。用真机验证过的语义锁住。
    #[test]
    fn disabling_a_discovered_extension_writes_a_minus_rule() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(agent.join("extensions")).unwrap();
        fs::write(agent.join("extensions/foo.ts"), "export default 1").unwrap();
        write(&agent.join("settings.json"), &json!({}));

        let key = format!("global:discovered:{}", agent.join("extensions/foo.ts").display());
        let out = set_enabled_at(&agent, &key, false, None).unwrap();
        assert_eq!(out["settings"]["extensions"], json!(["-extensions/foo.ts"]));

        // 写完之后盘点必须说它被停用了（读写闭环，不是只看写出来的 JSON）
        let v = inventory::overview(&agent, None).unwrap();
        let p = &v["groups"][0]["plugins"][0];
        assert_eq!(p["enabled"], json!(false));
        assert!(p["enabledBy"].as_str().unwrap().contains("- 规则"));
    }

    /// 再启用要**把规则摘干净**，不能留下 `-x`（否则 pi 的判定顺序里 `-` 最后赢，
    /// 界面显示已启用、pi 却不加载——这种"点了没反应"最难查）。
    #[test]
    fn enabling_removes_the_exclusion_rule_completely() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(agent.join("extensions")).unwrap();
        fs::write(agent.join("extensions/foo.ts"), "export default 1").unwrap();
        write(&agent.join("settings.json"), &json!({ "extensions": ["-extensions/foo.ts"] }));

        let key = format!("global:discovered:{}", agent.join("extensions/foo.ts").display());
        let out = set_enabled_at(&agent, &key, true, None).unwrap();

        // 没有任何规则了 → 键被清掉（不留 `"extensions": []`）
        assert!(out["settings"].get("extensions").is_none(), "{out}");
        let v = inventory::overview(&agent, None).unwrap();
        assert_eq!(v["groups"][0]["plugins"][0]["enabled"], json!(true));
    }

    /// 包的启停用 `autoload`，并且要清掉冲突的 `+`/`-` 规则。
    #[test]
    fn package_toggle_uses_autoload_and_drops_conflicting_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(&agent).unwrap();
        write(
            &agent.join("settings.json"),
            &json!({ "packages": [{ "source": "npm:@a/b", "autoload": false, "extensions": ["+index.ts"] }] }),
        );

        let on = set_enabled_at(&agent, "global:package:npm:@a/b", true, None).unwrap();
        let off = set_enabled_at(&agent, "global:package:npm:@a/b", false, None).unwrap();

        // 启用：全部规则清掉并塌回字符串形式（与 pi install 写的一致）
        assert_eq!(on["settings"]["packages"], json!(["npm:@a/b"]), "{on}");
        // 停用必须写成对象形式：`autoload:false` 是 pi 表达"这个包不加载"的**唯一**方式
        // （没有 enabled 字段，字符串形式 = 全加载）。塌回字符串就等于没停用。
        assert_eq!(
            off["settings"]["packages"],
            json!([{ "source": "npm:@a/b", "autoload": false }]),
            "{off}"
        );
        // 写完之后盘点必须同意"它被停用了"——读写闭环
        let v = inventory::overview(&agent, None).unwrap();
        let row = v["groups"][0]["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["kind"] == json!("package"))
            .expect("盘点的全局组里应有那条包");
        assert_eq!(row["enabled"], json!(false));
    }

    /// 包停用要清掉 `+` 规则：`autoload:false` + `+index.ts` 仍然会加载，
    /// 不清就是"点了停用却没停"。
    #[test]
    fn disabling_a_package_clears_force_include_rules() {
        let pkg = json!({ "source": "npm:@a/b", "extensions": ["+index.ts", "-other.ts"] });
        let off = apply_package_enabled(&pkg, false);
        assert_eq!(off["autoload"], json!(false));
        assert_eq!(off["extensions"], json!(["-other.ts"]));
    }

    /// 形状不对的 settings 必须**拒绝写入**而不是猜——猜错的后果是把用户整份配置写坏。
    #[test]
    fn malformed_settings_are_refused_not_guessed() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(agent.join("extensions")).unwrap();
        fs::write(agent.join("extensions/foo.ts"), "export default 1").unwrap();
        write(&agent.join("settings.json"), &json!({ "extensions": "not-an-array" }));
        let before = fs::read_to_string(agent.join("settings.json")).unwrap();

        let key = format!("global:discovered:{}", agent.join("extensions/foo.ts").display());
        let r = set_enabled_at(&agent, &key, false, None);

        assert!(r.is_err());
        assert!(r.unwrap_err().contains("不是数组"));
        assert_eq!(
            fs::read_to_string(agent.join("settings.json")).unwrap(),
            before,
            "文件不该被动过"
        );
    }

    /// 形如 `npm:@a/b` 的来源含 `:`，key 的切分必须只切前两段。
    #[test]
    fn keys_with_colons_in_the_source_still_parse() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(&agent).unwrap();
        write(&agent.join("settings.json"), &json!({ "packages": ["npm:@a/b"] }));

        let r = set_enabled_at(&agent, "global:package:npm:@a/b", false, None);
        assert!(r.is_ok(), "{r:?}");
    }

    /// 登记路径必须拒绝 pi 加载不了的东西（否则写进去也是死的）。
    #[test]
    fn add_path_refuses_what_pi_would_not_load() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(&agent).unwrap();
        fs::write(agent.join("settings.json"), "{}").unwrap();
        let bad = tmp.path().join("notes.md");
        fs::write(&bad, "x").unwrap();

        let e = add_path_at(&agent, &bad.to_string_lossy(), "global", None).unwrap_err();
        assert!(e.contains("不会把这个路径当扩展加载"), "{e}");
    }

    /// 登记一个真的扩展要能成功，并且再盘点时它就在列表里。
    #[test]
    fn add_path_registers_a_real_extension() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(&agent).unwrap();
        fs::write(agent.join("settings.json"), "{}").unwrap();
        let ext = tmp.path().join("my-ext.ts");
        fs::write(&ext, "export default () => {}").unwrap();

        add_path_at(&agent, &ext.to_string_lossy(), "global", None).unwrap();
        let v = inventory::overview(&agent, None).unwrap();
        let found = v["groups"][0]["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["kind"] == json!("path"));
        assert!(found, "登记后盘点里应该出现 kind=path 的一条：{v}");
    }

    /// 移除登记要**连它留下的 `+`/`-` 规则一起清掉**，否则下次登记同一个路径时，
    /// 那条残留的 `-` 会立刻把它排除掉——表现是"加了却没用"。
    #[test]
    fn removing_a_registered_path_also_drops_its_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(agent.join("exts")).unwrap();
        let ext = agent.join("exts/my-ext.ts");
        fs::write(&ext, "export default () => {}").unwrap();
        write(
            &agent.join("settings.json"),
            &json!({ "extensions": ["exts/my-ext.ts", "-exts/other.ts"] }),
        );

        let out = remove_path_at(&agent, "exts/my-ext.ts", "global", None).unwrap();
        // 只剩别人的那条规则
        assert_eq!(out["settings"]["extensions"], json!(["-exts/other.ts"]), "{out}");

        // 再登记回来时不该被任何残留规则挡住
        add_path_at(&agent, "exts/my-ext.ts", "global", None).unwrap();
        let v = inventory::overview(&agent, None).unwrap();
        let p = v["groups"][0]["plugins"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["kind"] == json!("path"))
            .expect("登记后应该有一条 kind=path");
        assert_eq!(p["enabled"], json!(true));
    }

    /// 裸包名检查：必须告诉用户写成 `npm:` 前缀（pi 会把它当本地路径）。
    #[test]
    fn bare_package_names_are_flagged_with_the_right_fix() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        for bare in ["@scope/pkg", "some-pkg"] {
            let r = rt.block_on(plugin_check_source(bare.into())).unwrap();
            assert_eq!(r["ok"], json!(false), "{bare}: {r}");
            assert!(
                r["hint"].as_str().unwrap().contains(&format!("npm:{bare}")),
                "{bare} 的提示应给出 npm: 写法，实际 {}",
                r["hint"]
            );
        }
        let ok = rt.block_on(plugin_check_source("npm:@scope/pkg".into())).unwrap();
        assert_eq!(ok["ok"], json!(true));
        assert_eq!(ok["sourceKind"], json!("npm"));

        // 相对路径不会被误判成包名
        let rel = rt.block_on(plugin_check_source("./x".into())).unwrap();
        assert_ne!(rel["problem"], json!("pi 会把裸名字当本地路径，而不是 npm 包名"));
    }

    /// 包名识别器本身的边界（它决定"提醒用户加 npm:"还是"说路径不存在"）。
    #[test]
    fn package_name_detection_is_narrow() {
        assert!(is_plain_package_name("pi-guardrails"));
        assert!(is_plain_package_name("a"));
        assert!(!is_plain_package_name("Foo"));
        assert!(!is_plain_package_name("a/b"));
        assert!(is_scoped_package_name("@scope/pkg"));
        assert!(!is_scoped_package_name("@scope"));
        assert!(!is_scoped_package_name("@scope/a/b"));
        assert!(!is_scoped_package_name("scope/pkg"));
    }
}
