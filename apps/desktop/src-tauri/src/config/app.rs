//! Piggy 自有配置（docs/03 §2.10 config/app.rs）：绝不存密钥。
//! M1：工作区布局持久化（~/.piggy/layout.json，原子写）。
//! M2：性能配置 config.json（maxWorkers / idleTimeoutMin，05 §4.1–4.2）。

use crate::config::paths;
use std::path::PathBuf;

/// Piggy 自己的配置目录 `~/.piggy`。
///
/// 主目录走 [`paths::home_dir_or_temp`]：老代码只看 `HOME`，Windows 上（默认不设）
/// 解析成**空路径** → `~/.piggy` 退化成**相对路径**，layout.json / config.json
/// 于是落到进程 cwd（装在 Program Files 下通常还没写权限）——设置存不下来。
fn config_dir() -> PathBuf {
    paths::home_dir_or_temp().join(".piggy")
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
/// 会话预览滚动条（TurnRail）放哪边（docs/04 §2.6）。
///
/// 三态而不是 bool：用户要的是"左/右/关"。
/// `#[serde(other)]` 把**认不出的值**收回默认档——config.json 是能手改的，
/// 一个拼错的值不该让整份配置反序列化失败（那会把所有设置一起重置，见 title_thinking 的注释）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RailPlacement {
    Off,
    Left,
    /// 默认右侧：与 DSH 的轮次导航条同侧（docs/12 §3）。
    #[default]
    #[serde(other)]
    Right,
}

impl RailPlacement {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim() {
            "off" => Ok(Self::Off),
            "left" => Ok(Self::Left),
            "right" => Ok(Self::Right),
            other => Err(format!("未知的预览滚动条位置 {other:?}（可选：off / left / right）")),
        }
    }
}

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
    /// pi 二进制来源（pi/discovery.rs）。**默认 system**：打包虽捆绑自定义 pi，
    /// 但不劫持用户机器上已有的安装。
    #[serde(default)]
    pub pi_source: crate::pi::discovery::PiSource,
    /// `pi_source = custom` 时的绝对路径。
    #[serde(default)]
    pub pi_path: Option<String>,
    /// 子代理委派开关（docs/06 §6）。开启时给 pi 追加一段
    /// `--append-system-prompt` 策略，并由桥接扩展自动激活 `subagent` 工具。
    ///
    /// **只在「完全权限」档生效**：限制档位的 `--tools` 白名单会把扩展工具整个过滤掉，
    /// `getAllTools()` 里压根没有 `subagent`，开了也没用。这一条已在真机验证过，
    /// 详见 `pi/process.rs::cli_args` 的注释。
    #[serde(default)]
    pub subagent_delegation: bool,
    /// 生成的会话标题最多多少个**字符**（不是字节；docs/03 §2.16）。
    ///
    /// 按字符算是刻意的：DSH 用 UTF-8 字节上限，于是"20 字节"在中文下只有 6 个字。
    /// 用户说的"字数"就是字符数。默认 20（侧栏一行约 220px 放得下）。
    #[serde(default = "default_title_max_chars")]
    pub title_max_chars: u32,
    /// 标题取材：first（只看第一条）/ recent（只看最近几条）/ both（默认）。
    #[serde(default)]
    pub title_source: crate::sessions::title::TitleStrategy,
    /// 生成标题用哪个模型，`"provider/modelId"`。`None` = **跟会话自己的模型**
    /// （会话文件里最后一次 `model_change`）。填了就用它——想用便宜模型刷标题时用。
    #[serde(default)]
    pub title_model: Option<String>,
    /// 生成标题时的思考强度（pi `--thinking`）。`None` = 不传这个开关，
    /// 用 pi 与模型自己的默认档。
    ///
    /// 取值必须是 pi 认的那 7 个（`sessions::title::THINKING_LEVELS`）。
    /// **刻意不用枚举 + serde 校验**：config.json 是可以手改的，而
    /// `perf_config_load` 是"整份反序列化失败就 `unwrap_or_default()`"——
    /// 一个拼错的枚举值会让**所有**设置一起被重置成默认，一个错字毁掉一份配置。
    /// 存字符串、由 `clamp()` 单独丢掉这一个字段，坏影响的半径就只有它自己。
    #[serde(default)]
    pub title_thinking: Option<String>,
    /// 会话预览滚动条放哪边（docs/04 §2.6）：`off` / `left` / `right`（默认）。
    #[serde(default)]
    pub transcript_rail: RailPlacement,
}

fn default_title_max_chars() -> u32 {
    crate::sessions::title::DEFAULT_MAX_CHARS
}

/// 把 `"provider/modelId"` 拆开。只切第一个 `/`——模型 id 里可能含 `/`
/// （`openrouter` 那类 `vendor/model` 形态），provider 名不会含。
pub fn split_model_ref(s: &str) -> Option<(String, String)> {
    let s = s.trim();
    let (p, m) = s.split_once('/')?;
    let (p, m) = (p.trim(), m.trim());
    if p.is_empty() || m.is_empty() {
        None
    } else {
        Some((p.to_string(), m.to_string()))
    }
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
            pi_source: crate::pi::discovery::PiSource::default(),
            pi_path: None,
            subagent_delegation: false,
            title_max_chars: default_title_max_chars(),
            title_source: crate::sessions::title::TitleStrategy::default(),
            title_model: None,
            title_thinking: None,
            transcript_rail: RailPlacement::default(),
        }
    }
}

impl PerfConfig {
    pub fn clamp(&mut self) {
        self.max_workers = self.max_workers.clamp(1, 64);
        // 上限兜底 24h；0 保留为"永不回收"语义
        self.idle_timeout_min = self.idle_timeout_min.min(24 * 60);
        // 标题字数：config.json 是可以手改的，0 会让每个标题都变成空串——
        // 那正好是最坏的结果（空标题覆盖掉用户原来的名字），所以这里兜住。
        self.title_max_chars = self.title_max_chars.clamp(1, 200);
        // 标题模型写成 `provider/modelId` 才有意义；写错了就丢掉（回落"跟会话"），
        // 而不是留着一个每次生成都报错的字符串。
        if let Some(m) = self.title_model.as_deref() {
            let m = m.trim();
            self.title_model = if m.is_empty() || split_model_ref(m).is_none() {
                None
            } else {
                Some(m.to_string())
            };
        }
        // 思考强度：不认识的值**丢掉**（回落"不传 --thinking"）。
        // pi 自己对不认识的档位是"警告 + 静默用默认"，所以留着一个拼错的值
        // 等于每次生成都多一行没人看的警告，行为还跟没设一样。
        if let Some(t) = self.title_thinking.as_deref() {
            let t = t.trim();
            self.title_thinking = if crate::sessions::title::is_valid_thinking(t) {
                Some(t.to_string())
            } else {
                None
            };
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 预览滚动条的三态：默认右、能解析、**认不出的值收回默认**（而不是整份配置失败）。
    #[test]
    fn rail_placement_parses_and_falls_back() {
        assert_eq!(RailPlacement::default(), RailPlacement::Right);
        assert_eq!(RailPlacement::parse("off").unwrap(), RailPlacement::Off);
        assert_eq!(RailPlacement::parse(" left ").unwrap(), RailPlacement::Left);
        assert_eq!(RailPlacement::parse("right").unwrap(), RailPlacement::Right);
        assert!(RailPlacement::parse("nope").is_err(), "写配置时要吵");

        // config.json 里的怪值：整份配置仍要能读出来（只把这一项收回默认）
        let cfg: PerfConfig = serde_json::from_str(r#"{"max_workers":4,"transcript_rail":"wat"}"#).unwrap();
        assert_eq!(cfg.transcript_rail, RailPlacement::Right);
        assert_eq!(cfg.max_workers, 4, "一个坏字段不该把别的设置一起重置");
        let cfg: PerfConfig = serde_json::from_str(r#"{"transcript_rail":"left"}"#).unwrap();
        assert_eq!(cfg.transcript_rail, RailPlacement::Left);
    }

    /// 序列化出来的名字就是界面与 mock 用的那三个字面量。
    #[test]
    fn rail_placement_serializes_as_kebab_strings() {
        let v = serde_json::to_value(PerfConfig::default()).unwrap();
        assert_eq!(v["transcript_rail"], "right");
        for (p, s) in [
            (RailPlacement::Off, "off"),
            (RailPlacement::Left, "left"),
            (RailPlacement::Right, "right"),
        ] {
            assert_eq!(serde_json::to_value(p).unwrap(), s);
            assert_eq!(p.as_str(), s);
        }
    }
}
