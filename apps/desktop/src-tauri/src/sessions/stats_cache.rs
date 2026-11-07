//! 会话统计的**按文件大小失效**缓存（docs/05 §6.4）。
//!
//! pi 的 `get_session_stats` 是每次全量重扫会话文件（`agent-session.ts` 的
//! `getSessionStats()`），而前端在每次提交后都会刷新一次。长会话（几万条）上
//! 这就是"每条消息扫一遍全文件"。
//!
//! 这里做一件很小的事：按**会话文件大小**缓存结果。会话文件是追加式
//! （`docs/02` §6.1），有变化必然变大，所以"大小没变 → 统计没变"成立；
//! 大小变了就重算。不做 TTL：pi 写盘是同步追加，大小是比时间更准的信号。
//!
//! 边界：
//! - 只缓存**成功**结果；错误不缓存（下次重试）。
//! - 上限 32 份，超了整表清空（会话切换频繁时也不会无限涨）。
//! - 进程级缓存：换 worker/重启应用都不影响正确性（键含文件路径 + 大小）。

use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

const MAX_ENTRIES: usize = 32;

#[derive(Clone)]
struct Entry {
    size: u64,
    value: Value,
}

fn table() -> &'static Mutex<HashMap<PathBuf, Entry>> {
    static TABLE: OnceLock<Mutex<HashMap<PathBuf, Entry>>> = OnceLock::new();
    TABLE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 文件大小（不存在/读不到 → `None`，调用方退化为"每次都问 pi"）。
pub fn stamp(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|m| m.len())
}

/// 命中缓存：文件大小一致才返回。
pub fn get(path: &Path, size: u64) -> Option<Value> {
    let table = table().lock().ok()?;
    let entry = table.get(path)?;
    (entry.size == size).then(|| entry.value.clone())
}

/// 写入缓存（超上限整表清空，语义是"缓存"，不是"账本"）。
pub fn put(path: &Path, size: u64, value: Value) {
    let Ok(mut table) = table().lock() else { return };
    if table.len() >= MAX_ENTRIES && !table.contains_key(path) {
        table.clear();
    }
    table.insert(path.to_path_buf(), Entry { size, value });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("piggy-stats-cache-{}-{name}", std::process::id()))
    }

    #[test]
    fn hits_only_while_the_file_size_is_unchanged() {
        let p = unique("a.jsonl");
        assert!(get(&p, 10).is_none(), "没写过就不该命中");
        put(&p, 10, serde_json::json!({"tokens": {"output": 1}}));
        assert_eq!(get(&p, 10).unwrap()["tokens"]["output"], 1);
        // 文件长大了（追加了一条）→ 必须重算
        assert!(get(&p, 11).is_none());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn keys_are_per_file() {
        let a = unique("a2.jsonl");
        let b = unique("b2.jsonl");
        put(&a, 1, serde_json::json!({"who": "a"}));
        put(&b, 1, serde_json::json!({"who": "b"}));
        assert_eq!(get(&a, 1).unwrap()["who"], "a");
        assert_eq!(get(&b, 1).unwrap()["who"], "b");
    }

    #[test]
    fn stamp_reflects_file_growth() {
        let p = unique("grow.jsonl");
        std::fs::write(&p, "a").unwrap();
        let s1 = stamp(&p).unwrap();
        std::fs::write(&p, "a\nb\n").unwrap();
        let s2 = stamp(&p).unwrap();
        assert!(s2 > s1);
        assert!(stamp(&p.with_extension("missing")).is_none());
        let _ = std::fs::remove_file(&p);
    }

    #[test]
    fn table_is_bounded() {
        // 直接灌满，确认不会无限增长（超过上限时整表清空）
        for i in 0..(MAX_ENTRIES + 1) {
            put(&unique(&format!("bound-{i}.jsonl")), 1, serde_json::json!(i));
        }
        let len = table().lock().unwrap().len();
        assert!(len <= MAX_ENTRIES, "缓存没有上限：{len}");
    }
}
