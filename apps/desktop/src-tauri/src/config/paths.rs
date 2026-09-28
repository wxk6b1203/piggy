//! 用户主目录与 pi 目录的**唯一**解析口径（docs/03 §2.18）。
//!
//! **为什么单独一个模块**：Windows 默认不设 `HOME`（只有 Git Bash/MSYS 会设），
//! 而老代码一律 `var_os("HOME")`，于是在 Windows 上：
//!
//! 1. 主目录解析成**空路径** → `join(".pi/agent")` 退化成**相对路径** `.pi/agent`
//!    （用户报的"默认地址变成 `.pi/agent\sessions`"）；
//! 2. `tab_create` 的 HOME 回退拿不到目录 → 「无法确定 cwd」；
//! 3. `~/.piggy/` 的 layout/config/panic 日志落到**进程 cwd**（设置存不下来）；
//! 4. `fs_preview_read` 的 `starts_with("")` 恒为真 → **预览沙箱形同虚设**。
//!
//! pi 自己用的是 Node 的 `os.homedir()`（`config.ts:529-534` 的 `getAgentDir()` 调
//! `homedir()`）：Windows 取 `USERPROFILE`（Node 再兜底 `HOMEDRIVE`+`HOMEPATH`），
//! POSIX 取 `HOME`。这里逐条对齐，并把顺序做成**可注入的纯函数**，
//! 好让三条平台链在 macOS 上也能被确定性验证（同 `open_in_app::host` 的思路）。
//!
//! 另一个纪律：跨平台的路径**只准用 `Path::join` 拼**，字面量里不许写分隔符
//! （`join(".pi/agent")` 在 Windows 上会拼出 `.pi/agent` 这种半反斜杠半正斜杠的
//! 混合路径）。这条由 `tests/path_separators.rs` 静态守住。

use std::path::{Path, PathBuf};

/// pi 的配置目录名（`package.json` 的 `piConfig.configDir`，默认 `.pi`）。
const CONFIG_DIR: &str = ".pi";
/// pi 的 agent 目录名（`getAgentDir()` = `<home>/.pi/agent`）。
const AGENT_SUBDIR: &str = "agent";
/// pi 的 agent 目录环境变量（`config.ts:507-508`：`${APP_NAME}_CODING_AGENT_DIR`）。
pub const ENV_AGENT_DIR: &str = "PI_CODING_AGENT_DIR";

/// 环境变量取值：空串/纯空白视为**未设置**（Windows 上 `set USERPROFILE=` 这类残留
/// 与"没设"必须同义，否则又会拼出相对路径）。
fn var_or_none(var: &dyn Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    match var(key) {
        Some(v) if !v.trim().is_empty() => Some(v),
        _ => None,
    }
}

/// `HOMEDRIVE` + `HOMEPATH` 直接拼接（Node `os.homedir()` 的 Windows 兜底形状：
/// `C:` + `\Users\x`）。
fn drive_home(var: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let drive = var_or_none(var, "HOMEDRIVE")?;
    let path = var_or_none(var, "HOMEPATH")?;
    Some(PathBuf::from(format!("{drive}{path}")))
}

/// 主目录解析（纯函数，`var` 注入环境）。
///
/// - Windows：`USERPROFILE` → `HOMEDRIVE`+`HOMEPATH` → `HOME`（Git Bash 兜底）
/// - 其它：`HOME` → `USERPROFILE` → `HOMEDRIVE`+`HOMEPATH`
///
/// Windows 把 `USERPROFILE` 排第一是因为 pi 的 `getAgentDir()` 走 Node `homedir()`，
/// 而 Git Bash 会把 `HOME` 设成 `/c/Users/x` 这种 MSYS 路径；两条口径不一致时，
/// Piggy 必须跟 pi 一致（否则读不到 pi 的 auth.json/settings.json）。
pub fn home_from(windows: bool, var: &dyn Fn(&str) -> Option<String>) -> Option<PathBuf> {
    let (first, second) = if windows {
        ("USERPROFILE", "HOME")
    } else {
        ("HOME", "USERPROFILE")
    };
    var_or_none(var, first)
        .or_else(|| var_or_none(var, second))
        .map(PathBuf::from)
        .or_else(|| drive_home(var))
}

/// 当前进程的主目录（生产入口）。
pub fn home_dir() -> Option<PathBuf> {
    home_from(cfg!(windows), &|k| std::env::var(k).ok())
}

/// 主目录未知时的兜底目录（临时目录，永远存在）。
pub fn home_dir_or_temp() -> PathBuf {
    home_dir().unwrap_or_else(std::env::temp_dir)
}

/// `~` 展开（纯函数版本）。语义照 pi `utils/paths.ts:88-95` 的 `normalizePath`：
/// 只认 `~`、`~/…`，Windows 上额外认 `~\…`。
///
/// 主目录未知时**原样返回**：宁可让后续 `is_dir()` 检查报"目录不存在"，
/// 也不要像老代码那样展开成空路径（空路径会被当成当前目录）。
pub fn expand_home_in(p: &str, home: Option<&Path>, windows: bool) -> PathBuf {
    if p == "~" {
        return home.map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(p));
    }
    let rest = p
        .strip_prefix("~/")
        .or_else(|| if windows { p.strip_prefix("~\\") } else { None });
    match (rest, home) {
        (Some(rest), Some(home)) => home.join(rest),
        _ => PathBuf::from(p),
    }
}

/// 当前进程的 `~` 展开（生产入口）。
pub fn expand_home(p: &str) -> PathBuf {
    let home = home_dir();
    expand_home_in(p, home.as_deref(), cfg!(windows))
}

/// pi 的 agent 目录（纯函数版本）：`PI_CODING_AGENT_DIR` 优先（pi `getAgentDir()`
/// 就是这么做的），否则 `<home>/.pi/agent`。
///
/// 主目录也拿不到时给**相对** `.pi/agent`（与 pi 在同样环境下 `join("", ".pi")`
/// 的结果一致），并打一行警告——静默落到相对路径正是这次 Windows 事故的成因。
pub fn agent_dir_from(windows: bool, var: &dyn Fn(&str) -> Option<String>) -> PathBuf {
    let home = home_from(windows, var);
    if let Some(raw) = var_or_none(var, ENV_AGENT_DIR) {
        return expand_home_in(&raw, home.as_deref(), windows);
    }
    match home {
        Some(h) => h.join(CONFIG_DIR).join(AGENT_SUBDIR),
        None => {
            eprintln!(
                "[piggy] 无法解析用户主目录（HOME / USERPROFILE / HOMEDRIVE+HOMEPATH 均为空），\
                 回退相对路径 {CONFIG_DIR}/{AGENT_SUBDIR}"
            );
            PathBuf::from(CONFIG_DIR).join(AGENT_SUBDIR)
        }
    }
}

/// pi 的 agent 目录（生产入口）。
pub fn agent_dir() -> PathBuf {
    agent_dir_from(cfg!(windows), &|k| std::env::var(k).ok())
}

/// `path` 是否在 `home` 子树内（预览沙箱用）。
///
/// **空 `home` 必须直接拒绝**：`Path::starts_with("")` 恒为 `true`
/// （实测 `Path::new("/etc/passwd").starts_with("") == true`），
/// 老代码在 Windows 上因此对任意文件都放行。
pub fn is_under(home: &Path, path: &Path) -> bool {
    !home.as_os_str().is_empty() && path.starts_with(home)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect();
        move |k: &str| map.get(k).cloned()
    }

    /* ---------------- 主目录查找顺序 ---------------- */

    #[test]
    fn unix_prefers_home() {
        let v = env(&[("HOME", "/Users/u"), ("USERPROFILE", r"C:\Users\u")]);
        assert_eq!(home_from(false, &v), Some(PathBuf::from("/Users/u")));
    }

    #[test]
    fn windows_prefers_userprofile_even_if_home_is_set() {
        // Git Bash 场景：HOME=/c/Users/u（MSYS 路径）但 pi 用的是 USERPROFILE。
        // 这条是本次 Windows 修复的核心：顺序必须跟 pi 的 Node homedir() 一致。
        let v = env(&[("HOME", "/c/Users/u"), ("USERPROFILE", r"C:\Users\u")]);
        assert_eq!(home_from(true, &v), Some(PathBuf::from(r"C:\Users\u")));
    }

    #[test]
    fn windows_without_userprofile_uses_home() {
        let v = env(&[("HOME", r"C:\Users\u")]);
        assert_eq!(home_from(true, &v), Some(PathBuf::from(r"C:\Users\u")));
    }

    #[test]
    fn falls_back_to_drive_plus_path() {
        // Node os.homedir() 的 Windows 兜底：HOMEDRIVE + HOMEPATH 直接拼。
        let v = env(&[("HOMEDRIVE", "C:"), ("HOMEPATH", r"\Users\u")]);
        assert_eq!(home_from(true, &v), Some(PathBuf::from(r"C:\Users\u")));
        assert_eq!(home_from(false, &v), Some(PathBuf::from(r"C:\Users\u")));
    }

    #[test]
    fn empty_values_count_as_unset() {
        // Windows 上 `set USERPROFILE=` 之类的残留：空串必须当"没设"，
        // 否则又会拼出相对路径（就是用户报的那个 bug）。
        let v = env(&[("HOME", ""), ("USERPROFILE", "   ")]);
        assert_eq!(home_from(true, &v), None);
        assert_eq!(home_from(false, &v), None);
    }

    #[test]
    fn empty_first_choice_falls_through_to_next() {
        let v = env(&[("USERPROFILE", ""), ("HOMEDRIVE", "D:"), ("HOMEPATH", r"\Users\x")]);
        assert_eq!(home_from(true, &v), Some(PathBuf::from(r"D:\Users\x")));
        let v = env(&[("HOME", ""), ("USERPROFILE", r"C:\Users\u")]);
        assert_eq!(home_from(false, &v), Some(PathBuf::from(r"C:\Users\u")));
    }

    /* ---------------- ~ 展开 ---------------- */

    #[test]
    fn tilde_expansion() {
        let home = PathBuf::from("/h");
        assert_eq!(expand_home_in("~", Some(&home), false), PathBuf::from("/h"));
        assert_eq!(expand_home_in("~/a/b", Some(&home), false), PathBuf::from("/h/a/b"));
        // 反斜杠形式只在 Windows 上认（POSIX 上 `~\a` 是合法文件名）
        assert_eq!(expand_home_in(r"~\a", Some(&home), true), PathBuf::from("/h/a"));
        assert_eq!(expand_home_in(r"~\a", Some(&home), false), PathBuf::from(r"~\a"));
        // 不认 `~user`、相对路径、绝对路径
        assert_eq!(expand_home_in("~user/x", Some(&home), true), PathBuf::from("~user/x"));
        assert_eq!(expand_home_in("rel/x", Some(&home), false), PathBuf::from("rel/x"));
        assert_eq!(expand_home_in("/abs", Some(&home), false), PathBuf::from("/abs"));
    }

    #[test]
    fn tilde_without_home_stays_literal() {
        // 老代码会展开成**空路径**（等于当前目录）；宁可原样保留让后续 is_dir() 报错。
        assert_eq!(expand_home_in("~/x", None, false), PathBuf::from("~/x"));
        assert_eq!(expand_home_in("~", None, false), PathBuf::from("~"));
    }

    /* ---------------- agent 目录 ---------------- */

    #[test]
    fn agent_dir_hangs_off_home() {
        let v = env(&[("USERPROFILE", "/Users/u")]);
        let dir = agent_dir_from(false, &v);
        assert_eq!(dir, PathBuf::from("/Users/u").join(".pi").join("agent"));
        assert!(dir.ends_with(".pi/agent"));
        // 必须是绝对路径：相对路径 = 随进程 cwd 漂移
        assert!(dir.is_absolute());
    }

    #[test]
    fn agent_dir_env_overrides_home() {
        let v = env(&[
            ("HOME", "/Users/u"),
            (ENV_AGENT_DIR, "/tmp/custom-agent"),
        ]);
        assert_eq!(agent_dir_from(false, &v), PathBuf::from("/tmp/custom-agent"));
        // `~` 形式也要展开（pi: expandTildePath(envDir)）
        let v = env(&[("HOME", "/Users/u"), (ENV_AGENT_DIR, "~/a")]);
        assert_eq!(agent_dir_from(false, &v), PathBuf::from("/Users/u/a"));
        // 空值 = 未设置
        let v = env(&[("HOME", "/Users/u"), (ENV_AGENT_DIR, "")]);
        assert_eq!(agent_dir_from(false, &v), PathBuf::from("/Users/u/.pi/agent"));
    }

    #[test]
    fn agent_dir_without_home_is_relative() {
        let v = env(&[]);
        let dir = agent_dir_from(true, &v);
        assert!(!dir.is_absolute());
        assert_eq!(dir, PathBuf::from(".pi").join("agent"));
    }

    /* ---------------- 预览沙箱 ---------------- */

    #[test]
    fn empty_home_never_contains_anything() {
        // 实测 `Path::new("/etc/passwd").starts_with("") == true`：
        // 不显式挡这一条，Windows 上 fs_preview_read 就是任意文件读取。
        assert!(Path::new("/etc/passwd").starts_with(""));
        assert!(!is_under(Path::new(""), Path::new("/etc/passwd")));
        assert!(!is_under(Path::new(""), Path::new(r"C:\Windows\win.ini")));
    }

    #[test]
    fn home_subtree_check() {
        let home = PathBuf::from("/h/u");
        assert!(is_under(&home, &PathBuf::from("/h/u/a.txt")));
        assert!(is_under(&home, &home));
        assert!(!is_under(&home, &PathBuf::from("/h/other/a.txt")));
        assert!(!is_under(&home, &PathBuf::from("/etc/passwd")));
    }

    /* ---------------- 真机证据（跑得到就打印实际解析结果） ---------------- */

    #[test]
    fn real_process_home_resolves() {
        let home = home_dir().expect("真机上应能解析出主目录（CI 也有 HOME）");
        assert!(home.is_absolute(), "主目录必须是绝对路径: {home:?}");
        let agent = agent_dir();
        // 真机一眼看清三件事：主目录在哪、agent 目录在哪、**生效**会话根在哪
        // （生效根可能被 PI_CODING_AGENT_SESSION_DIR / settings.json 改掉）
        eprintln!(
            "[real] home={} agent={} default_sessions={} effective_sessions={}",
            home.display(),
            agent.display(),
            agent.join("sessions").display(),
            crate::config::pi_files::sessions_root().display()
        );
        assert!(agent.ends_with(".pi/agent") || std::env::var_os(ENV_AGENT_DIR).is_some());
    }

    /* ---------------- 端到端：把 HOME 抹掉，看生产入口还对不对 ---------------- */

    /// 用户那台 Windows 上的**原始症状**：不设 `HOME` 时，
    /// 默认会话目录退化成**相对**路径 `.pi/agent\sessions`。
    ///
    /// 本机是 macOS 也能验：`cfg!(windows)` 只决定**查找顺序**，
    /// 真正出事的是"HOME 缺失后没有任何兜底"。所以这里起一个子进程，
    /// 把 `HOME` 抹掉只留 `USERPROFILE`，让**真正的生产入口**
    /// （`agent_dir()` / `sessions_root()`，不是纯函数）跑一遍。
    #[test]
    fn production_entries_survive_missing_home() {
        let fake_home = std::env::temp_dir().join(format!("piggy-home-probe-{}", std::process::id()));
        let exe = std::env::current_exe().expect("测试二进制路径");
        let out = std::process::Command::new(exe)
            .args([
                "--exact",
                "config::paths::tests::subprocess_home_probe",
                "--ignored",
                "--nocapture",
            ])
            .env_remove("HOME")
            .env_remove(ENV_AGENT_DIR)
            .env_remove("PI_CODING_AGENT_SESSION_DIR")
            .env("USERPROFILE", &fake_home)
            .output()
            .expect("起子进程");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(out.status.success(), "子进程失败:\n{stdout}");
        let agent = fake_home.join(".pi").join("agent");
        assert!(
            stdout.contains(&format!("probe agent={}", agent.display())),
            "HOME 缺失时应回退到 USERPROFILE，实际输出:\n{stdout}"
        );
        // 默认会话目录必须**绝对**（相对就是用户看到的 `.pi/agent\\sessions`）
        assert!(
            stdout.contains(&format!("probe sessions={}", agent.join("sessions").display())),
            "默认会话目录应为绝对路径，实际输出:\n{stdout}"
        );
    }

    /// 只由上面那个测试在子进程里跑（`--ignored --exact`），不单独出现在常规跑里。
    #[test]
    #[ignore = "由 production_entries_survive_missing_home 起子进程调用"]
    fn subprocess_home_probe() {
        println!("probe agent={}", agent_dir().display());
        println!("probe sessions={}", crate::config::pi_files::sessions_root().display());
    }
}
