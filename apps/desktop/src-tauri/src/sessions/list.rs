//! 会话文件扫描（docs/02 §6.1、03 §2.8）：零 pi 进程成本读取侧栏数据。
//!
//! 解析策略（M0 契约：懒落盘 + 文件可能很大）：
//! - 头部 64KB：SessionHeader（id/cwd/timestamp）+ 首条用户消息（未命名会话的展示文案）；
//! - 尾部 16KB：`session_info` 条目（set_session_name 追加在尾部，最新名字优先）。

use notify::{Event, RecursiveMode, Watcher};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::mpsc as std_mpsc;
use std::time::Duration;

const HEAD_BYTES: u64 = 64 * 1024;
const TAIL_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Serialize)]
pub struct SessionMeta {
    pub path: String,
    pub file_name: String,
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub name: Option<String>,
    pub first_message: Option<String>,
    pub mtime_ms: u64,
    pub size: u64,
}

/// 扫描默认会话目录（`~/.pi/agent/sessions`）；目录缺失视为空。
pub fn scan_sessions() -> Vec<SessionMeta> {
    let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let root = home.join(".pi/agent/sessions");
    scan_dir(&root)
}

pub fn scan_dir(root: &Path) -> Vec<SessionMeta> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for proj in rd.flatten() {
        let proj_path = proj.path();
        if !proj_path.is_dir() {
            continue;
        }
        let Ok(files) = std::fs::read_dir(&proj_path) else {
            continue;
        };
        for f in files.flatten() {
            let path = f.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if let Some(meta) = parse_session_file(&path) {
                out.push(meta);
            }
        }
    }
    out.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms));
    out
}

pub fn parse_session_file(path: &Path) -> Option<SessionMeta> {
    let md = std::fs::metadata(path).ok()?;
    let mut file = std::fs::File::open(path).ok()?;
    use std::io::{Read, Seek, SeekFrom};

    // 头部
    let head_len = HEAD_BYTES.min(md.len());
    let mut head = vec![0u8; head_len as usize];
    std::io::Read::read_exact(&mut file, &mut head).ok()?;

    let mut header_id = None;
    let mut header_cwd = None;
    let mut first_user = None;
    for line in head.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        if v["type"] == "session" {
            header_id = v["id"].as_str().map(String::from);
            header_cwd = v["cwd"].as_str().map(String::from);
        }
        if first_user.is_none() && v["type"] == "message" && v["message"]["role"] == "user" {
            first_user = extract_text(&v["message"]["content"]);
        }
        if header_id.is_some() && first_user.is_some() {
            break;
        }
    }

    // 尾部（session_info 最新名字）
    let mut name = None;
    if md.len() > HEAD_BYTES {
        let tail_len = TAIL_BYTES.min(md.len() - HEAD_BYTES);
        file.seek(SeekFrom::End(-(tail_len as i64))).ok()?;
        let mut tail = vec![0u8; tail_len as usize];
        std::io::Read::read(&mut file, &mut tail).ok()?;
        // 尾部首行可能是半行，跳到第一个换行后
        for line in tail.split(|&b| b == b'\n').skip(1) {
            let Ok(v) = serde_json::from_slice::<Value>(line) else {
                continue;
            };
            if v["type"] == "session_info" {
                if let Some(n) = v["name"].as_str() {
                    name = Some(n.to_string());
                }
            }
        }
    }

    let Some(header_id) = header_id else {
        return None; // 无 SessionHeader：空文件/损坏文件
    };
    let mtime = md
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    Some(SessionMeta {
        path: path.to_string_lossy().into_owned(),
        file_name: path.file_name()?.to_string_lossy().into_owned(),
        session_id: Some(header_id),
        cwd: header_cwd,
        name,
        first_message: first_user,
        mtime_ms: mtime,
        size: md.len(),
    })
}

fn extract_text(content: &Value) -> Option<String> {
    match content {
        Value::String(s) => Some(s.chars().take(120).collect()),
        Value::Array(blocks) => {
            for b in blocks {
                if b["type"] == "text" {
                    return b["text"].as_str().map(|s| s.chars().take(120).collect());
                }
            }
            None
        }
        _ => None,
    }
}

/// 删除（移入系统回收站；docs/02 §6.1 trash 语义）。
pub fn trash_session(path: &str) -> Result<(), String> {
    trash::delete(path).map_err(|e| format!("移入回收站失败: {e}"))
}

/// fs watcher（02 §6.2）：递归监听会话目录，debounce 后通知。
/// 返回 Watcher 句柄必须保活（drop 即停止监听）。
pub fn spawn_sessions_watcher<F: Fn() + Send + 'static>(
    root: PathBuf,
    on_change: F,
) -> Result<std::sync::Arc<dyn Watcher + Send + Sync>, String> {
    let (tx, rx) = std_mpsc::channel::<Event>();
    let tx2 = tx.clone();
    let mut watcher: notify::RecommendedWatcher =
        notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let _ = tx2.send(res.unwrap_or_else(|_| Event::default()));
        })
        .map_err(|e| format!("watcher init failed: {e}"))?;
    std::fs::create_dir_all(&root).ok();
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| format!("watch failed: {e}"))?;
    let handle: std::sync::Arc<dyn Watcher + Send + Sync> = std::sync::Arc::new(watcher);
    std::thread::spawn(move || {
        // notify 的 debounce 由内部 watcher 粗略保证；这里再做一层 300ms 合并
        let mut last = std::time::Instant::now() - Duration::from_secs(1);
        while rx.recv().is_ok() {
            let now = std::time::Instant::now();
            if now.duration_since(last) < Duration::from_millis(300) {
                continue;
            }
            last = now;
            on_change();
        }
    });
    Ok(handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_tmp_session(body: &str) -> PathBuf {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("piggy-list-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(format!("2026-09-22T00-00-00-000Z_test-{n}.jsonl"));
        std::fs::write(&p, body).unwrap();
        p
    }

    #[test]
    fn parses_header_first_user_and_session_info() {
        let header = r#"{"type":"session","version":3,"id":"sid-1","timestamp":"2026-09-22T01:00:00.000Z","cwd":"/tmp/proj"}"#;
        let user = r#"{"type":"message","id":"m1","parentId":null,"message":{"role":"user","content":"帮我修这个 bug"}}"#;
        let p = write_tmp_session(&format!("{header}\n{user}\n"));
        let m = parse_session_file(&p).expect("meta");
        assert_eq!(m.session_id.as_deref(), Some("sid-1"));
        assert_eq!(m.cwd.as_deref(), Some("/tmp/proj"));
        assert_eq!(m.first_message.as_deref(), Some("帮我修这个 bug"));
        assert!(m.name.is_none());
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn tail_session_info_wins_as_name() {
        let header = r#"{"type":"session","version":3,"id":"sid-2","timestamp":"2026-09-22T01:00:00.000Z","cwd":"/tmp/p2"}"#;
        let info = r#"{"type":"session_info","id":"i1","parentId":"x","name":"我的重命名会话"}"#;
        // 中间垫 200KB，保证 info 落在"尾部窗口"
        let pad = format!("{{\"pad\":\"{}\"}}\n", "x".repeat(200_000));
        let p = write_tmp_session(&format!("{header}\n{pad}{info}\n"));
        let m = parse_session_file(&p).expect("meta");
        assert_eq!(m.name.as_deref(), Some("我的重命名会话"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn broken_file_yields_none() {
        let dir = std::env::temp_dir().join(format!("piggy-list-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("broken.jsonl");
        std::fs::write(&p, b"").unwrap();
        assert!(parse_session_file(&p).is_none());
        std::fs::remove_file(&p).ok();
    }
}
