//! pi 二进制定位与版本门禁（docs/02 §2.1、03 §2.1）

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, serde::Serialize)]
pub struct PiBinary {
    pub path: PathBuf,
    pub version: String,
}

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("pi 二进制未找到（设置 piPath / PI_BIN / PATH）")]
    NotFound,
    #[error("pi --version 失败: {0}")]
    VersionCheckFailed(String),
}

/// 发现顺序（docs/02 §2.1，08 §7.1）：显式路径 → `PI_BIN` → 内置（捆绑 standalone）→ PATH。
pub fn discover(override_path: Option<&Path>, builtin: Option<&Path>) -> Result<PiBinary, DiscoveryError> {
    let path = match override_path {
        Some(p) => p.to_path_buf(),
        None => match std::env::var_os("PI_BIN").map(PathBuf::from) {
            Some(p) => p,
            None => match builtin.filter(|b| b.is_file()).map(PathBuf::from) {
                Some(b) => b,
                None => which_pi(),
            },
        },
    };
    if !path.exists() {
        return Err(DiscoveryError::NotFound);
    }
    let out = Command::new(&path)
        .arg("--version")
        .output()
        .map_err(|e| DiscoveryError::VersionCheckFailed(e.to_string()))?;
    if !out.status.success() {
        return Err(DiscoveryError::VersionCheckFailed(
            String::from_utf8_lossy(&out.stderr).trim().to_string(),
        ));
    }
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(PiBinary { path, version })
}

fn which_pi() -> PathBuf {
    let Some(paths) = std::env::var_os("PATH") else {
        return probe_well_known().unwrap_or_else(|| PathBuf::from("pi"));
    };
    for dir in std::env::split_paths(&paths) {
        for name in ["pi", "pi.exe", "pi.cmd"] {
            let cand = dir.join(name);
            if cand.is_file() {
                return cand;
            }
        }
    }
    // PATH 未命中（GUI 从 Finder 启动时 PATH 极简）：探测常见安装位置
    probe_well_known().unwrap_or_else(|| PathBuf::from("pi"))
}

/// 常见安装位置（pi.dev 安装脚本 / pnpm / cargo 风格目录）。
fn probe_well_known() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from)?;
    let candidates = [
        home.join(".local/bin/pi"),
        PathBuf::from("/usr/local/bin/pi"),
        PathBuf::from("/opt/homebrew/bin/pi"),
        home.join("Library/pnpm/bin/pi"),
        home.join(".cargo/bin/pi"),
    ];
    candidates.into_iter().find(|c| c.is_file())
}
