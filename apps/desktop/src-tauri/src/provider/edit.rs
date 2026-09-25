//! 提供商配置的写入（docs/03 §2.12）：改 `models.json` 的 `providers.<id>`。
//!
//! 三条铁律：
//!   1. **只动界面真正拥有的字段**（name / baseUrl / api / apiKey / models），
//!      其余一律原样保留——用户的 models.json 里有 `compat`、`thinkingLevelMap`、
//!      `cost`、`headers` 这些界面不展示的东西，重建整个对象会把它们抹掉；
//!   2. **模型行按 id 合并**：界面改的是"这一行"，不是"整张表"，
//!      所以同 id 的行做字段级合并，未知字段留着；
//!   3. **空值 = 删键**，不是写空串。pi 的 schema 里 `name`/`baseUrl`/`api` 都要求
//!      `minLength: 1`（`model-config.ts:229-242`），写空串会让整份 models.json
//!      校验失败（`Invalid models.json schema`）——那比不写还糟。

use std::path::Path;

use serde_json::{json, Map, Value};

use crate::config::pi_files;

/// 路由 id 的约束：非空、无空白/控制字符、无 `/`。
///
/// pi 自己只要求"是个非空字符串"（`providers: Record<string, ProviderConfig>`），
/// 但 id 同时是 auth.json 的键、是 `provider/model` 里的前半段，带空白或斜杠
/// 会让它在别处解析不出来。这里拦在写之前，并给出人话理由。
pub fn validate_provider_id(id: &str) -> Result<(), String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("提供商 id 不能为空".into());
    }
    if id.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(format!("提供商 id 不能含空格或控制字符：{id:?}"));
    }
    if id.contains('/') {
        return Err(format!("提供商 id 不能含 `/`（它会出现在 provider/model 里）：{id}"));
    }
    Ok(())
}

/// 界面拥有的一行模型。其余字段（cost/compat/…）由 `merge_models` 从旧行带过来。
fn clean_model(v: &Value, index: usize) -> Result<Value, String> {
    let obj = v
        .as_object()
        .ok_or_else(|| format!("模型 {} 不是一个对象", index + 1))?;
    let id = obj
        .get("id")
        .and_then(|x| x.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("模型 {} 缺少 id", index + 1))?;
    let mut out = Map::new();
    out.insert("id".into(), json!(id));
    // 显示名留空就删键（pi 的语义：留空用 id，见 DSH `modelNamePlaceholder`）
    match obj.get("name").and_then(|x| x.as_str()).map(str::trim) {
        Some(s) if !s.is_empty() => {
            out.insert("name".into(), json!(s));
        }
        _ => {}
    }
    if let Some(b) = obj.get("reasoning").and_then(|x| x.as_bool()) {
        if b {
            out.insert("reasoning".into(), json!(true));
        }
    }
    for key in ["contextWindow", "maxTokens"] {
        match obj.get(key) {
            // 数字以外的值（含 null）一律当"没填"——pi 的 schema 要求 Number
            Some(Value::Number(n)) if n.as_f64().map(|f| f > 0.0).unwrap_or(false) => {
                out.insert(key.into(), json!(n));
            }
            Some(Value::Null) | None => {}
            Some(other) => return Err(format!("模型 {} 的 {key} 不是正数：{other}", index + 1)),
        }
    }
    if let Some(Value::Array(arr)) = obj.get("input") {
        let kinds: Vec<&str> = arr
            .iter()
            .filter_map(|x| x.as_str())
            .filter(|s| *s == "text" || *s == "image")
            .collect();
        if !kinds.is_empty() {
            out.insert("input".into(), json!(kinds));
        }
    }
    Ok(Value::Object(out))
}

/// 把界面送来的模型表合并到旧模型表上：同 id 保留未知字段。
fn merge_models(old: Option<&Value>, new: &[Value]) -> Result<Vec<Value>, String> {
    let mut seen: Vec<String> = Vec::new();
    let mut out = Vec::new();
    for (i, m) in new.iter().enumerate() {
        let cleaned = clean_model(m, i)?;
        let id = cleaned["id"].as_str().unwrap().to_string();
        if seen.contains(&id) {
            return Err(format!("模型 id 重复：{id}"));
        }
        seen.push(id.clone());
        // 旧行里同 id 的那些字段，界面没管的照抄回来
        let merged = match old
            .and_then(|o| o.as_array())
            .and_then(|arr| arr.iter().find(|x| x.get("id").and_then(|v| v.as_str()) == Some(id.as_str())))
        {
            Some(prev) => {
                let mut base = prev.as_object().cloned().unwrap_or_default();
                for (k, v) in cleaned.as_object().unwrap() {
                    base.insert(k.clone(), v.clone());
                }
                // 界面显式清掉的字段要从旧行里删掉，否则"清空"看起来不生效
                for key in ["name", "reasoning", "contextWindow", "maxTokens", "input"] {
                    if !cleaned.as_object().unwrap().contains_key(key) {
                        base.remove(key);
                    }
                }
                Value::Object(base)
            }
            None => cleaned,
        };
        out.push(merged);
    }
    Ok(out)
}

fn providers_mut(doc: &mut Value) -> Result<&mut Map<String, Value>, String> {
    if !doc.is_object() {
        *doc = json!({});
    }
    let obj = doc.as_object_mut().unwrap();
    if !obj.get("providers").map(|p| p.is_object()).unwrap_or(false) {
        obj.insert("providers".into(), json!({}));
    }
    Ok(obj.get_mut("providers").unwrap().as_object_mut().unwrap())
}

/// 保存一个提供商（不存在就创建）。`patch` 里出现的键才写，空串 = 删键。
pub fn save_at(agent: &Path, provider: &str, patch: &Value) -> Result<Value, String> {
    validate_provider_id(provider)?;
    let path = agent.join("models.json");
    let mut doc = pi_files::read_json(&path)?;
    let existing = doc
        .get("providers")
        .and_then(|p| p.get(provider))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mut entry = existing.as_object().cloned().unwrap_or_default();

    for key in ["name", "baseUrl", "api"] {
        if let Some(v) = patch.get(key) {
            match v.as_str().map(str::trim) {
                Some(s) if !s.is_empty() => {
                    entry.insert(key.into(), json!(s));
                }
                // 空 = 删键（回落 pi 目录默认值），不是写空串
                _ => {
                    entry.remove(key);
                }
            }
        }
    }
    if let Some(models) = patch.get("models") {
        let arr = models.as_array().ok_or("models 必须是数组")?;
        if arr.is_empty() {
            entry.remove("models"); // 空表 = 回落 pi 目录
        } else {
            let merged = merge_models(entry.get("models"), arr)?;
            entry.insert("models".into(), json!(merged));
        }
    }

    let obj = providers_mut(&mut doc)?;
    obj.insert(provider.to_string(), Value::Object(entry.clone()));
    pi_files::write_json_atomic(&path, &doc)?;
    Ok(Value::Object(entry))
}

/// 写内联 API 密钥（`providers.<id>.apiKey`）。空串 = 删键。
pub fn set_inline_key_at(agent: &Path, provider: &str, key: &str) -> Result<(), String> {
    validate_provider_id(provider)?;
    let path = agent.join("models.json");
    let mut doc = pi_files::read_json(&path)?;
    let obj = providers_mut(&mut doc)?;
    let mut entry = obj.get(provider).and_then(|v| v.as_object()).cloned().unwrap_or_default();
    let trimmed = key.trim();
    if trimmed.is_empty() {
        entry.remove("apiKey");
    } else {
        entry.insert("apiKey".into(), json!(trimmed));
    }
    obj.insert(provider.to_string(), Value::Object(entry));
    pi_files::write_json_atomic(&path, &doc)
}

/// 删掉一个提供商在 models.json 里的定义（auth.json 的凭据由调用方另行处理）。
pub fn remove_at(agent: &Path, provider: &str) -> Result<(), String> {
    validate_provider_id(provider)?;
    let path = agent.join("models.json");
    let mut doc = pi_files::read_json(&path)?;
    if let Some(obj) = doc.get_mut("providers").and_then(|p| p.as_object_mut()) {
        obj.remove(provider);
    }
    pi_files::write_json_atomic(&path, &doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn fixture(models: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("auth.json"), "{}").unwrap();
        fs::write(dir.path().join("models.json"), models).unwrap();
        dir
    }

    fn read(dir: &tempfile::TempDir) -> Value {
        serde_json::from_str(&fs::read_to_string(dir.path().join("models.json")).unwrap()).unwrap()
    }

    /// 新建一个提供商：只写 patch 里给的键。
    #[test]
    fn creates_a_provider() {
        let dir = fixture("{}");
        save_at(
            dir.path(),
            "my-relay",
            &json!({"name":"My Relay","baseUrl":"https://relay.example/v1","api":"openai-completions"}),
        )
        .unwrap();
        let d = read(&dir);
        assert_eq!(d["providers"]["my-relay"]["name"], "My Relay");
        assert_eq!(d["providers"]["my-relay"]["baseUrl"], "https://relay.example/v1");
    }

    /// **不许抹掉界面不认识的字段**：用户手写的 compat / thinkingLevelMap / cost 要活下来。
    #[test]
    fn preserves_unknown_fields() {
        let dir = fixture(
            r#"{"providers":{"a":{"name":"A","compat":{"thinkingFormat":"deepseek"},"headers":{"X-Y":"1"},
               "modelOverrides":{"m":{"reasoning":true}},
               "models":[{"id":"m","name":"M","cost":{"input":1,"output":2},"thinkingLevelMap":{"max":"max"}}]}}}"#,
        );
        save_at(dir.path(), "a", &json!({"name":"A2","models":[{"id":"m","name":"M2","reasoning":true}]})).unwrap();
        let d = read(&dir);
        assert_eq!(d["providers"]["a"]["name"], "A2");
        assert_eq!(d["providers"]["a"]["compat"]["thinkingFormat"], "deepseek");
        assert_eq!(d["providers"]["a"]["headers"]["X-Y"], "1");
        assert_eq!(d["providers"]["a"]["modelOverrides"]["m"]["reasoning"], true);
        let m = &d["providers"]["a"]["models"][0];
        assert_eq!(m["name"], "M2");
        assert_eq!(m["reasoning"], true);
        assert_eq!(m["cost"]["output"], 2, "模型行里的未知字段被抹了");
        assert_eq!(m["thinkingLevelMap"]["max"], "max", "模型行里的未知字段被抹了");
    }

    /// 清空一个字段 = 删键（回落 pi 目录默认值），不能留空串——pi 的 schema 要求 minLength 1。
    #[test]
    fn clearing_a_field_removes_the_key() {
        let dir = fixture(r#"{"providers":{"a":{"name":"A","baseUrl":"https://x.example","api":"openai-completions"}}}"#);
        save_at(dir.path(), "a", &json!({"name":"","baseUrl":"  ","api":""})).unwrap();
        let d = read(&dir);
        let p = d["providers"]["a"].as_object().unwrap();
        assert!(!p.contains_key("name") && !p.contains_key("baseUrl") && !p.contains_key("api"), "{p:?}");
    }

    /// 模型表为空 = 删键（回落到 pi 内置目录），不是留一个空数组。
    #[test]
    fn empty_models_removes_the_key() {
        let dir = fixture(r#"{"providers":{"a":{"models":[{"id":"m"}]}}}"#);
        save_at(dir.path(), "a", &json!({"models":[]})).unwrap();
        assert!(read(&dir)["providers"]["a"].as_object().unwrap().get("models").is_none());
    }

    /// 别的提供商不许被动到。
    #[test]
    fn leaves_other_providers_alone() {
        let dir = fixture(r#"{"providers":{"a":{"name":"A"},"b":{"name":"B","apiKey":"sk-b-1234567890"}}}"#);
        save_at(dir.path(), "a", &json!({"name":"A3"})).unwrap();
        let d = read(&dir);
        assert_eq!(d["providers"]["b"]["name"], "B");
        assert_eq!(d["providers"]["b"]["apiKey"], "sk-b-1234567890");
    }

    /// 模型 id 重复 / 空 id 要报出来并指出是第几行。
    #[test]
    fn rejects_bad_model_rows() {
        let dir = fixture("{}");
        let e = save_at(dir.path(), "a", &json!({"models":[{"id":"m"},{"id":"m"}]})).unwrap_err();
        assert!(e.contains("重复"), "{e}");
        let e = save_at(dir.path(), "a", &json!({"models":[{"name":"没有 id"}]})).unwrap_err();
        assert!(e.contains("模型 1"), "{e}");
        let e = save_at(dir.path(), "a", &json!({"models":[{"id":"m","contextWindow":"很大"}]})).unwrap_err();
        assert!(e.contains("contextWindow"), "{e}");
    }

    /// 非正容量**要报错**，不能静默丢掉：用户填了 "-1" 却什么都没发生，
    /// 是最难查的那种"我明明填了"。
    #[test]
    fn non_positive_capacity_is_rejected_loudly() {
        let dir = fixture("{}");
        let e = save_at(dir.path(), "a", &json!({"models":[{"id":"m","contextWindow":-1}]})).unwrap_err();
        assert!(e.contains("contextWindow") && e.contains("-1"), "{e}");
        // null / 缺省 = 没填，合法
        save_at(dir.path(), "a", &json!({"models":[{"id":"m","contextWindow":null}]})).unwrap();
        let m = &read(&dir)["providers"]["a"]["models"][0];
        assert!(m.get("contextWindow").is_none(), "{m}");
    }

    #[test]
    fn inline_key_round_trip() {
        let dir = fixture("{}");
        set_inline_key_at(dir.path(), "a", "  sk-abc  ").unwrap();
        assert_eq!(read(&dir)["providers"]["a"]["apiKey"], "sk-abc");
        set_inline_key_at(dir.path(), "a", "").unwrap();
        assert!(read(&dir)["providers"]["a"].as_object().unwrap().get("apiKey").is_none());
    }

    #[test]
    fn removes_a_provider_only() {
        let dir = fixture(r#"{"providers":{"a":{"name":"A"},"b":{"name":"B"}},"other":1}"#);
        remove_at(dir.path(), "a").unwrap();
        let d = read(&dir);
        assert!(d["providers"].as_object().unwrap().get("a").is_none());
        assert_eq!(d["providers"]["b"]["name"], "B");
        assert_eq!(d["other"], 1, "顶层其它键被动了");
    }

    #[test]
    fn rejects_unusable_ids() {
        assert!(validate_provider_id("").is_err());
        assert!(validate_provider_id("  ").is_err());
        assert!(validate_provider_id("a b").is_err());
        assert!(validate_provider_id("a/b").is_err());
        assert!(validate_provider_id("cc-switch-deep-seek").is_ok());
    }

    /// 写入是原子的：留 .bak，且临时文件不残留。
    #[test]
    fn writes_are_atomic_with_backup() {
        let dir = fixture(r#"{"providers":{"a":{"name":"A"}}}"#);
        save_at(dir.path(), "a", &json!({"name":"A2"})).unwrap();
        assert!(dir.path().join("models.json.bak").exists(), "没有 .bak 备份");
        assert!(!dir.path().join("models.json.tmp").exists(), "临时文件没清掉");
    }
}
