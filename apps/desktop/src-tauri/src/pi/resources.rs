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
    let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(filename);
    dev.is_file().then_some(dev)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_tree_fallback_finds_the_bundled_scripts() {
        // 仓库里这两个脚本是提交过的资源，开发态必须能找到（找不到就等于功能静默消失）
        for name in ["piggy-guard.js", "piggy-bridge.js"] {
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
