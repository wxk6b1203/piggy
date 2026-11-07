//! 权限档位（docs/11 §2.2 的落地）：pi **没有**权限模型，只有「工具白名单 + 扩展钩子」两个原语，
//! 因此档位由这两件事组合而成，且都必须在 **spawn 时**决定（`--tools` / `-e` 都是 CLI 参数，
//! RPC 没有运行期改工具的接口——见 packages/coding-agent/src/modes/rpc/rpc-mode.ts 的 case 列表）。
//!
//! | 档位 | `--tools` | 守卫扩展 | 语义 |
//! |------|-----------|----------|------|
//! | 仅可查看 | `read,grep,find,ls` | 注入 | 没有写/shell 工具；读工具拦敏感目录（`~/.pi` 存 API key 明文，见 guard 的读侧策略） |
//! | 工作区内修改 | `read,grep,find,ls,write,edit` | 注入 | 无 shell；写工具被路径边界拦截，读工具拦敏感目录 |
//! | 完全权限 | 不传（交给 pi 自身默认） | 不需要 | 含 bash/powershell 与插件工具 |
//!
//! ## 两个必须记住的事实
//! 1. pi 的 `write`/`edit` **不做工作区边界检查**（`path-utils.ts` 的 `resolveToCwd` 只展开 `~`），
//!    所以「工作区内修改」不能只靠 `--tools` 成立，必须配 `resources/piggy-guard.js`。
//! 2. pi 的 `read`/`grep`/`find`/`ls` 同样接受绝对路径与 `~` 展开——「仅可查看」若不注入守卫，
//!    一次 prompt injection 就能把 `~/.pi/agent/auth.json` 读进模型上下文（2026-10-28 审查发现），
//!    所以两个限制档都注入守卫，只是拦截内容不同（写边界 / 读敏感目录）。
//! 3. 「完全权限」**不传** `--tools`：一旦传了显式白名单，pi 的插件/自定义工具会被一并排除，
//!    而这正是自定义 pi 打包场景要保住的东西。不传 = 不限制。

use std::path::{Path, PathBuf};

/// pi 内置工具里"只读"的那批（packages/coding-agent/src/core/tools/*.ts 的 `name` 字段）。
const READ_ONLY_TOOLS: &str = "read,grep,find,ls";
/// 加上写文件工具；**刻意不含** `bash` / `powershell`——shell 可以绕过任何路径守卫。
const WORKSPACE_TOOLS: &str = "read,grep,find,ls,write,edit";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    /// 仅可查看：只给只读工具。
    ReadOnly,
    /// 工作区内修改（默认）：可写文件，但被守卫扩展限制在会话 cwd 内，且无 shell。
    #[default]
    Workspace,
    /// 完全权限：不注入任何限制。
    Full,
}

impl PermissionMode {
    /// 前端与事件里使用的稳定标识（kebab-case，与 serde 表示一致）。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ReadOnly => "read-only",
            Self::Workspace => "workspace",
            Self::Full => "full",
        }
    }

    /// 人类可读档位名（与前端 `PERMISSION_MODES` 文案保持一字不差）。
    pub fn label(self) -> &'static str {
        match self {
            Self::ReadOnly => "仅可查看",
            Self::Workspace => "工作区内修改",
            Self::Full => "完全权限",
        }
    }

    /// `--tools` 的值；`None` = 不传该参数（= 不限制）。
    pub fn tool_allowlist(self) -> Option<&'static str> {
        match self {
            Self::ReadOnly => Some(READ_ONLY_TOOLS),
            Self::Workspace => Some(WORKSPACE_TOOLS),
            Self::Full => None,
        }
    }

    /// 是否需要注入路径守卫扩展。两个限制档都需要：
    /// 「工作区内修改」靠它拦写边界，「仅可查看」靠它拦读敏感目录（`~/.pi` 等）。
    /// 「完全权限」刻意不注入 = 不限制。
    pub fn needs_path_guard(self) -> bool {
        matches!(self, Self::ReadOnly | Self::Workspace)
    }

    /// 运行期"声明给模型的工具集"：`None` = 不限制（完全权限）。
    ///
    /// 与 [`Self::tool_allowlist`] 的分工（docs/17 §2.1）：
    /// - `tool_allowlist` 是**历史**的 spawn 期白名单，仍被 bridge 用来推导子代理 ceiling；
    /// - 这里算的是 `pi.setActiveTools()` 的入参 —— 含注入插件申报的工具与委派工具。
    ///
    /// 为什么不再用 `--tools`：pi 的 `--tools` 在**注册期**过滤（`_isAllowedTool` 直接
    /// 把工具从 registry 里删掉），被过滤的工具事后 `setActiveTools()` 也点不亮。
    /// 要支持运行期升档，只能"全注册 + 运行期收窄"。
    pub fn runtime_tools(&self, extra: &[String]) -> Option<Vec<String>> {
        let base = self.tool_allowlist()?;
        let mut names: Vec<String> = base.split(',').map(|s| s.trim().to_string()).collect();
        for name in extra {
            if !names.iter().any(|n| n == name) {
                names.push(name.clone());
            }
        }
        Some(names)
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim() {
            "read-only" | "readonly" => Ok(Self::ReadOnly),
            "workspace" => Ok(Self::Workspace),
            "full" => Ok(Self::Full),
            other => Err(format!("未知权限档位 {other:?}（可选：read-only / workspace / full）")),
        }
    }
}

/// 守卫扩展脚本定位：打包后优先用 resource_dir，开发时回落到源码树。
///
/// 打包布局（tauri `bundle.resources` 保留相对路径）：
///   macOS  → Contents/Resources/resources/piggy-guard.js
///   其他   → <exe 同级>/resources/piggy-guard.js
/// 探测逻辑见 `pi/resources.rs::extension_script`（与 piggy-bridge 共用同一套）。
pub fn guard_script_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    crate::pi::resources::guard_script_path(resource_dir)
}

/// spawn 与运行期切档**共用**的工具集计算（单一真相）。
///
/// @param plugin_dirs 本次注入的插件目录（`bundled_extensions`，已按配置过滤）
/// @param delegation_tools 委派打开时要加进来的工具名；关闭时传空
pub fn active_tools_for(
    mode: PermissionMode,
    plugin_dirs: &[PathBuf],
    delegation_tools: &[&str],
) -> Option<Vec<String>> {
    let mut extra = crate::pi::plugins::plugin_tools_for(plugin_dirs);
    for name in delegation_tools {
        extra.push((*name).to_string());
    }
    mode.runtime_tools(&extra)
}

/* ---------------- 运行期档位文件（docs/17 §2.1） ---------------- */

/// 档位文件的内容：`all` 为真时守卫**不调用** `setActiveTools`（保持 pi 默认全集）。
///
/// 不用 `Option<Vec<String>>` 直接序列化，是因为守卫（JS）要一个稳定的判别式：
/// `all: true` 比 `activeTools: null` 更难写错。
pub fn mode_file_json(mode: PermissionMode, active: Option<&[String]>) -> serde_json::Value {
    serde_json::json!({
        "mode": mode.as_str(),
        "all": active.is_none(),
        "activeTools": active.map(|v| v.to_vec()).unwrap_or_default(),
    })
}

/// 原子写档位文件（同目录 tmp + rename，与 `config/app.rs` 的 layout 写入同一手法）。
pub fn write_mode_file(path: &Path, mode: PermissionMode, active: Option<&[String]>) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let body = serde_json::to_vec(&mode_file_json(mode, active))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)
}

/// 这个工作区/机器上有没有配置 MCP 服务器。
///
/// 只用于一个判断：从限制档切到「完全权限」时，要不要为了**注册 MCP 工具**重启 worker
/// （限制档 spawn 时带了 `--no-mcp`，MCP 工具根本没进 registry，`setActiveTools` 点不亮）。
/// 没配置 MCP 的机器（大多数）不必重启——这是运行期切档能覆盖的常见情形。
///
/// 判据与 pi 一致：`<agent_dir>/mcp.json` 与 `<cwd>/.pi/mcp.json` 的 `mcpServers`。
/// 解析失败按"有配置"处理（fail-safe：宁可多重启一次，也不要静默少给 MCP 工具）。
pub fn mcp_configured(cwd: &Path) -> bool {
    let agent = crate::config::paths::agent_dir().join("mcp.json");
    let project = cwd.join(".pi").join("mcp.json");
    [agent, project].iter().any(|p| mcp_file_has_servers(p))
}

fn mcp_file_has_servers(path: &Path) -> bool {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return false; // 文件不存在 = 没配置
    };
    match serde_json::from_str::<serde_json::Value>(&raw) {
        Ok(v) => v
            .get("mcpServers")
            .and_then(|s| s.as_object())
            .is_some_and(|o| !o.is_empty()),
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allowlists_match_the_documented_matrix() {
        assert_eq!(PermissionMode::ReadOnly.tool_allowlist(), Some("read,grep,find,ls"));
        assert_eq!(
            PermissionMode::Workspace.tool_allowlist(),
            Some("read,grep,find,ls,write,edit")
        );
        // 完全权限必须"不传"，否则插件工具会被一起排除
        assert_eq!(PermissionMode::Full.tool_allowlist(), None);
    }

    #[test]
    fn restricted_modes_never_expose_shell() {
        for m in [PermissionMode::ReadOnly, PermissionMode::Workspace] {
            let list = m.tool_allowlist().expect("限制档必须有白名单");
            assert!(!list.contains("bash"), "{m:?} 不应包含 bash");
            assert!(!list.contains("powershell"), "{m:?} 不应包含 powershell");
        }
    }

    #[test]
    fn read_only_mode_has_no_mutators() {
        let list = PermissionMode::ReadOnly.tool_allowlist().unwrap();
        for mutator in ["write", "edit"] {
            assert!(!list.split(',').any(|t| t == mutator), "仅可查看不应有 {mutator}");
        }
    }

    #[test]
    fn restricted_modes_need_the_path_guard() {
        assert!(PermissionMode::ReadOnly.needs_path_guard(), "仅可查看也要拦读敏感目录");
        assert!(PermissionMode::Workspace.needs_path_guard());
        // 完全权限档刻意不拦（不限制就是它的语义）
        assert!(!PermissionMode::Full.needs_path_guard());
    }

    #[test]
    fn round_trips_through_serde_and_parse() {
        for m in [
            PermissionMode::ReadOnly,
            PermissionMode::Workspace,
            PermissionMode::Full,
        ] {
            let json = serde_json::to_string(&m).unwrap();
            assert_eq!(json, format!("\"{}\"", m.as_str()));
            assert_eq!(serde_json::from_str::<PermissionMode>(&json).unwrap(), m);
            assert_eq!(PermissionMode::parse(m.as_str()).unwrap(), m);
        }
        assert!(PermissionMode::parse("sandbox").is_err());
    }

    #[test]
    fn runtime_tools_merge_extras_only_for_restricted_modes() {
        let extra = vec!["ask_user_question".to_string()];
        assert_eq!(PermissionMode::Full.runtime_tools(&extra), None);
        let ro = PermissionMode::ReadOnly.runtime_tools(&extra).unwrap();
        assert_eq!(ro, vec!["read", "grep", "find", "ls", "ask_user_question"]);
        // 去重：同一名字只出现一次
        let dup = PermissionMode::ReadOnly
            .runtime_tools(&["read".to_string(), "read".to_string()])
            .unwrap();
        assert_eq!(dup.iter().filter(|n| *n == "read").count(), 1);
    }

    #[test]
    fn mode_file_is_written_atomically_and_round_trips() {
        let dir = std::env::temp_dir().join(format!("piggy-mode-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("tab-1.json");
        let active = vec!["read".to_string(), "grep".to_string()];
        write_mode_file(&path, PermissionMode::ReadOnly, Some(&active)).unwrap();
        let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["mode"], "read-only");
        assert_eq!(raw["all"], false);
        assert_eq!(raw["activeTools"], serde_json::json!(active));
        // 原子写：不留下 tmp 文件
        assert!(!path.with_extension("json.tmp").exists());

        write_mode_file(&path, PermissionMode::Full, None).unwrap();
        let raw: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(raw["mode"], "full");
        assert_eq!(raw["all"], true);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mcp_config_detection_is_fail_safe() {
        let dir = std::env::temp_dir().join(format!("piggy-mcp-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("mcp.json");

        assert!(!super::mcp_file_has_servers(&file), "文件不存在 = 没配");
        std::fs::write(&file, r#"{"mcpServers":{}}"#).unwrap();
        assert!(!super::mcp_file_has_servers(&file), "空表 = 没配");
        std::fs::write(&file, r#"{"mcpServers":{"docs":{"command":"x"}}}"#).unwrap();
        assert!(super::mcp_file_has_servers(&file));
        // 坏 JSON：按"有配置"处理（宁可多重启一次，不要静默少给 MCP 工具）
        std::fs::write(&file, "{").unwrap();
        assert!(super::mcp_file_has_servers(&file));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn default_is_workspace() {
        assert_eq!(PermissionMode::default(), PermissionMode::Workspace);
    }
}
