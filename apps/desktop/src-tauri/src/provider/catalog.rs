//! 提供商目录（docs/03 §2.12）：pi 认识哪些提供商、各自默认协议与密钥环境变量。
//!
//! **为什么需要它**：pi 的 RPC 没有「列出所有提供商」这条命令
//! （`rpc-types.ts` 的 RpcCommand 联合里只有 set_model / cycle_model /
//! get_available_models，而 `getAvailableSnapshot()` 只返回**已配置可用**的模型）。
//! 配置页要展示"还没配的那些"，就必须自带一份目录；而目录里的每个字段都必须是
//! pi 源码里写着的事实——抄错一个 id 或字段名，用户就会写出一份 pi 认不出的配置
//! （本项目真实踩过：auth.json 的密钥字段写成 `api_key`，pi 静默忽略）。
//!
//! 数据由 `apps/desktop/scripts/gen-provider-catalog.mjs` 从 pi 源码生成到
//! `catalog_generated.rs`，本文件只做查询与约束校验。**不在这里手写任何 provider**。

// 生成物就在本目录旁边（由 scripts/gen-provider-catalog.mjs 直接写出）
#[path = "catalog_generated.rs"]
mod catalog_generated;

pub use catalog_generated::{CATALOG, KNOWN_APIS};

/// 一条内置提供商目录项。空字符串一律表示「pi 源码里没写」，不是"空值当默认"。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CatalogEntry {
    /// 路由 id：auth.json / models.json 都以它为键。
    pub id: &'static str,
    /// 展示名，取 pi `createProvider({ name })`。
    pub name: &'static str,
    /// 默认 API 地址；空 = pi 未声明（Bedrock/Vertex/Radius 等按环境取）。
    pub base_url: &'static str,
    /// 默认「API 协议」；多协议提供商取 OpenAI 兼容那一门（列举端点最通用）。
    pub api: &'static str,
    /// pi 读哪个环境变量取这个提供商的密钥；空 = pi 不用环境变量
    /// （OAuth / 云凭据 / 在 models.json 里写 key）。
    pub env_var: &'static str,
    /// pi 为该提供商声明的全部协议（用于界面给选项）。空 = 未声明。
    pub apis: &'static [&'static str],
}

/// 按路由 id 查目录项。
pub fn lookup(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.id == id)
}

/// 该协议走 `GET {base}/models` 列举模型（OpenAI 系），还是 `GET {root}/v1/models`（Anthropic 系）。
///
/// 出处：DSH `llm-pi-ai/src/discovery.ts` 的 `listingUrl()` —— 它只对
/// `anthropic-messages` 换成 `/v1/models`，其余（OpenAI 系）都是 `{base}/models`。
/// 这里保持同一套规则，因为 pi 的协议名与 DSH 的 pi-ai 家族是同一套命名。
pub fn listing_style(api: &str) -> ListingStyle {
    if api == "anthropic-messages" {
        ListingStyle::Anthropic
    } else {
        ListingStyle::OpenAi
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ListingStyle {
    OpenAi,
    Anthropic,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 独立金标：手写几个众所周知的提供商的 id→环境变量→协议。
    /// 生成脚本改坏了、或者 pi 换了映射，这里必须红——**不要**用 CATALOG 自己
    /// 生成期望值（那等于用被测物证明被测物）。
    const GOLDEN: &[(&str, &str, &str)] = &[
        ("deepseek", "DEEPSEEK_API_KEY", "openai-completions"),
        ("anthropic", "ANTHROPIC_API_KEY", "anthropic-messages"),
        ("openai", "OPENAI_API_KEY", "openai-responses"),
        ("google", "GEMINI_API_KEY", "google-generative-ai"),
        ("zai", "ZAI_API_KEY", "openai-completions"),
        ("moonshotai", "MOONSHOT_API_KEY", "openai-completions"),
        ("openrouter", "OPENROUTER_API_KEY", "openai-completions"),
        ("github-copilot", "COPILOT_GITHUB_TOKEN", ""),
    ];

    #[test]
    fn golden_providers_match_pi_env_contract() {
        for (id, env, api) in GOLDEN {
            let e = lookup(id).unwrap_or_else(|| panic!("目录里没有 {id}"));
            assert_eq!(e.env_var, *env, "{id} 的环境变量");
            if !api.is_empty() {
                assert_eq!(e.api, *api, "{id} 的默认协议");
            }
        }
    }

    /// anthropic 的环境变量分支列了三个（AUTH_TOKEN / OAUTH_TOKEN / API_KEY），
    /// 但 pi 取密钥时会跳过 AUTH_TOKEN（env-api-keys.ts getEnvApiKey）。展示成
    /// Bearer token 会误导用户把 OAuth token 填进 API 密钥框。
    #[test]
    fn anthropic_prefers_the_api_key_variable() {
        assert_eq!(lookup("anthropic").unwrap().env_var, "ANTHROPIC_API_KEY");
    }

    #[test]
    fn ids_are_unique_and_well_formed() {
        let mut seen = std::collections::HashSet::new();
        for e in CATALOG {
            assert!(!e.id.is_empty(), "空 id");
            assert!(seen.insert(e.id), "id 重复：{}", e.id);
            assert!(!e.name.is_empty(), "{} 没有展示名", e.id);
            assert!(
                !e.id.contains(char::is_whitespace) && !e.id.contains('/'),
                "{} 不像一个路由 id",
                e.id
            );
        }
        assert!(CATALOG.len() >= 40, "目录只剩 {} 条，生成脚本大概漏解析了", CATALOG.len());
    }

    #[test]
    fn declared_urls_and_apis_are_usable() {
        for e in CATALOG {
            if !e.base_url.is_empty() {
                assert!(
                    e.base_url.starts_with("https://") || e.base_url.starts_with("http://"),
                    "{} 的 baseUrl 不是 http(s)：{}",
                    e.id,
                    e.base_url
                );
            }
            if !e.api.is_empty() {
                assert!(KNOWN_APIS.contains(&e.api), "{} 的协议 {} 不在 KnownApi 里", e.id, e.api);
            }
            for api in e.apis {
                assert!(KNOWN_APIS.contains(api), "{} 声明了未知协议 {api}", e.id);
            }
            // 默认协议必须是声明过的之一（否则界面的下拉选不中它）
            if !e.api.is_empty() && !e.apis.is_empty() {
                assert!(e.apis.contains(&e.api), "{} 的默认协议不在 apis 里", e.id);
            }
        }
    }

    /// 列举端点规则：Anthropic 系换 `/v1/models`，其余走 `{base}/models`。
    #[test]
    fn listing_style_follows_the_dsh_rule() {
        assert_eq!(listing_style("anthropic-messages"), ListingStyle::Anthropic);
        assert_eq!(listing_style("openai-completions"), ListingStyle::OpenAi);
        assert_eq!(listing_style("openai-responses"), ListingStyle::OpenAi);
        assert_eq!(listing_style("pi-messages"), ListingStyle::OpenAi);
    }
}
