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
        return Err(format!("路径越界：{} 不在项目根 {} 内", path.display(), root.display()));
    }
    Ok(())
}

/// 解析符号链接后的边界判定（2026-10-28 审查补）。
///
/// 纯前缀比较挡不住**工作区内的链接指向界外**：Windows 上 `mklink /J` 建目录 junction
/// 无需管理员权限，`ws/link -> C:\Users\x\.ssh` 会让 `ensure_within` 放行 `ws/link/authorized_keys`。
/// 这里把两边都 canonicalize 后再比一次。`path` 必须已存在（两条调用方 `read_dir` / `is_file`
/// 本来就要求存在）；解析失败按越界拒绝（fail-closed）。
pub fn ensure_within_resolved(root: &Path, path: &Path) -> Result<(), String> {
    ensure_within(root, path)?;
    let root_real = std::fs::canonicalize(root).map_err(|e| format!("项目根无法解析: {e}"))?;
    let path_real =
        std::fs::canonicalize(path).map_err(|e| format!("路径无法解析（不存在或无权限），按越界拒绝: {e}"))?;
    if !path_real.starts_with(&root_real) {
        return Err(format!(
            "路径越界（符号链接指向项目根之外）：{} 不在项目根 {} 内",
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
///
/// **不做 canonicalize**：Windows 上它会给路径加 `\\?\` 前缀，而调用方随后的
/// `ensure_within` 字面前缀比较用的是原始形态的 path——两侧形态不一致会全部误拒。
/// 符号链接穿透由 [`ensure_within_resolved`] 在内部对**两边**同时 canonicalize 完成
/// （两侧同为 verbatim 形态，比较自洽）；"root 是否已打开标签页的 cwd"的锚定核对
/// 用 `paths::same_path`（同样内部 canonicalize），也不依赖这里的返回形态。
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

    /// 符号链接逃逸：前缀比较放行、真实位置在界外 → 必须拒绝。
    /// POSIX 专属（Windows 建符号链接默认需要特权；junction 的同类风险由同一段
    /// canonicalize 逻辑覆盖，CI 的 Windows job 至少跑到"不存在的路径 fail-closed"那条）。
    #[cfg(unix)]
    #[test]
    fn resolved_check_blocks_symlink_escape() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        let secret = tmp.path().join("secret");
        std::fs::create_dir_all(&ws).unwrap();
        std::fs::create_dir_all(&secret).unwrap();
        std::fs::write(secret.join("k.txt"), "k").unwrap();
        std::os::unix::fs::symlink(&secret, ws.join("link")).unwrap();

        // 字面前缀在界内（ensure_within 放行），真实位置在界外（resolved 必须拦）
        let target = ws.join("link").join("k.txt");
        assert!(ensure_within(&ws, &target).is_ok());
        let err = ensure_within_resolved(&ws, &target).unwrap_err();
        assert!(err.contains("符号链接"), "要点名链接逃逸：{err}");
    }

    #[test]
    fn resolved_check_fails_closed_on_unresolvable_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let ws = tmp.path().join("ws");
        std::fs::create_dir_all(&ws).unwrap();
        let ghost = ws.join("does-not-exist.txt");
        assert!(ensure_within_resolved(&ws, &ghost).is_err(), "解析失败的路径不得放行");
    }
}
