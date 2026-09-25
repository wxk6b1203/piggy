//! 「获取可用模型 / 检测连通性」（docs/03 §2.12）：问一个提供商端点它有哪些模型。
//!
//! 移植自 DSH `packages/llm/llm-pi-ai/src/discovery.ts`，规则逐条对齐：
//!   · **本地目录优先**：pi 的 `models-store.json` 里已经有这个提供商的目录时不联网
//!     （DSH 同款：目录里有的就答目录，因为目录还带上下文窗口/输出上限，列举端点不给）；
//!   · OpenAI 系列举在 `{base}/models`，Anthropic 系在 `{root}/v1/models?limit=1000`
//!     （`listingUrl()`；`root` = 去掉尾部 `/` 与一个尾部 `/v1`）；
//!   · Anthropic 用 `x-api-key` + `anthropic-version: 2023-06-01`，OpenAI 系用
//!     `Authorization: Bearer`；
//!   · 响应体超过 4MB 直接拒绝（端点是用户填的 URL，上限按**实际读到的字节**算，
//!     不信 `Content-Length`）；
//!   · 回复里 `data` 数组优先，其次 `models` 对象（网关常见）；两者都没有就报错让用户手填；
//!   · 单行坏数据跳过，不让一行毁掉整份清单。
//!
//! 与 DSH 的差异（有意）：加了 15s 超时（DSH 用浏览器 fetch 没有显式超时，
//! 桌面端不能无限等）；Azure/Codex 这类非标准鉴权的协议不猜——按"不支持列举"报错。

use std::time::Duration;

use serde_json::{json, Value};

use super::catalog::{self, ListingStyle};

/// 单次请求上限。DSH `discovery.ts:59` 同值。
const MAX_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
/// 超时。桌面端必须有上限，否则端点吊死会一直转圈。
const TIMEOUT: Duration = Duration::from_secs(15);
/// Anthropic 列举端点的分页上限（DSH `ANTHROPIC_MODEL_LIMIT`）。
const ANTHROPIC_MODEL_LIMIT: u32 = 1000;
const ANTHROPIC_VERSION: &str = "2023-06-01";

/// 列举端点 URL。规则与 DSH `listingUrl()` 一致（见模块注释）。
pub fn listing_url(base_url: &str, api: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    match catalog::listing_style(api) {
        ListingStyle::OpenAi => format!("{base}/models"),
        ListingStyle::Anthropic => {
            let root = base.strip_suffix("/v1").unwrap_or(base);
            format!("{root}/v1/models?limit={ANTHROPIC_MODEL_LIMIT}")
        }
    }
}

/// 该协议下要带的鉴权头。返回 `(name, value)`；空密钥 = 不带（有些端点匿名可列）。
pub fn auth_header(api: &str, key: &str) -> Option<(&'static str, String)> {
    let key = key.trim();
    if key.is_empty() {
        return None;
    }
    match catalog::listing_style(api) {
        ListingStyle::OpenAi => Some(("Authorization", format!("Bearer {key}"))),
        ListingStyle::Anthropic => Some(("x-api-key", key.to_string())),
    }
}

/// 从一份列举回复里读出模型行。`data` 数组优先，其次 `models` 对象。
///
/// 出处：DSH `readListing()`。键名取自各家网关的真实写法（`context_length`、
/// `max_output_tokens`、`top_provider.max_completion_tokens`…），不是拍脑袋加的。
pub fn parse_listing(body: &Value) -> Result<Vec<Value>, String> {
    let listed: Vec<(Option<String>, &Value)>;
    if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
        listed = data.iter().map(|raw| (None, raw)).collect();
    } else if let Some(models) = body.get("models") {
        // models 既可能是映射（键 = id，网关常见），也可能是数组（Ollama 风格）。
        // DSH 只认映射；这里多认一种数组写法，不改变"两种都没有就报错"的结论。
        if let Some(arr) = models.as_array() {
            listed = arr.iter().map(|raw| (None, raw)).collect();
        } else if let Some(obj) = models.as_object() {
            listed = obj
                .iter()
                .filter(|(_, v)| v.is_object())
                .map(|(k, v)| (Some(k.clone()), v))
                .collect();
        } else {
            return Err(
                "端点的模型清单既没有 data 数组，也没有 models 对象；请手动填写该提供商的模型".into(),
            );
        }
    } else {
        return Err("端点的模型清单既没有 data 数组，也没有 models 对象；请手动填写该提供商的模型".into());
    }

    let label = |v: &Value, keys: &[&str]| -> Option<String> {
        keys.iter()
            .find_map(|k| v.get(*k).and_then(|x| x.as_str()))
            .filter(|s| !s.is_empty())
            .map(str::to_string)
    };
    let capacity = |v: &Value, keys: &[&str]| -> Option<u64> {
        for k in keys {
            // 支持 `limit.context` 这种一层嵌套
            let found = match k.split_once('.') {
                Some((a, b)) => v.get(a).and_then(|x| x.get(b)),
                None => v.get(*k),
            };
            if let Some(n) = found.and_then(|x| x.as_u64()) {
                if n > 0 {
                    return Some(n);
                }
            }
        }
        None
    };

    let mut out = Vec::new();
    for (key, raw) in listed {
        // models 映射用键当 id；没有键才回落到里面的 id（网关可能放的是规范名）
        let id = key
            .filter(|k| !k.is_empty())
            .or_else(|| label(raw, &["id", "model", "name"]));
        let Some(id) = id else { continue };
        let name = label(raw, &["name", "display_name", "displayName"]).unwrap_or_else(|| id.clone());
        let mut row = json!({ "id": id, "name": name });
        let ctx = capacity(
            raw,
            &["contextWindow", "context_window", "context_length", "max_input_tokens", "limit.context"],
        );
        let max = capacity(
            raw,
            &[
                "maxOutputTokens",
                "max_output_tokens",
                "maxTokens",
                "max_tokens",
                "limit.output",
                "top_provider.max_completion_tokens",
            ],
        );
        if let Some(c) = ctx {
            row["contextWindow"] = json!(c);
        }
        if let Some(m) = max {
            row["maxTokens"] = json!(m);
        }
        out.push(row);
    }
    Ok(out)
}

/// 一次列举的结果，形状直接给前端用。
pub struct Discovery {
    pub source: &'static str,
    pub url: String,
    pub models: Vec<Value>,
}

/// 优先本地模型目录（不联网），没有才上网问。
pub fn discover(
    agent: &std::path::Path,
    provider: &str,
    base_url: &str,
    api: &str,
    api_key: &str,
) -> Result<Discovery, String> {
    let cached = super::overview::cached_catalog(agent, provider);
    if !cached.is_empty() {
        return Ok(Discovery {
            source: "catalog",
            url: String::new(),
            models: cached,
        });
    }
    let url = listing_url(base_url, api);
    let models = fetch_blocking(&url, api, api_key)?;
    Ok(Discovery {
        source: "network",
        url,
        models,
    })
}

/// 同步入口（给 `spawn_blocking`/测试用）：自己起一个当前线程运行时。
pub fn fetch_blocking(url: &str, api: &str, api_key: &str) -> Result<Vec<Value>, String> {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| format!("运行时创建失败: {e}"))?;
    rt.block_on(fetch(url, api, api_key))
}

/// 装 TLS crypto provider（幂等）。
///
/// reqwest 用的是 rustls 的 no-provider 变体：没人先装 provider 的话，
/// `Client::builder().build()` 会**直接 panic**（不是返回错误）。tauri 自己和
/// updater 都是"用之前现装一次"，这里照做——否则真机上一点"检测"就崩。
fn ensure_crypto_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

/// 真发一次请求并解析。错误信息里必须带 URL 或状态码——不然用户只看到"失败了"。
pub async fn fetch(url: &str, api: &str, api_key: &str) -> Result<Vec<Value>, String> {
    ensure_crypto_provider();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err(format!("API 地址必须是 http(s)：{url}"));
    }
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败: {e}"))?;
    let mut req = client.get(url);
    if let Some((name, value)) = auth_header(api, api_key) {
        req = req.header(name, value);
    }
    if catalog::listing_style(api) == ListingStyle::Anthropic {
        req = req.header("anthropic-version", ANTHROPIC_VERSION);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("无法连接 {url}：{}", short_err(&e)))?;
    let status = res.status();
    let body = read_bounded(res).await?;
    if !status.is_success() {
        // 401/403 单独说清楚：这是密钥问题，不是地址问题
        let hint = match status.as_u16() {
            401 | 403 => "（API 密钥可能不对或没有权限）",
            404 => "（地址可能不对：该端点没有 /models）",
            429 => "（被限流了，稍后再试）",
            _ => "",
        };
        return Err(format!("{url} 返回 HTTP {}{hint}：{}", status.as_u16(), snippet(&body)));
    }
    let parsed: Value = serde_json::from_str(&body)
        .map_err(|e| format!("{url} 的回复不是 JSON（{e}）：{}", snippet(&body)))?;
    parse_listing(&parsed)
}

/// 按实际读到的字节限流，不信 `Content-Length`（DSH `readBounded()` 同款理由）。
async fn read_bounded(mut res: reqwest::Response) -> Result<String, String> {
    if let Some(len) = res.content_length() {
        if len > MAX_RESPONSE_BYTES as u64 {
            return Err(format!("回复超过 {MAX_RESPONSE_BYTES} 字节上限（声明 {len} 字节），已拒绝"));
        }
    }
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("读取回复失败：{}", short_err(&e)))? {
        if buf.len() + chunk.len() > MAX_RESPONSE_BYTES {
            return Err(format!("回复超过 {MAX_RESPONSE_BYTES} 字节上限，已拒绝"));
        }
        buf.extend_from_slice(&chunk);
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn short_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return format!("请求超时（{} 秒）", TIMEOUT.as_secs());
    }
    let mut chain = vec![e.to_string()];
    let mut src: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(e);
    while let Some(s) = src {
        chain.push(s.to_string());
        src = s.source();
    }
    chain.join(" ← ")
}

/// 报错时贴一小段回复体：用户要看到端点到底说了什么。
fn snippet(body: &str) -> String {
    let t = body.trim();
    let cut: String = t.chars().take(200).collect();
    if cut.is_empty() {
        "(空回复)".into()
    } else {
        cut
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{Arc, Mutex};

    /// 起一个只答一次的本地 HTTP 服务器，返回 (端口, 收到的原始请求)。
    /// 这是**真 socket**：URL 拼接、请求头、状态码、分块读取全都走真实路径。
    fn serve_once(status: u16, body: &'static str) -> (u16, Arc<Mutex<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(String::new()));
        let sink = seen.clone();
        std::thread::spawn(move || {
            let Ok((mut stream, _)) = listener.accept() else { return };
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            *sink.lock().unwrap() = String::from_utf8_lossy(&buf[..n]).to_string();
            let reason = if status == 200 { "OK" } else { "ERR" };
            let reply = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = stream.write_all(reply.as_bytes());
            let _ = stream.flush();
        });
        (port, seen)
    }

    #[test]
    fn openai_style_url_and_bearer_header() {
        assert_eq!(listing_url("https://api.deepseek.com", "openai-completions"), "https://api.deepseek.com/models");
        assert_eq!(listing_url("https://x.example/v1/", "openai-responses"), "https://x.example/v1/models");
        assert_eq!(
            auth_header("openai-completions", "sk-abc"),
            Some(("Authorization", "Bearer sk-abc".to_string()))
        );
    }

    /// Anthropic 系：去一个尾部 /v1 再拼 /v1/models，并且用 x-api-key。
    #[test]
    fn anthropic_style_url_and_key_header() {
        assert_eq!(
            listing_url("https://api.anthropic.com", "anthropic-messages"),
            "https://api.anthropic.com/v1/models?limit=1000"
        );
        assert_eq!(
            listing_url("https://gw.example/v1", "anthropic-messages"),
            "https://gw.example/v1/models?limit=1000"
        );
        assert_eq!(auth_header("anthropic-messages", "sk-ant"), Some(("x-api-key", "sk-ant".to_string())));
    }

    #[test]
    fn empty_key_sends_no_auth_header() {
        assert_eq!(auth_header("openai-completions", "   "), None);
    }

    /// 真打一次本地端点：请求行/鉴权头/解析全都要对。
    #[test]
    fn fetches_and_parses_over_a_real_socket() {
        let (port, seen) = serve_once(200, r#"{"data":[{"id":"deepseek-flash","context_length":1000000}]}"#);
        let models = fetch_blocking(&format!("http://127.0.0.1:{port}/v1/models"), "openai-completions", "sk-test").unwrap();
        assert_eq!(models.len(), 1);
        assert_eq!(models[0]["id"], "deepseek-flash");
        assert_eq!(models[0]["name"], "deepseek-flash", "没给名字时用 id 兜底");
        assert_eq!(models[0]["contextWindow"], 1000000, "context_length 别名没认出来");
        let req = seen.lock().unwrap().clone();
        assert!(req.starts_with("GET /v1/models "), "请求行不对：{req}");
        assert!(req.contains("authorization: Bearer sk-test") || req.contains("Authorization: Bearer sk-test"), "没带鉴权头：{req}");
    }

    /// 网关常见的 models 映射写法：键就是 id。
    #[test]
    fn parses_models_map_form() {
        let (port, _) = serve_once(
            200,
            r#"{"models":{"glm-4.6":{"display_name":"GLM 4.6","limit":{"context":200000,"output":128000}}}}"#,
        );
        let models = fetch_blocking(&format!("http://127.0.0.1:{port}/models"), "openai-completions", "").unwrap();
        assert_eq!(models[0]["id"], "glm-4.6");
        assert_eq!(models[0]["name"], "GLM 4.6");
        assert_eq!(models[0]["contextWindow"], 200000);
        assert_eq!(models[0]["maxTokens"], 128000);
    }

    /// 401 要说清是密钥问题 + 带上端点原话，而不是一句"失败"。
    #[test]
    fn reports_status_and_body_on_failure() {
        let (port, _) = serve_once(401, r#"{"error":{"message":"invalid api key"}}"#);
        let err = fetch_blocking(&format!("http://127.0.0.1:{port}/models"), "openai-completions", "bad").unwrap_err();
        assert!(err.contains("401"), "{err}");
        assert!(err.contains("API 密钥"), "没提示是密钥问题：{err}");
        assert!(err.contains("invalid api key"), "没带端点原话：{err}");
    }

    #[test]
    fn reports_non_json_reply() {
        let (port, _) = serve_once(200, "<html>hello</html>");
        let err = fetch_blocking(&format!("http://127.0.0.1:{port}/models"), "openai-completions", "").unwrap_err();
        assert!(err.contains("不是 JSON"), "{err}");
        assert!(err.contains("hello"), "没贴回复内容：{err}");
    }

    /// 不是模型清单的 JSON（比如某些网关返回 {"ok":true}）要给出可操作的指引。
    #[test]
    fn reports_unrecognized_shape() {
        assert!(parse_listing(&json!({"ok": true})).unwrap_err().contains("手动填写"));
        assert!(parse_listing(&json!({"models": {}})).unwrap().is_empty());
        assert!(parse_listing(&json!({"models": []})).unwrap().is_empty(), "空数组 = 没有模型，不该报错");
    }

    /// `models` 是数组的写法（Ollama 风格）也要认。
    #[test]
    fn parses_models_array_form() {
        let rows = parse_listing(&json!({"models":[{"name":"qwen3:8b","context_length":32768}]})).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["id"], "qwen3:8b", "数组形式要回落到 name/model 当 id");
        assert_eq!(rows[0]["contextWindow"], 32768);
    }

    /// 单行坏数据只跳过它，不毁掉整份清单。
    #[test]
    fn skips_unusable_rows() {
        let rows = parse_listing(&json!({"data":[{"id":"good"},{"no_id":1},null,"x",{"id":"good2"}]})).unwrap();
        let ids: Vec<&str> = rows.iter().map(|r| r["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["good", "good2"]);
    }

    /// 连不上的端口：错误里要有地址（否则用户不知道该改哪个字段）。
    #[test]
    fn unreachable_endpoint_names_the_url() {
        let err = fetch_blocking("http://127.0.0.1:1/models", "openai-completions", "").unwrap_err();
        assert!(err.contains("127.0.0.1:1"), "{err}");
    }

    /// **真机网络**核对（默认忽略：`cargo test -- --ignored real_network` 手动跑）。
    ///
    /// 不带密钥问真端点：要走到 DNS + TLS + 真 HTTP + 状态码映射，并拿到端点自己的
    /// JSON 错误原文。这证明的是"整条真实链路是通的"——本地假服务器证明不了 TLS/代理/
    /// 证书这一层（而这些恰好是桌面端最容易炸的地方）。
    /// 刻意**不用用户的密钥**：只验错误路径，不拿别人的凭据去打网络。
    #[test]
    #[ignore = "需要网络：cargo test --lib -- --ignored real_network"]
    fn real_network_reports_the_endpoints_own_error() {
        let err = fetch_blocking("https://api.deepseek.com/models", "openai-completions", "")
            .expect_err("不带密钥不该成功");
        eprintln!("真机返回：{err}");
        assert!(err.contains("HTTP 401"), "没拿到 401：{err}");
        assert!(err.to_lowercase().contains("authentication") || err.contains("api key"), "没带上端点原话：{err}");
    }

    #[test]
    fn rejects_non_http_urls() {
        assert!(fetch_blocking("ftp://x/models", "openai-completions", "").unwrap_err().contains("http(s)"));
    }
}
