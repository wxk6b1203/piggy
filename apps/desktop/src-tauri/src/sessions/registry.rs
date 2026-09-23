//! 标签页注册表（docs/03 §2.7）：tab ↔ worker ↔ 会话文件三方绑定、
//! 会话文件互斥、崩溃自动复活（switch_session + get_entries 游标补齐）。

use crate::events::EventSink;
use crate::pi::client::{Worker, WorkerState};
use crate::pi::discovery::{PiBinary, PiSource};
use crate::pi::permission::PermissionMode;
use crate::pi::process::{spawn_worker, SessionTarget, SpawnArgs};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

pub struct Tab {
    pub tab_id: String,
    pub cwd: PathBuf,
    pub session_file: Option<String>,
    pub session_id: Option<String>,
    pub session_name: Option<String>,
    pub last_cursor: Option<String>,
    pub worker: Option<Worker>,
    pub restarts: u32,
    pub deliberate: bool,
    /// 本标签页的权限档位。`--tools`/`-e` 是 CLI 参数，改档必须重启 worker；
    /// 该字段随 `revive_tab` 一起传给新进程，保证重启后档位不丢。
    pub permission: PermissionMode,
    /// 最近一次被使用的时间（任意 IPC 命令经 worker_of 触碰；05 §4.1 空闲回收依据）
    pub last_activity: Instant,
}

impl Tab {
    fn worker_state(&self) -> WorkerState {
        self.worker.as_ref().map(|w| w.state()).unwrap_or(WorkerState::Crashed)
    }
}

pub struct Registry {
    pub pi_bin: Option<PiBinary>,
    /// 内置 pi standalone（08 §7.1 full SKU）；setup 时由 resource_dir 填充
    pub builtin: Option<PathBuf>,
    /// pi 来源与自定义路径（设置项；默认 system，见 pi/discovery.rs）
    pub pi_source: PiSource,
    pub pi_custom_path: Option<PathBuf>,
    /// 权限守卫扩展脚本（pi/permission.rs::guard_script_path）；setup 时填充
    pub guard_script: Option<PathBuf>,
    /// 新建标签页的默认档位（持久化在 ~/.piggy/config.json）
    pub default_permission: PermissionMode,
    /// tab_id → Tab（docs/03 §2.7）
    pub tabs: HashMap<String, Tab>,
    /// 会话文件（规范化路径）→ 占用它的 tab_id（docs/02 §6.3 互斥）
    open_files: HashMap<String, String>,
}

pub type SharedRegistry = Arc<Mutex<Registry>>;

#[derive(serde::Serialize)]
pub struct TabSnapshot {
    pub tab_id: String,
    pub cwd: String,
    pub session_id: Option<String>,
    pub session_file: Option<String>,
    pub session_name: Option<String>,
    pub worker_state: WorkerState,
    pub permission: PermissionMode,
    pub state: Value,
}

impl Registry {
    pub fn new(pi_bin: Option<PiBinary>) -> Self {
        Self {
            pi_bin,
            builtin: None,
            pi_source: PiSource::default(),
            pi_custom_path: None,
            guard_script: None,
            default_permission: PermissionMode::default(),
            tabs: HashMap::new(),
            open_files: HashMap::new(),
        }
    }

    /// 校验缓存的 pi 路径；失效则按来源重新定位（升级自愈）。
    pub fn resolve_bin(&mut self) -> Result<PathBuf, String> {
        if let Some(b) = &self.pi_bin {
            if b.path.exists() {
                return Ok(b.path.clone());
            }
        }
        let b = crate::pi::discovery::discover(
            self.pi_source,
            self.pi_custom_path.as_deref(),
            self.builtin.as_deref(),
        )
        .map_err(|e| e.to_string())?;
        self.pi_bin = Some(b.clone());
        Ok(b.path)
    }

    /// 创建 tab：spawn worker → get_state 握手 → 绑定会话文件 → 初始化游标。
    pub async fn create_tab(
        &mut self,
        sink: &Arc<dyn EventSink>,
        cwd: PathBuf,
        session: SessionTarget,
        name: Option<String>,
        permission: PermissionMode,
    ) -> Result<TabSnapshot, String> {
        let tab_id = uuid::Uuid::new_v4().to_string();
        let worker = self
            .spawn_with_rediscovery(
                &tab_id,
                cwd.clone(),
                session.clone(),
                name.clone(),
                permission,
                sink.clone(),
            )
            .await?;
        let state = worker.get_state().await?;
        let session_file = state["sessionFile"].as_str().map(String::from);
        let session_id = state["sessionId"].as_str().map(String::from);
        // 互斥检查（docs/02 §6.3）
        if let Some(sf) = &session_file {
            let key = normalize_path(sf);
            if let Some(owner) = self.open_files.get(&key) {
                let _ = worker.shutdown().await;
                return Err(format!("会话文件已被标签页 {owner} 打开: {sf}"));
            }
            self.open_files.insert(key, tab_id.clone());
        }
        // 游标初始化：当前 leaf 即为"已见"边界
        let last_cursor = worker
            .get_entries(None)
            .await
            .ok()
            .and_then(|d| d["leafId"].as_str().map(String::from));
        let tab = Tab {
            tab_id: tab_id.clone(),
            cwd,
            session_file,
            session_id,
            session_name: name,
            last_cursor,
            worker: Some(worker.clone()),
            restarts: 0,
            deliberate: false,
            permission,
            last_activity: Instant::now(),
        };
        worker.set_state(WorkerState::Ready);
        let snapshot = snapshot_of(&tab, &state);
        self.tabs.insert(tab_id.clone(), tab);
        sink.emit_json("tabs:changed", json!({"tabIds": self.tab_ids()}));
        Ok(snapshot)
    }

    /// spawn + ENOENT 自愈：二进制缺失时重新发现一次再试（pi 升级窗口，02 §2.1）。
    pub async fn spawn_with_rediscovery(
        &mut self,
        tab_id: &str,
        cwd: PathBuf,
        session: SessionTarget,
        name: Option<String>,
        permission: PermissionMode,
        sink: Arc<dyn EventSink>,
    ) -> Result<Worker, String> {
        let guard = self.guard_script.clone();
        let build = |pi_bin: PathBuf| SpawnArgs {
            cwd: cwd.clone(),
            pi_bin,
            session: session.clone(),
            name: name.clone(),
            permission,
            guard_script: guard.clone(),
        };
        let args = build(self.resolve_bin()?);
        match spawn_worker(tab_id, args.clone(), sink.clone()).await {
            Ok(w) => Ok(w),
            Err(e) if e.starts_with("PI_BINARY_MISSING") => {
                // pi 升级/移动窗口：重走发现链再试一次（docs/02 §2.1）
                self.pi_bin = None;
                let args = build(self.resolve_bin()?);
                spawn_worker(tab_id, args, sink).await
            }
            // SESSION_CWD_MISSING（项目目录已删）/ GUARD_SCRIPT_MISSING 等：不重试，直接透传
            Err(e) => Err(e),
        }
    }

    /// 切换标签页权限档位（`--tools`/`-e` 是 CLI 参数 → 必须重启 worker）。
    ///
    /// 流程：改档 → 停旧进程（deliberate，watcher 不介入）→ 立刻按新档复活。
    /// 复用 `revive_tab`，因此会话文件、游标补齐、resync 都与崩溃复活同一条路径。
    /// 拒绝在流式中切换：那会打断进行中的回合，且用户看不到"后半段用了另一个档位"。
    pub async fn set_permission(
        &mut self,
        sink: &Arc<dyn EventSink>,
        tab_id: &str,
        mode: PermissionMode,
    ) -> Result<Value, String> {
        let (worker, session_file) = {
            let Some(tab) = self.tabs.get_mut(tab_id) else {
                return Err(format!("tab 不存在: {tab_id}"));
            };
            let state = tab.worker.as_ref().map(|w| w.state());
            if matches!(state, Some(WorkerState::Busy)) {
                return Err("会话正在运行，请先中断（Esc）再切换权限档位".to_string());
            }
            tab.permission = mode;
            tab.restarts = 0; // 换档不是崩溃，不占崩溃重启预算
            (tab.worker.take(), tab.session_file.clone())
        };
        // 主动停旧进程；deliberate 期间 watcher 不会把它当崩溃复活
        if let Some(w) = worker {
            let _ = w.shutdown().await;
        }
        // 立刻按新档复活，让界面状态与真实进程一致（而不是"待下次发送才生效"）
        let revived = revive_tab(self, sink, tab_id).await;
        let worker_state = self
            .tabs
            .get(tab_id)
            .map(|t| t.worker_state())
            .unwrap_or(WorkerState::Crashed);
        match revived {
            Ok(_) => Ok(json!({
                "tabId": tab_id,
                "permission": mode,
                "workerState": worker_state,
                "sessionFile": session_file,
                "tools": mode.tool_allowlist(),
                "pathGuard": mode.needs_path_guard(),
            })),
            Err(e) => Err(format!("已切换到「{}」，但 worker 重启失败：{e}", mode.label())),
        }
    }

    pub fn tab_ids(&self) -> Vec<String> {
        self.tabs.keys().cloned().collect()
    }

    /// 存活（有 worker 且非 Stopped）的 worker 数（05 §4.2 上限依据）
    pub fn alive_worker_count(&self) -> usize {
        self.tabs
            .values()
            .filter(|t| matches!(t.worker_state(), WorkerState::Ready | WorkerState::Busy | WorkerState::Spawning))
            .count()
    }

    /// 触碰活跃时间（05 §4.1 空闲判定基准）
    pub fn touch(&mut self, tab_id: &str) {
        if let Some(t) = self.tabs.get_mut(tab_id) {
            t.last_activity = Instant::now();
        }
    }

    /// 休眠标签（05 §4.3）：主动回收 worker，保留 tab/游标/会话指针。
    /// 再交互时 ensure_worker 自动复活 + 游标补齐。
    pub async fn sleep_tab(&mut self, sink: &Arc<dyn EventSink>, tab_id: &str) -> Result<(), String> {
        let Some(tab) = self.tabs.get_mut(tab_id) else {
            return Err(format!("tab 不存在: {tab_id}"));
        };
        tab.deliberate = true; // watcher 不得复活
        tab.restarts = 0; // 休眠/唤醒非崩溃，不计入重启上限
        if let Some(w) = tab.worker.take() {
            w.shutdown().await;
        }
        sink.emit_json(
            &format!("pi:state:{tab_id}"),
            json!({"state": "sleeping", "reason": "sleep"}),
        );
        Ok(())
    }

    /// 空闲回收（05 §4.1）：Ready 且空闲超过 timeout 的 worker 优雅退出。
    /// 返回被回收的 tab 列表。timeout_secs = 0 时由调用方不调度本函数。
    pub async fn reap_idle(&mut self, timeout_secs: u64) -> Vec<String> {
        let mut reaped = Vec::new();
        let ids: Vec<String> = self
            .tabs
            .iter()
            .filter(|(_, t)| {
                matches!(t.worker_state(), WorkerState::Ready)
                    && t.last_activity.elapsed().as_secs() >= timeout_secs
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            if self.sleep_tab_inner(&id).await {
                reaped.push(id);
            }
        }
        reaped
    }

    /// 回收最闲 worker（05 §4.2 超限时的"一键回收"目标）：Ready 且最久未用。
    pub async fn sleep_idlest(&mut self, sink: &Arc<dyn EventSink>) -> Option<String> {
        let candidate = self
            .tabs
            .iter()
            .filter(|(_, t)| matches!(t.worker_state(), WorkerState::Ready))
            .min_by_key(|(_, t)| t.last_activity)
            .map(|(id, _)| id.clone())?;
        self.sleep_tab(sink, &candidate).await.ok()?;
        Some(candidate)
    }

    /// 内部回收（不发 sleeping 事件版，供 reap 使用）
    async fn sleep_tab_inner(&mut self, tab_id: &str) -> bool {
        let Some(tab) = self.tabs.get_mut(tab_id) else { return false };
        tab.deliberate = true;
        tab.restarts = 0;
        if let Some(w) = tab.worker.take() {
            w.shutdown().await;
            return true;
        }
        false
    }

    pub async fn close_tab(&mut self, sink: &Arc<dyn EventSink>, tab_id: &str) -> Result<(), String> {
        let Some(mut tab) = self.tabs.remove(tab_id) else {
            return Ok(());
        };
        tab.deliberate = true;
        if let Some(sf) = &tab.session_file {
            self.open_files.remove(&normalize_path(sf));
        }
        if let Some(w) = tab.worker.take() {
            w.shutdown().await;
        }
        sink.emit_json("tabs:changed", json!({"tabIds": self.tab_ids()}));
        Ok(())
    }

    /// 确保该 tab 有可用 worker；Crashed/None 则复活（复活含游标补齐）。
    pub async fn ensure_worker(
        &mut self,
        sink: &Arc<dyn EventSink>,
        tab_id: &str,
    ) -> Result<Worker, String> {
        let needs_revive = match self.tabs.get(tab_id) {
            None => return Err(format!("tab 不存在: {tab_id}")),
            Some(tab) => match &tab.worker {
                Some(w) => !matches!(w.state(), WorkerState::Ready | WorkerState::Busy | WorkerState::Spawning),
                None => true,
            },
        };
        if !needs_revive {
            let w = self.tabs.get(tab_id).and_then(|t| t.worker.clone()).unwrap();
            return Ok(w);
        }
        revive_tab(self, sink, tab_id).await
    }

    pub async fn update_cursor(&mut self, tab_id: &str, cursor: Option<String>) {
        if let Some(tab) = self.tabs.get_mut(tab_id) {
            tab.last_cursor = cursor.or(tab.last_cursor.take());
        }
    }

    pub fn snapshot(&self, tab_id: &str) -> Option<TabSnapshot> {
        self.tabs.get(tab_id).map(|t| snapshot_of(t, &Value::Null))
    }
}

fn snapshot_of(tab: &Tab, state: &Value) -> TabSnapshot {
    TabSnapshot {
        tab_id: tab.tab_id.clone(),
        cwd: tab.cwd.to_string_lossy().into_owned(),
        session_id: tab.session_id.clone(),
        session_file: tab.session_file.clone(),
        session_name: tab.session_name.clone(),
        worker_state: tab.worker_state(),
        permission: tab.permission,
        state: state.clone(),
    }
}

/// 崩溃复活（docs/02 §7.5、01 §2.3）：spawn → 握手 → （必要时）switch_session
/// → get_entries(since=cursor) 游标补齐 → 发 resync 事件。
/// 重启一律沿用 `tab.permission`——换档与崩溃恢复共用这条路径。
async fn revive_tab(reg: &mut Registry, sink: &Arc<dyn EventSink>, tab_id: &str) -> Result<Worker, String> {
    let (cwd, expected_file, cursor, restarts, permission) = {
        let Some(tab) = reg.tabs.get_mut(tab_id) else {
            return Err(format!("tab 不存在: {tab_id}"));
        };
        tab.restarts += 1;
        (
            tab.cwd.clone(),
            tab.session_file.clone(),
            tab.last_cursor.clone(),
            tab.restarts,
            tab.permission,
        )
    };
    if restarts > 3 {
        return Err(format!("tab {tab_id} 重启次数超限（>3），请手动重试"));
    }
    // 指数退避由调用方（watcher）负责；此处立即尝试
    let target = expected_file
        .clone()
        .map(SessionTarget::Path)
        .unwrap_or(SessionTarget::New);
    let worker = reg
        .spawn_with_rediscovery(tab_id, cwd.clone(), target, None, permission, sink.clone())
        .await?;
    let mut state = worker.get_state().await?;
    // C1 兜底：若 --session 未生效，显式 switch_session
    let actual = state["sessionFile"].as_str().map(String::from);
    if let Some(expected) = &expected_file {
        if actual.as_deref() != Some(expected.as_str()) {
            let _ = worker.switch_session(expected).await?;
            state = worker.get_state().await?;
        }
    }
    // 游标补齐（C5 语义）：since 有效 → 增量；失效 → 全量
    let entries_result = match &cursor {
        Some(c) => worker.get_entries(Some(c.as_str())).await,
        None => worker.get_entries(None).await,
    };
    let data = match entries_result {
        Ok(d) => d,
        Err(_) => worker.get_entries(None).await?,
    };
    let leaf_id = data["leafId"].as_str().map(String::from);
    sink.emit_json(
        &format!("pi:commit:{tab_id}"),
        json!({
            "type": "piggy:resync",
            "entries": data["entries"].clone(),
            "leafId": leaf_id,
        }),
    );
    worker.set_state(WorkerState::Ready);
    if let Some(tab) = reg.tabs.get_mut(tab_id) {
        tab.session_file = state["sessionFile"].as_str().map(String::from);
        tab.session_id = state["sessionId"].as_str().map(String::from);
        tab.last_cursor = leaf_id;
        tab.worker = Some(worker.clone());
        if tab.deliberate {
            tab.deliberate = false;
        }
    }
    sink.emit_json(
        &format!("pi:state:{tab_id}"),
        json!({"state": WorkerState::Ready, "revived": true, "attempt": restarts}),
    );
    Ok(worker)
}

/// 崩溃 watcher（docs/01 §2.3）：状态变 Crashed 且非主动关闭 → 退避后自动复活（≤3 次）。
pub fn spawn_tab_watcher(shared: SharedRegistry, sink: Arc<dyn EventSink>, tab_id: String) {
    tokio::spawn(async move {
        let mut rx = {
            let reg = shared.lock().await;
            let Some(tab) = reg.tabs.get(&tab_id) else { return };
            let Some(w) = &tab.worker else { return };
            w.subscribe_state()
        };
        loop {
            if rx.changed().await.is_err() {
                return;
            }
            let s = *rx.borrow();
            if s == WorkerState::Crashed {
                let deliberate = {
                    let reg = shared.lock().await;
                    reg.tabs.get(&tab_id).map(|t| t.deliberate).unwrap_or(true)
                };
                if deliberate {
                    return;
                }
                let attempt = {
                    let reg = shared.lock().await;
                    reg.tabs.get(&tab_id).map(|t| t.restarts).unwrap_or(0)
                };
                if attempt >= 3 {
                    sink.emit_json(
                        &format!("pi:state:{tab_id}"),
                        json!({"state": WorkerState::Crashed, "gaveUp": true}),
                    );
                    return;
                }
                let backoff = std::time::Duration::from_secs(1u64 << attempt);
                tokio::time::sleep(backoff).await;
                let mut reg = shared.lock().await;
                let _ = revive_tab(&mut reg, &sink, &tab_id).await;
            }
            if s == WorkerState::Stopped {
                return;
            }
        }
    });
}

fn normalize_path(p: &str) -> String {
    // M0：字符串规范化（去尾部斜杠）；M1 换 canonicalize
    p.trim_end_matches('/').to_string()
}
