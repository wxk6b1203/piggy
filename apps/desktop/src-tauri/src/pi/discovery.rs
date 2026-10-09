//! pi 二进制定位与版本门禁（docs/02 §2.1、03 §2.1、17 §2）。
//!
//! ## 三种来源
//! | 来源 | 取值 | 典型场景 |
//! |------|------|----------|
//! | `system`（**默认**） | PATH → 常见安装位置 → 捆绑兜底 | 本机已装 pi，跟着 `pi update` 走 |
//! | `bundled` | 应用包里的 `resources/pi/pi` | 用打包进来的自定义 pi |
//! | `custom` | 用户指定的绝对路径 | fork 出来的 pi，放在任意位置 |
//!
//! `PI_BIN` 环境变量**永远优先于以上三者**：它是运维/CI 的显式指令，
//! 不该被界面上的默认值覆盖（也正因如此，界面上会显示实际生效的那一个）。
//!
//! 历史：这里原本是「显式路径 → PI_BIN → 内置 → PATH」，即**捆绑的 pi 优先于系统 pi**，
//! 且所有调用点都把显式路径传 `None`（docs/02 承诺的 `piPath` 设置项从未实现）。
//! 2026-09-23 改为按来源选择，默认系统 pi。

use std::path::{Path, PathBuf};
use std::process::Command;

/// pi 二进制来源（持久化在 `~/.piggy/config.json`）。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PiSource {
    /// 系统安装的 pi（默认）
    #[default]
    System,
    /// 应用包内捆绑的 pi（自定义构建走这条打包）
    Bundled,
    /// 用户指定的路径
    Custom,
}

impl PiSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Bundled => "bundled",
            Self::Custom => "custom",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::System => "系统 pi",
            Self::Bundled => "捆绑 pi",
            Self::Custom => "自定义路径",
        }
    }

    pub fn parse(s: &str) -> Result<Self, String> {
        match s.trim() {
            "system" => Ok(Self::System),
            "bundled" => Ok(Self::Bundled),
            "custom" => Ok(Self::Custom),
            other => Err(format!("未知 pi 来源 {other:?}（可选：system / bundled / custom）")),
        }
    }
}

/// 跨 IPC 的形状一律 camelCase（前端读的是 `fromEnv`）。
///
/// ⚠️ 这里曾经漏了 `rename_all`，于是 Rust 发 `from_env`、前端读 `fromEnv`、
/// 两边都不报错 —— 「被环境变量 PI_BIN 覆盖」那条警告**从来没显示过**。
/// 同类事故见 `sessions/title.rs::Generated`（会把 `NaN` 渲染给用户）。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PiBinary {
    pub path: PathBuf,
    pub version: String,
    /// 实际生效的来源（可能是回退后的结果，不等于用户设置）
    pub source: PiSource,
    /// 一句话说明是怎么找到的，直接显示给用户
    pub via: String,
    /// `PI_BIN` 覆盖是否生效（界面据此提示"设置被环境变量覆盖"）
    pub from_env: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum DiscoveryError {
    #[error("pi 二进制未找到。可选：在设置里指定路径、安装 pi 到 PATH，或选「捆绑 pi」（需 full SKU 打包）")]
    NotFound,
    #[error("指定的 pi 路径不存在: {0}")]
    CustomPathMissing(String),
    #[error("应用未捆绑 pi（lite SKU）。请改用「系统 pi」或换 full SKU 构建")]
    BuiltinMissing,
    #[error("pi --version 失败: {0}")]
    VersionCheckFailed(String),
}

/// 按来源挑选候选路径。**纯函数**——把「系统查到什么」「内置有没有」当参数传进来，
/// 因此来源矩阵与回退行为可以脱离环境（PATH/HOME/文件系统）穷举测试。
///
/// 返回 `(路径, 实际来源, 说明)`；实际来源可能与请求的不同（system 回退到 bundled）。
pub(crate) fn pick_source(
    source: PiSource,
    custom: Option<&Path>,
    builtin: Option<&Path>,
    system: Option<PathBuf>,
) -> Result<(PathBuf, PiSource, String), DiscoveryError> {
    let builtin_ok = builtin.filter(|b| b.is_file());
    match source {
        PiSource::Custom => {
            let p = custom.ok_or_else(|| DiscoveryError::CustomPathMissing("（未填写路径）".to_string()))?;
            if !p.is_file() {
                return Err(DiscoveryError::CustomPathMissing(p.display().to_string()));
            }
            Ok((p.to_path_buf(), PiSource::Custom, "设置中指定的路径".to_string()))
        }
        PiSource::Bundled => {
            let b = builtin_ok.ok_or(DiscoveryError::BuiltinMissing)?;
            Ok((b.to_path_buf(), PiSource::Bundled, "应用内捆绑".to_string()))
        }
        PiSource::System => match system {
            Some(p) => Ok((p, PiSource::System, "系统安装".to_string())),
            // 系统没装：若这个包自带 pi 就用它，而不是直接失败——
            // 默认值仍是「系统 pi」，但用户机器上没装时不该整个用不了。
            None => match builtin_ok {
                Some(b) => Ok((
                    b.to_path_buf(),
                    PiSource::Bundled,
                    "系统未找到 pi，回退到应用内捆绑".to_string(),
                )),
                None => Err(DiscoveryError::NotFound),
            },
        },
    }
}

/// 按来源定位 pi 并校验 `--version`。
pub fn discover(source: PiSource, custom: Option<&Path>, builtin: Option<&Path>) -> Result<PiBinary, DiscoveryError> {
    // 1) PI_BIN：显式环境覆盖，永远优先
    if let Some(p) = std::env::var_os("PI_BIN").map(PathBuf::from) {
        if p.is_file() {
            return verify(p, PiSource::Custom, "环境变量 PI_BIN".to_string(), true);
        }
        return Err(DiscoveryError::CustomPathMissing(p.display().to_string()));
    }

    // 2) 按用户选定的来源（system 档才需要真的去查系统）
    let system = match source {
        PiSource::System => which_pi(),
        _ => None,
    };
    let (path, resolved, via) = pick_source(source, custom, builtin, system)?;
    let via = if resolved == PiSource::System && !is_on_path(&path) {
        "常见安装位置".to_string()
    } else {
        via
    };
    verify(path, resolved, via, false)
}

fn verify(path: PathBuf, source: PiSource, via: String, from_env: bool) -> Result<PiBinary, DiscoveryError> {
    if !path.is_file() {
        return Err(DiscoveryError::CustomPathMissing(path.display().to_string()));
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
    Ok(PiBinary {
        path,
        version,
        source,
        via,
        from_env,
    })
}

/// 该路径是否来自 PATH（仅用于给用户一句可读的说明）。
fn is_on_path(p: &Path) -> bool {
    let Some(dirs) = std::env::var_os("PATH") else {
        return false;
    };
    let Some(parent) = p.parent() else { return false };
    std::env::split_paths(&dirs).any(|d| d == parent)
}

/// 可执行文件名的候选，**按优先级**。
///
/// ## 为什么不能只写 `["pi", "pi.exe", "pi.cmd"]`（Windows 上真实踩到的 bug）
///
/// npm / pnpm 在 Windows 的 bin 目录里**同时**放两份东西：
///   * `pi`      —— 给 Git Bash / MSYS 用的 **POSIX shell 脚本**；
///   * `pi.cmd`  —— 给 cmd/PowerShell 用的批处理垫片（`pi.exe` 则出现在 standalone 版）。
///
/// 老代码先试无扩展名的 `pi`，`is_file()` 为真就返回它，然后把这个绝对路径交给
/// `CreateProcess`——**绝对路径 Rust 不会再补 `.exe`**（见 std::process::Command 的平台说明：
/// 只有"不带扩展名的可执行文件"会补 .exe，而这里给的是一个真实存在的文件），
/// 于是 Windows 报 `os error 193（不是有效的 Win32 应用程序）`，
/// 整个发现流程失败，界面上就是"pi 未找到——可 pi 明明在 PATH 里"。
///
/// 规则：**Windows 上按 `PATHEXT` 生成候选（默认 .COM;.EXE;.BAT;.CMD），无扩展名的 `pi`
/// 排在最后**，且只在它真的是个 PE（`MZ` 头）时才接受（见 [`first_pi_in`]）。
/// 这样 shell 垫片永远不会被交给 `CreateProcess`，而"有人把 pi.exe 改名成 pi"的
/// 极端情况仍然能用。
pub fn exec_names(windows: bool, pathext: Option<&str>) -> Vec<String> {
    if !windows {
        return vec!["pi".to_string()];
    }
    const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";
    let raw = pathext.filter(|s| !s.trim().is_empty()).unwrap_or(DEFAULT_PATHEXT);
    let mut out: Vec<String> = Vec::new();
    for ext in raw.split(';') {
        // PATHEXT 里通常写 ".EXE"，也有人写 "*.EXE"；统一成小写、去掉通配符
        let ext = ext.trim().trim_start_matches('*').to_ascii_lowercase();
        if ext.is_empty() {
            continue;
        }
        let name = format!("pi{ext}");
        if !out.contains(&name) {
            out.push(name);
        }
    }
    // 最后再考虑无扩展名（只可能是"改名过的 PE"或不可执行的垫片，由调用方验内容）
    out.push("pi".to_string());
    out
}

/// 这个文件看起来是不是 Windows 可执行文件（PE：`MZ` 头）。
///
/// 只是个**便宜的筛子**，不是完整校验——真正的校验是后面跑 `--version`。
/// 用途：拒绝把 npm/pnpm 的 POSIX shell 垫片交给 `CreateProcess`。
fn looks_like_pe(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    let mut magic = [0u8; 2];
    f.read_exact(&mut magic).is_ok() && &magic == b"MZ"
}

/// 在单个目录里按候选名找 pi。
///
/// `windows=true` 时，**无扩展名**的候选额外要求"真的是 PE"（理由见 [`exec_names`]）。
fn first_pi_in(dir: &Path, names: &[String], windows: bool) -> Option<PathBuf> {
    for name in names {
        let cand = dir.join(name);
        if !cand.is_file() {
            continue;
        }
        if windows && name == "pi" && !looks_like_pe(&cand) {
            // 这是那个 shell 垫片：跳过，继续看后面的目录/候选
            continue;
        }
        return Some(cand);
    }
    None
}

/// 把一个 **`.cmd`/`.bat` 垫片**解析成"直接启动它背后的真实程序"的 argv。
///
/// ## 为什么需要它（2026-10-09 用户报的 bug）
///
/// 界面上点「重新生成标题」报：
/// `启动 C:\…\pnpm\bin\pi.cmd 失败：batch file arguments are invalid`。
///
/// 根因不在 pi、也不在参数写错，而在 **Rust 标准库对批处理垫片的参数转义**：
/// `CreateProcess` 传不了参数的原始字节，std 只能自己拼命令行交给 `cmd.exe`，
/// 而 `cmd.exe` **无法安全转义换行** —— 于是 std 直接拒绝启动（本机实测确认，三种都拒）：
///
/// | 参数内容 | 结果 |
/// |---|---|
/// | 空格 / 双引号 / `&` / `\|` / `%` | ✅ 正常转义 |
/// | `\n`、`\r\n`、单独的 `\r` | ❌ `batch file arguments are invalid` |
///
/// 而标题那条路的提示词**天生多行**（`build_prompt` 的 `…human messages:\n{json}`），
/// 所以「Windows + pnpm 垫片」下这条功能是**必然失败**，不是偶发。
///
/// ## 做法：走垫片自己写的那条命令，不自己拼 cmd 语法
///
/// pnpm / npm 的垫片形状是固定的（本机真机读到的 pnpm 版本）：
///
/// ```text
/// @IF EXIST "%~dp0\node.exe" (
///   "%~dp0\node.exe" "%~dp0\..\global\…\dist\bundle\cli.js" %*
/// ) ELSE (
///   @SET PATHEXT=%PATHEXT:;.JS;=;%
///   node "%~dp0\..\global\…\dist\bundle\cli.js" %*
/// )
/// ```
///
/// 所以：读文本 → 剥掉 `@IF EXIST …` / `@SET …` 这些行 → 在剩下的行里取第一个
/// `"<…>node.exe" "<…>cli.js"` 对，把 `%~dp0` 展开成垫片所在目录。
/// **把命令的"真身"交给 `CreateProcess`**，参数就没有 cmd 转义这一层了，
/// 换行、`&`、`%` 全部安全（而且顺带少一层 `cmd.exe` 进程）。
///
/// 解析不出来时返回 `None`，调用方**必须回退到垫片本身**（宁可失败得和以前一样，
/// 也不能因为解析不出就换一个跑不起来的启动器）。
#[cfg_attr(not(windows), allow(dead_code))]
pub fn direct_command(pi_bin: &Path) -> Option<(PathBuf, Vec<String>)> {
    let ext = pi_bin.extension()?.to_string_lossy().to_ascii_lowercase();
    if ext != "cmd" && ext != "bat" {
        return None;
    }
    let text = std::fs::read_to_string(pi_bin).ok()?;
    let shim_dir = pi_bin.parent()?;
    let (program, script) = parse_shim_command(&text, shim_dir)?;
    // 两道存在性闸门：解释器与入口脚本**都要真的在磁盘上**。
    // 缺任何一个就交回垫片自己报错 —— 否则用户看到的是 node 的 `MODULE_NOT_FOUND`，
    // 而那是"装坏了"的另一种说法，比 pi 的原话难懂得多。
    if !Path::is_file(&program) || !Path::is_file(&script) {
        return None;
    }
    Some((program, vec![script.to_string_lossy().into_owned()]))
}

/// 垫片文本 → `(解释器, 入口脚本)`，**纯函数**（不碰文件系统）。
///
/// 与 [`direct_command`] 的分工：这里只管"从 cmd 语法里读出它到底要跑什么"，
/// 存在性由调用方判。拆开是为了让夹具能覆盖各种垫片写法，而不必在磁盘上
/// 造出一个真的 node.exe。
///
/// 只认"第一段是解释器（node / pwsh）、第二段是脚本"这种形状：
/// **不做通用 cmd 解析** —— 猜错会造出一个跑不起来的启动器。
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_shim_command(text: &str, shim_dir: &Path) -> Option<(PathBuf, PathBuf)> {
    /* `%~dp0` 展开时**要按 cmd 的词法认分隔符**：批处理里的路径一律写 `\`，
    而解析器可能跑在 macOS/Linux 上（CI 的 rust 作业就是），那里 `\` 只是个普通字符
    —— `PathBuf::from("/tmp/x\\cli.js")` 会被当成一个**文件名**，`is_file` 永远为假，
    于是整条垫片解析在这两个平台上静默失效（2026-10-09 实测：三条用例在 macOS 上红，
    而它们本该在 CI 上守着这段 Windows 专用逻辑）。
    把 `\` 归一到宿主分隔符：Windows 上本来就是 `\`（no-op），POSIX 上还原出真实层级。
    只在这一处做，因为**这里的输入一定是 cmd 批处理文本**，不存在"路径里真的含反斜杠"的情形。 */
    let expand = |raw: &str| -> PathBuf {
        let joined = raw.replace("%~dp0", &shim_dir.to_string_lossy());
        let joined = joined.replace("\\%", "%"); // 兜一手转义过的百分号
        let joined = joined.replace('\\', std::path::MAIN_SEPARATOR_STR);
        PathBuf::from(joined)
    };
    let looks_like_interpreter = |p: &Path| {
        p.file_name()
            .map(|n| {
                let n = n.to_string_lossy().to_ascii_lowercase();
                n == "node.exe" || n == "node" || n == "pwsh.exe" || n == "powershell.exe"
            })
            .unwrap_or(false)
    };
    for line in text.lines() {
        let trimmed = line.trim();
        // 跳过批处理的控制行（`@IF EXIST` / `@SET` / `@ECHO` / 标签 / 分支括号）。
        // 注意 `@IF EXIST "%~dp0\node.exe" (` 这一行里也有引号，但它是**条件**不是命令，
        // 故意跳过；真正执行的那一行在它下面（本机 pi.cmd 第 2/3 行就是这个形状）。
        if trimmed.is_empty()
            || trimmed.starts_with('@')
            || trimmed.starts_with(':')
            || trimmed.starts_with("SET ")
            || trimmed.starts_with("REM ")
            // 分支条件本身不是命令（`@IF EXIST "%~dp0\node.exe" (` 里也有引号，
            // 但它是**条件**；真正执行的那一行在它下面，本机 pi.cmd 第 2/3 行就是这个形状）
            || trimmed.starts_with("IF ")
            || trimmed.starts_with(") ELSE")
            || trimmed == ")"
            || trimmed == "("
        {
            continue;
        }
        /* ⚠️ 这里必须按 cmd 的词法切分，**不能**只按引号切。
        本机 pi.cmd 真正执行的那一行是：
            node  "%~dp0\..\global\…\cli.js" %*
        ——解释器是**裸写**的 `node`（没有引号），只按引号切就只得一个片段，
        于是这一行被判成"不像启动命令"而跳过。第一版就是这么错的。 */
        let tokens = cmd_line_tokens(trimmed);
        let (raw_program, raw_script) = match (tokens.first(), tokens.get(1)) {
            (Some(p), Some(s)) => (p.as_str(), s.as_str()),
            _ => continue,
        };
        // 末段常是 `%*`（参数转发标记）：它不该出现在脚本位置上
        let script = expand(raw_script);
        if script.extension().is_none() {
            continue;
        }
        let raw_program = expand(raw_program);
        let program = if raw_program.is_absolute() {
            // 分支 1 的形状：垫片同目录的 node.exe。**它可能不存在**
            // （本机 pnpm 就没铺这一份，于是垫片实际走的是 ELSE 支）——
            // 不存在就跳过这一行、让下面的 PATH 解析接手。
            if !Path::is_file(&raw_program) {
                continue;
            }
            raw_program
        } else {
            // 分支 2 的形状：裸写的 `node`。cmd 此时从 PATH 取，我们也从 PATH 取。
            if !looks_like_interpreter(&raw_program) {
                continue;
            }
            let path_var = std::env::var("PATH").unwrap_or_default();
            which_in(
                &raw_program.to_string_lossy(),
                &path_var,
                std::env::var("PATHEXT").ok().as_deref(),
            )?
        };
        // 再确认一次形状（PATH 命中的可能是别的同名程序）
        if !looks_like_interpreter(&program) {
            continue;
        }
        return Some((program, script));
    }
    None
}

/// cmd 命令行 → 词法单元：`"…"` 当作一个整体（引号去掉），引号外的空白分段。
///
/// 够用就好：垫片里只有"解释器 + 脚本 + `%*`"这三段，不需要支持 `^` 转义、
/// 变量展开、重定向这些真正的 cmd 语法（解析错了会造出跑不起来的启动器）。
#[cfg_attr(not(windows), allow(dead_code))]
fn cmd_line_tokens(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in line.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// PATH 查找：逐目录探测"存在且可执行"（`PATHEXT` 参与补后缀）。
///
/// 与 `open_in_app::host::which_in` 同语义，但那边在 `open_in_app` 模块里、
/// 且要求 `PATHEXT` 由调用方传；这里就地留一个薄的转发，免得 pi 这一侧
/// 为了查一个 `node` 去依赖"打开方式"那个模块。
#[cfg_attr(not(windows), allow(dead_code))]
fn which_in(name: &str, path_var: &str, pathext: Option<&str>) -> Option<PathBuf> {
    crate::open_in_app::host::which_in(name, path_var, pathext)
}

/// PATH 扫描 → 常见安装位置兜底。都没有返回 `None`。
fn which_pi() -> Option<PathBuf> {
    let windows = cfg!(windows);
    let names = exec_names(windows, std::env::var("PATHEXT").ok().as_deref());
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            if let Some(p) = first_pi_in(&dir, &names, windows) {
                return Some(p);
            }
        }
    }
    // PATH 未命中（GUI 启动时 PATH 极简，或 Windows 上只装了垫片）：探测常见安装位置
    let env = WellKnownEnv::from_process();
    well_known_candidates(&env, windows, &names)
        .into_iter()
        .find(|c| c.is_file() && !(windows && c.file_name().is_some_and(|n| n == "pi") && !looks_like_pe(c)))
}

/// 探测常见安装位置需要的环境（结构体是为了**可测**：不依赖真实环境变量）。
pub struct WellKnownEnv {
    pub home: Option<PathBuf>,
    pub appdata: Option<PathBuf>,
    pub localappdata: Option<PathBuf>,
}

impl WellKnownEnv {
    fn from_process() -> Self {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from);
        Self {
            // 主目录口径与 pi 目录、Piggy 配置目录统一（config::paths）：
            // Windows 上 USERPROFILE 优先，再兜 HOMEDRIVE+HOMEPATH。
            home: crate::config::paths::home_dir(),
            appdata: var("APPDATA"),
            localappdata: var("LOCALAPPDATA"),
        }
    }
}

/// 常见安装位置（pi.dev 安装脚本 / pnpm / npm / cargo 风格目录）。
///
/// Windows 与 Unix 的目录**完全不同**：老代码只列了 Unix 路径，于是 Windows 上
/// PATH 未命中时这里必然返回 `None`（连试都没试）。
pub fn well_known_candidates(env: &WellKnownEnv, windows: bool, names: &[String]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if windows {
        // pnpm 的全局 bin（Windows 上是 %LOCALAPPDATA%\pnpm）、npm 的前缀、安装脚本目录
        if let Some(d) = &env.localappdata {
            dirs.push(d.join("pnpm"));
        }
        if let Some(d) = &env.appdata {
            dirs.push(d.join("npm"));
        }
        if let Some(h) = &env.home {
            dirs.push(h.join(".local").join("bin"));
            dirs.push(h.join("scoop").join("shims"));
        }
    } else {
        if let Some(h) = &env.home {
            dirs.push(h.join(".local").join("bin"));
            dirs.push(h.join("Library").join("pnpm").join("bin"));
            dirs.push(h.join(".cargo").join("bin"));
        }
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
    }
    let mut out = Vec::new();
    for dir in dirs {
        for name in names {
            out.push(dir.join(name));
        }
    }
    out
}

/// 计算 pi 来源的变更计划。
///
/// **纯函数**：只做校验与规整，不碰磁盘、不碰 registry、不解析二进制
/// （"能不能解析"由调用方在落盘**之前**用 `discover` 验证）。
///
/// 返回 `Ok(None)` = 没有变更；`Ok(Some((来源, 路径)))` = 有变更。
///
/// 这里拦住的是本项目真实踩过的坑：允许 `custom` 且路径为空会被写进 config.json，
/// 结果是**每次建会话都失败**（"指定的 pi 路径不存在: （未填写路径）"），
/// 而界面上因为命令报错、没走到 reload，看起来像"点了没反应"。
pub fn plan_source_change(
    current: PiSource,
    current_path: Option<&str>,
    requested_source: Option<&str>,
    requested_path: Option<&str>,
) -> Result<Option<(PiSource, Option<String>)>, String> {
    let next_source = match requested_source.map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => PiSource::parse(s)?,
        None => current,
    };
    let next_path = match requested_path {
        // 显式传空串 = 清空
        Some(p) => {
            let t = p.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        }
        None => current_path.map(str::to_string),
    };

    // 关键守卫：custom 必须有路径
    if next_source == PiSource::Custom && next_path.is_none() {
        return Err("选择「自定义路径」需要先指定 pi 可执行文件；配置未改动（仍用原来的来源）".to_string());
    }
    if next_source == current && next_path.as_deref() == current_path {
        return Ok(None);
    }
    Ok(Some((next_source, next_path)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_round_trips() {
        for s in [PiSource::System, PiSource::Bundled, PiSource::Custom] {
            let json = serde_json::to_string(&s).unwrap();
            assert_eq!(json, format!("\"{}\"", s.as_str()));
            assert_eq!(serde_json::from_str::<PiSource>(&json).unwrap(), s);
            assert_eq!(PiSource::parse(s.as_str()).unwrap(), s);
        }
        assert!(PiSource::parse("python").is_err());
    }

    #[test]
    fn no_change_returns_none() {
        assert!(plan_source_change(PiSource::System, None, Some("system"), None)
            .unwrap()
            .is_none());
        assert!(
            plan_source_change(PiSource::Custom, Some("/a/pi"), Some("custom"), None)
                .unwrap()
                .is_none()
        );
    }

    /// 这是本次的 bug：custom + 空路径曾被允许写盘，导致建会话全失败。
    #[test]
    fn custom_without_path_is_rejected() {
        let e = plan_source_change(PiSource::System, None, Some("custom"), None).unwrap_err();
        assert!(e.contains("自定义路径"), "{e}");

        // 显式传空串同样拒绝
        let e2 = plan_source_change(PiSource::System, None, Some("custom"), Some("  ")).unwrap_err();
        assert!(e2.contains("自定义路径"), "{e2}");

        // 已有 custom 路径时，清空它也要拒绝（否则同样落到"无路径的 custom"）
        let e3 = plan_source_change(PiSource::Custom, Some("/a/pi"), Some("custom"), Some("")).unwrap_err();
        assert!(e3.contains("自定义路径"), "{e3}");
    }

    #[test]
    fn custom_with_path_is_accepted() {
        let plan = plan_source_change(PiSource::System, None, Some("custom"), Some(" /x/pi "))
            .unwrap()
            .expect("应产生变更");
        assert_eq!(plan.0, PiSource::Custom);
        assert_eq!(plan.1.as_deref(), Some("/x/pi"), "路径应被 trim");
    }

    /// 只改配置里的其他字段（不传来源）时不该产生 pi 变更。
    #[test]
    fn omitted_source_keeps_current() {
        assert!(plan_source_change(PiSource::Bundled, Some("/b/pi"), None, None)
            .unwrap()
            .is_none());
    }

    /// 从坏状态（custom 无路径）切回 system 必须可行——这是修复路径。
    #[test]
    fn switching_away_from_broken_custom_repairs_it() {
        let plan = plan_source_change(PiSource::Custom, None, Some("system"), None)
            .unwrap()
            .expect("应产生变更");
        assert_eq!(plan.0, PiSource::System);
        assert_eq!(plan.1, None);
    }

    #[test]
    fn unknown_source_is_rejected() {
        assert!(plan_source_change(PiSource::System, None, Some("python"), None).is_err());
    }

    /// 默认必须是系统 pi —— 这是明确的产品要求（打包用自定义 pi，但默认不劫持用户已有的安装）。
    #[test]
    fn default_source_is_system() {
        assert_eq!(PiSource::default(), PiSource::System);
    }

    /// 缺失配置时给出可操作的错误，而不是一句 not found。
    #[test]
    fn custom_without_path_is_actionable() {
        let e = discover(PiSource::Custom, None, None).unwrap_err();
        assert!(matches!(e, DiscoveryError::CustomPathMissing(_)), "got {e:?}");
    }

    #[test]
    fn custom_with_missing_path_reports_the_path() {
        let e = discover(PiSource::Custom, Some(Path::new("/nope/pi")), None).unwrap_err();
        assert!(e.to_string().contains("/nope/pi"), "错误里应带上路径: {e}");
    }

    /// bundled 档在 lite SKU（没有内置二进制）下必须明确说"这个包没捆绑"，
    /// 而不是含糊的未找到。
    #[test]
    fn bundled_without_builtin_says_so() {
        let e = discover(PiSource::Bundled, None, None).unwrap_err();
        assert!(matches!(e, DiscoveryError::BuiltinMissing), "got {e:?}");
    }

    /* ---- Windows 上的 pi 发现（用户真机踩到的 os error 193） ----
    全部是纯函数/文件系统夹具，所以在 macOS 上也能跑：
    被验证的是"**选哪个名字**"，而不是"能不能执行"。 */

    fn names_of(v: Vec<String>) -> Vec<String> {
        v
    }

    #[test]
    fn exec_names_unix_is_just_pi() {
        assert_eq!(exec_names(false, None), vec!["pi"]);
        // Unix 上 PATHEXT 无关
        assert_eq!(exec_names(false, Some(".EXE")), vec!["pi"]);
    }

    #[test]
    fn exec_names_windows_follows_pathext_and_puts_bare_pi_last() {
        let n = exec_names(true, None);
        assert_eq!(names_of(n), vec!["pi.com", "pi.exe", "pi.bat", "pi.cmd", "pi"]);
        // 无扩展名必须是**最后一个**候选：npm/pnpm 的 shell 垫片就叫 `pi`
        assert_eq!(names_of(exec_names(true, None)).last().unwrap(), "pi");
        // 自定义 PATHEXT：大小写与 `*.EXE` 写法都要认，且要按用户给的环境变量顺序
        assert_eq!(
            names_of(exec_names(true, Some("*.EXE;.CMD"))),
            vec!["pi.exe", "pi.cmd", "pi"]
        );
        assert_eq!(names_of(exec_names(true, Some(""))), names_of(exec_names(true, None)));
        // 去重
        assert_eq!(names_of(exec_names(true, Some(".CMD;.CMD"))), vec!["pi.cmd", "pi"]);
    }

    /// **这是那个 bug 的回归测试**：同一个目录里既有 shell 垫片 `pi` 又有 `pi.cmd`，
    /// Windows 语义下必须选 `pi.cmd`；老代码会选 `pi` → `os error 193`。
    #[test]
    fn windows_prefers_the_cmd_shim_over_the_posix_shell_script() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("pi"), "#!/bin/sh\nexec node \"$0/../pi.js\" \"$@\"\n").unwrap();
        std::fs::write(dir.join("pi.cmd"), "@echo off\r\nnode \"%~dp0\\pi.js\" %*\r\n").unwrap();

        let names = exec_names(true, None);
        let picked = first_pi_in(dir, &names, true).expect("应该选中 pi.cmd");
        assert_eq!(
            picked.file_name().unwrap(),
            "pi.cmd",
            "选中了 shell 垫片 → Windows 会报 os error 193"
        );

        // Unix 语义下同一个目录选 `pi`（那边它才是对的）
        let picked_unix = first_pi_in(dir, &exec_names(false, None), false).unwrap();
        assert_eq!(picked_unix.file_name().unwrap(), "pi");
    }

    /// 只有 shell 垫片时**宁可报"未找到"**，也不要把脚本交给 CreateProcess
    /// （用户看到的 `%1 不是有效的 Win32 应用程序` 就是这么来的）。
    #[test]
    fn windows_ignores_a_lone_posix_shim() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(tmp.path().join("pi"), "#!/bin/sh\npi \"$@\"\n").unwrap();
        assert_eq!(first_pi_in(tmp.path(), &exec_names(true, None), true), None);

        // 但它要是真的 PE（有人把 pi.exe 改名成 pi），仍然接受
        std::fs::write(tmp.path().join("pi"), b"MZ\x90\x00fake-pe").unwrap();
        let picked = first_pi_in(tmp.path(), &exec_names(true, None), true).unwrap();
        assert_eq!(picked.file_name().unwrap(), "pi");
    }

    /* ---------------- 垫片 → 真实命令（标题那条路的换行 bug） ---------------- */

    /// 夹具用**本机真实读到的** pnpm 垫片形状（逐行 `Get-Content` 核对过），
    /// 把两个路径参数化，好让用例决定哪个分支真的存在。
    ///
    /// ⚠️ 第一版夹具写错了三处，都值得记下来：
    ///   ① 我以为 `"%~dp0\node.exe"` 单独占一行，实际它在 `@IF EXIST …` **那一行上**；
    ///   ② 我漏看了"分支 1 可能走不到"——本机 `%~dp0\node.exe` **不存在**，
    ///      所以垫片实际执行的是 ELSE 支里**裸写的 `node`**（cmd 从 PATH 取它）；
    ///   ③ 失败信息我写成了 `assert_eq!` 的第三个参数（它只收两个值），
    ///      于是屏幕上只剩一个光秃秃的行号，白查了一轮。
    /// 所以现在：夹具参数化、分支按"文件是否真的存在"选、断言都带消息。
    fn pnpm_shim(interp: &str, script: &str) -> String {
        format!(
            "@SETLOCAL\r\n\
             @IF EXIST \"%~dp0\\node.exe\" (\r\n\
             \x20 \"%~dp0\\node.exe\"  \"{script}\" %*\r\n\
             ) ELSE (\r\n\
             \x20 @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n\
             \x20 {interp}  \"{script}\" %*\r\n\
             )\r\n"
        )
    }

    /// 分支 1：垫片同目录**真的有** `node.exe` → 直接用它，脚本也跟着 `%~dp0` 展开。
    #[test]
    fn shim_prefers_the_node_next_to_it() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("node.exe"), b"MZ fake").unwrap(); // 只查存在性
        std::fs::write(dir.join("cli.js"), "// entry").unwrap();
        let text = pnpm_shim("%~dp0\\node.exe", "%~dp0\\cli.js");

        let (program, script) = parse_shim_command(&text, dir).expect("应当解析出分支 1");
        assert_eq!(program, dir.join("node.exe"));
        assert_eq!(script, dir.join("cli.js"));
        // `%*`（参数转发标记）不该混进脚本路径
        assert!(
            !script.to_string_lossy().contains('%'),
            "参数转发标记混进来了：{}",
            script.display()
        );
        // 控制行不许被当成命令
        assert!(!program.to_string_lossy().contains("PATHEXT"));
    }

    /// 分支 2：垫片同目录**没有** `node.exe`（本机 pnpm 就是这个状态）→
    /// 落到 ELSE 支里裸写的 `node`，按 **cmd 的语义**从 PATH 解析。
    ///
    /// 这条正是用户那个 bug 能否被修好的分水岭：本机分支 1 走不到，
    /// 不认识分支 2 就等于什么都没修。
    #[test]
    fn shim_falls_back_to_the_bare_node_from_path() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("cli.js"), "// entry").unwrap();
        // 故意**不**建 node.exe → 分支 1 的判定为假
        let text = pnpm_shim("node", "%~dp0\\cli.js");

        match parse_shim_command(&text, dir) {
            Some((program, script)) => {
                assert!(
                    program
                        .file_name()
                        .map(|n| n.to_string_lossy().to_ascii_lowercase().starts_with("node"))
                        .unwrap_or(false),
                    "分支 2 应当解析成 PATH 上的真 node，实际 {}",
                    program.display()
                );
                assert!(Path::is_file(&program), "PATH 命中的 node 应当存在");
                assert_eq!(script, dir.join("cli.js"));
            }
            None => eprintln!("本机 PATH 上没有 node，这条只验了\"不 panic\""),
        }
    }

    /// 分支 1 的文件在、但**脚本不在**（路径过期/换机器）→ `direct_command` 不接手
    /// （纯解析层 `parse_shim_command` 不管存在性，所以这条必须量外层那道闸门）。
    #[test]
    fn direct_command_declines_when_the_script_is_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        std::fs::write(dir.join("node.exe"), b"MZ fake").unwrap();
        let shim = dir.join("pi.cmd");
        std::fs::write(&shim, pnpm_shim("%~dp0\\node.exe", "%~dp0\\gone\\cli.js")).unwrap();
        assert!(
            direct_command(&shim).is_none(),
            "脚本不存在时不该接手（否则用户看到的是 node 的 ENOENT，而不是 pi 的原话）"
        );

        // 反面：脚本补上之后同一个垫片就该被接手
        //（否则上一条可能只是"永远返回 None"，那样它什么都没验证）
        std::fs::write(dir.join("cli.js"), "// entry").unwrap();
        std::fs::write(&shim, pnpm_shim("%~dp0\\node.exe", "%~dp0\\cli.js")).unwrap();
        let (program, args) = direct_command(&shim).expect("文件齐了就该接手");
        assert_eq!(program, dir.join("node.exe"));
        assert_eq!(args, vec![dir.join("cli.js").to_string_lossy().into_owned()]);
    }

    /// 不是 `.cmd`/`.bat` 的一律不接手（`.exe` 直接跑就好，没有 cmd 转义那一层）。
    #[test]
    fn direct_command_only_handles_batch_shims() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = tmp.path().join("pi.exe");
        std::fs::write(&exe, b"MZ fake").unwrap();
        assert!(direct_command(&exe).is_none(), ".exe 不该被解析，它本来就直连");

        let bare = tmp.path().join("pi");
        std::fs::write(&bare, "#!/bin/sh\n").unwrap();
        assert!(direct_command(&bare).is_none());
    }

    /// **真机核对**：本机 PATH 上那个垫片必须能被解析出来，且解析结果真的可执行。
    /// 这条是"我照着本机 pnpm 的写法写的解析器"的反向验证 —— 换个机器/换个包管理器
    /// （npm 的垫片写法略有不同）时，它会在这里红，而不是在用户点按钮时红。
    #[test]
    fn real_machine_shim_resolves_to_a_runnable_command() {
        let Some(bin) = which_pi() else {
            eprintln!("本机没有 pi，跳过");
            return;
        };
        if bin.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()) != Some("cmd".into()) {
            eprintln!("本机的 pi 不是 .cmd 垫片（{:?}），跳过", bin);
            return;
        }
        let (program, args) = direct_command(&bin).unwrap_or_else(|| panic!("本机的垫片没解析出来：{}", bin.display()));
        assert!(program.is_file(), "解析出的解释器不存在：{}", program.display());
        assert!(
            args.first().map(|a| Path::new(a).is_file()).unwrap_or(false),
            "解析出的入口脚本不存在：{args:?}"
        );
        // 真的跑一次：`--version` 必须成功，且回的就是 pi 的版本号
        let out = std::process::Command::new(&program)
            .args(&args)
            .arg("--version")
            .stdin(std::process::Stdio::null())
            .output()
            .expect("应当能启动解析出的命令");
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(out.status.success(), "解析出的命令跑不起来：{text}");
        /* 只要求"输出里有一个像版本号的片段"，**不钉具体版本** ——
        2026-10-09 之前这里写的是 `contains("0.87")`，于是用户把 pi 升到 1.1.0 之后
        这条会在 Windows 真机上红（macOS 因为提前 return 躲过去了）。
        这条用例要守的是"解析出来的命令**真的能跑 pi**"，不是"用户装的是哪一版"。 */
        let looks_like_version = text
            .split_whitespace()
            .any(|tok| tok.chars().next().is_some_and(|c| c.is_ascii_digit()) && tok.contains('.'));
        assert!(looks_like_version, "版本输出不像 pi：{text}");
        eprintln!("真机核对：{} → {} {}", bin.display(), program.display(), args[0]);
    }

    /// **这是用户那个报错的回归测试**：多行参数交给 `.cmd` 垫片必失败，
    /// 交给解析出来的真实命令则成功。
    ///
    /// 前半段量的是标准库的行为（不依赖 pi）：std 拒绝对批处理文件传含换行的参数，
    /// 报的就是 `batch file arguments are invalid` 那句原文。
    #[cfg(windows)]
    #[test]
    fn multiline_args_fail_on_a_shim_but_work_on_the_real_command() {
        let tmp = tempfile::tempdir().unwrap();
        let script = tmp.path().join("echo-args.js");
        // 一个只回显 argv 的 node 脚本：证明"参数真的原样到了"，不是只证明进程起来了
        std::fs::write(&script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));").unwrap();
        let Some(node) = which_node_for_test() else {
            eprintln!("找不到 node，跳过");
            return;
        };
        let multiline = "line1\nline2";

        // ① 垫片形状：std 直接拒绝（这就是用户看到的那句话）
        let shim = tmp.path().join("pi.cmd");
        std::fs::write(
            &shim,
            format!("@echo off\r\n\"{}\" \"{}\" %*\r\n", node.display(), script.display()),
        )
        .unwrap();
        let err = std::process::Command::new(&shim)
            .arg(multiline)
            .output()
            .expect_err("含换行的参数交给 .cmd 应当被 std 拒绝");
        assert!(
            err.to_string().contains("batch file arguments are invalid"),
            "报错文案变了，用户看到的那句就对不上了：{err}"
        );

        // ② 解析之后：同一个参数交给真实命令 → 原样送达
        let (program, args) = direct_command(&shim).expect("应当解析出 node + 脚本");
        let out = std::process::Command::new(&program)
            .args(&args)
            .arg(multiline)
            .output()
            .expect("解析出的命令应当能跑");
        let echoed = String::from_utf8_lossy(&out.stdout);
        assert_eq!(echoed, r#"["line1\nline2"]"#, "参数没有原样送达：{echoed}");
    }

    /// 测试里要一个 node（垫片解析的产物就是 node）。
    ///
    /// ⚠️ **不要往 `pnpm/bin/node.exe` 找**：本机那里根本没有（实测 `False`），
    /// pnpm 的垫片自己也是靠 ELSE 分支从 PATH 取 `node` 的。所以就照 PATH 找。
    #[cfg(windows)]
    fn which_node_for_test() -> Option<PathBuf> {
        let path = std::env::var("PATH").ok()?;
        crate::open_in_app::host::which_in("node", &path, std::env::var("PATHEXT").ok().as_deref())
    }

    #[test]
    fn windows_well_known_dirs_are_windows_dirs() {
        let env = WellKnownEnv {
            home: Some(PathBuf::from(r"C:\Users\wxk")),
            appdata: Some(PathBuf::from(r"C:\Users\wxk\AppData\Roaming")),
            localappdata: Some(PathBuf::from(r"C:\Users\wxk\AppData\Local")),
        };
        let names = exec_names(true, None);
        let cands = well_known_candidates(&env, true, &names);
        let shown: Vec<String> = cands.iter().map(|c| c.display().to_string()).collect();
        // pnpm 的全局 bin 与 npm 的前缀（Windows 上真正放 pi.cmd 的地方）
        assert!(
            shown
                .iter()
                .any(|c| c.contains("AppData\\Local") && c.contains("pnpm") && c.ends_with("pi.cmd")),
            "没有 pnpm 目录：{shown:?}"
        );
        assert!(
            shown
                .iter()
                .any(|c| c.contains("AppData\\Roaming") && c.contains("npm")),
            "没有 npm 目录：{shown:?}"
        );
        // 不能把 Unix 路径混进来
        assert!(!shown.iter().any(|c| c.contains("/usr/local/bin")), "{shown:?}");

        // Unix 侧保持原样（含 Homebrew 与 pnpm 的 macOS 路径）
        let unix_env = WellKnownEnv {
            home: Some(PathBuf::from("/Users/wxk")),
            appdata: None,
            localappdata: None,
        };
        let unix: Vec<String> = well_known_candidates(&unix_env, false, &exec_names(false, None))
            .iter()
            .map(|c| c.display().to_string())
            .collect();
        for want in [
            "/Users/wxk/.local/bin/pi",
            "/usr/local/bin/pi",
            "/opt/homebrew/bin/pi",
            "/Users/wxk/Library/pnpm/bin/pi",
            "/Users/wxk/.cargo/bin/pi",
        ] {
            assert!(unix.contains(&want.to_string()), "缺 {want}：{unix:?}");
        }
    }

    /* ---- 来源矩阵（纯函数，脱离 PATH/HOME/文件系统） ---- */

    fn tmpfile(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join("piggy-discovery-test");
        std::fs::create_dir_all(&d).unwrap();
        let p = d.join(name);
        std::fs::write(&p, b"x").unwrap();
        p
    }

    /// 选了 system：即使包内也有 pi，也必须用系统的。
    /// 这是明确的产品要求——打包捆绑自定义 pi，但默认不劫持用户已有的安装。
    #[test]
    fn system_wins_over_bundled_when_both_exist() {
        let sys = tmpfile("sys-pi");
        let builtin = tmpfile("builtin-pi");
        let (path, src, _) = pick_source(PiSource::System, None, Some(&builtin), Some(sys.clone())).unwrap();
        assert_eq!(path, sys);
        assert_eq!(src, PiSource::System);
    }

    /// 选了 system 但系统没装：回退到捆绑，并如实报告来源变成了 bundled。
    #[test]
    fn system_falls_back_to_bundled_when_absent() {
        let builtin = tmpfile("builtin-pi");
        let (path, src, via) = pick_source(PiSource::System, None, Some(&builtin), None).unwrap();
        assert_eq!(path, builtin);
        assert_eq!(src, PiSource::Bundled, "回退后来源必须如实反映，不能仍报 system");
        assert!(via.contains("回退"), "说明里要写清是回退来的: {via}");
    }

    /// 两边都没有：报 NotFound（可操作的提示在 Display 里）。
    #[test]
    fn system_with_nothing_available_is_not_found() {
        assert!(matches!(
            pick_source(PiSource::System, None, None, None),
            Err(DiscoveryError::NotFound)
        ));
    }

    /// 选了 bundled：即使系统有 pi，也不能用系统的。
    #[test]
    fn bundled_ignores_the_system_binary() {
        let sys = tmpfile("sys-pi");
        let builtin = tmpfile("builtin-pi");
        let (path, src, _) = pick_source(PiSource::Bundled, None, Some(&builtin), Some(sys)).unwrap();
        assert_eq!(path, builtin);
        assert_eq!(src, PiSource::Bundled);
    }

    /// bundled 档但包内没有（lite SKU）：报 BuiltinMissing，且不该退到系统 pi——
    /// 用户明确要的是打包进来的那个，静默换成另一个更糟。
    #[test]
    fn bundled_does_not_silently_fall_back_to_system() {
        let sys = tmpfile("sys-pi");
        let e = pick_source(PiSource::Bundled, None, None, Some(sys)).unwrap_err();
        assert!(matches!(e, DiscoveryError::BuiltinMissing), "got {e:?}");
    }

    /// custom 档：路径存在就用它，且优先于 bundled / system。
    #[test]
    fn custom_path_wins() {
        let sys = tmpfile("sys-pi");
        let builtin = tmpfile("builtin-pi");
        let mine = tmpfile("mine-pi");
        let (path, src, _) = pick_source(PiSource::Custom, Some(&mine), Some(&builtin), Some(sys)).unwrap();
        assert_eq!(path, mine);
        assert_eq!(src, PiSource::Custom);
    }

    /// custom 档未填路径 / 路径不存在：都要报出可操作的信息，而不是回退到别的二进制。
    #[test]
    fn custom_never_falls_back() {
        let sys = tmpfile("sys-pi");
        assert!(matches!(
            pick_source(PiSource::Custom, None, None, Some(sys.clone())),
            Err(DiscoveryError::CustomPathMissing(_))
        ));
        assert!(matches!(
            pick_source(PiSource::Custom, Some(Path::new("/nope/pi")), None, Some(sys)),
            Err(DiscoveryError::CustomPathMissing(_))
        ));
    }
}
