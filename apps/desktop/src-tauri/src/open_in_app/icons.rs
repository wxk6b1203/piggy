//! 图标提取：把"这台机器上真实存在的应用图标"变成可以直接塞进 `<img src>` 的 PNG。
//!
//! 移植 DSH `icons.ts` 的三平台策略，**但 Windows 那一支没做**：
//! - macOS：`.app` bundle 的 `.icns` → `plutil` 读 `CFBundleIconFile` → `sips` 转 128px PNG（已实测）；
//! - Linux：desktop entry 的 `Icon=` 键 → hicolor 主题 / pixmaps（纯文件查找，可测）；
//! - Windows：DSH 用生成的 PowerShell 脚本调 `ExtractAssociatedIcon`。这条**在 macOS 上无法验证**，
//!   与其塞一段没人跑过的脚本，不如老实返回 None —— 前端会退化成通用图标（视觉上不残废）。
//!   缺口记在 docs/15。
//!
//! 任何一步失败都返回 None（对应 DSH 图标路由的 404），**不报错**：图标拿不到不该让按钮消失。

use super::host::{Facts, Host};
use super::resolver::{find_desktop_entry, xdg_data_directories};
use super::spec::IconSource;
use std::path::Path;
use std::time::Duration;

/// hicolor 主题里按尺寸从大到小找（按钮只渲染 15-18 CSS px，但 Retina 要 2x）。
const HICOLOR_SIZES: [&str; 6] = ["512x512", "256x256", "128x128", "64x64", "48x48", "32x32"];

/// 提取一个应用的图标字节。`None` = 这台机器上拿不到（前端画通用图标）。
pub fn icon_png(
    host: &dyn Host,
    facts: &Facts,
    source: &IconSource,
    timeout: Duration,
) -> Option<Vec<u8>> {
    match source {
        IconSource::AppBundle(bundle) => bundle_icon_png(host, bundle, timeout),
        IconSource::Desktop(desktop_id) => linux_icon_bytes(host, facts, desktop_id),
        // Windows：未实现（模块头注释）
        IconSource::Executable(_) => None,
    }
}

/* ------------------------------- macOS ------------------------------- */

/// bundle 的图标：`Info.plist` 的 `CFBundleIconFile` → `Contents/Resources/*.icns` → `sips` 转 PNG。
fn bundle_icon_png(host: &dyn Host, bundle: &Path, timeout: Duration) -> Option<Vec<u8>> {
    let resources = bundle.join("Contents").join("Resources");
    let declared = host
        .run(
            "plutil",
            &[
                "-extract",
                "CFBundleIconFile",
                "raw",
                "-o",
                "-",
                &bundle.join("Contents").join("Info.plist").to_string_lossy(),
            ],
            timeout,
        )
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let icon_name = match declared {
        Some(name) => {
            if name.ends_with(".icns") {
                name
            } else {
                format!("{name}.icns")
            }
        }
        // Info.plist 没声明（或 plutil 读不动）→ 退到 Resources 里第一个 .icns
        None => host
            .read_dir(&resources)?
            .into_iter()
            .find(|e| e.ends_with(".icns"))?,
    };
    let icns = resources.join(icon_name);
    if !host.is_file(&icns) {
        return None; // plist 声明的图标不在磁盘上
    }

    let work = std::env::temp_dir().join(format!(
        "piggy-open-in-app-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&work).ok()?;
    let out = work.join("icon.png");
    let converted = host.run(
        "sips",
        &[
            "-s",
            "format",
            "png",
            "-Z",
            "128",
            &icns.to_string_lossy(),
            "--out",
            &out.to_string_lossy(),
        ],
        timeout,
    );
    let bytes = converted.and_then(|_| std::fs::read(&out).ok());
    let _ = std::fs::remove_dir_all(&work);
    bytes
}

/* ------------------------------- Linux ------------------------------- */

/// desktop entry 的 `Icon=` → 主题图标文件字节。
fn linux_icon_bytes(host: &dyn Host, facts: &Facts, desktop_id: &str) -> Option<Vec<u8>> {
    let entry = find_desktop_entry(host, facts, desktop_id)?;
    let icon = entry.icon.filter(|s| !s.is_empty())?;
    theme_icon_bytes(host, facts, &icon)
}

/// 图标名（或绝对路径）→ 图标文件字节。「打开方式」的文件关联列表也用这一条。
pub fn theme_icon_bytes(host: &dyn Host, facts: &Facts, icon: &str) -> Option<Vec<u8>> {
    if Path::new(icon).is_absolute() {
        return read_icon_file(host, Path::new(icon));
    }
    for dir in xdg_data_directories(facts) {
        for size in HICOLOR_SIZES {
            for ext in ["png", "svg"] {
                let p = dir
                    .join("icons").join("hicolor")
                    .join(size)
                    .join("apps")
                    .join(format!("{icon}.{ext}"));
                if let Some(bytes) = read_icon_file(host, &p) {
                    return Some(bytes);
                }
            }
        }
        let scalable = dir
            .join("icons").join("hicolor").join("scalable").join("apps")
            .join(format!("{icon}.svg"));
        if let Some(bytes) = read_icon_file(host, &scalable) {
            return Some(bytes);
        }
        for ext in ["png", "svg"] {
            let pixmap = dir.join("pixmaps").join(format!("{icon}.{ext}"));
            if let Some(bytes) = read_icon_file(host, &pixmap) {
                return Some(bytes);
            }
        }
    }
    None
}

fn read_icon_file(host: &dyn Host, path: &Path) -> Option<Vec<u8>> {
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    if ext != "png" && ext != "svg" {
        return None; // 不提供浏览器认不出的类型
    }
    host.read_bytes(path)
}

/* -------------------------------- 工具 -------------------------------- */

/// PNG 的像素尺寸（IHDR 前两个 u32）。给测试用来证明"真的是 128×128 的 PNG"。
pub fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const SIG: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if bytes.len() < 24 || bytes[..8] != SIG {
        return None;
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let h = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    Some((w, h))
}

/// 这个字节串该用什么 media type（前端拼 data URL 用）。
pub fn media_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        "image/png"
    } else if std::str::from_utf8(bytes)
        .map(|s| s.trim_start().starts_with("<svg") || s.contains("<svg"))
        .unwrap_or(false)
    {
        "image/svg+xml"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_in_app::catalog::Platform;
    use crate::open_in_app::host::RealHost;
    use crate::open_in_app::resolver::{resolve_all, resolve_one};
    use std::collections::HashMap;
    use std::path::PathBuf;

    #[test]
    fn png_dimensions_reads_ihdr() {
        // 最小合法 PNG 头（IHDR 长度 + 类型 + 宽高）
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&128u32.to_be_bytes());
        bytes.extend_from_slice(&128u32.to_be_bytes());
        assert_eq!(png_dimensions(&bytes), Some((128, 128)));
        assert_eq!(png_dimensions(b"not a png"), None);
    }

    #[test]
    fn media_type_sniffs_png_and_svg() {
        assert_eq!(media_type(&[0x89, b'P', b'N', b'G', 1]), "image/png");
        assert_eq!(media_type(b"<svg xmlns=\"...\"></svg>"), "image/svg+xml");
        assert_eq!(media_type(b"\x00\x01binary"), "application/octet-stream");
    }

    /// **真机核对**：在本机真的把 VS Code 的图标抠出来，并证明它是 128×128 的 PNG。
    /// 这条不是"代码看起来对"——它跑 `plutil` + `sips`，量的是真实字节。
    #[test]
    fn real_macos_bundle_icon_is_a_128px_png() {
        let facts = Facts::detect();
        if facts.platform != Some(Platform::Darwin) {
            return;
        }
        let Some(bundle) = [
            "/Applications/Visual Studio Code.app",
            "/Applications/Google Chrome.app",
            "/Applications/Safari.app",
        ]
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_dir()) else {
            eprintln!("本机没有可测的 bundle，跳过");
            return;
        };
        let host = RealHost::new(facts.clone());
        let bytes = icon_png(
            &host,
            &facts,
            &IconSource::AppBundle(bundle.clone()),
            Duration::from_secs(20),
        )
        .unwrap_or_else(|| panic!("没能从 {} 提取图标", bundle.display()));
        assert_eq!(
            png_dimensions(&bytes),
            Some((128, 128)),
            "提取出来的不是 128×128 PNG（{} 字节）",
            bytes.len()
        );
    }

    /// 本机解析出来的每一条，只要能声称有 bundle 图标，就必须真能提取出来。
    /// 这条会拦"图标路径写错但没人发现"——按钮上会静默变成通用图标。
    #[test]
    fn real_macos_every_claimed_bundle_icon_extracts() {
        let facts = Facts::detect();
        if facts.platform != Some(Platform::Darwin) {
            return;
        }
        let host = RealHost::new(facts.clone());
        let resolved = resolve_all(&host, &facts, Duration::from_secs(10));
        let mut checked = 0;
        let mut failures = Vec::new();
        for r in &resolved {
            let Some(source @ IconSource::AppBundle(bundle)) = &r.icon else {
                continue;
            };
            checked += 1;
            if icon_png(&host, &facts, source, Duration::from_secs(20)).is_none() {
                failures.push(format!("{} ({})", r.id, bundle.display()));
            }
        }
        assert!(failures.is_empty(), "这些条目的图标提取失败: {failures:?}");
        eprintln!("本机实测提取成功 {checked} 个 bundle 图标");
    }

    /// Windows 分支故意不实现：显式断言它返回 None（而不是悄悄返回坏字节）。
    #[test]
    fn windows_executable_icon_is_not_implemented() {
        let facts = Facts::detect();
        let host = RealHost::new(facts.clone());
        assert_eq!(
            icon_png(
                &host,
                &facts,
                &IconSource::Executable(PathBuf::from("/bin/ls")),
                Duration::from_secs(1)
            ),
            None
        );
    }

    /// Linux：hi-color 主题命中最省事的那条路径。
    #[test]
    fn linux_theme_icon_lookup_prefers_largest_size() {
        struct FakeLinux;
        impl Host for FakeLinux {
            fn is_dir(&self, _: &Path) -> bool {
                false
            }
            fn is_file(&self, p: &Path) -> bool {
                p.to_string_lossy().ends_with("128x128/apps/kitty.png")
                    || p.to_string_lossy().ends_with("applications/kitty.desktop")
            }
            fn read_dir(&self, _: &Path) -> Option<Vec<String>> {
                None
            }
            fn read_file(&self, p: &Path) -> Option<String> {
                p.to_string_lossy()
                    .ends_with("applications/kitty.desktop")
                    .then(|| "[Desktop Entry]\nIcon=kitty\n".to_string())
            }
            fn read_bytes(&self, p: &Path) -> Option<Vec<u8>> {
                p.to_string_lossy()
                    .ends_with("128x128/apps/kitty.png")
                    .then(|| vec![0x89, b'P', b'N', b'G'])
            }
            fn which(&self, _: &str) -> Option<PathBuf> {
                None
            }
            fn run(&self, _: &str, _: &[&str], _: Duration) -> Option<String> {
                None
            }
        }
        let env: HashMap<String, String> = [("HOME", "/Users/x"), ("XDG_DATA_DIRS", "/usr/share")]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let facts = Facts {
            platform: Some(Platform::Linux),
            home: PathBuf::from("/Users/x"),
            app_roots: vec![],
            ssh: false,
            env,
        };
        let host = FakeLinux;
        // 512/256 不存在 → 落到 128（而不是直接放弃）
        assert_eq!(
            linux_icon_bytes(&host, &facts, "kitty"),
            Some(vec![0x89, b'P', b'N', b'G'])
        );
        assert_eq!(linux_icon_bytes(&host, &facts, "nope"), None);
    }

    /// `resolve_one` 是"启动时发现可执行文件没了"的重解析入口，语义必须与整表一致。
    #[test]
    fn resolve_one_agrees_with_the_full_pass() {
        let facts = Facts::detect();
        if facts.platform != Some(Platform::Darwin) {
            return;
        }
        let host = RealHost::new(facts.clone());
        let all = resolve_all(&host, &facts, Duration::from_secs(10));
        for r in &all {
            let one = resolve_one(&host, &facts, r.id, Duration::from_secs(10))
                .unwrap_or_else(|| panic!("{} 整表能解析、单条却解析不出来", r.id));
            assert_eq!(one, *r, "{} 两次解析结果不一致", r.id);
        }
        assert!(resolve_one(&host, &facts, "nope-not-in-catalog", Duration::from_secs(5)).is_none());
    }
}
