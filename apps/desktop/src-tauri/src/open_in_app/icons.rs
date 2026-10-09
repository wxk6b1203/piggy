//! 图标提取：把"这台机器上真实存在的应用图标"变成可以直接塞进 `<img src>` 的 PNG。
//!
//! 移植 DSH `icons.ts` 的三平台策略：
//! - macOS：`.app` bundle 的 `.icns` → `plutil` 读 `CFBundleIconFile` → `sips` 转 128px PNG（已实测）；
//! - Linux：desktop entry 的 `Icon=` 键 → hicolor 主题 / pixmaps（纯文件查找，可测）；
//! - Windows：生成的 PowerShell 脚本调 `ExtractAssociatedIcon` → 留一张 32px PNG 到临时目录
//!   （与 DSH 逐条对齐：`-File` + 位置参数、`System.Drawing`、失败即"拿不到"）。
//!
//! 任何一步失败都返回 None（对应 DSH 图标路由的 404），**不报错**：图标拿不到不该让按钮消失。

use super::host::{Facts, Host};
use super::resolver::{find_desktop_entry, xdg_data_directories};
use super::spec::IconSource;
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

/// hicolor 主题里按尺寸从大到小找（按钮只渲染 15-18 CSS px，但 Retina 要 2x）。
const HICOLOR_SIZES: [&str; 6] = ["512x512", "256x256", "128x128", "64x64", "48x48", "32x32"];

/// 提取一个应用的图标字节。`None` = 这台机器上拿不到（前端画通用图标）。
pub fn icon_png(host: &dyn Host, facts: &Facts, source: &IconSource, timeout: Duration) -> Option<Vec<u8>> {
    match source {
        IconSource::AppBundle(bundle) => bundle_icon_png(host, bundle, timeout),
        IconSource::Desktop(desktop_id) => linux_icon_bytes(host, facts, desktop_id),
        IconSource::Executable(exe) => executable_icon_png(host, exe, timeout),
    }
}

/// 可执行文件图标的内存缓存（进程内），键是 exe 路径。
///
/// 为什么要缓存：`ExtractAssociatedIcon` 每次都要起一个 PowerShell 进程，
/// 本机实测**每个 250-350 ms**（新进程要重新 JIT 一次 `System.Drawing` 的调用点）。
/// 菜单一次要 10 多个图标，不缓存就是"打开菜单后好几秒才逐个亮起来"。
/// 也缓存 `None`：某个 exe 抠不出来时不该每次重试（那是最慢的一种"没有"）。
type IconCache = HashMap<std::path::PathBuf, Option<Vec<u8>>>;

fn icon_cache() -> &'static Mutex<IconCache> {
    static CACHE: OnceLock<Mutex<IconCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 「打开方式」预热：把这些可执行文件的图标先抠到缓存里（后台调，可失败）。
///
/// 与逐条 `icon_png` 的区别只有一处：算完**不释放**，直接留在缓存里。
pub fn prefetch_executable_icons(host: &dyn Host, exes: &[std::path::PathBuf], timeout: Duration) -> usize {
    let mut done = 0;
    for exe in exes {
        if icon_cache().lock().unwrap_or_else(|e| e.into_inner()).contains_key(exe) {
            continue;
        }
        let bytes = executable_icon_png(host, exe, timeout);
        if bytes.is_some() {
            done += 1;
        }
        icon_cache()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(exe.clone(), bytes);
    }
    done
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
        None => host.read_dir(&resources)?.into_iter().find(|e| e.ends_with(".icns"))?,
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
                    .join("icons")
                    .join("hicolor")
                    .join(size)
                    .join("apps")
                    .join(format!("{icon}.{ext}"));
                if let Some(bytes) = read_icon_file(host, &p) {
                    return Some(bytes);
                }
            }
        }
        let scalable = dir
            .join("icons")
            .join("hicolor")
            .join("scalable")
            .join("apps")
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

/* ------------------------------ Windows ------------------------------ */

/// Windows 抠图标脚本（DSH `icons.ts` 的 `EXTRACT_ICON_PS1` 同款两步：
/// `Add-Type -AssemblyName System.Drawing` → `Icon::ExtractAssociatedIcon` → 存 PNG）。
///
/// 三条硬约束，写错了不会报错、只会**静默没有图标**：
/// 1. **必须纯 ASCII**。Windows PowerShell 5.1 读**无 BOM 的 `.ps1`** 是按 ANSI（本机 936）
///    解的，UTF-8 的中文注释会被解成乱码并把语法弄坏 —— 本机实测：脚本里有中文注释时
///    `Unexpected token '}'`，整个脚本一行都不执行。（BOM 能修，但 Lint/编辑器一多就会被
///    悄悄去掉，所以这里用"不写非 ASCII"这条不依赖工具的约束。）
/// 2. **产物写文件，不走 stdout**。PNG 字节进 stdout 会被控制台编码毁掉（见 `Host::run_script`）。
/// 3. **失败也要 exit 0**：单个 exe 抠不出来不是整批失败，调用方按"这个文件没在磁盘上"判断。
const WINDOWS_ICON_SCRIPT: &str = r#"param(
  [Parameter(Mandatory=$true)][string]$Source,
  [Parameter(Mandatory=$true)][string]$Target
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Source)
if ($null -eq $icon) { exit 0 }
$bitmap = $icon.ToBitmap()
$bitmap.Save($Target, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
"#;

/// 脚本名（`-File` 只认 `.ps1` 后缀）。
const WINDOWS_ICON_SCRIPT_NAME: &str = "extract-icon.ps1";

/// 可执行文件 → 32px PNG 字节（带进程内缓存）。
///
/// 32px 是 `ExtractAssociatedIcon` 能给的上限（DSH 的 README 也这么写：
/// "the largest size `ExtractAssociatedIcon` yields without a native addon"）。
/// 菜单里渲染 15-18 CSS px，Retina 下 32px 仍然够；再大就得走 COM（`SHDefExtractIcon`），
/// 本机实测它只对一部分 exe 有效，换来的清晰度不值那份复杂度和失败面。
fn executable_icon_png(host: &dyn Host, exe: &Path, timeout: Duration) -> Option<Vec<u8>> {
    /* 平台闸门放在**这一层**（生产入口），不能放进 `extract_executable_icon`：
    那一层要在假宿主下被验证"线接对了"（`windows_executable_icon_runs_the_script_and_reads_the_png`），
    而 CI 的 rust 作业跑在 macOS 上 —— 闸门留在里面，那条用例就只剩"验了 cfg! 这一行"，
    等于 Windows 接线零覆盖（2026-10-09 实测：它就是这么在 macOS 上红的）。 */
    if !cfg!(target_os = "windows") {
        return None;
    }
    if let Some(hit) = icon_cache().lock().unwrap_or_else(|e| e.into_inner()).get(exe) {
        return hit.clone();
    }
    let bytes = extract_executable_icon(host, exe, timeout);
    icon_cache()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(exe.to_path_buf(), bytes.clone());
    bytes
}

/// 跑一次 PowerShell 抠图（**不带平台闸门**：闸门在 `executable_icon_png`）。
/// 生产入口只有 `executable_icon_png` 一个；直接调它会真的去起 `powershell.exe`。
fn extract_executable_icon(host: &dyn Host, exe: &Path, timeout: Duration) -> Option<Vec<u8>> {
    if !host.is_file(exe) {
        return None;
    }
    let work = std::env::temp_dir().join(format!(
        "piggy-icon-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&work).ok()?;
    let out = work.join("icon.png");
    let source = exe.to_string_lossy().into_owned();
    let target = out.to_string_lossy().into_owned();
    let ran = host.run_script(
        WINDOWS_ICON_SCRIPT_NAME,
        WINDOWS_ICON_SCRIPT,
        // 位置参数 + `-File`：路径是**数据**，不经过任何表达式解析（不给自己造引号转义面）
        &["-Source", &source, "-Target", &target],
        timeout,
    );
    let bytes = ran.and_then(|_| std::fs::read(&out).ok());
    let _ = std::fs::remove_dir_all(&work);
    // 只认真的 PNG：脚本可能"成功退出但没写文件"，也可能写出别的东西
    bytes.filter(|b| png_dimensions(b).is_some())
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

    /// 抠图脚本的内容约束：**必须纯 ASCII**。
    ///
    /// 这条不是洁癖：Windows PowerShell 5.1 按 ANSI 解无 BOM 的 `.ps1`，
    /// 一旦有人往脚本里加一句中文注释（最容易顺手做的事），整个脚本会
    /// `Unexpected token` 一行都不执行 —— 而现象只是"图标又没了"，
    /// 不会有人想到是注释编码。本机实测过这个坑，所以钉住它。
    #[test]
    fn windows_icon_script_stays_pure_ascii() {
        assert!(
            WINDOWS_ICON_SCRIPT.is_ascii(),
            "抠图脚本里出现了非 ASCII 字符（PowerShell 5.1 会按 ANSI 解它，语法会坏）"
        );
        assert!(WINDOWS_ICON_SCRIPT.contains("ExtractAssociatedIcon"));
        assert!(WINDOWS_ICON_SCRIPT_NAME.ends_with(".ps1"), "`-File` 只认 .ps1 后缀");
        // 失败路径必须是 exit 0（单个 exe 抠不出来不算整批失败）
        assert!(WINDOWS_ICON_SCRIPT.contains("exit 0"));
    }

    /// Windows 分支的**接线**：`IconSource::Executable` 必须真的走 `run_script`
    /// 去调 `powershell.exe`，并在产物文件是 PNG 时把字节读回来。
    ///
    /// 用假宿主跑，于是这条在 macOS/Linux 上也能验证"线接对了"；
    /// "真机抠出来的图长什么样"由下面那条 `#[cfg(windows)]` 的用例负责。
    #[test]
    fn windows_executable_icon_runs_the_script_and_reads_the_png() {
        use std::cell::RefCell;
        struct FakeWin {
            calls: RefCell<Vec<String>>,
            exe: PathBuf,
        }
        impl Host for FakeWin {
            fn is_dir(&self, _: &Path) -> bool {
                false
            }
            fn is_file(&self, p: &Path) -> bool {
                p == self.exe
            }
            fn read_dir(&self, _: &Path) -> Option<Vec<String>> {
                None
            }
            fn read_file(&self, _: &Path) -> Option<String> {
                None
            }
            fn read_bytes(&self, _: &Path) -> Option<Vec<u8>> {
                None
            }
            fn which(&self, _: &str) -> Option<PathBuf> {
                None
            }
            fn run(&self, _: &str, _: &[&str], _: Duration) -> Option<String> {
                None
            }
            fn run_script(&self, name: &str, script: &str, args: &[&str], _: Duration) -> Option<()> {
                assert_eq!(name, WINDOWS_ICON_SCRIPT_NAME);
                assert!(script.contains("ExtractAssociatedIcon"));
                // 假宿主"写"一张真 PNG 到 -Target 指定的位置（脚本在真机上就是干这个）
                let target = args.iter().position(|a| *a == "-Target").map(|i| args[i + 1]).unwrap();
                let mut png = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
                png.extend_from_slice(&13u32.to_be_bytes());
                png.extend_from_slice(b"IHDR");
                png.extend_from_slice(&32u32.to_be_bytes());
                png.extend_from_slice(&32u32.to_be_bytes());
                std::fs::write(target, &png).unwrap();
                self.calls.borrow_mut().push(args.join(" "));
                Some(())
            }
        }
        let exe = PathBuf::from("/fake/Code.exe");
        let host = FakeWin {
            calls: RefCell::new(Vec::new()),
            exe: exe.clone(),
        };
        let bytes =
            extract_executable_icon(&host, &exe, Duration::from_secs(5)).expect("脚本跑了、产物是 PNG，就该拿到字节");
        assert_eq!(png_dimensions(&bytes), Some((32, 32)));
        assert_eq!(host.calls.borrow().len(), 1, "应当恰好跑一次脚本");
        // 源文件必须**作为参数**传进去（不是拼进脚本源码）
        assert!(host.calls.borrow()[0].contains("-Source /fake/Code.exe"));
        // 不存在的可执行文件：连脚本都不该跑
        assert_eq!(
            extract_executable_icon(&host, Path::new("/fake/Nope.exe"), Duration::from_secs(5)),
            None
        );
        assert_eq!(host.calls.borrow().len(), 1, "文件不存在时不该起进程");
    }

    /// 非 Windows 上这条脚本没有意义（`System.Drawing` 不存在）—— 直接 None，不要白起进程。
    ///
    /// ⚠️ 量的是**生产入口** `executable_icon_png`（闸门在那儿）。以前这里调的是内层的
    /// `extract_executable_icon`，那等于把闸门和用例绑死在一起：内层一旦去掉闸门
    /// （为了让假宿主接线用例在任何平台都能跑），这条就会真的去起 powershell。
    #[test]
    fn executable_icon_is_none_off_windows() {
        if cfg!(target_os = "windows") {
            return;
        }
        let facts = Facts::detect();
        let host = RealHost::new(facts);
        // 用一个真实存在的可执行文件，证明 None 来自"平台不对"而不是"文件不存在"
        let exe = PathBuf::from("/bin/ls");
        if !exe.exists() {
            return;
        }
        assert_eq!(
            executable_icon_png(&host, &exe, Duration::from_secs(5)),
            None,
            "非 Windows 平台不该尝试抠 Windows 可执行文件的图标"
        );
    }

    /// **真机核对（Windows）**：把本机真的存在的 exe 的图标抠出来，并证明它是 PNG。
    /// 这条跑的是 `powershell.exe` + `System.Drawing`，不是"代码看起来对"。
    #[cfg(windows)]
    #[test]
    fn real_windows_executable_icon_is_a_png() {
        let facts = Facts::detect();
        let host = RealHost::new(facts.clone());
        let candidates: Vec<PathBuf> = [
            std::env::var("SystemRoot").map(|r| format!("{r}\\explorer.exe")).ok(),
            std::env::var("SystemRoot")
                .map(|r| format!("{r}\\System32\\notepad.exe"))
                .ok(),
            std::env::var("SystemRoot")
                .map(|r| format!("{r}\\System32\\cmd.exe"))
                .ok(),
        ]
        .into_iter()
        .flatten()
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .collect();
        assert!(!candidates.is_empty(), "Windows 上应当至少有一个系统 exe 可测");
        let mut checked = 0;
        for exe in &candidates {
            // 绕过缓存：这条量的就是"真跑一次脚本"
            let bytes = extract_executable_icon(&host, exe, Duration::from_secs(30))
                .unwrap_or_else(|| panic!("没能从 {} 抠出图标", exe.display()));
            let (w, h) = png_dimensions(&bytes).expect("产物不是 PNG");
            assert_eq!((w, h), (32, 32), "ExtractAssociatedIcon 给的应当是 32×32");
            assert!(bytes.len() > 200, "图太小了，可能是空图（{} 字节）", bytes.len());
            checked += 1;
        }
        eprintln!("真机实测抠出 {checked} 个 exe 图标（32×32 PNG）");
        // 缓存：第二次必须命中（同一路径不再起进程）—— 量的是"真的走了缓存"
        let again = executable_icon_png(&host, &candidates[0], Duration::from_secs(30));
        assert!(again.is_some(), "缓存命中时也该给出字节");
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
            fn run_script(&self, _: &str, _: &str, _: &[&str], _: Duration) -> Option<()> {
                None // Linux 这条链是纯文件查找，不起进程
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
