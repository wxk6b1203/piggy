//! pi 配置文件读写（docs/03 §2.10）：auth.json / models.json / settings.json。
//! 原则：原子写（tmp+rename）、写前 .bak 备份、未知字段保留、绝不存密钥到 Piggy 配置。

use std::path::PathBuf;

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

fn agent_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default()
        .join(".pi/agent")
}

fn read_json(path: &PathBuf) -> Result<serde_json::Value, String> {
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

fn write_json_atomic(path: &PathBuf, v: &serde_json::Value) -> Result<(), String> {
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

fn describe_credential(entry: &serde_json::Value) -> (String, Option<String>) {
    // auth.json 形态：{ "provider": { "type": "oauth", ... } } 或 { "provider": "sk-..." } 或含 api_key 字段
    if let Some(s) = entry.as_str() {
        return ("api_key".to_string(), Some(mask_secret(s)));
    }
    if let Some(obj) = entry.as_object() {
        let kind = obj
            .get("type")
            .and_then(|t| t.as_str())
            .map(String::from)
            .unwrap_or_else(|| {
                if obj.contains_key("access_token") || obj.contains_key("refresh_token") {
                    "oauth".into()
                } else {
                    "unknown".into()
                }
            });
        let key = obj
            .get("api_key")
            .or_else(|| obj.get("access_token"))
            .and_then(|k| k.as_str());
        return (kind, key.map(mask_secret));
    }
    ("unknown".to_string(), None)
}

fn mask_secret(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= 10 {
        return "•".repeat(chars.len());
    }
    format!("{}…{}", chars[..6].iter().collect::<String>(), chars[chars.len() - 4..].iter().collect::<String>())
}

/// 设置 provider 的 API Key（写入 auth.json；结构遵循 pi providers.md：字符串或 {type,api_key}）。
pub fn auth_set_key(provider: &str, api_key: &str) -> Result<(), String> {
    let path = agent_dir().join("auth.json");
    let mut v = read_json(&path)?;
    if !v.is_object() {
        v = serde_json::json!({});
    }
    v[provider] = serde_json::json!({ "type": "api_key", "api_key": api_key });
    write_json_atomic(&path, &v)
}

/// 删除 provider 凭据（= logout）。
pub fn auth_remove(provider: &str) -> Result<(), String> {
    let path = agent_dir().join("auth.json");
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
