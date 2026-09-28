//! 提供商配置总览（docs/03 §2.12）：把「内置目录 ∪ auth.json ∪ models.json ∪ 环境变量」
//! 合成配置页真正要显示的那张表——**每一行都带"这个值是哪儿来的"**。
//!
//! 为什么非要带上来源：pi 的密钥解析是**有优先级的**（`provider-composer.ts:347-375`
//! composeApiKeyAuth.resolve）：
//!   1. `auth.json` 里存着的凭据（`input.credential` → `source: "stored credential"`）；
//!   2. 否则 `models.json` 的 `providers.<id>.apiKey`（`source: "configured API key"`）；
//!   3. 否则该提供商自己的环境变量解析（`env-api-keys.ts`）。
//!
//! 也就是说：**同一个提供商可以同时存在三处密钥，只有一处生效**。界面上如果只写
//! "已配置"，用户改了 models.json 里那把旧 key 会以为生效了，实际上 auth.json 里那把
//! 一直在赢。这正是本项目最忌讳的"静默失效"，所以来源必须显示出来。

use std::path::Path;

use serde_json::{json, Map, Value};

use super::catalog;
use crate::config::paths;
use crate::config::pi_files;

/// 密钥来源（顺序即 pi 的解析优先级）。
pub const KEY_AUTH: &str = "auth";
pub const KEY_MODELS_JSON: &str = "models_json";
pub const KEY_ENV: &str = "env";
pub const KEY_NONE: &str = "none";

/// 有效值 + 它的来源。`models_json` 覆盖目录，目录只是默认值。
fn effective(declared_value: Option<&Value>, catalog_value: &'static str) -> (String, &'static str) {
    match declared_value.and_then(|v| v.as_str()).map(str::trim) {
        Some(s) if !s.is_empty() => (s.to_string(), "models_json"),
        _ if !catalog_value.is_empty() => (catalog_value.to_string(), "catalog"),
        _ => (String::new(), "none"),
    }
}

/// 某个提供商在 auth.json 里的凭据（类型, 掩码）。
fn auth_entry(auth: &Value, provider: &str) -> Option<(String, Option<String>)> {
    let entry = auth.get(provider)?;
    let obj = entry.as_object()?;
    let kind = obj.get("type").and_then(|t| t.as_str()).unwrap_or("unknown").to_string();
    let secret = obj
        .get("key")
        .or_else(|| obj.get("access"))
        .and_then(|k| k.as_str());
    Some((kind, secret.map(pi_files::mask_secret)))
}

/// models.json 里声明的模型（只取界面要显示/校验的字段，其余原样留在文件里）。
fn models_of(cfg: &Value) -> Vec<Value> {
    cfg.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let id = m.get("id").and_then(|x| x.as_str())?;
                    Some(json!({
                        "id": id,
                        "name": m.get("name").and_then(|x| x.as_str()).unwrap_or(id),
                        "reasoning": m.get("reasoning").and_then(|x| x.as_bool()).unwrap_or(false),
                        "contextWindow": m.get("contextWindow").cloned().unwrap_or(Value::Null),
                        "maxTokens": m.get("maxTokens").cloned().unwrap_or(Value::Null),
                        "input": m.get("input").cloned().unwrap_or(Value::Null),
                    }))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// pi 本地模型目录缓存（`models-store.json`，`pi update` 维护）里某提供商有多少条。
///
/// 出处：`packages/coding-agent/src/core/models-store.ts:52` —— 默认路径
/// `~/.pi/agent/models-store.json`，形状 `{ "<provider>": { models: Model[] } }`。
/// 它是"不用联网就能拿到的模型清单"，所以「获取可用模型」优先用它（DSH 同款语义：
/// 目录里有的就不上网问，见 DSH `discovery.ts` 开头的 catalog 分支）。
pub fn cached_catalog(agent: &Path, provider: &str) -> Vec<Value> {
    let Ok(store) = pi_files::read_json(&agent.join("models-store.json")) else {
        return Vec::new();
    };
    let Some(entry) = store.get(provider) else {
        return Vec::new();
    };
    let Some(rows) = entry.get("models").and_then(|m| m.as_array()) else {
        return Vec::new();
    };
    rows.iter()
        .filter_map(|m| {
            let id = m.get("id").and_then(|x| x.as_str())?;
            Some(json!({
                "id": id,
                "name": m.get("name").and_then(|x| x.as_str()).unwrap_or(id),
                "reasoning": m.get("reasoning").and_then(|x| x.as_bool()).unwrap_or(false),
                "contextWindow": m.get("contextWindow").cloned().unwrap_or(Value::Null),
                "maxTokens": m.get("maxTokens").cloned().unwrap_or(Value::Null),
                "input": m.get("input").cloned().unwrap_or(Value::Null),
            }))
        })
        .collect()
}

/// 环境变量的读取方式。注入是为了可测：进程环境是全局状态，测试里改它会串味
/// （第一版就踩了：一个测试设了 ANT_LING_API_KEY，另一个测试断言"空配置没有行"当场红）。
type EnvLookup<'a> = &'a dyn Fn(&str) -> bool;

fn real_env(name: &str) -> bool {
    !name.is_empty()
        && std::env::var(name)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
}

/// 合成总览。`agent` = `~/.pi/agent`（测试注入临时目录）。
pub fn overview_at(agent: &Path) -> Result<Value, String> {
    overview_with(agent, &real_env)
}

/// 同 [`overview_at`]，但环境变量的判断方式可注入。
pub fn overview_with(agent: &Path, env: EnvLookup<'_>) -> Result<Value, String> {
    let auth = pi_files::read_json(&agent.join("auth.json"))?;
    let models = pi_files::read_json(&agent.join("models.json"))?;
    let settings = pi_files::read_json(&agent.join("settings.json"))?;
    let default_provider = settings
        .get("defaultProvider")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let declared = models.get("providers").and_then(|p| p.as_object());

    // 行 = 内置目录 ∪ models.json ∪ auth.json ∪ 环境变量已就绪的目录项
    let mut ids: Vec<String> = catalog::CATALOG.iter().map(|e| e.id.to_string()).collect();
    if let Some(obj) = declared {
        for id in obj.keys() {
            if !ids.iter().any(|x| x == id) {
                ids.push(id.clone());
            }
        }
    }
    if let Some(obj) = auth.as_object() {
        for id in obj.keys() {
            if !ids.iter().any(|x| x == id) {
                ids.push(id.clone());
            }
        }
    }

    let mut rows: Vec<Value> = Vec::new();
    for id in ids {
        let entry = catalog::lookup(&id);
        let cfg = declared.and_then(|o| o.get(&id));
        let key = auth_entry(&auth, &id);
        let (base_url, base_url_source) = effective(
            cfg.and_then(|c| c.get("baseUrl")),
            entry.map(|e| e.base_url).unwrap_or(""),
        );
        let (api, api_source) =
            effective(cfg.and_then(|c| c.get("api")), entry.map(|e| e.api).unwrap_or(""));
        let env_var = entry.map(|e| e.env_var).unwrap_or("");
        let env_ok = env(env_var);
        let inline_key = cfg
            .and_then(|c| c.get("apiKey"))
            .and_then(|k| k.as_str())
            .filter(|k| !k.trim().is_empty());
        // 优先级照抄 pi：auth.json > models.json > 环境变量
        let has_auth_key = key.is_some();
        let (key_source, key_masked, key_kind) = if let Some((kind, masked)) = key {
            (KEY_AUTH, masked, kind)
        } else if let Some(k) = inline_key {
            (KEY_MODELS_JSON, Some(pi_files::mask_secret(k)), "api_key".to_string())
        } else if env_ok {
            (KEY_ENV, None, "api_key".to_string())
        } else {
            (KEY_NONE, None, String::new())
        };
        // 既没配置、环境变量也没就绪的纯目录项：不占页面位置
        let has_cfg = cfg.is_some();
        let configured = has_cfg || has_auth_key || env_ok;
        if !configured {
            continue;
        }
        let cached = cached_catalog(agent, &id).len();
        let name = cfg
            .and_then(|c| c.get("name"))
            .and_then(|n| n.as_str())
            .filter(|n| !n.trim().is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| entry.map(|e| e.name).unwrap_or(id.as_str()).to_string());
        rows.push(json!({
            "provider": id,
            "name": name,
            "declared": entry.is_some(),
            "baseUrl": base_url,
            "baseUrlSource": base_url_source,
            "api": api,
            "apiSource": api_source,
            "apis": entry.map(|e| e.apis.to_vec()).unwrap_or_default(),
            "envVar": env_var,
            "keySource": key_source,
            "keyMasked": key_masked,
            "keyKind": key_kind,
            "hasInlineKey": inline_key.is_some(),
            "models": models_of(cfg.unwrap_or(&Value::Null)),
            "cachedModels": cached,
            "isDefault": !default_provider.is_empty() && default_provider == id,
        }));
    }

    // 已配置的排前面，其余按目录顺序（目录顺序 = pi builtinProviders() 的顺序）
    let order: Vec<&str> = catalog::CATALOG.iter().map(|e| e.id).collect();
    rows.sort_by_key(|r| {
        let id = r.get("provider").and_then(|x| x.as_str()).unwrap_or("");
        let idx = order.iter().position(|o| *o == id).unwrap_or(usize::MAX);
        (idx, id.to_string())
    });

    let catalog_rows: Vec<Value> = catalog::CATALOG
        .iter()
        .map(|e| {
            json!({
                "id": e.id,
                "name": e.name,
                "baseUrl": e.base_url,
                "api": e.api,
                "envVar": e.env_var,
                "apis": e.apis,
            })
        })
        .collect();

    Ok(json!({
        "providers": rows,
        "catalog": catalog_rows,
        // 顶层叫 apiOptions（行的 apis 是"该提供商支持的协议"，别混）
        "apiOptions": catalog::KNOWN_APIS,
        "defaults": {
            "provider": default_provider,
            "model": settings.get("defaultModel").and_then(|x| x.as_str()).unwrap_or(""),
        },
        "paths": {
            "agent": agent.to_string_lossy(),
            "auth": agent.join("auth.json").to_string_lossy(),
            "models": agent.join("models.json").to_string_lossy(),
            "settings": agent.join("settings.json").to_string_lossy(),
        },
    }))
}

/// 生产入口：用真实的 `~/.pi/agent`。
pub fn overview() -> Result<Value, String> {
    overview_at(&paths::agent_dir())
}

/// 只保留 `providers` 这一层，给「高级」里的原始 JSON 编辑器做差异展示用。
#[allow(dead_code)]
pub fn providers_only(v: &Value) -> Map<String, Value> {
    v.get("providers")
        .and_then(|p| p.as_object())
        .cloned()
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, body) in files {
            fs::write(dir.path().join(name), body).unwrap();
        }
        dir
    }

    fn row<'a>(v: &'a Value, id: &str) -> &'a Value {
        v["providers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["provider"] == id)
            .unwrap_or_else(|| panic!("总览里没有 {id}"))
    }

    fn ids(v: &Value) -> Vec<String> {
        v["providers"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["provider"].as_str().unwrap().to_string())
            .collect()
    }

    /// 空环境：一个提供商都不显示（40 多条纯目录项不该糊满页面）。
    #[test]
    fn empty_config_shows_nothing() {
        let dir = fixture(&[("auth.json", "{}"), ("models.json", "{}")]);
        let v = overview_at(dir.path()).unwrap();
        assert_eq!(v["providers"].as_array().unwrap().len(), 0, "空配置却有行：{:?}", ids(&v));
        assert_eq!(v["catalog"].as_array().unwrap().len(), catalog::CATALOG.len());
    }

    /// models.json 里的自定义提供商：名字/地址/协议/模型全部来自它，key 来自内联。
    #[test]
    fn custom_provider_reports_inline_key_and_declared_models() {
        let dir = fixture(&[
            ("auth.json", "{}"),
            (
                "models.json",
                r#"{"providers":{"my-relay":{
                    "name":"My Relay","baseUrl":"https://relay.example/v1","api":"openai-completions",
                    "apiKey":"sk-relay-1234567890","models":[{"id":"glm-4.6","name":"GLM 4.6","reasoning":true,"contextWindow":200000}]}}}"#,
            ),
        ]);
        let v = overview_at(dir.path()).unwrap();
        let r = row(&v, "my-relay");
        assert_eq!(r["name"], "My Relay");
        assert_eq!(r["declared"], false);
        assert_eq!(r["baseUrl"], "https://relay.example/v1");
        assert_eq!(r["baseUrlSource"], "models_json");
        assert_eq!(r["keySource"], "models_json");
        assert_eq!(r["hasInlineKey"], true);
        let masked = r["keyMasked"].as_str().unwrap();
        assert!(!masked.contains("34567890"), "掩码泄露了密钥：{masked}");
        assert_eq!(r["models"].as_array().unwrap().len(), 1);
        assert_eq!(r["models"][0]["contextWindow"], 200000);
    }

    /// **优先级就是 pi 的优先级**：auth.json 与 models.json 同时有 key 时，auth 赢。
    /// 这条锁的是"界面上显示的那把 key 与 pi 真正会用的那把是同一把"。
    #[test]
    fn auth_json_key_wins_over_inline_key() {
        let dir = fixture(&[
            ("auth.json", r#"{"deepseek":{"type":"api_key","key":"sk-auth-aaaaaaaaaaaa"}}"#),
            (
                "models.json",
                r#"{"providers":{"deepseek":{"apiKey":"sk-inline-bbbbbbbbbbbb"}}}"#,
            ),
        ]);
        let v = overview_at(dir.path()).unwrap();
        let r = row(&v, "deepseek");
        assert_eq!(r["keySource"], "auth");
        assert!(r["keyMasked"].as_str().unwrap().starts_with("sk-aut"), "显示的不是生效的那把");
        assert_eq!(r["hasInlineKey"], true, "内联那把仍要报出来（界面要提示它没生效）");
        // 没写的字段回落到 pi 目录里的默认值，并且来源要标成 catalog
        assert_eq!(r["baseUrl"], "https://api.deepseek.com");
        assert_eq!(r["baseUrlSource"], "catalog");
        assert_eq!(r["api"], "openai-completions");
        assert_eq!(r["declared"], true);
    }

    /// 环境变量里就绪的目录项也要出现在列表里（否则用户会以为 piggy 看不见它）。
    /// 环境判断是注入的：不碰进程全局，也就不会串味到别的测试。
    #[test]
    fn catalog_provider_with_env_only_is_listed() {
        let dir = fixture(&[("auth.json", "{}"), ("models.json", "{}")]);
        let none = |_: &str| false;
        let v = overview_with(dir.path(), &none).unwrap();
        assert_eq!(v["providers"].as_array().unwrap().len(), 0, "没有环境变量却有行");

        let deepseek = |name: &str| name == "DEEPSEEK_API_KEY";
        let v = overview_with(dir.path(), &deepseek).unwrap();
        let r = row(&v, "deepseek");
        assert_eq!(r["keySource"], "env");
        assert_eq!(r["envVar"], "DEEPSEEK_API_KEY");
        assert_eq!(r["baseUrl"], "https://api.deepseek.com", "环境变量就绪时地址该回落到目录默认值");
        // 只认环境变量的提供商，不该顺带把别的目录项也显示出来
        assert_eq!(v["providers"].as_array().unwrap().len(), 1, "{:?}", ids(&v));
    }

    /// models-store.json 里的本地目录缓存条数要报出来（它是"不联网拿模型清单"的来源）。
    #[test]
    fn cached_catalog_count_comes_from_models_store() {
        let dir = fixture(&[
            ("auth.json", "{}"),
            ("models.json", r#"{"providers":{"deepseek":{"apiKey":"sk-x-1234567890"}}}"#),
            (
                "models-store.json",
                r#"{"deepseek":{"models":[{"id":"deepseek-flash"},{"id":"deepseek-v4-pro"}]}}"#,
            ),
        ]);
        let v = overview_at(dir.path()).unwrap();
        assert_eq!(row(&v, "deepseek")["cachedModels"], 2);
    }

    /// defaultProvider 来自 settings.json —— 界面上要能看出"当前默认是哪个"。
    #[test]
    fn default_provider_is_marked() {
        let dir = fixture(&[
            ("auth.json", "{}"),
            ("models.json", r#"{"providers":{"a":{"apiKey":"sk-1-1234567890"},"b":{"apiKey":"sk-2-1234567890"}}}"#),
            ("settings.json", r#"{"defaultProvider":"b","defaultModel":"m1"}"#),
        ]);
        let v = overview_at(dir.path()).unwrap();
        assert_eq!(row(&v, "a")["isDefault"], false);
        assert_eq!(row(&v, "b")["isDefault"], true);
        assert_eq!(v["defaults"]["model"], "m1");
    }

    /// 顺序：目录顺序优先（= pi builtinProviders() 的顺序），自定义的排后面。
    #[test]
    fn rows_follow_catalog_order_then_custom() {
        let dir = fixture(&[
            ("auth.json", "{}"),
            (
                "models.json",
                r#"{"providers":{"zzz-mine":{"apiKey":"sk-z-1234567890"},"openai":{"apiKey":"sk-o-1234567890"}}}"#,
            ),
        ]);
        let v = overview_at(dir.path()).unwrap();
        let listed = ids(&v);
        let openai = listed.iter().position(|x| x == "openai").unwrap();
        let zzz = listed.iter().position(|x| x == "zzz-mine").unwrap();
        assert!(openai < zzz, "目录项该排在自定义项前面：{listed:?}");
    }

    /// **真机核对**（默认忽略：`cargo test --lib -- --ignored real_home --nocapture`）：
    /// 拿真实的 `~/.pi/agent` 跑一遍合成，把"配置页会显示成什么样"打出来。
    /// 只打印展示名/来源/条数，**不打印密钥**（掩码由被测代码生成，这里也不额外展开）。
    #[test]
    #[ignore = "需要真实 ~/.pi/agent：cargo test --lib -- --ignored real_home --nocapture"]
    fn real_home_overview_is_renderable() {
        let v = overview().expect("真实 agent 目录应该能读");
        for r in v["providers"].as_array().unwrap() {
            eprintln!(
                "- {} ({}) 声明={} 地址={} 协议={} 密钥来源={} 模型={} 目录缓存={} 默认={}",
                r["name"].as_str().unwrap_or("?"),
                r["provider"].as_str().unwrap_or("?"),
                r["declared"],
                r["baseUrl"].as_str().unwrap_or(""),
                r["api"].as_str().unwrap_or(""),
                r["keySource"].as_str().unwrap_or(""),
                r["models"].as_array().map(|m| m.len()).unwrap_or(0),
                r["cachedModels"],
                r["isDefault"],
            );
        }
        eprintln!("内置目录 {} 条，协议 {} 种", v["catalog"].as_array().unwrap().len(), v["apiOptions"].as_array().unwrap().len());
        // 每一行都必须是界面能直接渲染的形状（拿不到 name 就是白行）
        for r in v["providers"].as_array().unwrap() {
            assert!(!r["name"].as_str().unwrap_or("").is_empty(), "有行没有展示名：{r}");
            assert!(!r["provider"].as_str().unwrap_or("").is_empty(), "有行没有 id：{r}");
        }
    }

    /// 坏 JSON 要说清楚是哪个文件坏了，而不是给一个空列表。
    #[test]
    fn broken_models_json_reports_the_file() {
        let dir = fixture(&[("auth.json", "{}"), ("models.json", "{not json")]);
        let err = overview_at(dir.path()).unwrap_err();
        assert!(err.contains("models.json"), "错误信息没点出文件：{err}");
    }
}
