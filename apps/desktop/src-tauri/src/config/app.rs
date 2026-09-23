//! Piggy 自有配置（docs/03 §2.10 config/app.rs）：绝不存密钥。
//! M1：工作区布局持久化（~/.piggy/layout.json，原子写）。
//! M2：性能配置 config.json（maxWorkers / idleTimeoutMin，05 §4.1–4.2）。

use std::path::PathBuf;

fn config_dir() -> PathBuf {
    let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    home.join(".piggy")
}

fn layout_path() -> PathBuf {
    config_dir().join("layout.json")
}

fn config_path() -> PathBuf {
    config_dir().join("config.json")
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

/* ---------------- 性能配置（05 §4：maxWorkers / idleTimeout） ---------------- */

/// Piggy 应用级配置（`~/.piggy/config.json`）。
///
/// 注意：`perf_config_save` 会整体重写这个文件，所以**凡是进 config.json 的字段都必须在这里**，
/// 否则会被静默抹掉。
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PerfConfig {
    /// 并发 worker 上限（05 §4.2，默认 8）
    #[serde(default = "default_max_workers")]
    pub max_workers: u32,
    /// worker 空闲回收分钟数，0 = 永不（05 §4.1，默认 10）
    #[serde(default = "default_idle_timeout_min")]
    pub idle_timeout_min: u32,
    /// 新建标签页的默认权限档位（pi/permission.rs）。缺省 = 工作区内修改。
    #[serde(default)]
    pub permission_mode: crate::pi::permission::PermissionMode,
}

fn default_max_workers() -> u32 {
    8
}

fn default_idle_timeout_min() -> u32 {
    10
}

impl Default for PerfConfig {
    fn default() -> Self {
        Self {
            max_workers: default_max_workers(),
            idle_timeout_min: default_idle_timeout_min(),
            permission_mode: crate::pi::permission::PermissionMode::default(),
        }
    }
}

impl PerfConfig {
    pub fn clamp(&mut self) {
        self.max_workers = self.max_workers.clamp(1, 64);
        // 上限兜底 24h；0 保留为"永不回收"语义
        self.idle_timeout_min = self.idle_timeout_min.min(24 * 60);
    }
}

/// 读取性能配置；文件缺失/字段缺省时回落默认值。
pub fn perf_config_load() -> PerfConfig {
    let mut cfg = std::fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str::<PerfConfig>(&raw).ok())
        .unwrap_or_default();
    cfg.clamp();
    cfg
}

pub fn perf_config_save(cfg: &PerfConfig) -> Result<(), String> {
    let mut cfg = cfg.clone();
    cfg.clamp();
    let dir = config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join("config.json.tmp");
    let body = serde_json::to_string_pretty(&cfg).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, config_path()).map_err(|e| e.to_string())
}
