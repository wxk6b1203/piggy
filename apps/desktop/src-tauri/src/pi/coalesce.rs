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
    tab_id: String,
    sink: Arc<dyn EventSink>,
    text: Vec<(i64, String)>,
    thinking: Vec<(i64, String)>,
    tool_args: Vec<(i64, String)>,
    signals: Vec<Value>,
    usage: Option<Value>,
}

impl FrameCoalescer {
    pub fn new(tab_id: String, sink: Arc<dyn EventSink>) -> Self {
        Self {
            tab_id,
            sink,
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
        self.sink
            .emit_json(&format!("pi:frame:{}", self.tab_id), frame);
        self.text.clear();
        self.thinking.clear();
        self.tool_args.clear();
        self.signals.clear();
        self.usage = None;
    }
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
        let mut c = FrameCoalescer::new("t1".into(), sink.clone());
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
    }

    #[tokio::test]
    async fn empty_flush_is_noop() {
        let sink = Arc::new(CollectorSink {
            events: StdMutex::new(Vec::new()),
        });
        let mut c = FrameCoalescer::new("t1".into(), sink.clone());
        c.flush().await;
        c.flush().await;
        assert!(sink.events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn signal_causes_pending_deltas_to_flush() {
        let sink = Arc::new(CollectorSink {
            events: StdMutex::new(Vec::new()),
        });
        let mut c = FrameCoalescer::new("t1".into(), sink.clone());
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
