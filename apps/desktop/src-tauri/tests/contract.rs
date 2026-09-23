//! pi RPC 契约测试（docs/02 §9 C1–C10）——M0 DoD 第 1 条。
//!
//! 运行：`pnpm test:contract`（需要 PATH 上有真实 pi；C9 会消耗极少量 token）。
//! 每个测试把结论写入 stderr，验收后回填 docs/02 §9。

use piggy_lib::events::{CollectorSink, NullSink};
use piggy_lib::pi::client::{Worker, WorkerState};
use piggy_lib::pi::discovery::{discover, PiSource};
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
    // discover(source, custom, builtin)：契约测试走默认来源（系统 pi），不捆绑 standalone
    discover(PiSource::default(), None, None).expect("pi not found").path
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
            bridge_script: None,
            envs: Vec::new(),
            // C12–C14 测的是子代理数据面本身，不涉及委派开关
            subagent_policy: None,
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
            bridge_script: None,
            envs: Vec::new(),
            // C12–C14 测的是子代理数据面本身，不涉及委派开关
            subagent_policy: None,
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
            bridge_script: None,
            envs: Vec::new(),
            // C12–C14 测的是子代理数据面本身，不涉及委派开关
            subagent_policy: None,
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
            bridge_script: None,
            envs: Vec::new(),
            // C12–C14 测的是子代理数据面本身，不涉及委派开关
            subagent_policy: None,
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
            bridge_script: None,
            envs: Vec::new(),
            // C12–C14 测的是子代理数据面本身，不涉及委派开关
            subagent_policy: None,
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

/* ================= M3：子代理双层（docs/06） ================= */

/// 桥接扩展产物路径。源码在 packages/piggy-bridge，产物由 `pnpm build:bridge` 生成到 resources。
fn bridge_script() -> PathBuf {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/piggy-bridge.js");
    assert!(
        p.is_file(),
        "缺少桥接扩展产物（先跑 pnpm build:bridge）: {}",
        p.display()
    );
    p
}

/// 从事件流里取出 bridge → GUI 的数据面载荷（`PIGGY:1:` + JSON）。
fn bridge_payloads(sink: &CollectorSink) -> Vec<Value> {
    sink.events
        .lock()
        .unwrap()
        .iter()
        .filter(|(ch, _)| ch.starts_with("pi:ui-req:"))
        .filter(|(_, v)| v["method"] == "set_editor_text")
        .filter_map(|(_, v)| v["text"].as_str().map(str::to_string))
        .filter_map(|t| t.strip_prefix("PIGGY:1:").and_then(|j| serde_json::from_str::<Value>(j).ok()))
        .collect()
}

/// 事件流里是否出现过某个扩展 UI 方法（notify/setWidget 等 fire-and-forget 面）。
fn saw_ui_method(sink: &CollectorSink, method: &str) -> bool {
    sink.events
        .lock()
        .unwrap()
        .iter()
        .any(|(ch, v)| ch.starts_with("pi:ui-req:") && v["method"] == method)
}

/// 等 `PIGGY:1:` 载荷出现（扩展命令是异步的：prompt 的 response 先回，载荷随后到）。
async fn wait_payloads(sink: &CollectorSink, n: usize, tries: usize) -> Vec<Value> {
    for _ in 0..tries {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let got = bridge_payloads(sink);
        if got.len() >= n {
            return got;
        }
    }
    bridge_payloads(sink)
}

/// C12：piggy-bridge 被真实 pi 加载，`/piggy:status` 经 RPC 数据面回传载荷。
///
/// 这一条锁的是**桥接本身可用**：注册形状（`registerCommand(name, {handler})`）、
/// UI 通道（`ctx.ui.setEditorText`）、RPC v1 协商（`subagents:rpc:v1:*`）三者缺一不可。
/// 2026-09-23 的旧实现写成 `registerCommand(name, fn)`，加载后每次调用都报
/// `command.handler is not a function`，而 prompt 仍然 success —— 所以必须用真实回执来验。
///
/// 装了 pi-subagents 走 `ok:true` 分支，没装走 `ok:false` 分支，两者都算通过：
/// 被测的是通道，不是本机装了哪些包。
#[tokio::test]
async fn c12_bridge_status_payload_over_rpc() {
    let tmp = tempfile::tempdir().unwrap();
    let sink = Arc::new(CollectorSink::default());
    let w = spawn_worker(
        "bridge",
        SpawnArgs {
            cwd: tmp.path().to_path_buf(),
            pi_bin: pi_bin(),
            session: SessionTarget::NoSession,
            name: None,
            permission: PermissionMode::Full,
            guard_script: None,
            bridge_script: Some(bridge_script()),
            envs: Vec::new(),
            // C12–C14 测的是子代理数据面本身，不涉及委派开关
            subagent_policy: None,
        },
        sink.clone(),
    )
    .await
    .unwrap();

    w.prompt("/piggy:status", None, None).await.expect("prompt accepted");
    let payloads = wait_payloads(&sink, 1, 40).await;
    assert!(!payloads.is_empty(), "C12 FAIL: 没有收到 PIGGY:1 载荷（扩展命令未执行？）");
    let payload = &payloads[0];
    assert_eq!(payload["kind"], "status", "C12 FAIL: 载荷 kind 不对: {payload}");
    assert!(saw_ui_method(&sink, "setWidget"), "C12 FAIL: 未见到舰队状态行（setWidget）");
    assert!(saw_ui_method(&sink, "notify"), "C12 FAIL: 未见到人读摘要（notify）");

    if payload["ok"] == true {
        let status = &payload["status"];
        assert!(
            status["fleet"].is_object() || status["asyncSnapshot"].is_object(),
            "C12 FAIL: ok:true 但没有任何舰队数据: {status}"
        );
        let active = status["fleet"]["totalActive"].as_u64().unwrap_or(0);
        eprintln!("C12: pi-subagents 在线 → ok:true, totalActive={active}, lanes={}", payload["lanes"]);
    } else {
        let err = payload["error"].as_str().unwrap_or("");
        assert!(err.contains("未安装"), "C12 FAIL: 降级理由不含「未安装」: {err}");
        eprintln!("C12: 本机未装 pi-subagents → 降级载荷正确: {err}");
    }
    w.shutdown().await;
}

/// C13：清空配置目录（无 pi-subagents）时桥接必须**明确降级**，而不是静默无声。
///
/// 这同时验证一条容易搞错的前提：pi 在 RPC 模式下、没有任何凭据时也能启动并执行扩展命令
/// ——扩展命令不走模型，所以这条测试零 token 消耗。
#[tokio::test]
async fn c13_bridge_degrades_without_pi_subagents() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = tempfile::tempdir().unwrap(); // 空目录 = 没有 packages/settings/auth
    let sink = Arc::new(CollectorSink::default());
    let w = spawn_worker(
        "bridge-degraded",
        SpawnArgs {
            cwd: tmp.path().to_path_buf(),
            pi_bin: pi_bin(),
            session: SessionTarget::NoSession,
            name: None,
            permission: PermissionMode::Full,
            guard_script: None,
            bridge_script: Some(bridge_script()),
            envs: vec![(
                "PI_CODING_AGENT_DIR".to_string(),
                cfg.path().to_string_lossy().into_owned(),
            )],
            subagent_policy: None,
        },
        sink.clone(),
    )
    .await
    .unwrap();

    w.prompt("/piggy:status", None, None).await.expect("prompt accepted");
    let payloads = wait_payloads(&sink, 1, 30).await;
    assert!(!payloads.is_empty(), "C13 FAIL: 空配置下没有降级载荷");
    let payload = &payloads[0];
    assert_eq!(payload["kind"], "status");
    assert_eq!(payload["ok"], false, "C13 FAIL: 没装 pi-subagents 却报成功: {payload}");
    assert!(
        payload["error"].as_str().unwrap_or("").contains("未安装"),
        "C13 FAIL: 降级理由不对: {payload}"
    );
    eprintln!("C13: 空配置目录 → 降级载荷 ✓ ({})", payload["error"]);
    w.shutdown().await;
}

/* ---------------- A 层：宿主 Fleet 编排（真实 pi） ---------------- */

/// 按 `commands::schedule_run` + `watch_lane` 的方式跑一条 lane，返回收集到的结果文本。
///
/// 用的是**同一份判定逻辑**（`fleet::lane_step`）与**同一个结果提取函数**
/// （`fleet::last_assistant_text`），所以这条测试不仅验证"pi 能跑"，也验证调度器
/// 赖以成立的两个前提：Busy→Ready 确实是"这一轮结束"，且 `get_messages` 能取到文本。
async fn run_lane(
    mgr: &piggy_lib::fleet::FleetManager,
    run_id: &str,
    lane_key: &str,
    cwd: &Path,
) -> String {
    let run = mgr.get(run_id).expect("run 存在");
    let lane = run.lane(lane_key).expect("lane 存在").clone();
    let prompt = piggy_lib::fleet::render_prompt(&lane.prompt, &run.task, &run, &lane);
    assert!(
        !prompt.contains("{upstream}") && !prompt.contains("{task}"),
        "占位符必须全部被替换: {prompt}"
    );
    let tab_id = format!("lane-{lane_key}");
    // 对应 commands::start_ready_lanes 的 bind_tab：settle_lane 靠 tab_id 反查 lane
    assert!(mgr.bind_tab(run_id, lane_key, &tab_id), "bind_tab 失败");
    let w = spawn_worker(
        &tab_id,
        SpawnArgs {
            cwd: cwd.to_path_buf(),
            pi_bin: pi_bin(),
            session: SessionTarget::NoSession,
            name: Some(format!("fleet:test/{lane_key}")),
            permission: PermissionMode::Full,
            guard_script: None,
            bridge_script: None,
            envs: Vec::new(),
            // C12–C14 测的是子代理数据面本身，不涉及委派开关
            subagent_policy: None,
        },
        Arc::new(NullSink),
    )
    .await
    .expect("lane spawn");

    let mut rx = w.subscribe_state();
    w.prompt(&prompt, None, None).await.expect("lane prompt accepted");
    let mut was_busy = false;
    let mut saw_busy = false;
    let mut settled = false;
    for _ in 0..240 {
        // 最多 2 分钟
        if rx.changed().await.is_err() {
            break;
        }
        let (busy, outcome) = piggy_lib::fleet::lane_step(was_busy, *rx.borrow());
        was_busy = busy;
        saw_busy |= busy;
        match outcome {
            Some(piggy_lib::fleet::LaneOutcome::Settled) => {
                settled = true;
                break;
            }
            Some(piggy_lib::fleet::LaneOutcome::Failed) => panic!("lane {lane_key} 失败（Crashed/Stopped）"),
            None => {}
        }
    }
    assert!(settled, "lane {lane_key} 未在超时内 settle");
    assert!(saw_busy, "lane {lane_key} 从未进入 Busy —— 那就不是真跑过，而是被误判完成");
    let messages = w.get_messages().await.expect("get_messages");
    let text = piggy_lib::fleet::last_assistant_text(&messages).unwrap_or_default();
    mgr.settle_lane(&tab_id, &text);
    w.shutdown().await;
    text
}

/// C14：两 lane DAG 用真实 pi 跑通 —— 就绪判定、settle 判定、结果收集、`{upstream}` 注入。
///
/// 消耗：两次极小 prompt（本机默认 glm-5.3-flash）。
#[tokio::test]
async fn c14_fleet_lane_dag_with_real_pi() {
    let tmp = tempfile::tempdir().unwrap();
    let template = json!({
        "lanes": [
            {
                "key": "a", "role": "侦察", "depends_on": [],
                "prompt": "Reply with exactly: ALPHA"
            },
            {
                "key": "b", "role": "汇总", "depends_on": ["a"],
                "prompt": "上一步的输出是：\n{upstream}\n若其中含 ALPHA 就回复 BRAVO-OK，否则回复 MISSING"
            }
        ]
    });
    let mgr = piggy_lib::fleet::FleetManager::new();
    let run = piggy_lib::fleet::build_run("c13".into(), "t", &template, "契约测试任务", tmp.path().to_path_buf())
        .expect("build_run");
    assert_eq!(run.ready_lanes(), vec!["a"], "初始只应有 a 就绪（b 依赖 a）");
    mgr.insert(run);

    let text_a = run_lane(&mgr, "c13", "a", tmp.path()).await;
    assert!(!text_a.trim().is_empty(), "C14 FAIL: lane a 结果为空");
    assert!(
        text_a.to_uppercase().contains("ALPHA"),
        "C14 FAIL: lane a 没按指令回复: {text_a:?}"
    );

    // a settle 后 b 才就绪（DAG 顺序由 Rust 侧决定，不靠模型）
    let run = mgr.get("c13").unwrap();
    assert_eq!(run.ready_lanes(), vec!["b"], "a 完成后 b 才应就绪");
    let b_prompt = piggy_lib::fleet::render_prompt(
        "上一步的输出是：\n{upstream}\n若其中含 ALPHA 就回复 BRAVO-OK，否则回复 MISSING",
        &run.task,
        &run,
        run.lane("b").unwrap(),
    );
    assert!(
        b_prompt.contains(text_a.trim()),
        "C14 FAIL: 下游 prompt 没带上游真实结果\n上游={text_a:?}\nprompt={b_prompt:?}"
    );

    let text_b = run_lane(&mgr, "c13", "b", tmp.path()).await;
    assert!(
        text_b.to_uppercase().contains("BRAVO"),
        "C14 FAIL: 汇总 lane 没看到上游内容: {text_b:?}"
    );
    assert!(mgr.maybe_finish("c13"), "全部 lane 终态后 run 应转 Done");
    assert_eq!(
        mgr.get("c13").unwrap().status,
        piggy_lib::fleet::RunStatus::Done,
        "C14 FAIL: run 未结束"
    );
    let snap = mgr.snapshot();
    eprintln!(
        "C14: DAG 跑通 ✓ a={:?} → b={:?}；快照 lanes={}",
        text_a.trim(),
        text_b.trim(),
        snap["runs"][0]["lanes"]
    );
}
