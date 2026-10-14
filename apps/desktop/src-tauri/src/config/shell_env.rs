//! 启动时把**登录 shell 的 `PATH`** 补进进程环境（docs/17 §2.1）。
//!
//! ## 为什么必须有这一层（2026-10-14 用户报障：「pi --version 失败: node: not found」）
//!
//! `pnpm tauri build` 打出来的 `.app` 从 Finder/Dock 启动时，环境**不是**终端里那一套：
//! launchd 只给基础变量，`PATH` 是 `/usr/bin:/bin:/usr/sbin:/sbin`。于是：
//!
//! 1. pnpm / npm 装的 `pi` 是**壳垫片**（`~/Library/pnpm/bin/pi`，`#!/bin/sh` + `exec node …`）；
//! 2. 发现链的「常见安装位置」兜底能找到这个垫片（所以界面上不是「pi 未找到」，
//!    而是"pi 明明在，却跑不起来"）；
//! 3. 但 nvm / homebrew / pnpm 的 bin 目录都不在 `PATH` 里 → 垫片里的
//!    `exec node` 报 `line 48: exec: node: not found` → 建会话直接失败。
//!
//! 终端里 `pnpm tauri dev` 一切正常，所以这个 bug 只在**打包产物**上出现。
//!
//! ## 做法：问一次登录 shell（VS Code / fix-path 的同款办法）
//!
//! macOS 的 GUI 进程拿不到 shell 启动文件，只能**自己去问**：跑一次
//! `$SHELL -ilc '<哨兵>; env'`，把 `PATH` 并回进程环境。
//!
//! ⚠️ **必须带 `-i`**：本机实测（macOS 15 / zsh）`zsh -lc` 只读 `.zshenv` + `.zprofile`，
//! 而 `nvm` 通常在 `.zshrc` 里 `source nvm.sh` —— 只有交互式 shell 才读 `.zshrc`，
//! 少了 `-i` 就"补了个 PATH 但 node 还是没有"，看起来像没修。
//!
//! 代价与护栏：
//! - 交互式启动文件可能**慢**（本机 0.5–0.9 s）或**挂住**（rc 里读标准输入、跑网络命令），
//!   所以有 [`LOGIN_SHELL_TIMEOUT`]；超时/失败一律**保持原样**，绝不阻断启动。
//! - rc 文件可能往 stdout 打横幅/乱码，所以只认**哨兵行之后**的内容。
//! - 全程只改 `PATH` 这一个变量，其余环境一律不动（别把 `HOME`、代理变量冲掉）。
//!
//! ## 为什么不干脆把 node 目录写进发现链
//!
//! 那样只是给 pi 垫片找个解释器，pi 自己 `bash` 工具起的子进程还是拿不到 `git`/`python`/
//! 用户自定义命令 —— 用户看到的是"能开会话，但 agent 的工具全报 command not found"。
//! 补 `PATH` 是一次修好整条链（pi 子进程、Fleet 的 `git`、插件 CLI 都受益）。
//!
//! ## 排查入口
//!
//! - `PIGGY_NO_SHELL_ENV=1`：关掉这一层（复现"Finder 环境"用，也是出问题时的对照实验）
//! - `PIGGY_SHELL=/path/to/shell`：换一个 shell 来问

/// 问 shell 的超时上限。交互式启动文件（nvm / conda / 各种 SDK 管理器）本机实测
/// 0.5–0.9 s；给到 5 s 是因为**慢机器 + 冷缓存**下 1–2 s 很常见，
/// 而超时的代价只是"没补上 PATH"（退回原行为），不是崩。
pub const LOGIN_SHELL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// 关闭这一层的环境变量（对照实验 / CI）。
pub const ENV_SKIP: &str = "PIGGY_NO_SHELL_ENV";

/// 指定用哪个 shell 去问（默认 `$SHELL`）。
pub const ENV_SHELL: &str = "PIGGY_SHELL";

/// 从 shell 输出里认出「环境从这里开始」的哨兵。
///
/// 用 `\x1f`（US，单元分隔符）而不是普通字符串：避免 rc 文件的横幅**恰好**含这几个字。
const SENTINEL: &str = "@piggy-shell-env@\u{1f}";

/// 真的把登录 shell 的环境并回进程 `PATH` 之后的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellPath {
    /// 实际用的 shell（可读说明用）
    pub shell: String,
    /// 合并后的 `PATH`
    pub path: String,
}

/// 补 `PATH` 的结果。失败是**正常路径**（保持原样），不是错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellEnvOutcome {
    /// 补上了
    Applied { shell: String },
    /// 没做（Windows / 已关闭 / 原样即够）
    Skipped { reason: String },
    /// 问了但没用上（超时、rc 报错、拿不到 PATH）
    Failed { reason: String },
}

impl ShellEnvOutcome {
    /// 给启动日志用的一行中文说明。
    pub fn describe(&self) -> String {
        match self {
            Self::Applied { shell } => format!("已从登录 shell 补齐 PATH（{shell}）"),
            Self::Skipped { reason } => format!("未补齐 PATH：{reason}"),
            Self::Failed { reason } => format!("补齐 PATH 失败（保持原样）：{reason}"),
        }
    }
}

/// 把登录 shell 的 `PATH` 并回**本进程环境**。启动时调用一次（`lib.rs::run` 最前面），
/// 之后所有子进程（pi worker、`git`、插件 CLI、pty）都自动继承。
///
/// Windows 上直接返回 `Skipped`：GUI 进程本来就继承用户完整环境（没有 macOS 这套 shell
/// 启动文件隔离），跑去 `cmd /c set` 只会多起一个进程、还可能被 AutoRun 干扰。
pub fn enrich_process_path() -> ShellEnvOutcome {
    if cfg!(windows) {
        return ShellEnvOutcome::Skipped {
            reason: "Windows 的 GUI 进程本就继承用户环境".to_string(),
        };
    }
    if std::env::var_os(ENV_SKIP).is_some_and(|v| !v.is_empty()) {
        return ShellEnvOutcome::Skipped {
            reason: format!("{ENV_SKIP} 已设置"),
        };
    }
    let current = std::env::var("PATH").unwrap_or_default();
    match enrich_with(&|k| std::env::var(k).ok(), &current) {
        Ok(Some(s)) => {
            std::env::set_var("PATH", &s.path);
            ShellEnvOutcome::Applied { shell: s.shell }
        }
        Ok(None) => ShellEnvOutcome::Skipped {
            reason: "登录 shell 的 PATH 没有新目录".to_string(),
        },
        Err(e) => ShellEnvOutcome::Failed { reason: e },
    }
}

/// [`enrich_process_path`] 的**可注入**版本：`var` 给环境、`current` 给当前 `PATH`，
/// 全程不碰真实进程环境 —— 于是"垫片找不到 node"这个真机事故能在单测里确定性地复现。
///
/// 返回 `Ok(None)` 表示"问了，但没有新目录可用"（调用方不必 `set_var`）。
pub fn enrich_with(var: &dyn Fn(&str) -> Option<String>, current: &str) -> Result<Option<ShellPath>, String> {
    let shell = login_shell(var)?;
    // 探测用的环境**必须与调用方声明的环境一致**：`PATH` 走 `current`、其余走 `var`。
    // 这一点是测试能复现真机事故的前提 —— 若让子 shell 去继承测试进程真实的 PATH
    // （开发终端里 PATH 早就带着 nvm），那"少了 -i 就读不到 .zshrc"根本测不出来。
    let probe = |k: &str| {
        if k == "PATH" {
            Some(current.to_string())
        } else {
            var(k)
        }
    };
    let raw = query_shell(&shell, &probe)?;
    let shell_path = var_from(&raw, "PATH").ok_or_else(|| format!("{} 没吐出 PATH", shell.display()))?;
    let merged = merge_paths(&shell_path, current);
    if merged == current {
        return Ok(None);
    }
    Ok(Some(ShellPath {
        shell: shell.display().to_string(),
        path: merged,
    }))
}

/// 用哪个 shell 去问：`PIGGY_SHELL` → `$SHELL` → 常见位置。
///
/// 候选**不查** `/etc/shells`：那会把用户自己装的 fish/nushell 排除掉（用户拿它们当
/// 登录 shell 时 `$SHELL` 就指向那儿）。只要求"是个能执行的普通文件"，
/// 失败时 `enrich_process_path` 会如实报出来（不静默）。
fn login_shell(var: &dyn Fn(&str) -> Option<String>) -> Result<std::path::PathBuf, String> {
    let mut tried: Vec<String> = Vec::new();
    let mut cands: Vec<String> = Vec::new();
    if let Some(s) = var(ENV_SHELL).filter(|s| !s.trim().is_empty()) {
        cands.push(s);
    }
    if let Some(s) = var("SHELL").filter(|s| !s.trim().is_empty()) {
        cands.push(s);
    }
    cands.push("/bin/zsh".into());
    cands.push("/bin/bash".into());
    cands.push("/bin/sh".into());
    for c in cands {
        let p = std::path::PathBuf::from(&c);
        if p.is_file() {
            return Ok(p);
        }
        tried.push(c);
    }
    Err(format!("找不到可用的登录 shell（试过 {}）", tried.join("、")))
}

/// 问一次 shell：`<shell> -ilc '<哨兵>; env'`。
///
/// 只认哨兵行**之后**的 `KEY=VALUE`；之前的一切（横幅、警告）全部忽略。
///
/// ⚠️ `-i` 不能省（docs/17 §2.1）：macOS 上 `zsh -lc` 只读 `.zshenv` + `.zprofile`，
/// 而 nvm 之类的 PATH 注入通常写在 `.zshrc`（只对交互式 shell 生效）。
/// `login_shell_path_makes_a_node_shim_runnable` 就是这条的守卫 ——
/// 把 `-ilc` 改回 `-lc`，它必须变红。
#[cfg(unix)]
fn query_shell(
    shell: &std::path::Path,
    var: &dyn Fn(&str) -> Option<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let script = format!("printf '{SENTINEL}\\n'; env");
    let out = run_with_timeout(shell, &["-ilc", &script], LOGIN_SHELL_TIMEOUT, var)?;
    if out.is_empty() {
        return Err(format!("{} 没有输出（rc 文件挂住或提前退出？）", shell.display()));
    }
    parse_env_output(&out)
}

#[cfg(windows)]
fn query_shell(
    shell: &std::path::Path,
    var: &dyn Fn(&str) -> Option<String>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let (_, _) = (shell, var);
    Err("Windows 不走登录 shell 这条路".to_string())
}

/// 跑子进程并在超时后杀掉。返回 stdout；非零退出且没有 stdout 时返回 stderr 尾巴（供报错）。
///
/// 手写超时而不是用 `wait_timeout` crate：这里只需要"最多等 N 秒"，几十行就够，
/// 不值得为一个启动期动作加依赖。
///
/// `var` 是子进程**继承的环境**：调用方说什么就是什么，与调用方声明的环境一致
/// （见 [`enrich_with`]，生产入口传的就是真实进程环境）。
#[cfg(unix)]
fn run_with_timeout(
    program: &std::path::Path,
    args: &[&str],
    timeout: std::time::Duration,
    var: &dyn Fn(&str) -> Option<String>,
) -> Result<String, String> {
    use std::io::Read;
    use std::process::{Command, Stdio};

    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null()) // 交互式 rc 若读标准输入 → 立刻 EOF，不会挂死
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // 只放调用方认得的变量（与它声明的环境一致），不去继承测试/宿主进程里那些额外变量
    for (k, _) in std::env::vars_os() {
        let Some(k) = k.to_str() else { continue };
        if let Some(v) = var(k) {
            cmd.env(k, v);
        }
    }
    let mut child = cmd.spawn().map_err(|e| format!("起 {} 失败: {e}", program.display()))?;

    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!(
                        "{} 超过 {:?} 没返回（rc 文件太慢？）",
                        program.display(),
                        timeout
                    ));
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            Err(e) => return Err(format!("等 {} 失败: {e}", program.display())),
        }
    };

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut s) = child.stdout.take() {
        let _ = s.read_to_string(&mut stdout);
    }
    if let Some(mut s) = child.stderr.take() {
        let _ = s.read_to_string(&mut stderr);
    }
    if !status.success() && stdout.trim().is_empty() {
        let tail: String = stderr
            .trim()
            .chars()
            .rev()
            .take(200)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        return Err(format!("{} 退出码 {}（{tail}）", program.display(), status));
    }
    Ok(stdout)
}

/// 解析 `<哨兵>` 之后的环境输出。**纯函数**，单独成函数是为了把
/// "rc 有横幅" / "值里带 `=`" / "CRLF" 这些形状钉在单测里。
fn parse_env_output(out: &str) -> Result<std::collections::HashMap<String, String>, String> {
    // 取**最后**一个哨兵：rc 里若有人重放 `env`，最后一段才是完整的
    let tail = match out.rfind(SENTINEL) {
        Some(i) => &out[i + SENTINEL.len()..],
        None => return Err("shell 的输出里没有哨兵（rc 把 stdout 吃了？）".to_string()),
    };
    let mut map = std::collections::HashMap::new();
    for line in tail.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some((k, v)) = split_env_line(line) {
            map.insert(k.to_string(), v.to_string());
        }
    }
    if map.is_empty() {
        return Err("哨兵之后没有任何环境变量".to_string());
    }
    Ok(map)
}

/// `KEY=VALUE` → `("KEY", "VALUE")`；非环境行（横幅残留、空行）→ `None`。
///
/// 按**第一个** `=` 切：值里带 `=` 是常态（`FOO=a=b`、base64、`LS_COLORS`）。
fn split_env_line(line: &str) -> Option<(&str, &str)> {
    let (k, v) = line.split_once('=')?;
    if k.is_empty() {
        return None;
    }
    // shell 变量名：字母/下划线开头，其余字母数字下划线。挡住 `--flag=x` 这类噪声。
    let mut chars = k.chars();
    let first = chars.next()?;
    if !(first.is_ascii_alphabetic() || first == '_') {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    Some((k, v))
}

/// 环境映射里取值（空串当未设置）。
fn var_from(map: &std::collections::HashMap<String, String>, key: &str) -> Option<String> {
    map.get(key).filter(|v| !v.trim().is_empty()).map(|v| v.to_string())
}

/// 合并 `PATH`：**shell 那套优先**（它才是用户真正在用的环境），
/// 再把当前进程独有的目录追加在后面（GUI 启动时可能带进来开发/测试注入的目录）。
///
/// 去重保序，丢掉空段（`PATH` 里尾随的 `:` 会解析成空路径 = 当前目录，
/// 留着等于把进程 cwd 挂进 `PATH`）。
fn merge_paths(shell_path: &str, current: &str) -> String {
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    for raw in shell_path.split(':').chain(current.split(':')) {
        if raw.is_empty() {
            continue;
        }
        let p = std::path::PathBuf::from(raw);
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    }
    std::env::join_paths(&dirs)
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|_| shell_path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
            .collect()
    }

    fn var_of(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        let m = map(pairs);
        move |k: &str| m.get(k).cloned()
    }

    /* ---------------- 解析 ---------------- */

    #[test]
    fn parses_only_what_follows_the_sentinel() {
        // rc 文件的横幅（含 ANSI、含像环境行的东西）必须被完全忽略
        let out = format!("Welcome to zsh!\nPATH=/evil\n{SENTINEL}\nHOME=/Users/u\nPATH=/usr/bin:/bin\n");
        let env = parse_env_output(&out).unwrap();
        assert_eq!(env.get("HOME").map(String::as_str), Some("/Users/u"));
        assert_eq!(
            env.get("PATH").map(String::as_str),
            Some("/usr/bin:/bin"),
            "取到了横幅里那行"
        );
    }

    #[test]
    fn last_sentinel_wins() {
        let out = format!("{SENTINEL}\nA=1\n{SENTINEL}\nB=2\n");
        let env = parse_env_output(&out).unwrap();
        assert_eq!(env.get("A"), None);
        assert_eq!(env.get("B").map(String::as_str), Some("2"));
    }

    #[test]
    fn keeps_equals_signs_and_colors_in_values() {
        let out = format!("{SENTINEL}\nFOO=a=b=c\nLS_COLORS=di=01;34:\nCRLF=1\r\n");
        let env = parse_env_output(&out).unwrap();
        assert_eq!(env.get("FOO").map(String::as_str), Some("a=b=c"));
        assert_eq!(env.get("LS_COLORS").map(String::as_str), Some("di=01;34:"));
        assert_eq!(env.get("CRLF").map(String::as_str), Some("1"), "CRLF 没被吃掉");
    }

    #[test]
    fn rejects_non_env_noise_and_empty_output() {
        assert!(parse_env_output("no sentinel here\n").is_err());
        assert!(parse_env_output(&format!("{SENTINEL}\n--flag=x\nnot a var\n")).is_err());
        assert!(parse_env_output(&format!("{SENTINEL}\n")).is_err());
        assert!(split_env_line("--flag=x").is_none());
        assert!(split_env_line("=v").is_none());
        assert!(split_env_line("A-B=v").is_none());
    }

    /* ---------------- 合并 ---------------- */

    #[test]
    fn shell_path_wins_and_current_extras_are_kept() {
        // Node 路径只存在于 shell 那套里 → 必须补上；当前进程独有的目录不能丢
        let merged = merge_paths(
            "/Users/u/.nvm/versions/node/v24/bin:/opt/homebrew/bin",
            "/usr/bin:/custom",
        );
        let dirs: Vec<&str> = merged.split(':').collect();
        assert_eq!(
            dirs,
            vec![
                "/Users/u/.nvm/versions/node/v24/bin",
                "/opt/homebrew/bin",
                "/usr/bin",
                "/custom"
            ]
        );
    }

    #[test]
    fn merge_dedupes_and_drops_empty_segments() {
        // 空段会解析成"当前目录" —— 留在 PATH 里等于把进程 cwd 挂上去
        let merged = merge_paths("/a:/b:", ":/b:/c");
        assert_eq!(merged.split(':').collect::<Vec<_>>(), vec!["/a", "/b", "/c"]);
    }

    #[test]
    fn no_new_dirs_reports_none() {
        // shell 那套是当前 PATH 的子集 → 不必回写，也不该报"已补齐"。
        // 用一台真实的 shell 来问，因为这台机器上它**一定**会带来新目录，
        // 所以断言分两条：要么 None，要么并集里原目录一个不少。
        let var = var_of(&[("SHELL", "/bin/sh")]);
        match enrich_with(&var, "/usr/bin:/bin") {
            Ok(None) => {}
            Ok(Some(s)) => {
                for d in ["/usr/bin", "/bin"] {
                    assert!(s.path.split(':').any(|x| x == d), "{d} 丢了: {}", s.path);
                }
            }
            Err(e) => panic!("不该失败: {e}"),
        }
    }

    /* ---------------- 真机：把「垫片找不到 node」整个复现一遍 ---------------- */

    /// 构造 pnpm/npm 那种 `#!/bin/sh` + `exec node …` 垫片，脚本内容就是 `--version`。
    #[cfg(unix)]
    fn write_node_shim(dir: &std::path::Path) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        if std::path::Path::new("/bin/sh").exists() {
            std::os::unix::fs::symlink("/bin/sh", dir.join("sh")).unwrap();
        }
        let script = dir.join("cli.js");
        std::fs::write(&script, "console.log('1.2.0')\n").unwrap();
        let shim = dir.join("pi");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\n# pnpm 垫片的形状：没有 node 就报错退出（真机报的就是 line 48）\n\
                 exec node \"{}\" \"$@\"\n",
                script.display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        shim
    }

    /// **这就是用户报的那个 bug**：`.app` 从 Finder 启动时的 PATH 跑不动 pi 垫片。
    ///
    /// 断言链：干净环境 → `pi --version` 报 "node: not found"（复现）
    ///        → `enrich_with` 从登录 shell 补 PATH（修复）
    ///        → 补完的 PATH 上 `pi --version` 能跑通（真的修好了）
    #[cfg(unix)]
    #[test]
    fn login_shell_path_makes_a_node_shim_runnable() {
        use std::process::Command;
        let tmp = tempfile::tempdir().unwrap();
        let shim = write_node_shim(tmp.path());

        // Finder 给的环境：只有基础目录，没有 `SHELL`（在 launchd 那套里也没有）。
        // 于是 `login_shell` 走兜底候选，和真机上一样。
        let finder = map(&[("API_KEY", "sk-test")]);
        let var = move |k: &str| finder.get(k).cloned();

        let run = |path: &str| {
            Command::new(&shim)
                .arg("--version")
                .env_clear()
                .env("API_KEY", "sk-test")
                .env("PATH", path)
                .output()
                .expect("跑垫片失败")
        };

        let before = run("/usr/bin:/bin");
        assert!(
            !before.status.success(),
            "干净 PATH 本该跑不动（复现失败）: {:?}",
            String::from_utf8_lossy(&before.stdout)
        );
        assert!(
            String::from_utf8_lossy(&before.stderr).contains("node"),
            "报错里该提到 node: {}",
            String::from_utf8_lossy(&before.stderr)
        );

        // 修复：问登录 shell 要 PATH（本机 $SHELL，测试进程里一定有）
        let enriched = enrich_with(&var, "/usr/bin:/bin")
            .expect("问登录 shell 不该失败")
            .expect("登录 shell 的 PATH 必须带来新目录（本机装着 node）");

        let after = run(&enriched.path);
        assert!(
            after.status.success(),
            "补完 PATH 还是跑不动：stdout={:?} stderr={:?} PATH={}",
            String::from_utf8_lossy(&after.stdout),
            String::from_utf8_lossy(&after.stderr),
            enriched.path
        );
        assert_eq!(String::from_utf8_lossy(&after.stdout).trim(), "1.2.0");
        assert!(
            enriched.path.contains("/bin"),
            "原 PATH 的目录不该丢: {}",
            enriched.path
        );
    }

    /// 超时护栏：rc 挂住时必须**按时放弃**，不能把应用启动拖死。
    #[cfg(unix)]
    #[test]
    fn a_hanging_shell_is_abandoned_at_the_deadline() {
        let started = std::time::Instant::now();
        let err = run_with_timeout(
            std::path::Path::new("/bin/sleep"),
            &["30"],
            std::time::Duration::from_millis(150),
            &|_| None,
        )
        .unwrap_err();
        assert!(err.contains("没返回"), "{err}");
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "没在超时后放弃");
    }

    /// `PIGGY_SHELL` / `$SHELL` 的优先级与兜底。
    #[test]
    fn shell_selection_prefers_env_then_falls_back() {
        let v = var_of(&[(ENV_SHELL, "/bin/sh"), ("SHELL", "/bin/nope")]);
        assert_eq!(login_shell(&v).unwrap(), std::path::PathBuf::from("/bin/sh"));
        let v = var_of(&[("SHELL", "/bin/zsh")]);
        assert_eq!(login_shell(&v).unwrap(), std::path::PathBuf::from("/bin/zsh"));
        // 两个都不存在 → 兜底到真实存在的那个
        let v = var_of(&[(ENV_SHELL, "/nope/shell")]);
        assert!(login_shell(&v).unwrap().is_file());
    }
}
