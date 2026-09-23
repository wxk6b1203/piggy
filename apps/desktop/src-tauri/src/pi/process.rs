//! 进程监督（docs/01 §2.3、02 §2、03 §2.3）：
//! spawn → stdin 单写者任务 → stderr 环形缓冲 → stdout reader（分帧/路由/合帧）。
//! reader 循环 = `select! { chunk, 16ms tick }`：chunk 驱动解析，tick 驱动合帧冲刷。

use crate::events::EventSink;
use crate::pi::client::{Worker, WorkerInner, WorkerState};
use crate::pi::coalesce::FrameCoalescer;
use crate::pi::codec::JsonlDecoder;
use crate::pi::permission::PermissionMode;
use crate::pi::protocol::{classify, Ame, PiEvent, DELTA_KINDS};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdout;

#[derive(Debug, Clone)]
pub enum SessionTarget {
    /// 默认：新会话（按 cwd 规则落盘）
    New,
    /// `--no-session`：临时草稿
    NoSession,
    /// `--session <path|id>`：打开既有会话【契约 C1】
    Path(String),
}

#[derive(Debug, Clone)]
pub struct SpawnArgs {
    pub cwd: PathBuf,
    pub pi_bin: PathBuf,
    pub session: SessionTarget,
    pub name: Option<String>,
    /// 权限档位（见 `pi/permission.rs`）。`--tools` / `-e` 都是 CLI 参数，
    /// 所以档位**只能在 spawn 时决定**：切档 = 带同一会话文件重启 worker。
    pub permission: PermissionMode,
    /// 守卫扩展脚本路径；仅 `Workspace` 档使用，缺失时拒绝启动（不静默降级）。
    pub guard_script: Option<PathBuf>,
}

pub async fn spawn_worker(
    tab_id: &str,
    args: SpawnArgs,
    sink: Arc<dyn EventSink>,
) -> Result<Worker, String> {
    let mut cmd = tokio::process::Command::new(&args.pi_bin);
    cmd.arg("--mode")
        .arg("rpc")
        .current_dir(&args.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("NO_COLOR", "1");
    match &args.session {
        SessionTarget::NoSession => {
            cmd.arg("--no-session");
        }
        SessionTarget::Path(p) => {
            cmd.arg("--session").arg(p);
        }
        SessionTarget::New => {}
    }
    if let Some(n) = &args.name {
        cmd.arg("--name").arg(n);
    }
    // 工具白名单（pi `--tools` / `-t`）：限制档位靠它拿掉 shell 与写工具。
    // 不传 = 不限制（pi 用自身默认 + 插件工具）——这是「完全权限」档的定义。
    if let Some(list) = args.permission.tool_allowlist() {
        cmd.arg("--tools").arg(list);
    }
    // 路径守卫（pi `-e`）：只有「工作区内修改」需要。
    // 脚本缺失时**必须报错而不是静默降级**——否则用户以为修改被限制在 cwd 内、实际没有，
    // 这种"看起来安全"的假象比直接启动失败更危险。
    if args.permission.needs_path_guard() {
        let Some(guard) = args.guard_script.as_ref().filter(|p| p.is_file()) else {
            return Err(
                "GUARD_SCRIPT_MISSING: 权限档位「工作区内修改」需要守卫扩展 resources/piggy-guard.js，\
                 但未找到。已拒绝以无边界的方式启动——请改用「仅可查看」/「完全权限」，或修复安装。"
                    .to_string(),
            );
        };
        cmd.arg("--extension").arg(guard);
        // 白名单根 = 会话 cwd。守卫 fail-closed：该变量丢失则拒绝一切写入。
        cmd.env("PIGGY_GUARD_ROOTS", &args.cwd);
    }
    // 前置检查：tokio 把 cwd 缺失与二进制缺失都报 NotFound，无法区分（M1 修正记录）
    if !args.cwd.exists() {
        return Err(format!("SESSION_CWD_MISSING: 项目目录不存在: {}", args.cwd.display()));
    }
    if !args.pi_bin.exists() {
        return Err(format!(
            "PI_BINARY_MISSING: pi 二进制不存在: {}（可能正在升级）",
            args.pi_bin.display()
        ));
    }
    // 启动参数留痕：权限档位完全由 argv 决定，"我到底起了什么"必须能从日志回答。
    // 排查自定义 pi（换二进制 / 换档位 / 守卫没生效）时，这一行通常是第一个要看的东西。
    {
        let mut shown: Vec<String> = vec![args.pi_bin.display().to_string()];
        for a in cmd.as_std().get_args() {
            shown.push(a.to_string_lossy().into_owned());
        }
        eprintln!(
            "[piggy] spawn pi [{tab_id}] permission={} cwd={}\n    {}",
            args.permission.as_str(),
            args.cwd.display(),
            shown.join(" ")
        );
    }
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            // 二进制消失（pi 升级窗口/被移动）：结构化标记，registry 据此重新发现并重试（docs/02 §2.1）
            format!("PI_BINARY_MISSING: {e} ({})", args.pi_bin.display())
        } else {
            format!("spawn pi failed ({:?}): {e}", args.pi_bin)
        }
    })?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "pi stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "pi stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "pi stderr unavailable".to_string())?;

    let (stdin_tx, stdin_rx) = tokio::sync::mpsc::channel::<String>(64);
    let (state_tx, state_rx) = tokio::sync::watch::channel(WorkerState::Spawning);

    let worker: Worker = Arc::new(WorkerInner {
        tab_id: tab_id.to_string(),
        cwd: args.cwd.clone(),
        stdin_tx,
        pending: tokio::sync::Mutex::new(std::collections::HashMap::new()),
        next_id: std::sync::atomic::AtomicU64::new(1),
        state_tx,
        state_rx,
        stderr_tail: tokio::sync::Mutex::new(std::collections::VecDeque::new()),
        child: tokio::sync::Mutex::new(Some(child)),
    });

    // stdin 单写者（docs/02 §3.1）：所有命令串行写入，避免交错坏帧
    // JSONL 协议要求每条命令以 LF 结尾（serde_json 不自带换行，此处统一补齐）
    tokio::spawn(async move {
        let mut rx = stdin_rx;
        while let Some(line) = rx.recv().await {
            let mut buf = line;
            if !buf.ends_with('\n') {
                buf.push('\n');
            }
            if stdin.write_all(buf.as_bytes()).await.is_err() {
                break;
            }
            if stdin.flush().await.is_err() {
                break;
            }
        }
        let _ = stdin.shutdown().await;
    });

    // stderr 环形缓冲（尾部 256 行，仅诊断）
    {
        let w = worker.clone();
        tokio::spawn(async move {
            let mut reader = BufReader::new(stderr);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line).await {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let mut tail = w.stderr_tail.lock().await;
                        if tail.len() >= 256 {
                            tail.pop_front();
                        }
                        tail.push_back(line.trim_end().to_string());
                    }
                }
            }
        });
    }

    // stdout reader + 合帧
    {
        let w = worker.clone();
        let sink2 = sink.clone();
        let tab = tab_id.to_string();
        tokio::spawn(async move {
            run_reader(w, sink2, tab, stdout).await;
        });
    }

    Ok(worker)
}

async fn run_reader(worker: Worker, sink: Arc<dyn EventSink>, tab_id: String, stdout: ChildStdout) {
    let mut decoder = JsonlDecoder::new();
    let mut coalescer = FrameCoalescer::new(tab_id.clone(), sink.clone());
    let mut buf = vec![0u8; 64 * 1024];
    let mut stdout = stdout;
    let mut interval = tokio::time::interval(Duration::from_millis(16));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    'outer: loop {
        tokio::select! {
            n = stdout.read(&mut buf) => {
                match n {
                    Ok(0) | Err(_) => break 'outer,
                    Ok(n) => {
                        let mut lines = Vec::new();
                        decoder.feed(&buf[..n], &mut lines);
                        for line in lines {
                            handle_line(&line, &worker, &sink, &tab_id, &mut coalescer).await;
                        }
                    }
                }
            }
            _ = interval.tick() => {
                coalescer.flush().await;
            }
        }
    }
    // EOF：冲刷半行 + 最后一帧
    let mut lines = Vec::new();
    decoder.finish(&mut lines);
    for line in lines {
        handle_line(&line, &worker, &sink, &tab_id, &mut coalescer).await;
    }
    coalescer.flush().await;
    worker.fail_all_pending("pi worker exited").await;
    // 回收子进程句柄并 wait（防僵尸）
    let exit_code = if let Some(mut child) = worker.child.lock().await.take() {
        child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1)
    } else {
        -1
    };
    let final_state = if worker.state() == WorkerState::Stopped {
        WorkerState::Stopped
    } else {
        worker.set_state(WorkerState::Crashed);
        WorkerState::Crashed
    };
    let stderr_tail: Vec<String> = worker.stderr_tail.lock().await.iter().cloned().collect();
    sink.emit_json(
        &format!("pi:state:{tab_id}"),
        json!({
            "state": final_state,
            "exitCode": exit_code,
            "stderrTail": stderr_tail.last().cloned(),
        }),
    );
}

async fn handle_line(
    line: &str,
    worker: &Worker,
    sink: &Arc<dyn EventSink>,
    tab: &str,
    coalescer: &mut FrameCoalescer,
) {
    let Ok(v) = serde_json::from_str::<Value>(line) else {
        // 防御：pi 保证合法 JSONL；非法行计数上报不中断（docs/02 §10）
        sink.emit_json(
            &format!("pi:log:{tab}"),
            json!({"kind": "parse_error", "line": line.chars().take(500).collect::<String>()}),
        );
        return;
    };
    if v["type"] == "response" {
        let id = v
            .get("id")
            .and_then(|x| {
                x.as_str()
                    .and_then(|s| s.parse::<u64>().ok())
                    .or_else(|| x.as_u64())
            });
        if let Some(id) = id {
            let tx = worker.pending.lock().await.remove(&id);
            if let Some(tx) = tx {
                let _ = tx.send(v);
            }
        }
        return;
    }
    match classify(&v) {
        PiEvent::MessageUpdate { usage, ame } => {
            coalescer.set_usage(usage);
            if DELTA_KINDS.contains(&ame.kind.as_str()) {
                coalescer.push_delta(&ame);
            } else {
                // 块边界：入帧立即冲刷（docs/05 §3.2）
                coalescer.push_signal(&ame);
                coalescer.flush().await;
            }
        }
        PiEvent::AgentStart => {
            if worker.state() != WorkerState::Stopped {
                worker.set_state(WorkerState::Busy);
            }
            coalescer.flush().await;
            sink.emit_json(&format!("pi:commit:{tab}"), v);
        }
        PiEvent::AgentSettled => {
            if worker.state() != WorkerState::Stopped {
                worker.set_state(WorkerState::Ready);
            }
            coalescer.flush().await;
            sink.emit_json(&format!("pi:commit:{tab}"), v);
        }
        PiEvent::ExtensionUiRequest { .. } => {
            sink.emit_json(&format!("pi:ui-req:{tab}"), v);
        }
        _ => {
            coalescer.flush().await;
            sink.emit_json(&format!("pi:commit:{tab}"), v);
        }
    }
}

#[allow(dead_code)]
fn _assert_ame_debug(a: &Ame) {
    let _ = format!("{a:?}");
}
