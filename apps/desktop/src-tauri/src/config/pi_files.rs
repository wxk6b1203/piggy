//! pi 配置文件读写（docs/03 §2.10）：auth.json / models.json / settings.json。
//! 原则：原子写（tmp+rename）、写前 .bak 备份、未知字段保留、绝不存密钥到 Piggy 配置。

use std::path::{Path, PathBuf};

pub fn expand_home(p: &str) -> PathBuf {
    if p == "~" {
        return std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(p)
}

/// 会话根目录：settings.json 的 `sessionDir`（绝对/~ 路径）优先，
/// 否则默认 `~/.pi/agent/sessions`（docs/02 §6.1；相对路径 pi 语义为"随项目 cwd"，
/// 扫描器无法枚举，M1 回退默认并注明）。
pub fn sessions_root() -> PathBuf {
    let default = agent_dir().join("sessions");
    let Ok(raw) = std::fs::read_to_string(agent_dir().join("settings.json")) else {
        return default;
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return default;
    };
    match v.get("sessionDir").and_then(|x| x.as_str()) {
        Some(s) if !s.trim().is_empty() => {
            let expanded = expand_home(s.trim());
            if expanded.is_absolute() {
                expanded
            } else {
                default // 相对路径：pi 侧随项目 cwd 落盘，扫描器回退默认
            }
        }
        _ => default,
    }
}

/// 当前生效会话目录（GUI 展示用）：{ dir, isCustom, raw }。
pub fn session_dir_effective() -> Result<serde_json::Value, String> {
    let settings = read_json(&agent_dir().join("settings.json"))?;
    let raw = settings
        .get("sessionDir")
        .and_then(|x| x.as_str())
        .map(String::from);
    let dir = sessions_root();
    Ok(serde_json::json!({
        "dir": dir.to_string_lossy(),
        "isCustom": raw.is_some(),
        "raw": raw,
    }))
}

pub(crate) fn agent_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".pi/agent")
}

pub(crate) fn read_json(path: &PathBuf) -> Result<serde_json::Value, String> {
    match std::fs::read_to_string(path) {
        Ok(raw) => {
            let t = raw.trim();
            if t.is_empty() {
                return Ok(serde_json::json!({}));
            }
            serde_json::from_str(t).map_err(|e| format!("{} 解析失败: {e}", path.display()))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::json!({})),
        Err(e) => Err(format!("{} 读取失败: {e}", path.display())),
    }
}

pub(crate) fn write_json_atomic(path: &PathBuf, v: &serde_json::Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 备份现有文件
    if path.exists() {
        let bak = path.with_extension("json.bak");
        std::fs::copy(path, &bak).map_err(|e| format!("备份失败: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/* ---------------- auth.json ---------------- */

/// 列出已配置凭据（密钥脱敏：仅显示前 6 + 后 4 位）。
pub fn auth_list() -> Result<serde_json::Value, String> {
    let v = read_json(&agent_dir().join("auth.json"))?;
    let mut out = Vec::new();
    if let Some(obj) = v.as_object() {
        for (provider, entry) in obj {
            let (kind, masked) = describe_credential(entry);
            out.push(serde_json::json!({
                "provider": provider,
                "kind": kind,
                "masked": masked,
            }));
        }
    }
    Ok(serde_json::json!({ "providers": out }))
}

/// 把 auth.json 里的一条凭据翻译成（类型, 掩码后的密钥）。
///
/// **形状以 pi 为准**（packages/ai/src/auth/types.ts:17-20）：
/// ```jsonc
/// { "anthropic": { "type": "api_key", "key": "sk-…" } }
/// { "openai":    { "type": "oauth", "refresh": "…", "access": "…", "expires": 123 } }
/// ```
/// 注意：`pi` 的 `AuthStorage.load()` 对**不合法的条目直接抛错**（auth-storage.ts:239-247），
/// 所以这里认识不了的形状不是"显示不出来"那么轻——它意味着那份 auth.json 整个不可用。
fn describe_credential(entry: &serde_json::Value) -> (String, Option<String>) {
    if let Some(obj) = entry.as_object() {
        let kind = obj
            .get("type")
            .and_then(|t| t.as_str())
            .unwrap_or("unknown")
            .to_string();
        // api_key 的字段名是 `key`（不是 api_key）；oauth 的是 `access`
        let secret = obj
            .get("key")
            .or_else(|| obj.get("access"))
            .and_then(|k| k.as_str());
        return (kind, secret.map(mask_secret));
    }
    // 裸字符串：历史上出现过、但 pi 会视为非法条目 —— 标为 unknown 而不是假装它是 api_key
    if entry.is_string() {
        return ("unknown".to_string(), None);
    }
    ("unknown".to_string(), None)
}

pub(crate) fn mask_secret(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 10 {
        return "•".repeat(chars.len());
    }
    format!("{}…{}", chars[..6].iter().collect::<String>(), chars[chars.len() - 4..].iter().collect::<String>())
}

/// 设置 provider 的 API Key（写入 auth.json）。
///
/// **字段名必须是 `key`**：pi 读的是 `credential.key`（packages/ai/src/auth/types.ts:17-20、
/// auth-storage.ts:233-266）。这里曾写成 `api_key` —— pi 的校验器容忍未知字段所以不报错，
/// 结果是**静默失效**：用户以为存好了，pi 却回落到环境变量、认证一直不过。
pub fn auth_set_key(provider: &str, api_key: &str) -> Result<(), String> {
    auth_set_key_at(&agent_dir(), provider, api_key)
}

/// 同 [`auth_set_key`]，但显式指定 agent 目录（provider 模块与测试用）。
pub(crate) fn auth_set_key_at(agent: &Path, provider: &str, api_key: &str) -> Result<(), String> {
    let path = agent.join("auth.json");
    let mut v = read_json(&path)?;
    if !v.is_object() {
        v = serde_json::json!({});
    }
    v[provider] = serde_json::json!({ "type": "api_key", "key": api_key });
    write_json_atomic(&path, &v)
}

/// 删除 provider 凭据（= logout）。
pub fn auth_remove(provider: &str) -> Result<(), String> {
    auth_remove_at(&agent_dir(), provider)
}

/// 同 [`auth_remove`]，但显式指定 agent 目录。
pub(crate) fn auth_remove_at(agent: &Path, provider: &str) -> Result<(), String> {
    let path = agent.join("auth.json");
    let mut v = read_json(&path)?;
    if let Some(obj) = v.as_object_mut() {
        obj.remove(provider);
    }
    write_json_atomic(&path, &v)
}

/* ---------------- models.json ---------------- */

pub fn models_read() -> Result<serde_json::Value, String> {
    read_json(&agent_dir().join("models.json"))
}

pub fn models_write(v: &serde_json::Value) -> Result<(), String> {
    if !v.is_object() {
        return Err("models.json 必须是对象".into());
    }
    write_json_atomic(&agent_dir().join("models.json"), v)
}

/* ---------------- settings.json（全局） ---------------- */

pub fn settings_read() -> Result<serde_json::Value, String> {
    read_json(&agent_dir().join("settings.json"))
}

pub fn settings_write(v: &serde_json::Value) -> Result<(), String> {
    if !v.is_object() {
        return Err("settings.json 必须是对象".into());
    }
    write_json_atomic(&agent_dir().join("settings.json"), v)
}

#[cfg(test)]
mod auth_shape_tests {
    use super::{auth_remove_at, auth_set_key_at, describe_credential};

    /// 契约：auth.json 的 api_key 条目字段名是 `key`（pi auth/types.ts:17-20）。
    /// 写成 `api_key` 会被 pi 静默忽略——本项目真实踩过，故锁死。
    #[test]
    fn api_key_credential_exposes_the_key_field() {
        let entry = serde_json::json!({ "type": "api_key", "key": "sk-ant-1234567890abcdef" });
        let (kind, masked) = describe_credential(&entry);
        assert_eq!(kind, "api_key");
        let masked = masked.expect("应能读出密钥用于展示");
        assert!(masked.starts_with("sk-ant"), "掩码应保留前缀: {masked}");
        assert!(!masked.contains("567890abcdef"), "掩码不得暴露完整密钥: {masked}");
    }

    /// `api_key` 是**错误**的字段名：必须读不出来，否则我们会以为它可用。
    #[test]
    fn legacy_api_key_field_is_not_treated_as_a_valid_secret() {
        let entry = serde_json::json!({ "type": "api_key", "api_key": "sk-legacy" });
        let (kind, masked) = describe_credential(&entry);
        assert_eq!(kind, "api_key");
        assert!(masked.is_none(), "旧字段名不该被当成有效凭据");
    }

    /// oauth 条目的令牌字段是 `access`（不是 access_token）。
    #[test]
    fn oauth_credential_reads_access_token() {
        let entry = serde_json::json!({
            "type": "oauth", "refresh": "r-1234567890", "access": "a-0987654321", "expires": 1_700_000_000_000u64
        });
        let (kind, masked) = describe_credential(&entry);
        assert_eq!(kind, "oauth");
        assert!(masked.is_some(), "oauth 应能读出 access token");
    }

    /// 裸字符串条目：pi 的 loader 会抛 `Invalid auth.json credential`，
    /// 因此这里必须报 unknown，而不是伪装成可用的 api_key。
    #[test]
    fn bare_string_entry_is_reported_as_unknown() {
        let (kind, masked) = describe_credential(&serde_json::json!("sk-bare"));
        assert_eq!(kind, "unknown");
        assert!(masked.is_none());
    }

    /// 写进 auth.json 的字段名必须是 `key`，且**不能**顺手把别的 provider 抹掉
    /// （配置页的"设置密钥"走的就是这条路）。
    #[test]
    fn auth_write_round_trip_keeps_other_providers() {
        let dir = tempfile::tempdir().unwrap();
        let agent = dir.path().to_path_buf();
        auth_set_key_at(&agent, "a", "sk-a").unwrap();
        auth_set_key_at(&agent, "b", "sk-b").unwrap();
        let raw = std::fs::read_to_string(agent.join("auth.json")).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["a"], serde_json::json!({"type":"api_key","key":"sk-a"}), "字段名必须是 key: {raw}");
        assert_eq!(v["b"]["key"], "sk-b");
        // 覆盖同一个 provider 只换值，不新增条目
        auth_set_key_at(&agent, "a", "sk-a2").unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("auth.json")).unwrap()).unwrap();
        assert_eq!(v.as_object().unwrap().len(), 2);
        assert_eq!(v["a"]["key"], "sk-a2");
        auth_remove_at(&agent, "a").unwrap();
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(agent.join("auth.json")).unwrap()).unwrap();
        assert!(v.get("a").is_none());
        assert_eq!(v["b"]["key"], "sk-b", "删 a 把 b 也删了");
        // 备份文件也要有（原子写契约）
        assert!(agent.join("auth.json.bak").exists());
    }
}
