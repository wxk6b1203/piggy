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
    /// 文件 mtime（最后写入时间）。列表**不再用它排序**，但仍保留：
    /// 它表达"最后活动"，而 `created_ms` 表达"何时创建"。
    pub mtime_ms: u64,
    /// 会话创建时间（毫秒）。来源优先级：SessionHeader.timestamp → 文件名里的 ISO 时间 → mtime。
    ///
    /// 为什么不用 mtime 排序：mtime 会随每次写入变化，于是"老会话被追加一条消息"
    /// 就跳到列表顶部，用户看到的就是**顺序经常变**。创建时间一旦写下就不再改变，
    /// 列表因此稳定。
    pub created_ms: u64,
    pub size: u64,
    /// 项目目录已不存在（打开会失败）
    pub cwd_missing: bool,
}

/// 扫描生效会话目录（settings.json `sessionDir` 优先，docs/09 M1 WP5）。
pub fn scan_sessions() -> Vec<SessionMeta> {
    scan_dir(&pi_files::sessions_root())
}

/// 收集一个 `.jsonl` 会话文件（非 jsonl / 解析失败静默跳过）。
fn push_session(out: &mut Vec<SessionMeta>, path: &Path) {
    if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
        return;
    }
    if let Some(meta) = parse_session_file(path) {
        out.push(meta);
    }
}

/// 扫描会话根目录，两种布局都要认（docs/03 §2.18）：
///
/// - **默认布局**：`<root>/--<cwd 编码>--/<时间戳>_<uuid>.jsonl`（pi 按 cwd 分子目录）
/// - **自定义 sessionDir**：pi 把该目录当**叶子**用，所有项目的会话**平铺**在根下
///   （`SessionManager.create` 直接 `join(sessionDir, 文件名)`，见 `session-manager.ts:1752-1756`）
///
/// 老代码只认子目录，于是"设了自定义 sessionDir 的机器上一片空白"。
pub fn scan_dir(root: &Path) -> Vec<SessionMeta> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root) else {
        return out;
    };
    for proj in rd.flatten() {
        let proj_path = proj.path();
        if proj_path.is_dir() {
            let Ok(files) = std::fs::read_dir(&proj_path) else {
                continue;
            };
            for f in files.flatten() {
                push_session(&mut out, &f.path());
            }
        } else {
            push_session(&mut out, &proj_path);
        }
    }
    // 按**创建时间**降序。用 mtime 排会随写入变化，顺序看起来经常变（用户报过）。
    out.sort_by_key(|m| std::cmp::Reverse(m.created_ms));
    out
}

pub fn parse_session_file(path: &Path) -> Option<SessionMeta> {
    let md = std::fs::metadata(path).ok()?;
    // 头部 SessionHeader 的创建时间戳（解析失败为 None）
    let mut header_ts: Option<u64> = None;
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
                // 创建时间就写在头部，此前读出来却被丢掉了
                header_ts = v["timestamp"].as_str().and_then(parse_iso8601_ms);
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
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    // 创建时间：头部 -> 文件名 -> mtime（逐级兜底，保证总有值）
    let created_ms = header_ts
        .or_else(|| filename_timestamp_ms(&file_name))
        .unwrap_or(mtime);
    Some(SessionMeta {
        path: path.to_string_lossy().into_owned(),
        file_name,
        session_id: Some(header_id),
        cwd: header_cwd,
        name,
        first_message: first_user,
        mtime_ms: mtime,
        created_ms,
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
/// 落点必须与 pi 自己的布局规则一致，否则**终端 pi 的会话选择器看不见这些会话**（G7）：
///
/// | 生效会话根 | pi 的落点 | 依据 |
/// |---|---|---|
/// | 默认（`<agent>/sessions`） | `<root>/--<cwd 编码>--/<ts>_<id>.jsonl` | `getDefaultSessionDirPath`（`session-manager.ts:592-593`） |
/// | 自定义（`sessionDir` / 环境变量） | `<root>/<ts>_<id>.jsonl`（**平铺**） | 自定义值被当叶子用（`SessionManager.create` `:1752-1756`），列举走 `listSessionsFromDir`（`:941-953`，只读该目录下的 `*.jsonl`，不下钻） |
///
/// 真机踩到过：本机 `settings.json` 的 `sessionDir` 指到 `…/tmp/session`，
/// Piggy 老代码仍往里建 `--Users-wxk--/` 子目录 → 那一层里的会话在终端 pi 里"不存在"。
pub fn precreate_session_file(cwd: &Path) -> Result<PathBuf, String> {
    precreate_session_file_with(pi_files::sessions_root_spec(), cwd)
}

/// 落点决策（纯函数，不碰文件系统）：默认布局按 cwd 编码建子目录，自定义布局平铺。
fn precreate_dir(spec: &(PathBuf, bool), cwd: &Path) -> PathBuf {
    let (root, flat) = spec;
    if *flat {
        return root.clone();
    }
    // pi getDefaultSessionDirPath：去掉一个前导 / 或 \，再把 / \ : 全替换为 -，两侧包 --
    let s = cwd.to_string_lossy();
    let stripped = s
        .strip_prefix('/')
        .or_else(|| s.strip_prefix('\\'))
        .unwrap_or(&s);
    let safe = stripped.replace(['/', '\\', ':'], "-");
    root.join(format!("--{safe}--"))
}

/// 同上，root + 布局由调用方注入（测试友好）。
pub fn precreate_session_file_in(root: &Path, cwd: &Path, flat: bool) -> Result<PathBuf, String> {
    precreate_session_file_with((root.to_path_buf(), flat), cwd)
}

/// 真正干活的那个：`(会话根, 是否自定义布局)` + cwd。
fn precreate_session_file_with(spec: (PathBuf, bool), cwd: &Path) -> Result<PathBuf, String> {
    let dir = precreate_dir(&spec, cwd);
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

/// days-from-civil（Hinnant 算法的逆运算），与上面的 `civil_from_days` 配成一对。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let mp = if m > 2 { m - 3 } else { m + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + d as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

/// 解析 pi 写的 ISO-8601 UTC 时间戳 → epoch ms。
///
/// 只接受 pi 实际产出的形状（`YYYY-MM-DDTHH:MM:SS[.mmm]Z`，秒的小数位可有可无）：
/// session 头部的 `timestamp` 与文件名里的时间戳都来自这里。
/// 解析不了就返回 `None`，由调用方兜底到下一级来源 —— **不要 panic**。
pub(crate) fn parse_iso8601_ms(s: &str) -> Option<u64> {
    let b = s.as_bytes();
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || (b[10] | 0x20) != b't' {
        return None;
    }
    let num = |from: usize, to: usize| -> Option<i64> {
        let part = s.get(from..to)?;
        if !part.bytes().all(|c| c.is_ascii_digit()) {
            return None;
        }
        part.parse::<i64>().ok()
    };
    let y = num(0, 4)?;
    let mo = num(5, 7)? as u32;
    let d = num(8, 10)? as u32;
    let h = num(11, 13)?;
    let mi = num(14, 16)?;
    let sec = num(17, 19)?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || sec > 60 {
        return None;
    }
    // 毫秒：'.' 后跟若干数字（pi 写 3 位，但别假设）
    let mut ms: i64 = 0;
    if b.get(19) == Some(&b'.') {
        let frac = &s[20..];
        let digits: String = frac.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() {
            let mut padded = digits.clone();
            padded.truncate(3);
            while padded.len() < 3 {
                padded.push('0');
            }
            ms = padded.parse().ok()?;
        }
    }
    let days = days_from_civil(y, mo, d);
    let total = days * 86_400 + h * 3_600 + mi * 60 + sec;
    u64::try_from(total * 1000 + ms).ok()
}

/// 从 pi 的会话文件名里取创建时间：`2026-09-23T06-00-07-100Z_<uuid>.jsonl`。
/// 把时间部分的 `-` 还原成 `:` / `.` 后复用 `parse_iso8601_ms`，避免写第二套解析。
fn filename_timestamp_ms(file_name: &str) -> Option<u64> {
    let head = file_name.get(0..24)?;
    let bytes = head.as_bytes();
    // 必须是 2026-09-23T06-00-07-100Z 这个形状
    if bytes[10] != b'T' || bytes[13] != b'-' || bytes[16] != b'-' || bytes[19] != b'-' || bytes[23] != b'Z' {
        return None;
    }
    let mut iso = String::with_capacity(24);
    for (i, c) in head.chars().enumerate() {
        iso.push(match i {
            13 | 16 => ':',
            19 => '.',
            _ => c,
        });
    }
    parse_iso8601_ms(&iso)
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
        let p = precreate_session_file_in(&root, cwd, false).expect("precreate");
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
        let p2 = precreate_session_file_in(&root, cwd, false).expect("precreate 2");
        assert_ne!(p, p2);
        std::fs::remove_dir_all(&root).ok();
    }

    /// **自定义** `sessionDir` 是叶子目录：pi 自己的列举（`listSessionsFromDir`）只读该目录下的
    /// `*.jsonl`，不下钻。所以预创建必须**平铺**，否则终端 pi 看不见这些会话（G7 双向兼容）。
    /// 真机背景：本机 `settings.json` 的 `sessionDir` 指到 `…/tmp/session`，
    /// 那一层同时有 pi 写的平铺文件与老代码建的 `--Users-wxk--/` 子目录。
    #[test]
    fn precreate_is_flat_for_custom_session_dir() {
        let root = std::env::temp_dir().join(format!("piggy-precreate-flat-{}", std::process::id()));
        let cwd = Path::new("/Users/wxk/proj");
        let p = precreate_session_file_in(&root, cwd, true).expect("precreate");
        assert_eq!(p.parent().unwrap(), root, "自定义会话根下必须平铺，不能再套 --cwd-- 子目录");
        assert!(p.is_file());
        // 平铺文件必须能被扫描器认出来（读写两条路对同一布局）。
        // 注意：刚预创建的是**空文件**，pi 还没写 header（懒落盘），所以此刻扫不到——
        // 这里补一行 header 模拟 pi 落盘后的样子，再扫。
        assert!(scan_dir(&root).is_empty(), "空文件不该被当成会话列出");
        std::fs::write(&p, "{\"type\":\"session\",\"version\":3,\"id\":\"flat\",\"cwd\":\"/Users/wxk/proj\"}\n")
            .unwrap();
        let list = scan_dir(&root);
        assert_eq!(list.len(), 1, "平铺布局的会话没被扫到");
        assert_eq!(list[0].session_id.as_deref(), Some("flat"));
        std::fs::remove_dir_all(&root).ok();
    }

    /// 生产入口必须用**生效会话根 + 它的布局规则**（两边漂移 = 又写回子目录）。
    ///
    /// 这里只算路径、不落盘：真机上 `sessions_root_spec()` 指向用户真实的会话目录，
    /// 单测往里写文件就是污染（一开始那版就是，红检失败后还留下了探针目录）。
    #[test]
    fn precreate_wiring_uses_the_effective_root_and_its_layout() {
        let spec = pi_files::sessions_root_spec();
        let cwd = Path::new("/tmp/piggy-wiring-probe");
        let dir = precreate_dir(&spec, cwd);
        if spec.1 {
            assert_eq!(dir, spec.0, "自定义根下写成了子目录");
            assert!(!dir.ends_with("--tmp-piggy-wiring-probe--"));
        } else {
            assert_eq!(dir, spec.0.join("--tmp-piggy-wiring-probe--"), "默认根下应按 cwd 编码建子目录");
        }
    }
}

#[cfg(test)]
mod created_time_tests {
    use super::*;

    /// 与 `iso_timestamp_filename` 互为逆运算 —— 编解码必须对齐。
    /// 注意走的是 `filename_timestamp_ms`：文件名用的是 `-` 分隔，
    /// `parse_iso8601_ms` 只吃标准 ISO（两种形状都由 pi 产出，别混用）。
    #[test]
    fn filename_timestamp_round_trips() {
        for ms in [0u64, 1, 999, 1_790_052_800_088, 951_912_000_500, 1_800_000_000_000] {
            let name = format!("{}_{}.jsonl", iso_timestamp_filename(ms), "uuid");
            let back = filename_timestamp_ms(&name).unwrap_or_else(|| panic!("解析失败: {name}"));
            assert_eq!(back, ms, "往返不一致: {name}");
        }
    }

    #[test]
    fn parses_the_shapes_pi_actually_writes() {
        // session 头部：带毫秒
        assert_eq!(parse_iso8601_ms("2026-09-22T01:00:00.000Z"), Some(1_790_038_800_000));
        // 不带毫秒
        assert_eq!(parse_iso8601_ms("2026-09-22T01:00:00Z"), Some(1_790_038_800_000));
        // 多于 3 位小数：截断而不是报错
        assert_eq!(parse_iso8601_ms("2026-09-22T01:00:00.123456Z"), Some(1_790_038_800_123));
        // 少于 3 位：右侧补零
        assert_eq!(parse_iso8601_ms("2026-09-22T01:00:00.5Z"), Some(1_790_038_800_500));
    }

    #[test]
    fn rejects_garbage_without_panicking() {
        for bad in [
            "", "not-a-date", "2026-09-22", "2026-13-01T00:00:00Z", "2026-09-32T00:00:00Z",
            "2026-09-22T25:00:00Z", "2026-09-22T00:61:00Z", "2026-09-22X01:00:00Z",
            "20x6-09-22T01:00:00Z",
        ] {
            assert!(parse_iso8601_ms(bad).is_none(), "不该解析成功: {bad:?}");
        }
    }

    /// 文件名兜底：pi 的 `-` 分隔形式要能还原
    #[test]
    fn filename_timestamp_is_parsed() {
        let got = filename_timestamp_ms("2026-09-22T04-53-20-088Z_abc123.jsonl");
        assert_eq!(got, Some(1_790_052_800_088));
        // 形状不对 → None（由调用方兜底到 mtime）
        assert_eq!(filename_timestamp_ms("random-name.jsonl"), None);
        assert_eq!(filename_timestamp_ms("2026-09-22_04-53-20.jsonl"), None);
    }

    /// 端到端：解析一个真实形状的会话文件，创建时间要来自**头部**而不是文件 mtime。
    #[test]
    fn header_timestamp_wins_over_mtime() {
        let dir = std::env::temp_dir().join("piggy-created-ms-test");
        let proj = dir.join("--proj--");
        std::fs::create_dir_all(&proj).unwrap();
        let path = proj.join("2020-01-01T00-00-00-000Z_hdr.jsonl");
        std::fs::write(
            &path,
            "{\"type\":\"session\",\"version\":3,\"id\":\"s1\",\"timestamp\":\"2021-06-01T12:00:00.000Z\",\"cwd\":\"/tmp\"}\n",
        )
        .unwrap();
        let m = parse_session_file(&path).expect("应能解析");
        // 头部时间：2021-06-01T12:00:00Z
        assert_eq!(m.created_ms, 1_622_548_800_000, "应取头部 timestamp");
        // 文件名时间是 2020，mtime 是"现在" —— 都不能覆盖头部
        assert_ne!(m.created_ms, m.mtime_ms);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 头部没有 timestamp 时退到文件名里的时间。
    #[test]
    fn falls_back_to_filename_timestamp() {
        let dir = std::env::temp_dir().join("piggy-created-ms-fallback");
        let proj = dir.join("--proj--");
        std::fs::create_dir_all(&proj).unwrap();
        let path = proj.join("2019-03-04T05-06-07-008Z_nohdr.jsonl");
        std::fs::write(&path, "{\"type\":\"session\",\"version\":3,\"id\":\"s2\",\"cwd\":\"/tmp\"}\n").unwrap();
        let m = parse_session_file(&path).expect("应能解析");
        assert_eq!(m.created_ms, filename_timestamp_ms("2019-03-04T05-06-07-008Z_nohdr.jsonl").unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 扫描顺序：按创建时间降序，**不受 mtime 影响**。
    #[test]
    fn scan_sorts_by_created_not_mtime() {        let dir = std::env::temp_dir().join("piggy-created-ms-sort");
        let proj = dir.join("--proj--");
        std::fs::create_dir_all(&proj).unwrap();
        // 先写"创建晚"的，再写"创建早"的 —— 这样创建早的那个 mtime 反而更新，
        // 正好复现用户看到的现象：老会话被写入一次就冒到列表顶部。
        let new = proj.join("2024-01-01T00-00-00-000Z_new.jsonl");
        let old = proj.join("2020-01-01T00-00-00-000Z_old.jsonl");
        std::fs::write(&new, "{\"type\":\"session\",\"version\":3,\"id\":\"new\",\"cwd\":\"/tmp\"}\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        std::fs::write(&old, "{\"type\":\"session\",\"version\":3,\"id\":\"old\",\"cwd\":\"/tmp\"}\n").unwrap();

        let list = scan_dir(&dir);
        assert_eq!(list.len(), 2, "应扫到 2 个会话");
        assert_eq!(list[0].session_id.as_deref(), Some("new"), "创建晚的排前面");
        assert_eq!(list[1].session_id.as_deref(), Some("old"));
        // 也就是说：mtime 更大的 old **没有**因为"刚被写过"而冒到顶部
        assert!(
            list[1].mtime_ms > list[0].mtime_ms,
            "本用例前提：创建早的 old 反而 mtime 更晚（否则测不出区别）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 自定义 sessionDir 的机器上，pi 把会话**平铺**在根目录下（不再有 `--cwd--` 子目录）。
    /// 老代码只扫子目录 → 这类机器侧栏一片空白（docs/03 §2.18）。
    #[test]
    fn scan_accepts_flat_custom_session_dir() {
        let dir = std::env::temp_dir().join("piggy-scan-flat-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("--proj--")).unwrap();
        // 默认布局：子目录里的会话
        std::fs::write(
            dir.join("--proj--").join("2023-01-01T00-00-00-000Z_nested.jsonl"),
            "{\"type\":\"session\",\"version\":3,\"id\":\"nested\",\"cwd\":\"/tmp/p\"}\n",
        )
        .unwrap();
        // 自定义布局：根目录下的扁平会话
        std::fs::write(
            dir.join("2024-01-01T00-00-00-000Z_flat.jsonl"),
            "{\"type\":\"session\",\"version\":3,\"id\":\"flat\",\"cwd\":\"/tmp/q\"}\n",
        )
        .unwrap();
        // 非 jsonl 的杂项文件不该被当成会话
        std::fs::write(dir.join("notes.md"), "x").unwrap();

        let list = scan_dir(&dir);
        let ids: Vec<_> = list.iter().filter_map(|m| m.session_id.clone()).collect();
        assert!(ids.contains(&"flat".to_string()), "扁平布局的会话漏了: {ids:?}");
        assert!(ids.contains(&"nested".to_string()), "子目录布局的会话漏了: {ids:?}");
        assert_eq!(ids.len(), 2, "只该扫到 2 个会话: {ids:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
