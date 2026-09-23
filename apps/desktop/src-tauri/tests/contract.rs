//! pi RPC 契约测试（docs/02 §9 C1–C10）——M0 DoD 第 1 条。
//!
//! 运行：`pnpm test:contract`（需要 PATH 上有真实 pi；C9 会消耗极少量 token）。
//! 每个测试把结论写入 stderr，验收后回填 docs/02 §9。

use piggy_lib::events::{CollectorSink, NullSink};
use piggy_lib::pi::client::{Worker, WorkerState};
use piggy_lib::pi::discovery::discover;
use piggy_lib::pi::permission::PermissionMode;
use piggy_lib::pi::process::{spawn_worker, SessionTarget, SpawnArgs};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

/// 测试产生的会话文件清理（防污染用户 ~/.pi/agent/sessions，M1 修正记录）
fn cleanup_session(file: &str) {
    let _ = std::fs::remove_file(file);
    if let Some(parent) = Path::new(file).parent() {
        let _ = std::fs::remove_dir(parent); // 仅空目录会成功
    }
}

fn pi_bin() -> PathBuf {
    // discover(override_path, builtin)：契约测试不注入覆盖路径，也不捆绑 standalone
    discover(None, None).expect("pi not found").path
}

async fn spawn(cwd: &Path, session: SessionTarget) -> Worker {
    spawn_worker(
        "contract-tab",
        SpawnArgs {
            cwd: cwd.to_path_buf(),
            pi_bin: pi_bin(),
            session,
            name: None,
            // 契约测试只验证 RPC 协议，不需要守卫脚本；用完全权限档避免依赖外部资源
            permission: PermissionMode::Full,
            guard_script: None,
        },
        Arc::new(NullSink),
    )
    .await
    .expect("spawn")
}

/// 在临时目录里建一个真实会话文件。
/// 契约事实：session 文件在**首个 LLM 回合完成时**才落盘（bash-only 追加只进内存），
/// 因此这里用一个最小 prompt 强制落盘（glm-5.3-flash 零成本）。
async fn make_session(tmp: &Path) -> String {
    let w = spawn(tmp, SessionTarget::New).await;
    w.bash("echo piggy-c1-setup").await.expect("bash append");
    w.prompt("Reply with exactly: OK", None, None).await.expect("prompt to force flush");
    // 等 settled（状态机 Ready）
    for _ in 0..60 {
        if w.state() == WorkerState::Ready { break; }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    let state = w.get_state().await.expect("state");
    let file = state["sessionFile"].as_str().expect("sessionFile").to_string();
    w.shutdown().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(PathBuf::from(&file).exists(), "session file should exist after first turn: {file}");
    file
}

/// C1：`pi --mode rpc --session <path>` 启动参数是否生效。
#[tokio::test]
async fn c1_session_flag() {
    let tmp = tempfile::tempdir().unwrap();
    let file = make_session(tmp.path()).await;
    let w = spawn(tmp.path(), SessionTarget::Path(file.clone())).await;
    let state = w.get_state().await.expect("get_state");
    let actual = state["sessionFile"].as_str().unwrap_or("<null>").to_string();
    eprintln!("C1: --session={} => sessionFile={}", file, actual);
    assert!(actual == file, "C1 FAIL: expected {file}, got {actual}");
    w.shutdown().await;
    cleanup_session(&file);
}

/// C2：Windows spawn 包装——macOS 上跳过，待 Windows CI。
#[tokio::test]
async fn c2_windows_spawn() {
    if !cfg!(windows) {
        eprintln!("C2: SKIP（非 Windows；pi.cmd/cmd /C 包装留待 Windows CI 验证）");
        return;
    }
}

/// C3：response 是否总是回显请求 id；不带 id 的响应形态。
#[tokio::test]
async fn c3_id_echo() {
    let tmp = tempfile::tempdir().unwrap();
    let w = spawn(tmp.path(), SessionTarget::NoSession).await;
    // 带 id（我们总是发字符串 id）
    let resp = w
        .raw_request("get_state", json!({}), Some(Duration::from_secs(10)))
        .await
        .expect("resp");
    eprintln!(
        "C3: id 回显 = {:?}（string）; command={:?} success={:?}",
        resp["id"], resp["command"], resp["success"]
    );
    assert_eq!(resp["id"].as_str().unwrap(), "1", "C3 FAIL: id 未回显");
    // 不带 id 的命令（手工构造）
    let line = r#"{"type":"get_state"}"#;
    // 直接读原始响应验证：发送无 id 命令，收集下一帧 response
    let sink = Arc::new(CollectorSink::default());
    let _ = sink; // 用带 sink 的 spawn 复测
    let w2 = spawn_worker(
        "c3b",
        SpawnArgs {
            cwd: tmp.path().to_path_buf(),
            pi_bin: pi_bin(),
            session: SessionTarget::NoSession,
            name: None,
            // 契约测试只验证 RPC 协议，不依赖守卫资源 → 用完全权限档
            permission: PermissionMode::Full,
            guard_script: None,
        },
        sink.clone(),
    )
    .await
    .unwrap();
    w2.stdin_send(line).await.unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    let responses: Vec<Value> = sink
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(_, v)| v["type"] == "response")
        .map(|(_, v)| v.clone())
        .collect();
    let no_id = responses.iter().find(|v| v.get("id").is_none()).cloned();
    eprintln!(
        "C3: 无 id 命令的 response 形态 = {}",
        no_id.map(|v| v.to_string()).unwrap_or_else(|| "<未观察到（response 不可见于事件通道——由 client 按 id 路由消耗）>".into())
    );
    w.shutdown().await;
    w2.shutdown().await;
}

/// C4：同一会话文件双开（GUI worker + 另一进程）的行为。
#[tokio::test]
async fn c4_double_open() {
    let tmp = tempfile::tempdir().unwrap();
    let file = make_session(tmp.path()).await;
    let a = spawn(tmp.path(), SessionTarget::Path(file.clone())).await;
    let b = spawn(tmp.path(), SessionTarget::New).await;
    let sw = b
        .switch_session(&file)
        .await
        .expect("switch_session on already-open file");
    eprintln!("C4: 第二进程 switch_session 已打开文件 => success={sw:?} cancelled={}", sw["cancelled"]);
    // 双方都追加
    let ra = a.bash("echo A").await;
    let rb = b.bash("echo B").await;
    eprintln!("C4: 双开下双写 A={:?} B={:?}", ra.is_ok(), rb.is_ok());
    // A 视角能否看到 B 的追加
    let entries = a.get_entries(None).await;
    if let Ok(d) = entries {
        let n = d["entries"].as_array().map(|x| x.len()).unwrap_or(0);
        eprintln!("C4: A 的 get_entries 条目数 = {n}（含 B 的追加?）");
    }
    a.shutdown().await;
    b.shutdown().await;
}

/// C5：get_entries(since) 游标语义（docs/02 §6.4）。
/// 契约事实：
///  1) 游标是"跨客户端重启"的持久语义（文件重读），**不是**跨进程实时可见——
///     并发双开时各进程持有独立内存态，外部 append 不进本进程的 get_entries；
///  2) bash-only 追加不触发落盘，只有 LLM 回合完成才 flush 到文件（见 make_session 注释）；
///  3) 非法 since 返回 success:false。
/// 因此按 Piggy 真实复活场景验证：B 产生新回合 → 新进程 C 打开同文件 → since 增量可见。
#[tokio::test]
async fn c5_cursor_incremental() {
    let tmp = tempfile::tempdir().unwrap();
    let file = make_session(tmp.path()).await;
    let a = spawn(tmp.path(), SessionTarget::Path(file.clone())).await;
    let before = a.get_entries(None).await.unwrap();
    let cursor = before["leafId"].as_str().unwrap().to_string();
    a.shutdown().await;
    // 进程 B：追加一个新回合（触发落盘）
    let b = spawn(tmp.path(), SessionTarget::Path(file.clone())).await;
    b.prompt("Reply with exactly: OK2", None, None).await.expect("append turn");
    for _ in 0..60 {
        if b.state() == WorkerState::Ready { break; }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    b.shutdown().await;
    tokio::time::sleep(Duration::from_millis(500)).await;
    // 新进程 C（模拟崩溃复活后的 worker）：游标增量必须可见
    let c = spawn(tmp.path(), SessionTarget::Path(file.clone())).await;
    let delta = c.get_entries(Some(&cursor)).await;
    match delta {
        Ok(d) => {
            let n = d["entries"].as_array().map(|x| x.len()).unwrap_or(0);
            let leaf = d["leafId"].as_str().unwrap_or("<null>");
            eprintln!("C5: 重启后 since 增量 => {n} 条, 新 leaf={leaf}");
            assert!(n > 0, "C5 FAIL: 重启后增量应 > 0");
        }
        Err(e) => panic!("C5 FAIL: {e}"),
    }
    let bad = c.get_entries(Some("no-such-entry-id")).await;
    eprintln!("C5: 非法 since => {:?}", bad.as_ref().err().unwrap_or(&"success:true?!".to_string()));
    assert!(bad.is_err(), "C5: 非法 since 应 success:false");
    c.shutdown().await;
    cleanup_session(&file);
}

/// C6：--no-session 下 get_state 的 sessionFile/sessionId 形态。
#[tokio::test]
async fn c6_no_session() {
    let tmp = tempfile::tempdir().unwrap();
    let w = spawn(tmp.path(), SessionTarget::NoSession).await;
    let st = w.get_state().await.unwrap();
    eprintln!(
        "C6: sessionFile={:?} sessionId={:?}",
        st.get("sessionFile").map(|v| v.to_string()),
        st["sessionId"].as_str()
    );
    assert!(st.get("sessionFile").map(|v| v.is_null()).unwrap_or(true), "C6: --no-session 下 sessionFile 应为 null/缺失");
    w.shutdown().await;
}

/// C7：>1MB 单事件（bash 巨量输出）下的管道行为。
#[tokio::test]
async fn c7_megabyte_lines() {
    let tmp = tempfile::tempdir().unwrap();
    let sink = Arc::new(CollectorSink::default());
    let w = spawn_worker(
        "c7",
        SpawnArgs {
            cwd: tmp.path().to_path_buf(),
            pi_bin: pi_bin(),
            session: SessionTarget::NoSession,
            name: None,
            // 契约测试只验证 RPC 协议，不依赖守卫资源 → 用完全权限档
            permission: PermissionMode::Full,
            guard_script: None,
        },
        sink.clone(),
    )
    .await
    .unwrap();
    let out = w
        .bash("python3 -c \"print('x'*1_500_000)\"")
        .await
        .expect("bash");
    let truncated = out["truncated"].as_bool().unwrap_or(false);
    eprintln!(
        "C7: 1.5MB bash 输出 => truncated={truncated}, fullOutputPath={:?}",
        out["fullOutputPath"].as_str()
    );
    let update_count = sink
        .events
        .lock()
        .unwrap()
        .iter()
        .filter(|(ch, v)| ch.starts_with("pi:commit:") && v["type"] == "bash_execution_update")
        .count();
    eprintln!("C7: bash_execution_update 事件数 = {update_count}（流式分片正常）");
    assert!(update_count > 0);
    w.shutdown().await;
}

/// C8：export_html 无 outputPath 的默认路径规则。
#[tokio::test]
async fn c8_export_html_default() {
    let tmp = tempfile::tempdir().unwrap();
    let file = make_session(tmp.path()).await;
    let w = spawn(tmp.path(), SessionTarget::Path(file.clone())).await;
    match w.export_html(None).await {
        Ok(d) => eprintln!("C8: 默认导出路径 = {:?}", d["path"].as_str()),
        Err(e) => eprintln!("C8: export_html(无路径) 失败 => {e}"),
    }
    w.shutdown().await;
    cleanup_session(&file);
}

/// C9：prompt.images 的接受度（随后 abort，最小消耗）。
#[tokio::test]
async fn c9_prompt_images() {
    let tmp = tempfile::tempdir().unwrap();
    let w = spawn(tmp.path(), SessionTarget::NoSession).await;
    // 1x1 PNG
    let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    let r = w
        .prompt(
            "What color is this 1x1 image? One word.",
            Some(vec![json!({"type":"image","data":png,"mimeType":"image/png"})]),
            None,
        )
        .await;
    match r {
        Ok(_) => {
            eprintln!("C9: prompt.images 受理成功（随后 abort 终止，最小消耗）");
            let _ = w.abort().await;
        }
        Err(e) => eprintln!("C9: prompt.images 被拒绝: {e}"),
    }
    w.shutdown().await;
}

/// C10：idle 状态下 abort 的响应语义。
#[tokio::test]
async fn c10_abort_idle() {
    let tmp = tempfile::tempdir().unwrap();
    let w = spawn(tmp.path(), SessionTarget::NoSession).await;
    let r = w.abort().await;
    eprintln!("C10: idle abort => {:?}", r.as_ref().map(|d| d.to_string()));
    assert!(r.is_ok(), "C10 FAIL: idle abort 应 success");
    w.shutdown().await;
}

/// DoD #2（E2E 无 GUI）：prompt → 合帧 → message_end → agent_settled。
/// 依赖已配置的 provider（本机默认 glm-5.3-flash，零成本）。
#[tokio::test]
async fn e2e_streaming_pipeline() {
    let tmp = tempfile::tempdir().unwrap();
    let sink = Arc::new(CollectorSink::default());
    let w = spawn_worker(
        "e2e",
        SpawnArgs {
            cwd: tmp.path().to_path_buf(),
            pi_bin: pi_bin(),
            session: SessionTarget::NoSession,
            name: None,
            // 契约测试只验证 RPC 协议，不依赖守卫资源 → 用完全权限档
            permission: PermissionMode::Full,
            guard_script: None,
        },
        sink.clone(),
    )
    .await
    .unwrap();
    w.prompt("Reply with exactly: OK", None, None).await.expect("prompt accepted");
    // 等 settled（状态机轮询）
    for _ in 0..120 {
        tokio::time::sleep(Duration::from_millis(500)).await;
        if w.state() == WorkerState::Ready {
            break;
        }
    }
    w.abort().await.ok();
    let events = sink.events.lock().unwrap();
    let frames: Vec<&Value> = events
        .iter()
        .filter(|(ch, _)| ch.starts_with("pi:frame:"))
        .map(|(_, v)| v)
        .collect();
    let commits: Vec<&Value> = events
        .iter()
        .filter(|(ch, _)| ch.starts_with("pi:commit:"))
        .map(|(_, v)| v)
        .collect();
    let has_text_delta = frames.iter().any(|f| !f["text"].as_array().unwrap_or(&vec![]).is_empty());
    let has_message_end = commits.iter().any(|v| v["type"] == "message_end");
    let has_settled = commits.iter().any(|v| v["type"] == "agent_settled");
    eprintln!(
        "E2E: frames={} commits={} text_delta={} message_end={} settled={}",
        frames.len(), commits.len(), has_text_delta, has_message_end, has_settled
    );
    assert!(has_text_delta, "E2E FAIL: 无 text_delta 帧");
    assert!(has_message_end, "E2E FAIL: 无 message_end");
    assert!(has_settled, "E2E FAIL: 未观察到 agent_settled");
    drop(events);
    w.shutdown().await;
}

/// DoD #5：崩溃注入 → Crashed 状态 → 重新 spawn + switch_session + 游标补齐。
#[tokio::test]
async fn e2e_crash_recovery() {
    let tmp = tempfile::tempdir().unwrap();
    let file = make_session(tmp.path()).await;
    let sink = Arc::new(CollectorSink::default());
    let w = spawn_worker(
        "crash",
        SpawnArgs {
            cwd: tmp.path().to_path_buf(),
            pi_bin: pi_bin(),
            session: SessionTarget::Path(file.clone()),
            name: None,
            // 契约测试只验证 RPC 协议，不依赖守卫资源 → 用完全权限档
            permission: PermissionMode::Full,
            guard_script: None,
        },
        sink.clone(),
    )
    .await
    .unwrap();
    let before = w.get_entries(None).await.unwrap();
    let cursor = before["leafId"].as_str().unwrap().to_string();
    // 注入崩溃：kill 子进程（模拟 worker 意外死亡）
    {
        let mut child = w.child.lock().await.take().unwrap();
        let _ = child.kill().await;
    }
    // reader 应观察到 EOF → Crashed
    for _ in 0..40 {
        tokio::time::sleep(Duration::from_millis(250)).await;
        if w.state() == WorkerState::Crashed {
            break;
        }
    }
    assert_eq!(w.state(), WorkerState::Crashed, "kill 后应 Crashed");
    // 复活路径（模拟 registry.revive）：重新 spawn + switch_session + 游标
    let w2 = spawn(tmp.path(), SessionTarget::New).await;
    w2.switch_session(&file).await.expect("switch after crash");
    let delta = w2.get_entries(Some(&cursor)).await.expect("cursor resync");
    let n = delta["entries"].as_array().map(|x| x.len()).unwrap_or(0);
    eprintln!("CRASH-RECOVERY: Crashed 检出 ✓, 复活后游标增量 = {n} 条");
    assert_eq!(n, 0, "崩溃后无新增（游标即崩溃前 leaf）");
    w2.shutdown().await;
    cleanup_session(&file);
}
