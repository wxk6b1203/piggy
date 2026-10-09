//! 随包分发的 pi 扩展资源定位（权限守卫、piggy-bridge）。
//!
//! Piggy 通过 `pi --extension <file>` 注入自带扩展。这些文件既是仓库里的源码
//! （`apps/desktop/src-tauri/resources/`），也是打包后的 resource：
//!
//! ```text
//! macOS → Contents/Resources/resources/<name>
//! 其他  → <exe 同级>/resources/<name>
//! ```
//!
//! 因此定位顺序固定为「resource_dir 两级候选 → 源码树兜底」。
//! 单独成模块的原因：2026-09-23 的一次改动把这段探测逻辑写进了 `permission.rs`，
//! 结果桥接扩展只能从权限模块里找——职责错位会让下一个扩展无处安放。

use std::path::{Path, PathBuf};

/// 在 resource_dir 与源码树里依次寻找 `filename`。
///
/// `resource_dir` 为 None（拿不到 Tauri 路径）或文件缺失时回落到源码树；
/// 都找不到返回 None——**由调用方决定缺失是错误还是可降级**。
pub fn extension_script(resource_dir: Option<&Path>, filename: &str) -> Option<PathBuf> {
    if let Some(rd) = resource_dir {
        for cand in [rd.join("resources").join(filename), rd.join(filename)] {
            if cand.is_file() {
                return Some(cand);
            }
        }
    }
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join(filename);
    dev.is_file().then_some(dev)
}

/// Piggy **捆绑的 pi 插件**目录（`resources/pi-plugins/<name>/`）。
///
/// 与上面两个脚本的区别：那些是 Piggy 自己的基础设施（守卫/桥接），这里是**给模型用的功能**
/// （结构化提问、计划模式……），每个是一个普通 pi 扩展目录，以 `pi --extension <dir>` 注入。
///
/// 为什么捆绑而不是让用户 `pi install`：目标机器上很可能**没有 node/npm**，而 pi 的包管理器
/// 是 spawn 系统 `npm` 来装的（`package-manager.js`）。捆绑 + `-e` 不需要任何包管理器。
///
/// @param resource_dir - Tauri 的资源目录（拿不到时回落源码树）
/// @param name - 插件目录名（例如 `pi-ask`）
/// @returns 目录路径；不存在返回 None（由调用方决定是警告还是忽略）
pub fn bundled_plugin_dir(resource_dir: Option<&Path>, name: &str) -> Option<PathBuf> {
    bundled_plugin_dir_with_origin(resource_dir, name).map(|(p, _)| p)
}

/// 这份插件目录是从哪儿找到的。
///
/// 为什么要把它显式报出来（2026-10-09）：第三个候选是**编译期烧进二进制的构建机绝对路径**
/// （`env!("CARGO_MANIFEST_DIR")`）。于是"打包漏登记 `pi-plugins`"这个失败在**构建机上
/// 直接跑那个 .app** 时会看起来完全正常 —— 换台机器才消失。
/// 界面必须能说出"这一份是从源码树来的"，否则这个坑会一直骗过手工验收。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PluginOrigin {
    /// `<resource_dir>/resources/pi-plugins/<name>`（打包后的正式落点）
    ResourceDir,
    /// `<resource_dir>/pi-plugins/<name>`（扁平布局，兼容早期打包）
    ResourceDirFlat,
    /// 仓库源码树（**开发态**；打包产物里出现它 = `bundle.resources` 漏登记了）
    SourceTree,
}

impl PluginOrigin {
    /// 给界面看的一句话。
    pub fn label(self) -> &'static str {
        match self {
            Self::ResourceDir | Self::ResourceDirFlat => "随包分发",
            Self::SourceTree => "开发态（仓库源码树）",
        }
    }
}

/// 同上，但连"从哪儿找到的"一起返回。
pub fn bundled_plugin_dir_with_origin(resource_dir: Option<&Path>, name: &str) -> Option<(PathBuf, PluginOrigin)> {
    // 目录判定用 `is_dir`（上面两个是单文件脚本，用 is_file）
    let candidates = [
        resource_dir.map(|rd| {
            (
                rd.join("resources").join("pi-plugins").join(name),
                PluginOrigin::ResourceDir,
            )
        }),
        resource_dir.map(|rd| (rd.join("pi-plugins").join(name), PluginOrigin::ResourceDirFlat)),
        Some((
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("pi-plugins")
                .join(name),
            PluginOrigin::SourceTree,
        )),
    ];
    candidates.into_iter().flatten().find(|(p, _)| p.is_dir())
}

/// 权限守卫扩展（`piggy-guard.js`）。缺失 → 「工作区内修改」档拒绝启动（fail-closed）。
pub fn guard_script_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    extension_script(resource_dir, "piggy-guard.js")
}

/// 桥接扩展（`piggy-bridge.js`，docs/06 §4）。**可选**：缺失只是没有 Fleet 数据面，
/// 不影响会话本身，所以调用方拿到 None 应当继续而不是报错。
pub fn bridge_script_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    extension_script(resource_dir, "piggy-bridge.js")
}

/// 子代理委派策略（`piggy-subagent-policy.md`，docs/06 §6）。
///
/// 它经 `pi --append-system-prompt <path>` 注入（pi 的 `resolvePromptInput` 对存在的路径
/// 读文件内容，对不存在的则当字面量文本——所以**必须传路径且必须存在**，否则整段路径
/// 字符串会被当成提示词塞进去）。
///
/// 缺失语义与守卫脚本一致：**调用方应当报错而不是静默继续**。开关打开却没注入策略，
/// 用户会以为子代理委派已启用，实际什么都没发生——这正是本项目最不能接受的那类失败。
pub fn subagent_policy_path(resource_dir: Option<&Path>) -> Option<PathBuf> {
    extension_script(resource_dir, "piggy-subagent-policy.md")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_tree_fallback_finds_the_bundled_scripts() {
        // 仓库里这几个文件都是提交过的资源，开发态必须能找到（找不到就等于功能静默消失）
        for name in ["piggy-guard.js", "piggy-bridge.js", "piggy-subagent-policy.md"] {
            let p = extension_script(None, name).unwrap_or_else(|| panic!("源码树里找不到 {name}"));
            assert!(p.is_file(), "{name} 应存在: {}", p.display());
        }
    }

    #[test]
    fn resource_dir_wins_over_source_tree() {
        let tmp = tempfile::tempdir().unwrap();
        let packaged = tmp.path().join("resources");
        std::fs::create_dir_all(&packaged).unwrap();
        let fake = packaged.join("piggy-bridge.js");
        std::fs::write(&fake, "// packaged").unwrap();
        let found = extension_script(Some(tmp.path()), "piggy-bridge.js").unwrap();
        assert_eq!(found, fake, "打包后必须优先用 resource_dir 里的那份");
    }

    #[test]
    fn flat_resource_dir_layout_is_also_supported() {
        let tmp = tempfile::tempdir().unwrap();
        let flat = tmp.path().join("piggy-guard.js");
        std::fs::write(&flat, "// flat").unwrap();
        assert_eq!(extension_script(Some(tmp.path()), "piggy-guard.js").unwrap(), flat);
    }

    #[test]
    fn missing_script_returns_none_instead_of_a_bogus_path() {
        let tmp = tempfile::tempdir().unwrap();
        // resource_dir 里没有、源码树里也没有的名字
        assert!(extension_script(Some(tmp.path()), "no-such-extension.js").is_none());
    }
}
