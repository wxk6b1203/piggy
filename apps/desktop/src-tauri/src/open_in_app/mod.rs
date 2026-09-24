//! 「打开方式」——把当前工作区目录交给本机已安装的编辑器 / IDE / Git GUI / 终端 / 文件管理器。
//!
//! 移植 DSH 的一对包（docs/11 §2.1）：
//! - 宿主半边 `@deepseek-ai/dsh-host-open-in-app`：固定目录 + 逐平台解析 + 图标 + 启动；
//! - 浏览器半边 `@deepseek-ai/dsh-client-ui-open-in-app`：会话头部的分裂胶囊按钮。
//!
//! Piggy 里宿主半边**落在 Rust**（Tauri 的命令层），不是再起一个 Node 服务：
//! 这一侧本来就有文件系统与进程能力，而 DSH 那三个 HTTP 路由在这里等价于三个命令。
//!
//! 三个命令的分工与不变量：
//! - `open_in_app_list`：本机装了哪些（**只报验过的启动器**），进程内缓存一次；
//! - `open_in_app_icon`：某个应用的图标（data URL；拿不到就 None，前端画通用图标）；
//! - `open_in_app_open`：在某个应用里打开某个目录。**只认已解析出来的启动器**，
//!   不接受前端传命令 —— 否则这个命令就是一个"任意命令执行"入口。
//!
//! 关于权限（docs/08 §6 最小权限）：DSH docs/11 原计划用 `tauri-plugin-opener`，
//! 但那个插件的权限面是"任意路径/URL"。这里的三个命令只做一件事：
//! 用本机已安装的**白名单应用**打开一个**已存在的绝对目录**，没有 URL、没有任意命令。

pub mod catalog;
pub mod host;
pub mod icons;
pub mod resolver;
pub mod spec;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use host::{Facts, RealHost};
use spec::{LaunchOutcome, LaunchSpec, Resolved};

/// 宿主命令（`xcode-select` / `plutil` / `reg.exe`）的单条超时。
/// DSH 把解析超时与图标超时分开（两个旋钮，调一个不影响另一个）；这里沿用同样的分离。
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const ICON_TIMEOUT: Duration = Duration::from_secs(10);
/// 启动后的观察窗：窗内非零退出 = 失败；到点仍在跑 = 交出去了（kitty/JetBrains 会一直前台运行）。
const LAUNCH_WATCH: Duration = Duration::from_secs(1);

/// 进程内的一次解析结果（DSH：`resolveOpenInAppApps` 每进程跑一次）。
fn cache() -> &'static Mutex<Option<Vec<Resolved>>> {
    static CACHE: OnceLock<Mutex<Option<Vec<Resolved>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn icon_cache() -> &'static Mutex<HashMap<String, Option<String>>> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<String>>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 本机已解析出的应用（首次调用时解析，之后复用）。
pub fn resolved_apps() -> Vec<Resolved> {
    let mut slot = cache().lock().unwrap_or_else(|e| e.into_inner());
    if slot.is_none() {
        let facts = Facts::detect();
        let real = RealHost::new(facts.clone());
        let apps = resolver::resolve_all(&real, &facts, PROBE_TIMEOUT);
        eprintln!(
            "[piggy] 「打开方式」解析到 {} 个应用: {:?}",
            apps.len(),
            apps.iter().map(|a| a.id).collect::<Vec<_>>()
        );
        *slot = Some(apps);
    }
    slot.as_ref().cloned().unwrap_or_default()
}

/// 只重解析一条（"启动时发现可执行文件没了" → 立刻自愈，DSH 同样只在卸载方向自愈）。
fn refresh_one(id: &str) -> Option<Resolved> {
    let facts = Facts::detect();
    let real = RealHost::new(facts.clone());
    let fresh = resolver::resolve_one(&real, &facts, id, PROBE_TIMEOUT);
    let mut slot = cache().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(apps) = slot.as_mut() {
        apps.retain(|a| a.id != id);
        if let Some(r) = fresh.clone() {
            apps.push(r);
            apps.sort_by_key(|a| catalog_position(a.id));
        }
    }
    fresh
}

fn catalog_position(id: &str) -> usize {
    catalog::CATALOG.iter().position(|a| a.id == id).unwrap_or(usize::MAX)
}

/* ------------------------------- 命令层 ------------------------------- */

/// 本机装了哪些可打开的应用（目录顺序 = 菜单顺序）。
///
/// 返回的 id 是**前端词典的键**：前端只渲染它能命名的 id，
/// 宿主多出来的 id 会被静默忽略（DSH 同款行为，避免菜单里出现裸 id）。
#[tauri::command(async)]
pub fn open_in_app_list() -> Vec<String> {
    resolved_apps().iter().map(|a| a.id.to_string()).collect()
}

/// 某个应用的图标（`data:` URL）。拿不到 → None（前端画通用图标，不是报错）。
#[tauri::command(async)]
pub fn open_in_app_icon(id: String) -> Option<String> {
    if let Some(hit) = icon_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
    {
        return hit.clone();
    }
    let value = load_icon(&id);
    icon_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id, value.clone());
    value
}

fn load_icon(id: &str) -> Option<String> {
    let app = resolved_apps().into_iter().find(|a| a.id == id)?;
    let source = app.icon?;
    let facts = Facts::detect();
    let real = RealHost::new(facts.clone());
    let bytes = icons::icon_png(&real, &facts, &source, ICON_TIMEOUT)?;
    let mime = icons::media_type(&bytes);
    Some(format!("data:{mime};base64,{}", base64(&bytes)))
}

/// 在一个已安装的应用里打开一个目录。
#[tauri::command(async)]
pub fn open_in_app_open(id: String, path: String) -> Result<(), String> {
    let dir = validate_directory(&path)?;
    let dir = dir.to_string_lossy().into_owned();
    // **不重新探测**：只用已解析出来的启动器（DSH 的 open 路由同样从不重新检测）
    let Some(app) = resolved_apps().into_iter().find(|a| a.id == id) else {
        return Err(format!("这个应用不可用（未安装或无法启动）: {id}"));
    };
    match launch_entry(&app, &dir) {
        LaunchOutcome::Launched => Ok(()),
        LaunchOutcome::Missing => {
            // 启动器不见了 = 这份解析过期（用户刚卸载）→ 重解析这一条再报错
            let gone = refresh_one(app.id).is_none();
            Err(if gone {
                format!("{} 已经不在这台机器上了（列表已刷新）", app.id)
            } else {
                format!("{} 的启动器失效了，请再试一次", app.id)
            })
        }
        LaunchOutcome::Failed(msg) => Err(format!("打开失败：{msg}")),
    }
}

/// 启动一个已解析的应用，主启动方式失败时走回退（目前只有 macOS 的 Xcode：`xed` → `open -a`）。
pub fn launch_entry(app: &Resolved, dir: &str) -> LaunchOutcome {
    let facts = Facts::detect();
    let primary = host::launch_detached(&app.launch, dir, LAUNCH_WATCH, &facts.env);
    if primary == LaunchOutcome::Launched || app.fallback.is_none() {
        return primary;
    }
    let fallback = host::launch_detached(
        app.fallback.as_ref().expect("刚判过"),
        dir,
        LAUNCH_WATCH,
        &facts.env,
    );
    if fallback == LaunchOutcome::Launched {
        return LaunchOutcome::Launched;
    }
    // 两个启动器里任何一个"不见了"都值得重解析
    if primary == LaunchOutcome::Missing || fallback == LaunchOutcome::Missing {
        LaunchOutcome::Missing
    } else {
        fallback
    }
}

/// 目录校验：必须是**已存在的绝对目录**（相对路径、文件、不存在的路径一律拒绝）。
///
/// 这一条与 DSH open 路由的请求校验对齐（绝对路径 + 存在的目录），
/// 也是"这个命令不是任意命令执行入口"的一半理由（另一半是：命令来自白名单解析）。
pub fn validate_directory(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("目录为空".into());
    }
    if trimmed.contains('\0') {
        return Err("目录含非法字符".into());
    }
    let p = PathBuf::from(trimmed);
    if !p.is_absolute() {
        return Err(format!("不是绝对路径: {trimmed}"));
    }
    if !p.is_dir() {
        return Err(format!("目录不存在: {trimmed}"));
    }
    Ok(p)
}

/// 标准 base64（不引依赖：只有这一个用途，且必须有测试锁住字母表与填充）。
pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = u32::from(b[0]) << 16 | u32::from(b[1]) << 8 | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// 前端拿到的启动方式描述（`ui:debug` / 排障用；不含目录）。
pub fn describe_launch(app: &Resolved) -> String {
    match &app.launch {
        LaunchSpec::ShellOpen => format!("{} → 系统文件管理器", app.id),
        LaunchSpec::Argv { command, .. } => format!("{} → {command}", app.id),
    }
}

/// 供 IPC 契约测试用：本机解析结果的一行行描述。
pub fn describe_all() -> Vec<String> {
    resolved_apps().iter().map(describe_launch).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_rfc4648_vectors() {
        // RFC 4648 §10 的官方测试向量：字母表/填充写错都会在这里断
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foob"), "Zm9vYg==");
        assert_eq!(base64(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        // 非 ASCII 字节也要按字节编码（PNG magic 的前几个字节）
        assert_eq!(base64(&[0x89, 0x50, 0x4e, 0x47]), "iVBORw==");
    }

    #[test]
    fn directory_validation_rejects_everything_but_a_real_absolute_dir() {
        assert!(validate_directory("/tmp").is_ok());
        assert!(validate_directory("").is_err());
        assert!(validate_directory("   ").is_err());
        assert!(validate_directory("relative/dir").is_err());
        assert!(validate_directory("/definitely/not/here/piggy").is_err());
        // 文件不是目录
        assert!(validate_directory("/etc/hosts").is_err());
        // NUL 注入
        assert!(validate_directory("/tmp\0/x").is_err());
    }

    #[test]
    fn catalog_position_is_stable_and_unknown_goes_last() {
        assert_eq!(catalog_position("finder"), 0);
        assert!(catalog_position("vscode") < catalog_position("iterm"));
        assert_eq!(catalog_position("nope"), usize::MAX);
    }

    /// SSH 启动下 `list` 必须是空的 —— 前端据此**不渲染按钮**（DSH 同款）。
    #[test]
    fn ssh_facts_produce_an_empty_catalog() {
        let mut facts = Facts::detect();
        facts.ssh = true;
        let real = RealHost::new(facts.clone());
        assert!(resolver::resolve_all(&real, &facts, PROBE_TIMEOUT).is_empty());
    }

    /// 真机：解析一次 → 描述非空；再解析一次 → 结果稳定（缓存的前提）。
    #[test]
    fn resolved_apps_are_stable_across_calls() {
        let first = resolved_apps();
        let second = resolved_apps();
        assert_eq!(first, second, "两次解析结果不一致（缓存/解析有随机性）");
        assert_eq!(describe_all().len(), first.len());
        for line in describe_all() {
            assert!(!line.is_empty());
        }
    }

    /// `open_in_app_open` 的**校验顺序**：目录不合法时必须在"应用不可用"之前就拦下。
    #[test]
    fn open_validates_the_directory_first() {
        // 应用不存在 + 目录不存在 → 报目录的错（说明先校验目录）
        let err = open_in_app_open("nope".into(), "/definitely/not/here".into()).unwrap_err();
        assert!(err.contains("目录不存在"), "{err}");
    }

    #[test]
    fn open_rejects_unknown_app_ids_even_with_a_valid_directory() {
        let err = open_in_app_open("nope".into(), "/tmp".into()).unwrap_err();
        assert!(err.contains("不可用"), "{err}");
    }
}
