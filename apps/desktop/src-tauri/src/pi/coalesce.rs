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
    /// 共享的标签页句柄（**不是** spawn 时拷下来的字符串：预热池会把一个已起的
    /// 进程重绑给另一个标签页，帧必须跟着走 —— 见 `client.rs::TabSlot`）
    tab: super::client::TabSlot,
    sink: Arc<dyn EventSink>,
    text: Vec<(i64, String)>,
    thinking: Vec<(i64, String)>,
    tool_args: Vec<(i64, String)>,
    signals: Vec<Value>,
    usage: Option<Value>,
}

/// 测试用：把字符串包成共享句柄。
#[cfg(test)]
fn slot(tab: &str) -> super::client::TabSlot {
    std::sync::Arc::new(std::sync::RwLock::new(tab.to_string()))
}

impl FrameCoalescer {
    pub fn new(tab: super::client::TabSlot, sink: Arc<dyn EventSink>) -> Self {
        Self {
            tab,
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
        let tab = self.tab.read().unwrap_or_else(|e| e.into_inner()).clone();
        self.sink.emit_json(&format!("pi:frame:{tab}"), frame);
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
        let mut c = FrameCoalescer::new(slot("t1"), sink.clone());
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

    /// **通道名在 flush 时读，不在构造时拷**（2026-10-09 立，2026-10-13 保留）。
    ///
    /// 立这条不变量是因为当时的预热池要复用一个已起的进程去服务**另一个**标签页。
    /// 预热池已删（docs/05 §5.7），但这条例仍值得留着：判据错了的形式是**静默串台** ——
    /// 帧发到一个标签、内容却属于另一个，两边都不报错，用户看到的是"字长到别的标签里"。
    /// 它也顺带钉住"合帧器持的是共享槽、不是一份快照"这个设计。
    #[tokio::test]
    async fn frames_follow_a_rebind() {
        let sink = Arc::new(CollectorSink {
            events: StdMutex::new(Vec::new()),
        });
        let s1 = slot("tab-old");
        let mut c = FrameCoalescer::new(s1.clone(), sink.clone());
        c.push_delta(&ame("text_delta", 0, Some("旧")));
        c.flush().await;
        assert_eq!(sink.events.lock().unwrap()[0].0, "pi:frame:tab-old");

        // 预热池把同一个进程重绑给新标签页
        *s1.write().unwrap() = "tab-new".to_string();
        c.push_delta(&ame("text_delta", 0, Some("新")));
        c.flush().await;
        let events = sink.events.lock().unwrap();
        assert_eq!(
            events[1].0, "pi:frame:tab-new",
            "重绑之后帧还发到旧标签页 —— 这是静默串台"
        );
    }

    #[tokio::test]
    async fn empty_flush_is_noop() {
        let sink = Arc::new(CollectorSink {
            events: StdMutex::new(Vec::new()),
        });
        let mut c = FrameCoalescer::new(slot("t1"), sink.clone());
        c.flush().await;
        c.flush().await;
        assert!(sink.events.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn signal_causes_pending_deltas_to_flush() {
        let sink = Arc::new(CollectorSink {
            events: StdMutex::new(Vec::new()),
        });
        let mut c = FrameCoalescer::new(slot("t1"), sink.clone());
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
