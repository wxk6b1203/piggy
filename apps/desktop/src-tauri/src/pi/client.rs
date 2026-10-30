//! 命令客户端（docs/02 §3）：id 关联、pending map、超时、stdin 单写者。
//! typed 方法全集见 docs/02 §3.2 映射表（M0 实现对话管道所需子集）。

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

use crate::process_ext::NoConsoleWindow;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerState {
    Spawning,
    Ready,
    Busy,
    Crashed,
    Stopped,
}

/// 这个 worker 服务的标签页 id（spawn 时定下，之后不变）。
///
/// 合帧器每帧都要用它拼通道名（`pi:frame:<tab>`），所以构造合帧器时读**一次**即可 ——
/// 见 `FrameCoalescer::new`。
///
/// **历史**（2026-10-13）：这个字段当年是 `Arc<RwLock<String>>`（`TabSlot`）—— 预热池
/// 要把一个已经起好的进程**重绑**给另一个标签页，所以需要一个可改写的槽。预热池与
/// `rebind_tab` 都已删除（docs/05 §5.7），生产代码里没有任何路径会重绑，于是
/// 2026-10-17 退回裸 `String`：合帧器不再每帧拿一次读锁，"帧发到哪个通道"在 spawn
/// 时就定了。真要再复用进程，改回共享槽的成本是这一处 + `FrameCoalescer::new` 的入参。
pub struct WorkerInner {
    pub(crate) tab_id: String,
    pub cwd: std::path::PathBuf,
    pub stdin_tx: mpsc::Sender<String>,
    pub pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    pub(crate) next_id: AtomicU64,
    pub(crate) state_tx: watch::Sender<WorkerState>,
    pub state_rx: watch::Receiver<WorkerState>,
    pub stderr_tail: Mutex<VecDeque<String>>,
    pub child: Mutex<Option<tokio::process::Child>>,
}

pub type Worker = Arc<WorkerInner>;

/// 测试用假 worker（不挂子进程）：状态通道、pending 表、stdin 通道都是真的。
///
/// 放在 `#[cfg(test)]` 的模块外，是因为 `sessions/registry.rs` 的 `commit_revive` 测试
/// 也要用它——那个 bug（用 `tab.worker` 而不是新 spawn 的 worker）没有真 pi 也能钉住。
#[cfg(test)]
pub(crate) fn test_worker(state: WorkerState) -> (Worker, mpsc::Receiver<String>) {
    let (state_tx, state_rx) = watch::channel(state);
    let (stdin_tx, stdin_rx) = mpsc::channel(8);
    (
        Arc::new(WorkerInner {
            tab_id: "t-test".into(),
            cwd: std::path::PathBuf::from("/tmp"),
            stdin_tx,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            state_tx,
            state_rx,
            stderr_tail: Mutex::new(VecDeque::new()),
            child: Mutex::new(None),
        }),
        stdin_rx,
    )
}

impl WorkerInner {
    /// 这个 worker 服务的标签页 id（spawn 时定下，之后不变）。
    pub fn tab_id(&self) -> String {
        self.tab_id.clone()
    }
}

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// `bash` 的兜底预算（**不是期望等待**）：跑的是用户命令，长构建可能要几分钟。
/// 超时只表示"不再等最终回执"，进程侧命令仍在跑，可 `abort_bash` 中止后重试。
/// 此前传 `None` = 永不超时，配合 pending 回收窗口会永久挂死调用方（2026-10-28 审查 H4）。
const BASH_FALLBACK_TIMEOUT: Duration = Duration::from_secs(600);

/// `compact` 的兜底预算：一次 LLM 总结整段会话，慢模型 + 大会话可能远超普通命令。
/// 同上，此前是 `None`（永不超时）。
const COMPACT_FALLBACK_TIMEOUT: Duration = Duration::from_secs(300);

/// **冷启动预算**：同一个 pi 进程里只有**第一条** stdin 之前的命令要付这笔钱
/// （起 node、读配置、加载扩展、读会话文件），所以凡是可能成为第一条的命令都用它。
///
/// 抽成常量而不是只写给 `get_state`（2026-10-09 复查发现的缝）：`set_session_name` /
/// `switch_session` / `new_session` 也都可能落在冷进程上 —— 一次性标题生成的
/// `set_session_name_via_worker` 就是 **spawn 之后不握手直接发**，
/// 冷启动慢到 >30s 时它会以"等了 30s"失败，而同一时刻 `get_state` 的预算是 40s：
/// 同一个进程两套判据，用户看到的报错会自相矛盾。
pub const COLD_START_TIMEOUT: Duration = Duration::from_secs(40);

/// 「要读很久、但一定有尽头」的命令（`get_entries` / `get_messages` / `get_tree`）。
///
/// 这些命令以前传的是 `None` = **永不超时**。11 MB 会话实测 `get_entries` 383 ms，
/// 正常情况下永远够用；但"永不超时"意味着一个卡住的 pi 会把调用方**永久**挂住 ——
/// 而 `revive_tab` 就是在 registry 锁里调它的，那会变成整个应用停摆。
/// 120s 是"再大的会话也不该超过"的量级，不是期望等待时间。
const LONG_TIMEOUT: Duration = Duration::from_secs(120);

/// 连根杀掉一个 worker **整棵进程树**（不是一个进程）。
///
/// ## 为什么必须有这一步（2026-10-09 本机实测的孤儿 bug）
///
/// Windows 上 pi 是通过 pnpm 的 `pi.cmd` 启动的，于是进程链是
/// `piggy → cmd.exe（垫片） → node.exe（真正的 pi）`。而 `tokio` 的
/// `Child::kill()` / `kill_on_drop(true)` 只杀**直接子进程**，也就是 `cmd.exe` ——
/// `node.exe` 会活下来变孤儿，继续握着那份会话文件。
///
/// 实测（本机）：只杀直接子进程之后，孙进程仍在；`taskkill /PID <pid> /T /F` 才连根拔掉。
/// 真实后果不是"多几个进程"这么轻：孤儿的 pi 仍然在写同一个 `.jsonl`，
/// 下次打开同一会话时就有了两个写者，`get_state` 冷启动从 2.2s 被拖到超过旧预算 10s ——
/// 这正是用户报的 `tab_create FAILED: pi command 'get_state' timed out`。
///
/// `taskkill` 是 Windows 自带、任何装了 Windows 的机器上都在；
/// 相比之下 Job Object 更"正统"，但本机实测：piggy 自己就跑在一个 job 里，
/// 给 `cmd.exe` 垫片 `AssignProcessToJobObject` 之后，它 fork 出来的 node **并不在** job 内
/// （`IsProcessInJob` 返回 0），关掉 job 句柄杀不掉 node。所以走 taskkill。
pub(crate) fn kill_process_tree(_pid: Option<u32>) {
    #[cfg(windows)]
    {
        let Some(pid) = _pid else { return };
        // `/T` = 连子孙一起，`/F` = 强制。stdout/stderr 丢掉：这里没什么可读的，
        // 进程已退出时它只会回一句 "not found"（不算错误）。
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .no_console_window()
            .status();
    }
    // 非 Windows：pi 没有 `cmd.exe` 垫片，直接子进程就是 pi 本身，`Child::kill()` 足够。
}

impl WorkerInner {
    pub fn state(&self) -> WorkerState {
        *self.state_rx.borrow()
    }

    pub fn subscribe_state(&self) -> watch::Receiver<WorkerState> {
        self.state_rx.clone()
    }

    pub(crate) fn set_state(&self, s: WorkerState) {
        let _ = self.state_tx.send(s);
    }

    /// 底层请求：写入 stdin 并等待对应 id 的 response。
    pub async fn request(&self, command: &str, mut payload: Value, timeout: Option<Duration>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        payload["type"] = json!(command);
        payload["id"] = json!(id.to_string());
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let line = serde_json::to_string(&payload).map_err(|e| format!("serialize {command} failed: {e}"))?;
        if let Err(e) = self.stdin_tx.send(line).await {
            self.pending.lock().await.remove(&id);
            return Err(format!("pi worker stdin closed: {e}"));
        }
        // 等待期同时盯住 worker 终态与时长预算，语义见 [`Self::wait_for_response`]。
        self.wait_for_response(command, id, rx, timeout).await
    }

    /// 等待应答的三件事：**应答本身 / worker 终态 / 时长预算**。
    ///
    /// 终态那一支是 2026-10-28 审查（H4）补的：`fail_all_pending` 是 pending 的唯一
    /// 批量清理点、只在 run_reader 退出时跑一次——落在它**之后**插入 pending 的请求，
    /// 进程死透也无人收槽，调用方（Tauri 命令）会**永久挂死**。而 run_reader 退出时
    /// 总会把 watch 置成 Crashed/Stopped，盯住这条通道就能在那一刻了结所有等待，
    /// 错误信息也比"永远不回"有用得多。
    ///
    /// 超时的两件事必须一起做：把 pending 槽收掉（否则一条永远不回的命令会留个死槽），
    /// 以及**把真实等了多久写进错误里** —— 报错文案是用户唯一能拿到的现场，
    /// "等了 10s" 与 "等了 40s" 对判断"pi 卡住了"还是"pi 只是慢"是决定性的。
    async fn wait_for_response(
        &self,
        command: &str,
        id: u64,
        rx: oneshot::Receiver<Value>,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        let started = Instant::now();
        let mut state_rx = self.state_rx.clone();
        /* `changed()` 只报**订阅之后**的变化：如果 worker 在 `ready_worker` 返回之后、
        订阅之前已经变成 Crashed/Stopped，这里会永远等不到下一次变化（bash 要白等 600s）。
        所以订阅后立刻看一次当前值——终态是"现在就是"，不是"等它变"。 */
        if matches!(*state_rx.borrow(), WorkerState::Crashed | WorkerState::Stopped) {
            let s = *state_rx.borrow();
            self.pending.lock().await.remove(&id);
            return Err(format!(
                "pi worker exited before responding to {command}（state={s:?}）"
            ));
        }
        let wait = async {
            match rx.await {
                Ok(v) => Ok(v),
                Err(_) => Err(format!("pi worker dropped response for {command}")),
            }
        };
        tokio::pin!(wait);
        // 没有预算时用"永不就绪"的 future 占位，select 的形状保持一种。
        let deadline = timeout.map(|t| tokio::time::Instant::from_std(started + t));
        loop {
            tokio::select! {
                r = &mut wait => return r,
                changed = state_rx.changed() => {
                    if changed.is_err() {
                        // 发送端被释放（WorkerInner 所有引用消失）：与终态同义
                        self.pending.lock().await.remove(&id);
                        return Err(format!("pi worker exited before responding to {command}"));
                    }
                    let s = *state_rx.borrow_and_update();
                    if matches!(s, WorkerState::Crashed | WorkerState::Stopped) {
                        self.pending.lock().await.remove(&id);
                        return Err(format!("pi worker exited before responding to {command}（state={s:?}）"));
                    }
                    // 非终态（Spawning/Ready/Busy）：继续等
                }
                _ = async {
                    match deadline {
                        Some(d) => tokio::time::sleep_until(d).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    self.pending.lock().await.remove(&id);
                    return Err(format!(
                        "pi command '{command}' timed out（等了 {}s 没回）",
                        started.elapsed().as_secs_f32().round() as u64
                    ));
                }
            }
        }
    }

    /// 请求并检查 success 字段，返回 data。
    pub async fn request_checked(
        &self,
        command: &str,
        payload: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        let resp = self.request(command, payload, timeout).await?;
        if resp["success"].as_bool().unwrap_or(false) {
            Ok(resp.get("data").cloned().unwrap_or(Value::Null))
        } else {
            Err(resp["error"].as_str().unwrap_or("unknown pi error").to_string())
        }
    }

    pub(crate) async fn fail_all_pending(&self, err: &str) {
        let mut p = self.pending.lock().await;
        for (_, tx) in p.drain() {
            let _ = tx.send(json!({
                "type": "response", "success": false, "error": err
            }));
        }
    }

    /// 主动终止（deliberate）：先试 abort（2s 宽限），再 kill。
    pub async fn shutdown(&self) {
        self.set_state(WorkerState::Stopped);
        let _ = self.request("abort", json!({}), Some(Duration::from_secs(2))).await;
        if let Some(mut child) = self.child.lock().await.take() {
            kill_process_tree(child.id());
            let _ = child.kill().await;
            // 收尸：不 wait() 的话进程句柄会一直挂着（Windows 上表现为僵尸条目）
            let _ = child.wait().await;
        }
    }

    /* ---------------- typed 方法（docs/02 §3.2 子集） ---------------- */

    pub async fn prompt(
        &self,
        message: &str,
        images: Option<Vec<Value>>,
        streaming_behavior: Option<&str>,
    ) -> Result<Value, String> {
        let mut p = json!({ "message": message });
        if let Some(imgs) = images {
            p["images"] = Value::Array(imgs);
        }
        if let Some(sb) = streaming_behavior {
            p["streamingBehavior"] = json!(sb);
        }
        self.request_checked("prompt", p, Some(DEFAULT_TIMEOUT)).await
    }

    pub async fn steer(&self, message: &str) -> Result<Value, String> {
        self.request_checked("steer", json!({ "message": message }), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn follow_up(&self, message: &str) -> Result<Value, String> {
        self.request_checked("follow_up", json!({ "message": message }), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn abort(&self) -> Result<Value, String> {
        // abort 等 idle 才回，给足宽限（docs/02 §3.2）
        self.request_checked("abort", json!({}), Some(Duration::from_secs(60)))
            .await
    }

    pub async fn clear_queue(&self) -> Result<Value, String> {
        self.request_checked("clear_queue", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    /// 冷启动握手（`tab_create` 的第一条命令）。
    ///
    /// **为什么不是 10s**（2026-10-09 实测，本机 Windows + pi 0.87.1）：
    /// `get_state` 是 pi 收到第一条 stdin 之前的"开工成本"——要起 node、读配置、
    /// 加载几个扩展、再读会话文件；本机空载实测**冷启动 2.2 s、热态 0.26 s**。
    /// 也就是说 10s 只有 4 倍余量，而这条路径上的真实放大项都是常见情形：
    /// 长会话（要读大 JSONL）、同时开多个 tab（多个 node 抢磁盘）、Defender 实时扫描、
    /// 以及**上一轮留下的孤儿 worker**（同一份会话文件被两个进程写）。
    /// 超时的代价却特别大：用户点一次"打开会话"直接失败。
    /// 40s 是"慢到什么程度才算真的卡住"的判据，不是期望等待时间（正常仍是 2-3s）。
    pub async fn get_state(&self) -> Result<Value, String> {
        self.request_checked("get_state", json!({}), Some(COLD_START_TIMEOUT))
            .await
    }

    pub async fn get_messages(&self) -> Result<Value, String> {
        self.request_checked("get_messages", json!({}), Some(LONG_TIMEOUT))
            .await
    }

    pub async fn get_entries(&self, since: Option<&str>) -> Result<Value, String> {
        let mut p = json!({});
        if let Some(s) = since {
            p["since"] = json!(s);
        }
        self.request_checked("get_entries", p, Some(LONG_TIMEOUT)).await
    }

    pub async fn new_session(&self) -> Result<Value, String> {
        // 可能落在冷进程上（换档/预热池）→ 用冷启动预算
        self.request_checked("new_session", json!({}), Some(COLD_START_TIMEOUT))
            .await
    }

    pub async fn switch_session(&self, path: &str) -> Result<Value, String> {
        // 换会话 = 重建整个 runtime（要读会话文件、重扫项目资源），冷启动预算
        self.request_checked(
            "switch_session",
            json!({ "sessionPath": path }),
            Some(COLD_START_TIMEOUT),
        )
        .await
    }

    pub async fn set_model(&self, provider: &str, model_id: &str) -> Result<Value, String> {
        self.request_checked(
            "set_model",
            json!({ "provider": provider, "modelId": model_id }),
            Some(DEFAULT_TIMEOUT),
        )
        .await
    }

    pub async fn get_available_models(&self) -> Result<Value, String> {
        // 可能等 pi 自己的目录刷新（它内部 15s abort），所以给冷启动预算而不是 30s
        self.request_checked("get_available_models", json!({}), Some(COLD_START_TIMEOUT))
            .await
    }

    pub async fn get_session_stats(&self) -> Result<Value, String> {
        self.request_checked("get_session_stats", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn set_session_name(&self, name: &str) -> Result<Value, String> {
        // 一次性标题生成的路径是"spawn 完不握手直接发" → 可能是这个进程的第一条命令
        self.request_checked("set_session_name", json!({ "name": name }), Some(COLD_START_TIMEOUT))
            .await
    }

    pub async fn bash(&self, command: &str) -> Result<Value, String> {
        self.request_checked("bash", json!({ "command": command }), Some(BASH_FALLBACK_TIMEOUT))
            .await
    }

    pub async fn export_html(&self, output_path: Option<&str>) -> Result<Value, String> {
        let mut p = json!({});
        if let Some(path) = output_path {
            p["outputPath"] = json!(path);
        }
        self.request_checked("export_html", p, Some(DEFAULT_TIMEOUT)).await
    }

    pub async fn get_tree(&self) -> Result<Value, String> {
        self.request_checked("get_tree", json!({}), Some(LONG_TIMEOUT)).await
    }

    pub async fn fork(&self, entry_id: &str) -> Result<Value, String> {
        self.request_checked("fork", json!({ "entryId": entry_id }), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn clone_session(&self) -> Result<Value, String> {
        self.request_checked("clone", json!({}), Some(DEFAULT_TIMEOUT)).await
    }

    pub async fn get_fork_messages(&self) -> Result<Value, String> {
        self.request_checked("get_fork_messages", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn set_thinking_level(&self, level: &str) -> Result<Value, String> {
        self.request_checked("set_thinking_level", json!({ "level": level }), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn get_available_thinking_levels(&self) -> Result<Value, String> {
        self.request_checked("get_available_thinking_levels", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn cycle_thinking_level(&self) -> Result<Value, String> {
        self.request_checked("cycle_thinking_level", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn get_commands(&self) -> Result<Value, String> {
        self.request_checked("get_commands", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn compact(&self, custom_instructions: Option<&str>) -> Result<Value, String> {
        let mut p = json!({});
        if let Some(ci) = custom_instructions {
            p["customInstructions"] = json!(ci);
        }
        self.request_checked("compact", p, Some(COMPACT_FALLBACK_TIMEOUT)).await
    }

    pub async fn abort_bash(&self) -> Result<Value, String> {
        self.request_checked("abort_bash", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn raw_request(&self, command: &str, payload: Value, timeout: Option<Duration>) -> Result<Value, String> {
        self.request(command, payload, timeout).await
    }

    /// 直接写入 stdin（测试/调试用；正常路径走 request）。
    pub async fn stdin_send(&self, line: &str) -> Result<(), String> {
        self.stdin_tx.send(line.to_string()).await.map_err(|e| e.to_string())
    }

    /// Extension UI 应答（docs/02 §8）：写回 stdin。
    pub async fn ui_response(&self, response: Value) -> Result<(), String> {
        let line = serde_json::to_string(&response).map_err(|e| e.to_string())?;
        self.stdin_tx.send(line).await.map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::kill_process_tree;

    /// 让进程活一会儿（`ping -n 30 127.0.0.1` 是**真的**等 29 秒）。
    #[cfg(windows)]
    fn spawn_ping_under_cmd() -> std::process::Child {
        std::process::Command::new("cmd.exe")
            .arg("/c")
            .arg("ping -n 30 127.0.0.1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("spawn cmd.exe 失败")
    }

    /// PID 还在不在（`tasklist` 的输出是 ASCII，不受系统语言影响）。
    #[cfg(windows)]
    fn pid_alive(pid: u32) -> bool {
        let out = std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .expect("tasklist 跑不动");
        let text = String::from_utf8_lossy(&out.stdout);
        text.contains(&pid.to_string()) && !text.contains("No tasks")
    }

    /// 等 PID 真的消失（`taskkill` 是**异步**的：返回时进程只是"正在死"）。
    ///
    /// 用固定 sleep 会得到一条时红时绿的用例 —— 实测就是这么红的（信号发了、进程还在收尾）。
    #[cfg(windows)]
    fn wait_until_gone(pid: u32, budget: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + budget;
        while std::time::Instant::now() < deadline {
            if !pid_alive(pid) {
                return true;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        false
    }

    /// 子进程树要有人收（WATCHDOG）：断言失败提前 return 也不许留孤儿。
    #[cfg(windows)]
    struct Watchdog(std::process::Child);
    #[cfg(windows)]
    impl Drop for Watchdog {
        fn drop(&mut self) {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.0.id().to_string(), "/T", "/F"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
            let _ = self.0.wait();
        }
    }

    /// **真机核对（Windows）**：`taskkill /T` 真的能连子孙一起收掉。
    ///
    /// 这条量的是用户报的那个超时背后的机制：pi 在 Windows 上是
    /// `cmd.exe`(垫片) → `node.exe`(真 pi)，而 `tokio` 的 `Child::kill()` 只杀前者。
    /// 所以这里不测"杀没杀掉 cmd.exe"（那个 `Child::kill()` 也能做到），
    /// 而是专门测 **`cmd.exe` 的子孙也没了** —— 那才是孤儿问题的全部内容。
    #[cfg(windows)]
    #[test]
    fn kill_process_tree_takes_the_grandchildren_too() {
        let mut child = spawn_ping_under_cmd();
        let cmd_pid = child.id();
        let guard = Watchdog(spawn_ping_under_cmd()); // 兜底：万一断言提前返回
                                                      // 等 ping 真的被拉起来（cmd.exe → ping.exe）
        std::thread::sleep(std::time::Duration::from_millis(700));
        let ping: Vec<u32> = String::from_utf8_lossy(
            &std::process::Command::new("powershell.exe")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!("(Get-CimInstance Win32_Process -Filter \"ParentProcessId={cmd_pid}\").ProcessId"),
                ])
                .output()
                .expect("powershell 跑不动")
                .stdout,
        )
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect();
        assert!(
            !ping.is_empty(),
            "cmd.exe 没拉起子进程，这条测试就失去意义了（前置不成立）"
        );

        kill_process_tree(Some(cmd_pid));
        let _ = child.wait();

        // taskkill 是异步的：给它 3 秒收尾，而不是赌一个固定 sleep
        assert!(
            wait_until_gone(cmd_pid, std::time::Duration::from_secs(3)),
            "cmd.exe（{cmd_pid}）还活着"
        );
        for pid in &ping {
            assert!(
                wait_until_gone(*pid, std::time::Duration::from_secs(3)),
                "子孙进程 {pid} 活下来了 —— 这就是那个孤儿 bug（会话文件会被它继续握着）"
            );
        }
        drop(guard);
    }

    /// 非 Windows：`kill_process_tree` 是空实现（不能 panic、不能挂）。
    #[test]
    fn kill_process_tree_tolerates_missing_pid() {
        kill_process_tree(None);
    }

    /* ---------------- request 的等待语义（2026-10-28 审查 H4） ---------------- */

    use super::{Worker, WorkerInner, WorkerState};
    use serde_json::json;
    use std::collections::{HashMap, VecDeque};
    use std::sync::atomic::AtomicU64;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::{mpsc, watch, Mutex};

    /// 构造一个不挂子进程的假 worker：状态通道、pending 表、stdin 通道都是真的，
    /// 足够测 `request` 的等待语义（不需要真 pi）。
    ///
    /// 返回值带上 stdin 接收端：**调用方必须把它活着拿住**——接收端一掉，通道关闭，
    /// `request` 会在"插入 pending → send 失败 → 收槽"之间瞬间失败，等不到要测的分支。
    fn fake_worker(state: WorkerState) -> (Worker, mpsc::Receiver<String>) {
        let (state_tx, state_rx) = watch::channel(state);
        let (stdin_tx, stdin_rx) = mpsc::channel(8);
        (
            Arc::new(WorkerInner {
                tab_id: "t-test".into(),
                cwd: std::path::PathBuf::from("/tmp"),
                stdin_tx,
                pending: Mutex::new(HashMap::new()),
                next_id: AtomicU64::new(0),
                state_tx,
                state_rx,
                stderr_tail: Mutex::new(VecDeque::new()),
                child: Mutex::new(None),
            }),
            stdin_rx,
        )
    }

    /// **H4 的核心场景**：请求落在 `fail_all_pending` 之后（唯一的批量清理点已跑过）、
    /// 进程随后死透 → 等待必须在状态变终态的那一刻了结，而不是永久挂死。
    /// 这里先手动跑一遍 `fail_all_pending`（模拟它已经收过一轮），再插入请求。
    #[tokio::test]
    async fn terminal_state_settles_requests_that_missed_fail_all_pending() {
        let (w, _stdin_rx) = fake_worker(WorkerState::Ready);
        w.fail_all_pending("pi worker exited").await; // 模拟清理点已跑过
        let t = tokio::spawn({
            let w = w.clone();
            async move { w.raw_request("bash", json!({}), None).await }
        });
        // 等请求真的进了 pending（stdin 通道有容量，send 立即成功）
        while w.pending.lock().await.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        w.set_state(WorkerState::Crashed); // run_reader 退出时总会置终态
        let err = tokio::time::timeout(Duration::from_secs(2), t)
            .await
            .expect("等待必须在终态后立刻了结（此前会永久挂死）")
            .unwrap()
            .unwrap_err();
        assert!(err.contains("exited before responding"), "{err}");
    }

    /// bash / compact 有兜底预算：worker 活着但不回包时按超时收槽，文案保留"真实等了多久"。
    #[tokio::test]
    async fn timeout_branch_keeps_its_wording() {
        let (w, _stdin_rx) = fake_worker(WorkerState::Ready); // 不回包也不死
        let err = w
            .raw_request("get_state", json!({}), Some(Duration::from_millis(80)))
            .await
            .unwrap_err();
        assert!(err.contains("timed out"), "{err}");
        assert!(err.contains("等了"), "{err}");
        assert!(w.pending.lock().await.is_empty(), "超时必须收掉 pending 槽");
    }

    /// 正常路径不受影响：应答先到就按应答走，pending 槽由 handle_line 取走。
    #[tokio::test]
    async fn response_still_wins() {
        let (w, _stdin_rx) = fake_worker(WorkerState::Ready);
        let t = tokio::spawn({
            let w = w.clone();
            async move {
                w.raw_request("get_state", json!({}), Some(Duration::from_secs(5)))
                    .await
            }
        });
        while w.pending.lock().await.is_empty() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        // 模拟 handle_line：取走槽并发对应 id 的应答
        w.pending
            .lock()
            .await
            .remove(&0)
            .expect("id 0 的槽应在")
            .send(json!({ "success": true, "data": { "ok": 1 } }))
            .expect("接收端应还在等");
        let out = tokio::time::timeout(Duration::from_secs(2), t)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(out["data"]["ok"], 1);
    }

    /// 终态**已经**在订阅之前：`changed()` 只报后续变化，若不先看当前值，
    /// 这条请求会永久挂住（H4 修的窗口只是变窄，没有消失）。
    #[tokio::test]
    async fn already_terminal_state_settles_a_new_request() {
        for state in [WorkerState::Crashed, WorkerState::Stopped] {
            let (w, _stdin_rx) = fake_worker(state);
            let t = tokio::spawn({
                let w = w.clone();
                async move { w.raw_request("bash", json!({}), None).await }
            });
            let err = tokio::time::timeout(Duration::from_secs(1), t)
                .await
                .expect("已经是终态时必须立刻了结，不能等 600s 兜底")
                .unwrap()
                .unwrap_err();
            assert!(err.contains("exited before responding"), "{state:?}: {err}");
            assert!(w.pending.lock().await.is_empty(), "{state:?}: pending 槽必须收掉");
        }
    }
}
