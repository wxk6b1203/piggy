//! 前端事件总线（docs/03 §2.14）：统一通道命名。
//! EventSink 抽象使核心逻辑不依赖 tauri，可被测试直接驱动。

use serde_json::Value;
use std::sync::Mutex as StdMutex;

pub trait EventSink: Send + Sync + 'static {
    fn emit_json(&self, channel: &str, payload: Value);
}

pub struct TauriSink {
    pub app: tauri::AppHandle,
}

impl EventSink for TauriSink {
    fn emit_json(&self, channel: &str, payload: Value) {
        use tauri::Emitter;
        let _ = self.app.emit(channel, payload);
    }
}

/// 测试用：收集所有事件（契约测试 / 单测）。
#[derive(Default)]
pub struct CollectorSink {
    pub events: StdMutex<Vec<(String, Value)>>,
}

impl EventSink for CollectorSink {
    fn emit_json(&self, channel: &str, payload: Value) {
        self.events.lock().unwrap().push((channel.to_string(), payload));
    }
}

/// 静默 sink（契约测试中不需要收集时使用）。
#[derive(Default)]
pub struct NullSink;

impl EventSink for NullSink {
    fn emit_json(&self, _channel: &str, _payload: Value) {}
}
