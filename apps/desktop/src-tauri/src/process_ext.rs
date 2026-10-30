//! 子进程的 Windows 控制台窗口抑制（2026-10-30 真机报障）。
//!
//! 打包后的 Piggy 是 `windows_subsystem = "windows"` 的 GUI 进程，本身没有控制台。
//! 但 `std::process::Command` / `tokio::process::Command` 默认按 `CreateProcessW` 的
//! 缺省行为创建子进程：子进程是控制台程序（`pi`、`cmd.exe`、`git`、`powershell.exe`
//! 都是）且父进程没有控制台时，Windows 会给它**新分配一个控制台窗口**。
//!
//! 结果就是用户看到的"打开 Piggy 弹出一大堆命令行黑框"：
//! - 启动时 `discovery::verify` 跑一次 `pi --version`；
//! - 每个会话 tab 都起一个 `pi`（Windows 上还是 `cmd.exe` 垫片 → `node.exe`）；
//! - `prefetch_icons` 在后台给每个「打开方式」应用起一个 `powershell.exe` 抠图标；
//! - 收 worker 时 `taskkill`、探测/菜单命令 `reg.exe`、`git worktree` 等。
//!
//! `CREATE_NO_WINDOW`（0x0800_0000）让这些子进程**不创建控制台窗口**；它们仍然
//! 继承 stdin/stdout/stderr 管道，行为不变。需要显示 UI 的启动器（`explorer.exe`、
//! 文件关联打开）**不要**用它：那些走 `open_in_app::host::detach` 的
//! `DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP`，是另一套语义。
//!
//! 用 trait 而不是在每个调用点写 `#[cfg(windows)]`：调用点保持一行
//! `cmd.no_console_window()`，非 Windows 上是空操作，不会因为漏一个 `cfg`
//! 而在 macOS/Linux 上编译失败。

/// `CreateProcessW` 的 `CREATE_NO_WINDOW` 标志。
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 让子进程不要弹控制台窗口。非 Windows 上什么都没做。
pub trait NoConsoleWindow {
    fn no_console_window(&mut self) -> &mut Self;
}

#[cfg(windows)]
impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(windows)]
impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        self.creation_flags(CREATE_NO_WINDOW)
    }
}

#[cfg(not(windows))]
impl NoConsoleWindow for std::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}

#[cfg(not(windows))]
impl NoConsoleWindow for tokio::process::Command {
    fn no_console_window(&mut self) -> &mut Self {
        self
    }
}
