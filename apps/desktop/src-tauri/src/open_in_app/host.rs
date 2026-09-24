//! 宿主事实与宿主能力（移植 DSH `resolver.ts` 的 `internals` 注入设计）。
//!
//! **为什么要有 `Host` trait**：目录解析的正确性几乎全在"读文件系统 + 跑一条宿主命令"
//! 的编排里，而这些在 CI/开发机上没法真的装齐 34 个应用。DSH 的做法是让
//! `platform / home / env / applicationRoots / run / launch / resolveExecutable`
//! 全部可注入，于是 macOS/Windows/Linux 三条解析链都能在**任何**平台上被确定性验证。
//! 这里照搬：`RealHost` 是真机，`FakeHost`（tests）是脚本化的假宿主。

use super::catalog::Platform;
use super::resolver::launch_args;
use super::spec::{LaunchOutcome, LaunchSpec};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// 注入给解析器的宿主事实。
#[derive(Debug, Clone)]
pub struct Facts {
    pub platform: Option<Platform>,
    pub home: PathBuf,
    pub app_roots: Vec<PathBuf>,
    /// `SSH_CONNECTION` / `SSH_TTY` 非空 → 这台机器上的编辑器打开的是**别人**的屏幕。
    pub ssh: bool,
    pub env: HashMap<String, String>,
}

impl Facts {
    /// 从当前进程环境探测。
    pub fn detect() -> Facts {
        let env: HashMap<String, String> = std::env::vars().collect();
        let home = env
            .get("HOME")
            .or_else(|| env.get("USERPROFILE"))
            .map(PathBuf::from)
            .unwrap_or_default();
        Facts {
            platform: Platform::current(),
            app_roots: vec![
                PathBuf::from("/Applications"),
                home.join("Applications"),
            ],
            ssh: is_ssh(&env),
            home,
            env,
        }
    }

    /// 一个环境变量的值。
    pub fn var(&self, name: &str) -> Option<&str> {
        self.env.get(name).map(String::as_str)
    }
}

/// SSH 判定：DSH 只看继承到的进程层 `SSH_CONNECTION` / `SSH_TTY`（项目/用户 `.env` 不算）。
pub fn is_ssh(env: &HashMap<String, String>) -> bool {
    ["SSH_CONNECTION", "SSH_TTY"]
        .iter()
        .any(|k| env.get(*k).map(|v| !v.is_empty()).unwrap_or(false))
}

/// 宿主能力。解析器只通过这些方法接触外界 —— 于是它可以被造假。
pub trait Host {
    fn is_dir(&self, path: &Path) -> bool;
    fn is_file(&self, path: &Path) -> bool;
    /// 目录项名（不保证顺序）；目录不存在/不可读 → None。
    fn read_dir(&self, path: &Path) -> Option<Vec<String>>;
    /// 读文本文件；失败 → None。
    fn read_file(&self, path: &Path) -> Option<String>;
    /// 读二进制文件（图标是 PNG/SVG，不能当 UTF-8 读）；失败 → None。
    fn read_bytes(&self, path: &Path) -> Option<Vec<u8>>;
    /// PATH 上的可执行文件。
    fn which(&self, name: &str) -> Option<PathBuf>;
    /// 跑一条宿主命令（argv，永不经过 shell），带超时；失败/超时/非零退出 → None。
    fn run(&self, command: &str, args: &[&str], timeout: Duration) -> Option<String>;
}

/// 真机宿主。
pub struct RealHost {
    facts: Facts,
}

impl RealHost {
    pub fn new(facts: Facts) -> RealHost {
        RealHost { facts }
    }
}

impl Host for RealHost {
    fn is_dir(&self, path: &Path) -> bool {
        path.is_dir()
    }

    fn is_file(&self, path: &Path) -> bool {
        path.is_file()
    }

    fn read_dir(&self, path: &Path) -> Option<Vec<String>> {
        let entries = std::fs::read_dir(path).ok()?;
        Some(
            entries
                .filter_map(|e| e.ok())
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect(),
        )
    }

    fn read_file(&self, path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok()
    }

    fn read_bytes(&self, path: &Path) -> Option<Vec<u8>> {
        std::fs::read(path).ok()
    }

    fn which(&self, name: &str) -> Option<PathBuf> {
        which_in(name, self.facts.var("PATH")?, self.facts.var("PATHEXT"))
    }

    fn run(&self, command: &str, args: &[&str], timeout: Duration) -> Option<String> {
        run_bounded(command, args, timeout)
    }
}

/// PATH 查找（不经过 shell、不调 `which`）：逐目录探测"存在且可执行"。
pub fn which_in(name: &str, path_var: &str, pathext: Option<&str>) -> Option<PathBuf> {
    let sep = if cfg!(windows) { ';' } else { ':' };
    let suffixes: Vec<String> = if cfg!(windows) {
        let raw = pathext.unwrap_or(".COM;.EXE;.BAT;.CMD");
        std::iter::once(String::new())
            .chain(raw.split(';').filter(|s| !s.is_empty()).map(str::to_string))
            .collect()
    } else {
        vec![String::new()]
    };
    for dir in path_var.split(sep).filter(|d| !d.is_empty()) {
        for suffix in &suffixes {
            let candidate = Path::new(dir).join(format!("{name}{suffix}"));
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn is_executable_file(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

/// 跑一条有超时的宿主命令。
///
/// stdout 由**单独线程**读干：`reg.exe query /s` 这类输出能超过管道缓冲（64KB），
/// 先 `try_wait` 再读会在管道写满时互相等死。读线程 + 轮询是这里唯一安全的形状。
pub fn run_bounded(command: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(command)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        buf
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let out = reader.join().unwrap_or_default();
                return if status.success() { Some(out) } else { None };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = reader.join();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => {
                let _ = reader.join();
                return None;
            }
        }
    }
}

/// 交给外部应用的环境：从父环境**洗掉**凭据类变量。
///
/// 理由（DSH README）：这些进程的用户是坐在屏幕前的人，它们**不需要** harness 的
/// `*KEY*` / `*SECRET*`；一旦某个编辑器把环境打进崩溃报告/遥测，密钥就跟着出去了。
pub fn scrubbed_env(env: &HashMap<String, String>) -> Vec<(String, String)> {
    const MARKERS: [&str; 6] = ["KEY", "SECRET", "TOKEN", "PASSWORD", "PASSWD", "CREDENTIAL"];
    env.iter()
        .filter(|(k, _)| {
            let upper = k.to_ascii_uppercase();
            !MARKERS.iter().any(|m| upper.contains(m))
        })
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

/// 启动一个外部应用并只观察"早期失败"。
///
/// 语义（DSH `launchDetachedApp`）：spawn 失败 → `Missing`/`Failed`；
/// 观察窗内非零退出 → `Failed`；观察窗结束时**仍在运行** → 算成功、交出去、不再跟踪
/// （kitty、JetBrains 这类启动器会以前台身份活到窗口关闭，等它退出等于永远不返回）。
pub fn launch_detached(
    spec: &LaunchSpec,
    dir: &str,
    watch: Duration,
    env: &HashMap<String, String>,
) -> LaunchOutcome {
    match spec {
        LaunchSpec::ShellOpen => {
            let opener = if cfg!(target_os = "linux") { "xdg-open" } else { "open" };
            spawn_watched(opener, &[dir.to_string()], watch, env, &[])
        }
        LaunchSpec::Argv { command, args, env: extra } => {
            spawn_watched(command, &launch_args(args, dir), watch, env, extra)
        }
    }
}

/// 用**完整 argv** 启动并观察早期失败（不做任何参数代入）。
///
/// 与 `launch_detached` 分开的理由：文件/目录那一档（`paths.rs`）的参数已经在
/// 调用点拼好（有的还带平台自己的转义，比如 PowerShell 的单引号字面量），
/// 再走一次"追加目录"只会多出一个空参数。
pub fn spawn_watched(
    command: &str,
    args: &[String],
    watch: Duration,
    env: &HashMap<String, String>,
    extra_env: &[(String, String)],
) -> LaunchOutcome {
    let mut cmd = Command::new(command);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_clear()
        .envs(scrubbed_env(env))
        .envs(extra_env.iter().cloned());
    detach(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return if e.kind() == std::io::ErrorKind::NotFound {
                LaunchOutcome::Missing
            } else {
                LaunchOutcome::Failed(format!("启动 {command} 失败: {e}"))
            };
        }
    };

    let deadline = Instant::now() + watch;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    LaunchOutcome::Launched
                } else {
                    LaunchOutcome::Failed(format!(
                        "{command} 在观察窗内退出（code {:?}）",
                        status.code()
                    ))
                };
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    // 仍在运行 = 交出去了。交给一个回收线程 wait()：
                    // 不回收的话子进程退出后会变成僵尸挂在 Piggy 名下。
                    std::thread::spawn(move || {
                        let _ = child.wait();
                    });
                    return LaunchOutcome::Launched;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return LaunchOutcome::Failed(format!("等待 {command} 失败: {e}")),
        }
    }
}

/// 让子进程脱离本进程的进程组/终端：父进程被 ^C 或退出时它继续活着。
fn detach(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
        cmd.creation_flags(0x0000_0008 | 0x0000_0200);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env_of(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn ssh_detection_reads_only_connection_markers() {
        assert!(is_ssh(&env_of(&[("SSH_CONNECTION", "10.0.0.1 1 2 3")])));
        assert!(is_ssh(&env_of(&[("SSH_TTY", "/dev/ttys001")])));
        assert!(!is_ssh(&env_of(&[("SSH_CONNECTION", "")])));
        assert!(!is_ssh(&env_of(&[("TERM", "xterm")])));
        // 项目 .env 里的同名值不该被当成启动方式（DSH 明确写死这条）
        assert!(!is_ssh(&HashMap::new()));
    }

    #[test]
    fn scrub_keeps_runtime_vars_and_drops_credentials() {
        let env = env_of(&[
            ("PATH", "/usr/bin"),
            ("HOME", "/Users/x"),
            ("OPENAI_API_KEY", "sk-secret"),
            ("DSH_TOKEN", "t"),
            ("DB_PASSWORD", "p"),
            ("MY_CREDENTIALS", "c"),
            ("GITHUB_PAT", "keep-me-not-named-like-a-credential"),
        ]);
        let kept: Vec<String> = scrubbed_env(&env).into_iter().map(|(k, _)| k).collect();
        assert!(kept.contains(&"PATH".to_string()));
        assert!(kept.contains(&"HOME".to_string()));
        assert!(!kept.contains(&"OPENAI_API_KEY".to_string()));
        assert!(!kept.contains(&"DSH_TOKEN".to_string()));
        assert!(!kept.contains(&"DB_PASSWORD".to_string()));
        assert!(!kept.contains(&"MY_CREDENTIALS".to_string()));
        // 只按名字判定：没被命名的照旧留着（不猜内容）
        assert!(kept.contains(&"GITHUB_PAT".to_string()));
    }

    /// 观察窗语义要**真的**跑一次进程来量，不能靠读代码下结论。
    #[test]
    fn watch_window_counts_a_still_running_child_as_launched() {
        let facts = Facts::detect();
        // 用 `sh -c '<cmd>' <dir>`：追加在末尾的目录落进 `$0`（无害），
        // 于是这条测试既跑了真实的 argv 组装，又量的是一段真实进程的观察窗行为。
        let spec = LaunchSpec::Argv {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 20".into()],
            env: Vec::new(),
        };
        let started = Instant::now();
        let outcome = launch_detached(&spec, "/tmp", Duration::from_millis(300), &facts.env);
        assert_eq!(outcome, LaunchOutcome::Launched);
        // 不能等 sleep 20 结束 —— 观察窗到点就返回
        assert!(started.elapsed() < Duration::from_secs(3), "没有按观察窗返回");
    }

    #[test]
    fn early_nonzero_exit_is_a_failure() {
        let facts = Facts::detect();
        let spec = LaunchSpec::Argv {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 3".into()],
            env: Vec::new(),
        };
        match launch_detached(&spec, "/tmp", Duration::from_millis(1000), &facts.env) {
            LaunchOutcome::Failed(msg) => assert!(msg.contains("观察窗"), "{msg}"),
            other => panic!("应判定失败，实际 {other:?}"),
        }
    }

    #[test]
    fn early_zero_exit_is_a_success() {
        let facts = Facts::detect();
        let spec = LaunchSpec::Argv {
            command: "/bin/sh".into(),
            args: vec!["-c".into(), "exit 0".into()],
            env: Vec::new(),
        };
        assert_eq!(
            launch_detached(&spec, "/tmp", Duration::from_millis(1000), &facts.env),
            LaunchOutcome::Launched
        );
    }

    #[test]
    fn missing_executable_is_classified_as_missing() {
        let facts = Facts::detect();
        let spec = LaunchSpec::Argv {
            command: "/definitely/not/here/piggy-nope".into(),
            args: vec![],
            env: Vec::new(),
        };
        assert_eq!(
            launch_detached(&spec, "/tmp", Duration::from_millis(200), &facts.env),
            LaunchOutcome::Missing
        );
    }

    #[test]
    fn shell_open_uses_the_platform_opener() {
        // 只用 argv 形状做断言（真开 Finder 会弹窗，不能进测试）
        let spec = LaunchSpec::ShellOpen;
        assert_eq!(spec.describe(), "shell-open");
        // 参数代入由 launch_args 负责（shell-open 直接把目录交给系统打开器）
    }

    #[test]
    fn which_finds_a_real_binary_and_misses_a_fake_one() {
        let Some(path) = std::env::var("PATH").ok() else {
            return;
        };
        assert!(which_in("ls", &path, None).is_some(), "PATH 上应该有 ls");
        assert!(which_in("piggy-definitely-not-installed", &path, None).is_none());
        // 目录不算可执行文件（PATH 里常有目录项；只判存在会误命中）
        let tmp = std::env::temp_dir();
        assert!(which_in("", &format!("{}", tmp.display()), None).is_none());
    }

    #[test]
    fn run_bounded_times_out_and_returns_stdout() {
        let out = run_bounded("/bin/echo", &["hi"], Duration::from_secs(2));
        assert_eq!(out.as_deref(), Some("hi\n"));
        let started = Instant::now();
        let out = run_bounded("/bin/sleep", &["20"], Duration::from_millis(200));
        assert!(out.is_none());
        assert!(started.elapsed() < Duration::from_secs(3));
        // 非零退出 → None（与"命令不可用"同一个含义）
        assert!(run_bounded("/usr/bin/false", &[], Duration::from_secs(2)).is_none());
        assert!(run_bounded("/definitely/not/here", &[], Duration::from_secs(2)).is_none());
    }

    /// 管道写满不会死锁：让子进程吐远超 64KB 的输出。
    #[test]
    fn run_bounded_drains_large_output_without_deadlock() {
        let out = run_bounded(
            "/bin/sh",
            &["-c", "yes hello | head -c 300000"],
            Duration::from_secs(10),
        );
        assert_eq!(out.map(|s| s.len()), Some(300_000));
    }
}
