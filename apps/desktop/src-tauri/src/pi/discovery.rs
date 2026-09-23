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

#[derive(Debug, Clone, serde::Serialize)]
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

/// PATH 扫描 → 常见安装位置兜底。都没有返回 `None`。
fn which_pi() -> Option<PathBuf> {
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            for name in ["pi", "pi.exe", "pi.cmd"] {
                let cand = dir.join(name);
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    // PATH 未命中（GUI 从 Finder 启动时 PATH 极简）：探测常见安装位置
    probe_well_known()
}

/// 常见安装位置（pi.dev 安装脚本 / pnpm / cargo 风格目录）。
fn probe_well_known() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let candidates = [
        home.join(".local/bin/pi"),
        PathBuf::from("/usr/local/bin/pi"),
        PathBuf::from("/opt/homebrew/bin/pi"),
        home.join("Library/pnpm/bin/pi"),
        home.join(".cargo/bin/pi"),
    ];
    candidates.into_iter().find(|c| c.is_file())
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
