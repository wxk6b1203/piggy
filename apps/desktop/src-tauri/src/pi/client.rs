//! 命令客户端（docs/02 §3）：id 关联、pending map、超时、stdin 单写者。
//! typed 方法全集见 docs/02 §3.2 映射表（M0 实现对话管道所需子集）。

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot, watch, Mutex};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkerState {
    Spawning,
    Ready,
    Busy,
    Crashed,
    Stopped,
}

pub struct WorkerInner {
    pub tab_id: String,
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

const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// 冷启动握手预算（见 `get_state`）。
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(40);

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
        // 超时的两件事必须一起做：把 pending 槽收掉（否则一条永远不回的命令会留个死槽），
        // 以及**把真实等了多久写进错误里** —— 报错文案是用户唯一能拿到的现场，
        // "等了 10s" 与 "等了 40s" 对判断"pi 卡住了"还是"pi 只是慢"是决定性的。
        // 用 `select!`（而不是 `timeout(t, rx)`）是为了让"收槽"就发生在超时那一支里：
        // 若应答同时到达，`handle_line` 已取走槽并成功 send，这里 remove 打空（无害）。
        let wait = async {
            match rx.await {
                Ok(v) => Ok(v),
                Err(_) => Err(format!("pi worker dropped response for {command}")),
            }
        };
        match timeout {
            None => wait.await,
            Some(t) => {
                let started = Instant::now();
                tokio::select! {
                    r = wait => r,
                    _ = tokio::time::sleep(t) => {
                        self.pending.lock().await.remove(&id);
                        Err(format!(
                            "pi command '{command}' timed out（等了 {}s 没回）",
                            started.elapsed().as_secs_f32().round() as u64
                        ))
                    }
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
        self.request_checked("get_state", json!({}), Some(HANDSHAKE_TIMEOUT))
            .await
    }

    pub async fn get_messages(&self) -> Result<Value, String> {
        self.request_checked("get_messages", json!({}), None).await
    }

    pub async fn get_entries(&self, since: Option<&str>) -> Result<Value, String> {
        let mut p = json!({});
        if let Some(s) = since {
            p["since"] = json!(s);
        }
        self.request_checked("get_entries", p, None).await
    }

    pub async fn new_session(&self) -> Result<Value, String> {
        self.request_checked("new_session", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn switch_session(&self, path: &str) -> Result<Value, String> {
        self.request_checked("switch_session", json!({ "sessionPath": path }), Some(DEFAULT_TIMEOUT))
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
        self.request_checked("get_available_models", json!({}), None).await
    }

    pub async fn get_session_stats(&self) -> Result<Value, String> {
        self.request_checked("get_session_stats", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn set_session_name(&self, name: &str) -> Result<Value, String> {
        self.request_checked("set_session_name", json!({ "name": name }), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn bash(&self, command: &str) -> Result<Value, String> {
        self.request_checked("bash", json!({ "command": command }), None).await
    }

    pub async fn export_html(&self, output_path: Option<&str>) -> Result<Value, String> {
        let mut p = json!({});
        if let Some(path) = output_path {
            p["outputPath"] = json!(path);
        }
        self.request_checked("export_html", p, Some(DEFAULT_TIMEOUT)).await
    }

    pub async fn get_tree(&self) -> Result<Value, String> {
        self.request_checked("get_tree", json!({}), None).await
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
        self.request_checked("compact", p, None).await
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
                    &format!(
                        "(Get-CimInstance Win32_Process -Filter \"ParentProcessId={cmd_pid}\").ProcessId"
                    ),
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
}
