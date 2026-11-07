//! 合帧器（docs/02 §5、05 §3.2）：delta 合并、非 delta 直通。
//!
//! - `text/thinking/toolcall` delta 累积进帧；
//! - 块边界信号（*_start/_end、toolcall_start/end）入帧后**立即冲刷**
//!   （低频且驱动 UI 结构变化，等待窗口反而增加视觉滞后）；
//! - `usage` 取最新值搭车；
//! - 16ms 定时冲刷由 process.rs 的 reader 循环触发。

use crate::events::EventSink;
use serde_json::{json, Value};
use std::sync::Arc;

use super::protocol::Ame;

pub struct FrameCoalescer {
    /// 通道名里的标签页 id（spawn 时定死；2026-10-17 去掉共享槽，见 `client.rs`）
    tab: String,
    sink: Arc<dyn EventSink>,
    /// 事件信封序号（docs/02 §5.2）：每发出一个 `pi:frame` / `pi:commit` 自增。
    /// 前端用 `(seq, t)` 重建时序：`seq` 单调定序，`t` 是墙钟毫秒（可跨进程/跨会话比较）。
    seq: u64,
    text: Vec<(i64, String)>,
    thinking: Vec<(i64, String)>,
    tool_args: Vec<(i64, String)>,
    signals: Vec<Value>,
    usage: Option<Value>,
}

impl FrameCoalescer {
    pub fn new(tab: String, sink: Arc<dyn EventSink>) -> Self {
        Self {
            tab,
            sink,
            seq: 0,
            text: Vec::new(),
            thinking: Vec::new(),
            tool_args: Vec::new(),
            signals: Vec::new(),
            usage: None,
        }
    }

    pub fn push_delta(&mut self, ame: &Ame) {
        let Some(delta) = &ame.delta else {
            return;
        };
        match ame.kind.as_str() {
            "text_delta" => self.text.push((ame.content_index, delta.clone())),
            "thinking_delta" => self.thinking.push((ame.content_index, delta.clone())),
            "toolcall_delta" => self.tool_args.push((ame.content_index, delta.clone())),
            _ => {}
        }
    }

    pub fn push_signal(&mut self, ame: &Ame) {
        self.signals.push(ame.raw.clone());
    }

    /// usage 是累计值：直接换最新（搭下一帧）。
    pub fn set_usage(&mut self, usage: Option<Value>) {
        if usage.is_some() {
            self.usage = usage;
        }
    }

    pub fn has_pending(&self) -> bool {
        !self.text.is_empty()
            || !self.thinking.is_empty()
            || !self.tool_args.is_empty()
            || !self.signals.is_empty()
            || self.usage.is_some()
    }

    /// 给一条将要发往渲染进程的事件盖信封（`seq` 单调 + `t` 墙钟毫秒）。
    ///
    /// `pi:frame` 与 `pi:commit` **共用同一个计数器**，所以一次 delta 帧和它之后的
    /// `message_end` 提交在时间线上的先后是确定的——这正是 docs/05 §6 预算与轨迹
    /// 时间线做"首字延迟 / 每步耗时"所需要的。
    pub fn stamp(&mut self, mut v: Value) -> Value {
        self.seq += 1;
        v["seq"] = json!(self.seq);
        v["t"] = json!(now_ms());
        v
    }

    /// 冲刷一帧到 `pi:frame:{tab}`；空帧不发送（零事件零开销）。
    pub async fn flush(&mut self) {
        if !self.has_pending() {
            return;
        }
        let conv = |v: &[(i64, String)]| {
            v.iter()
                .map(|(i, s)| json!({"contentIndex": i, "delta": s}))
                .collect::<Vec<_>>()
        };
        let frame = json!({
            "text": conv(&self.text),
            "thinking": conv(&self.thinking),
            "toolArgs": conv(&self.tool_args),
            "signals": self.signals,
            "usage": self.usage,
        });
        let frame = self.stamp(frame);
        self.sink.emit_json(&format!("pi:frame:{}", self.tab), frame);
        self.text.clear();
        self.thinking.clear();
        self.tool_args.clear();
        self.signals.clear();
        self.usage = None;
    }
}

/// 墙钟毫秒。取不到系统时钟时退回 0（时间线只是"没有绝对时间"，不影响定序）。
fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::events::CollectorSink;
    use serde_json::from_value;
    use std::sync::Mutex as StdMutex;

    fn ame(kind: &str, ci: i64, delta: Option<&str>) -> Ame {
        Ame {
            kind: kind.to_string(),
            content_index: ci,
            delta: delta.map(String::from),
            tool_call_id: None,
            tool_name: None,
            raw: json!({"type": kind, "contentIndex": ci, "delta": delta}),
        }
    }

    #[tokio::test]
    async fn merges_deltas_into_one_frame() {
        let sink = Arc::new(CollectorSink {
            events: StdMutex::new(Vec::new()),
        });
        let mut c = FrameCoalescer::new("t1".to_string(), sink.clone());
        c.push_delta(&ame("text_delta", 0, Some("Hel")));
        c.push_delta(&ame("text_delta", 0, Some("lo ")));
        c.push_delta(&ame("text_delta", 0, Some("world")));
        c.set_usage(Some(json!({"totalTokens": 5})));
        c.flush().await;
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        let (ch, payload) = &events[0];
        assert_eq!(ch, "pi:frame:t1");
        let raw_items: Vec<serde_json::Value> = from_value(payload["text"].clone()).unwrap();
        let text: Vec<(i64, String)> = raw_items
            .into_iter()
            .map(|v| {
                (
                    v["contentIndex"].as_i64().unwrap(),
                    v["delta"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        // 3 个 delta → 3 项（保序）；合帧的意义是 1 次 IPC 携带全部
        assert_eq!(text.len(), 3);
        assert_eq!(text[0].1, "Hel");
        assert_eq!(payload["usage"]["totalTokens"], 5);
        // 信封（docs/02 §5.2）：帧自带 seq + 墙钟毫秒，前端不必再靠到达顺序猜时序
        assert_eq!(payload["seq"], 1, "首帧 seq 从 1 开始");
        assert!(payload["t"].as_u64().unwrap() > 1_700_000_000_000, "t 是毫秒时间戳");
    }

    #[tokio::test]
    async fn envelope_seq_is_monotonic_across_frames_and_commits() {
        let sink = Arc::new(CollectorSink {
            events: StdMutex::new(Vec::new()),
        });
        let mut c = FrameCoalescer::new("t1".to_string(), sink.clone());
        c.push_delta(&ame("text_delta", 0, Some("a")));
        c.flush().await;
        // process.rs 的提交路径走同一个 stamp：帧与提交共用一个计数器
        let commit = c.stamp(json!({"type": "message_end"}));
        c.flush().await; // 空帧不发送
        c.push_delta(&ame("text_delta", 0, Some("b")));
        c.flush().await;
        assert_eq!(commit["seq"], 2);
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 2, "空帧既不发送也不占序号");
        assert_eq!(events[0].1["seq"], 1);
        assert_eq!(events[1].1["seq"], 3, "提交占掉的 2 号不会复用");
        let t0 = events[0].1["t"].as_u64().unwrap();
        let t1 = events[1].1["t"].as_u64().unwrap();
        assert!(t1 >= t0);
    }

    #[tokio::test]
    async fn empty_flush_is_noop() {
        let sink = Arc::new(CollectorSink {
            events: StdMutex::new(Vec::new()),
        });
        let mut c = FrameCoalescer::new("t1".to_string(), sink.clone());
        c.flush().await;
        c.flush().await;
        assert!(sink.events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn signal_causes_pending_deltas_to_flush() {
        let sink = Arc::new(CollectorSink {
            events: StdMutex::new(Vec::new()),
        });
        let mut c = FrameCoalescer::new("t1".to_string(), sink.clone());
        c.push_delta(&ame("thinking_delta", 1, Some("hmm")));
        c.push_signal(&ame("toolcall_start", 2, None));
        assert!(c.has_pending());
        // process.rs 在信号路径上立即 flush；此处验证信号入帧
        c.flush().await;
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1["signals"][0]["type"], "toolcall_start");
        assert_eq!(events[0].1["thinking"][0]["delta"], "hmm");
    }
}
