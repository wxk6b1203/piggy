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
        // 主目录口径统一走 config::paths（HOME/USERPROFILE/HOMEDRIVE+HOMEPATH 的平台顺序，
        // 同 pi 的 Node homedir()）；这里只是不再自己挑一遍变量。
        let home = crate::config::paths::home_dir().unwrap_or_default();
        Facts {
            platform: Platform::current(),
            app_roots: vec![PathBuf::from("/Applications"), home.join("Applications")],
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
    /// 把一段**脚本内容**写进临时文件再执行它（argv，永不经过 shell）。
    ///
    /// 为什么需要它（而不是 `run` + `-Command <脚本>`）：
    /// 1. **二进制产不出**。`run` 的返回值是 `String`，而 Windows 抠图标这条路的产物是 PNG
    ///    字节 —— 塞进 stdout 会被控制台编码毁掉（PowerShell 5.1 的 `Console.OutputEncoding`
    ///    是 UTF-16LE，重定向时表现为零字节交替）。所以脚本只负责**往文件写**，
    ///    调用方读文件，stdout 仅留给人看的日志。
    /// 2. **不给自己造引号转义面**。脚本体作为 `-Command` 的实参要再过一层解析，
    ///    里面任何引号都要转义；写进 `.ps1` 再用 `-File` 执行则是**数据**，不是表达式
    ///    （DSH 的 Windows 图标脚本同样只用 `-File` + 位置参数）。
    ///
    /// 返回 `None` = 脚本没跑成（非零退出/超时/spawn 失败），调用方按"拿不到"处理。
    fn run_script(&self, script_name: &str, script: &str, args: &[&str], timeout: Duration) -> Option<()>;
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

    fn run_script(&self, script_name: &str, script: &str, args: &[&str], timeout: Duration) -> Option<()> {
        // 临时目录里的一次性脚本：**保留 .ps1 后缀**（`powershell -File` 只认这个后缀）
        let dir = std::env::temp_dir().join(format!(
            "piggy-script-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).ok()?;
        let path = dir.join(script_name);
        // 脚本体是 ASCII（见 open_in_app::icons 的说明）：BOM 在这里帮不上忙，
        // 因为 Windows PowerShell 5.1 读**无 BOM 的 .ps1** 是按 ANSI 解的 ——
        // 非 ASCII 注释会被解成乱码并把语法弄坏。这条约束写在图标脚本的常量注释里。
        std::fs::write(&path, script).ok()?;
        let mut argv: Vec<String> = vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-ExecutionPolicy".to_string(),
            "Bypass".to_string(),
            "-File".to_string(),
            path.to_string_lossy().into_owned(),
        ];
        argv.extend(args.iter().map(|a| a.to_string()));
        let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
        let ok = run_bounded("powershell.exe", &refs, timeout).is_some();
        let _ = std::fs::remove_dir_all(&dir);
        ok.then_some(())
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
pub fn launch_detached(spec: &LaunchSpec, dir: &str, watch: Duration, env: &HashMap<String, String>) -> LaunchOutcome {
    match spec {
        LaunchSpec::ShellOpen => {
            if cfg!(windows) {
                return launch_via_explorer(dir, env);
            }
            let opener = if cfg!(target_os = "linux") { "xdg-open" } else { "open" };
            spawn_watched(opener, &[dir.to_string()], watch, env, &[])
        }
        LaunchSpec::Argv {
            command,
            args,
            env: extra,
        } => spawn_watched(command, &launch_args(args, dir), watch, env, extra),
    }
}

/// "交给系统 shell 打开一个参数"该起什么？（**纯函数，可跨平台断言**）
///
/// 返回 `(命令, 能不能用退出码判成败)`。
///
/// 抽出来的理由（2026-10-14）：这个选择以前在两处各写了一遍
/// （`launch_detached` 的 `ShellOpen` 与 `mod.rs::open_external_url`），
/// 而且**两处都写错了同一个地方**（`if linux { xdg-open } else { open }` → Windows 落进 else）。
/// 收成一个纯函数之后，"Windows 上到底起哪个命令"这件事可以在任何平台上断言，
/// 不必真的去起一个资源管理器。
///
/// 第二个返回值是那个平台怪癖：**`explorer.exe` 成功时也返回 1**，
/// 所以 Windows 那格必须为 `false`（否则成功会被判成失败）。
///
/// @returns `(命令名, 退出码能否判成败)`
pub fn shell_opener() -> (&'static str, bool) {
    if cfg!(windows) {
        ("explorer.exe", false)
    } else if cfg!(target_os = "linux") {
        ("xdg-open", true)
    } else {
        ("open", true)
    }
}

/// Windows 上"交给系统 shell"的唯一入口：`explorer.exe <参数>`（**目录或 URL 都吃**）。
///
/// ## 为什么必须单独一条（2026-10-14 用户报障："用文件资源管理器打开目录失败了"）
///
/// 这里以前是 `if linux { "xdg-open" } else { "open" }` —— **Windows 落进了 else**，
/// 于是去起 macOS 的 `open`。Windows 上既没有 `open` 这个命令、也没有注册 `.exe` 之外的
/// 关联，`Command::new("open")` 直接 `NotFound` → `LaunchOutcome::Missing` →
/// 上层把"这份解析过期了"报给用户（"explorer 的启动器失效了"），
/// 而真相是**我们从来没起过 explorer**。
/// 同一个错误在两处出现（这里的 `ShellOpen` 与 `mod.rs::open_external_url`），
/// 所以收成一个入口 —— 下次再改只改这一处。
///
/// ## 为什么不能用 `spawn_watched`（它按退出码判成功）
///
/// 真机实测：`explorer.exe <已存在的目录>` 与 `explorer.exe <URL>` **成功打开后退出码都是 1**
/// （不是 0）。走 `spawn_watched` 就会把成功判成 `Failed("在观察窗内退出（code 1）")` ——
/// 东西明明开了，界面却报错。所以这里只看"能不能起得来"：
/// 起不来（`NotFound`）才是 `Missing`，起来了就是 `Launched`。
///
/// 路径**不转成 file URL**：`explorer.exe` 的位置参数吃的是普通路径
/// （`/select,` 那条才需要 file URL，见 `paths.rs::windows_file_url`）。
///
/// @param arg - 目录路径或 URL（两者的处理方式一致）
pub fn launch_via_explorer(arg: &str, env: &HashMap<String, String>) -> LaunchOutcome {
    let (opener, trust_exit) = shell_opener();
    // 这条只服务"不能信退出码"的那一格（Windows）。判据与 `shell_opener` 同一处，
    // 免得哪天平台表变了、这条还硬编码着 explorer。
    debug_assert!(!trust_exit, "launch_via_explorer 只该被『退出码不可信』的平台用到");
    let mut cmd = Command::new(opener);
    cmd.arg(arg)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .env_clear()
        .envs(scrubbed_env(env));
    detach(&mut cmd);
    match cmd.spawn() {
        Ok(child) => {
            // 交出去，但**不**看退出码（成功也是 1）。回收线程只为不留下僵尸。
            std::thread::spawn(move || {
                let mut child = child;
                let _ = child.wait();
            });
            LaunchOutcome::Launched
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                LaunchOutcome::Missing
            } else {
                LaunchOutcome::Failed(format!("启动 {opener} 失败: {e}"))
            }
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
                    LaunchOutcome::Failed(format!("{command} 在观察窗内退出（code {:?}）", status.code()))
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

    /// **平台派发表**（2026-10-14 用户报"打开目录失败"之后的回归闸门）。
    ///
    /// 这条是纯的、**任何平台都能跑**：它钉住"哪个平台用哪个命令"以及
    /// "退出码能不能判成败"。红检方式：把 `shell_opener` 的 Windows 格改回
    /// `("open", true)`（也就是把当初那个 bug 写回去），Windows 上立刻红。
    #[test]
    fn shell_opener_dispatches_by_platform() {
        let (cmd, trust_exit) = shell_opener();
        if cfg!(windows) {
            assert_eq!(
                cmd, "explorer.exe",
                "Windows 上不许去起 macOS 的 `open`（那个命令不存在）"
            );
            assert!(
                !trust_exit,
                "explorer.exe 成功打开时退出码是 1，所以退出码不能判成败（会把成功判成失败）"
            );
        } else if cfg!(target_os = "linux") {
            assert_eq!(cmd, "xdg-open");
            assert!(trust_exit);
        } else {
            assert_eq!(cmd, "open");
            assert!(trust_exit);
        }
        // 三个平台都不该落到空串（`Command::new("")` 是另一类难查的失败）
        assert!(!cmd.is_empty());
    }

    /// **Windows 上"打开目录/URL"必须真的起得来**（2026-10-14 用户报障的回归闸门）。
    ///
    /// 红检方式（改坏哪一行会红）：把 `shell_opener` 的 Windows 格改回 `("open", true)` ——
    /// Windows 上没有 `open`，这条立刻拿到 `Missing`。**所以它必须真的 spawn**
    /// （用一个假启动器就测不出来了，这正是这个 bug 之前漏过去的原因：
    /// 旧用例 `shell_open_uses_the_platform_opener` 只断言了 `describe()` 字符串）。
    ///
    /// 副作用：会在 Windows 上真的弹出一个资源管理器窗口（打开临时目录）。
    #[test]
    #[cfg(windows)]
    fn windows_shell_open_launches_explorer_for_a_directory() {
        let dir = std::env::temp_dir();
        let facts = Facts::detect();
        let outcome = launch_detached(
            &LaunchSpec::ShellOpen,
            &dir.to_string_lossy(),
            Duration::from_millis(300),
            &facts.env,
        );
        assert_eq!(
            outcome,
            LaunchOutcome::Launched,
            "Windows 上「交给系统文件管理器」起不来（以前是去起不存在的 `open`）"
        );
    }

    /// **成功时退出码是 1**，所以这条链不能用 `spawn_watched` 判成功。
    ///
    /// 这条量的是那个平台事实本身（不是我们的代码）：`explorer.exe <存在的目录>`
    /// 打开窗口后退出码为 1。钉住它是为了说明白 `launch_via_explorer` 为什么不能用
    /// 退出码判成败 —— 否则下一个人"顺手统一一下"就会把成功判成失败。
    #[test]
    #[cfg(windows)]
    fn explorer_exits_nonzero_even_on_success() {
        let dir = std::env::temp_dir();
        let status = std::process::Command::new("explorer.exe")
            .arg(&dir)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("explorer.exe 应当能启动");
        assert!(
            !status.success(),
            "平台行为变了：explorer.exe 成功时居然返回 0（那么 launch_via_explorer 的注释要改）"
        );
    }

    /// 非 Windows 上仍然走原来的系统打开器（这条**不** spawn，只钉选择逻辑）。
    #[test]
    #[cfg(not(windows))]
    fn shell_open_still_uses_open_or_xdg_open_off_windows() {
        let facts = Facts::detect();
        let outcome = launch_detached(
            &LaunchSpec::ShellOpen,
            "/definitely/not/a/directory",
            Duration::from_millis(200),
            &facts.env,
        );
        // 这里只要求"不是因为我们没找到启动器而失败"：
        // `open`/`xdg-open` 存在（在 PATH 上），所以结论不该是 Missing。
        assert_ne!(
            outcome,
            LaunchOutcome::Missing,
            "macOS/Linux 上系统打开器应当存在（Missing = 命令都找不到）"
        );
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
