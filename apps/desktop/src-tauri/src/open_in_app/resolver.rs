//! 把 `catalog.rs` 的静态表解析成"这台机器上真实可用的启动方式"。
//!
//! 移植 DSH `resolver.ts`。三条铁律（每条都有测试）：
//! 1. **只有验证过的启动器才算数** —— 光有安装记录/注册表项不算，必须落到磁盘上真实存在的文件；
//! 2. **一台机器只解析一次**（`mod.rs` 缓存），只有"启动时发现可执行文件没了"才重新解析那一条；
//! 3. **argv 永不经过 shell** —— 没有引号/转义/注入面。

use super::catalog::{spec_for, AppEntry, Launch, Locator, Platform, CATALOG, PATH_TOKEN};
use super::host::{Facts, Host};
use super::spec::{IconSource, LaunchSpec, Resolved};
use std::cell::RefCell;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/* ------------------------------- 路径展开 ------------------------------- */

/// 展开 `${VAR}` 与开头的 `~/`；任何变量未设置 → None（不是空串）。
pub fn expand_candidate(raw: &str, facts: &Facts) -> Option<PathBuf> {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        let end = after.find('}')?;
        out.push_str(facts.var(&after[..end])?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    if let Some(rest) = out.strip_prefix("~/") {
        return Some(facts.home.join(rest));
    }
    Some(PathBuf::from(out))
}

/// 展开 Windows 注册表值里的 `%VAR%`；任何变量未设置 → None。
pub fn expand_registry_value(value: &str, facts: &Facts) -> Option<String> {
    let mut out = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let Some(end) = after.find('%') else {
            out.push_str(&rest[start..]);
            return Some(out);
        };
        let name = &after[..end];
        out.push_str(facts.var(name)?);
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    Some(out)
}

/* --------------------------- Windows 注册表视图 --------------------------- */

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallRecord {
    pub display_name: String,
    pub install_location: Option<String>,
    pub display_icon: Option<String>,
}

/// 一次解析里注册表的只读视图（`App Paths` + 卸载记录）。
#[derive(Debug, Default)]
pub struct Registry {
    /// 可执行文件名（小写）→ 绝对路径。
    pub app_paths: HashMap<String, String>,
    pub install_records: Vec<InstallRecord>,
}

const APP_PATHS_ROOTS: [&str; 2] = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
];
const UNINSTALL_ROOTS: [&str; 3] = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
];

/// 解析 `reg.exe query <root> /s` 的输出：子键路径 → 该键下的字符串值。
///
/// `reg.exe` 每个子键打一行键路径，随后是缩进的值行；值名可能是本地化的默认值标记
/// （`(Default)` / `(默认)`），所以**用 `REG_*` 类型名定位列**，不按值名切。
pub fn parse_registry_dump(dump: &str) -> Vec<(String, HashMap<String, String>)> {
    let mut keys: Vec<(String, HashMap<String, String>)> = Vec::new();
    let mut current: Option<usize> = None;
    for line in dump.lines() {
        let line = line.trim_end_matches('\r');
        if line.starts_with("HK") {
            keys.push((line.trim().to_string(), HashMap::new()));
            current = Some(keys.len() - 1);
            continue;
        }
        let Some(values) = current.map(|i| &mut keys[i].1) else {
            continue;
        };
        let trimmed = line.trim_start();
        if trimmed.len() == line.len() {
            continue; // 值行一定是缩进的
        }
        // <值名>\s+REG_SZ|REG_EXPAND_SZ\s+<数据>
        let mut parts = trimmed.splitn(2, "REG_");
        let Some(name) = parts.next() else { continue };
        let Some(rest) = parts.next() else { continue };
        let Some((kind, data)) = rest.split_once(char::is_whitespace) else {
            continue;
        };
        if kind != "SZ" && kind != "EXPAND_SZ" {
            continue;
        }
        let name = name.trim();
        let key = if name.starts_with('(') && name.ends_with(')') {
            "(Default)".to_string()
        } else {
            name.to_string()
        };
        values.insert(key, data.trim().to_string());
    }
    keys
}

struct RegistryView<'a> {
    host: &'a dyn Host,
    facts: &'a Facts,
    timeout: Duration,
    cache: RefCell<Option<Registry>>,
}

impl<'a> RegistryView<'a> {
    fn new(host: &'a dyn Host, facts: &'a Facts, timeout: Duration) -> RegistryView<'a> {
        RegistryView {
            host,
            facts,
            timeout,
            cache: RefCell::new(None),
        }
    }

    /// 一次解析最多读一遍注册表（每个根一条 `reg.exe`）。
    fn read(&self) -> std::cell::Ref<'_, Registry> {
        if self.cache.borrow().is_none() {
            *self.cache.borrow_mut() = Some(self.load());
        }
        std::cell::Ref::map(self.cache.borrow(), |c| c.as_ref().expect("刚填过"))
    }

    fn load(&self) -> Registry {
        let mut reg = Registry::default();
        for root in APP_PATHS_ROOTS {
            let Some(dump) = self.host.run("reg.exe", &["query", root, "/s"], self.timeout) else {
                continue;
            };
            for (key, values) in parse_registry_dump(&dump) {
                let exe = key
                    .rsplit('\\')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let Some(target) = values.get("(Default)") else {
                    continue;
                };
                if !exe.ends_with(".exe") || reg.app_paths.contains_key(&exe) {
                    continue; // 用户 hive 优先（先读先占）
                }
                let cleaned = target.trim_matches('"');
                if let Some(path) = expand_registry_value(cleaned, self.facts) {
                    reg.app_paths.insert(exe, path);
                }
            }
        }
        for root in UNINSTALL_ROOTS {
            let Some(dump) = self.host.run("reg.exe", &["query", root, "/s"], self.timeout) else {
                continue;
            };
            for (_, values) in parse_registry_dump(&dump) {
                let Some(display_name) = values.get("DisplayName") else {
                    continue;
                };
                reg.install_records.push(InstallRecord {
                    display_name: display_name.clone(),
                    install_location: values.get("InstallLocation").cloned(),
                    display_icon: values.get("DisplayIcon").cloned(),
                });
            }
        }
        reg
    }
}

/// 卸载记录能反证出来的可执行文件（光有记录不算）。
fn record_launcher(
    host: &dyn Host,
    record: &InstallRecord,
    rel_launcher: &str,
    facts: &Facts,
) -> Option<PathBuf> {
    if !rel_launcher.is_empty() {
        if let Some(loc) = record.install_location.as_deref().filter(|s| !s.is_empty()) {
            if let Some(base) = expand_registry_value(loc.trim_matches('"'), facts) {
                let candidate = Path::new(&base).join(rel_launcher);
                if host.is_file(&candidate) {
                    return Some(candidate);
                }
            }
        }
    }
    let icon = record.display_icon.as_deref()?;
    // DisplayIcon 可能带 `,<index>` 后缀和引号。
    let bare = icon
        .rsplit_once(',')
        .filter(|(_, idx)| idx.trim_start_matches('-').chars().all(|c| c.is_ascii_digit()))
        .map(|(head, _)| head)
        .unwrap_or(icon)
        .trim()
        .trim_matches('"')
        .to_string();
    let path = expand_registry_value(&bare, facts)?;
    if path.to_ascii_lowercase().ends_with(".exe") && host.is_file(Path::new(&path)) {
        Some(PathBuf::from(path))
    } else {
        None
    }
}

/* ---------------------------- Linux desktop entry ---------------------------- */

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DesktopEntry {
    pub exec: Option<String>,
    pub try_exec: Option<String>,
    pub icon: Option<String>,
}

/// 解析 `[Desktop Entry]` 段的 `Exec` / `TryExec` / `Icon`（其它段忽略）。
pub fn parse_desktop_entry(text: &str) -> DesktopEntry {
    let mut entry = DesktopEntry::default();
    let mut in_entry = false;
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        let trimmed = line.trim();
        if trimmed.starts_with('[') {
            in_entry = trimmed == "[Desktop Entry]";
            continue;
        }
        if !in_entry {
            continue;
        }
        let Some((key, value)) = trimmed.split_once('=') else {
            continue;
        };
        match key.trim() {
            "Exec" => entry.exec = Some(value.trim().to_string()),
            "TryExec" => entry.try_exec = Some(value.trim().to_string()),
            "Icon" => entry.icon = Some(value.trim().to_string()),
            _ => {}
        }
    }
    entry
}

/// XDG 数据目录（`XDG_DATA_HOME` 优先，然后 `XDG_DATA_DIRS`）。
pub fn xdg_data_directories(facts: &Facts) -> Vec<PathBuf> {
    let data_home = facts
        .var("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| facts.home.join(".local/share"));
    let data_dirs = facts.var("XDG_DATA_DIRS").unwrap_or("/usr/local/share:/usr/share");
    let mut dirs = vec![data_home];
    dirs.extend(
        data_dirs
            .split(':')
            .filter(|d| !d.is_empty())
            .map(PathBuf::from),
    );
    dirs
}

pub fn find_desktop_entry(host: &dyn Host, facts: &Facts, desktop_id: &str) -> Option<DesktopEntry> {
    for dir in xdg_data_directories(facts) {
        let path = dir.join("applications").join(format!("{desktop_id}.desktop"));
        if let Some(text) = host.read_file(&path) {
            return Some(parse_desktop_entry(&text));
        }
    }
    None
}

/// `Exec=` 的第一个 token（带引号取引号内）。
pub fn exec_command(exec: &str) -> Option<String> {
    let trimmed = exec.trim_start();
    if let Some(rest) = trimmed.strip_prefix('"') {
        return rest.split('"').next().map(str::to_string);
    }
    trimmed.split_whitespace().next().map(str::to_string)
}

/// desktop entry 反证出来的启动器：`TryExec` 优先，否则 `Exec` 首 token。
fn desktop_launcher(host: &dyn Host, entry: &DesktopEntry) -> Option<PathBuf> {
    let candidate = entry
        .try_exec
        .clone()
        .filter(|s| !s.is_empty())
        .or_else(|| entry.exec.as_deref().and_then(exec_command))
        .filter(|s| !s.is_empty())?;
    let path = Path::new(&candidate);
    if path.is_absolute() {
        return host.is_file(path).then(|| path.to_path_buf());
    }
    host.which(&candidate)
}

/// 这台机器能不能把目录交给桌面环境打开（`xdg-open` 只在这个前提下算数）。
pub fn can_open_native_path(facts: &Facts) -> bool {
    match facts.platform {
        Some(Platform::Linux) => ["DISPLAY", "WAYLAND_DISPLAY"]
            .iter()
            .any(|k| facts.var(k).map(|v| !v.is_empty()).unwrap_or(false)),
        Some(_) => true,
        None => false,
    }
}

/* ------------------------------- 版本排序 ------------------------------- */

/// 版本化目录名倒序比较：数字段按数值比（`2024.1.10` 要压过 `2024.1.9`，纯字典序会搞反）。
pub fn version_cmp_desc(a: &str, b: &str) -> std::cmp::Ordering {
    cmp_numeric_aware(b, a)
}

#[derive(Debug, PartialEq, Eq)]
enum Tok {
    Num(u128),
    Txt(String),
}

fn tokenize(s: &str) -> Vec<Tok> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut digits = None::<bool>;
    for c in s.chars() {
        let is_digit = c.is_ascii_digit();
        if digits == Some(is_digit) {
            cur.push(c);
            continue;
        }
        if let Some(was_digit) = digits {
            out.push(finish(&cur, was_digit));
            cur.clear();
        }
        digits = Some(is_digit);
        cur.push(c);
    }
    if let Some(was_digit) = digits {
        out.push(finish(&cur, was_digit));
    }
    out
}

fn finish(s: &str, digits: bool) -> Tok {
    if digits {
        // 超长数字段（解析不了）退化成按长度比，绝不 panic
        Tok::Num(s.parse::<u128>().unwrap_or(u128::MAX))
    } else {
        Tok::Txt(s.to_string())
    }
}

/// 数字感知的升序比较（等价于 JS 的 `localeCompare(..., {numeric:true})` 的排序语义）。
fn cmp_numeric_aware(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    let (ta, tb) = (tokenize(a), tokenize(b));
    for (x, y) in ta.iter().zip(tb.iter()) {
        let ord = match (x, y) {
            (Tok::Num(x), Tok::Num(y)) => x.cmp(y),
            // 文本段按小写比：`en` 的 localeCompare 不看大小写，`G` 该排在 `O` 前面
            (Tok::Txt(x), Tok::Txt(y)) => x.to_ascii_lowercase().cmp(&y.to_ascii_lowercase()),
            (Tok::Num(_), Tok::Txt(_)) => Ordering::Less,
            (Tok::Txt(_), Tok::Num(_)) => Ordering::Greater,
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    ta.len().cmp(&tb.len())
}

/* -------------------------------- 主解析 -------------------------------- */

/// 把目录按这台机器解析一遍（保持菜单顺序）。
///
/// SSH 启动、未知平台 → 空表（DSH 同样返回空 Map，前端据此**不渲染按钮**）。
pub fn resolve_all(host: &dyn Host, facts: &Facts, timeout: Duration) -> Vec<Resolved> {
    let Some(_platform) = facts.platform else {
        return Vec::new();
    };
    if facts.ssh {
        return Vec::new();
    }
    let registry = RegistryView::new(host, facts, timeout);
    CATALOG
        .iter()
        .filter_map(|app| resolve_entry(host, facts, app, &registry))
        .collect()
}

/// 解析单条（启动时发现可执行文件没了 → 用它重新解析这一条）。
pub fn resolve_one(
    host: &dyn Host,
    facts: &Facts,
    id: &str,
    timeout: Duration,
) -> Option<Resolved> {
    let app = CATALOG.iter().find(|a| a.id == id)?;
    let registry = RegistryView::new(host, facts, timeout);
    resolve_entry(host, facts, app, &registry)
}

fn resolve_entry(
    host: &dyn Host,
    facts: &Facts,
    app: &'static AppEntry,
    registry: &RegistryView<'_>,
) -> Option<Resolved> {
    let platform = facts.platform?;
    for locator in spec_for(app, platform) {
        if let Some((launch, fallback, icon)) = locate(host, facts, locator, registry) {
            // Linux 的图标统一来自 desktop entry（DSH `extractAppIcon` 同样按平台分派）
            let icon = if platform == Platform::Linux {
                app.desktop_id.map(|id| IconSource::Desktop(id.to_string()))
            } else {
                icon
            };
            return Some(Resolved {
                id: app.id,
                launch,
                fallback,
                icon,
            });
        }
    }
    None
}

type Located = (LaunchSpec, Option<LaunchSpec>, Option<IconSource>);

fn argv(command: impl Into<String>, args: &[&str]) -> LaunchSpec {
    LaunchSpec::Argv {
        command: command.into(),
        args: args.iter().map(|s| s.to_string()).collect(),
        env: Vec::new(),
    }
}

fn locate(
    host: &dyn Host,
    facts: &Facts,
    locator: &Locator,
    registry: &RegistryView<'_>,
) -> Option<Located> {
    match *locator {
        Locator::Fixed { launch, icon_path } => {
            let launch = match launch {
                Launch::ShellOpen => LaunchSpec::ShellOpen,
                Launch::Argv { command, args } => argv(command, args),
            };
            let icon = icon_path.and_then(|p| expand_candidate(p, facts)).map(|p| {
                if facts.platform == Some(Platform::Darwin) {
                    IconSource::AppBundle(p)
                } else {
                    IconSource::Executable(p)
                }
            });
            Some((launch, None, icon))
        }
        Locator::App { fs_names } => {
            for root in &facts.app_roots {
                for name in fs_names {
                    let bundle = root.join(name);
                    if host.is_dir(&bundle) {
                        let display = bundle.to_string_lossy().into_owned();
                        return Some((
                            argv("open", &["-a", display.as_str()]),
                            None,
                            Some(IconSource::AppBundle(bundle)),
                        ));
                    }
                }
            }
            None
        }
        Locator::Xcode => {
            let developer = host.run("xcode-select", &["-p"], registry.timeout)?;
            let developer = PathBuf::from(developer.trim());
            let bundle = developer.parent()?.parent()?.to_path_buf();
            let is_app = bundle
                .extension()
                .map(|e| e.to_string_lossy() == "app")
                .unwrap_or(false);
            if !is_app || !host.is_dir(&bundle) {
                return None;
            }
            let display = bundle.to_string_lossy().into_owned();
            Some((
                argv("xed", &[]),
                Some(argv("open", &["-a", display.as_str()])),
                Some(IconSource::AppBundle(bundle)),
            ))
        }
        Locator::Cli {
            name,
            args,
            requires_desktop,
        } => {
            if requires_desktop && !can_open_native_path(facts) {
                return None;
            }
            let found = host.which(name)?;
            let icon = executable_icon(facts, &found);
            Some((argv(found.to_string_lossy().into_owned(), args), None, icon))
        }
        Locator::File { candidates, args } => {
            for candidate in candidates {
                let Some(path) = expand_candidate(candidate, facts) else {
                    continue;
                };
                if host.is_file(&path) {
                    let icon = executable_icon(facts, &path);
                    return Some((argv(path.to_string_lossy().into_owned(), args), None, icon));
                }
            }
            None
        }
        Locator::AppPaths { exe, args } => {
            let target = registry.read().app_paths.get(&exe.to_ascii_lowercase())?.clone();
            let path = PathBuf::from(&target);
            if !host.is_file(&path) {
                return None;
            }
            let icon = executable_icon(facts, &path);
            Some((argv(target, args), None, icon))
        }
        Locator::InstallRecord {
            display_prefix,
            rel_launcher,
            args,
        } => {
            let view = registry.read();
            for record in &view.install_records {
                if !record.display_name.starts_with(display_prefix) {
                    continue;
                }
                let Some(launcher) = record_launcher(host, record, rel_launcher, facts) else {
                    continue;
                };
                let icon = executable_icon(facts, &launcher);
                return Some((argv(launcher.to_string_lossy().into_owned(), args), None, icon));
            }
            None
        }
        Locator::Scan {
            root,
            name_prefix,
            rel_launcher,
            args,
        } => {
            let root = expand_candidate(root, facts)?;
            let mut entries: Vec<String> = host
                .read_dir(&root)?
                .into_iter()
                .filter(|e| e.starts_with(name_prefix))
                .collect();
            entries.sort_by(|a, b| version_cmp_desc(a, b));
            for entry in entries {
                let launcher = root.join(entry).join(rel_launcher);
                if host.is_file(&launcher) {
                    let icon = executable_icon(facts, &launcher);
                    return Some((argv(launcher.to_string_lossy().into_owned(), args), None, icon));
                }
            }
            None
        }
        Locator::GithubDesktop { root } => {
            let root = expand_candidate(root, facts)?;
            let mut versions: Vec<String> = host
                .read_dir(&root)?
                .into_iter()
                .filter(|e| e.starts_with("app-"))
                .collect();
            versions.sort_by(|a, b| version_cmp_desc(a, b));
            for version in versions {
                let dir = root.join(version);
                let executable = dir.join("GitHubDesktop.exe");
                let cli = dir.join("resources/app/cli.js");
                if host.is_file(&executable) && host.is_file(&cli) {
                    let cli_arg = cli.to_string_lossy().into_owned();
                    let mut spec = argv(executable.to_string_lossy().into_owned(), &[cli_arg.as_str(), "open"]);
                    if let LaunchSpec::Argv { env, .. } = &mut spec {
                        env.push(("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string()));
                    }
                    let icon = executable_icon(facts, &executable);
                    return Some((spec, None, icon));
                }
            }
            None
        }
        Locator::Desktop { desktop_id, args } => {
            let entry = find_desktop_entry(host, facts, desktop_id)?;
            let launcher = desktop_launcher(host, &entry)?;
            Some((argv(launcher.to_string_lossy().into_owned(), args), None, None))
        }
    }
}

/// Windows 的图标来自可执行文件本身；其它平台不由 locator 提供图标。
fn executable_icon(facts: &Facts, path: &Path) -> Option<IconSource> {
    (facts.platform == Some(Platform::Win32)).then(|| IconSource::Executable(path.to_path_buf()))
}

/// 把目录代入参数：参数里有 `{path}` 就替换，否则追加在末尾（DSH `launchArgs`）。
pub fn launch_args(args: &[String], path: &str) -> Vec<String> {
    if args.iter().any(|a| a.contains(PATH_TOKEN)) {
        args.iter()
            .map(|a| a.replace(PATH_TOKEN, path))
            .collect::<Vec<_>>()
    } else {
        let mut out = args.to_vec();
        out.push(path.to_string());
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::open_in_app::host::RealHost;
    use std::time::Duration;

    fn facts_for(platform: Platform) -> Facts {
        Facts {
            platform: Some(platform),
            home: PathBuf::from("/Users/x"),
            app_roots: vec![
                PathBuf::from("/Applications"),
                PathBuf::from("/Users/x/Applications"),
            ],
            ssh: false,
            env: [
                ("HOME", "/Users/x"),
                ("ProgramFiles", "C:\\Program Files"),
                ("LOCALAPPDATA", "C:\\Users\\x\\AppData\\Local"),
                ("SystemRoot", "C:\\Windows"),
                ("PATH", "/usr/bin:/bin"),
            ]
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        }
    }

    /* ---------- 脚本化假宿主：三条平台链都能在任何机器上被验证 ---------- */

    #[derive(Default)]
    struct FakeHost {
        dirs: Vec<String>,
        files: Vec<String>,
        texts: HashMap<String, String>,
        bins: HashMap<String, String>,
        runs: HashMap<String, String>,
        seen_runs: RefCell<Vec<String>>,
    }

    impl FakeHost {
        fn dir(mut self, p: &str) -> Self {
            self.dirs.push(p.to_string());
            self
        }
        fn file(mut self, p: &str) -> Self {
            self.files.push(p.to_string());
            self
        }
        fn text(mut self, p: &str, body: &str) -> Self {
            self.texts.insert(p.to_string(), body.to_string());
            self
        }
        fn bin(mut self, name: &str, path: &str) -> Self {
            self.bins.insert(name.to_string(), path.to_string());
            self
        }
        fn run_out(mut self, cmdline: &str, stdout: &str) -> Self {
            self.runs.insert(cmdline.to_string(), stdout.to_string());
            self
        }
        fn runs(&self) -> Vec<String> {
            self.seen_runs.borrow().clone()
        }
    }

    impl Host for FakeHost {
        fn is_dir(&self, path: &Path) -> bool {
            self.dirs.iter().any(|d| norm(d) == norm(&path.to_string_lossy()))
        }
        fn is_file(&self, path: &Path) -> bool {
            let p = norm(&path.to_string_lossy());
            self.files.iter().any(|f| norm(f) == p) || self.texts.keys().any(|t| norm(t) == p)
        }
        fn read_dir(&self, path: &Path) -> Option<Vec<String>> {
            let prefix = format!("{}/", norm(&path.to_string_lossy()));
            let mut names: Vec<String> = self
                .dirs
                .iter()
                .chain(self.files.iter())
                .chain(self.texts.keys())
                .filter_map(|p| norm(p).strip_prefix(&prefix).map(str::to_string))
                .filter(|rest| !rest.is_empty() && !rest.contains('/'))
                .collect();
            names.sort();
            names.dedup();
            (!names.is_empty()).then_some(names)
        }
        fn read_file(&self, path: &Path) -> Option<String> {
            let p = norm(&path.to_string_lossy());
            self.texts.iter().find(|(k, _)| norm(k) == p).map(|(_, v)| v.clone())
        }
        fn read_bytes(&self, path: &Path) -> Option<Vec<u8>> {
            self.read_file(path).map(String::into_bytes)
        }
        fn which(&self, name: &str) -> Option<PathBuf> {
            self.bins.get(name).map(PathBuf::from)
        }
        fn run(&self, command: &str, args: &[&str], _timeout: Duration) -> Option<String> {
            let key = format!("{} {}", command, args.join(" "));
            self.seen_runs.borrow_mut().push(key.clone());
            self.runs.get(&key).cloned()
        }
    }

    /// 假宿主按**归一化斜杠**比较：夹具可以照实写 Windows 反斜杠路径，
    /// 而在 macOS/Linux 上 `Path::join` 只会补 `/`（真实 Windows 上两者等价）。
    fn norm(p: &str) -> String {
        p.replace('\\', "/")
    }

    fn ids(resolved: &[Resolved]) -> Vec<&str> {
        resolved.iter().map(|r| r.id).collect()
    }

    /* ------------------------------ 纯函数 ------------------------------ */

    #[test]
    fn expand_candidate_handles_vars_and_tilde() {
        let facts = facts_for(Platform::Darwin);
        assert_eq!(
            expand_candidate("~/Applications", &facts),
            Some(PathBuf::from("/Users/x/Applications"))
        );
        assert_eq!(
            expand_candidate("${ProgramFiles}/X/x.exe", &facts),
            Some(PathBuf::from("C:\\Program Files/X/x.exe"))
        );
        assert_eq!(expand_candidate("${NOPE}/x", &facts), None); // 未设置的变量 = 未设置，不是空串
        assert_eq!(expand_candidate("/plain", &facts), Some(PathBuf::from("/plain")));
    }

    #[test]
    fn expand_registry_value_handles_percent_vars() {
        let facts = facts_for(Platform::Win32);
        assert_eq!(
            expand_registry_value("%LOCALAPPDATA%\\Programs\\X", &facts).as_deref(),
            Some("C:\\Users\\x\\AppData\\Local\\Programs\\X")
        );
        assert_eq!(expand_registry_value("%NOPE%\\X", &facts), None);
        assert_eq!(expand_registry_value("C:\\plain", &facts).as_deref(), Some("C:\\plain"));
    }

    #[test]
    fn launch_args_substitutes_or_appends() {
        let args = vec!["--working-directory={path}".to_string()];
        assert_eq!(launch_args(&args, "/proj"), vec!["--working-directory=/proj"]);
        let args = vec!["-a".to_string(), "/Applications/X.app".to_string()];
        assert_eq!(launch_args(&args, "/proj"), vec!["-a", "/Applications/X.app", "/proj"]);
        assert_eq!(launch_args(&[], "/proj"), vec!["/proj"]);
    }

    /// `reg.exe` 输出的真实形状（含本地化默认值标记与 REG_EXPAND_SZ）。
    #[test]
    fn parse_registry_dump_matches_reg_exe_shape() {
        let dump = "\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe\r\n    (Default)    REG_SZ    C:\\Users\\x\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe\r\n    Path    REG_SZ    C:\\x\r\n\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\cursor.exe\r\n    (默认)    REG_EXPAND_SZ    %LOCALAPPDATA%\\Programs\\cursor\\Cursor.exe\r\n";
        let keys = parse_registry_dump(dump);
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].0, "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe");
        assert!(keys[0].1.get("(Default)").unwrap().ends_with("Code.exe"));
        // 本地化的默认值标记也归一成 (Default)
        assert!(keys[1].1.contains_key("(Default)"));
    }

    #[test]
    fn parse_desktop_entry_reads_only_the_entry_section() {
        let text = "[Desktop Entry]\nType=Application\nExec=/usr/bin/code --unity-launch %F\nTryExec=code\nIcon=vscode\n\n[Desktop Action new]\nExec=/usr/bin/code --new-window\nIcon=ignored\n";
        let entry = parse_desktop_entry(text);
        assert_eq!(entry.exec.as_deref(), Some("/usr/bin/code --unity-launch %F"));
        assert_eq!(entry.try_exec.as_deref(), Some("code"));
        assert_eq!(entry.icon.as_deref(), Some("vscode"));
        assert_eq!(exec_command(entry.exec.as_deref().unwrap()).as_deref(), Some("/usr/bin/code"));
        // 带引号的路径
        assert_eq!(exec_command("\"/opt/My App/bin/x\" --flag").as_deref(), Some("/opt/My App/bin/x"));
    }

    #[test]
    fn version_sort_is_numeric_aware_and_descending() {
        let mut names = vec![
            "GoLand 2024.1.9",
            "GoLand 2024.1.10",
            "GoLand 2023.3",
            "GoLand 2024.2",
        ];
        names.sort_by(|a, b| version_cmp_desc(a, b));
        assert_eq!(
            names,
            vec![
                "GoLand 2024.2",
                "GoLand 2024.1.10",
                "GoLand 2024.1.9",
                "GoLand 2023.3"
            ]
        );
        // 纯字典序会把 "2024.1.9" 排在 "2024.1.10" 前面 —— 这就是必须数值感知的理由
        let mut lexicographic = names.clone();
        lexicographic.sort_by(|a, b| b.cmp(a));
        assert_ne!(lexicographic, names);
        assert_eq!(
            version_cmp_desc("app-2.10.0", "app-2.9.0"),
            std::cmp::Ordering::Less // "2.10" 比 "2.9" 新 → 排前面
        );
    }

    #[test]
    fn xdg_dirs_honour_the_environment() {
        let mut facts = facts_for(Platform::Linux);
        facts.env.insert("XDG_DATA_DIRS".into(), "/a:/b".into());
        assert_eq!(
            xdg_data_directories(&facts),
            vec![
                PathBuf::from("/Users/x/.local/share"),
                PathBuf::from("/a"),
                PathBuf::from("/b")
            ]
        );
        facts.env.insert("XDG_DATA_HOME".into(), "/custom".into());
        assert_eq!(xdg_data_directories(&facts)[0], PathBuf::from("/custom"));
    }

    #[test]
    fn xdg_open_needs_a_display_server() {
        let mut facts = facts_for(Platform::Linux);
        assert!(!can_open_native_path(&facts));
        facts.env.insert("WAYLAND_DISPLAY".into(), "wayland-0".into());
        assert!(can_open_native_path(&facts));
        // macOS/Windows 恒为真
        assert!(can_open_native_path(&facts_for(Platform::Darwin)));
    }

    /* ------------------------------ macOS 链 ------------------------------ */

    #[test]
    fn macos_resolves_bundles_in_order_and_skips_missing() {
        let facts = facts_for(Platform::Darwin);
        let host = FakeHost::default()
            .dir("/Applications/Xcode.app")
            .dir("/Applications/Visual Studio Code.app")
            .dir("/Applications/iTerm.app")
            .dir("/Applications/Fork.app")
            .dir("/Applications/GoLand.app")
            .run_out("xcode-select -p", "/Applications/Xcode.app/Contents/Developer\n");
        let resolved = resolve_all(&host, &facts, Duration::from_secs(1));
        let got = ids(&resolved);
        assert!(got.contains(&"vscode"));
        assert!(got.contains(&"iterm"));
        assert!(got.contains(&"fork"));
        assert!(got.contains(&"goland"));
        assert!(got.contains(&"xcode"));
        // 菜单顺序 = 目录顺序（Finder 恒在、终端恒在）
        assert_eq!(got[0], "finder");
        assert!(got.contains(&"terminal"));
        // 没装的绝不出现
        assert!(!got.contains(&"cursor"));
        assert!(!got.contains(&"zed"));
        // 装了 VS Code 就该有它的 bundle 图标 + `open -a <bundle>`
        let vscode = resolved.iter().find(|r| r.id == "vscode").unwrap();
        assert_eq!(vscode.launch.describe(), "open -a /Applications/Visual Studio Code.app");
        assert_eq!(
            vscode.icon,
            Some(IconSource::AppBundle(PathBuf::from("/Applications/Visual Studio Code.app")))
        );
        // Xcode 有回退：xed 失败 → open -a
        let xcode = resolved.iter().find(|r| r.id == "xcode").unwrap();
        assert_eq!(xcode.launch.describe(), "xed");
        assert_eq!(
            xcode.fallback.as_ref().map(LaunchSpec::describe).as_deref(),
            Some("open -a /Applications/Xcode.app")
        );
    }

    #[test]
    fn macos_user_applications_is_searched_too() {
        let facts = facts_for(Platform::Darwin);
        let host = FakeHost::default().dir("/Users/x/Applications/Zed.app");
        let resolved = resolve_all(&host, &facts, Duration::from_secs(1));
        let zed = resolved.iter().find(|r| r.id == "zed").unwrap();
        assert_eq!(zed.launch.describe(), "open -a /Users/x/Applications/Zed.app");
    }

    #[test]
    fn xcode_absent_when_xcode_select_fails() {
        let facts = facts_for(Platform::Darwin);
        let host = FakeHost::default(); // 没有 xcode-select 输出
        let resolved = resolve_all(&host, &facts, Duration::from_secs(1));
        assert!(!ids(&resolved).contains(&"xcode"));
    }

    /// `xcode-select -p` 指向的不是 `.app` 里面（比如 CommandLineTools）→ 不算数。
    #[test]
    fn xcode_ignores_a_developer_dir_outside_a_bundle() {
        let facts = facts_for(Platform::Darwin);
        let host = FakeHost::default().run_out(
            "xcode-select -p",
            "/Library/Developer/CommandLineTools\n",
        );
        let resolved = resolve_all(&host, &facts, Duration::from_secs(1));
        assert!(!ids(&resolved).contains(&"xcode"));
    }

    #[test]
    fn ssh_launch_reports_nothing() {
        let mut facts = facts_for(Platform::Darwin);
        facts.ssh = true;
        let host = FakeHost::default().dir("/Applications/Visual Studio Code.app");
        assert!(resolve_all(&host, &facts, Duration::from_secs(1)).is_empty());
    }

    #[test]
    fn unknown_platform_reports_nothing() {
        let mut facts = facts_for(Platform::Darwin);
        facts.platform = None;
        let host = FakeHost::default().dir("/Applications/Visual Studio Code.app");
        assert!(resolve_all(&host, &facts, Duration::from_secs(1)).is_empty());
    }

    #[test]
    fn fixed_entries_always_resolve_on_macos() {
        let facts = facts_for(Platform::Darwin);
        let resolved = resolve_all(&FakeHost::default(), &facts, Duration::from_secs(1));
        let finder = resolved.iter().find(|r| r.id == "finder").unwrap();
        assert_eq!(finder.launch, LaunchSpec::ShellOpen);
        assert_eq!(
            finder.icon,
            Some(IconSource::AppBundle(PathBuf::from("/System/Library/CoreServices/Finder.app")))
        );
        let terminal = resolved.iter().find(|r| r.id == "terminal").unwrap();
        assert_eq!(terminal.launch.describe(), "open -a Terminal");
    }

    /* ------------------------------ Windows 链 ------------------------------ */

    #[test]
    fn windows_reads_app_paths_and_uninstall_records() {
        let facts = facts_for(Platform::Win32);
        let dump = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe\r\n    (Default)    REG_SZ    C:\\Program Files\\Microsoft VS Code\\Code.exe\r\n";
        let uninstall = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\GoLand\r\n    DisplayName    REG_SZ    GoLand 2024.1\r\n    InstallLocation    REG_SZ    C:\\Program Files\\JetBrains\\GoLand 2024.1\r\n";
        let host = FakeHost::default()
            .file("C:\\Program Files\\Microsoft VS Code\\Code.exe")
            .file("C:\\Program Files\\JetBrains\\GoLand 2024.1\\bin\\goland64.exe")
            .run_out(
                "reg.exe query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths /s",
                dump,
            )
            .run_out(
                "reg.exe query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s",
                uninstall,
            )
            .run_out("reg.exe query HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s", "");
        let resolved = resolve_all(&host, &facts, Duration::from_secs(1));
        let vscode = resolved.iter().find(|r| r.id == "vscode").unwrap();
        assert_eq!(vscode.launch.describe(), "C:\\Program Files\\Microsoft VS Code\\Code.exe");
        let goland = resolved.iter().find(|r| r.id == "goland").unwrap();
        assert!(goland.launch.describe().ends_with("goland64.exe"));
        // 注册表每个根**只读一次**（3 个卸载根 + 2 个 App Paths 根 = 5 条命令）
        let runs = host.runs();
        assert_eq!(runs.iter().filter(|r| r.contains("App Paths")).count(), 2);
        assert_eq!(runs.iter().filter(|r| r.contains("Uninstall")).count(), 3);
        // 没有 Windows Terminal / Explorer 的 CLI 时它们不该出现
        assert!(!ids(&resolved).contains(&"windowsterminal"));
    }

    /// 光有卸载记录、磁盘上没有 exe → 不算装（"声明的 ≠ 可用的"）。
    #[test]
    fn windows_install_record_without_the_executable_is_rejected() {
        let facts = facts_for(Platform::Win32);
        let uninstall = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fork\r\n    DisplayName    REG_SZ    Fork\r\n    InstallLocation    REG_SZ    C:\\Users\\x\\AppData\\Local\\Fork\r\n";
        let host = FakeHost::default()
            .run_out(
                "reg.exe query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s",
                uninstall,
            )
            .run_out("reg.exe query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths /s", "")
            .run_out("reg.exe query HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths /s", "")
            .run_out("reg.exe query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s", "")
            .run_out("reg.exe query HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall /s", "");
        let resolved = resolve_all(&host, &facts, Duration::from_secs(1));
        assert!(!ids(&resolved).contains(&"fork"));
    }

    #[test]
    fn windows_scan_picks_the_newest_version_directory() {
        let facts = facts_for(Platform::Win32);
        let host = FakeHost::default()
            .dir("C:\\Program Files/JetBrains/PyCharm 2024.1.9")
            .dir("C:\\Program Files/JetBrains/PyCharm 2024.1.10")
            .file("C:\\Program Files/JetBrains/PyCharm 2024.1.9/bin/pycharm64.exe")
            .file("C:\\Program Files/JetBrains/PyCharm 2024.1.10/bin/pycharm64.exe");
        let resolved = resolve_all(&host, &facts, Duration::from_secs(1));
        let pycharm = resolved.iter().find(|r| r.id == "pycharm").unwrap();
        // 数值感知：2024.1.10 压过 2024.1.9（纯字典序会选错）
        assert!(
            pycharm.launch.describe().contains("2024.1.10"),
            "选错了版本: {}",
            pycharm.launch.describe()
        );
    }

    /* ------------------------------ Linux 链 ------------------------------ */

    #[test]
    fn linux_uses_path_cli_and_desktop_entries() {
        let mut facts = facts_for(Platform::Linux);
        facts.env.insert("XDG_DATA_DIRS".into(), "/usr/share".into());
        facts.env.insert("DISPLAY".into(), ":0".into());
        let code_entry = "[Desktop Entry]\nExec=/usr/share/code/code --unity-launch %F\nTryExec=/usr/share/code/code\nIcon=vscode\n";
        let host = FakeHost::default()
            .bin("code", "/usr/bin/code")
            .bin("xdg-open", "/usr/bin/xdg-open")
            .bin("kitty", "/usr/bin/kitty")
            .text("/usr/share/applications/kitty.desktop", "[Desktop Entry]\nExec=kitty\nIcon=kitty\n")
            .text("/Users/x/.local/share/applications/code.desktop", code_entry);
        let resolved = resolve_all(&host, &facts, Duration::from_secs(1));
        let got = ids(&resolved);
        assert!(got.contains(&"vscode"));
        assert!(got.contains(&"kitty"));
        assert!(got.contains(&"filemanager"));
        // 图标走 desktop entry（Linux 平台统一）
        let vscode = resolved.iter().find(|r| r.id == "vscode").unwrap();
        assert_eq!(vscode.icon, Some(IconSource::Desktop("code".to_string())));
    }

    #[test]
    fn linux_hides_xdg_open_without_a_display() {
        let facts = facts_for(Platform::Linux); // 无 DISPLAY/WAYLAND_DISPLAY
        let host = FakeHost::default().bin("xdg-open", "/usr/bin/xdg-open");
        let resolved = resolve_all(&host, &facts, Duration::from_secs(1));
        assert!(!ids(&resolved).contains(&"filemanager"));
    }

    /// `TryExec` 指向的文件不在 → 落到 `Exec` 首 token；两个都不在 → 该条不算装。
    #[test]
    fn linux_desktop_entry_falls_back_from_tryexec_to_exec() {
        let mut facts = facts_for(Platform::Linux);
        facts.env.insert("DISPLAY".into(), ":0".into());
        let host = FakeHost::default()
            .file("/opt/zed/bin/zed")
            .bin("zed", "/opt/zed/bin/zed")
            .text(
                "/Users/x/.local/share/applications/dev.zed.Zed.desktop",
                "[Desktop Entry]\nTryExec=/opt/zed/bin/zed\nExec=zed %F\nIcon=zed\n",
            );
        let resolved = resolve_all(&host, &facts, Duration::from_secs(1));
        let zed = resolved.iter().find(|r| r.id == "zed").unwrap();
        assert_eq!(zed.launch.describe(), "/opt/zed/bin/zed");
    }

    /* ---------------------------- 真机（本机）核对 ---------------------------- */

    /// **DSH 目录的 macOS bundle 拼写金标**（逐字抄自 `dsh-host-open-in-app` 的 `catalog.ts`）。
    ///
    /// 为什么要在这里再抄一遍：光有"解析出来的启动器都存在"是**循环论证** ——
    /// 把 `iTerm.app` 写成 `iTerm2.app`，正向测试照样全绿（那个 bundle 只是"没装"），
    /// 而本机明明装了 iTerm 的用户再也看不到它。这份金标与被测数据相互独立，
    /// 所以拼写漂移会当场变红。
    const DSH_MAC_BUNDLES: &[(&str, &[&str])] = &[
        ("cursor", &["Cursor.app"]),
        ("vscode", &["Visual Studio Code.app"]),
        ("vscodeinsiders", &["Visual Studio Code - Insiders.app"]),
        ("windsurf", &["Windsurf.app"]),
        ("zed", &["Zed.app", "Zed Preview.app"]),
        ("sublimetext", &["Sublime Text.app"]),
        ("androidstudio", &["Android Studio.app"]),
        ("intellij", &[
            "IntelliJ IDEA.app",
            "IntelliJ IDEA Ultimate.app",
            "IntelliJ IDEA CE.app",
        ]),
        ("pycharm", &[
            "PyCharm.app",
            "PyCharm Professional.app",
            "PyCharm CE.app",
            "PyCharm Community.app",
        ]),
        ("webstorm", &["WebStorm.app"]),
        ("phpstorm", &["PhpStorm.app"]),
        ("goland", &["GoLand.app"]),
        ("rider", &["Rider.app", "JetBrains Rider.app"]),
        ("rustrover", &["RustRover.app"]),
        ("fork", &["Fork.app"]),
        ("sourcetree", &["Sourcetree.app"]),
        ("github", &["GitHub Desktop.app"]),
        ("tower", &["Tower.app"]),
        ("gitkraken", &["GitKraken.app"]),
        ("smartgit", &["SmartGit.app"]),
        ("sublimemerge", &["Sublime Merge.app"]),
        ("ghostty", &["Ghostty.app"]),
        ("warp", &["Warp.app"]),
        ("iterm", &["iTerm.app"]),
        ("kitty", &["kitty.app"]),
    ];

    #[test]
    fn macos_bundle_names_match_the_dsh_catalog() {
        for (id, want) in DSH_MAC_BUNDLES {
            let app = CATALOG
                .iter()
                .find(|a| a.id == *id)
                .unwrap_or_else(|| panic!("目录里没有 {id}"));
            let declared: Vec<&str> = app
                .darwin
                .iter()
                .flat_map(|l| match l {
                    Locator::App { fs_names } => fs_names.to_vec(),
                    _ => Vec::new(),
                })
                .collect();
            assert_eq!(&declared, want, "{id} 的 macOS bundle 拼写与 DSH 目录不一致");
        }
    }

    /// **反向核对**：金标里那些 bundle，本机 `/Applications` 里真实存在的，必须都被解析出来。
    /// 正向那条只证明"解析出来的都存在"，证明不了"装了的都没漏"。
    #[test]
    fn every_installed_catalog_bundle_resolves() {
        let facts = Facts::detect();
        if facts.platform != Some(Platform::Darwin) {
            return;
        }
        let host = RealHost::new(facts.clone());
        let resolved = resolve_all(&host, &facts, Duration::from_secs(10));
        let got = ids(&resolved);
        let mut installed = 0;
        for (id, bundles) in DSH_MAC_BUNDLES {
            if bundles
                .iter()
                .any(|n| facts.app_roots.iter().any(|root| root.join(n).is_dir()))
            {
                installed += 1;
                assert!(
                    got.contains(id),
                    "本机装了 {id}（{}），却没被解析出来 —— 定位链断了？",
                    bundles.join(" / ")
                );
            }
        }
        assert!(installed >= 1, "本机一个金标应用都没装？这条核对会退化成空转");
        eprintln!("反向核对：本机装了 {installed} 个金标应用，全部解析到了");
    }

    /// 不是"这段代码看起来对"，而是**在这台机器上真的解析一遍**：
    /// Finder / Terminal 恒在；解析出来的每一个启动器都必须真实存在于磁盘。
    #[test]
    fn real_macos_host_resolves_and_every_launcher_exists() {
        let facts = Facts::detect();
        if facts.platform != Some(Platform::Darwin) {
            return; // 非 macOS 机器上这条不适用
        }
        let host = RealHost::new(facts.clone());
        let resolved = resolve_all(&host, &facts, Duration::from_secs(10));
        assert!(resolved.len() >= 2, "至少 Finder + Terminal，实际 {}", resolved.len());
        assert_eq!(resolved[0].id, "finder");
        for r in &resolved {
            match &r.launch {
                LaunchSpec::ShellOpen => {}
                LaunchSpec::Argv { command, args, .. } => {
                    // 命令要么是 PATH 上的名字（open/xed），要么是绝对路径且存在
                    let path = Path::new(command);
                    if path.is_absolute() {
                        assert!(path.exists(), "{} 的启动器不存在: {command}", r.id);
                    } else {
                        assert!(
                            ["open", "xed"].contains(&command.as_str()),
                            "{} 用了意外的 PATH 命令: {command}",
                            r.id
                        );
                    }
                    let _ = args;
                }
            }
            if let Some(IconSource::AppBundle(bundle)) = &r.icon {
                assert!(bundle.is_dir(), "{} 的图标 bundle 不存在: {}", r.id, bundle.display());
            }
        }
    }
}
