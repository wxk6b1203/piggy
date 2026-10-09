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
    /// 权限守卫扩展脚本（pi/resources.rs::guard_script_path）；setup 时填充
    pub guard_script: Option<PathBuf>,
    /// 桥接扩展脚本（pi/resources.rs::bridge_script_path，docs/06 §4）；setup 时填充。
    /// 缺失只影响 Fleet 数据面，不影响会话启动。
    pub bridge_script: Option<PathBuf>,
    /// 子代理委派策略（pi/resources.rs::subagent_policy_path，docs/06 §6）。
    /// `Some` = `~/.piggy/config.json` 里开关打开；是否**真的**生效还要看档位
    /// （见 `pi/process.rs::subagent_delegation_active`）。setup 时填充。
    pub subagent_policy: Option<PathBuf>,
    /// **捆绑的 pi 插件候选目录**（`pi/resources.rs::bundled_plugin_dir`，docs/06 §7）。
    ///
    /// 存"候选"而不是"最终路径"：装不装由 `~/.piggy/config.json` 的 `bundled_plugins`
    /// 与"用户是不是自己装过同名扩展"两件事在 spawn 时决定
    /// （重复加载会让 pi 因工具名冲突直接退出，见 `pi/plugins.rs`）。
    pub bundled_plugins: Vec<PathBuf>,
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
            bundled_plugins: Vec::new(),
            bridge_script: None,
            subagent_policy: None,
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
        let b = crate::pi::discovery::discover(self.pi_source, self.pi_custom_path.as_deref(), self.builtin.as_deref())
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
        /* spawn **之后**的任何失败都必须把这棵树收掉。
        为什么值得单独一个函数：握手超时（`get_state`）以前是直接 `?` 返回的，
        于是那个 worker 既不在 `self.tabs` 里（没人会再关它）、进程又活着 ——
        它继续握着那份会话文件，用户再点一次同一个会话就是两个写者，
        下一次握手更慢、继续超时。一个失败会自己养出下一次失败（2026-10-09 实测踩到）。 */
        self.bind_new_tab(sink, tab_id, cwd, name, permission, worker).await
    }

    /// `create_tab` 的第二段（握手 + 记账）。失败时**由这里**收掉 worker。
    async fn bind_new_tab(
        &mut self,
        sink: &Arc<dyn EventSink>,
        tab_id: String,
        cwd: PathBuf,
        name: Option<String>,
        permission: PermissionMode,
        worker: Worker,
    ) -> Result<TabSnapshot, String> {
        let state = match worker.get_state().await {
            Ok(s) => s,
            Err(e) => {
                // 握手失败 = 这个 worker 不可用。连根杀（Windows 上有 cmd.exe 垫片，
                // 只 kill 直接子进程会留下孤儿 node），再原样把原因交出去。
                worker.shutdown().await;
                return Err(e);
            }
        };
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
        /* 游标初始化（"已见"边界）**不在打开路径上**，由 `spawn_cursor_init` 在后台补。
        这里曾经直接 `worker.get_entries(None).await`：pi 的 `get_entries` 不带 `since`
        会把**整段**会话发回来（`rpc-mode.js` 的 get_entries 分支），而我们只要里面的
        `leafId` —— 11.13 MB 的会话实测 **73 ms**，且随会话线性增长，正好压在
        "点一下打开会话"最关键的那一下上（用户 2026-09-23 问"这 1s 是 pi 的还是我们的"）。
        游标只是**崩溃恢复**的优化（`revive_tab` 用它做增量 resync），不是打开会话的
        必需品：补上之前若 worker 崩了，resync 退回全量（罕见路径，前端按
        `role:timestamp` 去重，不会重复显示）。 */
        let last_cursor = None;
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
        let bridge = self.bridge_script.clone();
        let policy = self.subagent_policy.clone();
        /* 捆绑插件：按当前配置过滤一遍（设置页关掉的不注入）。
        放到 spawn 时算而不是 setup 时算：`bundled_plugins` 是用户能改的开关，
        改完新建标签页就该生效，不必重启应用。 */
        let plugins = crate::pi::plugins::enabled_plugin_dirs(&self.bundled_plugins);
        let build = |pi_bin: PathBuf| SpawnArgs {
            cwd: cwd.clone(),
            pi_bin,
            session: session.clone(),
            name: name.clone(),
            permission,
            guard_script: guard.clone(),
            bridge_script: bridge.clone(),
            subagent_policy: policy.clone(),
            bundled_extensions: plugins.clone(),
            envs: Vec::new(),
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
            .filter(|t| {
                matches!(
                    t.worker_state(),
                    WorkerState::Ready | WorkerState::Busy | WorkerState::Spawning
                )
            })
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
                matches!(t.worker_state(), WorkerState::Ready) && t.last_activity.elapsed().as_secs() >= timeout_secs
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
        let Some(tab) = self.tabs.get_mut(tab_id) else {
            return false;
        };
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
    pub async fn ensure_worker(&mut self, sink: &Arc<dyn EventSink>, tab_id: &str) -> Result<Worker, String> {
        let needs_revive = match self.tabs.get(tab_id) {
            None => return Err(format!("tab 不存在: {tab_id}")),
            Some(tab) => match &tab.worker {
                Some(w) => !matches!(
                    w.state(),
                    WorkerState::Ready | WorkerState::Busy | WorkerState::Spawning
                ),
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

/// 会话名的两个来源，按优先级取（用户 2026-09-23 报："点击重新生成标题之后，
/// 上方的标题也要更新"）。
///
/// 1. `tab.session_name`：建 tab 时调用方给的名字（新会话的临时名），
///    以及 `/name` / `pi_set_session_name` 写回来的那个；
/// 2. pi 的 `get_state.sessionName`：**pi 从会话文件里读出来的**（最新一条
///    `session_info` 条目，pi `session-manager.js:926-935`）。
///
/// 第 2 条是"这个会话叫什么"的真相。少了它，打开一个**已命名**的会话时前端拿到的
/// 是 `null`，上方标题就退回"第一条用户消息"——与侧栏那一行（读 `session_list`
/// 的 `name`）对不上。刚被 `session_title_generate` / `session_rename` 改过名的
/// 会话更是直接显示旧名字。
fn session_name_of(tab: &Tab, state: &Value) -> Option<String> {
    tab.session_name
        .clone()
        .or_else(|| state.get("sessionName").and_then(Value::as_str).map(str::to_string))
        .filter(|n| !n.trim().is_empty())
}

fn snapshot_of(tab: &Tab, state: &Value) -> TabSnapshot {
    TabSnapshot {
        tab_id: tab.tab_id.clone(),
        cwd: tab.cwd.to_string_lossy().into_owned(),
        session_id: tab.session_id.clone(),
        session_file: tab.session_file.clone(),
        session_name: session_name_of(tab, state),
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
/// 后台补初始游标（见 `create_tab` 里的说明）。
///
/// 单独一个函数只因为**不能在 registry 锁里跑**：对长会话这是一次百毫秒级的
/// "把整段会话序列化 + 传回来 + 解析"，而那把锁是全局的（会卡住其它标签的命令）。
///
/// 只在 `last_cursor` 还是空时写入：游标比"前端实际已经看到的"更新，会让崩溃恢复的
/// resync **漏掉**条目 —— 那是数据丢失，比多传一段严重得多。
pub fn spawn_cursor_init(registry: SharedRegistry, tab_id: String) {
    tokio::spawn(async move {
        let worker = {
            let reg = registry.lock().await;
            reg.tabs.get(&tab_id).and_then(|t| t.worker.clone())
        };
        let Some(worker) = worker else { return };
        let Ok(data) = worker.get_entries(None).await else {
            return;
        };
        let leaf = data["leafId"].as_str().map(str::to_string);
        let mut reg = registry.lock().await;
        if let Some(tab) = reg.tabs.get_mut(&tab_id) {
            fill_cursor_if_empty(tab, leaf);
        }
    });
}

/// 后台游标的写入判据（抽成纯函数是为了能单测 —— 这条判据错了是**数据丢失**级别的）。
///
/// 只在还是空时写：迟到的叶子绝不许覆盖更新的值。游标比"前端实际已经看到的"更新，
/// 崩溃恢复的 resync 就会**跳过**那些条目 —— 那是静默丢消息，比慢一点严重得多。
///
/// @returns 是否真的写进去了
fn fill_cursor_if_empty(tab: &mut Tab, leaf: Option<String>) -> bool {
    let Some(leaf) = leaf.filter(|l| !l.trim().is_empty()) else {
        return false;
    };
    if tab.last_cursor.is_some() {
        return false;
    }
    tab.last_cursor = Some(leaf);
    true
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi::permission::PermissionMode;

    fn tab_with_name(name: Option<&str>) -> Tab {
        Tab {
            tab_id: "t1".into(),
            cwd: PathBuf::from("/tmp"),
            session_file: Some("/tmp/s.jsonl".into()),
            session_id: None,
            session_name: name.map(str::to_string),
            last_cursor: None,
            worker: None,
            restarts: 0,
            deliberate: false,
            permission: PermissionMode::Workspace,
            last_activity: Instant::now(),
        }
    }

    #[test]
    fn session_name_falls_back_to_pi_state() {
        // 打开一个**已命名**的会话：调用方没给名字，名字在会话文件里（pi 读出来了）
        let tab = tab_with_name(None);
        let state = json!({ "sessionName": "项目严重缺陷排查" });
        assert_eq!(session_name_of(&tab, &state).as_deref(), Some("项目严重缺陷排查"));
    }

    #[test]
    fn explicit_tab_name_wins_over_pi_state() {
        // `/name` 之后 tab 上那一份是**刚写下去**的，pi 的 state 可能还是连接时的旧值
        let tab = tab_with_name(Some("新名字"));
        let state = json!({ "sessionName": "旧名字" });
        assert_eq!(session_name_of(&tab, &state).as_deref(), Some("新名字"));
    }

    fn tab_for_cursor(cursor: Option<&str>) -> Tab {
        let mut t = tab_with_name(None);
        t.last_cursor = cursor.map(str::to_string);
        t
    }

    #[test]
    fn background_cursor_fills_only_when_empty() {
        // 空 → 补上
        let mut t = tab_for_cursor(None);
        assert!(fill_cursor_if_empty(&mut t, Some("leaf-1".into())));
        assert_eq!(t.last_cursor.as_deref(), Some("leaf-1"));
        // 已经有值（例如 revive 之后写的更新值）→ 迟到的叶子**不许覆盖**：
        // 游标比"前端已看到的"更新 → resync 会跳过条目 = 静默丢消息
        assert!(!fill_cursor_if_empty(&mut t, Some("leaf-2".into())));
        assert_eq!(t.last_cursor.as_deref(), Some("leaf-1"));
        // pi 没给叶子 / 给了空串 → 什么都不做
        let mut empty = tab_for_cursor(None);
        assert!(!fill_cursor_if_empty(&mut empty, None));
        assert!(!fill_cursor_if_empty(&mut empty, Some("  ".into())));
        assert!(empty.last_cursor.is_none());
    }

    #[test]
    fn blank_names_are_treated_as_absent() {
        // 新会话：pi 还没给名字（`undefined` / 空串），别把空串当名字传给前端
        assert_eq!(session_name_of(&tab_with_name(None), &json!({})), None);
        assert_eq!(
            session_name_of(&tab_with_name(None), &json!({ "sessionName": "" })),
            None
        );
        assert_eq!(session_name_of(&tab_with_name(Some("   ")), &json!({})), None);
    }
}
