//! pi 二进制定位与版本门禁（docs/02 §2.1、03 §2.1、17 §2）。
//!
//! ## 三种来源
//! | 来源 | 取值 | 典型场景 |
//! |------|------|----------|
//! | `system`（**默认**） | PATH → 常见安装位置 → 捆绑兜底 | 本机已装 pi，跟着 `pi update` 走 |
//! | `bundled` | 应用包里的 `resources/pi/pi` | 用打包进来的自定义 pi |
//! | `custom` | 用户指定的绝对路径 | fork 出来的 pi，放在任意位置 |
//!
//! `PI_BIN` 环境变量**永远优先于以上三者**：它是运维/CI 的显式指令，
//! 不该被界面上的默认值覆盖（也正因如此，界面上会显示实际生效的那一个）。
//!
//! 历史：这里原本是「显式路径 → PI_BIN → 内置 → PATH」，即**捆绑的 pi 优先于系统 pi**，
//! 且所有调用点都把显式路径传 `None`（docs/02 承诺的 `piPath` 设置项从未实现）。
//! 2026-09-23 改为按来源选择，默认系统 pi。

use std::path::{Path, PathBuf};
use std::process::Command;

/// pi 二进制来源（持久化在 `~/.piggy/config.json`）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PiSource {
    /// 系统安装的 pi（默认）
    #[default]
    System,
    /// 应用包内捆绑的 pi（自定义构建走这条打包）
    Bundled,
    /// 用户指定的路径
    Custom,
}

impl PiSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Bundled => "bundled",
            Self::Custom => "custom",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::System => "系统 pi",
            Self::Bundled => "捆绑 pi",
            Self::Custom => "自定义路径",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim() {
            "system" => Ok(Self::System),
            "bundled" => Ok(Self::Bundled),
            "custom" => Ok(Self::Custom),
            other => Err(format!(
                "未知 pi 来源 {other:?}（可选：system / bundled / custom）"
            )),
        }
    }
}

/// 跨 IPC 的形状一律 camelCase（前端读的是 `fromEnv`）。
///
/// ⚠️ 这里曾经漏了 `rename_all`，于是 Rust 发 `from_env`、前端读 `fromEnv`、
/// 两边都不报错 —— 「被环境变量 PI_BIN 覆盖」那条警告**从来没显示过**。
/// 同类事故见 `sessions/title.rs::Generated`（会把 `NaN` 渲染给用户）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiBinary {
    pub path: PathBuf,
    pub version: String,
    /// 实际生效的来源（可能是回退后的结果，不等于用户设置）
    pub source: PiSource,
    /// 一句话说明是怎么找到的，直接显示给用户
    pub via: String,
    /// `PI_BIN` 覆盖是否生效（界面据此提示"设置被环境变量覆盖"）
    pub from_env: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error(
        "pi 二进制未找到。可选：在设置里指定路径、安装 pi 到 PATH，或选「捆绑 pi」（需 full SKU 打包）"
    )]
    NotFound,
    #[error("指定的 pi 路径不存在: {0}")]
    CustomPathMissing(String),
    #[error("应用未捆绑 pi（lite SKU）。请改用「系统 pi」或换 full SKU 构建")]
    BuiltinMissing,
    #[error("pi --version 失败: {0}")]
    VersionCheckFailed(String),
}

/// 按来源挑选候选路径。**纯函数**——把「系统查到什么」「内置有没有」当参数传进来，
/// 因此来源矩阵与回退行为可以脱离环境（PATH/HOME/文件系统）穷举测试。
///
/// 返回 `(路径, 实际来源, 说明)`；实际来源可能与请求的不同（system 回退到 bundled）。
pub(crate) fn pick_source(
    source: PiSource,
    custom: Option<&Path>,
    builtin: Option<&Path>,
    system: Option<PathBuf>,
) -> Result<(PathBuf, PiSource, String), DiscoveryError> {
    let builtin_ok = builtin.filter(|b| b.is_file());
    match source {
        PiSource::Custom => {
            let p = custom
                .ok_or_else(|| DiscoveryError::CustomPathMissing("（未填写路径）".to_string()))?;
            if !p.is_file() {
                return Err(DiscoveryError::CustomPathMissing(p.display().to_string()));
            }
            Ok((p.to_path_buf(), PiSource::Custom, "设置中指定的路径".to_string()))
        }
        PiSource::Bundled => {
            let b = builtin_ok.ok_or(DiscoveryError::BuiltinMissing)?;
            Ok((b.to_path_buf(), PiSource::Bundled, "应用内捆绑".to_string()))
        }
        PiSource::System => match system {
            Some(p) => Ok((p, PiSource::System, "系统安装".to_string())),
            // 系统没装：若这个包自带 pi 就用它，而不是直接失败——
            // 默认值仍是「系统 pi」，但用户机器上没装时不该整个用不了。
            None => match builtin_ok {
                Some(b) => Ok((
                    b.to_path_buf(),
                    PiSource::Bundled,
                    "系统未找到 pi，回退到应用内捆绑".to_string(),
                )),
                None => Err(DiscoveryError::NotFound),
            },
        },
    }
}

/// 按来源定位 pi 并校验 `--version`。
pub fn discover(
    source: PiSource,
    custom: Option<&Path>,
    builtin: Option<&Path>,
) -> Result<PiBinary, DiscoveryError> {
    // 1) PI_BIN：显式环境覆盖，永远优先
    if let Some(p) = std::env::var_os("PI_BIN").map(PathBuf::from) {
        if p.is_file() {
            return verify(p, PiSource::Custom, "环境变量 PI_BIN".to_string(), true);
        }
        return Err(DiscoveryError::CustomPathMissing(p.display().to_string()));
    }

    // 2) 按用户选定的来源（system 档才需要真的去查系统）
    let system = match source {
        PiSource::System => which_pi(),
        _ => None,
    };
    let (path, resolved, via) = pick_source(source, custom, builtin, system)?;
    let via = if resolved == PiSource::System && !is_on_path(&path) {
        "常见安装位置".to_string()
    } else {
        via
    };
    verify(path, resolved, via, false)
}

fn verify(
    path: PathBuf,
    source: PiSource,
    via: String,
    from_env: bool,
) -> Result<PiBinary, DiscoveryError> {
    if !path.is_file() {
        return Err(DiscoveryError::CustomPathMissing(path.display().to_string()));
    }
    let out = Command::new(&path)
        .arg("--version")
        .output()
        .map_err(|e| DiscoveryError::VersionCheckFailed(e.to_string()))?;
    if !out.status.success() {
        return Err(DiscoveryError::VersionCheckFailed(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(PiBinary { path, version, source, via, from_env })
}

/// 该路径是否来自 PATH（仅用于给用户一句可读的说明）。
fn is_on_path(p: &Path) -> bool {
    let Some(dirs) = std::env::var_os("PATH") else { return false };
    let Some(parent) = p.parent() else { return false };
    std::env::split_paths(&dirs).any(|d| d == parent)
}

/// 可执行文件名的候选，**按优先级**。
///
/// ## 为什么不能只写 `["pi", "pi.exe", "pi.cmd"]`（Windows 上真实踩到的 bug）
///
/// npm / pnpm 在 Windows 的 bin 目录里**同时**放两份东西：
///   * `pi`      —— 给 Git Bash / MSYS 用的 **POSIX shell 脚本**；
///   * `pi.cmd`  —— 给 cmd/PowerShell 用的批处理垫片（`pi.exe` 则出现在 standalone 版）。
///
/// 老代码先试无扩展名的 `pi`，`is_file()` 为真就返回它，然后把这个绝对路径交给
/// `CreateProcess`——**绝对路径 Rust 不会再补 `.exe`**（见 std::process::Command 的平台说明：
/// 只有"不带扩展名的可执行文件"会补 .exe，而这里给的是一个真实存在的文件），
/// 于是 Windows 报 `os error 193（不是有效的 Win32 应用程序）`，
/// 整个发现流程失败，界面上就是"pi 未找到——可 pi 明明在 PATH 里"。
///
/// 规则：**Windows 上按 `PATHEXT` 生成候选（默认 .COM;.EXE;.BAT;.CMD），无扩展名的 `pi`
/// 排在最后**，且只在它真的是个 PE（`MZ` 头）时才接受（见 [`first_pi_in`]）。
/// 这样 shell 垫片永远不会被交给 `CreateProcess`，而"有人把 pi.exe 改名成 pi"的
/// 极端情况仍然能用。
pub fn exec_names(windows: bool, pathext: Option<&str>) -> Vec<String> {
    if !windows {
        return vec!["pi".to_string()];
    }
    const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";
    let raw = pathext.filter(|s| !s.trim().is_empty()).unwrap_or(DEFAULT_PATHEXT);
    let mut out: Vec<String> = Vec::new();
    for ext in raw.split(';') {
        // PATHEXT 里通常写 ".EXE"，也有人写 "*.EXE"；统一成小写、去掉通配符
        let ext = ext.trim().trim_start_matches('*').to_ascii_lowercase();
        if ext.is_empty() {
            continue;
        }
        let name = format!("pi{ext}");
        if !out.contains(&name) {
            out.push(name);
        }
    }
    // 最后再考虑无扩展名（只可能是"改名过的 PE"或不可执行的垫片，由调用方验内容）
    out.push("pi".to_string());
    out
}

/// 这个文件看起来是不是 Windows 可执行文件（PE：`MZ` 头）。
///
/// 只是个**便宜的筛子**，不是完整校验——真正的校验是后面跑 `--version`。
/// 用途：拒绝把 npm/pnpm 的 POSIX shell 垫片交给 `CreateProcess`。
fn looks_like_pe(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else { return false };
    let mut magic = [0u8; 2];
    f.read_exact(&mut magic).is_ok() && &magic == b"MZ"
}

/// 在单个目录里按候选名找 pi。
///
/// `windows=true` 时，**无扩展名**的候选额外要求"真的是 PE"（理由见 [`exec_names`]）。
fn first_pi_in(dir: &Path, names: &[String], windows: bool) -> Option<PathBuf> {
    for name in names {
        let cand = dir.join(name);
        if !cand.is_file() {
            continue;
        }
        if windows && name == "pi" && !looks_like_pe(&cand) {
            // 这是那个 shell 垫片：跳过，继续看后面的目录/候选
            continue;
        }
        return Some(cand);
    }
    None
}

/// PATH 扫描 → 常见安装位置兜底。都没有返回 `None`。
fn which_pi() -> Option<PathBuf> {
    let windows = cfg!(windows);
    let names = exec_names(windows, std::env::var("PATHEXT").ok().as_deref());
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if let Some(p) = first_pi_in(&dir, &names, windows) {
                return Some(p);
            }
        }
    }
    // PATH 未命中（GUI 启动时 PATH 极简，或 Windows 上只装了垫片）：探测常见安装位置
    let env = WellKnownEnv::from_process();
    well_known_candidates(&env, windows, &names)
        .into_iter()
        .find(|c| c.is_file() && !(windows && c.file_name().is_some_and(|n| n == "pi") && !looks_like_pe(c)))
}

/// 探测常见安装位置需要的环境（结构体是为了**可测**：不依赖真实环境变量）。
pub struct WellKnownEnv {
    pub home: Option<PathBuf>,
    pub appdata: Option<PathBuf>,
    pub localappdata: Option<PathBuf>,
}

impl WellKnownEnv {
    fn from_process() -> Self {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
        Self {
            // 主目录口径与 pi 目录、Piggy 配置目录统一（config::paths）：
            // Windows 上 USERPROFILE 优先，再兜 HOMEDRIVE+HOMEPATH。
            home: crate::config::paths::home_dir(),
            appdata: var("APPDATA"),
            localappdata: var("LOCALAPPDATA"),
        }
    }
}

/// 常见安装位置（pi.dev 安装脚本 / pnpm / npm / cargo 风格目录）。
///
/// Windows 与 Unix 的目录**完全不同**：老代码只列了 Unix 路径，于是 Windows 上
/// PATH 未命中时这里必然返回 `None`（连试都没试）。
pub fn well_known_candidates(env: &WellKnownEnv, windows: bool, names: &[String]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if windows {
        // pnpm 的全局 bin（Windows 上是 %LOCALAPPDATA%\pnpm）、npm 的前缀、安装脚本目录
        if let Some(d) = &env.localappdata {
            dirs.push(d.join("pnpm"));
        }
        if let Some(d) = &env.appdata {
            dirs.push(d.join("npm"));
        }
        if let Some(h) = &env.home {
            dirs.push(h.join(".local").join("bin"));
            dirs.push(h.join("scoop").join("shims"));
        }
    } else {
        if let Some(h) = &env.home {
            dirs.push(h.join(".local").join("bin"));
            dirs.push(h.join("Library").join("pnpm").join("bin"));
            dirs.push(h.join(".cargo").join("bin"));
        }
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    let mut out = Vec::new();
    for dir in dirs {
        for name in names {
            out.push(dir.join(name));
        }
    }
    out
}

/// 计算 pi 来源的变更计划。
///
/// **纯函数**：只做校验与规整，不碰磁盘、不碰 registry、不解析二进制
/// （"能不能解析"由调用方在落盘**之前**用 `discover` 验证）。
///
/// 返回 `Ok(None)` = 没有变更；`Ok(Some((来源, 路径)))` = 有变更。
///
/// 这里拦住的是本项目真实踩过的坑：允许 `custom` 且路径为空会被写进 config.json，
/// 结果是**每次建会话都失败**（"指定的 pi 路径不存在: （未填写路径）"），
/// 而界面上因为命令报错、没走到 reload，看起来像"点了没反应"。
pub fn plan_source_change(
    current: PiSource,
    current_path: Option<&str>,
    requested_source: Option<&str>,
    requested_path: Option<&str>,
) -> Result<Option<(PiSource, Option<String>)>, String> {
    let next_source = match requested_source.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => PiSource::parse(s)?,
        None => current,
    };
    let next_path = match requested_path {
        // 显式传空串 = 清空
        Some(p) => {
            let t = p.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        None => current_path.map(str::to_string),
    };

    // 关键守卫：custom 必须有路径
    if next_source == PiSource::Custom && next_path.is_none() {
        return Err(
            "选择「自定义路径」需要先指定 pi 可执行文件；配置未改动（仍用原来的来源）".to_string(),
        );
    }
    if next_source == current && next_path.as_deref() == current_path {
        return Ok(None);
    }
    Ok(Some((next_source, next_path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_round_trips() {
        for s in [PiSource::System, PiSource::Bundled, PiSource::Custom] {
            let json = serde_json::to_string(&s).unwrap();
            assert_eq!(json, format!("\"{}\"", s.as_str()));
            assert_eq!(serde_json::from_str::<PiSource>(&json).unwrap(), s);
            assert_eq!(PiSource::parse(s.as_str()).unwrap(), s);
        }
        assert!(PiSource::parse("python").is_err());
    }

    #[test]
    fn no_change_returns_none() {
        assert!(plan_source_change(PiSource::System, None, Some("system"), None)
            .unwrap()
            .is_none());
        assert!(
            plan_source_change(PiSource::Custom, Some("/a/pi"), Some("custom"), None)
                .unwrap()
                .is_none()
        );
    }

    /// 这是本次的 bug：custom + 空路径曾被允许写盘，导致建会话全失败。
    #[test]
    fn custom_without_path_is_rejected() {
        let e = plan_source_change(PiSource::System, None, Some("custom"), None).unwrap_err();
        assert!(e.contains("自定义路径"), "{e}");

        // 显式传空串同样拒绝
        let e2 = plan_source_change(PiSource::System, None, Some("custom"), Some("  ")).unwrap_err();
        assert!(e2.contains("自定义路径"), "{e2}");

        // 已有 custom 路径时，清空它也要拒绝（否则同样落到"无路径的 custom"）
        let e3 = plan_source_change(PiSource::Custom, Some("/a/pi"), Some("custom"), Some(""))
            .unwrap_err();
        assert!(e3.contains("自定义路径"), "{e3}");
    }

    #[test]
    fn custom_with_path_is_accepted() {
        let plan = plan_source_change(PiSource::System, None, Some("custom"), Some(" /x/pi "))
            .unwrap()
            .expect("应产生变更");
        assert_eq!(plan.0, PiSource::Custom);
        assert_eq!(plan.1.as_deref(), Some("/x/pi"), "路径应被 trim");
    }

    /// 只改配置里的其他字段（不传来源）时不该产生 pi 变更。
    #[test]
    fn omitted_source_keeps_current() {
        assert!(plan_source_change(PiSource::Bundled, Some("/b/pi"), None, None)
            .unwrap()
            .is_none());
    }

    /// 从坏状态（custom 无路径）切回 system 必须可行——这是修复路径。
    #[test]
    fn switching_away_from_broken_custom_repairs_it() {
        let plan = plan_source_change(PiSource::Custom, None, Some("system"), None)
            .unwrap()
            .expect("应产生变更");
        assert_eq!(plan.0, PiSource::System);
        assert_eq!(plan.1, None);
    }

    #[test]
    fn unknown_source_is_rejected() {
        assert!(plan_source_change(PiSource::System, None, Some("python"), None).is_err());
    }

    /// 默认必须是系统 pi —— 这是明确的产品要求（打包用自定义 pi，但默认不劫持用户已有的安装）。
    #[test]
    fn default_source_is_system() {
        assert_eq!(PiSource::default(), PiSource::System);
    }

    /// 缺失配置时给出可操作的错误，而不是一句 not found。
    #[test]
    fn custom_without_path_is_actionable() {
        let e = discover(PiSource::Custom, None, None).unwrap_err();
        assert!(matches!(e, DiscoveryError::CustomPathMissing(_)), "got {e:?}");
    }

    #[test]
    fn custom_with_missing_path_reports_the_path() {
        let e = discover(PiSource::Custom, Some(Path::new("/nope/pi")), None).unwrap_err();
        assert!(e.to_string().contains("/nope/pi"), "错误里应带上路径: {e}");
    }

    /// bundled 档在 lite SKU（没有内置二进制）下必须明确说"这个包没捆绑"，
    /// 而不是含糊的未找到。
    #[test]
    fn bundled_without_builtin_says_so() {
        let e = discover(PiSource::Bundled, None, None).unwrap_err();
        assert!(matches!(e, DiscoveryError::BuiltinMissing), "got {e:?}");
    }

    /* ---- Windows 上的 pi 发现（用户真机踩到的 os error 193） ----
       全部是纯函数/文件系统夹具，所以在 macOS 上也能跑：
       被验证的是"**选哪个名字**"，而不是"能不能执行"。 */

    fn names_of(v: Vec<String>) -> Vec<String> {
        v
    }

    #[test]
    fn exec_names_unix_is_just_pi() {
        assert_eq!(exec_names(false, None), vec!["pi"]);
        // Unix 上 PATHEXT 无关
        assert_eq!(exec_names(false, Some(".EXE")), vec!["pi"]);
    }

    #[test]
    fn exec_names_windows_follows_pathext_and_puts_bare_pi_last() {
        let n = exec_names(true, None);
        assert_eq!(names_of(n), vec!["pi.com", "pi.exe", "pi.bat", "pi.cmd", "pi"]);
        // 无扩展名必须是**最后一个**候选：npm/pnpm 的 shell 垫片就叫 `pi`
        assert_eq!(names_of(exec_names(true, None)).last().unwrap(), "pi");
        // 自定义 PATHEXT：大小写与 `*.EXE` 写法都要认，且要按用户给的环境变量顺序
        assert_eq!(
            names_of(exec_names(true, Some("*.EXE;.CMD"))),
            vec!["pi.exe", "pi.cmd", "pi"]
        );
        assert_eq!(names_of(exec_names(true, Some(""))), names_of(exec_names(true, None)));
        // 去重
        assert_eq!(names_of(exec_names(true, Some(".CMD;.CMD"))), vec!["pi.cmd", "pi"]);
    }

    /// **这是那个 bug 的回归测试**：同一个目录里既有 shell 垫片 `pi` 又有 `pi.cmd`，
    /// Windows 语义下必须选 `pi.cmd`；老代码会选 `pi` → `os error 193`。
    #[test]
    fn windows_prefers_the_cmd_shim_over_the_posix_shell_script() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("pi"), "#!/bin/sh\nexec node \"$0/../pi.js\" \"$@\"\n").unwrap();
        std::fs::write(dir.join("pi.cmd"), "@echo off\r\nnode \"%~dp0\\pi.js\" %*\r\n").unwrap();

        let names = exec_names(true, None);
        let picked = first_pi_in(dir, &names, true).expect("应该选中 pi.cmd");
        assert_eq!(picked.file_name().unwrap(), "pi.cmd", "选中了 shell 垫片 → Windows 会报 os error 193");

        // Unix 语义下同一个目录选 `pi`（那边它才是对的）
        let picked_unix = first_pi_in(dir, &exec_names(false, None), false).unwrap();
        assert_eq!(picked_unix.file_name().unwrap(), "pi");
    }

    /// 只有 shell 垫片时**宁可报"未找到"**，也不要把脚本交给 CreateProcess
    /// （用户看到的 `%1 不是有效的 Win32 应用程序` 就是这么来的）。
    #[test]
    fn windows_ignores_a_lone_posix_shim() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("pi"), "#!/bin/sh\npi \"$@\"\n").unwrap();
        assert_eq!(first_pi_in(tmp.path(), &exec_names(true, None), true), None);

        // 但它要是真的 PE（有人把 pi.exe 改名成 pi），仍然接受
        std::fs::write(tmp.path().join("pi"), b"MZ\x90\x00fake-pe").unwrap();
        let picked = first_pi_in(tmp.path(), &exec_names(true, None), true).unwrap();
        assert_eq!(picked.file_name().unwrap(), "pi");
    }

    #[test]
    fn windows_well_known_dirs_are_windows_dirs() {
        let env = WellKnownEnv {
            home: Some(PathBuf::from(r"C:\Users\wxk")),
            appdata: Some(PathBuf::from(r"C:\Users\wxk\AppData\Roaming")),
            localappdata: Some(PathBuf::from(r"C:\Users\wxk\AppData\Local")),
        };
        let names = exec_names(true, None);
        let cands = well_known_candidates(&env, true, &names);
        let shown: Vec<String> = cands.iter().map(|c| c.display().to_string()).collect();
        // pnpm 的全局 bin 与 npm 的前缀（Windows 上真正放 pi.cmd 的地方）
        assert!(
            shown.iter().any(|c| c.contains("AppData\\Local") && c.contains("pnpm") && c.ends_with("pi.cmd")),
            "没有 pnpm 目录：{shown:?}"
        );
        assert!(
            shown.iter().any(|c| c.contains("AppData\\Roaming") && c.contains("npm")),
            "没有 npm 目录：{shown:?}"
        );
        // 不能把 Unix 路径混进来
        assert!(!shown.iter().any(|c| c.contains("/usr/local/bin")), "{shown:?}");

        // Unix 侧保持原样（含 Homebrew 与 pnpm 的 macOS 路径）
        let unix_env = WellKnownEnv {
            home: Some(PathBuf::from("/Users/wxk")),
            appdata: None,
            localappdata: None,
        };
        let unix: Vec<String> = well_known_candidates(&unix_env, false, &exec_names(false, None))
            .iter()
            .map(|c| c.display().to_string())
            .collect();
        for want in [
            "/Users/wxk/.local/bin/pi",
            "/usr/local/bin/pi",
            "/opt/homebrew/bin/pi",
            "/Users/wxk/Library/pnpm/bin/pi",
            "/Users/wxk/.cargo/bin/pi",
        ] {
            assert!(unix.contains(&want.to_string()), "缺 {want}：{unix:?}");
        }
    }

    /* ---- 来源矩阵（纯函数，脱离 PATH/HOME/文件系统） ---- */

    fn tmpfile(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join("piggy-discovery-test");
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        std::fs::write(&p, b"x").unwrap();
        p
    }

    /// 选了 system：即使包内也有 pi，也必须用系统的。
    /// 这是明确的产品要求——打包捆绑自定义 pi，但默认不劫持用户已有的安装。
    #[test]
    fn system_wins_over_bundled_when_both_exist() {
        let sys = tmpfile("sys-pi");
        let builtin = tmpfile("builtin-pi");
        let (path, src, _) =
            pick_source(PiSource::System, None, Some(&builtin), Some(sys.clone())).unwrap();
        assert_eq!(path, sys);
        assert_eq!(src, PiSource::System);
    }

    /// 选了 system 但系统没装：回退到捆绑，并如实报告来源变成了 bundled。
    #[test]
    fn system_falls_back_to_bundled_when_absent() {
        let builtin = tmpfile("builtin-pi");
        let (path, src, via) = pick_source(PiSource::System, None, Some(&builtin), None).unwrap();
        assert_eq!(path, builtin);
        assert_eq!(src, PiSource::Bundled, "回退后来源必须如实反映，不能仍报 system");
        assert!(via.contains("回退"), "说明里要写清是回退来的: {via}");
    }

    /// 两边都没有：报 NotFound（可操作的提示在 Display 里）。
    #[test]
    fn system_with_nothing_available_is_not_found() {
        assert!(matches!(
            pick_source(PiSource::System, None, None, None),
            Err(DiscoveryError::NotFound)
        ));
    }

    /// 选了 bundled：即使系统有 pi，也不能用系统的。
    #[test]
    fn bundled_ignores_the_system_binary() {
        let sys = tmpfile("sys-pi");
        let builtin = tmpfile("builtin-pi");
        let (path, src, _) =
            pick_source(PiSource::Bundled, None, Some(&builtin), Some(sys)).unwrap();
        assert_eq!(path, builtin);
        assert_eq!(src, PiSource::Bundled);
    }

    /// bundled 档但包内没有（lite SKU）：报 BuiltinMissing，且不该退到系统 pi——
    /// 用户明确要的是打包进来的那个，静默换成另一个更糟。
    #[test]
    fn bundled_does_not_silently_fall_back_to_system() {
        let sys = tmpfile("sys-pi");
        let e = pick_source(PiSource::Bundled, None, None, Some(sys)).unwrap_err();
        assert!(matches!(e, DiscoveryError::BuiltinMissing), "got {e:?}");
    }

    /// custom 档：路径存在就用它，且优先于 bundled / system。
    #[test]
    fn custom_path_wins() {
        let sys = tmpfile("sys-pi");
        let builtin = tmpfile("builtin-pi");
        let mine = tmpfile("mine-pi");
        let (path, src, _) = pick_source(
            PiSource::Custom,
            Some(&mine),
            Some(&builtin),
            Some(sys),
        )
        .unwrap();
        assert_eq!(path, mine);
        assert_eq!(src, PiSource::Custom);
    }

    /// custom 档未填路径 / 路径不存在：都要报出可操作的信息，而不是回退到别的二进制。
    #[test]
    fn custom_never_falls_back() {
        let sys = tmpfile("sys-pi");
        assert!(matches!(
            pick_source(PiSource::Custom, None, None, Some(sys.clone())),
            Err(DiscoveryError::CustomPathMissing(_))
        ));
        assert!(matches!(
            pick_source(PiSource::Custom, Some(Path::new("/nope/pi")), None, Some(sys)),
            Err(DiscoveryError::CustomPathMissing(_))
        ));
    }
}
