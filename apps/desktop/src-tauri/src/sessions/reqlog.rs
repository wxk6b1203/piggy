//! 请求头快照（docs/05 §6.4、docs/21 §8 C2）：每次发 prompt 前落一条 JSONL，
//! 回答"这一轮模型到底看到了什么配置"。
//!
//! 为什么需要它：pi 的 RPC 事件面**没有** `request/header`（对照 dsh 有），
//! 会话文件里的 system message 又是"启动时一段 + 之后若干增量"，排障时很难一眼看出
//! 这一轮用的是哪个模型、开了哪些工具、system prompt 是哪一版。这里做的就是把
//! **宿主知道的那部分**固化下来：
//!
//! ```text
//! ~/.piggy/traces/requests.jsonl          每轮一行（追加）
//! ~/.piggy/traces/system/<hash>.json      system message 原文（按内容哈希去重）
//! ```
//!
//! 边界（说清楚，别过度承诺）：
//! - 只记**头**，不记消息体；不落 API key（`model` 只存 id/provider）。
//! - system prompt 取会话文件**开头 1MB** 里的第一条 `role:"system"` —— 那是基础提示词
//!   与工具声明；之后 pi 追加的增量（工具增删）不在这里，用本行 `tools` 字段对齐。
//! - 写失败绝不能影响发消息：调用方一律 `let _ = ...`。

use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};

/// 扫描 system message 时只读会话文件开头这么多字节。
///
/// 1MB 足够覆盖"会话头 + 基础 system message"（实测 system message 通常 10–40KB）；
/// 长会话每轮全量扫会被这个上限挡住。
const PREFIX_BYTES: usize = 1 << 20;

/// 一轮请求头快照。
pub struct TurnSnapshot<'a> {
    pub tab_id: &'a str,
    pub session_file: Option<&'a str>,
    pub cwd: &'a Path,
    pub permission: &'a str,
    pub model: Option<&'a str>,
    pub provider: Option<&'a str>,
    pub thinking: Option<&'a str>,
    /// `None` = 不限制（完全权限）。
    pub tools: Option<&'a [String]>,
}

/// 写一条快照（默认目录 `~/.piggy/traces/`）。
pub fn record(snap: &TurnSnapshot) -> std::io::Result<PathBuf> {
    record_in(&crate::config::app::traces_dir(), snap)
}

/// 同 [`record`]，但目录可注入（单测用）。
pub fn record_in(dir: &Path, snap: &TurnSnapshot) -> std::io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    let system = snap.session_file.map(Path::new).and_then(system_message);
    let system_hash = system.as_ref().map(stable_hash);
    if let (Some(hash), Some(sys)) = (&system_hash, &system) {
        let sys_dir = dir.join("system");
        std::fs::create_dir_all(&sys_dir)?;
        let path = sys_dir.join(format!("{hash}.json"));
        // 内容寻址：同一份 system prompt 只写一次
        if !path.exists() {
            std::fs::write(&path, serde_json::to_vec_pretty(sys)?)?;
        }
    }
    let line = json!({
        "t": now_ms(),
        "tab": snap.tab_id,
        "sessionFile": snap.session_file,
        "cwd": snap.cwd.to_string_lossy(),
        "permission": snap.permission,
        "model": snap.model,
        "provider": snap.provider,
        "thinkingLevel": snap.thinking,
        "tools": snap.tools,
        "systemHash": system_hash,
    });
    let out = dir.join("requests.jsonl");
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(&out)?;
    // 一行一次 write：POSIX 的 O_APPEND 对小于 PIPE_BUF 的写是原子的；
    // 多标签页并发追加最多是"两行交错"（仍是合法 JSONL），不会互相截断。
    f.write_all(serde_json::to_string(&line)?.as_bytes())?;
    f.write_all(b"\n")?;
    Ok(out)
}

/// 从会话文件开头取第一条 `role:"system"` 的消息体。
///
/// 返回的是 `message` 对象（含 role/content/tools 等），不含外层 entry 元数据。
pub fn system_message(path: &Path) -> Option<Value> {
    let bytes = read_prefix(path, PREFIX_BYTES)?;
    extract_system_message(&bytes)
}

/// 纯函数版（单测直接喂字节）。
pub fn extract_system_message(bytes: &[u8]) -> Option<Value> {
    for line in bytes.split(|b| *b == b'\n') {
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue; // 半行（超出前缀被截断）或非 JSON：跳过
        };
        if v.get("type").and_then(Value::as_str) != Some("message") {
            continue;
        }
        let msg = v.get("message")?;
        if msg.get("role").and_then(Value::as_str) == Some("system") {
            return Some(msg.clone());
        }
    }
    None
}

fn read_prefix(path: &Path, limit: usize) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut f = std::fs::File::open(path).ok()?;
    let mut buf = vec![0u8; limit];
    let mut filled = 0usize;
    loop {
        match f.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => {
                filled += n;
                if filled == limit {
                    break;
                }
            }
            Err(_) => return None,
        }
    }
    buf.truncate(filled);
    Some(buf)
}

/// 稳定的内容哈希（FNV-1a 64）。
///
/// **不能用 `DefaultHasher`**：它的 key 每个进程随机，跨应用重启算出的哈希不同，
/// "同一份 system prompt 只存一次"会退化成"每次启动都多存一份"。
fn stable_hash(v: &Value) -> String {
    let text = serde_json::to_string(v).unwrap_or_default();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in text.as_bytes() {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn system_entry(text: &str) -> String {
        json!({
            "type": "message",
            "id": "sys-1",
            "parentId": null,
            "timestamp": "2026-11-07T00:00:00.000Z",
            "message": {
                "role": "system",
                "content": [{"type": "text", "text": text}],
                "tools": [{"name": "read"}],
            }
        })
        .to_string()
    }

    #[test]
    fn finds_the_first_system_message_and_ignores_header_and_truncation() {
        let body = format!(
            "{}\n{}\n{{\"type\":\"message\",\"message\":{{\"role\":\"user\"",
            json!({"type": "session", "version": 3}),
            system_entry("You are pi.")
        );
        let found = extract_system_message(body.as_bytes()).expect("应找到 system");
        assert_eq!(found["role"], "system");
        assert_eq!(found["content"][0]["text"], "You are pi.");
        // 尾部半行（被 1MB 截断）不影响前面已经找到的那条
        assert!(extract_system_message(format!("{body}\n{{\"type\":\"mess").as_bytes()).is_some());
        // 没有任何 system message
        assert!(extract_system_message(json!({"type": "session"}).to_string().as_bytes()).is_none());
    }

    #[test]
    fn hash_is_stable_and_content_addressed() {
        let a = json!({"role": "system", "content": "x"});
        let b = json!({"role": "system", "content": "x"});
        let c = json!({"role": "system", "content": "y"});
        assert_eq!(stable_hash(&a), stable_hash(&b));
        assert_ne!(stable_hash(&a), stable_hash(&c));
        // 固定值：跨进程必须一致（换成 DefaultHasher 这行会红——它每个进程加盐）
        assert_eq!(stable_hash(&json!(null)), "5b9bc4ba528108e4");
        assert_eq!(stable_hash(&a).len(), 16);
    }

    #[test]
    fn record_appends_one_header_line_and_dedupes_the_system_file() {
        let dir = std::env::temp_dir().join(format!("piggy-reqlog-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let session = dir.join("s.jsonl");
        std::fs::write(
            &session,
            format!("{}\n{}\n", json!({"type": "session"}), system_entry("sys")),
        )
        .unwrap();

        let tools = vec!["read".to_string(), "write".to_string()];
        let snap = TurnSnapshot {
            tab_id: "t1",
            session_file: Some(session.to_str().unwrap()),
            cwd: &dir,
            permission: "workspace",
            model: Some("deepseek-flash"),
            provider: Some("deepseek"),
            thinking: Some("medium"),
            tools: Some(&tools),
        };
        let out = record_in(&dir, &snap).unwrap();
        record_in(&dir, &snap).unwrap();

        let raw = std::fs::read_to_string(&out).unwrap();
        let lines: Vec<&str> = raw.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
        assert_eq!(lines.len(), 2, "每轮一行");
        let first: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["tab"], "t1");
        assert_eq!(first["model"], "deepseek-flash");
        assert_eq!(first["permission"], "workspace");
        assert_eq!(first["tools"], json!(["read", "write"]));
        assert!(first["systemHash"].as_str().unwrap().len() == 16);

        // 同一份 system prompt 只写一份文件
        let sys_files: Vec<_> = std::fs::read_dir(dir.join("system")).unwrap().collect();
        assert_eq!(sys_files.len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
