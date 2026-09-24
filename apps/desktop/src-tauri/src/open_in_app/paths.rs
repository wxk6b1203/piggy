//! 「用本机应用打开**某个文件**」—— 移植 DSH `native-command/path-opener.ts`
//! 与 `file-applications.ts`（docs/12 §6.5 的文档预览动作位）。
//!
//! 与 `resolver.rs` 的分工：那边是**固定白名单目录**（编辑器/终端/Git GUI，用来打开
//! 一个工作区**目录**）；这里是**操作系统的文件关联**（用来打开**一个文件**，
//! 并且能列出"这个 .md 现在能由哪些应用打开"）。
//!
//! 三个动作，与 DSH 逐条对应：
//! - `open`：默认应用打开（macOS `open <path>`，Linux `xdg-open`，Windows `Invoke-Item`）；
//! - `reveal`：在文件管理器里**定位到**它（macOS `open -R`，Windows `explorer /select,`，
//!   Linux 打开父目录）；
//! - `open_with`：用**已注册**的某个应用打开 —— 先查一遍关联列表再校验，不在列表里一律拒绝
//!   （DSH 的 `openNativeFileApplication`：`Application is not registered for this file`）。
//!
//! 平台现状（与图标那一档同样的诚实标准）：
//! - **macOS 已真机实测**：`osascript -l JavaScript` + AppKit `NSWorkspace`
//!   （`URLsForApplicationsToOpenURL`），本机 0.4 秒返回 20+ 个处理器（含 32px 图标）；
//! - **Linux 已实现**：`gio info` + `gio mime` + XDG desktop entry（解析有夹具测试）；
//! - **Windows 只做打开与定位**：处理器枚举要用 COM（`SHAssocEnumHandlers` + 图标提取，
//!   DSH 为此内嵌了一段 C#）。这段在 macOS 上无法验证，所以**没写**：列表返回空，
//!   前端于是把"显示文件位置"当作默认动作（DSH 在拿不到默认应用时也是这个行为）。

use super::catalog::Platform;
use super::spec::{LaunchOutcome, LaunchSpec};
use super::host::{Facts, Host};
use super::icons::{media_type, theme_icon_bytes};
use super::resolver::{find_desktop_file, parse_desktop_entry};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 一个已注册的文件处理器（DSH `SessionWorkspacePathApplication`）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PathApplication {
    /// 处理器标识：macOS = `.app` 绝对路径，Linux = desktop entry id，Windows = 空集。
    pub id: String,
    pub name: String,
    /// 系统当前的默认选择。
    #[serde(rename = "default")]
    pub is_default: bool,
    /// `data:` URL；拿不到就是 None（前端画通用图标）。
    pub icon: Option<String>,
}

/// 一次路径动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathAction {
    Open,
    Reveal,
}

impl PathAction {
    pub fn parse(raw: &str) -> Option<PathAction> {
        match raw {
            "open" => Some(PathAction::Open),
            "reveal" => Some(PathAction::Reveal),
            _ => None,
        }
    }
}

/* ------------------------------- macOS ------------------------------- */

/// 在系统自带的 JXA 宿主里跑 AppKit：**路径作为 argv 传入，永远不进可执行源码**
/// （DSH 的注释同样强调这一点 —— 拼接脚本字符串就等于自己造了一个注入面）。
const MAC_APPLICATIONS: &str = r#"
ObjC.import('AppKit');
function run(argv) {
  var workspace = $.NSWorkspace.sharedWorkspace;
  var file = $.NSURL.fileURLWithPath(argv[0]);
  var preferred = workspace.URLForApplicationToOpenURL(file);
  var preferredPath = preferred.isNil() ? null : ObjC.unwrap(preferred.path);
  var urls = workspace.URLsForApplicationsToOpenURL(file);
  var apps = [];
  for (var i = 0; i < urls.count; i++) {
    var url = urls.objectAtIndex(i);
    var path = ObjC.unwrap(url.path);
    var image = null;
    if (argv[1] === 'icons') {
      var icon = workspace.iconForFile(path);
      var thumbnail = $.NSImage.alloc.initWithSize($.NSMakeSize(32, 32));
      thumbnail.lockFocus;
      icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, 32, 32), $.NSZeroRect, $.NSCompositingOperationSourceOver, 1);
      thumbnail.unlockFocus;
      var bitmap = $.NSBitmapImageRep.imageRepWithData(thumbnail.TIFFRepresentation);
      var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
      image = png.isNil() ? null : 'data:image/png;base64,' + ObjC.unwrap(png.base64EncodedStringWithOptions(0));
    }
    var bundle = $.NSBundle.bundleWithURL(url);
    var bundleId = bundle.isNil() || bundle.bundleIdentifier.isNil() ? null : ObjC.unwrap(bundle.bundleIdentifier);
    var version = bundle.isNil() ? null : bundle.objectForInfoDictionaryKey('CFBundleShortVersionString');
    apps.push({
      id: path,
      name: ObjC.unwrap($.NSFileManager.defaultManager.displayNameAtPath(path)),
      default: path === preferredPath,
      icon: image,
      bundle: bundleId,
      version: version === null || version.isNil() ? null : String(ObjC.unwrap(version))
    });
  }
  return JSON.stringify(apps);
}"#;

/// JXA 返回的原始条目（比对外形态多两个字段：分组用的 bundle 与 version）。
#[derive(Debug, Clone, Deserialize)]
struct MacRaw {
    id: String,
    name: String,
    #[serde(default, rename = "default")]
    is_default: bool,
    #[serde(default)]
    icon: Option<String>,
    #[serde(default)]
    bundle: Option<String>,
    #[serde(default)]
    version: Option<String>,
}

/// 点分版本比较：非数字段按 0，缺失版本最低（DSH `compareVersions`）。
fn compare_versions(left: Option<&str>, right: Option<&str>) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (left, right) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Less,
        (Some(_), None) => Ordering::Greater,
        (Some(a), Some(b)) => {
            let a: Vec<u32> = a.split('.').map(|s| s.parse().unwrap_or(0)).collect();
            let b: Vec<u32> = b.split('.').map(|s| s.parse().unwrap_or(0)).collect();
            for i in 0..a.len().max(b.len()) {
                let (x, y) = (*a.get(i).unwrap_or(&0), *b.get(i).unwrap_or(&0));
                if x != y {
                    return x.cmp(&y);
                }
            }
            Ordering::Equal
        }
    }
}

/// 校验并按 (bundle, 显示名) 折叠重复注册。
///
/// 为什么要折叠：自更新类应用会在磁盘上留下多份副本（Application Support 下的暂存副本、
/// 按版本安装的副本），LaunchServices 全都注册，于是原始列表里同一个应用出现好几次。
/// Finder 每个应用只显示一条，只有**刻意的并存安装**（显示名不同）才拆开 —— 这里对齐它。
/// 折叠保留系统默认的那一份，否则留版本最高的那一份，位置取组内第一条。
/// （**打开时不做折叠**：每一个注册副本都得能打开，DSH 也是这么分的。）
fn parse_mac_applications(json: &str) -> Result<Vec<PathApplication>, String> {
    let raw: Vec<MacRaw> = serde_json::from_str(json).map_err(|e| format!("解析 AppKit 结果失败: {e}"))?;
    let mut order: Vec<MacRaw> = Vec::new();
    let mut groups: HashMap<String, usize> = HashMap::new();
    for app in raw {
        if app.id.is_empty() || app.name.is_empty() {
            continue;
        }
        let Some(bundle) = app.bundle.clone().filter(|b| !b.is_empty()) else {
            order.push(app);
            continue;
        };
        let key = format!("{bundle}\u{0}{}", app.name);
        match groups.get(&key) {
            None => {
                groups.insert(key, order.len());
                order.push(app);
            }
            Some(&index) => {
                let held = &order[index];
                if held.is_default {
                    continue;
                }
                if app.is_default || compare_versions(app.version.as_deref(), held.version.as_deref()).is_gt() {
                    order[index] = app;
                }
            }
        }
    }
    Ok(order
        .into_iter()
        .map(|a| PathApplication {
            id: a.id,
            name: a.name,
            is_default: a.is_default,
            icon: a.icon.filter(|i| !i.is_empty()),
        })
        .collect())
}

fn mac_applications(
    host: &dyn Host,
    path: &Path,
    timeout: Duration,
) -> Result<Vec<PathApplication>, String> {
    let out = host
        .run(
            "osascript",
            &[
                "-l",
                "JavaScript",
                "-e",
                MAC_APPLICATIONS,
                &path.to_string_lossy(),
                "icons",
            ],
            timeout,
        )
        .ok_or_else(|| "系统文件关联查询失败（osascript / AppKit）".to_string())?;
    parse_mac_applications(out.trim())
}

/* ------------------------------- Linux ------------------------------- */

/// `standard::content-type: text/markdown` → `text/markdown`
fn parse_gio_content_type(stdout: &str) -> Option<String> {
    stdout.lines().find_map(|line| {
        line.trim()
            .strip_prefix("standard::content-type:")
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// `gio mime <type>` 的输出 → (默认 desktop id, 全部 desktop id，按系统偏好序)。
fn parse_gio_mime(stdout: &str) -> (Option<String>, Vec<String>) {
    let mut preferred = None;
    let mut ids: Vec<String> = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("Default application") {
            if let Some((_, value)) = trimmed.split_once(':') {
                let value = value.trim();
                if value.ends_with(".desktop") {
                    preferred = Some(value.to_string());
                }
            }
            continue;
        }
        // 处理器行是缩进的、且以 .desktop 结尾
        if (line.starts_with(' ') || line.starts_with('\t'))
            && trimmed.ends_with(".desktop")
            && !trimmed.contains(' ')
        {
            ids.push(trimmed.to_string());
        }
    }
    if let Some(default) = &preferred {
        ids.retain(|id| id != default);
        ids.insert(0, default.clone());
    }
    let mut seen = std::collections::HashSet::new();
    ids.retain(|id| seen.insert(id.clone()));
    (preferred, ids)
}

/// `Name[zh_CN]` → `Name[zh]` → `Name`
fn desktop_display_name(entry: &super::resolver::DesktopEntry, locale: &str) -> Option<String> {
    let short = locale.split('.').next().unwrap_or(locale);
    let base = short.split('_').next().unwrap_or(short);
    [
        entry.fields.get(&format!("Name[{short}]")),
        entry.fields.get(&format!("Name[{base}]")),
        entry.fields.get("Name"),
    ]
    .into_iter()
    .flatten()
    .find(|v| !v.is_empty())
    .cloned()
}

fn linux_applications(
    host: &dyn Host,
    facts: &Facts,
    path: &Path,
    timeout: Duration,
) -> Result<Vec<PathApplication>, String> {
    let info = host
        .run(
            "gio",
            &["info", "-a", "standard::content-type", &path.to_string_lossy()],
            timeout,
        )
        .ok_or_else(|| "gio 无法识别该文件的内容类型".to_string())?;
    let mime = parse_gio_content_type(&info).ok_or_else(|| "gio 未返回内容类型".to_string())?;
    let listing = host
        .run("env", &["LC_ALL=C", "gio", "mime", &mime], timeout)
        .ok_or_else(|| "gio mime 查询失败".to_string())?;
    let (preferred, ids) = parse_gio_mime(&listing);
    let locale = facts
        .var("LC_ALL")
        .or_else(|| facts.var("LC_MESSAGES"))
        .or_else(|| facts.var("LANG"))
        .unwrap_or("")
        .to_string();
    let mut apps = Vec::new();
    for id in ids {
        let Some(file) = find_desktop_file(host, facts, &id) else {
            continue;
        };
        let Some(text) = host.read_file(&file) else {
            continue;
        };
        let entry = parse_desktop_entry(&text);
        if entry.fields.get("Hidden").map(|v| v == "true").unwrap_or(false) {
            continue;
        }
        let name = match desktop_display_name(&entry, &locale) {
            Some(n) => strip_desktop_suffix(&n),
            None => continue,
        };
        let icon = entry
            .icon
            .as_deref()
            .filter(|i| !i.is_empty())
            .and_then(|i| theme_icon_bytes(host, facts, i))
            .map(|bytes| format!("data:{};base64,{}", media_type(&bytes), super::base64(&bytes)));
        apps.push(PathApplication {
            id: file.to_string_lossy().into_owned(),
            name,
            is_default: preferred.as_deref() == Some(id.as_str()),
            icon,
        });
    }
    Ok(apps)
}

/// desktop entry 的显示名常以 `.desktop` 结尾（`code.desktop`）——菜单里不该出现它。
fn strip_desktop_suffix(name: &str) -> String {
    name.strip_suffix(".desktop").unwrap_or(name).to_string()
}

/* ------------------------------ Windows ------------------------------ */

/// Windows 的**文件 URL**（`explorer /select,` 吃这个形状）。
///
/// Explorer 自己解析逗号，所以逗号必须转义成 `%2C`（DSH 同款理由：路径里的逗号
/// 与空白只有 URI 形式才保留得住）。`%` 必须先编码，否则会把已有的转义再转一次。
pub fn windows_file_url(path: &str) -> String {
    let mut out = String::with_capacity(path.len() + 8);
    out.push_str("file:///");
    for ch in path.chars() {
        match ch {
            '\\' => out.push('/'),
            '%' => out.push_str("%25"),
            ',' => out.push_str("%2C"),
            '#' => out.push_str("%23"),
            '?' => out.push_str("%3F"),
            _ => out.push(ch),
        }
    }
    out
}

/// PowerShell 单引号字面量（内嵌单引号翻倍）——路径是**数据**，不是表达式。
pub fn powershell_literal(path: &str) -> String {
    format!("'{}'", path.replace('\'', "''"))
}

/* ------------------------------- 分发 ------------------------------- */

/// 这台机器的桌面能不能把路径交给应用（DSH `canOpenWorkspacePath`）。
pub fn can_open_path(facts: &Facts) -> bool {
    super::resolver::can_open_native_path(facts)
}

/// 校验一个**已存在**的绝对路径（文件或目录都可以）。
///
/// 与 `validate_directory` 分开：目录那一档只服务于"打开工作区"，
/// 这里要服务"打开这个文件"，所以存在性与绝对性是共同要求，类型不是。
pub fn validate_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("路径为空".into());
    }
    if trimmed.contains('\0') {
        return Err("路径含非法字符".into());
    }
    let p = PathBuf::from(trimmed);
    if !p.is_absolute() {
        return Err(format!("不是绝对路径: {trimmed}"));
    }
    if !p.exists() {
        return Err(format!("路径不存在: {trimmed}"));
    }
    Ok(p)
}

/// 该文件当前注册的处理器（按系统偏好序）。
pub fn applications(
    host: &dyn Host,
    facts: &Facts,
    path: &Path,
    timeout: Duration,
) -> Result<Vec<PathApplication>, String> {
    match facts.platform {
        Some(Platform::Darwin) => mac_applications(host, path, timeout),
        Some(Platform::Linux) => linux_applications(host, facts, path, timeout),
        // Windows：处理器枚举要 COM（见模块头注释）。空列表 → 前端把"显示文件位置"当默认动作。
        Some(Platform::Win32) | None => Ok(Vec::new()),
    }
}

/// 一个动作要执行的 argv（`{path}` 由 `launch_detached` 在启动时代入）。
pub fn action_launch(
    facts: &Facts,
    action: PathAction,
    path: &Path,
    application: Option<&str>,
) -> Result<LaunchSpec, String> {
    let platform = facts.platform.ok_or_else(|| "不支持的平台".to_string())?;
    let path_str = path.to_string_lossy().into_owned();
    let argv = |command: &str, args: Vec<String>| LaunchSpec::Argv {
        command: command.to_string(),
        args,
        env: Vec::new(),
    };
    // 指定应用优先：它每个平台只有一条**已注册**的路径（注册校验在 run_action 里做）
    if let Some(app) = application {
        return match platform {
            Platform::Darwin => Ok(argv("open", vec!["-a".into(), app.to_string(), path_str])),
            Platform::Linux => Ok(argv("gio", vec!["launch".into(), app.to_string(), path_str])),
            Platform::Win32 => Err(
                "Windows 上暂不支持指定应用打开（处理器枚举需要 COM，见 docs/15）".into(),
            ),
        };
    }
    match (platform, action) {
        (Platform::Darwin, PathAction::Open) => Ok(argv("open", vec![path_str])),
        (Platform::Darwin, PathAction::Reveal) => Ok(argv("open", vec!["-R".into(), path_str])),
        (Platform::Linux, PathAction::Open) => Ok(argv("xdg-open", vec![path_str])),
        // Linux 没有跨桌面的"选中这个文件"原语，退到打开它所在的目录（DSH 同款）。
        (Platform::Linux, PathAction::Reveal) => {
            let parent = path
                .parent()
                .ok_or_else(|| "路径没有父目录".to_string())?
                .to_string_lossy()
                .into_owned();
            Ok(argv("xdg-open", vec![parent]))
        }
        (Platform::Win32, PathAction::Open) => Ok(argv(
            "powershell.exe",
            vec![
                "-NoProfile".into(),
                "-Command".into(),
                format!("Invoke-Item -LiteralPath {}", powershell_literal(&path_str)),
            ],
        )),
        (Platform::Win32, PathAction::Reveal) => Ok(argv(
            "explorer.exe",
            vec![format!("/select,{}", windows_file_url(&path_str))],
        )),
    }
}

/// 执行一次路径动作：`application` 给了就是"用指定应用打开"（会先校验注册）。
///
/// 校验放在**启动之前**，且校验的是一份现查的注册列表 —— 前端传什么字符串都进不来，
/// 只有系统此刻真的注册过的处理器才可能被执行。
pub fn run_action(
    host: &dyn Host,
    facts: &Facts,
    path: &Path,
    action: PathAction,
    application: Option<&str>,
    probe_timeout: Duration,
    watch: Duration,
) -> Result<(), String> {
    if !can_open_path(facts) {
        return Err("这台机器没有可用的桌面环境".into());
    }
    if let Some(app) = application {
        let registered = applications(host, facts, path, probe_timeout)?;
        if !registered.iter().any(|a| a.id == app) {
            return Err("这个应用没有注册打开该文件".into());
        }
    }
    let spec = action_launch(facts, action, path, application)?;
    let LaunchSpec::Argv {
        command,
        args,
        env: extra,
    } = spec
    else {
        return Err("内部错误：路径动作必须是 argv 形态".into());
    };
    match super::host::spawn_watched(&command, &args, watch, &facts.env, &extra) {
        LaunchOutcome::Launched => Ok(()),
        LaunchOutcome::Missing => Err(format!("找不到启动器：{command}")),
        LaunchOutcome::Failed(msg) => Err(msg),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_in_app::host::RealHost;
    use crate::open_in_app::resolver::DesktopEntry;
    use std::collections::HashMap;

    fn facts_for(platform: Platform) -> Facts {
        Facts {
            platform: Some(platform),
            home: PathBuf::from("/Users/x"),
            app_roots: vec![PathBuf::from("/Applications")],
            ssh: false,
            env: [("HOME", "/Users/x"), ("DISPLAY", ":0"), ("LANG", "zh_CN.UTF-8")]
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    /* ---------- 纯函数（三平台都能在 macOS 上验证） ---------- */

    #[test]
    fn parses_gio_content_type() {
        let out = "uri: file:///x/a.md\nlocal path: /x/a.md\nunix mount: /dev\n  standard::content-type: text/markdown\n  standard::size: 12\n";
        assert_eq!(parse_gio_content_type(out).as_deref(), Some("text/markdown"));
        assert_eq!(parse_gio_content_type("no type here"), None);
    }

    #[test]
    fn parses_gio_mime_default_and_handlers() {
        let out = "Default application for “text/markdown”: code.desktop\nRegistered applications:\n\tTypora.desktop\n\tcode.desktop\n\torg.gnome.TextEditor.desktop\n";
        let (default, ids) = parse_gio_mime(out);
        assert_eq!(default.as_deref(), Some("code.desktop"));
        // 默认项排第一，且不重复
        assert_eq!(
            ids,
            vec!["code.desktop", "Typora.desktop", "org.gnome.TextEditor.desktop"]
        );
        let (none, ids) = parse_gio_mime("No applications registered for “x/y”\n");
        assert_eq!(none, None);
        assert!(ids.is_empty());
    }

    #[test]
    fn desktop_display_name_prefers_locale_then_falls_back() {
        let mut fields = HashMap::new();
        fields.insert("Name".to_string(), "Text Editor".to_string());
        fields.insert("Name[zh]".to_string(), "文本编辑器".to_string());
        fields.insert("Name[zh_CN]".to_string(), "文本编辑器（简体）".to_string());
        let entry = DesktopEntry {
            fields,
            ..Default::default()
        };
        assert_eq!(desktop_display_name(&entry, "zh_CN.UTF-8").as_deref(), Some("文本编辑器（简体）"));
        assert_eq!(desktop_display_name(&entry, "zh_TW").as_deref(), Some("文本编辑器"));
        assert_eq!(desktop_display_name(&entry, "en_US").as_deref(), Some("Text Editor"));
    }

    #[test]
    fn strips_desktop_suffix_from_display_names() {
        assert_eq!(strip_desktop_suffix("code.desktop"), "code");
        assert_eq!(strip_desktop_suffix("Visual Studio Code"), "Visual Studio Code");
    }

    /// Explorer 自己解析逗号：路径里的逗号必须转义，`%` 不能二次转义。
    #[test]
    fn windows_file_url_encodes_what_explorer_parses() {
        assert_eq!(windows_file_url(r"C:\a\b.md"), "file:///C:/a/b.md");
        assert_eq!(windows_file_url(r"C:\My, File.md"), "file:///C:/My%2C File.md");
        assert_eq!(windows_file_url(r"C:\100%\x.md"), "file:///C:/100%25/x.md");
        assert_eq!(windows_file_url(r"C:\a#b?c.md"), "file:///C:/a%23b%3Fc.md");
    }

    #[test]
    fn powershell_literal_doubles_quotes() {
        assert_eq!(powershell_literal(r"C:\a b\x.md"), r"'C:\a b\x.md'");
        assert_eq!(powershell_literal("it's"), "'it''s'");
    }

    #[test]
    fn validate_path_requires_an_existing_absolute_path() {
        assert!(validate_path("/tmp").is_ok());
        assert!(validate_path("/etc/hosts").is_ok()); // 文件也可以
        assert!(validate_path("").is_err());
        assert!(validate_path("rel/x").is_err());
        assert!(validate_path("/definitely/not/here").is_err());
        assert!(validate_path("/tmp\0x").is_err());
    }

    #[test]
    fn action_launch_matches_each_platforms_recipe() {
        let facts = facts_for(Platform::Darwin);
        let p = Path::new("/x/a.md");
        assert_eq!(
            action_launch(&facts, PathAction::Open, p, None).unwrap().describe(),
            "open /x/a.md"
        );
        assert_eq!(
            action_launch(&facts, PathAction::Reveal, p, None).unwrap().describe(),
            "open -R /x/a.md"
        );
        assert_eq!(
            action_launch(&facts, PathAction::Open, p, Some("/Applications/Typora.app"))
                .unwrap()
                .describe(),
            "open -a /Applications/Typora.app /x/a.md"
        );
        let linux = facts_for(Platform::Linux);
        assert_eq!(
            action_launch(&linux, PathAction::Reveal, p, None).unwrap().describe(),
            "xdg-open /x"
        );
        assert_eq!(
            action_launch(&linux, PathAction::Open, p, Some("code.desktop"))
                .unwrap()
                .describe(),
            "gio launch code.desktop /x/a.md"
        );
        let win = facts_for(Platform::Win32);
        assert!(action_launch(&win, PathAction::Open, Path::new(r"C:\a\b.md"), None)
            .unwrap()
            .describe()
            .contains("Invoke-Item -LiteralPath 'C:\\a\\b.md'"));
        assert!(action_launch(&win, PathAction::Reveal, Path::new(r"C:\a\b.md"), None)
            .unwrap()
            .describe()
            .contains("/select,file:///C:/a/b.md"));
        // Windows 指定应用：明确不支持，而不是静默乱开
        assert!(action_launch(&win, PathAction::Open, Path::new(r"C:\a\b.md"), Some("x")).is_err());
    }

    /* ---------- macOS 真机 ---------- */

    /// **真机实测**：拿本机真实存在的文件问一遍系统，必须问出东西来。
    /// 这条跑的是 `osascript` + AppKit，不是"代码看起来对"。
    #[test]
    fn real_macos_reports_registered_handlers() {
        let facts = Facts::detect();
        if facts.platform != Some(Platform::Darwin) {
            return;
        }
        let host = RealHost::new(facts.clone());
        let file = Path::new("/Users/wxk/Documents/Project/piggy/README.md");
        if !file.exists() {
            return;
        }
        let apps = applications(&host, &facts, file, Duration::from_secs(30)).expect("查询应当成功");
        assert!(
            apps.len() >= 2,
            "本机 markdown 的处理器应当不止一个，实际 {}",
            apps.len()
        );
        assert_eq!(
            apps.iter().filter(|a| a.is_default).count(),
            1,
            "默认项必须**恰好**有一个"
        );
        // id 是 .app 绝对路径，且真实存在；图标是 PNG data URL
        for app in &apps {
            assert!(app.id.ends_with(".app"), "处理器 id 不像 bundle: {}", app.id);
            assert!(Path::new(&app.id).is_dir(), "处理器不存在: {}", app.id);
            if let Some(icon) = &app.icon {
                assert!(icon.starts_with("data:image/png;base64,"), "图标不是 PNG data URL");
                assert!(icon.len() > 1000, "图标太小，可能是空图");
            }
        }
        // 折叠：同一个应用不许出现两次
        let mut seen = std::collections::HashSet::new();
        for app in &apps {
            assert!(seen.insert(app.id.clone()), "重复的处理器: {}", app.id);
        }
        eprintln!(
            "真机文件关联: {} 个处理器，默认 = {}",
            apps.len(),
            apps.iter().find(|a| a.is_default).map(|a| a.name.as_str()).unwrap_or("(无)")
        );
    }

    /// 目录**也**可能有关联（本机实测 `/tmp` → 终端.app），
    /// 所以"打开工作区目录"必须走固定白名单目录，而不是文件关联 ——
    /// 关联列表会给出"用终端打开这个文件夹"这种对工作区没有意义的选择。
    #[test]
    fn real_macos_directory_associations_are_not_a_workspace_answer() {
        let facts = Facts::detect();
        if facts.platform != Some(Platform::Darwin) {
            return;
        }
        let host = RealHost::new(facts.clone());
        let apps = applications(&host, &facts, Path::new("/tmp"), Duration::from_secs(30))
            .expect("目录查询不该报错（有没有结果都行）");
        for app in &apps {
            assert!(Path::new(&app.id).is_dir(), "关联到的应用不存在: {}", app.id);
        }
        // 无论关联列表给出什么，"定位到目录"始终可用
        let spec = action_launch(&facts, PathAction::Reveal, Path::new("/tmp"), None).unwrap();
        assert_eq!(spec.describe(), "open -R /tmp");
        eprintln!("本机 /tmp 的关联应用: {:?}", apps.iter().map(|a| a.name.as_str()).collect::<Vec<_>>());
    }

    /// 未注册的应用必须被拒（前端传什么字符串都进不来）。
    #[test]
    fn real_macos_rejects_an_unregistered_application() {
        let facts = Facts::detect();
        if facts.platform != Some(Platform::Darwin) {
            return;
        }
        let host = RealHost::new(facts.clone());
        let file = Path::new("/Users/wxk/Documents/Project/piggy/README.md");
        if !file.exists() {
            return;
        }
        let err = run_action(
            &host,
            &facts,
            file,
            PathAction::Open,
            Some("/Applications/Definitely-Not-Registered.app"),
            Duration::from_secs(30),
            Duration::from_millis(500),
        )
        .unwrap_err();
        assert!(err.contains("没有注册"), "{err}");
    }
}
