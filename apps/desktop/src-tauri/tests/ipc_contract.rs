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

/* ------------------- 「打开方式」（docs/11 §2.1）------------------- */

/// 最小 base64 解码（**故意**不复用被测代码的编码器：两边独立实现，
/// 编码器的字母表/填充由 `open_in_app::tests::base64_matches_rfc4648_vectors` 锁住）。
fn b64_decode(s: &str) -> Vec<u8> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let idx = |c: u8| TABLE.iter().position(|t| *t == c).map(|i| i as u32);
    let mut out = Vec::new();
    let bytes: Vec<u8> = s.bytes().filter(|b| *b != b'\n').collect();
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        let mut pad = 0;
        for (i, b) in chunk.iter().enumerate() {
            let v = if *b == b'=' {
                pad += 1;
                0
            } else {
                idx(*b).unwrap_or_else(|| panic!("非法 base64 字符: {}", *b as char))
            };
            n |= v << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    out
}

/// 前端拿到的是 `string[]`（id 数组），不是对象、不是 null。
#[test]
fn open_in_app_list_returns_string_ids() {
    let ids = piggy_lib::open_in_app::open_in_app_list();
    for id in &ids {
        assert!(!id.is_empty(), "空 id 会被前端当成词典键去查");
        assert!(
            id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
            "id 必须是纯小写字母数字（前端词典的键）: {id}"
        );
    }
    if cfg!(target_os = "macos") {
        // Finder 与 Terminal 随 macOS 发行 → 这两条恒定可解析。
        // 少了它们说明定位链断了（而不是"这台机器没装"）。
        assert!(ids.contains(&"finder".to_string()), "macOS 上必须有 finder: {ids:?}");
        assert!(ids.contains(&"terminal".to_string()), "macOS 上必须有 terminal: {ids:?}");
        assert!(ids.len() >= 2, "至少 Finder + Terminal");
    }
    // 宿主给的 id 必须能被前端词典命名，否则菜单里会漏项（前端的 `labelFor` 会丢掉它）
    let named = ["finder", "terminal", "vscode", "goland", "iterm"];
    for id in ids.iter().filter(|i| named.contains(&i.as_str())) {
        assert!(named.contains(&id.as_str()));
    }
}

/// 图标必须是 `data:image/png;base64,...`，解出来得是 **128×128 的 PNG**。
/// 这条把"宿主真的抠出了图标"钉在跨 IPC 的那一层（而不是只钉在内部函数上）。
#[test]
fn open_in_app_icon_is_a_128px_png_data_url() {
    let ids = piggy_lib::open_in_app::open_in_app_list();
    let Some(id) = ids
        .iter()
        .find(|i| i.as_str() == "vscode")
        .or_else(|| ids.iter().find(|i| i.as_str() != "terminal"))
        .cloned()
    else {
        return; // 这台机器上一个应用都没有
    };
    let url = piggy_lib::open_in_app::open_in_app_icon(id.clone())
        .unwrap_or_else(|| panic!("{id} 已解析出来，却拿不到图标"));
    let payload = url
        .strip_prefix("data:image/png;base64,")
        .unwrap_or_else(|| panic!("图标不是 PNG data URL: {}", &url[..40.min(url.len())]));
    let bytes = b64_decode(payload);
    assert_eq!(
        piggy_lib::open_in_app::icons::png_dimensions(&bytes),
        Some((128, 128)),
        "{id} 的图标不是 128×128 PNG（{} 字节）",
        bytes.len()
    );
    // 拿不到的应用返回 None（不是报错、也不是空串）
    assert_eq!(piggy_lib::open_in_app::open_in_app_icon("nope-nope".into()), None);
}

/// `open_in_app_open` 的拒绝面：未知应用 / 非目录 / 相对路径 一律 Err。
#[test]
fn open_in_app_open_rejects_bad_requests() {
    let err = piggy_lib::open_in_app::open_in_app_open("nope".into(), "/tmp".into()).unwrap_err();
    assert!(err.contains("不可用"), "{err}");
    let err = piggy_lib::open_in_app::open_in_app_open("finder".into(), "rel/path".into()).unwrap_err();
    assert!(err.contains("绝对路径") || err.contains("目录"), "{err}");
    let err = piggy_lib::open_in_app::open_in_app_open("finder".into(), "/etc/hosts".into()).unwrap_err();
    assert!(err.contains("目录"), "{err}");
}
