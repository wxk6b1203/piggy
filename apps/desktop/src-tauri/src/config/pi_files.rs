//! pi 配置文件读写（docs/03 §2.10）：auth.json / models.json / settings.json。
//! 原则：原子写（tmp+rename）、写前 .bak 备份、未知字段保留、绝不存密钥到 Piggy 配置。

use crate::config::paths::{self, agent_dir};
use std::path::{Path, PathBuf};

/// pi 的会话目录环境变量（`config.ts:509` 的 `ENV_SESSION_DIR`，
/// 生效点在 `main.ts:675-679`）。
pub const ENV_SESSION_DIR: &str = "PI_CODING_AGENT_SESSION_DIR";

/// 生效会话根是从哪来的（设置页要显示它，排查时才分得清"默认值坏了"还是"自定义值被吞了"）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionsRootSource {
    Default,
    Env,
    Settings,
}

impl SessionsRootSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Env => "env",
            Self::Settings => "settings",
        }
    }
}

/// 生效会话根 + 它的来源（**唯一**实现，读写两侧都走这里）。
///
/// 照 pi `main.ts:675-679` 的优先级（从高到低）：`--session-dir` 旗标、
/// `PI_CODING_AGENT_SESSION_DIR`、settings.json 的 `sessionDir`、
/// 默认 `<agent>/sessions`。Piggy 不用旗标（它总是显式 `--session <文件>`），
/// 所以这里管后三条。
///
/// **只认绝对路径**（含 `~` 展开后绝对）：相对路径在 pi 那边是"随项目 cwd"，
/// 扫描器无法枚举，于是回退默认值并在 UI 里标成默认（docs/02 §6.1、docs/15 缺口）。
///
/// 返回值里的来源还决定**布局**：默认根按 cwd 分子目录，自定义根平铺
/// （见 [`sessions_root_spec`]）。
pub fn effective_sessions_root(
    default: PathBuf,
    env_dir: Option<&str>,
    setting: Option<&str>,
) -> (PathBuf, SessionsRootSource) {
    for (raw, source) in [(env_dir, SessionsRootSource::Env), (setting, SessionsRootSource::Settings)] {
        let Some(t) = raw.map(str::trim).filter(|t| !t.is_empty()) else {
            continue;
        };
        let expanded = paths::expand_home(t);
        if expanded.is_absolute() {
            return (expanded, source);
        }
    }
    (default, SessionsRootSource::Default)
}

/// 会话根目录（生产入口）。
pub fn sessions_root() -> PathBuf {
    sessions_root_spec().0
}

/// 会话根目录 + **是否自定义**（`true` = 来自 `PI_CODING_AGENT_SESSION_DIR` 或
/// `settings.json` 的 `sessionDir`）。
///
/// 为什么要连"是不是自定义"一起给：pi 对这两种会话根的**布局规则不同**——
/// 默认根下按 cwd 分子目录（`--<cwd 编码>--`），自定义根则**平铺**（自定义值被当叶子目录用，
/// 列举走 `listSessionsFromDir`，只读该目录下的 `*.jsonl`）。写会话的人（`precreate_session_file`）
/// 必须按同一规则落点，否则终端 pi 的会话选择器看不见 Piggy 建的会话。
pub fn sessions_root_spec() -> (PathBuf, bool) {
    let (root, source) = effective_sessions_root(
        agent_dir().join("sessions"),
        env_session_dir().as_deref(),
        setting_session_dir().as_deref(),
    );
    (root, source != SessionsRootSource::Default)
}

/// `PI_CODING_AGENT_SESSION_DIR` 的值（空串视为未设置）。
fn env_session_dir() -> Option<String> {
    std::env::var(ENV_SESSION_DIR)
        .ok()
        .filter(|v| !v.trim().is_empty())
}

/// settings.json 的 `sessionDir`（读不到/不是字符串 → None）。
fn setting_session_dir() -> Option<String> {
    std::fs::read_to_string(agent_dir().join("settings.json"))
        .ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .and_then(|v| v.get("sessionDir").and_then(|x| x.as_str()).map(String::from))
}

/// 当前生效会话目录（GUI 展示用）：{ dir, isCustom, raw, source }。
///
/// `source` 是这次新加的：Windows 事故里"默认地址变成 `.pi/agent\sessions`"
/// 光看 `dir` 分不清是默认值坏了还是自定义值被吞了，标明来源才好排查。
pub fn session_dir_effective() -> Result<serde_json::Value, String> {
    let settings = read_json(&agent_dir().join("settings.json"))?;
    let setting = settings
        .get("sessionDir")
        .and_then(|x| x.as_str())
        .map(String::from);
    let env = env_session_dir();
    // 复用同一条优先级规则（不自己再判一遍 is_absolute，否则两处会漂移）
    let (dir, source) = effective_sessions_root(
        agent_dir().join("sessions"),
        env.as_deref(),
        setting.as_deref(),
    );
    Ok(serde_json::json!({
        "dir": dir.to_string_lossy(),
        "isCustom": source != SessionsRootSource::Default,
        "raw": if source == SessionsRootSource::Env { env.clone() } else { setting.clone() },
        "source": source.as_str(),
    }))
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

/* ---------------- 会话根目录优先级（pi main.ts:675-679） ---------------- */

#[cfg(test)]
mod session_root_tests {
    use super::{agent_dir, effective_sessions_root, paths, SessionsRootSource};
    use std::path::PathBuf;

    fn default_root() -> PathBuf {
        PathBuf::from("/h/u").join(".pi").join("agent").join("sessions")
    }

    #[test]
    fn sessions_root_prefers_env_over_settings() {
        // pi：env（PI_CODING_AGENT_SESSION_DIR）优先于 settings.json 的 sessionDir
        let (got, source) = effective_sessions_root(
            default_root(),
            Some("/tmp/env-sessions"),
            Some("/tmp/set-sessions"),
        );
        assert_eq!(got, PathBuf::from("/tmp/env-sessions"));
        assert_eq!(source, SessionsRootSource::Env);
    }

    #[test]
    fn sessions_root_uses_settings_when_env_absent() {
        let (got, source) = effective_sessions_root(default_root(), None, Some("~/sess"));
        let home = paths::home_dir().expect("真机/CI 都有主目录");
        assert_eq!(got, home.join("sess"));
        assert_eq!(source, SessionsRootSource::Settings);
    }

    #[test]
    fn sessions_root_ignores_relative_and_empty() {
        // 相对路径在 pi 那边随项目 cwd，扫描器枚举不了 → 回退默认（docs/15 缺口）
        let cases: [(Option<&str>, Option<&str>); 6] = [
            (Some("rel/dir"), None),
            (None, Some("rel/dir")),
            (Some("   "), None),
            (Some(""), Some("  ")),
            (None, None),
            (Some("dir/./x"), Some("..")), // 都是相对
        ];
        for (env, setting) in cases {
            let (got, source) = effective_sessions_root(default_root(), env, setting);
            assert_eq!(got, default_root(), "env={env:?} setting={setting:?}");
            assert_eq!(source, SessionsRootSource::Default);
        }
    }

    /// `~` 展开后绝对 → 算自定义（pi 也是这么认的：expandTildePath 之后才 join）
    #[test]
    fn sessions_root_expands_tilde_before_deciding() {
        let (got, source) = effective_sessions_root(default_root(), None, Some("~/x"));
        let home = paths::home_dir().expect("真机/CI 都有主目录");
        assert_eq!(got, home.join("x"));
        assert_eq!(source, SessionsRootSource::Settings);
    }

    #[test]
    fn sessions_root_result_is_absolute_and_well_formed() {
        // Windows 事故的回归位：默认根必须是**绝对**路径，且由 join 逐段拼出。
        let dir = agent_dir().join("sessions");
        assert!(dir.is_absolute(), "默认会话根必须是绝对路径: {}", dir.display());
        assert!(dir.ends_with(".pi/agent/sessions") || std::env::var_os(paths::ENV_AGENT_DIR).is_some());
        // 混合分隔符（`.pi/agent\sessions`）只在 Windows 上看得出来，
        // 所以这条断言就只在 Windows 上生效——它正是用户那台机器上的验收条件。
        #[cfg(windows)]
        assert!(
            !dir.to_string_lossy().contains('/'),
            "路径里混了正斜杠: {}",
            dir.display()
        );
    }
}
