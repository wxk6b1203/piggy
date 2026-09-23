//! 文件访问守卫（M4：资源浏览器 + 快捷编辑，00 NG4、docs/04 §1.5）。
//! 边界：只能访问显式项目根（活动会话 cwd）子树；写路径额外限制大小与 mtime 冲突检测。

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

pub const MAX_EDIT_BYTES: u64 = 1024 * 1024;

/// path 必须位于 root 子树内（规范化到分量级，不含 `..` 逃逸）。
pub fn ensure_within(root: &Path, path: &Path) -> Result<(), String> {
    if !root.is_absolute() {
        return Err("项目根不是绝对路径".into());
    }
    if !path.is_absolute() {
        return Err("路径不是绝对路径".into());
    }
    if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("路径包含 `..`".into());
    }
    if !path.starts_with(root) {
        return Err(format!(
            "路径越界：{} 不在项目根 {} 内",
            path.display(),
            root.display()
        ));
    }
    Ok(())
}

/// mtime 冲突判定（快捷编辑的外部变更警示）：base 与当前不一致 → 冲突。
pub fn mtime_conflicted(current_modified: std::io::Result<std::time::SystemTime>, base_mtime_ms: Option<u64>) -> bool {
    let current_ms = current_modified
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64);
    match (base_mtime_ms, current_ms) {
        (Some(base), Some(cur)) => base != cur,
        _ => true, // 无基线或读不到 mtime：一律视为冲突（保守）
    }
}

/// 项目根白名单校验：root 本身必须存在且为目录。
pub fn validate_root(root: &Path) -> Result<PathBuf, String> {
    if !root.is_dir() {
        return Err(format!("项目根不存在或不是目录: {}", root.display()));
    }
    Ok(root.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn within_accepts_subtree_and_rejects_outside() {
        let root = Path::new("/proj");
        assert!(ensure_within(root, Path::new("/proj/src/a.ts")).is_ok());
        assert!(ensure_within(root, Path::new("/proj")).is_ok());
        assert!(ensure_within(root, Path::new("/etc/passwd")).is_err());
        assert!(ensure_within(root, Path::new("/projectile/x")).is_err()); // 前缀不能碰瓷
    }

    #[test]
    fn parent_dir_components_rejected() {
        let root = Path::new("/proj");
        assert!(ensure_within(root, Path::new("/proj/../secrets")).is_err());
    }

    #[test]
    fn relative_paths_rejected() {
        assert!(ensure_within(Path::new("/proj"), Path::new("src/a.ts")).is_err());
        assert!(ensure_within(Path::new("rel-root"), Path::new("/x")).is_err());
    }

    #[test]
    fn mtime_conflict_semantics() {
        let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(1000);
        assert!(!mtime_conflicted(Ok(t), Some(1000)));
        assert!(mtime_conflicted(Ok(t), Some(999))); // 外部已改
        assert!(mtime_conflicted(Ok(t), None)); // 无基线 → 保守冲突
        assert!(mtime_conflicted(Err(std::io::Error::other("gone")), Some(1000)));
    }
}
