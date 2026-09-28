//! 能力探测（docs/03 §2.20）：Piggy 的 todo 界面由**插件**提供时，怎么知道该不该开。
//!
//! ## 为什么需要这一层
//!
//! todo 功能不是 Piggy 实现的 —— 它由 pi 扩展（本机是 `pi-todo`）提供工具与清单数据。
//! Piggy 的立场是：**探测到能力且插件已启用 → 自动支持；没探测到 → 一点都不显示**。
//! 所以需要一个"这台机器上，谁提供了 todo 能力，而且是启用状态吗"的判定。
//!
//! ## 两级证据（谁能说清楚就听谁的）
//!
//! | 级别 | 依据 | 适用 |
//! |---|---|---|
//! | 1. 声明 | 插件 `package.json` 的 `pi.piggy.capabilities[]` | 有清单的正规装法（npm 包 / 本地包 / 发现目录里的目录） |
//! | 2. 内容探测 | 扩展入口文件里出现能力标记串（todo 是 `todo_write`） | 兜底：`~/.pi/agent/extensions/` 里直接放一个 `index.ts`，没有 package.json |
//!
//! 声明优先的理由不是"更准"，而是**更快也更稳**：不读代码就不会被注释、字符串、
//! 压缩产物里的偶然命中骗到。内容探测是必要的兜底 —— 上面那种"裸文件"装法在真机上
//! 很常见（pi-guardrails 就是这么装的）。
//!
//! ## 只看已启用的插件 —— 但停用的也要报
//!
//! 启用规则（`!` / `+` / `-` 通配符）由 [`super::inventory`] 负责，这里不重复实现 ——
//! 两份判定必然分叉。停用的命中项照样返回（`disabled` 字段），因为界面上
//! "装了但没启用"和"根本没装"要给用户不同的提示（前者只要去插件页点一下启用）。
//!
//! ## 探测成本与边界
//!
//! 每个候选入口最多读 [`MAX_PROBE_BYTES`]；超限只读前一段并把 `truncated` 标出来
//! （**不静默**：截断意味着"没命中"这件事不一定是真的）。读不到的文件进 `problems`。

use std::fs;
use std::path::Path;
use std::path::PathBuf;

use serde_json::{json, Value};

use super::inventory;

/// 单个入口文件最多读多少字节做内容探测。512 KiB 足够覆盖任何手写扩展，
/// 又能挡住"误把打包产物当入口"的情况。
pub const MAX_PROBE_BYTES: u64 = 512 * 1024;

/// 能力的定义：id、给人看的名字、内容探测用的标记串。
#[derive(Debug, Clone, Copy)]
pub struct Capability {
    /// 稳定 id（前后端与配置里都用它）
    pub id: &'static str,
    /// 中文名（界面提示用）
    pub label: &'static str,
    /// 内容探测的标记串：入口文件里出现任意一个即认为提供该能力
    pub markers: &'static [&'static str],
}

/// 已知能力表。加新能力只改这里（外加前端一处映射）。
pub const CAPABILITIES: &[Capability] = &[Capability {
    id: "todo",
    label: "任务清单",
    // `todo_write` 是模型面向的工具名：插件无论怎么写，注册它时一定会出现这个字符串
    // （pi-todo 的 index.ts 里有；DSH 迁移过来的实现也一样）
    markers: &["todo_write"],
}];

/// 按 id 取能力定义。
pub fn spec(id: &str) -> Option<Capability> {
    CAPABILITIES.iter().copied().find(|c| c.id == id)
}

/// 一个入口文件的探测结果。
struct Probe {
    hit: bool,
    /// 只读了前一段（文件超过上限）——"没命中"因此不是定论
    truncated: bool,
    error: Option<String>,
}

/// 读一个入口文件，找标记串。
fn probe_file(path: &Path, markers: &[&str]) -> Probe {
    let mut out = Probe {
        hit: false,
        truncated: false,
        error: None,
    };
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => {
            out.error = Some(format!("{e}"));
            return out;
        }
    };
    if meta.is_dir() {
        out.error = Some("是目录，不是扩展入口文件".to_string());
        return out;
    }
    let bytes = if meta.len() > MAX_PROBE_BYTES {
        out.truncated = true;
        match fs::File::open(path).and_then(|mut f| {
            use std::io::Read;
            let mut buf = vec![0u8; MAX_PROBE_BYTES as usize];
            let n = f.read(&mut buf)?;
            buf.truncate(n);
            Ok(buf)
        }) {
            Ok(b) => b,
            Err(e) => {
                out.error = Some(format!("{e}"));
                return out;
            }
        }
    } else {
        match fs::read(path) {
            Ok(b) => b,
            Err(e) => {
                out.error = Some(format!("{e}"));
                return out;
            }
        }
    };
    // 入口是源码（可能含中文注释）：按 UTF-8 无损转换，坏字节直接跳过而不是整段丢弃
    let text = String::from_utf8_lossy(&bytes);
    out.hit = markers.iter().any(|m| text.contains(m));
    out
}

/// 目录入口的候选文件：pi 的加载约定就是 `index.{ts,js,mjs,cjs}`
/// （`core/extensions/loader.ts:702-744`："subdirectory with index.ts/index.js"）。
///
/// 为什么需要：真机上确实有包这么声明入口 —— `pi-web-access` 的
/// `pi.extensions` 就是 `["./dist"]`（一个目录）。把目录当"探测失败"报出来是噪音，
/// 假装它没有能力又会漏掉真正提供方。所以按 pi 的同一套约定往里找一层。
fn dir_candidates(dir: &Path) -> Vec<PathBuf> {
    ["index.ts", "index.js", "index.mjs", "index.cjs"]
        .iter()
        .map(|name| dir.join(name))
        .filter(|p| p.is_file())
        .collect()
}

/// 探测一个"入口"（文件或目录），返回 `(是否命中, 明细, 问题)`。
///
/// 与 [`probe_file`] 的分工：这里负责**入口形状**（文件 / 目录 / 不存在），
/// 目录按 pi 的约定下探一层；读失败才算问题，目录里没有候选文件只是"探不到"。
fn probe_entry(path: &Path, markers: &[&str]) -> (bool, Vec<Value>, Vec<String>) {
    let mut detail: Vec<Value> = Vec::new();
    let mut problems: Vec<String> = Vec::new();
    if path.is_dir() {
        let candidates = dir_candidates(path);
        if candidates.is_empty() {
            detail.push(json!({
                "entry": path.to_string_lossy(),
                "hit": false,
                "skipped": "目录里没有 index.{ts,js,mjs,cjs}（pi 的目录入口约定）",
            }));
            return (false, detail, problems);
        }
        for candidate in candidates {
            let probe = probe_file(&candidate, markers);
            if let Some(err) = &probe.error {
                problems.push(format!("{} 探测失败：{err}", candidate.display()));
            }
            if probe.truncated {
                problems.push(format!(
                    "{} 超过 {} KiB，只探测了前一段 —— 未命中不代表没有",
                    candidate.display(),
                    MAX_PROBE_BYTES / 1024
                ));
            }
            detail.push(json!({
                "entry": candidate.to_string_lossy(),
                "hit": probe.hit,
                "truncated": probe.truncated,
                "error": probe.error,
            }));
            if probe.hit {
                return (true, detail, problems);
            }
        }
        return (false, detail, problems);
    }
    let probe = probe_file(path, markers);
    if let Some(err) = &probe.error {
        problems.push(format!("{} 探测失败：{err}", path.display()));
    }
    if probe.truncated {
        problems.push(format!(
            "{} 超过 {} KiB，只探测了前一段 —— 未命中不代表没有",
            path.display(),
            MAX_PROBE_BYTES / 1024
        ));
    }
    detail.push(json!({
        "entry": path.to_string_lossy(),
        "hit": probe.hit,
        "truncated": probe.truncated,
        "error": probe.error,
    }));
    (probe.hit, detail, problems)
}

/// 读插件目录里 `package.json` 声明的能力（`pi.piggy.capabilities`）。
///
/// 形状不认识就当没声明（返回空 + 一条问题）：宁可不认，也不要猜错。
fn declared_capabilities(dir: &Path, problems: &mut Vec<String>) -> Vec<String> {
    let manifest = dir.join("package.json");
    if !manifest.is_file() {
        return Vec::new();
    }
    let value = match crate::config::pi_files::read_json(&manifest) {
        Ok(v) => v,
        Err(e) => {
            problems.push(format!("{} 读取失败：{e}", manifest.display()));
            return Vec::new();
        }
    };
    let caps = value
        .get("pi")
        .and_then(|pi| pi.get("piggy"))
        .and_then(|piggy| piggy.get("capabilities"));
    match caps {
        None => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|v| v.as_str())
            .map(str::to_string)
            .collect(),
        Some(other) => {
            problems.push(format!(
                "{} 的 pi.piggy.capabilities 不是数组：{other}",
                manifest.display()
            ));
            Vec::new()
        }
    }
}

/// 对一个插件条目做能力探测，返回 `(命中, 证据, 探测明细, 问题)`。
fn probe_plugin(plugin: &Value, cap: Capability) -> (bool, String, Vec<Value>, Vec<String>) {
    let mut problems: Vec<String> = Vec::new();
    let dir = PathBuf::from(plugin.get("path").and_then(|v| v.as_str()).unwrap_or(""));
    // 1) 声明
    let declared = declared_capabilities(&dir, &mut problems);
    if declared.iter().any(|c| c == cap.id) {
        return (
            true,
            format!("package.json 声明 pi.piggy.capabilities 含 \"{}\"", cap.id),
            Vec::new(),
            problems,
        );
    }
    // 2) 内容探测
    let entries: Vec<PathBuf> = plugin
        .get("entries")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default();
    let mut detail: Vec<Value> = Vec::new();
    for entry in &entries {
        let (hit, mut rows, mut probs) = probe_entry(entry, cap.markers);
        detail.append(&mut rows);
        problems.append(&mut probs);
        if hit {
            let name = entry
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| entry.to_string_lossy().into_owned());
            return (
                true,
                format!("内容探测：{name} 里出现 {}", cap.markers.join(" / ")),
                detail,
                problems,
            );
        }
    }
    (false, String::new(), detail, problems)
}

/// 探测某个能力的提供者。
///
/// @param id - 能力 id（[`CAPABILITIES`] 里的一个）
/// @param agent_dir - pi 的 agent 目录（`~/.pi/agent`）
/// @param cwd - 当前项目目录（`None` = 只盘全局）
/// @returns 形状见 `tests/ipc_contract.rs`：`supported` 才是"能不能开界面"的判据
pub fn status(id: &str, agent_dir: &Path, cwd: Option<&Path>) -> Result<Value, String> {
    let cap = spec(id).ok_or_else(|| {
        format!(
            "未知能力 {id}（已知：{}）",
            CAPABILITIES.iter().map(|c| c.id).collect::<Vec<_>>().join(", ")
        )
    })?;
    let overview = inventory::overview(agent_dir, cwd)?;
    let mut problems: Vec<String> = Vec::new();
    let mut enabled_hit: Option<Value> = None;
    let mut disabled_hits: Vec<Value> = Vec::new();
    let mut considered = 0usize;

    for group in overview
        .get("groups")
        .and_then(|g| g.as_array())
        .cloned()
        .unwrap_or_default()
    {
        for plugin in group
            .get("plugins")
            .and_then(|p| p.as_array())
            .cloned()
            .unwrap_or_default()
        {
            considered += 1;
            let (hit, evidence, detail, mut probs) = probe_plugin(&plugin, cap);
            problems.append(&mut probs);
            if !hit {
                continue;
            }
            let report = json!({
                "name": plugin.get("name").cloned().unwrap_or(Value::Null),
                "key": plugin.get("key").cloned().unwrap_or(Value::Null),
                "kind": plugin.get("kind").cloned().unwrap_or(Value::Null),
                "scope": plugin.get("scope").cloned().unwrap_or(Value::Null),
                "scopeLabel": plugin.get("scopeLabel").cloned().unwrap_or(Value::Null),
                "source": plugin.get("source").cloned().unwrap_or(Value::Null),
                "path": plugin.get("path").cloned().unwrap_or(Value::Null),
                "version": plugin.get("version").cloned().unwrap_or(Value::Null),
                "entries": plugin.get("entries").cloned().unwrap_or(Value::Null),
                "enabled": plugin.get("enabled").cloned().unwrap_or(json!(false)),
                "enabledBy": plugin.get("enabledBy").cloned().unwrap_or(Value::Null),
                "evidence": evidence,
                "probes": detail,
            });
            let enabled = plugin.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
            if enabled {
                // 只留第一条：能力只有一个提供者时（现实就是这样）界面不必选择，
                // 有多个时第一条按 inventory 的加载优先级排在最前面（rank 小的先出）
                if enabled_hit.is_none() {
                    enabled_hit = Some(report);
                }
            } else {
                disabled_hits.push(report);
            }
        }
    }

    let detected = enabled_hit.is_some() || !disabled_hits.is_empty();
    Ok(json!({
        "capability": cap.id,
        "label": cap.label,
        "markers": cap.markers,
        "detected": detected,
        "supported": enabled_hit.is_some(),
        "enabled": enabled_hit.is_some(),
        "plugin": enabled_hit,
        "disabled": disabled_hits,
        "considered": considered,
        "problems": problems,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn spec_lookup_is_exact() {
        assert_eq!(spec("todo").map(|c| c.label), Some("任务清单"));
        assert!(spec("Todo").is_none(), "id 大小写敏感，别做模糊匹配");
        assert!(spec("nope").is_none());
    }

    #[test]
    fn probe_finds_the_marker_in_a_naked_extension_file() {
        let tmp = std::env::temp_dir().join(format!("piggy-cap-{}", std::process::id()));
        let entry = tmp.join("index.ts");
        write(&entry, "pi.registerTool({ name: 'todo_write' })");
        let probe = probe_file(&entry, spec("todo").unwrap().markers);
        assert!(probe.hit);
        assert!(!probe.truncated);
        assert!(probe.error.is_none());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn probe_reports_missing_files_instead_of_guessing() {
        let missing = std::env::temp_dir().join("piggy-cap-does-not-exist/index.ts");
        let probe = probe_file(&missing, &["todo_write"]);
        assert!(!probe.hit);
        assert!(probe.error.is_some(), "读不到要说出来，不能当成『没命中』");
    }

    #[test]
    fn probe_flags_truncation_so_a_miss_is_not_a_verdict() {
        let tmp = std::env::temp_dir().join(format!("piggy-cap-big-{}", std::process::id()));
        let entry = tmp.join("big.ts");
        // 标记串放在上限之后：截断时必然读不到 —— 这正是要标出来的情况
        let padding = "x".repeat(MAX_PROBE_BYTES as usize + 32);
        write(&entry, &format!("{padding}todo_write"));
        let probe = probe_file(&entry, &["todo_write"]);
        assert!(!probe.hit);
        assert!(probe.truncated, "超限必须标出来");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn declared_capabilities_reads_the_piggy_block() {
        let tmp = std::env::temp_dir().join(format!("piggy-cap-decl-{}", std::process::id()));
        write(
            &tmp.join("package.json"),
            r#"{"name":"x","pi":{"extensions":["./index.ts"],"piggy":{"capabilities":["todo"]}}}"#,
        );
        let mut problems = Vec::new();
        assert_eq!(declared_capabilities(&tmp, &mut problems), vec!["todo".to_string()]);
        assert!(problems.is_empty());
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn declared_capabilities_rejects_a_malformed_block() {
        let tmp = std::env::temp_dir().join(format!("piggy-cap-bad-{}", std::process::id()));
        write(&tmp.join("package.json"), r#"{"pi":{"piggy":{"capabilities":"todo"}}}"#);
        let mut problems = Vec::new();
        assert!(declared_capabilities(&tmp, &mut problems).is_empty());
        assert_eq!(problems.len(), 1);
        assert!(problems[0].contains("不是数组"), "{}", problems[0]);
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn declared_capabilities_is_empty_without_a_manifest() {
        let tmp = std::env::temp_dir().join(format!("piggy-cap-none-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let mut problems = Vec::new();
        assert!(declared_capabilities(&tmp, &mut problems).is_empty());
        assert!(problems.is_empty(), "没有 package.json 是正常情况，不是问题");
        let _ = fs::remove_dir_all(&tmp);
    }


    #[test]
    fn dir_entries_are_probed_through_pi_convention_and_do_not_noise() {
        // 真机上 `pi-web-access` 声明 `pi.extensions: ["./dist"]`（目录）。
        // 目录不是"探测失败"：按 pi 的目录入口约定下探一层，找不到候选文件只是"探不到"。
        let tmp = std::env::temp_dir().join(format!("piggy-cap-dir-{}", std::process::id()));
        let dist = tmp.join("dist");
        fs::create_dir_all(&dist).unwrap();
        fs::write(dist.join("index.js"), "registerTool({name:'todo_write'})").unwrap();
        let (hit, detail, problems) = probe_entry(&dist, spec("todo").unwrap().markers);
        assert!(hit, "目录入口要按 index.* 约定下探");
        assert!(problems.is_empty(), "{problems:?}");
        assert!(detail[0]["entry"].as_str().unwrap().ends_with("index.js"));

        // 目录里什么都没有 → 探不到，但**不是问题**
        let empty = tmp.join("empty");
        fs::create_dir_all(&empty).unwrap();
        let (hit, detail, problems) = probe_entry(&empty, &["todo_write"]);
        assert!(!hit);
        assert!(problems.is_empty(), "没有候选文件不是错误：{problems:?}");
        assert!(detail[0]["skipped"].is_string(), "{detail:?}");
        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unknown_capability_is_an_error_not_a_silent_empty() {
        let tmp = std::env::temp_dir().join(format!("piggy-cap-unknown-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let err = status("nope", &tmp, None).unwrap_err();
        assert!(err.contains("未知能力"), "{err}");
        let _ = fs::remove_dir_all(&tmp);
    }

    /// 真机（可选）：对着本机 `~/.pi/agent` 跑一次，看 piggy 能不能认出手上这个 todo 插件。
    /// `cargo test -- --ignored real_machine_capability`
    #[test]
    #[ignore]
    fn real_machine_todo_capability() {
        let agent = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".pi/agent");
        let v = status("todo", &agent, None).unwrap();
        eprintln!("{}", serde_json::to_string_pretty(&v).unwrap());
    }
}
