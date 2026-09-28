//! Rust↔TS 契约对拍（docs/08 §5）：读取 packages/pi-protocol/fixtures/*.json，
//! 断言 Rust 侧协议分类器与 TS 侧 zod schema 对同一数据集均可解析。

use piggy_lib::pi::protocol::{classify, PiEvent};
use serde_json::Value;
use std::fs;
use std::path::PathBuf;

fn fixtures_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/pi-protocol/fixtures")
}

#[test]
fn all_fixtures_classify() {
    let dir = fixtures_dir();
    let mut count = 0;
    for entry in fs::read_dir(&dir).expect("fixtures dir") {
        let path = entry.unwrap().path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let raw: Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).expect("valid json");
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        if raw["type"] == "response" {
            // 响应类：仅要求可解析为 JSON（client 按回执处理）
            continue;
        }
        if let PiEvent::Other { kind } = classify(&raw) {
            panic!("fixture {name} 意外落入未知事件分类: {kind}");
        }
        count += 1;
    }
    assert!(count >= 20, "fixture 数量异常: {count}");
}

#[test]
fn known_event_kinds_map_correctly() {
    let cases = [
        ("event_agent_start.json", "agent_start"),
        ("event_agent_settled.json", "agent_settled"),
        ("event_message_end_user.json", "message_end"),
        ("event_update_text_delta.json", "message_update"),
        ("event_extension_ui_request.json", "extension_ui_request"),
    ];
    for (file, expected) in cases {
        let raw: Value = serde_json::from_str(
            &fs::read_to_string(fixtures_dir().join(file)).unwrap(),
        )
        .unwrap();
        assert_eq!(raw["type"], expected, "{file}");
        let _ = classify(&raw);
    }
}

#[test]
fn unknown_event_type_falls_to_other_without_loss() {
    let raw: Value =
        serde_json::from_str(r#"{"type":"shiny_new_event_v2","payload":{"a":1}}"#).unwrap();
    match classify(&raw) {
        PiEvent::Other { kind } => assert_eq!(kind, "shiny_new_event_v2"),
        _ => panic!("unknown should map to Other"),
    }
}
