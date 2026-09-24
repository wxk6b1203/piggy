//! 「打开方式」应用目录 —— 移植 DSH `dsh-host-open-in-app` 的 `catalog.ts`（docs/11 §2.1）。
//!
//! 编译期固定的一张表：每个条目声明**按平台**依次尝试的定位链（locator chain）。
//! 表里只有数据，平台解析在 `resolver.rs`，图标提取在 `icons.rs`。
//!
//! 为什么是白名单而不是扫 `/Applications`：操作系统能告诉你"装了什么"，
//! 但**不能**告诉你"它接受一个工作目录、以及用什么协议接受"。
//! 扫出来的列表里会有大量不认目录参数的应用（截图工具、播放器……），
//! 点下去要么没反应要么开成别的窗口。DSH 因此把目录做成编译期白名单，
//! 这里逐条照搬（含菜单顺序）。

/// 启动参数里代表工作目录的占位符（`--cd={path}`）；参数里没出现时目录追加在末尾。
pub const PATH_TOKEN: &str = "{path}";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Darwin,
    Win32,
    Linux,
}

impl Platform {
    /// 编译/运行平台。三个平台之外（BSD 等）当作 Linux 之外无目录 → 菜单为空。
    pub fn current() -> Option<Platform> {
        if cfg!(target_os = "macos") {
            Some(Platform::Darwin)
        } else if cfg!(target_os = "windows") {
            Some(Platform::Win32)
        } else if cfg!(target_os = "linux") {
            Some(Platform::Linux)
        } else {
            None
        }
    }
}

/// 静态启动方式（目录表里的形态；`{path}` 在解析后代入）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Launch {
    /// 交给操作系统 shell 的 open 动词（文件管理器）：macOS/Windows `open <path>`，Linux `xdg-open <path>`。
    ShellOpen,
    /// argv 直接执行，**永不经过 shell**（没有引号/注入面）。
    Argv {
        command: &'static str,
        args: &'static [&'static str],
    },
}

/// 一条定位链上的一个环节。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locator {
    /// 随操作系统发行、恒定存在的条目；`icon_path` 直接信任（不探测）。
    Fixed {
        launch: Launch,
        icon_path: Option<&'static str>,
    },
    /// macOS：在已知应用目录里找这些 bundle 拼写。
    App { fs_names: &'static [&'static str] },
    /// macOS：`xcode-select -p` → 反推 bundle（Beta / 改名安装也能找到）。
    Xcode,
    /// PATH 上的可执行文件（Linux 与 Windows CLI 名）。
    Cli {
        name: &'static str,
        args: &'static [&'static str],
        /// 只有在有桌面会话时才有意义（`xdg-open` 这类）。
        requires_desktop: bool,
    },
    /// 第一个存在的候选文件。
    File {
        candidates: &'static [&'static str],
        args: &'static [&'static str],
    },
    /// Windows `App Paths` 注册表项。
    AppPaths {
        exe: &'static str,
        args: &'static [&'static str],
    },
    /// Windows 卸载记录（用记录指向的可执行文件反证，光有记录不算）。
    InstallRecord {
        display_prefix: &'static str,
        rel_launcher: &'static str,
        args: &'static [&'static str],
    },
    /// Windows 版本化安装目录（`.../JetBrains/GoLand 2024.1`），按版本号倒序找最新的。
    Scan {
        root: &'static str,
        name_prefix: &'static str,
        rel_launcher: &'static str,
        args: &'static [&'static str],
    },
    /// Windows GitHub Desktop：版本化目录里的 `GitHubDesktop.exe` + 打包的 `cli.js`。
    GithubDesktop { root: &'static str },
    /// Linux XDG desktop entry。
    Desktop {
        desktop_id: &'static str,
        args: &'static [&'static str],
    },
}

pub struct AppEntry {
    pub id: &'static str,
    pub darwin: &'static [Locator],
    pub win32: &'static [Locator],
    pub linux: &'static [Locator],
    /// Linux 图标来源：这个条目归哪个 desktop entry（`Icon=` 指向主题里的图）。
    pub desktop_id: Option<&'static str>,
}

/// 条目的平台定位链；该平台没声明 = 空链（解析为"未安装"）。
pub fn spec_for(app: &AppEntry, platform: Platform) -> &'static [Locator] {
    match platform {
        Platform::Darwin => app.darwin,
        Platform::Win32 => app.win32,
        Platform::Linux => app.linux,
    }
}

/// 应用目录，**按菜单顺序**：文件管理器 → 编辑器/IDE → Git GUI → 终端。
///
/// Finder / Terminal / Explorer 随操作系统发行，它们的定位链恒定可解析。
/// macOS 只列常见 bundle 拼写：改名或挪到 `/Applications`、`~/Applications`
/// 之外的 bundle 找不到（不做 Launch Services 查询，也不扫盘 —— 见 README 限制）。
pub const CATALOG: &[AppEntry] = &[
    AppEntry {
        id: "finder",
        darwin: &[Locator::Fixed {
            launch: Launch::ShellOpen,
            icon_path: Some("/System/Library/CoreServices/Finder.app"),
        }],
        win32: &[],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "explorer",
        darwin: &[],
        win32: &[Locator::Fixed {
            launch: Launch::ShellOpen,
            icon_path: Some("${SystemRoot}/explorer.exe"),
        }],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "filemanager",
        darwin: &[],
        win32: &[],
        linux: &[Locator::Cli {
            name: "xdg-open",
            args: &[],
            requires_desktop: true,
        }],
        desktop_id: None,
    },
    AppEntry {
        id: "cursor",
        darwin: &[Locator::App {
            fs_names: &["Cursor.app"],
        }],
        win32: &[
            Locator::AppPaths {
                exe: "Cursor.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "Cursor",
                rel_launcher: "",
                args: &[],
            },
            Locator::File {
                candidates: &["${LOCALAPPDATA}/Programs/cursor/Cursor.exe"],
                args: &[],
            },
        ],
        linux: &[Locator::Cli {
            name: "cursor",
            args: &[],
            requires_desktop: false,
        }],
        desktop_id: None,
    },
    AppEntry {
        id: "vscode",
        darwin: &[Locator::App {
            fs_names: &["Visual Studio Code.app"],
        }],
        win32: &[
            Locator::AppPaths {
                exe: "Code.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "Microsoft Visual Studio Code",
                rel_launcher: "Code.exe",
                args: &[],
            },
            Locator::File {
                candidates: &[
                    "${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe",
                    "${ProgramFiles}/Microsoft VS Code/Code.exe",
                ],
                args: &[],
            },
        ],
        linux: &[Locator::Cli {
            name: "code",
            args: &[],
            requires_desktop: false,
        }],
        desktop_id: Some("code"),
    },
    AppEntry {
        id: "vscodeinsiders",
        darwin: &[Locator::App {
            fs_names: &["Visual Studio Code - Insiders.app"],
        }],
        win32: &[
            Locator::AppPaths {
                exe: "Code - Insiders.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "Microsoft Visual Studio Code Insiders",
                rel_launcher: "Code - Insiders.exe",
                args: &[],
            },
            Locator::File {
                candidates: &["${LOCALAPPDATA}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe"],
                args: &[],
            },
        ],
        linux: &[Locator::Cli {
            name: "code-insiders",
            args: &[],
            requires_desktop: false,
        }],
        desktop_id: Some("code-insiders"),
    },
    AppEntry {
        id: "windsurf",
        darwin: &[Locator::App {
            fs_names: &["Windsurf.app"],
        }],
        win32: &[
            Locator::AppPaths {
                exe: "Windsurf.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "Windsurf",
                rel_launcher: "",
                args: &[],
            },
            Locator::File {
                candidates: &["${LOCALAPPDATA}/Programs/Windsurf/Windsurf.exe"],
                args: &[],
            },
        ],
        linux: &[Locator::Cli {
            name: "windsurf",
            args: &[],
            requires_desktop: false,
        }],
        desktop_id: None,
    },
    AppEntry {
        id: "zed",
        darwin: &[Locator::App {
            fs_names: &["Zed.app", "Zed Preview.app"],
        }],
        win32: &[],
        linux: &[
            Locator::Cli {
                name: "zed",
                args: &[],
                requires_desktop: false,
            },
            Locator::Desktop {
                desktop_id: "dev.zed.Zed",
                args: &[],
            },
        ],
        desktop_id: Some("dev.zed.Zed"),
    },
    AppEntry {
        id: "sublimetext",
        darwin: &[Locator::App {
            fs_names: &["Sublime Text.app"],
        }],
        win32: &[
            Locator::AppPaths {
                exe: "sublime_text.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "Sublime Text",
                rel_launcher: "",
                args: &[],
            },
            Locator::File {
                candidates: &["${ProgramFiles}/Sublime Text/sublime_text.exe"],
                args: &[],
            },
        ],
        linux: &[Locator::Cli {
            name: "subl",
            args: &[],
            requires_desktop: false,
        }],
        desktop_id: Some("sublime_text"),
    },
    AppEntry {
        id: "xcode",
        darwin: &[Locator::Xcode],
        win32: &[],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "androidstudio",
        darwin: &[Locator::App {
            fs_names: &["Android Studio.app"],
        }],
        win32: &[
            Locator::InstallRecord {
                display_prefix: "Android Studio",
                rel_launcher: "bin/studio64.exe",
                args: &[],
            },
            Locator::File {
                candidates: &["${ProgramFiles}/Android/Android Studio/bin/studio64.exe"],
                args: &[],
            },
        ],
        linux: &[
            Locator::Cli {
                name: "studio",
                args: &[],
                requires_desktop: false,
            },
            Locator::File {
                candidates: &[
                    "~/.local/share/JetBrains/Toolbox/scripts/studio",
                    "/opt/android-studio/bin/studio.sh",
                ],
                args: &[],
            },
        ],
        desktop_id: None,
    },
    // ---- JetBrains 家族（DSH `jetBrains()` 工厂的等价展开）----
    AppEntry {
        id: "intellij",
        darwin: &[Locator::App {
            fs_names: &[
                "IntelliJ IDEA.app",
                "IntelliJ IDEA Ultimate.app",
                "IntelliJ IDEA CE.app",
            ],
        }],
        win32: &[
            Locator::Scan {
                root: "${ProgramFiles}/JetBrains",
                name_prefix: "IntelliJ IDEA",
                rel_launcher: "bin/idea64.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "IntelliJ IDEA",
                rel_launcher: "bin/idea64.exe",
                args: &[],
            },
        ],
        linux: &[
            Locator::Cli {
                name: "idea",
                args: &[],
                requires_desktop: false,
            },
            Locator::File {
                candidates: &["~/.local/share/JetBrains/Toolbox/scripts/idea"],
                args: &[],
            },
        ],
        desktop_id: None,
    },
    AppEntry {
        id: "pycharm",
        darwin: &[Locator::App {
            fs_names: &[
                "PyCharm.app",
                "PyCharm Professional.app",
                "PyCharm CE.app",
                "PyCharm Community.app",
            ],
        }],
        win32: &[
            Locator::Scan {
                root: "${ProgramFiles}/JetBrains",
                name_prefix: "PyCharm",
                rel_launcher: "bin/pycharm64.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "PyCharm",
                rel_launcher: "bin/pycharm64.exe",
                args: &[],
            },
        ],
        linux: &[
            Locator::Cli {
                name: "pycharm",
                args: &[],
                requires_desktop: false,
            },
            Locator::File {
                candidates: &["~/.local/share/JetBrains/Toolbox/scripts/pycharm"],
                args: &[],
            },
        ],
        desktop_id: None,
    },
    AppEntry {
        id: "webstorm",
        darwin: &[Locator::App {
            fs_names: &["WebStorm.app"],
        }],
        win32: &[
            Locator::Scan {
                root: "${ProgramFiles}/JetBrains",
                name_prefix: "WebStorm",
                rel_launcher: "bin/webstorm64.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "WebStorm",
                rel_launcher: "bin/webstorm64.exe",
                args: &[],
            },
        ],
        linux: &[
            Locator::Cli {
                name: "webstorm",
                args: &[],
                requires_desktop: false,
            },
            Locator::File {
                candidates: &["~/.local/share/JetBrains/Toolbox/scripts/webstorm"],
                args: &[],
            },
        ],
        desktop_id: None,
    },
    AppEntry {
        id: "phpstorm",
        darwin: &[Locator::App {
            fs_names: &["PhpStorm.app"],
        }],
        win32: &[
            Locator::Scan {
                root: "${ProgramFiles}/JetBrains",
                name_prefix: "PhpStorm",
                rel_launcher: "bin/phpstorm64.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "PhpStorm",
                rel_launcher: "bin/phpstorm64.exe",
                args: &[],
            },
        ],
        linux: &[
            Locator::Cli {
                name: "phpstorm",
                args: &[],
                requires_desktop: false,
            },
            Locator::File {
                candidates: &["~/.local/share/JetBrains/Toolbox/scripts/phpstorm"],
                args: &[],
            },
        ],
        desktop_id: None,
    },
    AppEntry {
        id: "goland",
        darwin: &[Locator::App {
            fs_names: &["GoLand.app"],
        }],
        win32: &[
            Locator::Scan {
                root: "${ProgramFiles}/JetBrains",
                name_prefix: "GoLand",
                rel_launcher: "bin/goland64.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "GoLand",
                rel_launcher: "bin/goland64.exe",
                args: &[],
            },
        ],
        linux: &[
            Locator::Cli {
                name: "goland",
                args: &[],
                requires_desktop: false,
            },
            Locator::File {
                candidates: &["~/.local/share/JetBrains/Toolbox/scripts/goland"],
                args: &[],
            },
        ],
        desktop_id: None,
    },
    AppEntry {
        id: "rider",
        darwin: &[Locator::App {
            fs_names: &["Rider.app", "JetBrains Rider.app"],
        }],
        win32: &[
            Locator::Scan {
                root: "${ProgramFiles}/JetBrains",
                name_prefix: "Rider",
                rel_launcher: "bin/rider64.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "Rider",
                rel_launcher: "bin/rider64.exe",
                args: &[],
            },
        ],
        linux: &[
            Locator::Cli {
                name: "rider",
                args: &[],
                requires_desktop: false,
            },
            Locator::File {
                candidates: &["~/.local/share/JetBrains/Toolbox/scripts/rider"],
                args: &[],
            },
        ],
        desktop_id: None,
    },
    AppEntry {
        id: "rustrover",
        darwin: &[Locator::App {
            fs_names: &["RustRover.app"],
        }],
        win32: &[
            Locator::Scan {
                root: "${ProgramFiles}/JetBrains",
                name_prefix: "RustRover",
                rel_launcher: "bin/rustrover64.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "RustRover",
                rel_launcher: "bin/rustrover64.exe",
                args: &[],
            },
        ],
        linux: &[
            Locator::Cli {
                name: "rustrover",
                args: &[],
                requires_desktop: false,
            },
            Locator::File {
                candidates: &["~/.local/share/JetBrains/Toolbox/scripts/rustrover"],
                args: &[],
            },
        ],
        desktop_id: None,
    },
    // ---- Git GUI ----
    AppEntry {
        id: "fork",
        darwin: &[Locator::App {
            fs_names: &["Fork.app"],
        }],
        win32: &[
            Locator::InstallRecord {
                display_prefix: "Fork",
                rel_launcher: "",
                args: &[],
            },
            Locator::File {
                candidates: &["${LOCALAPPDATA}/Fork/Fork.exe"],
                args: &[],
            },
        ],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "sourcetree",
        darwin: &[Locator::App {
            fs_names: &["Sourcetree.app"],
        }],
        win32: &[],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "github",
        darwin: &[Locator::App {
            fs_names: &["GitHub Desktop.app"],
        }],
        win32: &[Locator::GithubDesktop {
            root: "${LOCALAPPDATA}/GitHubDesktop",
        }],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "tower",
        darwin: &[Locator::App {
            fs_names: &["Tower.app"],
        }],
        win32: &[],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "gitkraken",
        darwin: &[Locator::App {
            fs_names: &["GitKraken.app"],
        }],
        win32: &[],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "smartgit",
        darwin: &[Locator::App {
            fs_names: &["SmartGit.app"],
        }],
        win32: &[],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "sublimemerge",
        darwin: &[Locator::App {
            fs_names: &["Sublime Merge.app"],
        }],
        win32: &[
            Locator::AppPaths {
                exe: "sublime_merge.exe",
                args: &[],
            },
            Locator::InstallRecord {
                display_prefix: "Sublime Merge",
                rel_launcher: "",
                args: &[],
            },
            Locator::File {
                candidates: &["${ProgramFiles}/Sublime Merge/sublime_merge.exe"],
                args: &[],
            },
        ],
        linux: &[Locator::Cli {
            name: "smerge",
            args: &[],
            requires_desktop: false,
        }],
        desktop_id: Some("sublime_merge"),
    },
    // ---- 终端 ----
    AppEntry {
        id: "ghostty",
        darwin: &[Locator::App {
            fs_names: &["Ghostty.app"],
        }],
        win32: &[],
        linux: &[
            Locator::Cli {
                name: "ghostty",
                args: &["--working-directory={path}"],
                requires_desktop: false,
            },
            Locator::Desktop {
                desktop_id: "com.mitchellh.ghostty",
                args: &["--working-directory={path}"],
            },
        ],
        desktop_id: Some("com.mitchellh.ghostty"),
    },
    AppEntry {
        id: "warp",
        darwin: &[Locator::App {
            fs_names: &["Warp.app"],
        }],
        win32: &[],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "iterm",
        darwin: &[Locator::App {
            fs_names: &["iTerm.app"],
        }],
        win32: &[],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "kitty",
        darwin: &[Locator::App {
            fs_names: &["kitty.app"],
        }],
        win32: &[],
        linux: &[
            Locator::Cli {
                name: "kitty",
                args: &["--directory"],
                requires_desktop: false,
            },
            Locator::Desktop {
                desktop_id: "kitty",
                args: &["--directory"],
            },
        ],
        desktop_id: Some("kitty"),
    },
    AppEntry {
        id: "terminal",
        darwin: &[Locator::Fixed {
            launch: Launch::Argv {
                command: "open",
                args: &["-a", "Terminal"],
            },
            icon_path: Some("/System/Applications/Utilities/Terminal.app"),
        }],
        win32: &[],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "windowsterminal",
        darwin: &[],
        win32: &[Locator::Cli {
            name: "wt",
            args: &["-d"],
            requires_desktop: false,
        }],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "gitbash",
        darwin: &[],
        win32: &[
            // Git for Windows 注册成 "Git version <x.y.z>"；只用 "Git" 前缀会撞上 GitHub Desktop。
            Locator::InstallRecord {
                display_prefix: "Git version",
                rel_launcher: "git-bash.exe",
                args: &["--cd={path}"],
            },
            Locator::File {
                candidates: &["${ProgramFiles}/Git/git-bash.exe"],
                args: &["--cd={path}"],
            },
        ],
        linux: &[],
        desktop_id: None,
    },
    AppEntry {
        id: "gnometerminal",
        darwin: &[],
        win32: &[],
        linux: &[
            Locator::Cli {
                name: "gnome-terminal",
                args: &["--working-directory={path}"],
                requires_desktop: false,
            },
            Locator::Desktop {
                desktop_id: "org.gnome.Terminal",
                args: &["--working-directory={path}"],
            },
        ],
        desktop_id: Some("org.gnome.Terminal"),
    },
    AppEntry {
        id: "konsole",
        darwin: &[],
        win32: &[],
        linux: &[
            Locator::Cli {
                name: "konsole",
                args: &["--workdir"],
                requires_desktop: false,
            },
            Locator::Desktop {
                desktop_id: "org.kde.konsole",
                args: &["--workdir"],
            },
        ],
        desktop_id: Some("org.kde.konsole"),
    },
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ids_are_unique_and_ordered() {
        let mut seen = HashSet::new();
        for app in CATALOG {
            assert!(seen.insert(app.id), "重复的 id: {}", app.id);
            assert!(!app.id.is_empty());
            assert!(
                app.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()),
                "id 必须是纯小写字母数字（前端词典的键）: {}",
                app.id
            );
        }
        // 菜单顺序：文件管理器在最前，终端在最后（DSH catalog 的排布）
        assert_eq!(CATALOG[0].id, "finder");
        assert_eq!(CATALOG.last().unwrap().id, "konsole");
    }

    #[test]
    fn every_entry_declares_at_least_one_platform() {
        for app in CATALOG {
            assert!(
                !app.darwin.is_empty() || !app.win32.is_empty() || !app.linux.is_empty(),
                "{} 在任何平台都不可解析 = 死条目",
                app.id
            );
        }
    }

    /// `{path}` 只能出现在**整段参数**里，且不能同时出现"带 {path} 的参数"和"需要追加目录"的歧义。
    /// 真正的不变式由 resolver 的 `launch_args` 承担：有 token 就替换、没有就追加。
    #[test]
    fn path_token_only_in_args_that_need_it() {
        let mut users = Vec::new();
        for app in CATALOG {
            for platform in [Platform::Darwin, Platform::Win32, Platform::Linux] {
                for loc in spec_for(app, platform) {
                    let args: &[&str] = match loc {
                        Locator::Cli { args, .. }
                        | Locator::File { args, .. }
                        | Locator::AppPaths { args, .. }
                        | Locator::InstallRecord { args, .. }
                        | Locator::Scan { args, .. }
                        | Locator::Desktop { args, .. } => args,
                        Locator::Fixed { launch, .. } => match launch {
                            Launch::Argv { args, .. } => args,
                            Launch::ShellOpen => &[],
                        },
                        Locator::App { .. } | Locator::Xcode | Locator::GithubDesktop { .. } => &[],
                    };
                    if args.iter().any(|a| a.contains(PATH_TOKEN)) {
                        users.push((app.id, platform));
                    }
                }
            }
        }
        // 只有这几个条目把目录塞进参数（其余靠"追加在末尾"）
        let ids: HashSet<&str> = users.iter().map(|(id, _)| *id).collect();
        for expected in ["ghostty", "gitbash", "gnometerminal"] {
            assert!(ids.contains(expected), "{expected} 应该用 {{path}} 参数");
        }
        assert_eq!(ids.len(), 3, "意外的 {{path}} 使用方: {users:?}");
    }

    /// `requires_desktop` 目前只有 Linux 的 `xdg-open` 用了 —— 这是个**有意**的窄集合：
    /// 它决定"没有桌面会话时这一条不算数"，多标一个就会让某个应用在纯 CLI 环境下消失。
    #[test]
    fn desktop_only_locators_are_the_expected_ones() {
        let mut found = Vec::new();
        for app in CATALOG {
            for loc in app.linux {
                if let Locator::Cli {
                    name,
                    requires_desktop: true,
                    ..
                } = loc
                {
                    found.push(*name);
                }
            }
        }
        assert_eq!(found, vec!["xdg-open"]);
    }

    #[test]
    fn mac_entries_are_app_bundles_or_fixed() {
        for app in CATALOG {
            for loc in app.darwin {
                match loc {
                    Locator::App { fs_names } => {
                        for n in *fs_names {
                            assert!(n.ends_with(".app"), "{} 的 bundle 名不像 bundle: {n}", app.id);
                        }
                    }
                    Locator::Xcode | Locator::Fixed { .. } => {}
                    other => panic!("{} 在 macOS 上用了非 mac 定位器: {other:?}", app.id),
                }
            }
        }
    }
}
