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

/* ------------- 「打开方式」文件级（DSH path-opener / file-applications） ------------- */

/// 桌面能力是一个**布尔**，且本机（macOS）必须为真。
#[test]
fn open_path_available_is_a_boolean() {
    let available = piggy_lib::open_in_app::open_path_available();
    if cfg!(target_os = "macos") {
        assert!(available, "macOS 恒有桌面打开器");
    }
}

/// 文件关联列表的**跨 IPC 形状**：`{id, name, default, icon}`，且默认项恰好一个。
/// 这条跑的是真机（`osascript` + AppKit），因此也顺带证明了那条 JXA 路线在打包环境里可用。
#[test]
fn open_path_applications_shape_on_this_machine() {
    let file = "/Users/wxk/Documents/Project/piggy/README.md";
    if !std::path::Path::new(file).exists() {
        return;
    }
    let apps = piggy_lib::open_in_app::open_path_applications(file.to_string())
        .expect("关联查询应当成功");
    assert!(!apps.is_empty(), "本机 README.md 应当有处理器");
    let value = serde_json::to_value(&apps).expect("可序列化");
    let array = value.as_array().expect("是数组");
    let mut defaults = 0;
    for entry in array {
        assert!(entry["id"].is_string(), "id 必须是字符串");
        assert!(entry["name"].is_string(), "name 必须是字符串");
        assert!(entry["default"].is_boolean(), "default 必须是布尔（前端按它选主按钮）");
        assert!(
            entry["icon"].is_null() || entry["icon"].is_string(),
            "icon 必须是字符串或 null"
        );
        if entry["default"].as_bool() == Some(true) {
            defaults += 1;
        }
    }
    assert_eq!(defaults, 1, "默认项必须恰好一个");
}

/// 目录**也能**查出关联（本机实测 `/tmp` → 终端.app）——
/// 所以"打开工作区"走的是固定白名单目录，不是这张关联列表。
#[test]
fn open_path_applications_accepts_a_directory_without_error() {
    let apps = piggy_lib::open_in_app::open_path_applications("/tmp".to_string())
        .expect("目录查询不该报错");
    for app in apps {
        assert!(std::path::Path::new(&app.id).is_dir(), "关联到的应用不存在: {}", app.id);
    }
}

/// 拒绝面：不存在的路径 / 相对路径 / 未知 action 一律 Err（**在启动之前**拦下）。
#[test]
fn open_path_open_rejects_bad_requests() {
    let missing =
        piggy_lib::open_in_app::open_path_open("/definitely/not/here.md".into(), "open".into(), None)
            .unwrap_err();
    assert!(missing.contains("不存在"), "{missing}");
    let relative =
        piggy_lib::open_in_app::open_path_open("rel/x.md".into(), "open".into(), None).unwrap_err();
    assert!(relative.contains("绝对路径"), "{relative}");
    let bad_action =
        piggy_lib::open_in_app::open_path_open("/tmp".into(), "delete".into(), None).unwrap_err();
    assert!(bad_action.contains("未知的打开方式"), "{bad_action}");
    // 未注册的应用：不许执行（前端传什么字符串都进不来）
    let unregistered = piggy_lib::open_in_app::open_path_open(
        "/tmp".into(),
        "open".into(),
        Some("/Applications/Definitely-Not-Registered.app".into()),
    )
    .unwrap_err();
    assert!(unregistered.contains("没有注册"), "{unregistered}");
}

/* ------------------- 提供商配置（docs/03 §2.12）------------------- */

/// 构造一个只含 provider 配置的临时 agent 目录（**不碰真实 `~/.pi/agent`**）。
fn agent_fixture(models: &str, auth: &str) -> tempfile::TempDir {
    let dir = tempfile::tempdir().expect("tempdir");
    fs::write(dir.path().join("models.json"), models).unwrap();
    fs::write(dir.path().join("auth.json"), auth).unwrap();
    dir
}

/// 前端 `ProviderRow` 依赖的键集合。改 Rust 侧的字段名而没同步改前端 =
/// 界面上一片空白，而浏览器测试用的 mock 是另写的一份，永远发现不了。
/// 所以这里把键集合**逐个锁死**（多一个键可以，少一个/改名不行）。
#[test]
fn provider_overview_row_shape() {
    let dir = agent_fixture(
        r#"{"providers":{"my-relay":{
            "name":"My Relay","baseUrl":"https://relay.example/v1","api":"openai-completions",
            "apiKey":"sk-relay-1234567890",
            "models":[{"id":"glm-4.6","name":"GLM 4.6","reasoning":true,"contextWindow":200000,"maxTokens":8192}]}}}"#,
        "{}",
    );
    let out = piggy_lib::provider::overview::overview_at(dir.path()).expect("overview ok");

    let rows = out["providers"].as_array().expect("providers 是数组");
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    for key in [
        "provider", "name", "declared", "baseUrl", "baseUrlSource", "api", "apiSource", "apis", "envVar",
        "keySource", "keyMasked", "keyKind", "hasInlineKey", "models", "cachedModels", "isDefault",
    ] {
        assert!(row.get(key).is_some(), "provider 行缺少字段 {key}：{row}");
    }
    assert!(row["provider"].is_string());
    assert!(row["name"].is_string());
    assert!(row["declared"].is_boolean());
    assert!(row["apis"].is_array());
    assert!(row["models"].is_array());
    assert!(row["cachedModels"].is_number());
    assert!(row["isDefault"].is_boolean());
    assert_eq!(row["keySource"], "models_json", "内联密钥的来源标错");
    assert!(
        row["keyMasked"].as_str().unwrap().starts_with("sk-rel"),
        "掩码应保留前缀：{}",
        row["keyMasked"]
    );

    // 目录 + 协议选项也要是前端能直接吃的形状
    let catalog = out["catalog"].as_array().expect("catalog 是数组");
    assert!(catalog.len() >= 40, "内置目录只有 {} 条", catalog.len());
    for c in catalog.iter().take(5) {
        for key in ["id", "name", "baseUrl", "api", "envVar", "apis"] {
            assert!(c.get(key).is_some(), "目录项缺少 {key}：{c}");
        }
    }
    let apis = out["apiOptions"].as_array().expect("apiOptions 是数组");
    assert!(apis.iter().all(|a| a.is_string()), "apiOptions 必须是字符串数组");
    assert!(out["paths"]["models"].is_string());
    assert!(out["defaults"]["provider"].is_string());
}

/// 保存一个提供商：返回值是**存进去的那份**，且落盘内容与之一致。
#[test]
fn provider_save_returns_the_saved_entry() {
    let dir = agent_fixture(r#"{"providers":{"keep":{"name":"Keep Me","custom":"untouched"}}}"#, "{}");
    let saved = piggy_lib::provider::edit::save_at(
        dir.path(),
        "new-one",
        &serde_json::json!({
            "name": "New One",
            "baseUrl": "https://new.example/v1",
            "api": "openai-completions",
            "models": [{ "id": "m1", "reasoning": true, "contextWindow": 128000 }]
        }),
    )
    .expect("save ok");
    assert_eq!(saved["name"], "New One");
    assert_eq!(saved["models"][0]["id"], "m1");

    let on_disk: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.path().join("models.json")).unwrap()).unwrap();
    assert_eq!(on_disk["providers"]["new-one"]["name"], "New One");
    assert_eq!(on_disk["providers"]["new-one"]["models"][0]["contextWindow"], 128000);
    assert_eq!(
        on_disk["providers"]["keep"]["custom"], "untouched",
        "保存一个提供商把别的提供商动了"
    );

    // 空串 = 删键（pi 的 schema 对 name/baseUrl/api 都有 minLength: 1）
    piggy_lib::provider::edit::save_at(
        dir.path(),
        "new-one",
        &serde_json::json!({"name": "", "baseUrl": "", "api": ""}),
    )
    .unwrap();
    let on_disk: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.path().join("models.json")).unwrap()).unwrap();
    let entry = on_disk["providers"]["new-one"].as_object().unwrap();
    assert!(
        !entry.contains_key("name") && !entry.contains_key("baseUrl") && !entry.contains_key("api"),
        "空串该删键，实际留下了：{entry:?}"
    );
}

/// 非法请求要有明确的拒绝面（不是静默写坏文件）。
#[test]
fn provider_writes_reject_unusable_input() {
    let dir = agent_fixture("{}", "{}");
    let err = piggy_lib::provider::edit::save_at(dir.path(), "a/b", &serde_json::json!({"name":"x"}))
        .expect_err("带斜杠的 id 应该被拒");
    assert!(err.contains('/'), "{err}");
    let err = piggy_lib::provider::edit::save_at(
        dir.path(),
        "ok",
        &serde_json::json!({"models":[{"id":"m"},{"id":"m"}]}),
    )
    .expect_err("重复模型 id 应该被拒");
    assert!(err.contains("重复"), "{err}");
    // 被拒之后文件里**一个提供商都没有**（不许写一半：先校验再落盘）
    let on_disk: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.path().join("models.json")).unwrap()).unwrap();
    let written = on_disk["providers"].as_object().map(|o| o.len()).unwrap_or(0);
    assert_eq!(written, 0, "被拒的请求还是写进去了：{on_disk}");
}

/* ============================ 插件（docs/03 §2.15） ============================ */

/// `plugin_overview` 的行形状。**这里手写的键名是独立的一份**，与
/// `src/lib/plugins.ts` 的 `PluginRow` 接口各锁一遍——两边同时改错才可能漏。
///
/// 为什么值得单锁：插件页行里的 `key` 是启停/删除的回传标识，
/// 形状变了而前端没跟着改，表现是"点了开关什么都没发生"（前端拿到 undefined 的 key），
/// 而不是报错。
#[test]
fn plugin_overview_row_shape() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = tmp.path().join("agent");
    let proj = tmp.path().join("proj");
    std::fs::create_dir_all(agent.join("npm/node_modules/@a/b")).unwrap();
    std::fs::create_dir_all(agent.join("extensions")).unwrap();
    std::fs::create_dir_all(proj.join(".pi/extensions")).unwrap();
    std::fs::write(agent.join("extensions/g.ts"), "export default 1").unwrap();
    std::fs::write(proj.join(".pi/extensions/p.ts"), "export default 1").unwrap();
    std::fs::write(agent.join("npm/node_modules/@a/b/index.ts"), "export default 1").unwrap();
    std::fs::write(
        agent.join("npm/node_modules/@a/b/package.json"),
        r#"{"name":"@a/b","version":"1.2.3","description":"d","pi":{"extensions":["./index.ts"]}}"#,
    )
    .unwrap();
    std::fs::write(agent.join("settings.json"), r#"{"packages":["npm:@a/b"]}"#).unwrap();

    let out = piggy_lib::plugin::inventory::overview(&agent, Some(&proj)).expect("overview ok");

    for key in ["agentDir", "agentDirFromEnv", "projectDir", "groups", "warnings", "counts"] {
        assert!(out.get(key).is_some(), "plugin_overview 缺少字段 {key}：{out}");
    }
    let c = &out["counts"];
    for key in ["total", "enabled", "disabled", "missing", "updatable"] {
        assert!(c[key].is_number(), "counts 缺少数字字段 {key}：{c}");
    }
    let groups = out["groups"].as_array().expect("groups 是数组");
    assert_eq!(
        groups.iter().map(|g| g["id"].as_str().unwrap()).collect::<Vec<_>>(),
        vec!["project", "global", "builtin"],
        "分组顺序必须与 pi 的加载优先级一致"
    );
    for g in groups {
        for key in ["id", "label", "dir", "settingsPath", "count", "plugins"] {
            assert!(g.get(key).is_some(), "分组缺少字段 {key}：{g}");
        }
    }

    let rows: Vec<&serde_json::Value> = groups
        .iter()
        .flat_map(|g| g["plugins"].as_array().unwrap())
        .collect();
    // 1 个项目发现 + 1 个全局发现 + 1 个包 + N 个内置
    assert_eq!(rows.len(), 3 + rows.iter().filter(|r| r["kind"] == "builtin").count());
    for row in &rows {
        for key in [
            "key", "name", "kind", "kindLabel", "sourceKind", "sourceKindLabel", "scope", "scopeLabel",
            "source", "path", "exists", "enabled", "enabledBy", "version", "description", "entries",
            "removable", "updatable", "loadRank",
        ] {
            assert!(row.get(key).is_some(), "插件行缺少字段 {key}：{row}");
        }
        assert!(row["enabled"].is_boolean());
        assert!(row["exists"].is_boolean());
        assert!(row["removable"].is_boolean());
        assert!(row["updatable"].is_boolean());
        assert!(row["loadRank"].is_number());
        assert!(row["entries"].is_array());
        // key 是启停/删除的回传标识：必须是 "<scope>:<kind>:<source>" 且 scope 合法
        let key = row["key"].as_str().unwrap();
        let scope = key.split(':').next().unwrap();
        assert!(
            ["project", "global", "builtin"].contains(&scope),
            "key 的 scope 段不可识别：{key}"
        );
        assert_eq!(key.split(':').nth(1).unwrap(), row["kind"].as_str().unwrap());
    }
    // 内置那一条：名字必须来自 builtInExtensions，不能是从说明文字里取的文件名
    let builtin = rows.iter().find(|r| r["kind"] == "builtin").expect("应有内置");
    assert!(
        !builtin["name"].as_str().unwrap().ends_with(')'),
        "内置名字取错了（从说明性路径里取了文件名）：{}",
        builtin["name"]
    );
    assert_eq!(builtin["removable"], false);
    assert_eq!(builtin["updatable"], false);
}

/// 启停写下去的**正是 pi 认的**形状。
///
/// 这是全页最容易"看起来成功其实没用"的地方：pi 没有 enabled 字段，
/// 停用只有 `-`/`!` 通配符（松散扩展）与 `autoload:false`（包）两条路。
/// 写错形状 pi 不报错，只是**继续加载**。
#[test]
fn plugin_enable_writes_pis_own_shape() {
    let tmp = tempfile::tempdir().unwrap();
    let agent = tmp.path().join("agent");
    std::fs::create_dir_all(agent.join("extensions")).unwrap();
    std::fs::write(agent.join("extensions/foo.ts"), "export default 1").unwrap();
    std::fs::write(agent.join("settings.json"), "{}").unwrap();

    let key = format!("global:discovered:{}", agent.join("extensions/foo.ts").display());
    let out = piggy_lib::plugin::set_enabled_at(&agent, &key, false, None).expect("停用 ok");
    assert_eq!(
        out["settings"]["extensions"],
        serde_json::json!(["-extensions/foo.ts"]),
        "停用发现目录里的扩展要写精确排除规则（pi 的 config-selector 就是这么写的）"
    );
    // 读写闭环：写完之后盘点必须同意它被停用了
    let v = piggy_lib::plugin::inventory::overview(&agent, None).unwrap();
    let row = &v["groups"][0]["plugins"][0];
    assert_eq!(row["enabled"], false);
    assert!(row["enabledBy"].as_str().unwrap().contains("- 规则"));

    // 包：停用必须落成 autoload:false（字符串形式 = 全加载，塌回去就等于没停用）
    std::fs::write(agent.join("settings.json"), r#"{"packages":["npm:@a/b"]}"#).unwrap();
    let off = piggy_lib::plugin::set_enabled_at(&agent, "global:package:npm:@a/b", false, None).unwrap();
    assert_eq!(off["settings"]["packages"][0]["autoload"], false);
    let on = piggy_lib::plugin::set_enabled_at(&agent, "global:package:npm:@a/b", true, None).unwrap();
    assert_eq!(
        on["settings"]["packages"],
        serde_json::json!(["npm:@a/b"]),
        "启用要塌回字符串形式，与 pi install 写出来的一致"
    );
}

/// 裸包名必须在**动手之前**被拦下：pi 的 `isLocalPath` 只看前缀，
/// `@scope/pkg` 会被当本地路径，实测报 `Path does not exist: …/@scope/pkg`。
#[test]
fn plugin_check_source_catches_bare_package_names() {
    let rt = tokio::runtime::Runtime::new().unwrap();
    let bare = rt
        .block_on(piggy_lib::plugin::plugin_check_source("@scope/pkg".into()))
        .unwrap();
    assert_eq!(bare["ok"], false);
    assert!(bare["hint"].as_str().unwrap().contains("npm:@scope/pkg"));

    let ok = rt
        .block_on(piggy_lib::plugin::plugin_check_source("npm:@scope/pkg".into()))
        .unwrap();
    assert_eq!(ok["ok"], true);
    assert_eq!(ok["sourceKind"], "npm");
}

/// 插件命令行的参数形状（与 `pi install --help` 逐字对齐）。
#[test]
fn plugin_cli_plan_matches_pi_flags() {
    let g = piggy_lib::plugin::cli::plan("install", Some("npm:@a/b"), "global", None).unwrap();
    assert_eq!(g.args, vec!["install", "npm:@a/b"]);
    let p = piggy_lib::plugin::cli::plan("install", Some("npm:@a/b"), "project", Some("/p")).unwrap();
    assert_eq!(p.args, vec!["install", "npm:@a/b", "--local", "--approve"]);
    // 升级的默认目标**不能**是 pi 自己（pi 的默认是 self，会升级二进制）
    let u = piggy_lib::plugin::cli::plan("update", None, "global", None).unwrap();
    assert_eq!(u.args, vec!["update", "--extensions"]);
    // 项目作用域没有目录 → 报错，而不是悄悄写到全局
    assert!(piggy_lib::plugin::cli::plan("install", Some("npm:@a/b"), "project", None).is_err());
}

/// **跨 IPC 的键必须是 camelCase**（docs/15 规矩 37）。
///
/// 这一条是三次真实事故换来的，且三次的形状完全一样：Rust 的 struct 漏了
/// `#[serde(rename_all = "camelCase")]`，前端按 camelCase 读 —— **两边都不报错**：
///
/// | 结构 | Rust 发出去 | 前端读 | 表现 |
/// |---|---|---|---|
/// | `Generated` | `elapsed_ms` / `prompt_chars` | `elapsedMs` / `promptChars` | 提示里出现 `NaNs`、`素材 undefined 字` |
/// | `PiBinary` | `from_env` | `fromEnv` | 「被 PI_BIN 覆盖」那条警告**从未显示过** |
///
/// 反例（**不是** bug，别照着"修"）：`PathApplication` 的字段叫 `is_default`，
/// 线格式却是 `default` —— 因为它带了字段级的 `#[serde(rename = "default")]`。
/// 我第一版按字段名猜它坏了、还"顺手修了"，被这条测试当场拦下：
/// **判形状要看真正的序列化结果，不要看字段名。**
///
/// 为什么门禁全绿也抓不到：前端浏览器门禁跑的是 **mock**，mock 是按前端读法手写的，
/// 两边自洽；真机那一侧没有任何检查。所以形状必须在**这一层**逐个键锁死。
#[test]
fn plugin_and_title_payloads_are_camel_case() {
    use serde_json::json;

    // Generated（标题生成结果）
    let g = piggy_lib::sessions::title::Generated {
        title: "t".into(),
        raw: "r".into(),
        provider: None,
        model_id: Some("m".into()),
        elapsed_ms: 1,
        prompt_chars: 2,
        usable: true,
    };
    let v = serde_json::to_value(&g).unwrap();
    for k in ["modelId", "elapsedMs", "promptChars"] {
        assert!(v.get(k).is_some(), "Generated 缺 {k}：{v}");
    }
    for bad in ["model_id", "elapsed_ms", "prompt_chars"] {
        assert!(v.get(bad).is_none(), "Generated 漏出 snake_case {bad}：{v}");
    }
    assert!(v["elapsedMs"].is_number() && v["promptChars"].is_number());

    // PiBinary（pi 二进制解析结果）——这条事故的表现是"警告从不出现"
    let bin = piggy_lib::pi::discovery::PiBinary {
        path: std::path::PathBuf::from("/usr/local/bin/pi"),
        version: "0.87.1".into(),
        source: piggy_lib::pi::discovery::PiSource::System,
        via: "PATH".into(),
        from_env: true,
    };
    let b = serde_json::to_value(&bin).unwrap();
    assert!(b.get("fromEnv").is_some(), "PiBinary 缺 fromEnv：{b}");
    assert!(b.get("from_env").is_none(), "PiBinary 漏出 from_env：{b}");
    assert_eq!(b["fromEnv"], json!(true), "覆盖标志必须是布尔");

    // PathApplication（文件关联）：**这里刻意锁的是 `default`**。
    // 字段名是 `is_default`，但字段级 `#[serde(rename = "default")]` 让它线格式是 `default`
    // ——按名字猜会得到相反的结论（我第一次就猜错了）。
    let app = piggy_lib::open_in_app::paths::PathApplication {
        id: "/Applications/Typora.app".into(),
        name: "Typora.app".into(),
        is_default: true,
        icon: None,
    };
    let a = serde_json::to_value(&app).unwrap();
    assert_eq!(
        a["default"],
        json!(true),
        "PathApplication 的默认项线格式变了（前端读 a.default）：{a}"
    );
    assert!(a.get("isDefault").is_none(), "PathApplication 不该发 isDefault：{a}");
}

/// 「标题模型」下拉的数据源：`title_model_options` 的返回形状（docs/03 §2.16）。
///
/// 这条是**跨 IPC 契约**，与 `sessions/title.rs::model_options_keys_are_camel_case`
/// 是同一件事的两道锁（那边锁 Rust 自己的序列化，这边锁"发出去的那份值"）。
/// 前端 `sessionTitle.ts::normalizeModelOptions` 读的是 `models / note / piBin / elapsedMs`，
/// 少一个键的表现是**界面少一句话**而不是报错——所以键名要在这里写死。
#[test]
fn title_model_options_payload_is_camel_case() {
    use piggy_lib::sessions::title::{ModelOption, ModelOptions};

    let opts = ModelOptions {
        models: vec![
            ModelOption { provider: "cc-switch-zhipu-glm".into(), id: "glm-5.3-flash".into(), reasoning: true },
            ModelOption { provider: "local".into(), id: "no-think".into(), reasoning: false },
        ],
        note: None,
        pi_bin: "/usr/local/bin/pi".into(),
        elapsed_ms: 612,
    };
    let v = serde_json::to_value(&opts).unwrap();
    for k in ["models", "note", "piBin", "elapsedMs"] {
        assert!(v.get(k).is_some(), "ModelOptions 缺 {k}：{v}");
    }
    for bad in ["pi_bin", "elapsed_ms"] {
        assert!(v.get(bad).is_none(), "ModelOptions 漏出 snake_case {bad}：{v}");
    }
    // 前端拿 `elapsedMs` 做算术（undefined 会变成 NaN 显示给用户——本项目真发生过）
    assert!(v["elapsedMs"].is_number(), "{}", v["elapsedMs"]);
    // reasoning 必须是**布尔**：前端用它决定"思考强度"能不能选。
    // 字符串 "yes" 在 JS 里也是真值 → 不支持推理的模型会被显示成支持。
    for m in v["models"].as_array().unwrap() {
        assert!(m["reasoning"].is_boolean(), "reasoning 必须是布尔：{m}");
        assert!(m["provider"].is_string() && m["id"].is_string(), "{m}");
    }
    assert_eq!(v["models"][1]["reasoning"], serde_json::json!(false));
}

/// 思考强度：合法值只有 pi 认的那 7 个，且**只有**它们能被写进 config
/// （写错了 pi 只打一行 stderr 警告然后静默用默认档，界面上看不出任何区别）。
#[tokio::test]
async fn thinking_levels_are_the_pi_ones_and_invalid_ones_are_rejected() {
    use piggy_lib::sessions::title::{is_valid_thinking, THINKING_LEVELS};

    for lv in THINKING_LEVELS {
        assert!(is_valid_thinking(lv), "{lv} 应当是合法档位");
    }
    for bad in ["", "  ", "none", "HIGH", "extreme", "off,high"] {
        assert!(!is_valid_thinking(bad), "{bad:?} 不该被当成合法档位");
    }
}


/// 「关于与许可」的载荷形状（docs/03 §2.17）。
///
/// 前端 `normalizeNotices` 读的是 `licenseName / licenseUrl / gplText / thirdParty` 这些
/// camelCase 键；少一个的表现是**界面少一块**（比如没有全文、或第三方表空着），
/// 而不是抛错——所以键名要在这里写死。
#[test]
fn legal_notices_payload_is_camel_case_and_complete() {
    let v = piggy_lib::legal::notices("9.9.9");
    for k in [
        "name",
        "version",
        "copyright",
        "spdx",
        "licenseName",
        "warranty",
        "licenseUrl",
        "gplText",
        "thirdParty",
    ] {
        assert!(v.get(k).is_some(), "legal_notices 缺 {k}：{v}");
    }
    for bad in ["license_name", "license_url", "gpl_text", "third_party"] {
        assert!(v.get(bad).is_none(), "legal_notices 漏出 snake_case {bad}");
    }
    // 版本号来自 package_info（调用方传进来），必须是字符串
    assert_eq!(v["version"], "9.9.9");
    // GPL 全文是真的全文（不是"详见 LICENSE"那句话）
    let text = v["gplText"].as_str().unwrap();
    assert!(text.len() > 30_000, "全文只有 {} 字节，像是被截断了", text.len());
    assert!(text.contains("END OF TERMS AND CONDITIONS"));
    // 第三方表：每一项四个键都得在（少 holder = 署名缺主体）
    let rows = v["thirdParty"].as_array().unwrap();
    assert!(rows.len() >= 5, "第三方表只剩 {} 条", rows.len());
    for r in rows {
        for k in ["name", "license", "holder", "usage"] {
            assert!(r[k].is_string() && !r[k].as_str().unwrap().is_empty(), "{r} 的 {k} 缺失");
        }
    }
}
