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
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::ChildStdout;

#[derive(Debug, Clone, Default)]
pub enum SessionTarget {
    /// 默认：新会话（按 cwd 规则落盘）
    #[default]
    New,
    /// `--no-session`：临时草稿
    NoSession,
    /// `--session <path|id>`：打开既有会话【契约 C1】
    Path(String),
}

#[derive(Debug, Clone, Default)]
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
    /// 桥接扩展脚本路径（`piggy-bridge.js`，docs/06 §4）。**可选**：缺失只是 Fleet 少一条
    /// 数据面，会话本身照常可用，所以这里缺失不报错、只记日志。
    pub bridge_script: Option<PathBuf>,
    /// 追加给 pi 的环境变量。目前用于契约测试隔离配置目录
    /// （`PI_CODING_AGENT_DIR` → 一个没有 pi-subagents 的空目录，从而验证降级路径），
    /// 以及 `PIGGY_SUBAGENT_DELEGATION`（告诉桥接扩展自动激活 `subagent`）。
    pub envs: Vec<(String, String)>,
    /// 子代理委派策略文件（`piggy-subagent-policy.md`）。`Some` = 开关已打开。
    pub subagent_policy: Option<PathBuf>,
    /// **捆绑的 pi 插件目录**（`resources/pi-plugins/<name>/`，docs/06 §7）。
    ///
    /// 与 `guard_script`/`bridge_script` 的区别：那些是单文件脚本、写死用途；这里是
    /// 通用功能插件（结构化提问、计划模式……），由配置 `bundled_plugins` 决定装哪几个。
    /// 每个都以 `pi --extension <dir>` 注入（pi 的 `-e` 接受文件**或**目录）。
    pub bundled_extensions: Vec<PathBuf>,
}

/// 组装 pi 的 argv（不含二进制本身）。
///
/// 抽成纯函数是为了让「权限档位/扩展注入到底传了什么」可被单测覆盖——
/// 这层如果错了，界面显示的档位和进程实际拿到的能力就会不一致，
/// 而那是最难从现象反推的一类 bug（见 docs/15 规矩 8）。
/// worker 到底该起哪个进程：能剥掉 cmd 垫片就剥（**纯函数，便于单测**）。
///
/// ## 为什么要剥（2026-10-09）
///
/// Windows 上 pi 是 pnpm 的 `pi.cmd` 垫片，进程链是
/// `piggy → cmd.exe → node.exe`。三层里前两层只带来坏处：
///   · `Child::kill()` / `kill_on_drop(true)` **只杀得掉 cmd.exe** → 孤儿 node 握着会话文件
///     （e898b02 那个 bug 的病根，当时只能用 `taskkill /T /F` 兜）；
///   · 每开一个会话多一个进程，Windows 上还要多付一次 CreateProcess + Defender 扫描。
/// 一次性命令（标题生成 / 列模型）早就走 `direct_command` 了，worker 这条长命进程反而没有。
///
/// **解析不出来就回退到垫片本身**（行为与从前完全一致）——宁可失败得和以前一样，
/// 也不能因为解析不出就换一个跑不起来的启动器。
///
/// ⚠️ 这条**只在 Windows 上有意义**：POSIX 的 pnpm 垫片用的是 `exec node …`
/// （本机 `~/Library/pnpm/bin/pi` 实测），shell 进程被 node **替换**掉，
/// 所以既没有多余的进程、也没有孤儿问题 —— `direct_command` 也只在
/// `.cmd`/`.bat` 上接手（跨平台解析 shell 垫片是另一件事，收益只有 ~10ms，不做）。
///
/// @param pi_bin - 发现链给出的 pi 路径（可能是 `.cmd`/`.bat` 垫片）
/// @returns `(真正要起的程序, 前置参数)`
pub fn worker_command(pi_bin: &Path) -> (PathBuf, Vec<String>) {
    match crate::pi::discovery::direct_command(pi_bin) {
        Some((program, args)) => (program, args),
        None => (pi_bin.to_path_buf(), Vec::new()),
    }
}

pub fn cli_args(args: &SpawnArgs) -> Result<Vec<std::ffi::OsString>, String> {
    let mut out: Vec<std::ffi::OsString> = vec!["--mode".into(), "rpc".into()];
    match &args.session {
        SessionTarget::NoSession => out.push("--no-session".into()),
        SessionTarget::Path(p) => {
            out.push("--session".into());
            out.push(p.into());
        }
        SessionTarget::New => {}
    }
    if let Some(n) = &args.name {
        out.push("--name".into());
        out.push(n.into());
    }
    /* 工具白名单（pi `--tools` / `-t`）：限制档位靠它拿掉 shell 与写工具。
    不传 = 不限制（pi 用自身默认 + 插件工具）——这是「完全权限」档的定义。

    ⚠️ pi 的帮助原话："Applies to built-in, extension, and custom tools"。也就是说
    **`--tools` 会把捆绑插件的工具一起过滤掉**（真机验证：`--tools read,grep,find,ls`
    之下 `pi.getAllTools()` 只剩这 4 个）。要让插件在限制档位下仍然可用，就得把它申报的
    工具名**加进白名单**（名字来自插件的 `piggy-plugin.json`，见 `pi/plugins.rs`）。
    只加"这次真的注入了的"那些插件申报的名字 —— 插件没注入却把名字写进白名单，
    等于告诉模型"你有这个工具"，而它并不存在。 */
    if let Some(list) = args.permission.tool_allowlist() {
        let mut names: Vec<String> = list.split(',').map(|s| s.trim().to_string()).collect();
        let extra = crate::pi::plugins::plugin_tools_for(&args.bundled_extensions);
        for t in extra {
            if !names.iter().any(|n| n == &t) {
                names.push(t);
            }
        }
        out.push("--tools".into());
        out.push(names.join(",").into());
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
        out.push("--extension".into());
        out.push(guard.into());
    }
    // 桥接扩展（piggy-bridge）：所有档位都注入。它只注册 `/piggy:*` 命令与数据面，
    // 不注册任何工具，因此不影响 `--tools` 白名单的语义。
    if let Some(bridge) = args.bridge_script.as_ref().filter(|p| p.is_file()) {
        out.push("--extension".into());
        out.push(bridge.into());
    }
    /* 捆绑的 pi 插件（docs/06 §7）：目录形式注入，pi 的 `-e` 接受目录。
    ⚠️ 与 `--tools` 的关系：pi 的帮助写得很清楚 —— `--tools` 是"内置、扩展与自定义工具"
    的总白名单。限制档位（`tool_allowlist()` 为 Some）之下**插件工具名不在白名单里，
    所以插件的工具会被整个过滤掉**（真机验证见 docs/15 规矩 8 那条）。这里仍然注入
    （不注入的话连"插件在不在"都看不出来），但**上层必须据此提示用户**：
    想用插件工具就得用「完全权限」档，或者把工具名加进白名单。 */
    for ext in args.bundled_extensions.iter().filter(|p| p.is_dir()) {
        out.push("--extension".into());
        out.push(ext.into());
    }
    /* 限制档位**显式关掉 MCP**（pi 1.0.4 起的 `--no-mcp`）。
    ⚠️ 为什么不能只靠 `--tools`：pi 1.1.0 的判据是"白名单里有没有 `mcp__` 前缀的名字"
    （`agent-session.ts` 的 `_allowlistFiltersMcp`），所以**限制档照样会拉起用户配的
    MCP 服务器**（真机实测：`--tools read,grep,find,ls` 之下 stdio stub 仍被 spawn）。
    工具本身不会声明给模型（它们要走 `tool_search`/`codemode`，而那两个也被过滤掉了，
    pi 自己会回一条 "MCP tools are only reachable from the codemode or tool_search tool"），
    但"仅可查看"档去启动本地进程 / 打开网络出口，与这一档对用户的承诺不符。
    放在 argv 末尾：老版本 pi 不认识这个 flag 时会当未知 flag 收进 unknownFlags
    （`cli/args.ts` 的 `arg.startsWith("--")` 分支），**不会**吃掉后面的参数值。 */
    if args.permission.tool_allowlist().is_some() {
        out.push("--no-mcp".into());
    }
    // 子代理委派策略（docs/06 §6）：`--append-system-prompt` 落到系统提示词的 addendum 段，
    // 位置在所有其它段落之后 —— 它要正面对冲 pi-subagents 写在 rules 段里的
    // "Do not invoke subagents unless the operator requested delegation..."，
    // 靠后并且明确自称"这就是那个授权"。
    //
    // ⚠️ **只在「完全权限」档注入**。真机验证（2026-09-23）：`--tools read,grep,find,ls`
    // 之下 `pi.getAllTools()` 只剩这 4 个，扩展工具根本没被注册进来，
    // 连 `subagents_enable` 都不存在 —— 此时注入一段"去委派吧"的策略等于让模型去调一个
    // 不存在的工具。判定条件写在这里而不是让上层决定，是为了让它能被 `cli_args` 的单测钉死。
    if subagent_delegation_active(args) {
        let policy = args
            .subagent_policy
            .as_ref()
            .expect("subagent_delegation_active 为真时必然有 policy");
        // 缺失必须报错：开关开着却没注入，用户会以为委派已启用（静默失效）。
        if !policy.is_file() {
            return Err(format!(
                "SUBAGENT_POLICY_MISSING: 子代理委派已开启，但策略文件不存在: {}。\
                 已拒绝启动——否则开关看起来生效、实际什么都没发生。\
                 请重新安装 Piggy 或在设置里关闭该开关。",
                policy.display()
            ));
        }
        out.push("--append-system-prompt".into());
        out.push(policy.into());
    }
    Ok(out)
}

/// 打开子代理委派时注入的环境变量名（桥接扩展 `packages/piggy-bridge` 里同名常量）。
pub const DELEGATION_ENV: &str = "PIGGY_SUBAGENT_DELEGATION";

/// 告诉 pi 扩展"宿主是谁"（`pi-ask` 用它决定走提问卡还是降级成逐个对话框）。
///
/// 值就是宿主名 `piggy`；扩展只判"有没有这个变量"，不依赖版本号 ——
/// 需要版本协商时再看信封前缀（`piggy:ask:v1:`）那一层。
pub const HOST_ENV: &str = "PIGGY_HOST";

/// `PIGGY_HOST` 的值。
pub const HOST_NAME: &str = "piggy";

/// 子代理委派此刻是否**真的**生效（开关打开 **且** 档位能让扩展工具存在）。
///
/// 抽出来是为了让「界面显示的开关状态」与「进程实际拿到的能力」用同一个判据——
/// 两者分叉会让用户以为开了、实际没开（docs/15 规矩 8 同一类问题）。
pub fn subagent_delegation_active(args: &SpawnArgs) -> bool {
    args.permission == PermissionMode::Full && args.subagent_policy.is_some()
}

/// 交给 pi 进程的环境变量：`SpawnArgs.envs` 加上委派开关。
///
/// 单独成函数（而不是塞进 `spawn_worker`）是为了让"开关打开时到底传了什么"可被单测覆盖。
pub fn spawn_envs(args: &SpawnArgs) -> Vec<(String, String)> {
    let mut envs = args.envs.clone();
    // 宿主标识：让捆绑的插件能分辨"在 Piggy 里跑"还是"在 pi TUI 里跑"（见 HOST_ENV）
    if !envs.iter().any(|(k, _)| k == HOST_ENV) {
        envs.push((HOST_ENV.to_string(), HOST_NAME.to_string()));
    }
    if subagent_delegation_active(args) {
        // 桥接扩展据此在首个模型请求前激活 `subagent`，
        // 省掉模型自己调 `subagents_enable` 的那一轮。
        envs.push(("PIGGY_SUBAGENT_DELEGATION".to_string(), "1".to_string()));
    }
    envs
}

pub async fn spawn_worker(tab_id: &str, args: SpawnArgs, sink: Arc<dyn EventSink>) -> Result<Worker, String> {
    let argv = cli_args(&args)?;
    let (program, prefix) = worker_command(&args.pi_bin);
    let mut cmd = tokio::process::Command::new(&program);
    for a in prefix {
        cmd.arg(a);
    }
    cmd.current_dir(&args.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env("NO_COLOR", "1");
    for a in &argv {
        cmd.arg(a);
    }
    for (k, v) in spawn_envs(&args) {
        cmd.env(k, v);
    }
    if args.permission.needs_path_guard() {
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
    let mut stdin = child.stdin.take().ok_or_else(|| "pi stdin unavailable".to_string())?;
    let stdout = child.stdout.take().ok_or_else(|| "pi stdout unavailable".to_string())?;
    let stderr = child.stderr.take().ok_or_else(|| "pi stderr unavailable".to_string())?;

    let (stdin_tx, stdin_rx) = tokio::sync::mpsc::channel::<String>(64);
    let (state_tx, state_rx) = tokio::sync::watch::channel(WorkerState::Spawning);

    let worker: Worker = Arc::new(WorkerInner {
        tab_id: std::sync::Arc::new(std::sync::RwLock::new(tab_id.to_string())),
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
        tokio::spawn(async move {
            /* ⚠️ 不再把 tab_id 拷进闭包：reader 与合帧器都从 `worker.tab_slot()` 读
            （预热池会把一个已起的进程重绑给另一个标签页，事件必须跟着走）。 */
            run_reader(w, sink2, stdout).await;
        });
    }

    Ok(worker)
}

async fn run_reader(worker: Worker, sink: Arc<dyn EventSink>, stdout: ChildStdout) {
    let mut decoder = JsonlDecoder::new();
    let mut coalescer = FrameCoalescer::new(worker.tab_slot(), sink.clone());
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
                            handle_line(&line, &worker, &sink, &mut coalescer).await;
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
        handle_line(&line, &worker, &sink, &mut coalescer).await;
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
    /* 退出通知的通道名也要读**当前**绑定（预热池重绑之后，这个进程属于新标签页；
    用 spawn 时的 id 会把"进程挂了"报到旧标签页上）。 */
    let tab_id = worker.tab_id();
    sink.emit_json(
        &format!("pi:state:{tab_id}"),
        json!({
            "state": final_state,
            "exitCode": exit_code,
            "stderrTail": stderr_tail.last().cloned(),
        }),
    );
}

/// 处理一行 pi 事件。
///
/// `tab` **每次调用都从 worker 读**（`worker.tab_id()`），不是参数：预热池会把一个
/// 已经起好的进程重绑给另一个标签页，而事件通道名必须跟着新绑定走。
async fn handle_line(line: &str, worker: &Worker, sink: &Arc<dyn EventSink>, coalescer: &mut FrameCoalescer) {
    let tab = worker.tab_id();
    let tab = tab.as_str();
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
            .and_then(|x| x.as_str().and_then(|s| s.parse::<u64>().ok()).or_else(|| x.as_u64()));
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

/* ---------------- 测试：argv 组装（权限档位 + 扩展注入） ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn args(permission: PermissionMode) -> SpawnArgs {
        SpawnArgs {
            cwd: std::env::temp_dir(),
            pi_bin: PathBuf::from("/usr/bin/true"),
            session: SessionTarget::New,
            name: None,
            permission,
            guard_script: None,
            bridge_script: None,
            envs: Vec::new(),
            subagent_policy: None,
            bundled_extensions: Vec::new(),
        }
    }

    /// 生成一份真实的策略文件（`cli_args` 会校验它存在）。
    fn policy_file(dir: &std::path::Path) -> PathBuf {
        let p = dir.join("piggy-subagent-policy.md");
        std::fs::write(&p, "# policy").unwrap();
        p
    }

    fn argv(args: &SpawnArgs) -> Vec<String> {
        cli_args(args)
            .expect("argv 组装失败")
            .into_iter()
            .map(|a| a.to_string_lossy().into_owned())
            .collect()
    }

    fn tmp_file(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(name);
        std::fs::write(&p, "// test").unwrap();
        p
    }

    #[test]
    fn full_permission_passes_no_tools_flag() {
        let a = args(PermissionMode::Full);
        let v = argv(&a);
        assert_eq!(v, vec!["--mode", "rpc"]);
        assert!(!v.iter().any(|x| x == "--tools"));
    }

    #[test]
    fn restricted_modes_carry_the_allowlist() {
        assert!(argv(&args(PermissionMode::ReadOnly)).contains(&"read,grep,find,ls".to_string()));
        /* 插件的工具名要**加进**白名单（否则 `--tools` 把它们整个过滤掉，
        插件等于没注入）。名字来自插件的 `piggy-plugin.json`。 */
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("pi-ask");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("piggy-plugin.json"),
            r#"{"name":"pi-ask","entry":"index.js","tools":["ask_user_question","exit_plan_mode"]}"#,
        )
        .unwrap();
        std::fs::write(dir.join("index.js"), "// x\n").unwrap();
        let mut a = args(PermissionMode::ReadOnly);
        a.bundled_extensions = vec![dir];
        let with_plugin = argv(&a);
        assert!(
            with_plugin.contains(&"read,grep,find,ls,ask_user_question,exit_plan_mode".to_string()),
            "插件工具没进白名单：{with_plugin:?}"
        );
        // Workspace 档必须有守卫才允许组装 argv（缺守卫是硬错误，见下一个测试）
        let mut a = args(PermissionMode::Workspace);
        a.guard_script = Some(tmp_file("piggy-test-guard-allowlist.js"));
        let workspace = argv(&a);
        assert!(workspace.contains(&"read,grep,find,ls,write,edit".to_string()));
        assert!(
            !workspace.iter().any(|x| x.contains("bash")),
            "不应放开 shell: {workspace:?}"
        );
    }

    #[test]
    fn workspace_without_the_guard_refuses_to_start() {
        // 守卫缺失必须是硬错误：静默启动 = 用户以为有边界、实际没有
        let err = cli_args(&args(PermissionMode::Workspace)).unwrap_err();
        assert!(err.starts_with("GUARD_SCRIPT_MISSING"), "{err}");
    }

    #[test]
    fn workspace_with_the_guard_injects_it() {
        let mut a = args(PermissionMode::Workspace);
        a.guard_script = Some(tmp_file("piggy-test-guard.js"));
        let v = argv(&a);
        let idx = v.iter().position(|x| x == "--extension").expect("应注入守卫");
        assert!(v[idx + 1].ends_with("piggy-test-guard.js"));
    }

    #[test]
    fn bridge_is_injected_in_every_permission_mode() {
        // 桥接只注册命令、不注册工具，所以不受 --tools 白名单影响，档位不该改变它是否注入
        let bridge = tmp_file("piggy-test-bridge.js");
        for mode in [PermissionMode::ReadOnly, PermissionMode::Full] {
            let mut a = args(mode);
            a.bridge_script = Some(bridge.clone());
            let v = argv(&a);
            let idx = v.iter().position(|x| x == "--extension").expect("应注入桥接");
            assert!(v[idx + 1].ends_with("piggy-test-bridge.js"), "{mode:?}");
        }
    }

    #[test]
    fn both_extensions_are_injected_side_by_side() {
        let mut a = args(PermissionMode::Workspace);
        a.guard_script = Some(tmp_file("piggy-test-guard2.js"));
        a.bridge_script = Some(tmp_file("piggy-test-bridge2.js"));
        let v = argv(&a);
        assert_eq!(v.iter().filter(|x| *x == "--extension").count(), 2, "{v:?}");
    }

    /// 捆绑插件：目录形式注入（pi 的 `-e` 接受目录），缺失的目录不注入也不报错。
    #[test]
    fn bundled_plugin_dirs_are_injected_and_missing_ones_are_skipped() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("pi-ask");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.js"), "export default () => {}\n").unwrap();
        let mut a = args(PermissionMode::Full);
        a.bundled_extensions = vec![dir.clone(), tmp.path().join("does-not-exist")];
        let argv = cli_args(&a).unwrap();
        let rendered: Vec<String> = argv.iter().map(|s| s.to_string_lossy().to_string()).collect();
        // 出现的次数：一次是 `--extension`，紧跟其后是目录本身
        let ext_uses = rendered
            .windows(2)
            .filter(|w| w[0] == "--extension" && w[1] == dir.to_string_lossy())
            .count();
        assert_eq!(ext_uses, 1, "插件目录没有被 -e 注入：{rendered:?}");
        assert!(
            !rendered.iter().any(|s| s.contains("does-not-exist")),
            "不存在的插件目录不该出现在 argv 里：{rendered:?}"
        );
    }

    /// 限制档位下插件**照样注入**（工具会不会被 `--tools` 过滤掉是另一件事，
    /// 见 `plugins.rs` 顶部与 docs/15 规矩 8；但"注入了什么"必须能从 argv 看出来）。
    #[test]
    fn bundled_plugins_are_injected_in_restricted_modes_too() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("pi-ask");
        std::fs::create_dir_all(&dir).unwrap();
        let mut a = args(PermissionMode::ReadOnly);
        a.bundled_extensions = vec![dir.clone()];
        let argv = cli_args(&a).unwrap();
        assert!(argv.iter().any(|s| s == &std::ffi::OsString::from(&dir)));
    }

    /// **覆盖型插件不许把限制档变成可写档**（2026-10-09 补，argv 级）。
    ///
    /// `plugins.rs` 那边有单测盯着 `plugin_tools_for`；这条盯的是**最终 argv**：
    /// 清单写了 `"allowlist": false` 的插件，它的 `write`/`edit` 绝不能出现在
    /// 「仅可查看」档的 `--tools` 里。两处都要，是因为"合并发生在 `cli_args` 里"
    /// 这件事只有这条能证明（以前的白名单测试只钉静态常量）。
    #[test]
    fn override_type_plugin_does_not_widen_a_restricted_allowlist() {
        let tmp = tempfile::tempdir().unwrap();
        let over = tmp.path().join("pi-guardrails");
        std::fs::create_dir_all(&over).unwrap();
        std::fs::write(over.join("index.js"), "export default function () {}\n").unwrap();
        std::fs::write(
            over.join("piggy-plugin.json"),
            r#"{"name":"pi-guardrails","entry":"index.js","tools":["write","edit"],"allowlist":false}"#,
        )
        .unwrap();
        // 一个正常插件，证明"别的插件的名字还是照旧合并"
        let normal = tmp.path().join("pi-ask");
        std::fs::create_dir_all(&normal).unwrap();
        std::fs::write(normal.join("index.js"), "export default function () {}\n").unwrap();
        std::fs::write(
            normal.join("piggy-plugin.json"),
            r#"{"name":"pi-ask","entry":"index.js","tools":["ask_user_question"]}"#,
        )
        .unwrap();

        let mut a = args(PermissionMode::ReadOnly);
        a.bundled_extensions = vec![over, normal];
        let argv = argv(&a);
        let tools = argv
            .windows(2)
            .find(|w| w[0] == "--tools")
            .map(|w| w[1].clone())
            .expect("限制档必须带 --tools");
        assert!(
            !tools.contains("write") && !tools.contains("edit"),
            "覆盖型插件的 write/edit 混进了「仅可查看」的白名单：{tools}"
        );
        assert!(tools.contains("ask_user_question"), "正常插件的工具名该合并：{tools}");
    }

    /// worker 启动命令：**能剥掉 cmd 垫片就剥**（Windows 上那一层 cmd.exe 是孤儿进程的真凶），
    /// 剥不出来时原样回退到垫片（行为与从前一致）。
    ///
    /// 用例在 macOS 上也能跑：`direct_command` 只做**文本解析 + 存在性**检查，
    /// 不要求那个 `.cmd` 真能被 CreateProcess 执行（路径分隔符的归一化见 `discovery.rs`）。
    #[test]
    fn worker_command_prefers_the_real_node_over_the_cmd_shim() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("node.exe"), b"MZ fake").unwrap();
        std::fs::write(dir.join("cli.js"), "// entry").unwrap();
        let shim = dir.join("pi.cmd");
        std::fs::write(
            &shim,
            "@IF EXIST \"%~dp0\\node.exe\" (\r\n \"%~dp0\\node.exe\" \"%~dp0\\cli.js\" %*\r\n) ELSE (\r\n node \"%~dp0\\cli.js\" %*\r\n)\r\n",
        )
        .unwrap();
        let (program, prefix) = worker_command(&shim);
        assert_eq!(program, dir.join("node.exe"), "没有剥掉垫片那一层");
        assert_eq!(prefix, vec![dir.join("cli.js").to_string_lossy().into_owned()]);

        // 剥不出来（脚本不在 / 不是 .cmd）→ 回退到原路径
        let bare = dir.join("pi");
        std::fs::write(&bare, "#!/bin/sh\n").unwrap();
        assert_eq!(worker_command(&bare), (bare.clone(), Vec::new()));
        let exe = dir.join("pi.exe");
        std::fs::write(&exe, b"MZ fake").unwrap();
        assert_eq!(worker_command(&exe), (exe.clone(), Vec::new()));
    }

    #[test]
    fn restricted_modes_disable_mcp_explicitly() {
        /* `--tools` 在 pi 1.1.0 上**拦不住 MCP**（判据是"白名单里有没有 mcp__ 前缀"），
        所以限制档必须显式带上 `--no-mcp`；完全权限档不带（那是"用你自己的配置"）。 */
        for mode in [PermissionMode::ReadOnly, PermissionMode::Workspace] {
            let mut a = args(mode);
            // 「工作区内修改」档要求守卫脚本存在（缺失是 fail-closed），这里给一个真的
            a.guard_script = Some(tmp_file("piggy-guard-test.js"));
            let argv = argv(&a);
            assert!(argv.contains(&"--no-mcp".to_string()), "{mode:?} 档没关 MCP");
            // 位置：末尾（老版本 pi 会把不认识的 `--flag` 收进 unknownFlags，
            // 只有后面跟的不是值时才当布尔 —— 放末尾最安全）
            assert_eq!(argv.last().map(String::as_str), Some("--no-mcp"));
        }
        assert!(
            !argv(&args(PermissionMode::Full)).contains(&"--no-mcp".to_string()),
            "完全权限档不该关 MCP"
        );
    }

    #[test]
    fn missing_bridge_is_skipped_not_fatal() {
        // 资源缺失（打包漏带/被删）时桥接静默缺席，但会话必须能起来
        let mut a = args(PermissionMode::Full);
        a.bridge_script = Some(PathBuf::from("/nonexistent/piggy-bridge.js"));
        assert!(!argv(&a).iter().any(|x| x == "--extension"));
    }

    #[test]
    fn session_and_name_flags_keep_their_order() {
        let mut a = args(PermissionMode::Full);
        a.session = SessionTarget::Path("/tmp/s.jsonl".into());
        a.name = Some("fleet:abc/scout".into());
        assert_eq!(
            argv(&a),
            vec![
                "--mode",
                "rpc",
                "--session",
                "/tmp/s.jsonl",
                "--name",
                "fleet:abc/scout"
            ]
        );
        let mut b = args(PermissionMode::Full);
        b.session = SessionTarget::NoSession;
        assert!(argv(&b).contains(&"--no-session".to_string()));
    }

    /* ---------------- 子代理委派开关（docs/06 §6） ---------------- */

    #[test]
    fn delegation_off_by_default_injects_nothing() {
        // 默认关：不注入策略、不传环境变量。判定与档位无关，因为压根没开。
        // （Workspace 档需要守卫脚本，它由 `delegation_is_silently_off_in_restricted_modes` 覆盖）
        for mode in [PermissionMode::ReadOnly, PermissionMode::Full] {
            let a = args(mode);
            assert!(!argv(&a).contains(&"--append-system-prompt".to_string()), "{mode:?}");
            assert!(spawn_envs(&a).iter().all(|(k, _)| k != DELEGATION_ENV), "{mode:?}");
            assert!(!subagent_delegation_active(&a), "{mode:?}");
        }
    }

    #[test]
    fn delegation_injects_policy_and_env_in_full_mode() {
        let tmp = tempfile::tempdir().unwrap();
        let mut a = args(PermissionMode::Full);
        a.subagent_policy = Some(policy_file(tmp.path()));

        assert_eq!(
            argv(&a),
            vec![
                "--mode",
                "rpc",
                "--append-system-prompt",
                a.subagent_policy.as_ref().unwrap().to_str().unwrap(),
            ]
        );
        assert!(subagent_delegation_active(&a));
        assert_eq!(
            spawn_envs(&a).iter().find(|(k, _)| k == DELEGATION_ENV),
            Some(&(DELEGATION_ENV.to_string(), "1".to_string()))
        );
    }

    #[test]
    fn delegation_is_silently_off_in_restricted_modes() {
        // 真机验证（2026-09-23）：--tools 白名单会把扩展工具整个过滤掉，
        // `pi.getAllTools()` 里连 subagents_enable 都没有。此时注入"去委派吧"的策略
        // 等于让模型去调一个不存在的工具 —— 所以限制档位下**不注入**。
        let tmp = tempfile::tempdir().unwrap();
        for mode in [PermissionMode::ReadOnly, PermissionMode::Workspace] {
            let mut a = args(mode);
            a.subagent_policy = Some(policy_file(tmp.path()));
            if mode == PermissionMode::Workspace {
                // 守卫脚本缺失会让 Workspace 直接拒绝启动，先补上
                let g = tmp.path().join("piggy-guard.js");
                std::fs::write(&g, "// guard").unwrap();
                a.guard_script = Some(g);
            }
            assert!(!argv(&a).contains(&"--append-system-prompt".to_string()), "{mode:?}");
            assert!(spawn_envs(&a).iter().all(|(k, _)| k != DELEGATION_ENV), "{mode:?}");
            assert!(!subagent_delegation_active(&a), "{mode:?}");
        }
    }

    #[test]
    fn delegation_with_a_missing_policy_file_refuses_to_start() {
        // 开关开着却没注入 = 用户以为委派已启用、实际什么都没发生（静默失效）。
        // 这是本项目最不能接受的失败方式，所以必须硬错误。
        let tmp = tempfile::tempdir().unwrap();
        let mut a = args(PermissionMode::Full);
        a.subagent_policy = Some(tmp.path().join("does-not-exist.md"));
        let err = cli_args(&a).unwrap_err();
        assert!(err.starts_with("SUBAGENT_POLICY_MISSING"), "{err}");
    }

    /// 宿主标识不许覆盖调用方显式传进来的值（契约测试可能自己指定宿主）。
    #[test]
    fn host_env_is_not_clobbered() {
        let mut a = args(PermissionMode::Full);
        a.envs = vec![(HOST_ENV.into(), "custom".into())];
        let envs = spawn_envs(&a);
        assert_eq!(
            envs.iter().filter(|(k, _)| k == HOST_ENV).count(),
            1,
            "PIGGY_HOST 只许出现一次"
        );
        assert!(envs.iter().any(|(k, v)| k == HOST_ENV && v == "custom"));
    }

    #[test]
    fn delegation_env_does_not_clobber_existing_envs() {
        // 契约测试用 envs 隔离 PI_CODING_AGENT_DIR；两个都要在
        let tmp = tempfile::tempdir().unwrap();
        let mut a = args(PermissionMode::Full);
        a.subagent_policy = Some(policy_file(tmp.path()));
        a.envs = vec![("PI_CODING_AGENT_DIR".into(), "/tmp/empty".into())];
        let envs = spawn_envs(&a);
        assert!(envs
            .iter()
            .any(|(k, v)| k == "PI_CODING_AGENT_DIR" && v == "/tmp/empty"));
        assert!(envs.iter().any(|(k, _)| k == DELEGATION_ENV));
        // 宿主标识也一定在（插件靠它分辨"在 Piggy 里跑"还是"在 pi TUI 里跑"）
        assert!(envs.iter().any(|(k, v)| k == HOST_ENV && v == HOST_NAME));
        assert_eq!(envs.len(), 3);
    }
}
