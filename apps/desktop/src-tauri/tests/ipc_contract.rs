//! IPC 返回值的 **JSON 形状**契约（docs/08 §5）。
//!
//! 存在的理由：前端在浏览器里跑的是 `mockBackend`，它的返回形状与 Rust 侧**各写各的**。
//! 一旦两边不一致，mock 会把真机上必崩的 bug 藏起来——2026-09-23 就发生过一次：
//! `fs_list_dir` 把 `entry.file_name()`（`OsString`）直接塞进 `serde_json::json!`，
//! serde 在 Unix 上把它序列化成 `{"Unix":[字节...]}` 这样的**对象**，
//! 前端把它当 React child 渲染即抛 "Objects are not valid as a React child" → **整窗黑屏**；
//! 而 mock 返回的是普通字符串，所有浏览器测试全绿。
//!
//! 因此这里对"跨 IPC 边界的字段"断言**基础类型**：字符串就得是字符串。

use std::fs;

/// 前端 `FilesView` 依赖：`{ entries: [{ name: string, isDir: boolean, size: number }] }`
#[tokio::test]
async fn fs_list_dir_returns_string_names() {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::write(dir.path().join("a.txt"), b"hello").unwrap();
    fs::create_dir(dir.path().join("sub")).unwrap();

    let root = dir.path().to_string_lossy().into_owned();
    let out = piggy_lib::commands::fs_list_dir(root.clone(), root)
        .await
        .expect("fs_list_dir ok");

    let entries = out["entries"].as_array().expect("entries 是数组");
    assert_eq!(entries.len(), 2, "应列出 2 个条目");

    for e in entries {
        let name = &e["name"];
        assert!(
            name.is_string(),
            "name 必须是字符串，实际是 {name}——OsString 未转 String 时会变成 {{\"Unix\": [...]}} 这样的对象",
        );
        assert!(e["isDir"].is_boolean(), "isDir 必须是布尔");
        assert!(e["size"].is_number(), "size 必须是数字");
    }

    // 排序：目录在前、再按名字（依赖 name 是字符串，否则 as_str() 恒为 None）
    assert_eq!(entries[0]["name"].as_str().unwrap(), "sub", "目录应排在最前");
    assert_eq!(entries[1]["name"].as_str().unwrap(), "a.txt");
}
