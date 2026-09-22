//! 命令客户端（docs/02 §3）：id 关联、pending map、超时、stdin 单写者。
//! typed 方法全集见 docs/02 §3.2 映射表（M0 实现对话管道所需子集）。

use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
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
    pub async fn request(
        &self,
        command: &str,
        mut payload: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        payload["type"] = json!(command);
        payload["id"] = json!(id.to_string());
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);
        let line = serde_json::to_string(&payload)
            .map_err(|e| format!("serialize {command} failed: {e}"))?;
        if let Err(e) = self.stdin_tx.send(line).await {
            self.pending.lock().await.remove(&id);
            return Err(format!("pi worker stdin closed: {e}"));
        }
        let wait = async {
            rx.await
                .map_err(|_| format!("pi worker dropped response for {command}"))
        };
        match timeout {
            None => wait.await,
            Some(t) => match tokio::time::timeout(t, wait).await {
                Ok(r) => r,
                Err(_) => {
                    self.pending.lock().await.remove(&id);
                    Err(format!("pi command '{command}' timed out"))
                }
            },
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
            Err(resp["error"]
                .as_str()
                .unwrap_or("unknown pi error")
                .to_string())
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
        let _ = self
            .request("abort", json!({}), Some(Duration::from_secs(2)))
            .await;
        if let Some(mut child) = self.child.lock().await.take() {
            let _ = child.kill().await;
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
        self.request_checked(
            "steer",
            json!({ "message": message }),
            Some(DEFAULT_TIMEOUT),
        )
        .await
    }

    pub async fn follow_up(&self, message: &str) -> Result<Value, String> {
        self.request_checked(
            "follow_up",
            json!({ "message": message }),
            Some(DEFAULT_TIMEOUT),
        )
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

    pub async fn get_state(&self) -> Result<Value, String> {
        self.request_checked("get_state", json!({}), Some(Duration::from_secs(10)))
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
        self.request_checked(
            "switch_session",
            json!({ "sessionPath": path }),
            Some(DEFAULT_TIMEOUT),
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
        self.request_checked("get_available_models", json!({}), None)
            .await
    }

    pub async fn get_session_stats(&self) -> Result<Value, String> {
        self.request_checked("get_session_stats", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn set_session_name(&self, name: &str) -> Result<Value, String> {
        self.request_checked(
            "set_session_name",
            json!({ "name": name }),
            Some(DEFAULT_TIMEOUT),
        )
        .await
    }

    pub async fn bash(&self, command: &str) -> Result<Value, String> {
        self.request_checked("bash", json!({ "command": command }), None)
            .await
    }

    pub async fn export_html(&self, output_path: Option<&str>) -> Result<Value, String> {
        let mut p = json!({});
        if let Some(path) = output_path {
            p["outputPath"] = json!(path);
        }
        self.request_checked("export_html", p, Some(DEFAULT_TIMEOUT))
            .await
    }


    pub async fn get_tree(&self) -> Result<Value, String> {
        self.request_checked("get_tree", json!({}), None).await
    }

    pub async fn fork(&self, entry_id: &str) -> Result<Value, String> {
        self.request_checked(
            "fork",
            json!({ "entryId": entry_id }),
            Some(DEFAULT_TIMEOUT),
        )
        .await
    }

    pub async fn clone_session(&self) -> Result<Value, String> {
        self.request_checked("clone", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn get_fork_messages(&self) -> Result<Value, String> {
        self.request_checked("get_fork_messages", json!({}), Some(DEFAULT_TIMEOUT))
            .await
    }

    pub async fn set_thinking_level(&self, level: &str) -> Result<Value, String> {
        self.request_checked(
            "set_thinking_level",
            json!({ "level": level }),
            Some(DEFAULT_TIMEOUT),
        )
        .await
    }

    pub async fn get_available_thinking_levels(&self) -> Result<Value, String> {
        self.request_checked(
            "get_available_thinking_levels",
            json!({}),
            Some(DEFAULT_TIMEOUT),
        )
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

    pub async fn raw_request(
        &self,
        command: &str,
        payload: Value,
        timeout: Option<Duration>,
    ) -> Result<Value, String> {
        self.request(command, payload, timeout).await
    }

    /// 直接写入 stdin（测试/调试用；正常路径走 request）。
    pub async fn stdin_send(&self, line: &str) -> Result<(), String> {
        self.stdin_tx
            .send(line.to_string())
            .await
            .map_err(|e| e.to_string())
    }

    /// Extension UI 应答（docs/02 §8）：写回 stdin。
    pub async fn ui_response(&self, response: Value) -> Result<(), String> {
        let line = serde_json::to_string(&response).map_err(|e| e.to_string())?;
        self.stdin_tx.send(line).await.map_err(|e| e.to_string())
    }
}
