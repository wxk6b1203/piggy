//! 内嵌终端（docs/09 M4：OAuth 登录内嵌终端；xterm.js + portable-pty 路线，02 §2.10）。
//! 会话 = master 读写端 + 子进程；输出经后台线程 → `pty:out:<id>` 事件推给前端 xterm。
//! 退出检测：shell 退出即关闭 pty → reader EOF → `exited` 事件。

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde_json::json;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;

pub struct PtySession {
    pub writer: Box<dyn Write + Send>,
    pub master: Box<dyn portable_pty::MasterPty + Send>,
    pub child: Option<Box<dyn portable_pty::Child + Send + Sync>>,
}

pub type SharedPtyMap = Arc<std::sync::Mutex<HashMap<String, PtySession>>>;

pub struct PtyHandle {
    pub id: String,
    pub rows: u16,
    pub cols: u16,
}

/// 登录 shell 命令行构建（平台差异集中在此，便于单测）
pub fn build_login_shell() -> (String, Vec<String>) {
    if cfg!(windows) {
        ("cmd.exe".to_string(), vec!["/Q".to_string()])
    } else {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());
        (shell, vec!["-l".to_string()])
    }
}

/// 打开 PTY 并启动输出泵。返回句柄信息。
pub fn open_pty(
    map: &SharedPtyMap,
    app: &tauri::AppHandle,
    id: &str,
    cwd: &str,
    rows: u16,
    cols: u16,
) -> Result<PtyHandle, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("PTY 打开失败: {e}"))?;

    // 登录终端落在用户主目录（拿不到就退调用方给的 cwd）。老代码只看 HOME，
    // Windows 上会拿不到 → 直接落到 cwd，行为上"看起来没问题"但和 macOS 不一致。
    let home = crate::config::paths::home_dir()
        .map(|h| h.to_string_lossy().into_owned())
        .unwrap_or_else(|| cwd.to_string());
    let (prog, args) = build_login_shell();
    let mut cmd = CommandBuilder::new(prog);
    cmd.args(args);
    cmd.cwd(home);
    cmd.env("TERM", "xterm-256color");
    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("shell 启动失败: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("PTY reader 获取失败: {e}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("PTY writer 获取失败: {e}"))?;

    // 输出泵：逐块读 → 事件（lossy UTF-8；登录 TUI 场景可接受）
    let out_id = id.to_string();
    let out_app = app.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let text = String::from_utf8_lossy(&buf[..n]);
                    use tauri::Emitter;
                    let _ = out_app.emit(&format!("pty:out:{out_id}"), json!({ "data": text }));
                }
            }
        }
        use tauri::Emitter;
        let _ = out_app.emit(&format!("pty:out:{out_id}"), json!({ "exited": true }));
    });

    let session = PtySession {
        writer,
        master: pair.master,
        child: Some(child),
    };
    map.lock().map_err(|_| "PTY 表锁失败")?.insert(id.to_string(), session);
    Ok(PtyHandle { id: id.to_string(), rows, cols })
}

pub fn write_pty(map: &SharedPtyMap, id: &str, data: &str) -> Result<(), String> {
    let mut m = map.lock().map_err(|_| "PTY 表锁失败")?;
    let session = m.get_mut(id).ok_or_else(|| format!("PTY 不存在: {id}"))?;
    session.writer.write_all(data.as_bytes()).map_err(|e| format!("PTY 写入失败: {e}"))?;
    session.writer.flush().map_err(|e| format!("PTY flush 失败: {e}"))
}

pub fn resize_pty(map: &SharedPtyMap, id: &str, rows: u16, cols: u16) -> Result<(), String> {
    let m = map.lock().map_err(|_| "PTY 表锁失败")?;
    let session = m.get(id).ok_or_else(|| format!("PTY 不存在: {id}"))?;
    session
        .master
        .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| format!("PTY resize 失败: {e}"))
}

pub fn close_pty(map: &SharedPtyMap, id: &str) -> Result<(), String> {
    let mut m = map.lock().map_err(|_| "PTY 表锁失败")?;
    if let Some(mut session) = m.remove(id) {
        if let Some(mut child) = session.child.take() {
            let _ = child.kill();
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_shell_selection() {
        let (prog, args) = build_login_shell();
        if cfg!(windows) {
            assert_eq!(prog, "cmd.exe");
        } else {
            assert!(!prog.is_empty());
            assert_eq!(args, vec!["-l".to_string()]);
        }
    }

    #[cfg(unix)]
    #[test]
    fn pty_echo_roundtrip() {
        // 真实 PTY 回读（unix 可跑；验证 openpty→spawn→read 管线）
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        let mut cmd = CommandBuilder::new("/bin/echo");
        cmd.arg("piggy-pty-ok");
        let mut child = pair.slave.spawn_command(cmd).expect("spawn echo");
        drop(pair.slave);
        let mut reader = pair.master.try_clone_reader().expect("reader");
        // 先读到 EOF（子进程退出关闭 slave），再回收子进程
        let mut out = Vec::new();
        reader.read_to_end(&mut out).expect("read to eof");
        let _ = child.wait();
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("piggy-pty-ok"), "实际输出: {text:?}");
    }

    #[test]
    fn session_map_lifecycle() {
        let map: SharedPtyMap = Arc::new(std::sync::Mutex::new(HashMap::new()));
        assert!(write_pty(&map, "nope", "x").is_err());
        assert!(resize_pty(&map, "nope", 24, 80).is_err());
        assert!(close_pty(&map, "nope").is_ok()); // 关闭不存在的 = 幂等 ok
    }
}
