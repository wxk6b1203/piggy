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

/// 新建/更新一个提供商。`patch` 里出现的键才写，空串 = 删键（回落 pi 目录默认值）。
#[tauri::command]
pub async fn provider_save(provider: String, patch: Value) -> Result<Value, String> {
    let agent = paths::agent_dir();
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

/// 「获取可用模型 / 检测」：本地模型目录优先（不联网），否则问端点。
///
/// 返回里带 `source`（catalog/network）、`url`（真打的地址）与 `keySource`
/// （这次用的是哪把密钥）——用户点"检测"时必须能看出**到底测了什么**，
/// 否则"通过"两个字毫无信息量。
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
        tokio::task::spawn_blocking(move || {
            let cached = overview::cached_catalog(&agent, &provider);
            let (key, key_source) = resolve_key(&agent, &provider, &typed);
            (cached, key, key_source)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    let (cached, key, key_source) = probe;
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
        assert_eq!(resolve_key(dir.path(), "deepseek", "sk-typed"), ("sk-typed".into(), "typed"));
        assert_eq!(resolve_key(dir.path(), "deepseek", "  "), ("sk-auth".into(), "auth"));

        // 拿掉 auth.json 那把 → 轮到 models.json
        fs::write(dir.path().join("auth.json"), "{}").unwrap();
        assert_eq!(resolve_key(dir.path(), "deepseek", ""), ("sk-inline".into(), "models_json"));

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
}
