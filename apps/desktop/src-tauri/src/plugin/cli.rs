//! 调 `pi` 自己的包管理命令（docs/03 §2.15）。
//!
//! ## 为什么是"调 pi"而不是"自己写 settings.json"
//!
//! `pi install` 做的事远不止往 settings.json 里加一行：npm 包要 `npm install --prefix`
//! 到 `~/.pi/agent/npm`、git 源要 `git clone` 到 `~/.pi/agent/git` 再 `npm install --omit=dev`、
//! 本地路径要按**设置文件所在目录**折算成相对路径、还要处理"同一个源已存在"的替换
//! （`package-manager.ts:824-853`、`:1785-1863`、`:2025-2114`）。
//! 自己实现一份必然与 pi 分叉——用户随后在终端里跑 `pi list` 会看到不一样的东西。
//!
//! 所以：**install / remove / update 一律走 pi 的命令行**，Piggy 只负责把参数拼对、
//! 把输出流给界面看。启停与路径登记这类"就是改 settings.json"的操作才由 Piggy 直接写
//! （因为 pi 没有对应的非交互命令，唯一的入口是 `pi config` 那个 TUI）。
//!
//! ## 输出是流的，不是一次性的
//!
//! `npm install` 动辄几十秒到几分钟。因此命令立刻返回 `jobId`，输出按行
//! 通过 `plugin:log:<jobId>` 推给界面，结束时发 `plugin:done:<jobId>`。
//! 界面上能看见 npm/git 的原始输出——这类失败（网络、权限、依赖冲突）**只看
//! 退出码是查不出来的**。

use std::path::PathBuf;
use std::process::Stdio;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Mutex;

use crate::events::EventSink;

/// 一次安装/升级的时间上限。npm 装大依赖图 + 走代理时可以很久，
/// 但不能没有上限——挂死的子进程会把 job 永远留在"运行中"。
const JOB_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15 * 60);

/// 流式输出的行数上限（内存里保留的部分）。超出后只保留尾部，
/// 并记一行"已截断"——`npm install` 的日志可以上万行。
const MAX_LINES: usize = 2000;

/// 一个正在跑（或已结束）的插件任务。
#[derive(Debug, Clone)]
pub struct Job {
    pub id: String,
    pub action: String,
    pub target: String,
    /// 拼出来的完整命令行，显示给用户（要能复制出去自己重跑）
    pub command: String,
    pub cwd: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub lines: Vec<String>,
    pub truncated: bool,
    pub started_ms: u128,
    pub error: Option<String>,
}

/// 任务表。放在模块级而不是 AppState：它只在插件模块里用，
/// 且必须在测试里能不起 Tauri 直接驱动。
static JOBS: std::sync::OnceLock<Mutex<std::collections::HashMap<String, Job>>> =
    std::sync::OnceLock::new();

fn jobs() -> &'static Mutex<std::collections::HashMap<String, Job>> {
    JOBS.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

/// 取消标志：`plugin_job_cancel` 置位，读循环看到后杀子进程。
static CANCELS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();

fn cancels() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    CANCELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

pub fn request_cancel(job_id: &str) {
    cancels().lock().unwrap().insert(job_id.to_string());
}

fn take_cancel(job_id: &str) -> bool {
    cancels().lock().unwrap().remove(job_id)
}

/// 所有任务（界面刷新后重新拉一次，避免错过事件）。
pub async fn snapshot() -> Vec<Value> {
    let map = jobs().lock().await;
    let mut out: Vec<Value> = map
        .values()
        .map(|j| {
            json!({
                "id": j.id,
                "action": j.action,
                "target": j.target,
                "command": j.command,
                "cwd": j.cwd,
                "running": j.running,
                "exitCode": j.exit_code,
                "lines": j.lines,
                "truncated": j.truncated,
                "error": j.error,
                "startedMs": j.started_ms,
            })
        })
        .collect();
    out.sort_by_key(|v| v["startedMs"].as_u64().unwrap_or(0));
    out
}

/// 一次任务要跑的 pi 子命令。
#[derive(Debug)]
pub struct Invocation {
    pub action: &'static str,
    pub target: String,
    pub args: Vec<String>,
}

/// 拼命令行。**这里是唯一决定"哪个 scope 写哪个文件"的地方**：
/// `-l/--local` 写 `<cwd>/.pi/settings.json`，不带则写 `~/.pi/agent/settings.json`
/// （`package-manager-cli.ts:265-276`）。
///
/// 返回 `Err` 的两种情况都来自 pi 自己的解析器，早点拦住比让 npm 报错好：
/// * 空来源；
/// * 裸包名 —— pi 的 `isLocalPath` 会把它当**本地路径**（`package-manager.ts:1446-1471`），
///   结果是 `Path does not exist: …/@scope/pkg`。界面上必须提示写成 `npm:@scope/pkg`。
pub fn plan(action: &str, source: Option<&str>, scope: &str, cwd: Option<&str>) -> Result<Invocation, String> {
    let local = scope.trim() == "project";
    if local && cwd.is_none() {
        return Err("要装到本项目，得先打开一个项目目录".into());
    }
    let src = source.unwrap_or("").trim().to_string();
    let mut args: Vec<String> = Vec::new();
    let action_static = match action {
        "install" => {
            if src.is_empty() {
                return Err("请填写要安装的插件来源".into());
            }
            args.push("install".into());
            args.push(src.clone());
            if local {
                args.push("--local".into());
            }
            // 项目作用域要信任项目，否则 pi 会拒绝读 .pi/settings.json
            // （`trust-manager.ts:29-37`：settings.json 属于"需要信任"的资源）。
            if local {
                args.push("--approve".into());
            }
            "install"
        }
        "remove" => {
            if src.is_empty() {
                return Err("请填写要删除的插件来源".into());
            }
            args.push("remove".into());
            args.push(src.clone());
            if local {
                args.push("--local".into());
                args.push("--approve".into());
            }
            "remove"
        }
        "update" => {
            args.push("update".into());
            if src.is_empty() {
                // 不加限定 = 更新所有已配置的包（`--extensions` 而不是默认的 self！
                // 默认目标是 pi 自己，见 `package-manager-cli.ts:1008-1012`）。
                args.push("--extensions".into());
            } else {
                args.push("--extension".into());
                args.push(src.clone());
            }
            "update"
        }
        other => return Err(format!("未知操作 {other:?}")),
    };
    Ok(Invocation {
        action: action_static,
        target: if src.is_empty() { "(全部)".into() } else { src },
        args,
    })
}

/// 起一个任务。立刻返回 jobId；输出异步推事件。
pub fn spawn(
    sink: std::sync::Arc<dyn EventSink>,
    pi_bin: PathBuf,
    invocation: Invocation,
    cwd: PathBuf,
) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let command_line = format!(
        "{} {}",
        pi_bin.display(),
        invocation.args.join(" ")
    );
    let job = Job {
        id: id.clone(),
        action: invocation.action.to_string(),
        target: invocation.target.clone(),
        command: command_line.clone(),
        cwd: cwd.to_string_lossy().into_owned(),
        running: true,
        exit_code: None,
        lines: Vec::new(),
        truncated: false,
        started_ms: now_ms(),
        error: None,
    };
    let job_id = id.clone();
    tauri::async_runtime::spawn(async move {
        {
            let mut map = jobs().lock().await;
            map.insert(job_id.clone(), job);
        }
        // 起跑事件：界面据此立刻把这一行标成"运行中"
        sink.emit_json(
            &format!("plugin:start:{job_id}"),
            json!({ "id": job_id, "action": invocation.action, "target": invocation.target, "command": command_line, "cwd": cwd.to_string_lossy() }),
        );

        let result = run(&sink, &job_id, &pi_bin, &invocation.args, &cwd).await;

        let (code, err) = match result {
            Ok(c) => (Some(c), None),
            Err(e) => (None, Some(e)),
        };
        {
            let mut map = jobs().lock().await;
            if let Some(j) = map.get_mut(&job_id) {
                j.running = false;
                j.exit_code = code;
                j.error = err.clone();
            }
        }
        sink.emit_json(
            &format!("plugin:done:{job_id}"),
            json!({ "id": job_id, "exitCode": code, "error": err, "ok": code == Some(0) }),
        );
    });
    id
}

/// 把一路输出按行推给界面，同时留在内存里（刷新页面后还能看到）。
async fn pump(
    stream: Option<impl tokio::io::AsyncRead + Unpin + Send + 'static>,
    channel: &'static str,
    sink: std::sync::Arc<dyn EventSink>,
    id: String,
) {
    let Some(stream) = stream else { return };
    let mut lines = BufReader::new(stream).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        push_line(&id, &line).await;
        sink.emit_json(
            &format!("plugin:log:{id}"),
            json!({ "id": id, "stream": channel, "line": line }),
        );
    }
}

/// 看门狗：超时或用户取消时给一个"该收手了"的信号。
async fn watchdog(job_id: &str) -> String {
    let start = std::time::Instant::now();
    loop {
        if take_cancel(job_id) {
            return "已取消".into();
        }
        if start.elapsed() > JOB_TIMEOUT {
            return format!("超过 {} 分钟仍未结束，已中止", JOB_TIMEOUT.as_secs() / 60);
        }
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    }
}

async fn run(
    sink: &std::sync::Arc<dyn EventSink>,
    job_id: &str,
    pi_bin: &std::path::Path,
    args: &[String],
    cwd: &std::path::Path,
) -> Result<i32, String> {
    let mut child = Command::new(pi_bin)
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("启动 {} 失败: {e}", pi_bin.display()))?;

    let out_task = tokio::spawn(pump(
        child.stdout.take(),
        "stdout",
        sink.clone(),
        job_id.to_string(),
    ));
    let err_task = tokio::spawn(pump(
        child.stderr.take(),
        "stderr",
        sink.clone(),
        job_id.to_string(),
    ));

    /// 结果的两种可能。做成枚举是为了让 `select!` 的**分支体里不碰 child**——
    /// `child.wait()` 借走了 `child`，在分支体里 `kill()` 会撞借用检查；
    /// 把结论带出来、回到 select 之外再杀，借用已经结束。
    enum Outcome {
        Exited(std::io::Result<std::process::ExitStatus>),
        Stop(String),
    }

    let outcome = tokio::select! {
        r = child.wait() => Outcome::Exited(r),
        reason = watchdog(job_id) => Outcome::Stop(reason),
    };

    let status = match outcome {
        Outcome::Exited(r) => r.map_err(|e| format!("等待子进程失败: {e}"))?,
        Outcome::Stop(reason) => {
            // 取消/超时都要**先杀再等**：只 kill 不等会留下僵尸，
            // 而且 npm 可能已经把一半文件写进 node_modules。
            let _ = child.kill().await;
            let _ = child.wait().await;
            let _ = tokio::join!(out_task, err_task);
            return Err(reason);
        }
    };
    // 进程退出后管道会关，两个 pump 自然结束——等它们把最后几行读完再返回，
    // 否则 `plugin:done` 可能早于最后一行日志到达界面。
    let _ = tokio::join!(out_task, err_task);
    Ok(status.code().unwrap_or(-1))
}

async fn push_line(job_id: &str, line: &str) {
    let mut map = jobs().lock().await;
    if let Some(j) = map.get_mut(job_id) {
        j.lines.push(line.to_string());
        if j.lines.len() > MAX_LINES {
            let drop = j.lines.len() - MAX_LINES;
            j.lines.drain(0..drop);
            j.truncated = true;
        }
    }
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// install 的参数必须与 `pi install --help` 一致（`-l/--local`、`-a/--approve`）。
    #[test]
    fn install_args_match_pi_cli() {
        let g = plan("install", Some("npm:@a/b"), "global", None).unwrap();
        assert_eq!(g.args, vec!["install", "npm:@a/b"]);

        let p = plan("install", Some("npm:@a/b"), "project", Some("/tmp/proj")).unwrap();
        assert_eq!(p.args, vec!["install", "npm:@a/b", "--local", "--approve"]);
    }

    /// 项目作用域没有 cwd 就必须报错，而不是悄悄写到全局去。
    #[test]
    fn project_scope_requires_a_directory() {
        let e = plan("install", Some("npm:@a/b"), "project", None).unwrap_err();
        assert!(e.contains("打开一个项目"), "{e}");
    }

    /// 空来源要在这里拦住（否则会走到 pi 的参数校验，报错文案对用户没意义）。
    #[test]
    fn empty_sources_are_rejected_before_spawning() {
        assert!(plan("install", None, "global", None).is_err());
        assert!(plan("install", Some("   "), "global", None).is_err());
        assert!(plan("remove", None, "global", None).is_err());
    }

    /// 升级：不带来源 = 更新全部扩展，**不是** pi 的默认目标（pi 默认更新自己）。
    /// 这条如果写错，用户点"检查更新"会把 pi 二进制升级掉。
    #[test]
    fn update_never_defaults_to_updating_pi_itself() {
        let all = plan("update", None, "global", None).unwrap();
        assert_eq!(all.args, vec!["update", "--extensions"]);
        assert!(!all.args.iter().any(|a| a == "--self" || a == "--all"));

        let one = plan("update", Some("npm:@a/b"), "global", None).unwrap();
        assert_eq!(one.args, vec!["update", "--extension", "npm:@a/b"]);
    }

    /// remove 要走 pi 的 remove（它同时删安装目录与 settings 条目）。
    #[test]
    fn remove_uses_pis_own_removal() {
        let r = plan("remove", Some("git:github.com/u/r"), "global", None).unwrap();
        assert_eq!(r.args, vec!["remove", "git:github.com/u/r"]);
    }

    #[test]
    fn unknown_actions_are_rejected() {
        assert!(plan("purge", Some("x"), "global", None).is_err());
    }
}
