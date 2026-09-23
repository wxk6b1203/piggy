//! 权限档位（docs/11 §2.2 的落地）：pi **没有**权限模型，只有「工具白名单 + 扩展钩子」两个原语，
//! 因此档位由这两件事组合而成，且都必须在 **spawn 时**决定（`--tools` / `-e` 都是 CLI 参数，
//! RPC 没有运行期改工具的接口——见 packages/coding-agent/src/modes/rpc/rpc-mode.ts 的 case 列表）。
//!
//! | 档位 | `--tools` | 守卫扩展 | 语义 |
//! |------|-----------|----------|------|
//! | 仅可查看 | `read,grep,find,ls` | 不需要 | 根本没有写/shell 工具 |
//! | 工作区内修改 | `read,grep,find,ls,write,edit` | 注入 | 无 shell；写工具被路径边界拦截 |
//! | 完全权限 | 不传（交给 pi 自身默认） | 不需要 | 含 bash/powershell 与插件工具 |
//!
//! ## 两个必须记住的事实
//! 1. pi 的 `write`/`edit` **不做工作区边界检查**（`path-utils.ts` 的 `resolveToCwd` 只展开 `~`），
//!    所以「工作区内修改」不能只靠 `--tools` 成立，必须配 `resources/piggy-guard.js`。
//! 2. 「完全权限」**不传** `--tools`：一旦传了显式白名单，pi 的插件/自定义工具会被一并排除，
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

    /// 是否需要注入路径守卫扩展（只有允许写文件、又要求边界时才是）。
    pub fn needs_path_guard(self) -> bool {
        matches!(self, Self::Workspace)
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim() {
            "read-only" | "readonly" => Ok(Self::ReadOnly),
            "workspace" => Ok(Self::Workspace),
            "full" => Ok(Self::Full),
            other => Err(format!(
                "未知权限档位 {other:?}（可选：read-only / workspace / full）"
            )),
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
    fn only_workspace_mode_needs_the_path_guard() {
        assert!(PermissionMode::Workspace.needs_path_guard());
        // 只读档没有写工具可拦；完全权限档刻意不拦
        assert!(!PermissionMode::ReadOnly.needs_path_guard());
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
    fn default_is_workspace() {
        assert_eq!(PermissionMode::default(), PermissionMode::Workspace);
    }
}
