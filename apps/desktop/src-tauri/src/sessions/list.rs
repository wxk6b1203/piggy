//! 会话文件扫描（docs/02 §6.1、03 §2.8）：零 pi 进程成本读取侧栏数据。
//!
//! 解析策略（M0 契约：懒落盘 + 文件可能很大）：
//! - 头部 64KB：SessionHeader（id/cwd/timestamp）+ 首条用户消息（未命名会话的展示文案）；
//! - 尾部 16KB：`session_info` 条目（set_session_name 追加在尾部，最新名字优先）。

use crate::config::pi_files;
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
    /// 项目目录已不存在（打开会失败）
    pub cwd_missing: bool,
}

/// 扫描生效会话目录（settings.json `sessionDir` 优先，docs/09 M1 WP5）。
pub fn scan_sessions() -> Vec<SessionMeta> {
    scan_dir(&pi_files::sessions_root())
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
    out.sort_by_key(|m| std::cmp::Reverse(m.mtime_ms));
    out
}

pub fn parse_session_file(path: &Path) -> Option<SessionMeta> {
    let md = std::fs::metadata(path).ok()?;
    let mut file = std::fs::File::open(path).ok()?;
    use std::io::{Seek, SeekFrom};

    // 头部
    let head_len = HEAD_BYTES.min(md.len());
    let mut head = vec![0u8; head_len as usize];
    std::io::Read::read_exact(&mut file, &mut head).ok()?;

    let mut header_id = None;
    let mut header_cwd = None;
    let mut first_user = None;
    // 头部（全段扫描）：session header（id/cwd）、首条用户消息、session_info 命名。
    // session_info 必须在头部也解析：改名写入的是小文件（<64KB）时，名字只存在于"头部"窗口。
    let mut name = None;
    for line in head.split(|&b| b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else {
            continue;
        };
        match v["type"].as_str() {
            Some("session") => {
                header_id = v["id"].as_str().map(String::from);
                header_cwd = v["cwd"].as_str().map(String::from);
            }
            Some("message") if v["message"]["role"] == "user" && first_user.is_none() => {
                first_user = extract_text(&v["message"]["content"]);
            }
            Some("session_info") => {
                if let Some(n) = v["name"].as_str() {
                    name = Some(n.to_string());
                }
            }
            _ => {}
        }
    }

    // 尾部（session_info 最新名字）——仅当文件超过头部窗口时，尾部条目更新、覆盖头部结果
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

    let cwd_missing = header_cwd
        .as_ref()
        .map(|c| !Path::new(c).exists())
        .unwrap_or(true);
    Some(SessionMeta {
        path: path.to_string_lossy().into_owned(),
        file_name: path.file_name()?.to_string_lossy().into_owned(),
        session_id: Some(header_id),
        cwd: header_cwd,
        name,
        first_message: first_user,
        mtime_ms: mtime,
        size: md.len(),
        cwd_missing,
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

/* ---------------- 新会话预落盘（docs/02 §6.1 懒落盘的绕过） ---------------- */

/// 为新会话预创建**空**会话文件并返回路径。
///
/// pi 对 `--session <空文件>` 的行为（session-manager `_setSessionFile`）：立即写入
/// session header 并置 flushed，此后所有条目（含 `--name` 命名）直接追加落盘——
/// 绕过"首个 LLM 回合完成才写盘"的懒落盘，空白会话因此不会再丢失。
///
/// 路径遵循 pi 自身约定，保证与扫描器/终端 pi 双向兼容（G7）：
/// `<sessionRoot>/--<cwd 编码>--/<ISO时间戳>_<uuid>.jsonl`
pub fn precreate_session_file(cwd: &Path) -> Result<PathBuf, String> {
    precreate_session_file_in(&pi_files::sessions_root(), cwd)
}

/// 同上，root 由调用方注入（测试友好）。
pub fn precreate_session_file_in(root: &Path, cwd: &Path) -> Result<PathBuf, String> {
    // pi getDefaultSessionDirPath：去掉一个前导 / 或 \，再把 / \ : 全替换为 -，两侧包 --
    let s = cwd.to_string_lossy();
    let stripped = s
        .strip_prefix('/')
        .or_else(|| s.strip_prefix('\\'))
        .unwrap_or(&s);
    let safe = stripped.replace(['/', '\\', ':'], "-");
    let dir = root.join(format!("--{safe}--"));
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建会话目录失败: {e}"))?;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let name = format!(
        "{}_{}.jsonl",
        iso_timestamp_filename(now_ms),
        uuid::Uuid::new_v4()
    );
    let path = dir.join(name);
    // O_EXCL 创建空文件：并发/重试下不覆盖任何已有文件
    std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|e| format!("创建会话文件失败: {e}"))?;
    Ok(path)
}

/// epoch ms → `YYYY-MM-DDTHH-MM-SS-mmmZ`（pi 文件名时间戳格式：ISO 冒号/点替换为 -）。
/// 手写 civil-from-days（Howard Hinnant 算法），避免为格式化一个文件名引入 chrono。
fn iso_timestamp_filename(now_ms: u64) -> String {
    let secs = (now_ms / 1000) as i64;
    let ms = now_ms % 1000;
    let days = secs.div_euclid(86_400);
    let sod = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}-{:02}-{:02}-{ms:03}Z",
        sod / 3600,
        (sod % 3600) / 60,
        sod % 60
    )
}

fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// fs watcher（02 §6.2）：递归监听一组根目录（agent 目录 + 生效会话根，可含自定义
/// sessionDir），debounce 后通知。返回 Watcher 句柄必须保活（drop 即停止监听）。
pub fn spawn_sessions_watcher<F: Fn() + Send + 'static>(
    roots: Vec<PathBuf>,
    on_change: F,
) -> Result<std::sync::Arc<dyn Watcher + Send + Sync>, String> {
    let (tx, rx) = std_mpsc::channel::<Event>();
    let tx2 = tx.clone();
    let mut watcher: notify::RecommendedWatcher =
        notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            let _ = tx2.send(res.unwrap_or_else(|_| Event::default()));
        })
        .map_err(|e| format!("watcher init failed: {e}"))?;
    let mut watched = 0;
    for root in roots {
        std::fs::create_dir_all(&root).ok();
        if watcher.watch(&root, RecursiveMode::Recursive).is_ok() {
            watched += 1;
        }
    }
    if watched == 0 {
        return Err("watch failed: 无可监听目录".into());
    }
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

    #[test]
    fn iso_timestamp_matches_pi_filename_format() {
        assert_eq!(iso_timestamp_filename(0), "1970-01-01T00-00-00-000Z");
        assert_eq!(iso_timestamp_filename(1_790_052_800_088), "2026-09-22T04-53-20-088Z");
        assert_eq!(iso_timestamp_filename(951_912_000_500), "2000-03-01T12-00-00-500Z");
    }

    #[test]
    fn small_file_session_info_is_parsed() {
        // 临时/空白会话只有几百字节：改名写入的 session_info 必须能读到
        let header = r#"{"type":"session","version":3,"id":"sid-3","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/tmp/p3"}"#;
        let info = r#"{"type":"session_info","id":"i1","parentId":null,"name":"我的新名字"}"#;
        let p = write_tmp_session(&format!("{header}\n{info}\n"));
        let m = parse_session_file(&p).expect("meta");
        assert_eq!(m.name.as_deref(), Some("我的新名字"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn last_rename_wins() {
        let header = r#"{"type":"session","version":3,"id":"sid-4","timestamp":"2026-09-23T00:00:00.000Z","cwd":"/tmp/p4"}"#;
        let i1 = r#"{"type":"session_info","id":"i1","parentId":null,"name":"第一个名字"}"#;
        let i2 = r#"{"type":"session_info","id":"i2","parentId":null,"name":"第二个名字"}"#;
        let p = write_tmp_session(&format!("{header}\n{i1}\n{i2}\n"));
        let m = parse_session_file(&p).expect("meta");
        assert_eq!(m.name.as_deref(), Some("第二个名字"));
        std::fs::remove_file(&p).ok();
    }

    #[test]
    fn precreate_follows_pi_dir_and_file_naming() {
        let root = std::env::temp_dir().join(format!("piggy-precreate-{}", std::process::id()));
        let cwd = Path::new("/Users/wxk/My:Proj");
        let p = precreate_session_file_in(&root, cwd).expect("precreate");
        // 目录编码与 pi getDefaultSessionDirPath 一致
        assert_eq!(
            p.parent().unwrap(),
            root.join("--Users-wxk-My-Proj--"),
            "项目目录编码应符合 pi 约定"
        );
        let name = p.file_name().unwrap().to_string_lossy();
        // <ISO 时间戳>_<uuid>.jsonl
        let rest = name.strip_suffix(".jsonl").unwrap();
        let (ts, id) = rest.split_once('_').unwrap();
        assert!(ts.starts_with(char::is_numeric) && ts.contains('T') && ts.ends_with('Z'));
        assert_eq!(id.matches('-').count(), 4);
        // 空文件已创建；再次创建不覆盖（O_EXCL，生成新名）
        assert!(p.metadata().unwrap().len() == 0);
        let p2 = precreate_session_file_in(&root, cwd).expect("precreate 2");
        assert_ne!(p, p2);
        std::fs::remove_dir_all(&root).ok();
    }
}
