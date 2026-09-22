//! Piggy 自有配置（docs/03 §2.10 config/app.rs）：绝不存密钥。
//! M1：工作区布局持久化（~/.piggy/layout.json，原子写）。

use std::path::PathBuf;

fn config_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join(".piggy")
}

fn layout_path() -> PathBuf {
    config_dir().join("layout.json")
}

pub fn layout_load() -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(layout_path()).unwrap_or_else(|_| "{}".into());
    serde_json::from_str(&raw).map_err(|e| format!("layout.json 解析失败: {e}"))
}

pub fn layout_save(v: &serde_json::Value) -> Result<(), String> {
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("layout.json.tmp");
    let body = serde_json::to_string_pretty(v).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, layout_path()).map_err(|e| e.to_string())
}
