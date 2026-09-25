//! 插件盘点（docs/03 §2.15）：把 pi **实际会加载哪些插件**还原成一张表。
//!
//! ## pi 的插件来源（读源码确认）
//!
//! pi 里没有单一"插件"实体，能进 `extensions/` 的东西有四个来源，
//! 加载优先级由 `resourcePrecedenceRank` 决定（`core/package-manager.ts:176-192`）：
//!
//! | rank | 来源 | 基准目录 | 谁写的 |
//! |---|---|---|---|
//! | 0 | 项目 settings 的 `extensions[]` | `<cwd>/.pi` | 手工 / 本项目 |
//! | 1 | 项目发现目录 `.pi/extensions/` | `<cwd>/.pi` | 往目录里放文件 |
//! | 2 | 全局 settings 的 `extensions[]` | `~/.pi/agent` | 手工 |
//! | 3 | 全局发现目录 `~/.pi/agent/extensions/` | `~/.pi/agent` | 往目录里放文件 |
//! | 4 | 包（`packages[]`，npm/git/本地） | 安装根 | `pi install / remove` |
//!
//! 另有 `-e/--extension` 的 CLI 路径排在所有来源之前，以及 **pi 内置扩展**
//! （`src/extensions/index.ts` 的 `builtInExtensions`，随 pi 发布、不可增删）。
//!
//! 同一路径被多个来源命中时**保留 rank 最小的一条**（`package-manager.ts:2585-2593`）。
//!
//! ## 发现目录识别规则（`loader.ts:670-744`）
//!
//! 只扫一层：直接文件 `*.ts`/`*.js`；子目录有 `package.json` 的 `pi.extensions[]` 按它加载；
//! 否则子目录有 `index.ts`/`index.js` 就加载；都不满足 = 不是扩展。
//!
//! ## 启用/停用：pi 用**通配符**表达，不是布尔开关
//!
//! 这是最容易搞错的一处。pi 没有 `enabled` 字段，停用靠 settings 里的资源通配符
//! （`package-manager.ts:707-780`，语义在 `docs/settings.md` 的 Resources 一节）：
//!
//! | 写法 | 含义 | 匹配方式 |
//! |---|---|---|
//! | `path` | 声明一个资源 | 路径 |
//! | `!glob` | 排除 | minimatch（对 相对路径/文件名/绝对路径 三者取或） |
//! | `+path` | 强制包含（压过 `!`） | **精确**相等 |
//! | `-path` | 强制排除（压过 `+`） | **精确**相等 |
//!
//! 判定顺序固定为 `!` → `+` → `-`，后者覆盖前者（`isEnabledByOverrides`，
//! `package-manager.ts:712-728`）。**每个来源只受自己那个作用域的通配符影响**：
//! 全局的 `-x` 管不到项目发现目录里的文件（`addAutoDiscoveredResources` 按作用域分别调用）。
//!
//! 所以界面上的"停用"就是往对应作用域的 `extensions[]` 里写一条 `-<相对路径>`，
//! 而不是编一个 pi 不认的开关——否则终端里的 `pi` 与 Piggy 显示的状态会不一致。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::config::pi_files;

/// 条目类型（决定图标、可做的操作）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// `settings.json` 的 `packages[]`（npm / git / 本地路径，`pi install` 写入）
    Package,
    /// `settings.json` 的 `extensions[]` 里显式登记的路径
    Path,
    /// 发现目录里扫出来的文件/目录
    Discovered,
    /// `-e` 传入的路径（本次运行的临时加载）
    Cli,
    /// pi 内置（随 pi 发布，不可增删）
    Builtin,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Package => "package",
            Self::Path => "path",
            Self::Discovered => "discovered",
            Self::Cli => "cli",
            Self::Builtin => "builtin",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Package => "插件包",
            Self::Path => "登记路径",
            Self::Discovered => "发现目录",
            Self::Cli => "命令行加载",
            Self::Builtin => "pi 内置",
        }
    }
}

/// 来源协议。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SourceKind {
    Npm,
    Git,
    Local,
    Discovered,
    Cli,
    Builtin,
}

impl SourceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Npm => "npm",
            Self::Git => "git",
            Self::Local => "local",
            Self::Discovered => "discovered",
            Self::Cli => "cli",
            Self::Builtin => "builtin",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Npm => "npm 包",
            Self::Git => "git 仓库",
            Self::Local => "本地路径",
            Self::Discovered => "发现目录",
            Self::Cli => "命令行",
            Self::Builtin => "内置",
        }
    }
}

/// 作用域。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Scope {
    Project,
    Global,
    Builtin,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Global => "global",
            Self::Builtin => "builtin",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::Project => "本项目",
            Self::Global => "全局",
            Self::Builtin => "pi 内置",
        }
    }
    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim() {
            "project" => Ok(Self::Project),
            "global" => Ok(Self::Global),
            _ => Err(format!("未知作用域 {s:?}（可选：project / global）")),
        }
    }
}

/* ============================ 目录 ============================ */

/// 一个作用域在磁盘上的位置。
#[derive(Debug, Clone)]
pub struct ScopeDirs {
    pub agent_dir: PathBuf,
    pub cwd: PathBuf,
}

impl ScopeDirs {
    pub fn new(agent_dir: PathBuf, cwd: PathBuf) -> Self {
        Self { agent_dir, cwd }
    }

    /// 全局基准目录 `~/.pi/agent`；项目基准目录 `<cwd>/.pi`。
    /// `PI_CODING_AGENT_DIR` 覆盖全局目录（`config.ts:528-534` 的 `getAgentDir`）。
    pub fn base_dir(&self, scope: Scope) -> PathBuf {
        match scope {
            Scope::Project => self.cwd.join(".pi"),
            _ => self.agent_dir.clone(),
        }
    }

    pub fn settings_path(&self, scope: Scope) -> PathBuf {
        self.base_dir(scope).join("settings.json")
    }

    /// npm 包安装根（`package-manager.ts:2025-2034`）。
    pub fn npm_root(&self, scope: Scope) -> PathBuf {
        self.base_dir(scope).join("npm")
    }

    /// git 包安装根（`package-manager.ts:2105-2114`）。
    pub fn git_root(&self, scope: Scope) -> PathBuf {
        self.base_dir(scope).join("git")
    }

    /// 自动发现目录（`package-manager.ts:2381-2384`）。
    pub fn discovery_dir(&self, scope: Scope) -> PathBuf {
        self.base_dir(scope).join("extensions")
    }
}

/// 全局 agent 目录：`PI_CODING_AGENT_DIR` 优先，否则 `~/.pi/agent`。
///
/// pi 自己的名字是 `PI_CODING_AGENT_DIR`（`config.ts:502-508`：
/// `ENV_AGENT_DIR = ${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`）。
/// 注意 `config/pi_files.rs` 目前只看 `$HOME`——那边管的是 models/auth，
/// 这里管插件，两边对"agent 目录在哪"必须给同一个答案，所以本模块自己解析。
pub fn agent_dir() -> PathBuf {
    if let Some(dir) = std::env::var_os("PI_CODING_AGENT_DIR") {
        let p = PathBuf::from(dir);
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    pi_files::agent_dir()
}

pub fn read_settings(dirs: &ScopeDirs, scope: Scope) -> Result<Value, String> {
    pi_files::read_json(&dirs.settings_path(scope))
}

pub fn write_settings(dirs: &ScopeDirs, scope: Scope, v: &Value) -> Result<(), String> {
    pi_files::write_json_atomic(&dirs.settings_path(scope), v)
}

/* ============================ 路径工具 ============================ */

/// 相对路径，统一用 `/`（pi 全程 `toPosixPath`，Windows 上也用 `/` 比通配符）。
fn rel_posix(base: &Path, path: &Path) -> String {
    let b: Vec<_> = base.components().collect();
    let p: Vec<_> = path.components().collect();
    let common = b.iter().zip(p.iter()).take_while(|(x, y)| x == y).count();
    if common == 0 {
        return path.to_string_lossy().replace('\\', "/");
    }
    let mut out: Vec<String> = Vec::new();
    for _ in common..b.len() {
        out.push("..".to_string());
    }
    for c in &p[common..] {
        out.push(c.as_os_str().to_string_lossy().into_owned());
    }
    out.join("/")
}

/// 词法规范化（不碰文件系统，允许路径不存在）。
fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            std::path::Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/* ============================ 来源解析 ============================ */

/// 来源协议判定，与 pi 的 `isLocalPath`（`utils/paths.ts:51-63`）同一份前缀表。
pub fn classify(source: &str) -> SourceKind {
    let s = source.trim();
    if s.starts_with("npm:") {
        SourceKind::Npm
    } else if s.starts_with("git:")
        || s.starts_with("github:")
        || s.starts_with("http:")
        || s.starts_with("https:")
        || s.starts_with("ssh://")
        || s.starts_with("git://")
    {
        SourceKind::Git
    } else {
        SourceKind::Local
    }
}

/// 本地来源相对**设置文件所在目录**解析（pi 的 `resolvePath(p, baseDir)`）。
/// 实测：`pi install /Users/…/pi-guardrails` 进 settings.json 的是相对 agent 目录的
/// `../../../../../Users/…/pi-guardrails`。
pub fn resolve_local(source: &str, base_dir: &Path) -> PathBuf {
    let p = pi_files::expand_home(source.trim());
    if p.is_absolute() {
        normalize(&p)
    } else {
        normalize(&base_dir.join(p))
    }
}

/// npm 来源 → 包名。`npm:@scope/name@1.2.3` → `@scope/name`。
pub fn npm_package_name(source: &str) -> Option<String> {
    let spec = source.trim().strip_prefix("npm:")?.trim();
    if spec.is_empty() {
        return None;
    }
    match spec.strip_prefix('@') {
        Some(rest) => {
            let (scope, tail) = rest.split_once('/')?;
            let name = tail.split('@').next().unwrap_or(tail);
            if scope.is_empty() || name.is_empty() {
                None
            } else {
                Some(format!("@{scope}/{name}"))
            }
        }
        None => {
            let name = spec.split('@').next().unwrap_or(spec);
            if name.is_empty() {
                None
            } else {
                Some(name.to_string())
            }
        }
    }
}

/// git 来源 → `(host, path)`。`git:github.com/u/r#v1` → `("github.com","u/r")`。
pub fn git_host_path(source: &str) -> Option<(String, String)> {
    let s = source.trim();
    let rest = s
        .strip_prefix("git:")
        .or_else(|| s.strip_prefix("github:"))
        .or_else(|| s.strip_prefix("https://"))
        .or_else(|| s.strip_prefix("http://"))
        .or_else(|| s.strip_prefix("git://"))
        .or_else(|| s.strip_prefix("ssh://"))
        .unwrap_or(s);
    let rest = rest.split('#').next().unwrap_or(rest);
    // 去掉 `user@`：scp 形态（`git@github.com:owner/repo`）与 URL 形态（`ssh://git@host/...`）
    // 都会带。只切第一个 `@`，因为 `@` 不会出现在 host 里。
    let rest = match rest.split_once('@') {
        Some((_, after)) => after,
        None => rest,
    };
    // scp 形态的 `host:owner/repo`：冒号在第一个 `/` **之前**才是 host 分隔符
    // （`github.com/owner/repo` 里没有冒号；`host:8080/x` 这种带端口的这里不处理，
    // pi 的 parseGitUrl 也不支持端口形态）。
    let (host, path) = match (rest.find(':'), rest.find('/')) {
        (Some(c), Some(sl)) if c < sl => (rest[..c].to_string(), rest[c + 1..].to_string()),
        _ => {
            let (h, p) = rest.split_once('/')?;
            (h.to_string(), p.to_string())
        }
    };
    let path = path.trim_end_matches('/').trim_end_matches(".git").to_string();
    if host.is_empty() || path.is_empty() {
        return None;
    }
    Some((host, path))
}

/// 包在磁盘上的落点（`package-manager.ts:2025-2114`）。
pub fn package_path(dirs: &ScopeDirs, scope: Scope, source: &str) -> PathBuf {
    match classify(source) {
        SourceKind::Npm => dirs
            .npm_root(scope)
            .join("node_modules")
            .join(npm_package_name(source).unwrap_or_default()),
        SourceKind::Git => match git_host_path(source) {
            Some((host, path)) => dirs.git_root(scope).join(host).join(path),
            None => dirs.git_root(scope).join("(无法解析)"),
        },
        _ => resolve_local(source, &dirs.base_dir(scope)),
    }
}

/* ============================ 扩展入口 ============================ */

/// 一个目录里实际会被加载的扩展入口。**与 pi 逐条对齐**（`loader.ts:670-700`）。
pub fn extension_entries(dir: &Path) -> Vec<PathBuf> {
    let manifest = dir.join("package.json");
    if let Ok(v) = pi_files::read_json(&manifest) {
        if let Some(list) = v.get("pi").and_then(|p| p.get("extensions")).and_then(|e| e.as_array()) {
            let declared: Vec<PathBuf> = list
                .iter()
                .filter_map(|e| e.as_str())
                .map(|rel| normalize(&dir.join(rel)))
                .filter(|p| p.exists())
                .collect();
            // pi：声明的入口一个都不存在时，回落到 index.ts/js（`loader.ts:683-697`）
            if !declared.is_empty() {
                return declared;
            }
        }
    }
    for name in ["index.ts", "index.js"] {
        let p = dir.join(name);
        if p.exists() {
            return vec![p];
        }
    }
    Vec::new()
}

fn is_extension_file(name: &str) -> bool {
    name.ends_with(".ts") || name.ends_with(".js")
}

/// 扫一个发现目录（**只扫一层**，`loader.ts:712-744`）。返回 `(路径, 是否目录)`。
/// 跳过 `node_modules` 与点文件——pi 的 `collectAutoExtensionEntries` 会跳（`package-manager.ts:213`）。
pub fn scan_discovery_dir(dir: &Path) -> Vec<(PathBuf, bool)> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in rd.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name == "node_modules" {
            continue;
        }
        let is_dir = std::fs::metadata(&path).map(|m| m.is_dir()).unwrap_or(false);
        if is_dir {
            if !extension_entries(&path).is_empty() {
                out.push((path, true));
            }
        } else if is_extension_file(&name) {
            out.push((path, false));
        }
    }
    out.sort();
    out
}

/* ============================ 通配符 ============================ */

/// 极简 minimatch：`*` 不跨 `/`，`**` 跨，`?` 单字符。
/// pi 用的是完整 minimatch（`package-manager.ts:653-676`）；这里覆盖 docs 承诺的
/// 常用形态（`*.ts`、`extensions/*`、`**/*.ts`），超出范围的花式模式会退化为"精确/后缀"匹配。
pub fn glob_match(pat: &str, text: &str) -> bool {
    fn go(p: &[u8], t: &[u8]) -> bool {
        if p.is_empty() {
            return t.is_empty();
        }
        match p[0] {
            b'*' => {
                if p.len() > 1 && p[1] == b'*' {
                    let mut rest = &p[2..];
                    // `**/` 也应匹配零层目录
                    if rest.first() == Some(&b'/') {
                        rest = &rest[1..];
                        return go(rest, t) || (0..=t.len()).any(|i| go(rest, &t[i..]));
                    }
                    (0..=t.len()).any(|i| go(rest, &t[i..]))
                } else {
                    (0..=t.len()).any(|i| t[..i].iter().all(|c| *c != b'/') && go(&p[1..], &t[i..]))
                }
            }
            b'?' => !t.is_empty() && t[0] != b'/' && go(&p[1..], &t[1..]),
            c => !t.is_empty() && t[0] == c && go(&p[1..], &t[1..]),
        }
    }
    go(pat.as_bytes(), text.as_bytes())
}

/// `matchesAnyPattern`（`package-manager.ts:653-676`）：对
/// 相对路径 / 文件名 / 绝对路径**三者取或**。
pub fn matches_any_pattern(file: &Path, patterns: &[String], base_dir: &Path) -> bool {
    let rel = rel_posix(base_dir, file);
    let name = file.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let abs = file.to_string_lossy().replace('\\', "/");
    patterns.iter().any(|p| {
        let pat = p.replace('\\', "/");
        let pat = pat.trim_start_matches("./");
        glob_match(pat, &rel) || glob_match(pat, &name) || glob_match(pat, &abs)
    })
}

/// `matchesAnyExactPattern`（`package-manager.ts:679-705`）：**精确**相等，只认相对路径与绝对路径。
pub fn matches_any_exact(file: &Path, patterns: &[String], base_dir: &Path) -> bool {
    if patterns.is_empty() {
        return false;
    }
    let rel = rel_posix(base_dir, file);
    let abs = file.to_string_lossy().replace('\\', "/");
    patterns.iter().any(|p| {
        let pat = p.replace('\\', "/");
        let pat = pat.trim_start_matches("./").to_string();
        pat == rel || pat == abs
    })
}

/// 从资源数组里挑出通配符项（`getOverridePatterns`，`package-manager.ts:707-709`）。
pub fn override_patterns(entries: &[String]) -> Vec<String> {
    entries
        .iter()
        .filter(|p| p.starts_with('!') || p.starts_with('+') || p.starts_with('-'))
        .cloned()
        .collect()
}

/// 从资源数组里挑出普通项（登记的资源路径）。
pub fn plain_entries(entries: &[String]) -> Vec<String> {
    entries
        .iter()
        .filter(|p| !(p.starts_with('!') || p.starts_with('+') || p.starts_with('-')))
        .cloned()
        .collect()
}

/// `isEnabledByOverrides`（`package-manager.ts:712-728`）：顺序固定 `!` → `+` → `-`。
pub fn enabled_by_overrides(file: &Path, overrides: &[String], base_dir: &Path) -> (bool, String) {
    let excludes: Vec<String> = overrides
        .iter()
        .filter_map(|p| p.strip_prefix('!'))
        .map(str::to_string)
        .collect();
    let force_in: Vec<String> = overrides
        .iter()
        .filter_map(|p| p.strip_prefix('+'))
        .map(str::to_string)
        .collect();
    let force_out: Vec<String> = overrides
        .iter()
        .filter_map(|p| p.strip_prefix('-'))
        .map(str::to_string)
        .collect();

    let mut enabled = true;
    let mut by = String::new();
    if !excludes.is_empty() && matches_any_pattern(file, &excludes, base_dir) {
        enabled = false;
        by = format!("被 {base}/settings.json 的 ! 规则排除", base = base_dir.display());
    }
    if !force_in.is_empty() && matches_any_exact(file, &force_in, base_dir) {
        enabled = true;
        by = format!("被 {base}/settings.json 的 + 规则强制包含", base = base_dir.display());
    }
    if !force_out.is_empty() && matches_any_exact(file, &force_out, base_dir) {
        enabled = false;
        by = format!("被 {base}/settings.json 的 - 规则强制排除", base = base_dir.display());
    }
    if by.is_empty() {
        by = "默认加载（没有任何规则排除它）".to_string();
    }
    (enabled, by)
}

/* ============================ 包的通配符 ============================ */

/// `PackageSource` → `(source, autoload, 资源通配符)`（`settings-manager.ts:94-108`）。
pub fn split_package(pkg: &Value) -> (String, bool, Vec<String>) {
    match pkg {
        Value::String(s) => (s.clone(), true, Vec::new()),
        Value::Object(o) => {
            let source = o.get("source").and_then(|s| s.as_str()).unwrap_or_default().to_string();
            let autoload = o.get("autoload").and_then(|a| a.as_bool()).unwrap_or(true);
            let pats = o
                .get("extensions")
                .and_then(|e| e.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str()).map(str::to_string).collect())
                .unwrap_or_default();
            (source, autoload, pats)
        }
        _ => (String::new(), true, Vec::new()),
    }
}

/// 包内某个扩展入口是否启用。
///
/// `autoload=true`（默认）：走 `isEnabledByOverrides`——`-`/`!` 关，`+` 开。
/// `autoload=false`：走 `applyAutoloadDisabledPatterns`（`package-manager.ts:787-806`），
/// 即**只有被通配符命中的文件**才启用，其余一律关闭。
pub fn package_entry_enabled(pkg: &Value, file: &Path, package_root: &Path) -> (bool, String) {
    let (_, autoload, pats) = split_package(pkg);
    if autoload {
        if pats.is_empty() {
            return (
                true,
                "这条包在 settings.json 的 packages 里没有过滤规则 → pi 加载它提供的全部资源".to_string(),
            );
        }
        return enabled_by_overrides(file, &pats, package_root);
    }
    // autoload=false：按出现顺序逐条命中，后者覆盖前者
    let rel = rel_posix(package_root, file);
    let mut state: Option<(bool, String)> = None;
    for p in &pats {
        let (on, target, exact) = match p.as_str() {
            s if s.starts_with('+') => (true, &s[1..], true),
            s if s.starts_with('-') => (false, &s[1..], true),
            s if s.starts_with('!') => (false, &s[1..], false),
            s => (true, s, false),
        };
        let hit = if exact {
            matches_any_exact(file, &[target.to_string()], package_root)
        } else {
            matches_any_pattern(file, &[target.to_string()], package_root)
        };
        if hit {
            state = Some((on, format!("包设置了 autoload:false，由规则 {p:?} 决定")));
        }
    }
    match state {
        Some((on, by)) => (on, by),
        None => (false, format!("包设置了 autoload:false，{} 不在任何 + 规则里", rel)),
    }
}

/* ============================ 组装 ============================ */

/// 一个插件条目（**返回给前端的形状，契约由 tests 锁死**）。
#[allow(clippy::too_many_arguments)]
pub fn make_entry(
    kind: Kind,
    source_kind: SourceKind,
    scope: Scope,
    source: &str,
    path: &Path,
    enabled: (bool, String),
    entries: Vec<PathBuf>,
    load_rank: i32,
) -> Value {
    // 内置扩展随 pi 发布，路径是说明性文字而非真实文件——不算"缺失"，
    // 否则计数里永远挂着一条"1 个缺失"，把真正的缺失淹掉。
    let exists = kind == Kind::Builtin || path.exists();
    let meta = pi_files::read_json(&path.join("package.json")).unwrap_or(Value::Null);
    // 内置的名字只能取 `source`（= `builtInExtensions` 里的 name）：
    // 它的 path 是"(pi 内置：…/llama)"这样的说明文字，取 file_name 会得到 "llama)"。
    // 这个坑是真机核对用例抓出来的（`real_machine_overview_reads_the_live_agent_dir`）。
    let name = if kind == Kind::Builtin {
        source.to_string()
    } else {
        meta.get("name")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .or_else(|| path.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| source.to_string())
    };
    let (removable, updatable) = match kind {
        Kind::Builtin | Kind::Cli => (false, false),
        // 发现目录里的文件：能删（删文件），但没有"升级"这回事
        Kind::Discovered | Kind::Path => (true, false),
        Kind::Package => (true, matches!(source_kind, SourceKind::Npm | SourceKind::Git)),
    };
    json!({
        "key": format!("{}:{}:{}", scope.as_str(), kind.as_str(), source),
        "name": name,
        "kind": kind.as_str(),
        "kindLabel": kind.label(),
        "sourceKind": source_kind.as_str(),
        "sourceKindLabel": source_kind.label(),
        "scope": scope.as_str(),
        "scopeLabel": scope.label(),
        "source": source,
        "path": path.to_string_lossy(),
        "exists": exists,
        "enabled": enabled.0,
        "enabledBy": enabled.1,
        "version": meta.get("version").and_then(|v| v.as_str()),
        "description": meta.get("description").and_then(|v| v.as_str()),
        "entries": entries.iter().map(|p| p.to_string_lossy().into_owned()).collect::<Vec<_>>(),
        "removable": removable,
        "updatable": updatable,
        "loadRank": load_rank,
    })
}

fn str_list(v: &Value, key: &str) -> Vec<String> {
    v.get(key)
        .and_then(|x| x.as_array())
        .map(|a| a.iter().filter_map(|s| s.as_str()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// 完整盘点。`cwd = None` 表示没有打开项目（只盘全局）。
pub fn overview(agent_dir: &Path, cwd: Option<&Path>) -> Result<Value, String> {
    let cwd_owned = cwd.map(|p| p.to_path_buf());
    let dirs = ScopeDirs::new(
        agent_dir.to_path_buf(),
        cwd_owned.clone().unwrap_or_default(),
    );
    let mut warnings: Vec<String> = Vec::new();
    let mut plugins: Vec<Value> = Vec::new();

    let global_settings = read_settings(&dirs, Scope::Global)?;
    let project_settings = match &cwd_owned {
        Some(_) => read_settings(&dirs, Scope::Project).unwrap_or_else(|e| {
            warnings.push(format!("本项目 .pi/settings.json 读取失败：{e}"));
            json!({})
        }),
        None => json!({}),
    };

    /* ── 1. 包（rank 4）── */
    for scope in [Scope::Global, Scope::Project] {
        if scope == Scope::Project && cwd_owned.is_none() {
            continue;
        }
        let settings = if scope == Scope::Project { &project_settings } else { &global_settings };
        for pkg in settings.get("packages").and_then(|p| p.as_array()).cloned().unwrap_or_default() {
            let (source, _, _) = split_package(&pkg);
            if source.trim().is_empty() {
                warnings.push(format!("{} 的 packages 里有一条没有 source 的条目", scope.label()));
                continue;
            }
            let sk = classify(&source);
            let path = package_path(&dirs, scope, &source);
            let entries = if path.is_dir() { extension_entries(&path) } else { Vec::new() };
            // 包可能声明多个入口（`pi.extensions`）：只要有一个启用就算这个包启用，
            // 全被关掉才算停用——界面上"停用"是对整包说的。
            let mut states: Vec<(bool, String)> = entries
                .iter()
                .map(|e| package_entry_enabled(&pkg, e, &path))
                .collect();
            if states.is_empty() {
                states.push(package_entry_enabled(&pkg, &path, &path));
            }
            let enabled = states.iter().any(|(on, _)| *on);
            let by = states
                .iter()
                .find(|(on, _)| *on == enabled)
                .map(|(_, why)| why.clone())
                .unwrap_or_else(|| "无扩展入口".to_string());
            plugins.push(make_entry(Kind::Package, sk, scope, &source, &path, (enabled, by), entries, 4));
        }
    }

    /* ── 2/3. settings 登记的路径 + 发现目录（rank 0-3）── */
    for scope in [Scope::Project, Scope::Global] {
        if scope == Scope::Project && cwd_owned.is_none() {
            continue;
        }
        let settings = if scope == Scope::Project { &project_settings } else { &global_settings };
        let base = dirs.base_dir(scope);
        let raw = str_list(settings, "extensions");
        let overrides = override_patterns(&raw);
        let rank_base = if scope == Scope::Project { 0 } else { 2 };

        // 显式登记的路径（rank 0 / 2）
        for raw_entry in plain_entries(&raw) {
            let resolved = resolve_local(&raw_entry, &base);
            let entries = if resolved.is_dir() {
                extension_entries(&resolved)
            } else {
                vec![resolved.clone()]
            };
            if !resolved.exists() {
                warnings.push(format!(
                    "{} 的 extensions 里 {} 不存在（pi 会跳过它）",
                    scope.label(),
                    resolved.display()
                ));
            }
            let state = enabled_by_overrides(&resolved, &overrides, &base);
            plugins.push(make_entry(
                Kind::Path,
                SourceKind::Local,
                scope,
                &raw_entry,
                &resolved,
                state,
                entries,
                rank_base,
            ));
        }

        // 发现目录（rank 1 / 3）
        let dir = dirs.discovery_dir(scope);
        for (path, is_dir) in scan_discovery_dir(&dir) {
            let entries = if is_dir { extension_entries(&path) } else { vec![path.clone()] };
            let state = enabled_by_overrides(&path, &overrides, &base);
            plugins.push(make_entry(
                Kind::Discovered,
                SourceKind::Discovered,
                scope,
                &path.to_string_lossy(),
                &path,
                state,
                entries,
                rank_base + 1,
            ));
        }
    }

    /* ── 4. pi 内置 ── */
    for b in crate::plugin::builtins_generated::BUILTINS {
        plugins.push(make_entry(
            Kind::Builtin,
            SourceKind::Builtin,
            Scope::Builtin,
            b.name,
            Path::new(b.path),
            (true, "pi 内置扩展：随 pi 发布，不可增删，-ne 也关不掉".to_string()),
            Vec::new(),
            -1,
        ));
    }

    // 同路径去重：保留 rank 最小的一条（`package-manager.ts:2585-2593`）
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    plugins.retain(|p| {
        let path = p["path"].as_str().unwrap_or_default().to_string();
        let rank = p["loadRank"].as_i64().unwrap_or(99);
        // 只在"同一个真实路径"上去重；包是按包目录算的，与文件级路径不同，天然不冲突
        match p["kind"].as_str() {
            Some("discovered") | Some("path") => {
                if seen.contains(&path) {
                    return false;
                }
                let _ = rank;
                seen.insert(path);
                true
            }
            _ => true,
        }
    });

    let total = plugins.len();
    let enabled = plugins.iter().filter(|p| p["enabled"] == json!(true)).count();
    let missing = plugins.iter().filter(|p| p["exists"] == json!(false)).count();
    let updatable = plugins.iter().filter(|p| p["updatable"] == json!(true)).count();

    let groups: Vec<Value> = [Scope::Project, Scope::Global, Scope::Builtin]
        .into_iter()
        .filter(|s| *s != Scope::Project || cwd_owned.is_some())
        .map(|s| {
            let items: Vec<Value> = plugins
                .iter()
                .filter(|p| p["scope"] == json!(s.as_str()))
                .cloned()
                .collect();
            json!({
                "id": s.as_str(),
                "label": s.label(),
                "dir": if s == Scope::Builtin {
                    "（随 pi 发布）".to_string()
                } else {
                    dirs.base_dir(s).to_string_lossy().into_owned()
                },
                "settingsPath": if s == Scope::Builtin { Value::Null } else { json!(dirs.settings_path(s).to_string_lossy()) },
                "count": items.len(),
                "plugins": items,
            })
        })
        .collect();

    Ok(json!({
        "agentDir": agent_dir.to_string_lossy(),
        "agentDirFromEnv": std::env::var_os("PI_CODING_AGENT_DIR").is_some(),
        "projectDir": cwd_owned.as_ref().map(|p| p.to_string_lossy().into_owned()),
        "groups": groups,
        "warnings": warnings,
        "counts": {
            "total": total,
            "enabled": enabled,
            "disabled": total - enabled,
            "missing": missing,
            "updatable": updatable,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn dirs(tmp: &Path, cwd: Option<&Path>) -> ScopeDirs {
        ScopeDirs::new(
            tmp.join("agent"),
            cwd.map(|c| c.to_path_buf()).unwrap_or_default(),
        )
    }

    /// 来源分类必须与 pi 的 `isLocalPath` 前缀表一致——判错的后果是"装到别处去"。
    #[test]
    fn source_classification_matches_pi_prefixes() {
        assert_eq!(classify("npm:@foo/bar"), SourceKind::Npm);
        assert_eq!(classify("git:github.com/u/r"), SourceKind::Git);
        assert_eq!(classify("github:u/r"), SourceKind::Git);
        assert_eq!(classify("https://github.com/u/r"), SourceKind::Git);
        assert_eq!(classify("ssh://git@github.com/u/r"), SourceKind::Git);
        assert_eq!(classify("./local/x"), SourceKind::Local);
        assert_eq!(classify("/abs/x"), SourceKind::Local);
        assert_eq!(classify("~/x"), SourceKind::Local);
    }

    #[test]
    fn npm_names_parse_with_scope_and_version() {
        assert_eq!(npm_package_name("npm:foo").as_deref(), Some("foo"));
        assert_eq!(npm_package_name("npm:foo@1.2.3").as_deref(), Some("foo"));
        assert_eq!(npm_package_name("npm:@scope/foo").as_deref(), Some("@scope/foo"));
        assert_eq!(npm_package_name("npm:@scope/foo@1.2.3").as_deref(), Some("@scope/foo"));
        assert_eq!(npm_package_name("npm:"), None);
        assert_eq!(npm_package_name("npm:@broken"), None);
    }

    #[test]
    fn git_host_path_parses_all_forms() {
        let want = Some(("github.com".to_string(), "user/repo".to_string()));
        assert_eq!(git_host_path("git:github.com/user/repo"), want);
        assert_eq!(git_host_path("git:github.com/user/repo#v1"), want);
        assert_eq!(git_host_path("https://github.com/user/repo"), want);
        assert_eq!(git_host_path("https://github.com/user/repo.git"), want);
        assert_eq!(git_host_path("git:git@github.com:user/repo"), want);
        assert_eq!(git_host_path("npm:foo"), None);
    }

    #[test]
    fn package_paths_follow_pi_layout() {
        let tmp = tempfile::tempdir().unwrap();
        let d = dirs(tmp.path(), Some(&tmp.path().join("proj")));
        assert_eq!(
            package_path(&d, Scope::Global, "npm:@a/b"),
            tmp.path().join("agent/npm/node_modules/@a/b")
        );
        assert_eq!(
            package_path(&d, Scope::Project, "npm:@a/b"),
            tmp.path().join("proj/.pi/npm/node_modules/@a/b")
        );
        assert_eq!(
            package_path(&d, Scope::Global, "git:github.com/u/r"),
            tmp.path().join("agent/git/github.com/u/r")
        );
    }

    /// 本地来源相对设置文件所在目录解析（实测：pi install 写的是相对 agent 目录的串）。
    #[test]
    fn local_sources_resolve_against_the_settings_dir() {
        let base = PathBuf::from("/home/u/.pi/agent");
        assert_eq!(resolve_local("../../x/y", &base), PathBuf::from("/home/u/x/y"));
        assert_eq!(resolve_local("/abs/z", &base), PathBuf::from("/abs/z"));
        assert_eq!(resolve_local("./a/b", &base), PathBuf::from("/home/u/.pi/agent/a/b"));
    }

    #[test]
    fn discovery_dir_matches_pi_rules() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("extensions");
        fs::create_dir_all(dir.join("with-index")).unwrap();
        fs::create_dir_all(dir.join("with-manifest/src")).unwrap();
        fs::create_dir_all(dir.join("not-an-extension")).unwrap();
        fs::create_dir_all(dir.join("node_modules")).unwrap();
        fs::write(dir.join("flat.ts"), "export default 1").unwrap();
        fs::write(dir.join("notes.md"), "x").unwrap();
        fs::write(dir.join("with-index/index.ts"), "export default 1").unwrap();
        fs::write(dir.join("with-manifest/src/main.ts"), "export default 1").unwrap();
        fs::write(
            dir.join("with-manifest/package.json"),
            r#"{"name":"m","pi":{"extensions":["./src/main.ts"]}}"#,
        )
        .unwrap();
        fs::write(dir.join("not-an-extension/readme.txt"), "x").unwrap();
        fs::write(dir.join("node_modules/x.ts"), "export default 1").unwrap();

        let found: Vec<String> = scan_discovery_dir(&dir)
            .into_iter()
            .map(|(p, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(found, vec!["flat.ts", "with-index", "with-manifest"]);
    }

    /// 声明的入口全都不存在时回落到 index.ts（`loader.ts:683-697`）。
    #[test]
    fn manifest_entries_fall_back_to_index() {
        let tmp = tempfile::tempdir().unwrap();
        let d = tmp.path().join("pkg");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("index.ts"), "export default 1").unwrap();
        fs::write(d.join("package.json"), r#"{"pi":{"extensions":["./missing.ts"]}}"#).unwrap();
        assert_eq!(extension_entries(&d), vec![d.join("index.ts")]);
    }

    /// 通配符语义（`package-manager.ts:712-728`）：`!` 排除、`+` 强制包含、`-` 强制排除，后者覆盖前者。
    #[test]
    fn override_patterns_follow_pi_precedence() {
        let base = PathBuf::from("/a/agent");
        let f = PathBuf::from("/a/agent/extensions/foo.ts");

        let (on, _) = enabled_by_overrides(&f, &[], &base);
        assert!(on, "没有规则时默认加载");

        let (on, why) = enabled_by_overrides(&f, &["-extensions/foo.ts".into()], &base);
        assert!(!on && why.contains("- 规则"), "精确排除");

        let (on, _) = enabled_by_overrides(&f, &["!extensions/*.ts".into()], &base);
        assert!(!on, "glob 排除");

        // `+` 压过 `!`，`-` 又压过 `+`
        let (on, _) = enabled_by_overrides(
            &f,
            &["!extensions/*.ts".into(), "+extensions/foo.ts".into()],
            &base,
        );
        assert!(on, "+ 压过 !");

        let (on, _) = enabled_by_overrides(
            &f,
            &["+extensions/foo.ts".into(), "-extensions/foo.ts".into()],
            &base,
        );
        assert!(!on, "- 压过 +");

        // 精确匹配不认 glob：`-extensions/*.ts` 不该命中
        let (on, _) = enabled_by_overrides(&f, &["-extensions/*.ts".into()], &base);
        assert!(on, "- 是精确匹配，不展开 glob");
    }

    /// `+`/`-` 用精确匹配、`!` 用 glob（`package-manager.ts:653-705`）。
    #[test]
    fn exact_and_glob_matching_differ() {
        let base = PathBuf::from("/a/agent");
        let f = PathBuf::from("/a/agent/extensions/deep/foo.ts");
        assert!(matches_any_pattern(&f, &["*.ts".into()], &base), "glob 认文件名");
        assert!(!matches_any_exact(&f, &["*.ts".into()], &base), "精确不认 glob");
        assert!(matches_any_exact(&f, &["extensions/deep/foo.ts".into()], &base));
    }

    /// `autoload:false` 的包：只有被规则命中的入口才加载（`package-manager.ts:787-806`）。
    #[test]
    fn package_autoload_false_requires_an_explicit_rule() {
        let root = PathBuf::from("/a/agent/npm/node_modules/x");
        let entry = root.join("index.ts");
        let off = json!({"source": "npm:x", "autoload": false});
        assert!(!package_entry_enabled(&off, &entry, &root).0);

        let picked = json!({"source": "npm:x", "autoload": false, "extensions": ["+index.ts"]});
        assert!(package_entry_enabled(&picked, &entry, &root).0);

        // autoload 默认 true：没有规则就是加载
        let plain = json!({"source": "npm:x"});
        assert!(package_entry_enabled(&plain, &entry, &root).0);

        // autoload=true 时 `-` 能关掉
        let blocked = json!({"source": "npm:x", "extensions": ["-index.ts"]});
        assert!(!package_entry_enabled(&blocked, &entry, &root).0);
    }

    /// 端到端盘点：四种来源各造一条，核对分组、计数与启用状态。
    #[test]
    fn overview_collects_every_source() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        let proj = tmp.path().join("proj");
        fs::create_dir_all(agent.join("npm/node_modules/@a/b")).unwrap();
        fs::create_dir_all(agent.join("extensions")).unwrap();
        fs::create_dir_all(proj.join(".pi/extensions")).unwrap();
        fs::write(agent.join("extensions/g.ts"), "export default 1").unwrap();
        fs::write(proj.join(".pi/extensions/p.ts"), "export default 1").unwrap();
        fs::write(agent.join("npm/node_modules/@a/b/index.ts"), "export default 1").unwrap();
        fs::write(
            agent.join("npm/node_modules/@a/b/package.json"),
            r#"{"name":"@a/b","version":"1.2.3","description":"d","pi":{"extensions":["./index.ts"]}}"#,
        )
        .unwrap();
        fs::write(agent.join("settings.json"), r#"{"packages":["npm:@a/b"]}"#).unwrap();

        let v = overview(&agent, Some(&proj)).unwrap();
        let builtins = crate::plugin::builtins_generated::BUILTINS.len();
        assert_eq!(v["counts"]["total"], json!(3 + builtins));
        assert_eq!(v["counts"]["missing"], json!(0));
        assert_eq!(v["counts"]["enabled"], json!(3 + builtins));

        let global = &v["groups"][1];
        assert_eq!(global["label"], json!("全局"));
        let pkg = &global["plugins"][0];
        assert_eq!(pkg["name"], json!("@a/b"));
        assert_eq!(pkg["version"], json!("1.2.3"));
        assert_eq!(pkg["kind"], json!("package"));
        assert_eq!(pkg["sourceKind"], json!("npm"));
        assert_eq!(pkg["enabled"], json!(true));
        assert_eq!(pkg["updatable"], json!(true));

        let project = &v["groups"][0];
        assert_eq!(project["label"], json!("本项目"));
        assert_eq!(project["count"], json!(1));
    }

    /// 发现目录里的文件可以被同作用域 settings 的 `-` 规则关掉——这是"停用"的真实机制。
    #[test]
    fn discovered_extension_can_be_disabled_by_pattern() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(agent.join("extensions")).unwrap();
        fs::write(agent.join("extensions/foo.ts"), "export default 1").unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"extensions":["-extensions/foo.ts"]}"#,
        )
        .unwrap();

        let v = overview(&agent, None).unwrap();
        let g = &v["groups"][0];
        assert_eq!(g["id"], json!("global"));
        assert_eq!(g["plugins"][0]["enabled"], json!(false));
        assert!(g["plugins"][0]["enabledBy"].as_str().unwrap().contains("- 规则"));
        assert_eq!(v["counts"]["disabled"], json!(1));
    }

    /// 全局的规则管不到项目发现目录（pi 按作用域分别施加规则）。
    #[test]
    fn global_patterns_do_not_reach_project_discovery() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        let proj = tmp.path().join("proj");
        fs::create_dir_all(agent.join("extensions")).unwrap();
        fs::create_dir_all(proj.join(".pi/extensions")).unwrap();
        fs::write(agent.join("extensions/g.ts"), "export default 1").unwrap();
        fs::write(proj.join(".pi/extensions/p.ts"), "export default 1").unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"extensions":["-extensions/p.ts","-extensions/g.ts"]}"#,
        )
        .unwrap();

        let v = overview(&agent, Some(&proj)).unwrap();
        let project = &v["groups"][0]["plugins"][0];
        assert_eq!(project["path"], json!(proj.join(".pi/extensions/p.ts").to_string_lossy()));
        assert_eq!(project["enabled"], json!(true), "全局规则不该关掉项目文件");
        let global = &v["groups"][1]["plugins"][0];
        assert_eq!(global["enabled"], json!(false));
    }

    /// 包没装上时 `exists=false`——界面必须能显示"声明了但没装"，
    /// 否则用户只看到一条永远加载不出来的条目。
    #[test]
    fn missing_package_is_reported_not_hidden() {
        let tmp = tempfile::tempdir().unwrap();
        let agent = tmp.path().join("agent");
        fs::create_dir_all(&agent).unwrap();
        fs::write(
            agent.join("settings.json"),
            r#"{"packages":["npm:@a/never-installed"]}"#,
        )
        .unwrap();
        let v = overview(&agent, None).unwrap();
        assert_eq!(v["counts"]["missing"], json!(1));
        let p = &v["groups"][0]["plugins"][0];
        assert_eq!(p["exists"], json!(false));
        assert_eq!(p["path"], json!(agent.join("npm/node_modules/@a/never-installed").to_string_lossy()));
    }

    /// **真机核对**（`cargo test --lib -- --ignored real_machine --nocapture`）。
    ///
    /// 用这台机器上真实的 `~/.pi/agent` 与当前项目盘点一次，把结果打出来。
    /// 单元测试用的是自己造的目录，证明不了"真的能读懂用户机器上的 pi 状态"——
    /// 这条才是。它只读不写。
    #[test]
    #[ignore]
    fn real_machine_overview_reads_the_live_agent_dir() {
        let agent = agent_dir();
        let cwd = std::env::current_dir().unwrap();
        println!("agentDir = {}", agent.display());
        println!("cwd      = {}", cwd.display());
        assert!(agent.exists(), "这台机器上没有 {}（pi 还没初始化过？）", agent.display());

        let v = overview(&agent, Some(&cwd)).unwrap();
        println!("counts   = {}", v["counts"]);
        for g in v["groups"].as_array().unwrap() {
            println!("── {} ({})  {}", g["label"], g["count"], g["dir"]);
            for p in g["plugins"].as_array().unwrap() {
                println!(
                    "   [{:>9}] {:<28} enabled={:<5} exists={:<5} {}{}",
                    p["sourceKind"].as_str().unwrap_or("?"),
                    p["name"].as_str().unwrap_or("?"),
                    p["enabled"],
                    p["exists"],
                    p["source"].as_str().unwrap_or(""),
                    p["version"].as_str().map(|s| format!(" v{s}")).unwrap_or_default(),
                );
                println!("        状态依据：{}", p["enabledBy"].as_str().unwrap_or(""));
            }
        }
        for w in v["warnings"].as_array().unwrap() {
            println!("warning: {w}");
        }
        // 至少要有内置那一条；其余取决于机器状态，不写死
        assert!(v["counts"]["total"].as_u64().unwrap() >= 1);
    }

    /// `PI_CODING_AGENT_DIR` 指向别处时，盘点必须跟着走（pi 的 getAgentDir 就是这么做的）。
    #[test]
    fn agent_dir_env_override_is_honored() {
        let tmp = tempfile::tempdir().unwrap();
        std::env::set_var("PI_CODING_AGENT_DIR", tmp.path());
        assert_eq!(agent_dir(), tmp.path());
        std::env::remove_var("PI_CODING_AGENT_DIR");
        assert!(agent_dir().ends_with(".pi/agent"));
    }
}
