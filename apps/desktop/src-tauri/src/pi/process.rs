//! 进程监督（docs/01 §2.3、02 §2、03 §2.3）：
//! spawn → stdin 单写者任务 → stderr 环形缓冲 → stdout reader（分帧/路由/合帧）。
//! reader 循环 = `select! { chunk, 16ms tick }`：chunk 驱动解析，tick 驱动合帧冲刷。

use crate::events::EventSink;
use crate::pi::client::{Worker, WorkerInner, WorkerState};
use crate::pi::coalesce::FrameCoalescer;
use crate::pi::codec::JsonlDecoder;
use crate::pi::permission::PermissionMode;
use crate::pi::protocol::{classify, Ame, PiEvent, DELTA_KINDS};
use crate::plain_path;
use crate::process_ext::NoConsoleWindow;
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
    /// 权限档位（见 `pi/permission.rs`）。
    ///
    /// 2026-11-07 起档位**不再**由 `--tools` 决定（那会让升档必须重启）：
    /// 工具全量注册，守卫扩展按本档位在运行期 `pi.setActiveTools()` 收窄。
    /// `permission` 仍然决定 spawn 时的 `--no-mcp` 与守卫注入。
    pub permission: PermissionMode,
    /// 运行期档位文件（`~/.piggy/permission/<tab>.json`）。守卫每次工具调用前读它。
    /// `None` = 运行期切档不可用（仅测试/老调用点），此时切档必须重启。
    pub permission_file: Option<PathBuf>,
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
    /* 委派的前置条件：限制档位的委派**必须**有 bridge。
    子代理的 capability ceiling 与 required guard 都是 bridge 在父进程里注册的。
    bridge 缺失时如果仍然把 subagent 加进运行期工具集，子代理会按 agent 自己声明的
    tools 启动（worker 带 bash）——这是权限提升。Full 档不需要 bridge（本来就不限制），
    所以只拦限制档。 */
    if subagent_delegation_active(args)
        && args.permission.needs_path_guard()
        && !args.bridge_script.as_ref().is_some_and(|p| p.is_file())
    {
        return Err("SUBAGENT_BRIDGE_MISSING: 限制档位开启子代理委派需要 bridge 扩展 \
             resources/piggy-bridge.js，但未找到。已拒绝启动——否则子代理无法继承父会话权限。\
             请重新安装 Piggy，或在设置里关闭子代理委派。"
            .to_string());
    }
    /* 2026-11-07：不再传 `--tools`（docs/17 §2.1）。
    pi 的 `--tools` 在**注册期**过滤（`_isAllowedTool` 把工具从 registry 删掉），
    被过滤掉的工具事后 `pi.setActiveTools()` 也点不亮 —— 升档就只剩"重启"一条路。
    现在全量注册，由守卫扩展按档位在运行期收窄（`before_agent_start` + `tool_call` 双保险）。
    限制档仍然传 `--no-mcp`：不想让"仅可查看"的会话去拉起本地 MCP 进程/开网络出口。 */
    // 路径守卫（pi `-e`）：两个限制档都需要——
    // 「工作区内修改」拦写边界，「仅可查看」拦读敏感目录（`~/.pi` 里存着 API key 明文，
    // pi 的读工具接受绝对路径与 `~` 展开，不拦就会被 prompt injection 读进模型上下文）。
    // 脚本缺失时**必须报错而不是静默降级**——否则用户以为限制还在、实际没有，
    // 这种"看起来安全"的假象比直接启动失败更危险。
    // 守卫扩展：**所有档位**都注入（2026-11-07 起）。
    // 限制档靠它拦写边界/敏感目录 + 收窄工具集；完全权限档靠它保住"运行期还能切回限制档"
    // 这条能力（切回时它要能立刻 setActiveTools）。完全权限档缺脚本只降级（打不开运行期
    // 收窄），限制档缺脚本仍然 fail-closed。
    match args.guard_script.as_ref().filter(|p| p.is_file()) {
        Some(guard) => {
            out.push("--extension".into());
            out.push(plain_path(guard).into());
        }
        None if args.permission.needs_path_guard() => {
            return Err("GUARD_SCRIPT_MISSING: 限制档位（仅可查看 / 工作区内修改）需要守卫扩展 \
                 resources/piggy-guard.js，但未找到。已拒绝以无边界的方式启动——\
                 请改用「完全权限」，或修复安装。"
                .to_string());
        }
        None => {
            eprintln!("[piggy] 警告：完全权限档没找到 piggy-guard.js，运行期切档将退化为重启");
        }
    }
    // 桥接扩展（piggy-bridge）：所有档位都注入。它只注册 `/piggy:*` 命令与数据面，
    // 不注册任何工具，因此不影响运行期工具集（`setActiveTools` 的名单）。
    if let Some(bridge) = args.bridge_script.as_ref().filter(|p| p.is_file()) {
        out.push("--extension".into());
        out.push(plain_path(bridge).into());
    }
    /* 捆绑的 pi 插件（docs/06 §7）：目录形式注入，pi 的 `-e` 接受目录。
    ⚠️ 与运行期工具集的关系（2026-11-07 起）：插件工具会被**注册**，但限制档的
    `setActiveTools` 名单里没有它们 —— 模型看不见、`tool_call` 也拦。
    要放开某插件的工具，得把 `piggy-plugin.json` 申报的名字并进 `active_tools_for`
    （`pi/permission.rs`，`allowlist: false` 的覆盖型插件被排除）。 */
    for ext in args.bundled_extensions.iter().filter(|p| p.is_dir()) {
        out.push("--extension".into());
        // ⚠️ 必须摘掉 verbatim 前缀：这一批是**目录形式**的扩展，而 pi（node）加载目录形式的
        // `--extension` 时不认 `\\?\` —— 报 `EISDIR ... lstat 'C:'` 然后 exit(1)（真机 A/B 见
        // docs/15 §4.4）。单文件形式反而没事，所以只有这几条会让 pi 起不来。
        // 这里再摘一次是**兜底**：bundled_extensions 由上层传下来，谁传都可能带前缀。
        out.push(plain_path(ext).into());
    }
    /* 限制档位**显式关掉 MCP**（pi 1.0.4 起的 `--no-mcp`）。
    2026-11-07 取消 `--tools` 之后这条更关键：MCP 工具一旦注册进 registry，
    `setActiveTools()` 就只是"不声明"，进程该连的还是会连。限制档的承诺是
    "不启动本地 MCP 进程 / 不开网络出口"，只能靠 `--no-mcp` 在启动期拿掉。
    （代价：从限制档升到「完全权限」且真配了 MCP 时，必须重启换进程 —— 见 registry 的
    `needs_restart`；没配 MCP 的机器不受影响。）
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
    // 2026-10-30 起**所有权限档位都可注入**：限制档位的 `--tools` 白名单里已经补上了
    // `subagent,subagents_enable`（见上面的 allowlist 块），而子代理实际能用的工具
    // 由 bridge 注册的 capability ceiling 收窄到父会话同一套，并强制子会话加载守卫扩展。
    // 换句话说：允许委派，但子代理**继承**父会话的权限，不会绕过只读/工作区边界。
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
/// 父会话的权限档位。bridge 用它判断"要不要给子代理注册 capability ceiling"。
pub const PERMISSION_ENV: &str = "PIGGY_PERMISSION_MODE";
/// 运行期档位文件路径（守卫扩展读它，见 `pi/permission.rs::write_mode_file`）。
pub const PERMISSION_FILE_ENV: &str = "PIGGY_PERMISSION_FILE";
/// 档位文件缺失时守卫的兜底工具集（逗号分隔；仅限制档位有）。
pub const PERMISSION_TOOLS_ENV: &str = "PIGGY_PERMISSION_TOOLS";
/// 父会话允许的工具名（逗号分隔）。bridge 把同一份名单注册成子代理的 ceiling。
pub const SUBAGENT_TOOLS_ENV: &str = "PIGGY_SUBAGENT_ALLOWED_TOOLS";
/// 守卫扩展的绝对路径。bridge 把它注册成子会话的 required extension。
pub const GUARD_SCRIPT_ENV: &str = "PIGGY_GUARD_SCRIPT";
/// 委派开关打开时，限制档位要额外加进**运行期工具集**的两个扩展工具名。
pub const DELEGATION_TOOLS: [&str; 2] = ["subagent", "subagents_enable"];

/// 告诉 pi 扩展"宿主是谁"（`pi-ask` 用它决定走提问卡还是降级成逐个对话框）。
///
/// 值就是宿主名 `piggy`；扩展只判"有没有这个变量"，不依赖版本号 ——
/// 需要版本协商时再看信封前缀（`piggy:ask:v1:`）那一层。
pub const HOST_ENV: &str = "PIGGY_HOST";

/// `PIGGY_HOST` 的值。
pub const HOST_NAME: &str = "piggy";

/// 子代理委派此刻是否**真的**生效（开关打开，策略文件已登记）。
///
/// 2026-10-30 起不再要求「完全权限」：限制档位通过
/// 运行期工具集补上 `subagent,subagents_enable`，bridge 再把父会话的工具名
/// 注册成子代理 capability ceiling，并强制子会话加载守卫扩展。子代理继承
/// 父会话权限，而不是继承"完全权限"。
///
/// 抽出来是为了让「界面显示的开关状态」与「进程实际拿到的能力」用同一个判据——
/// 两者分叉会让用户以为开了、实际没开（docs/15 规矩 8 同一类问题）。
pub fn subagent_delegation_active(args: &SpawnArgs) -> bool {
    args.subagent_policy.is_some()
}

/// 本档位在运行期应该**声明给模型**的工具集（`None` = 不限制）。
///
/// 单一真相：spawn 时写进档位文件、切档时重写同一份文件；守卫只消费不推导。
/// 这样"界面显示的档位"与"进程实际声明的工具"不会各算各的（docs/15 规矩 8）。
pub fn active_tools(args: &SpawnArgs) -> Option<Vec<String>> {
    let delegation: &[&str] = if subagent_delegation_active(args) {
        &DELEGATION_TOOLS
    } else {
        &[]
    };
    crate::pi::permission::active_tools_for(args.permission, &args.bundled_extensions, delegation)
}

/// 交给 pi 进程的环境变量：`SpawnArgs.envs` 加上权限/守卫/委派开关。
///
/// 单独成函数（而不是塞进 `spawn_worker`）是为了让"开关打开时到底传了什么"可被单测覆盖。
pub fn spawn_envs(args: &SpawnArgs) -> Vec<(String, String)> {
    let mut envs = args.envs.clone();
    let mut push = |key: &str, value: String| {
        if !envs.iter().any(|(k, _)| k == key) {
            envs.push((key.to_string(), value));
        }
    };

    // 宿主标识：让捆绑的插件能分辨"在 Piggy 里跑"还是"在 pi TUI 里跑"（见 HOST_ENV）
    push(HOST_ENV, HOST_NAME.to_string());
    // bridge 靠它决定给子代理注册哪一档 capability ceiling（Full = 不限制，不注册）。
    push(PERMISSION_ENV, args.permission.as_str().to_string());
    // 守卫扩展靠它读**运行期**档位（spawn 期档位是 env，之后以文件为准）。
    if let Some(path) = &args.permission_file {
        push(PERMISSION_FILE_ENV, plain_path(path).to_string_lossy().into_owned());
    }
    // 档位文件的**兜底**：文件被清理/写坏时，守卫至少还能拿到 spawn 时的工具集。
    // 没有它，守卫只能 fail-closed（一个工具都不给），会话会不可用。
    if let Some(active) = active_tools(args) {
        push(PERMISSION_TOOLS_ENV, active.join(","));
    }
    // 限制档位的子会话必须加载守卫；bridge 用这个路径注册 required child extension。
    // 只传真实存在的文件；缺失时 cli_args 已经会 fail-closed，轮不到 spawn。
    if args.permission.needs_path_guard() {
        if let Some(guard) = args.guard_script.as_ref().filter(|p| p.is_file()) {
            push(GUARD_SCRIPT_ENV, plain_path(guard).to_string_lossy().into_owned());
        }
    }
    if subagent_delegation_active(args) {
        // 桥接扩展据此在首个模型请求前激活 `subagent`，
        // 省掉模型自己调 `subagents_enable` 的那一轮。
        push(DELEGATION_ENV, "1".to_string());
        // 子代理 ceiling：与父会话同一套工具名（不含委派工具本身，禁止嵌套委派）。
        if let Some(list) = args.permission.tool_allowlist() {
            push(SUBAGENT_TOOLS_ENV, list.to_string());
        }
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
    // 写侧白名单根 = 会话 cwd。守卫 fail-closed：该变量丢失则拒绝一切写入
    // （读侧敏感目录判定不依赖它，基准是主目录，见 piggy-guard.js 的 checkRead）。
    // 完全权限档也传：运行期切回限制档时，守卫要靠它立刻拿到边界。
    cmd.env("PIGGY_GUARD_ROOTS", &args.cwd);
    // 打包版是 GUI 子系统，每个 pi 控制台子进程都会弹一个黑框（Windows）。
    cmd.no_console_window();
    // 运行期档位文件：守卫的**唯一**档位真相（spawn 期先写一次初值）。
    if let Some(path) = &args.permission_file {
        let active = active_tools(&args);
        crate::pi::permission::write_mode_file(path, args.permission, active.as_deref()).map_err(|e| {
            format!(
                "PERMISSION_FILE_WRITE_FAILED: 写运行期档位文件失败: {}（{e}）",
                path.display()
            )
        })?;
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
        tokio::spawn(async move {
            /* `tab_id` 在 spawn 时定死（2026-10-17 去掉共享槽，见 `client.rs` 的
            `tab_id` 字段注释）：合帧器只读一次，不再每帧拿锁。 */
            run_reader(w, sink2, stdout).await;
        });
    }

    Ok(worker)
}

async fn run_reader(worker: Worker, sink: Arc<dyn EventSink>, stdout: ChildStdout) {
    let mut decoder = JsonlDecoder::new();
    let mut coalescer = FrameCoalescer::new(worker.tab_id(), sink.clone());
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
    /* 先定终态、再收 pending、最后收尸（2026-10-28 顺序修正，H4）：
    状态置成 Crashed/Stopped 之后，`ready_worker` 的快路径**立刻**不再发放这个 worker；
    若先收 pending，"收完 → 置态"之间插进来的请求只能靠 `wait_for_response` 的
    终态监听兜底。child 回收放最后——shutdown 持有 child 锁做 taskkill 时这里要等它，
    不能让收尸推迟终态的公布。 */
    let final_state = if worker.state() == WorkerState::Stopped {
        WorkerState::Stopped
    } else {
        worker.set_state(WorkerState::Crashed);
        WorkerState::Crashed
    };
    worker.fail_all_pending("pi worker exited").await;
    // 回收子进程句柄并 wait（防僵尸）
    let exit_code = if let Some(mut child) = worker.child.lock().await.take() {
        child.wait().await.ok().and_then(|s| s.code()).unwrap_or(-1)
    } else {
        -1
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
            sink.emit_json(&format!("pi:commit:{tab}"), coalescer.stamp(v));
        }
        PiEvent::AgentSettled => {
            if worker.state() != WorkerState::Stopped {
                worker.set_state(WorkerState::Ready);
            }
            coalescer.flush().await;
            sink.emit_json(&format!("pi:commit:{tab}"), coalescer.stamp(v));
        }
        PiEvent::ExtensionUiRequest { .. } => {
            sink.emit_json(&format!("pi:ui-req:{tab}"), v);
        }
        _ => {
            coalescer.flush().await;
            sink.emit_json(&format!("pi:commit:{tab}"), coalescer.stamp(v));
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
            permission_file: None,
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

    /// 2026-11-07 起：**任何档位都不传 `--tools`**（docs/17 §2.1）。
    /// 传了就等于在注册期裁掉工具，`setActiveTools()` 再也点不亮它们 —— 升档只能重启。
    #[test]
    fn no_permission_mode_passes_a_tools_flag() {
        for mode in [
            PermissionMode::ReadOnly,
            PermissionMode::Workspace,
            PermissionMode::Full,
        ] {
            let mut a = args(mode);
            a.guard_script = Some(tmp_file("piggy-test-no-tools-flag.js"));
            let v = argv(&a);
            assert!(!v.iter().any(|x| x == "--tools"), "{mode:?} 仍传了 --tools: {v:?}");
        }
    }

    /// 运行期档位工具集（守卫 `setActiveTools` 的入参）：矩阵与插件/委派合并。
    #[test]
    fn active_tools_matrix_covers_plugins_and_delegation() {
        use crate::pi::permission::active_tools_for;

        assert_eq!(active_tools_for(PermissionMode::Full, &[], &[]), None);
        assert_eq!(
            active_tools_for(PermissionMode::ReadOnly, &[], &[]),
            Some(
                vec!["read", "grep", "find", "ls"]
                    .into_iter()
                    .map(String::from)
                    .collect()
            )
        );
        assert_eq!(
            active_tools_for(PermissionMode::Workspace, &[], &[]),
            Some(
                vec!["read", "grep", "find", "ls", "write", "edit"]
                    .into_iter()
                    .map(String::from)
                    .collect()
            )
        );
        assert_eq!(
            active_tools_for(PermissionMode::ReadOnly, &[], &DELEGATION_TOOLS)
                .unwrap()
                .iter()
                .filter(|n| n.starts_with("subagent"))
                .count(),
            2,
            "委派工具要进运行期工具集"
        );
    }

    /// 插件的工具名要并进**运行期**工具集（不再进 `--tools`）。
    #[test]
    fn plugin_tools_are_merged_into_the_runtime_tool_set() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("pi-ask");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.js"), "// x\n").unwrap();
        std::fs::write(
            dir.join("piggy-plugin.json"),
            r#"{"name":"pi-ask","entry":"index.js","tools":["ask_user_question","exit_plan_mode"]}"#,
        )
        .unwrap();
        let mut a = args(PermissionMode::ReadOnly);
        a.bundled_extensions = vec![dir];
        let tools = active_tools(&a).expect("限制档必须有运行期工具集");
        assert!(tools.iter().any(|t| t == "ask_user_question"), "{tools:?}");
        assert!(tools.iter().any(|t| t == "exit_plan_mode"), "{tools:?}");
    }

    /// 完全权限档也注入守卫（2026-11-07）：它是"运行期还能切回限制档"的前提。
    /// 守卫缺失时完全权限档只降级打日志，不 fail-closed。
    #[test]
    fn full_mode_injects_the_guard_when_present() {
        let mut a = args(PermissionMode::Full);
        a.guard_script = Some(tmp_file("piggy-test-guard-full.js"));
        let v = argv(&a);
        assert!(
            v.windows(2)
                .any(|w| w[0] == "--extension" && w[1].ends_with("piggy-test-guard-full.js")),
            "{v:?}"
        );
        // 缺守卫时仍然能起（完全权限档本来就不需要它）
        assert!(cli_args(&args(PermissionMode::Full)).is_ok());
    }

    #[test]
    fn restricted_modes_without_the_guard_refuse_to_start() {
        // 守卫缺失必须是硬错误：静默启动 = 用户以为有边界、实际没有。
        // 两个限制档都成立——「仅可查看」靠守卫拦读敏感目录，缺了它 auth.json 就裸奔。
        for mode in [PermissionMode::ReadOnly, PermissionMode::Workspace] {
            let err = cli_args(&args(mode)).unwrap_err();
            assert!(err.starts_with("GUARD_SCRIPT_MISSING"), "{mode:?}: {err}");
        }
    }

    #[test]
    fn restricted_modes_with_the_guard_inject_it() {
        for mode in [PermissionMode::ReadOnly, PermissionMode::Workspace] {
            let mut a = args(mode);
            a.guard_script = Some(tmp_file("piggy-test-guard.js"));
            let v = argv(&a);
            let idx = v.iter().position(|x| x == "--extension").expect("应注入守卫");
            assert!(v[idx + 1].ends_with("piggy-test-guard.js"), "{mode:?}");
        }
    }

    #[test]
    fn bridge_is_injected_in_every_permission_mode() {
        // 桥接只注册命令、不注册工具，所以不受 --tools 白名单影响，档位不该改变它是否注入。
        // ReadOnly 也注入守卫（读敏感目录拦截），argv 里会有两个 `--extension`（守卫在前），
        // 所以按"--extension 后面跟的是不是桥接"找，而不是取第一个 --extension。
        let bridge = tmp_file("piggy-test-bridge.js");
        for mode in [PermissionMode::ReadOnly, PermissionMode::Full] {
            let mut a = args(mode);
            a.guard_script = Some(tmp_file("piggy-test-guard-bridge-mode.js"));
            a.bridge_script = Some(bridge.clone());
            let v = argv(&a);
            assert!(
                v.windows(2)
                    .any(|w| w[0] == "--extension" && w[1].ends_with("piggy-test-bridge.js")),
                "{mode:?}: 应注入桥接 {v:?}"
            );
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

    /// **argv 里的路径不许带 verbatim 前缀**（`\\?\`）。
    ///
    /// 真机 A/B（2026-10-13）：完全相同的三条插件目录，普通路径下 pi `exit=0`，
    /// 带上 `\\?\` 则 pi 报
    /// `Failed to load extension ...: EISDIR: illegal operation on a directory, lstat 'C:'`
    /// 然后 `process.exit(1)` —— 表现为建会话失败（`pi worker exited`）。
    /// 我们的 argv 对象是 `OsString`，**不是** String，所以任何 `String` 侧的
    /// contains/replace 都碰不到它：这条闸门直接钉字节前缀。
    ///
    /// ⚠️ 仅 Windows 编译（AGENTS.md 第 13 条，2026-10-24 加护栏）：fixture 造的
    /// verbatim 路径必须能过 `cli_args` 的 `is_dir()` 过滤才会被注入，而
    /// `\\?\…` 在 Unix 上永远不是目录 —— 夹具在 macOS/Linux 上按定义到不了
    /// 断言那一行。剥离行为本身由下面那条**全平台**纯函数测试钉住。
    #[cfg(windows)]
    #[test]
    fn extension_args_never_carry_the_verbatim_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        let ext = tmp.path().join("pi-ask");
        std::fs::create_dir_all(&ext).unwrap();
        // 造一份真路径，再把 verbatim 前缀拼回去 —— 模拟 Tauri 的 resource_dir
        let verbatim = |p: &std::path::Path| {
            let s = p.to_string_lossy();
            let bare = s.strip_prefix(r"\\?\").unwrap_or(s.as_ref());
            PathBuf::from(format!(r"\\?\{bare}"))
        };
        let mut a = args(PermissionMode::Workspace);
        a.guard_script = Some(tmp_file("piggy-test-verbatim-guard.js"));
        a.bridge_script = Some(tmp_file("piggy-test-verbatim-bridge.js"));
        a.bundled_extensions = vec![verbatim(&ext)];

        let raw = cli_args(&a).expect("argv 组装失败");
        let bad: Vec<String> = raw
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .filter(|s| s.starts_with(r"\\?\"))
            .collect();
        assert!(
            bad.is_empty(),
            "argv 里出现了 verbatim 路径（pi 会直接 exit(1)）：{bad:?}"
        );
        // 插件目录还得真的被注入了，否则这条测试会因为"什么都没注入"而空过
        assert!(
            raw.iter().any(|s| s.to_string_lossy().ends_with("pi-ask")),
            "插件目录没被注入，这条测试等于没验：{raw:?}"
        );
    }

    /// `plain_path` 的剥离行为在**所有平台**都要对。argv 级的那条闸门（上一条）
    /// 只在 Windows 上能真正跑到注入断言（Unix 上 `\\?\…` 永远过不了
    /// `cli_args` 的 `is_dir()` 过滤），所以这里把纯函数单独钉住 —— 剥离是
    /// 字符串操作，跨平台语义一致，没理由只在 Windows 上验证。
    #[test]
    fn plain_path_strips_verbatim_prefixes_on_every_platform() {
        assert_eq!(
            crate::plain_path(std::path::Path::new(r"\\?\C:\Users\wxk\piggy\pi-ask")),
            std::path::PathBuf::from(r"C:\Users\wxk\piggy\pi-ask")
        );
        // UNC 形态剥成普通 UNC（`\\?\UNC\srv\share` → `\\srv\share`）
        assert_eq!(
            crate::plain_path(std::path::Path::new(r"\\?\UNC\srv\share\piggy")),
            std::path::PathBuf::from(r"\\srv\share\piggy")
        );
        // 普通路径原样返回：macOS/Linux 的日常形态不做任何"聪明"改写
        assert_eq!(
            crate::plain_path(std::path::Path::new("/var/folders/xx/pi-ask")),
            std::path::PathBuf::from("/var/folders/xx/pi-ask")
        );
        // 已经不带前缀的 Windows 形态也不动（幂等）
        assert_eq!(
            crate::plain_path(std::path::Path::new(r"C:\plain\path")),
            std::path::PathBuf::from(r"C:\plain\path")
        );
    }

    /// 限制档位下插件**照样注入**（工具会不会进运行期工具集是另一件事，
    /// 见 `plugins.rs` 顶部与 docs/15 规矩 8；但"注入了什么"必须能从 argv 看出来）。
    #[test]
    fn bundled_plugins_are_injected_in_restricted_modes_too() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("pi-ask");
        std::fs::create_dir_all(&dir).unwrap();
        let mut a = args(PermissionMode::ReadOnly);
        a.guard_script = Some(tmp_file("piggy-test-guard-bundled.js"));
        a.bundled_extensions = vec![dir.clone()];
        let argv = cli_args(&a).unwrap();
        assert!(argv.iter().any(|s| s == &std::ffi::OsString::from(&dir)));
    }

    /// **覆盖型插件不许把限制档变成可写档**（2026-10-09 补，argv 级）。
    ///
    /// `plugins.rs` 那边有单测盯着 `plugin_tools_for`；这条盯的是**最终 argv**：
    /// 清单写了 `"allowlist": false` 的插件，它的 `write`/`edit` 绝不能出现在
    /// 「仅可查看」档的运行期工具集里。两处都要，是因为"合并发生在 `active_tools_for` 里"
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
        a.guard_script = Some(tmp_file("piggy-test-guard-override.js"));
        a.bundled_extensions = vec![over, normal];
        let tools = active_tools(&a).expect("限制档必须有运行期工具集");
        assert!(
            !tools.iter().any(|t| t == "write" || t == "edit"),
            "覆盖型插件的 write/edit 混进了「仅可查看」的运行期工具集：{tools:?}"
        );
        assert!(tools.iter().any(|t| t == "ask_user_question"), "{tools:?}");
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
        /* 限制档必须显式带上 `--no-mcp`（2026-11-07 取消 `--tools` 后，它成了
        唯一能阻止 MCP 进程被拉起的开关）；完全权限档不带（那是"用你自己的配置"）。 */
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
        // （两个限制档都需要守卫脚本，这里直接补上——守卫缺失的硬错误另测）
        for mode in [PermissionMode::ReadOnly, PermissionMode::Full] {
            let mut a = args(mode);
            a.guard_script = Some(tmp_file("piggy-test-guard-delegation-off.js"));
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
    fn delegation_is_active_in_restricted_modes_and_extends_the_allowlist() {
        // 2026-10-30：限制档位不再"静默关闭"委派。扩展工具默认不进运行期工具集，
        // 所以必须把 subagent/subagents_enable 显式加进去；子代理的工具边界
        // 由 bridge 的 capability ceiling + 守卫扩展继承（bridge 单测另锁）。
        let tmp = tempfile::tempdir().unwrap();
        for mode in [PermissionMode::ReadOnly, PermissionMode::Workspace] {
            let mut a = args(mode);
            a.subagent_policy = Some(policy_file(tmp.path()));
            let g = tmp.path().join("piggy-guard.js");
            std::fs::write(&g, "// guard").unwrap();
            a.guard_script = Some(g);
            let b = tmp.path().join("piggy-bridge.js");
            std::fs::write(&b, "// bridge").unwrap();
            a.bridge_script = Some(b);
            let argv = argv(&a);
            assert!(argv.contains(&"--append-system-prompt".to_string()), "{mode:?}");
            // 2026-11-07：委派工具不再进 `--tools`（那份白名单已取消），而是进运行期工具集。
            let tools = active_tools(&a).expect("限制档位必须有运行期工具集");
            for name in DELEGATION_TOOLS {
                assert!(tools.iter().any(|t| t == name), "{mode:?} 缺 {name}: {tools:?}");
            }
            let envs = spawn_envs(&a);
            assert!(envs.iter().any(|(k, v)| k == DELEGATION_ENV && v == "1"), "{mode:?}");
            assert!(
                envs.iter().any(|(k, _)| k == SUBAGENT_TOOLS_ENV),
                "{mode:?} 必须把父会话的工具边界交给 bridge"
            );
            assert!(
                envs.iter().any(|(k, _)| k == GUARD_SCRIPT_ENV),
                "{mode:?} 必须让子会话加载守卫"
            );
            assert!(subagent_delegation_active(&a), "{mode:?}");
        }
    }

    #[test]
    fn spawn_envs_carry_the_permission_file_and_fallback_tool_list() {
        let mut a = args(PermissionMode::Workspace);
        a.permission_file = Some(PathBuf::from("/tmp/piggy-perm.json"));
        let envs = spawn_envs(&a);
        assert!(
            envs.iter()
                .any(|(k, v)| k == PERMISSION_FILE_ENV && v == "/tmp/piggy-perm.json"),
            "运行期档位文件路径必须交给守卫：{envs:?}"
        );
        let tools = envs
            .iter()
            .find(|(k, _)| k == PERMISSION_TOOLS_ENV)
            .map(|(_, v)| v.clone())
            .expect("限制档必须有兜底工具集");
        assert_eq!(tools, "read,grep,find,ls,write,edit");

        // 完全权限：有文件（供运行期降档），但没有兜底工具集（不限制）
        let mut f = args(PermissionMode::Full);
        f.permission_file = Some(PathBuf::from("/tmp/piggy-perm.json"));
        let envs = spawn_envs(&f);
        assert!(envs.iter().any(|(k, _)| k == PERMISSION_FILE_ENV));
        assert!(!envs.iter().any(|(k, _)| k == PERMISSION_TOOLS_ENV));
    }

    #[test]
    fn delegation_without_bridge_refuses_in_restricted_modes_only() {
        // 限制档位的子代理边界靠 bridge 注册；bridge 缺失时不能只凭策略文件就放行。
        let tmp = tempfile::tempdir().unwrap();
        let mut a = args(PermissionMode::ReadOnly);
        a.subagent_policy = Some(policy_file(tmp.path()));
        a.guard_script = Some(tmp_file("piggy-test-guard-no-bridge.js"));
        let err = cli_args(&a).unwrap_err();
        assert!(err.starts_with("SUBAGENT_BRIDGE_MISSING"), "{err}");

        // Full 不需要 bridge：它本来就不限制子代理。
        let mut full = args(PermissionMode::Full);
        full.subagent_policy = Some(policy_file(tmp.path()));
        assert!(cli_args(&full).is_ok());
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
        // 宿主标识与权限档位也一定在（bridge 靠它决定要不要给子代理注册 ceiling）
        assert!(envs.iter().any(|(k, v)| k == HOST_ENV && v == HOST_NAME));
        assert!(envs.iter().any(|(k, v)| k == PERMISSION_ENV && v == "full"));
        assert_eq!(envs.len(), 4);
    }
}
