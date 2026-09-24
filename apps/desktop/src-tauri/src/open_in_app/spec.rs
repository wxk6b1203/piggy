//! 「打开方式」的运行时形态（`catalog.rs` 是静态表，这里是解析产物）。
//!
//! 与 DSH 的对应：`resolver.ts` 的 `resolved.launch` / `fallbackLaunch` / `icon`
//! 三个字段在这里是 `Resolved` 的三个字段，语义逐条对齐。

use std::path::PathBuf;

/// 解析出来的启动方式。
///
/// **目录不在里面**：解析结果按 host 进程缓存一次、被所有工作区共用，
/// 所以 `{path}` 留在参数里，由 `host::launch_detached` 在真正启动那一刻代入
/// （DSH `launchArgs` 同一个位置、同一个语义）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchSpec {
    /// 系统 shell 的 open 动词（目录由启动时决定）。
    ShellOpen,
    /// argv 直接执行。`env` 是**额外**注入的环境（在洗净后的父环境之上叠加）。
    Argv {
        command: String,
        args: Vec<String>,
        env: Vec<(String, String)>,
    },
}

impl LaunchSpec {
    /// 用于日志/报错的一行描述。
    pub fn describe(&self) -> String {
        match self {
            LaunchSpec::ShellOpen => "shell-open".to_string(),
            LaunchSpec::Argv { command, args, .. } => {
                if args.is_empty() {
                    command.clone()
                } else {
                    format!("{command} {}", args.join(" "))
                }
            }
        }
    }
}

/// 图标来源。macOS 用 bundle（`.icns`），Linux 用 desktop entry 的主题图标；
/// Windows 目前**没有**实现提取（见模块头注释与 docs/15）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IconSource {
    /// `.app` bundle：`plutil` 读 `CFBundleIconFile` → `sips` 转 PNG。
    AppBundle(PathBuf),
    /// Linux：desktop entry id（`Icon=` 键指向主题里的图）。
    Desktop(String),
    /// 可执行文件本身（Windows；当前不实现提取）。
    Executable(PathBuf),
}

/// 一个条目的解析结果：主启动方式 + 可选回退 + 图标来源。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
    pub id: &'static str,
    pub launch: LaunchSpec,
    /// 主启动方式在观察窗内失败后尝试的第二种方式（目前只有 macOS 的 Xcode：`xed` → `open -a`）。
    pub fallback: Option<LaunchSpec>,
    pub icon: Option<IconSource>,
}

/// 一次启动尝试的结局。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchOutcome {
    /// 已交出：进程仍在运行（或退出码 0）即算成功，不再跟踪。
    Launched,
    /// 可执行文件不在了 —— 说明这次解析过期，调用方应重新解析这一条。
    Missing,
    /// 其它失败（spawn 出错、观察窗内非零退出）。
    Failed(String),
}
