//! 协议类型（docs/02 §5.1）：只强类型化 Piggy 消费的字段，原始 JSON 全量透传。
//! 手写 classify（按 `type` 字符串分派）而非 serde 枚举 tag，
//! 未知事件类型降级为 `Other` 且不丢原始数据——向前兼容的根基。

use serde_json::Value;

/// `message_update.assistantMessageEvent`（docs/02 §4.2）
#[derive(Debug, Clone)]
pub struct Ame {
    pub kind: String,
    pub content_index: i64,
    pub delta: Option<String>,
    pub tool_call_id: Option<String>,
    pub tool_name: Option<String>,
    pub raw: Value,
}

/// 高频增量类型（合帧器合并对象）；其余（start/end 边界）走信号通道。
pub const DELTA_KINDS: [&str; 3] = ["text_delta", "thinking_delta", "toolcall_delta"];

#[derive(Debug, Clone)]
pub enum PiEvent {
    AgentStart,
    AgentEnd {
        will_retry: bool,
        raw: Value,
    },
    AgentSettled,
    MessageStart {
        message: Value,
    },
    MessageUpdate {
        usage: Option<Value>,
        ame: Ame,
    },
    MessageEnd {
        message: Value,
    },
    ToolExecStart {
        tool_call_id: String,
        tool_name: String,
    },
    ToolExecUpdate {
        tool_call_id: String,
    },
    ToolExecEnd {
        tool_call_id: String,
        is_error: bool,
    },
    QueueUpdate {
        steering: Vec<String>,
        follow_up: Vec<String>,
    },
    TurnStart,
    TurnEnd {
        raw: Value,
    },
    CompactionStart {
        reason: String,
    },
    CompactionEnd {
        raw: Value,
    },
    AutoRetry {
        raw: Value,
    },
    SummarizationRetry {
        raw: Value,
    },
    ExtensionError {
        raw: Value,
    },
    BashExecutionUpdate {
        id: Option<String>,
        delta: String,
    },
    ExtensionUiRequest {
        raw: Value,
    },
    Other {
        kind: String,
    },
}

pub fn classify(raw: &Value) -> PiEvent {
    let kind = raw["type"].as_str().unwrap_or("").to_string();
    match kind.as_str() {
        "agent_start" => PiEvent::AgentStart,
        "agent_end" => PiEvent::AgentEnd {
            will_retry: raw["willRetry"].as_bool().unwrap_or(false),
            raw: raw.clone(),
        },
        "agent_settled" => PiEvent::AgentSettled,
        "message_start" => PiEvent::MessageStart {
            message: raw["message"].clone(),
        },
        "message_update" => PiEvent::MessageUpdate {
            usage: raw.get("usage").filter(|u| !u.is_null()).cloned(),
            ame: parse_ame(&raw["assistantMessageEvent"]),
        },
        "message_end" => PiEvent::MessageEnd {
            message: raw["message"].clone(),
        },
        "tool_execution_start" => PiEvent::ToolExecStart {
            tool_call_id: raw["toolCallId"].as_str().unwrap_or_default().to_string(),
            tool_name: raw["toolName"].as_str().unwrap_or_default().to_string(),
        },
        "tool_execution_update" => PiEvent::ToolExecUpdate {
            tool_call_id: raw["toolCallId"].as_str().unwrap_or_default().to_string(),
        },
        "tool_execution_end" => PiEvent::ToolExecEnd {
            tool_call_id: raw["toolCallId"].as_str().unwrap_or_default().to_string(),
            is_error: raw["isError"].as_bool().unwrap_or(false),
        },
        "queue_update" => PiEvent::QueueUpdate {
            steering: str_array(&raw["steering"]),
            follow_up: str_array(&raw["followUp"]),
        },
        "extension_ui_request" => PiEvent::ExtensionUiRequest { raw: raw.clone() },
        "turn_start" => PiEvent::TurnStart,
        "turn_end" => PiEvent::TurnEnd { raw: raw.clone() },
        "compaction_start" => PiEvent::CompactionStart {
            reason: raw["reason"].as_str().unwrap_or_default().to_string(),
        },
        "compaction_end" => PiEvent::CompactionEnd { raw: raw.clone() },
        "auto_retry_start" | "auto_retry_end" => PiEvent::AutoRetry { raw: raw.clone() },
        "summarization_retry_scheduled" | "summarization_retry_attempt_start"
        | "summarization_retry_finished" => PiEvent::SummarizationRetry { raw: raw.clone() },
        "extension_error" => PiEvent::ExtensionError { raw: raw.clone() },
        "bash_execution_update" => PiEvent::BashExecutionUpdate {
            id: raw["id"].as_str().map(String::from),
            delta: raw["delta"].as_str().unwrap_or_default().to_string(),
        },
        other => PiEvent::Other {
            kind: other.to_string(),
        },
    }
}

fn parse_ame(v: &Value) -> Ame {
    Ame {
        kind: v["type"].as_str().unwrap_or("").to_string(),
        content_index: v["contentIndex"].as_i64().unwrap_or(0),
        delta: v["delta"].as_str().map(String::from),
        tool_call_id: v["id"].as_str().map(String::from),
        tool_name: v["toolName"].as_str().map(String::from),
        raw: v.clone(),
    }
}

fn str_array(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}
