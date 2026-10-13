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
    /// **捆绑的 pi 插件候选**（`pi/resources.rs::bundled_plugin_dir_with_origin`，docs/06 §7）。
    ///
    /// 存"候选"而不是"最终路径"：装不装由 `~/.piggy/config.json` 的 `bundled_plugins`
    /// 与"用户是不是自己装过同名扩展"两件事在 **spawn 时**决定
    /// （重复加载会让 pi 因工具名冲突直接退出，见 `pi/plugins.rs`）。
    /// 候选里也包含**目录缺失**的那些（`dir: None`）—— 否则打包漏登记时设置页连一行都不显示。
    pub bundled_plugins: Vec<crate::pi::plugins::Candidate>,
    /// 新建标签页的默认档位（持久化在 ~/.piggy/config.json）
    pub default_permission: PermissionMode,
    /// tab_id → Tab（docs/03 §2.7）
    pub tabs: HashMap<String, Tab>,
    /// 会话文件（规范化路径）→ 占用它的 tab_id（docs/02 §6.3 互斥）
    open_files: HashMap<String, String>,
    /// **正在复活**的 tab_id 集合。复活必须"锁外握手"（见 `revive_unlocked`），
    /// 而两个并发复活会给同一个 tab 拉起两个 pi、写同一份会话文件 —— 所以要有占位。
    reviving: std::collections::HashSet<String>,
}

pub type SharedRegistry = Arc<Mutex<Registry>>;

/// 建 tab 的"现场"：调用方在锁内填好，交给 [`Registry::bind_new_tab`] 记账。
///
/// 单独一个结构体（而不是五个位置参数）不只是为了过 clippy 的 7 参数线：
/// `create_tab` / `create_tab_unlocked` 两条入口都要传同样一组东西，
/// 位置参数多到一定程度就会开始串味（`name` 与 `permission` 都是"看起来都像字符串"的那种）。
pub struct NewTab {
    pub tab_id: String,
    pub cwd: PathBuf,
    pub name: Option<String>,
    pub permission: PermissionMode,
}

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
            reviving: std::collections::HashSet::new(),
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
    ///
    /// ⚠️ **不要**在持有 registry 锁时调它：握手预算 40s，握着全局锁等它会把
    /// 所有标签页的命令一起卡住（2026-10-09 复查发现）。真正的实现拆成
    /// 「锁内 spawn → **锁外握手** → 锁内记账」三段，见 [`create_tab_unlocked`]。
    /// 这里保留 `&mut self` 形态只为了给测试与"已经持锁"的调用方一个入口。
    pub async fn create_tab(
        &mut self,
        sink: &Arc<dyn EventSink>,
        cwd: PathBuf,
        session: SessionTarget,
        name: Option<String>,
        permission: PermissionMode,
    ) -> Result<TabSnapshot, String> {
        let tab = NewTab {
            tab_id: uuid::Uuid::new_v4().to_string(),
            cwd,
            name,
            permission,
        };
        let worker = self
            .spawn_with_rediscovery(
                &tab.tab_id,
                tab.cwd.clone(),
                session,
                tab.name.clone(),
                tab.permission,
                sink.clone(),
            )
            .await?;
        /* spawn **之后**的任何失败都必须把这棵树收掉。
        为什么值得单独一个函数：握手超时（`get_state`）以前是直接 `?` 返回的，
        于是那个 worker 既不在 `self.tabs` 里（没人会再关它）、进程又活着 ——
        它继续握着那份会话文件，用户再点一次同一个会话就是两个写者，
        下一次握手更慢、继续超时。一个失败会自己养出下一次失败（2026-10-09 实测踩到）。

        ⚠️ 这条不变量对**每一条** spawn 之后的路径都成立，不只是建 tab：
        `revive`（崩溃复活 / 休眠唤醒 / 切权限档）同样在 spawn 之后有四个失败点，
        它们共用 `bind_or_kill`。漏掉一处的症状是"某个标签页崩过一次之后，
        打开会话越来越慢"，而不是一条报错 —— 所以还有一条**源码文本闸门**
        （`revive_reaps_the_worker_on_every_post_spawn_failure`）盯着别漏。 */
        let state = handshake(&worker).await?;
        self.bind_new_tab(sink, tab, worker, state).await
    }

    /// `create_tab` 的第二段（记账）。失败时**由这里**收掉 worker。
    ///
    /// @param state - 已经拿到的 `get_state` 结果（握手在锁外做，见 [`create_tab_unlocked`]）
    async fn bind_new_tab(
        &mut self,
        sink: &Arc<dyn EventSink>,
        tab: NewTab,
        worker: Worker,
        state: Value,
    ) -> Result<TabSnapshot, String> {
        let NewTab {
            tab_id,
            cwd,
            name,
            permission,
        } = tab;
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
        /* ⚠️ cwd 必须传进去：项目级 `<cwd>/.pi/extensions` 里的同名扩展同样会让 pi
        因工具名冲突直接退出（真机复现过），而 2026-10-09 之前这里写死 `None`，
        等于那条路在生产里一直瞎着。 */
        let plugins = crate::pi::plugins::enabled_plugin_dirs(&self.bundled_plugins, Some(&cwd));
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
    /// 再交互时按需复活（`revive_unlocked`）+ 游标补齐。
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

/// 「spawn 之后、记账之前」的失败必须**连根收掉**这棵进程树。
///
/// 抽成唯一漏斗的理由见 `create_tab` 里那段注释（孤儿 pi 握着会话文件 → 下一次更慢 →
/// 继续超时，一个失败自己养出下一个失败）。这里的 `Err` 一律先 `shutdown()`（Windows 上
/// 是 `taskkill /T /F` + `wait()` 收尸）再把原因原样交出去 —— **不吞错**：
/// 调用方与用户看到的仍然是那条真实的失败原因。
async fn bind_or_kill<T>(worker: &Worker, r: Result<T, String>) -> Result<T, String> {
    match r {
        Ok(v) => Ok(v),
        Err(e) => {
            worker.shutdown().await;
            Err(e)
        }
    }
}

/// **锁外握手**：`get_state` 是冷启动的第一条命令（起 node、读配置、加载扩展、
/// 读会话文件），预算 [`crate::pi::client::COLD_START_TIMEOUT`]。
///
/// 为什么单独成一个函数：它必须能在**没有 registry 锁**的情况下被调用 ——
/// 之前握手发生在锁里（`create_tab` 直接 `?`），一次慢启动就能让整个应用
/// 冻结到 40s（别的标签页的命令全走同一把锁）。失败时照样收树，见 `bind_or_kill`。
pub async fn handshake(worker: &Worker) -> Result<Value, String> {
    bind_or_kill(worker, worker.get_state().await).await
}

/// **锁外建 tab**（三段式）：
///
/// ```text
/// ① 锁内：分配 tab_id + 拉起 pi 进程（毫秒级）
/// ② 锁外：握手（冷启动预算 40s —— 只卡这一次调用，不卡整个应用）
/// ③ 锁内：会话文件互斥 + 记账 + 发事件
/// ```
///
/// 并发正确性：两个调用同时打开**同一份会话文件**时，两边都会走到 ③，
/// 而 ③ 里的「查 `open_files` → 插入」是原子的 —— 后到的那个会看见先到的 owner，
/// 于是拒绝并收掉自己的进程（与改造前 ① ② 全在锁里时的行为一致）。
/// 唯一的软肋是 `max_workers`：检查在 ① 之前，并发建 tab 可能**临时**多出一个进程，
/// 下一次建 tab 就会被挡（上限本身是"活跃会话"的软约束，不是资源硬闸）。
///
/// @param max_workers - 活跃会话上限（05 §4.2；0 = 不限制）
pub async fn create_tab_unlocked(
    shared: &SharedRegistry,
    sink: &Arc<dyn EventSink>,
    cwd: PathBuf,
    session: SessionTarget,
    name: Option<String>,
    permission: PermissionMode,
    max_workers: usize,
) -> Result<TabSnapshot, String> {
    let tab = NewTab {
        tab_id: uuid::Uuid::new_v4().to_string(),
        cwd,
        name,
        permission,
    };
    /* 活跃会话上限（锁内只做这一次毫秒级检查）。
    2026-10-13：这一段以前还顺带"取走预热 worker"，所以锁的作用域必须跨住整个取用过程；
    预热池删掉之后锁就只包这一次检查 —— 与上面"别握着锁 spawn"的口径一致。 */
    if max_workers > 0 {
        let reg = shared.lock().await;
        if reg.alive_worker_count() >= max_workers {
            return Err(format!(
                "MAX_WORKERS: 活跃会话已达上限 {max_workers}。可关闭或休眠不用的标签后重试。"
            ));
        }
    }
    let worker = {
        let mut reg = shared.lock().await;
        reg.spawn_with_rediscovery(
            &tab.tab_id,
            tab.cwd.clone(),
            session,
            tab.name.clone(),
            tab.permission,
            sink.clone(),
        )
        .await?
    };
    let state = handshake(&worker).await?;
    let snapshot = {
        let mut reg = shared.lock().await;
        reg.bind_new_tab(sink, tab, worker, state).await?
    };
    Ok(snapshot)
}

/// 「改权限档位」的**锁内准备段**：校验、改档、把旧 worker 摘下来（由调用方在锁外停它）。
///
/// 抽出来是为了让命令层能在锁内只做微秒级的事 —— 停进程要 `abort`（最多 2s）+
/// `taskkill`，复活要握手（40s 预算），两件都不能在锁里做。
fn begin_set_permission(
    reg: &mut Registry,
    tab_id: &str,
    mode: PermissionMode,
) -> Result<(Option<Worker>, Option<String>), String> {
    let Some(tab) = reg.tabs.get_mut(tab_id) else {
        return Err(format!("tab 不存在: {tab_id}"));
    };
    let state = tab.worker.as_ref().map(|w| w.state());
    if matches!(state, Some(WorkerState::Busy)) {
        return Err("会话正在运行，请先中断（Esc）再切换权限档位".to_string());
    }
    tab.permission = mode;
    tab.restarts = 0; // 换档不是崩溃，不占崩溃重启预算
    Ok((tab.worker.take(), tab.session_file.clone()))
}

/// **锁外切权限档位**（`--tools`/`-e` 都是 CLI 参数 → 只能带同一份会话文件重启 worker）。
///
/// 三段式：改档（锁内）→ 停旧进程（锁外）→ 按新档复活（锁外，复用崩溃复活那条路径，
/// 因此会话文件、游标补齐、resync 的语义完全一致）。
/// 拒绝在流式中切换：那会打断进行中的回合，且用户看不到"后半段用了另一个档位"。
pub async fn set_permission_unlocked(
    shared: &SharedRegistry,
    sink: &Arc<dyn EventSink>,
    tab_id: &str,
    mode: PermissionMode,
) -> Result<Value, String> {
    let (old_worker, session_file) = {
        let mut reg = shared.lock().await;
        begin_set_permission(&mut reg, tab_id, mode)?
    };
    // 主动停旧进程；deliberate 期间 watcher 不会把它当崩溃复活
    if let Some(w) = old_worker {
        let _ = w.shutdown().await;
    }
    let revived = revive_unlocked(shared, sink, tab_id).await;
    let worker_state = {
        let reg = shared.lock().await;
        reg.tabs
            .get(tab_id)
            .map(|t| t.worker_state())
            .unwrap_or(WorkerState::Crashed)
    };
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

/// 一次复活的"现场"：锁内取，**锁外**干活。
pub struct ReviveJob {
    pub tab_id: String,
    pub cwd: PathBuf,
    pub expected_file: Option<String>,
    pub cursor: Option<String>,
    pub permission: PermissionMode,
    pub restarts: u32,
}

/// `claim_revive` 的结果。
pub enum ReviveClaim {
    /// 不需要复活：已经有可用 worker
    Ready(Worker),
    /// 拿到现场，去锁外干活
    Claimed(Box<ReviveJob>),
    /// 已经有一个复活在跑（调用方应当等一等再看）
    InFlight,
}

impl Registry {
    /// 已经有可用 worker 吗（`Ready`/`Busy`/`Spawning`）？顺带刷新活跃时间（05 §4.1）。
    ///
    /// @returns `Ok(Some)` 可用；`Ok(None)` 需要复活（交给锁外的 `revive_unlocked`）；
    ///          `Err` 这个 tab 根本不存在（调用方该把错误交给用户，而不是去复活）
    pub fn ready_worker(&mut self, tab_id: &str) -> Result<Option<Worker>, String> {
        let Some(tab) = self.tabs.get_mut(tab_id) else {
            return Err(format!("tab 不存在: {tab_id}"));
        };
        tab.last_activity = Instant::now();
        Ok(match &tab.worker {
            Some(w)
                if matches!(
                    w.state(),
                    WorkerState::Ready | WorkerState::Busy | WorkerState::Spawning
                ) =>
            {
                Some(w.clone())
            }
            _ => None,
        })
    }

    /// 认领一次复活（**锁内，微秒级**）：取自增后的重启计数、检查上限、占位。
    ///
    /// 占位（`reviving`）是必须的：没有它，两个并发调用会给同一个 tab 拉起两个 pi，
    /// 而两个进程写同一份会话文件正是 `open_files` 互斥要避免的事。
    pub fn claim_revive(&mut self, tab_id: &str) -> Result<ReviveClaim, String> {
        if let Some(w) = self.ready_worker(tab_id)? {
            return Ok(ReviveClaim::Ready(w));
        }
        if self.reviving.contains(tab_id) {
            return Ok(ReviveClaim::InFlight);
        }
        let Some(tab) = self.tabs.get_mut(tab_id) else {
            return Err(format!("tab 不存在: {tab_id}"));
        };
        tab.restarts += 1;
        if tab.restarts > 3 {
            return Err(format!("tab {tab_id} 重启次数超限（>3），请手动重试"));
        }
        let job = ReviveJob {
            tab_id: tab_id.to_string(),
            cwd: tab.cwd.clone(),
            expected_file: tab.session_file.clone(),
            cursor: tab.last_cursor.clone(),
            permission: tab.permission,
            restarts: tab.restarts,
        };
        self.reviving.insert(tab_id.to_string());
        Ok(ReviveClaim::Claimed(Box::new(job)))
    }

    /// 放弃占位（复活失败，或准备提交）。
    pub fn release_revive(&mut self, tab_id: &str) {
        self.reviving.remove(tab_id);
    }

    /// 复活成功的记账（锁内）：写回会话信息与游标、发 `piggy:resync` 与 `pi:state`。
    ///
    /// tab 可能在锁外那段时间里被关掉 → 此时**必须收掉这个 worker**（它已经不在
    /// `self.tabs` 里，没人会再关它），并返回错误让调用方别再往下走。
    fn commit_revive(
        &mut self,
        sink: &Arc<dyn EventSink>,
        job: &ReviveJob,
        state: &Value,
        data: &Value,
    ) -> Result<Worker, String> {
        let leaf_id = data["leafId"].as_str().map(String::from);
        let worker = match self.tabs.get_mut(&job.tab_id).and_then(|t| t.worker.clone()) {
            Some(w) => w,
            None => return Err(format!("tab 在复活期间被关闭: {}", job.tab_id)),
        };
        sink.emit_json(
            &format!("pi:commit:{}", job.tab_id),
            json!({
                "type": "piggy:resync",
                "entries": data["entries"].clone(),
                "leafId": leaf_id,
            }),
        );
        worker.set_state(WorkerState::Ready);
        if let Some(tab) = self.tabs.get_mut(&job.tab_id) {
            tab.session_file = state["sessionFile"].as_str().map(String::from);
            tab.session_id = state["sessionId"].as_str().map(String::from);
            tab.last_cursor = leaf_id;
            tab.worker = Some(worker.clone());
            if tab.deliberate {
                tab.deliberate = false;
            }
        }
        sink.emit_json(
            &format!("pi:state:{}", job.tab_id),
            json!({"state": WorkerState::Ready, "revived": true, "attempt": job.restarts}),
        );
        Ok(worker)
    }
}

/// **锁外复活**（崩溃 watcher / 休眠唤醒 / 切权限档 / 任何命令的按需复活共用）。
///
/// 与 [`create_tab_unlocked`] 同一套三段式，只是中间那段多了"换会话 + 补游标"：
/// ① `claim_revive`（锁内）② spawn + 握手 + `switch_session` + `get_entries`（**锁外**）
/// ③ `commit_revive`（锁内）。
///
/// 撞上"已经有别的调用在复活"时**等**（最多等到握手预算用完），而不是报错：
/// 前端一个面板挂载会并发发好几条命令（get_state / 模型表 / 命令表），
/// 报错会变成一串红色 toast —— 而它们要的其实是同一个 worker。
pub async fn revive_unlocked(
    shared: &SharedRegistry,
    sink: &Arc<dyn EventSink>,
    tab_id: &str,
) -> Result<Worker, String> {
    let started = Instant::now();
    let job = loop {
        {
            let mut reg = shared.lock().await;
            match reg.claim_revive(tab_id)? {
                ReviveClaim::Ready(w) => return Ok(w),
                ReviveClaim::Claimed(job) => break job,
                ReviveClaim::InFlight => {}
            }
        }
        if started.elapsed() > crate::pi::client::COLD_START_TIMEOUT + std::time::Duration::from_secs(5) {
            return Err(format!(
                "会话 {tab_id} 正在恢复中，等了 {}s 还没好",
                started.elapsed().as_secs()
            ));
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    };

    // ① spawn（短暂持锁：`spawn_with_rediscovery` 要用 registry 里的 pi 路径缓存）
    let target = job
        .expected_file
        .clone()
        .map(SessionTarget::Path)
        .unwrap_or(SessionTarget::New);
    let spawned = {
        let mut reg = shared.lock().await;
        reg.spawn_with_rediscovery(&job.tab_id, job.cwd.clone(), target, None, job.permission, sink.clone())
            .await
    };
    let worker = match spawned {
        Ok(w) => w,
        Err(e) => {
            shared.lock().await.release_revive(&job.tab_id);
            return Err(e);
        }
    };

    // ② 锁外：握手 → （必要时）换会话 → 补游标。**每一处失败都走 bind_or_kill**
    //    （spawn 之后的任何失败都要收树），然后释放占位。
    let fetched: Result<(Value, Value), String> = async {
        let mut state = handshake(&worker).await?;
        let actual = state["sessionFile"].as_str().map(String::from);
        if let Some(expected) = &job.expected_file {
            if actual.as_deref() != Some(expected.as_str()) {
                bind_or_kill(&worker, worker.switch_session(expected).await).await?;
                state = handshake(&worker).await?;
            }
        }
        // 游标补齐（C5 语义）：since 有效 → 增量；失效 → 全量
        let entries = match &job.cursor {
            Some(c) => worker.get_entries(Some(c.as_str())).await,
            None => worker.get_entries(None).await,
        };
        let data = match entries {
            Ok(d) => d,
            Err(_) => bind_or_kill(&worker, worker.get_entries(None).await).await?,
        };
        Ok((state, data))
    }
    .await;

    // ③ 锁内记账
    let mut reg = shared.lock().await;
    reg.release_revive(&job.tab_id);
    let (state, data) = match fetched {
        Ok(v) => v,
        Err(e) => return Err(e),
    };
    match reg.commit_revive(sink, &job, &state, &data) {
        Ok(w) => Ok(w),
        Err(e) => {
            // tab 在锁外那段时间被关掉了：这个 worker 已经没人认领，收掉它
            drop(reg);
            worker.shutdown().await;
            Err(e)
        }
    }
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
                /* 复活**不在锁里**跑（`revive_unlocked` 自己在三段之间取锁）：
                握手预算是 40s，握着全局锁等它会把所有标签页的命令一起卡住。 */
                let _ = revive_unlocked(&shared, &sink, &tab_id).await;
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

    /// **复活占位**：同一个 tab 同时只允许一个复活在跑。
    ///
    /// 这条判据错了的后果不是"慢"：两个 pi 会同时握着同一份会话文件写，
    /// 正是 `open_files` 互斥要避免的事。而前端一个面板挂载会并发发好几条命令
    /// （get_state / 模型表 / 命令表）—— 所以第二个调用必须拿到 `InFlight` 去**等**，
    /// 而不是自己去拉一个进程。
    #[test]
    fn a_second_revive_claim_is_told_to_wait_instead_of_spawning_a_twin() {
        let mut reg = Registry::new(None);
        reg.tabs.insert("t1".into(), tab_with_name(None));
        assert!(matches!(reg.claim_revive("t1").unwrap(), ReviveClaim::Claimed(_)));
        assert!(
            matches!(reg.claim_revive("t1").unwrap(), ReviveClaim::InFlight),
            "第二个调用者必须被告知『正在复活』"
        );
        // 释放之后（复活结束，成功或失败）可以再次认领
        reg.release_revive("t1");
        assert!(matches!(reg.claim_revive("t1").unwrap(), ReviveClaim::Claimed(_)));
    }

    /// 重启预算：第 4 次认领直接拒绝（沿用 `>3` 的旧判据），且**不留下占位**。
    #[test]
    fn revive_claim_gives_up_after_three_attempts() {
        let mut reg = Registry::new(None);
        reg.tabs.insert("t1".into(), tab_with_name(None));
        for _ in 0..3 {
            assert!(matches!(reg.claim_revive("t1").unwrap(), ReviveClaim::Claimed(_)));
            reg.release_revive("t1");
        }
        // 不用 `unwrap_err()`：`ReviveClaim` 里装着 `Worker`（没有 Debug），
        // 为了一条用例给整条链路加 Debug 派生不划算
        let err = match reg.claim_revive("t1") {
            Err(e) => e,
            Ok(_) => panic!("第 4 次该被拒绝（重启次数超限）"),
        };
        assert!(err.contains("重启次数超限"), "第 4 次该拒绝：{err}");
        assert!(!reg.reviving.contains("t1"), "被拒的认领留下了占位");
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

    /// **源码文本闸门**：复活路径里不许再出现裸的 `worker.xxx().await?`。
    ///
    /// 为什么用读源码这种笨办法：漏掉一处的后果不是一条报错，而是"某个标签页崩过一次
    /// 之后，打开会话越来越慢" —— 孤儿 pi 活着、握着会话文件，谁都不会发现。
    /// 而这条不变量没法用类型系统表达（要动的面太大），所以退而求其次：
    /// 函数体里每次 spawn 之后的失败都必须经过 `bind_or_kill`。
    #[test]
    fn revive_reaps_the_worker_on_every_post_spawn_failure() {
        let src = include_str!("registry.rs");
        let body = src
            .split_once("pub async fn revive_unlocked(")
            .and_then(|(_, rest)| rest.split_once("\n}\n"))
            .map(|(b, _)| b)
            .expect("找不到 revive_unlocked 的函数体（改名了就要同步改这条闸门）");
        let offenders: Vec<&str> = body
            .lines()
            .map(str::trim)
            .filter(|l| l.contains("worker.") && l.contains(".await?") && !l.contains("bind_or_kill("))
            .collect();
        assert!(
            offenders.is_empty(),
            "复活路径里还有没走 bind_or_kill 的调用（spawn 之后失败会漏掉整棵进程树）：{offenders:#?}"
        );
        // 反面：确认真的在用它（否则上面那条可能只是"函数体里什么调用都没有"）。
        // `handshake()` 内部就是 `bind_or_kill(get_state)`，所以两个都算回收点。
        let reaping_sites = body.matches("bind_or_kill(").count() + body.matches("handshake(&worker)").count();
        assert!(
            reaping_sites >= 4,
            "复活路径的回收点变少了（{reaping_sites} 处）—— 是不是把某处改回裸 `?` 了？"
        );
    }
}
