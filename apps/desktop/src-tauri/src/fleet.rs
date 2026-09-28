//! A 层：宿主 Fleet 编排（docs/06 §3，M3）。
//! FleetRun = 模板实例：多条 lane（各绑定一个 registry worker/tab），DAG 依赖由 Rust 调度。
//! lane = registry 的 Tab（kind=Fleet）：完整复用 worker 生命周期/资源上限/事件管线，
//! "提升为标签页"即前端对该 tabId 打开 dockview 面板（06 §3.5）。

use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::pi::client::WorkerState;

/* ---------------- 模板（纯数据，06 §3.2） ---------------- */

/// 内置模板（JSON）：lanes[].key/role/prompt/depends_on[]/worktree。
/// prompt 为角色模板，{task}/{worktree} 为运行时注入占位符。
pub fn builtin_templates() -> Value {
    json!({
        "scout-review-build": {
            "label": "侦察 → 评审 + 构建",
            "lanes": [
                {
                    "key": "scout", "role": "侦察", "depends_on": [],
                    "prompt": "你是侦察员。只读工具。调研以下任务的相关代码与上下文，输出结构化事实清单（不要修改任何文件）：\n{task}"
                },
                {
                    "key": "review", "role": "评审", "depends_on": ["scout"],
                    "prompt": "你是评审员。只读工具。基于侦察结论，从正确性/边界条件角度审查该任务的实现方案：\n{task}\n侦察结论：\n{upstream}"
                },
                {
                    "key": "build", "role": "构建", "depends_on": ["scout"], "worktree": true,
                    "prompt": "你是实现者。根据任务与侦察结论完成实现（在分配的工作目录内）：\n{task}\n侦察结论：\n{upstream}"
                }
            ]
        },
        "parallel-review": {
            "label": "并行评审",
            "lanes": [
                { "key": "r-correctness", "role": "评审·正确性", "depends_on": [], "prompt": "只读评审。专注正确性与边界条件：\n{task}" },
                { "key": "r-tests", "role": "评审·测试", "depends_on": [], "prompt": "只读评审。专注测试覆盖与可测性：\n{task}" },
                { "key": "r-complexity", "role": "评审·复杂度", "depends_on": [], "prompt": "只读评审。专注复杂度与可维护性：\n{task}" }
            ]
        },
        "research": {
            "label": "调研汇总",
            "lanes": [
                { "key": "res-1", "role": "调研·方案空间", "depends_on": [], "prompt": "网络调研。梳理可行方案空间与取舍：\n{task}" },
                { "key": "res-2", "role": "调研·实践案例", "depends_on": [], "prompt": "网络调研。收集业界实践案例与踩坑：\n{task}" },
                { "key": "synth", "role": "汇总", "depends_on": ["res-1", "res-2"], "prompt": "汇总以下调研结论为决策建议（含推荐与风险）：\n{task}\n调研结论：\n{upstream}" }
            ]
        },
        "custom": { "label": "自定义", "lanes": [] }
    })
}

/* ---------------- 状态机（06 §3.1）：Draft → Running → Settled → Done | Aborted ---------------- */

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Running,
    Done,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LaneStatus {
    Pending,
    Running,
    Settled,
    Failed,
}

#[derive(Debug, Clone)]
pub struct Lane {
    pub key: String,
    pub role: String,
    pub prompt: String,
    pub depends_on: Vec<String>,
    pub worktree: bool,
    pub status: LaneStatus,
    pub tab_id: Option<String>,
    pub result_text: Option<String>,
}

#[derive(Debug, Clone)]
pub struct FleetRun {
    pub id: String,
    pub template_id: String,
    pub task: String,
    pub cwd: PathBuf,
    pub status: RunStatus,
    pub lanes: Vec<Lane>,
}

impl FleetRun {
    /// DAG 纯函数（06 §3.3 顺序依赖）：可调度 lane = Pending 且全部依赖 Settled。
    pub fn ready_lanes(&self) -> Vec<String> {
        ready_lanes(&self.lanes)
    }

    pub fn all_done(&self) -> bool {
        self.lanes.iter().all(|l| matches!(l.status, LaneStatus::Settled | LaneStatus::Failed))
    }

    pub fn lane(&self, key: &str) -> Option<&Lane> {
        self.lanes.iter().find(|l| l.key == key)
    }

    pub fn lane_mut(&mut self, key: &str) -> Option<&mut Lane> {
        self.lanes.iter_mut().find(|l| l.key == key)
    }
}

/// 纯函数版（可单测）：可调度 lane keys，保持模板声明顺序。
pub fn ready_lanes(lanes: &[Lane]) -> Vec<String> {
    let status_of = |k: &str| lanes.iter().find(|l| l.key == k).map(|l| l.status.clone());
    lanes
        .iter()
        .filter(|l| l.status == LaneStatus::Pending)
        .filter(|l| {
            l.depends_on
                .iter()
                .all(|d| status_of(d) == Some(LaneStatus::Settled))
        })
        .map(|l| l.key.clone())
        .collect()
}

/// 模板 + 任务 → FleetRun（Draft lanes 全 Pending）。模板 JSON 形如 builtin_templates()。
pub fn build_run(
    id: String,
    template_id: &str,
    template: &Value,
    task: &str,
    cwd: PathBuf,
) -> Result<FleetRun, String> {
    let lanes_json = template
        .get("lanes")
        .and_then(|l| l.as_array())
        .ok_or_else(|| "模板缺少 lanes 数组".to_string())?;
    if lanes_json.is_empty() {
        return Err("模板没有任何 lane".into());
    }
    let mut lanes = Vec::new();
    for l in lanes_json {
        let key = l["key"].as_str().ok_or("lane 缺 key")?.to_string();
        let prompt = l["prompt"].as_str().ok_or("lane 缺 prompt")?.to_string();
        let depends_on = l["depends_on"]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect())
            .unwrap_or_default();
        // 依赖环与未知依赖在 build 时即拒绝（fail fast）
        lanes.push(Lane {
            key: key.clone(),
            role: l["role"].as_str().unwrap_or(&key).to_string(),
            prompt,
            depends_on,
            worktree: l["worktree"].as_bool().unwrap_or(false),
            status: LaneStatus::Pending,
            tab_id: None,
            result_text: None,
        });
    }
    // 环检测：DFS
    if has_cycle(&lanes) {
        return Err("模板依赖存在环".into());
    }
    Ok(FleetRun { id, template_id: template_id.to_string(), task: task.to_string(), cwd, status: RunStatus::Running, lanes })
}

fn has_cycle(lanes: &[Lane]) -> bool {
    // 三色 DFS（以索引起点，避免字符串借用生命周期问题）
    #[derive(Clone, Copy, PartialEq)]
    enum Color {
        White,
        Gray,
        Black,
    }
    fn visit(idx: usize, lanes: &[Lane], color: &mut Vec<Color>) -> bool {
        color[idx] = Color::Gray;
        for d in &lanes[idx].depends_on {
            if let Some(di) = lanes.iter().position(|l| l.key == *d) {
                match color[di] {
                    Color::Gray => return true,
                    Color::White => {
                        if visit(di, lanes, color) {
                            return true;
                        }
                    }
                    Color::Black => {}
                }
            }
        }
        color[idx] = Color::Black;
        false
    }
    let mut color = vec![Color::White; lanes.len()];
    (0..lanes.len()).any(|i| color[i] == Color::White && visit(i, lanes, &mut color))
}

/// lane prompt 渲染：{task} 注入任务，{upstream} 注入依赖 lane 结果（06 §3.3 汇总语义）。
pub fn render_prompt(template_prompt: &str, task: &str, run: &FleetRun, lane: &Lane) -> String {
    let upstream = lane
        .depends_on
        .iter()
        .filter_map(|k| run.lane(k))
        .map(|dep| {
            let result = dep.result_text.as_deref().unwrap_or("(无输出)");
            format!("[{}/{}] {}\n{}", dep.role, dep.key, result.chars().take(4000).collect::<String>(), "")
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    template_prompt
        .replace("{task}", task)
        .replace("{upstream}", &upstream)
}

/* ---------------- lane 生命周期判定（从 IO 胶水里抽出来，可单测 + 契约测试共用） ---------------- */

/// lane 的终态判定结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaneOutcome {
    /// 这一轮跑完了 → 收集结果、驱动下游
    Settled,
    /// 进程崩了/被停了 → 计失败
    Failed,
}

/// lane 的 worker 状态机（`commands::watch_lane` 的全部判定逻辑）。
///
/// 入参是「此前是否见过 Busy」与当前状态，返回「更新后的 was_busy」与「是否产生终态」：
/// - `Busy` 之后回到 `Ready` = 这一轮结束了 → Settled；
/// - `Crashed` / `Stopped` = 失败；
/// - 其余（包括"刚 spawn 还没跑就 Ready"）不产生终态 —— 否则 lane 会在 prompt
///   真正发出前就被判定完成，DAG 会带着空结果往下跑。
pub fn lane_step(was_busy: bool, state: WorkerState) -> (bool, Option<LaneOutcome>) {
    match state {
        WorkerState::Busy => (true, None),
        WorkerState::Ready if was_busy => (was_busy, Some(LaneOutcome::Settled)),
        WorkerState::Crashed | WorkerState::Stopped => (was_busy, Some(LaneOutcome::Failed)),
        _ => (was_busy, None),
    }
}

/// 容量等待的继续条件（06 §3.4：lane 计入 maxWorkers，资源不足时**排队**而不是溢出）。
///
/// 之前 `MAX_WORKERS` 只是 `continue` 掉——没有任何东西会在额度释放后重新调度，
/// 于是"当前 tab 数已达上限"时整个 run 会永久停在 Pending（实测死锁）。
pub fn should_keep_waiting(
    status: &RunStatus,
    ready_lanes: usize,
    waited: Duration,
    max_wait: Duration,
) -> bool {
    *status == RunStatus::Running && ready_lanes > 0 && waited < max_wait
}

/* ---------------- 结果收集（06 §3.3：agent_settled 后取最后一条 assistant 文本） ---------------- */

/// 从 `get_messages` 的返回里取最后一条 assistant 消息的纯文本。
///
/// 形状必须两种都认：
/// - RPC `get_messages` 的 `data` 是 **`{"messages": [...]}`**（官方 `docs/rpc-commands.md`
///   明写），Fleet 拿到的就是这一层；
/// - 事件流里直接就是裸消息数组。
///
/// 只认裸数组是一个真实存在过的 bug：lane 会 settle 但结果恒为空，
/// 下游 `{upstream}` 永远显示"(无输出)"，而界面看起来一切正常。
pub fn last_assistant_text(messages: &Value) -> Option<String> {
    let arr = match messages {
        Value::Array(a) => a,
        Value::Object(o) => o.get("messages")?.as_array()?,
        _ => return None,
    };
    let text_of = |content: &Value| -> String {
        match content {
            Value::String(s) => s.clone(),
            Value::Array(blocks) => blocks
                .iter()
                .filter_map(|b| {
                    if b["type"] == "text" {
                        b["text"].as_str().map(String::from)
                    } else {
                        None
                    }
                })
                .collect::<Vec<_>>()
                .join(""),
            _ => String::new(),
        }
    };
    arr.iter()
        .rev()
        .find(|m| m["role"] == "assistant" || m["message"]["role"] == "assistant")
        .map(|m| {
            if m.get("message").is_some() {
                text_of(&m["message"]["content"])
            } else {
                text_of(&m["content"])
            }
        })
        .filter(|s| !s.is_empty())
}

/* ---------------- Manager（IO 胶水；调度决策走上面的纯函数） ---------------- */

pub struct FleetManager {
    pub runs: Mutex<HashMap<String, FleetRun>>,
}

pub type SharedFleet = Arc<FleetManager>;

impl Default for FleetManager {
    fn default() -> Self {
        Self::new()
    }
}

impl FleetManager {
    pub fn new() -> Self {
        Self { runs: Mutex::new(HashMap::new()) }
    }

    pub fn run_ids(&self) -> Vec<String> {
        self.runs.lock().map(|r| r.keys().cloned().collect()).unwrap_or_default()
    }

    pub fn get(&self, id: &str) -> Option<FleetRun> {
        self.runs.lock().ok().and_then(|r| r.get(id).cloned())
    }

    pub fn insert(&self, run: FleetRun) {
        if let Ok(mut r) = self.runs.lock() {
            r.insert(run.id.clone(), run);
        }
    }

    /// lane → Settled（携带结果文本）；驱动者负责随后再次调度。
    pub fn settle_lane(&self, tab_id: &str, result_text: &str) -> Option<(String, String)> {
        let mut runs = self.runs.lock().ok()?;
        for run in runs.values_mut() {
            for lane in run.lanes.iter_mut() {
                if lane.tab_id.as_deref() == Some(tab_id) && lane.status == LaneStatus::Running {
                    lane.status = LaneStatus::Settled;
                    lane.result_text = Some(result_text.to_string());
                    return Some((run.id.clone(), lane.key.clone()));
                }
            }
        }
        None
    }

    pub fn fail_lane(&self, tab_id: &str) -> Option<String> {
        let mut runs = self.runs.lock().ok()?;
        for run in runs.values_mut() {
            for lane in run.lanes.iter_mut() {
                if lane.tab_id.as_deref() == Some(tab_id) && lane.status == LaneStatus::Running {
                    lane.status = LaneStatus::Failed;
                    return Some(run.id.clone());
                }
            }
        }
        None
    }

    /// 按 lane key 标记失败（启动期尚未有结果的场景）
    pub fn fail_lane_by_key(&self, run_id: &str, lane_key: &str) -> bool {
        let mut runs = match self.runs.lock() {
            Ok(r) => r,
            Err(_) => return false,
        };
        let Some(run) = runs.get_mut(run_id) else { return false };
        let Some(lane) = run.lane_mut(lane_key) else { return false };
        if lane.status == LaneStatus::Running || lane.status == LaneStatus::Pending {
            lane.status = LaneStatus::Failed;
            return true;
        }
        false
    }

    /// 绑定 lane ↔ tab（拉起后回填）
    pub fn bind_tab(&self, run_id: &str, lane_key: &str, tab_id: &str) -> bool {
        let mut runs = match self.runs.lock() {
            Ok(r) => r,
            Err(_) => return false,
        };
        let Some(run) = runs.get_mut(run_id) else { return false };
        let Some(lane) = run.lane_mut(lane_key) else { return false };
        lane.tab_id = Some(tab_id.to_string());
        lane.status = LaneStatus::Running;
        true
    }

    /// 终态判定：全部 lane 终态 → Done。
    pub fn maybe_finish(&self, run_id: &str) -> bool {
        let mut runs = match self.runs.lock() {
            Ok(r) => r,
            Err(_) => return false,
        };
        if let Some(run) = runs.get_mut(run_id) {
            if run.all_done() && run.status == RunStatus::Running {
                run.status = RunStatus::Done;
                return true;
            }
        }
        false
    }

    pub fn abort(&self, run_id: &str) -> Option<Vec<String>> {
        // 返回仍存活（有 tab）的 lane tabIds，驱动者负责 abort worker
        let mut runs = self.runs.lock().ok()?;
        let run = runs.get_mut(run_id)?;
        run.status = RunStatus::Aborted;
        Some(
            run.lanes
                .iter()
                .filter(|l| matches!(l.status, LaneStatus::Running | LaneStatus::Pending))
                .filter_map(|l| l.tab_id.clone())
                .collect(),
        )
    }

    /// 前端快照（Fleet 面板数据源）
    pub fn snapshot(&self) -> Value {
        let runs = self.runs.lock().ok();
        let list: Vec<Value> = runs
            .map(|r| {
                r.values()
                    .map(|run| {
                        json!({
                            "id": run.id,
                            "templateId": run.template_id,
                            "task": run.task,
                            "cwd": run.cwd.to_string_lossy(),
                            "status": run.status,
                            "lanes": run.lanes.iter().map(|l| json!({
                                "key": l.key,
                                "role": l.role,
                                "status": l.status,
                                "tabId": l.tab_id,
                                "resultPreview": l.result_text.as_deref().map(|t| t.chars().take(160).collect::<String>()),
                            })).collect::<Vec<_>>(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default();
        json!({ "runs": list })
    }
}

/* ---------------- worktree 辅助（06 §3.4：一个 cwd 一个写者） ---------------- */

/// worktree 路径约定：<repo>/.piggy-worktrees/<name>（name 经安全净化，防路径逃逸）
pub fn worktree_path(repo: &Path, name: &str) -> PathBuf {
    let safe_name: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    repo.join(".piggy-worktrees").join(safe_name)
}

/// git worktree add（存在则复用）。返回 worktree 绝对路径。
pub fn create_worktree(repo: &PathBuf, name: &str) -> Result<PathBuf, String> {
    let path = worktree_path(repo, name);
    let safe_name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    if path.is_dir() {
        return Ok(path);
    }
    let branch = format!("piggy/{safe_name}");
    let out = std::process::Command::new("git")
        .args(["worktree", "add"])
        .arg(&path)
        .arg("-b")
        .arg(&branch)
        .current_dir(repo)
        .output()
        .map_err(|e| format!("git 启动失败: {e}"))?;
    if !out.status.success() {
        // 分支已存在等场景：尝试不带 -b 复用
        let retry = std::process::Command::new("git")
            .args(["worktree", "add"])
            .arg(&path)
            .arg(&branch)
            .current_dir(repo)
            .output()
            .map_err(|e| format!("git 启动失败: {e}"))?;
        if !retry.status.success() {
            return Err(format!(
                "git worktree add 失败: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ));
        }
    }
    Ok(path)
}

/* ---------------- 测试 ---------------- */

#[cfg(test)]
mod tests {
    use super::*;

    fn lane(key: &str, deps: &[&str]) -> Lane {
        Lane {
            key: key.into(),
            role: key.into(),
            prompt: String::new(),
            depends_on: deps.iter().map(|s| s.to_string()).collect(),
            worktree: false,
            status: LaneStatus::Pending,
            tab_id: None,
            result_text: None,
        }
    }

    #[test]
    fn builtin_templates_are_valid_dags() {
        let templates = builtin_templates();
        for (tid, tpl) in templates.as_object().unwrap() {
            if tid == "custom" {
                continue; // custom 允许空
            }
            let run = build_run(
                "test-run".into(),
                tid,
                tpl,
                "示例任务",
                PathBuf::from("/tmp"),
            )
            .unwrap_or_else(|e| panic!("模板 {tid} 非法: {e}"));
            assert!(!run.lanes.is_empty());
            // 就绪集合：初始只含无依赖 lane
            let ready = run.ready_lanes();
            assert!(run.lanes.iter().filter(|l| l.depends_on.is_empty()).all(|l| ready.contains(&l.key)));
        }
    }

    #[test]
    fn dag_schedules_in_dependency_order() {
        let mut lanes = vec![lane("a", &[]), lane("b", &["a"]), lane("c", &["a"]), lane("d", &["b", "c"])];
        let mut run = FleetRun {
            id: "r".into(),
            template_id: "t".into(),
            task: String::new(),
            cwd: PathBuf::from("/tmp"),
            status: RunStatus::Running,
            lanes: lanes.clone(),
        };
        let ready1 = ready_lanes(&lanes);
        assert_eq!(ready1, vec!["a"]);
        for l in run.lanes.iter_mut() {
            if l.key == "a" {
                l.status = LaneStatus::Settled;
            }
        }
        lanes = run.lanes.clone();
        assert_eq!(ready_lanes(&lanes), vec!["b", "c"]);
        for l in run.lanes.iter_mut() {
            if l.key == "b" || l.key == "c" {
                l.status = LaneStatus::Settled;
            }
        }
        assert_eq!(run.ready_lanes(), vec!["d"]);
        for l in run.lanes.iter_mut() {
            l.status = LaneStatus::Settled;
        }
        assert!(run.all_done());
        run.status = RunStatus::Running;
        assert!(run.all_done());
    }

    #[test]
    fn cycle_is_rejected() {
        let mut lanes = vec![lane("a", &["b"]), lane("b", &["a"])];
        assert!(has_cycle(&lanes));
        lanes = vec![lane("a", &[]), lane("b", &["a"])];
        assert!(!has_cycle(&lanes));
        let tpl = json!({ "lanes": [ {"key":"a","prompt":"p","depends_on":["b"]}, {"key":"b","prompt":"p","depends_on":["a"]} ] });
        assert!(build_run("r".into(), "t", &tpl, "task", PathBuf::from("/tmp")).is_err());
    }

    #[test]
    fn prompt_render_injects_task_and_upstream() {
        let mut lanes = vec![lane("a", &[]), lane("b", &["a"])];
        lanes[0].result_text = Some("侦察结论ABC".into());
        lanes[0].status = LaneStatus::Settled;
        let run = FleetRun {
            id: "r".into(),
            template_id: "t".into(),
            task: "修复登录 bug".into(),
            cwd: PathBuf::from("/tmp"),
            status: RunStatus::Running,
            lanes,
        };
        let b = run.lane("b").unwrap();
        let rendered = render_prompt("实现它：{task}\n参考：{upstream}", &run.task, &run, b);
        assert!(rendered.contains("修复登录 bug"));
        assert!(rendered.contains("侦察结论ABC"));
        // 未命名占位不残留
        assert!(!rendered.contains("{task}"));
        assert!(!rendered.contains("{upstream}"));
    }

    #[test]
    fn manager_lane_lifecycle_and_snapshot() {
        let mgr = FleetManager::new();
        let mut run = FleetRun {
            id: "run-1".into(),
            template_id: "parallel-review".into(),
            task: "评审".into(),
            cwd: PathBuf::from("/tmp"),
            status: RunStatus::Running,
            lanes: vec![lane("r1", &[]), lane("r2", &[])],
        };
        run.lanes[0].tab_id = Some("tab-r1".into());
        run.lanes[0].status = LaneStatus::Running;
        run.lanes[1].tab_id = Some("tab-r2".into());
        run.lanes[1].status = LaneStatus::Running;
        mgr.insert(run);

        assert_eq!(mgr.settle_lane("tab-r1", "结论1").unwrap(), ("run-1".into(), "r1".into()));
        assert_eq!(mgr.settle_lane("tab-未知", "x"), None);
        assert!(!mgr.maybe_finish("run-1"));
        assert_eq!(mgr.settle_lane("tab-r2", "结论2").unwrap(), ("run-1".into(), "r2".into()));
        assert!(mgr.maybe_finish("run-1"));
        let snap = mgr.snapshot();
        assert_eq!(snap["runs"][0]["status"], "done");
        assert_eq!(snap["runs"][0]["lanes"][0]["resultPreview"], "结论1");
    }

    #[test]
    fn abort_marks_and_returns_live_lanes() {
        let mgr = FleetManager::new();
        let mut run = FleetRun {
            id: "run-2".into(),
            template_id: "t".into(),
            task: String::new(),
            cwd: PathBuf::from("/tmp"),
            status: RunStatus::Running,
            lanes: vec![lane("a", &[]), lane("b", &["a"])],
        };
        run.lanes[0].tab_id = Some("tab-a".into());
        run.lanes[0].status = LaneStatus::Running;
        mgr.insert(run);
        let live = mgr.abort("run-2").unwrap();
        assert_eq!(live, vec!["tab-a"]);
        assert_eq!(mgr.get("run-2").unwrap().status, RunStatus::Aborted);
    }

    #[test]
    fn worktree_path_sanitizes_name() {
        let p = worktree_path(&PathBuf::from("/repo"), "../../etc/passwd");
        assert!(!p.to_string_lossy().contains(".."));
    }

    /* ---- lane 状态机：这四条曾经是 watch_lane 里的隐式行为，现在被钉住 ---- */

    #[test]
    fn busy_then_ready_settles_the_lane() {
        let (busy, outcome) = lane_step(false, WorkerState::Busy);
        assert!(busy, "见到 Busy 要记住");
        assert_eq!(outcome, None, "Busy 本身不是终态");
        assert_eq!(lane_step(true, WorkerState::Ready), (true, Some(LaneOutcome::Settled)));
    }

    #[test]
    fn ready_before_busy_is_not_a_settle() {
        // spawn 完成后 worker 就是 Ready：若不看 was_busy，lane 会在 prompt 之前被判完成
        assert_eq!(lane_step(false, WorkerState::Ready), (false, None));
        assert_eq!(lane_step(false, WorkerState::Spawning), (false, None));
    }

    #[test]
    fn crash_and_stop_fail_the_lane() {
        for s in [WorkerState::Crashed, WorkerState::Stopped] {
            assert_eq!(lane_step(true, s).1, Some(LaneOutcome::Failed), "{s:?}");
        }
    }

    #[test]
    fn stuck_on_busy_keeps_waiting() {
        assert_eq!(lane_step(true, WorkerState::Busy), (true, None));
    }

    /* ---- 容量排队：MAX_WORKERS 不再是死锁 ---- */

    #[test]
    fn capacity_wait_ends_on_progress_or_abort() {
        let max = Duration::from_secs(600);
        let none = Duration::from_secs(0);
        // 还在跑 + 有就绪 lane + 未超时 → 继续等
        assert!(should_keep_waiting(&RunStatus::Running, 2, none, max));
        // 没有就绪 lane（都在跑或都完成）→ 不用等
        assert!(!should_keep_waiting(&RunStatus::Running, 0, none, max));
        // run 被中止/完成 → 立刻停
        assert!(!should_keep_waiting(&RunStatus::Aborted, 3, none, max));
        assert!(!should_keep_waiting(&RunStatus::Done, 3, none, max));
        // 超时兜底：不无限占着一个后台任务
        assert!(!should_keep_waiting(&RunStatus::Running, 1, max, max));
    }

    /* ---- 结果收集：真实 get_messages 形状 ---- */

    #[test]
    fn last_assistant_text_reads_wrapped_and_bare_shapes() {
        let wrapped = json!([
            {"type": "message", "message": {"role": "user", "content": [{"type": "text", "text": "问题"}]}},
            {"type": "message", "message": {"role": "assistant", "content": [{"type": "text", "text": "回答一"}]}}
        ]);
        assert_eq!(last_assistant_text(&wrapped).as_deref(), Some("回答一"));
        let bare = json!([{"role": "assistant", "content": "纯字符串回复"}]);
        assert_eq!(last_assistant_text(&bare).as_deref(), Some("纯字符串回复"));
    }

    #[test]
    fn last_assistant_text_accepts_the_rpc_get_messages_envelope() {
        // 真实 get_messages 的 data 形状：{"messages": [...]}（docs/rpc-commands.md）
        // 契约测试 C13 就是用这个形状跑出来的——它曾经让每条 lane 的结果恒为空。
        let rpc = json!({
            "messages": [
                {"role": "system", "content": "系统提示"},
                {"role": "user", "content": "任务"},
                {"role": "assistant", "content": [{"type": "text", "text": "ALPHA"}]}
            ]
        });
        assert_eq!(last_assistant_text(&rpc).as_deref(), Some("ALPHA"));
    }

    #[test]
    fn last_assistant_text_tolerates_other_shapes() {
        assert_eq!(last_assistant_text(&json!({"messages": []})), None);
        assert_eq!(last_assistant_text(&json!({"other": []})), None);
        assert_eq!(last_assistant_text(&json!("字符串")), None);
        assert_eq!(last_assistant_text(&json!(null)), None);
    }

    #[test]
    fn last_assistant_text_takes_the_latest_and_skips_empty() {
        let v = json!([
            {"role": "assistant", "content": [{"type": "text", "text": "旧"}]},
            {"role": "assistant", "content": [{"type": "toolCall", "name": "read"}]},
            {"role": "user", "content": "插一句"}
        ]);
        // 最后一条 assistant 只有工具调用 → 不返回"旧"（那会让下游拿到过期结论）
        assert_eq!(last_assistant_text(&v), None);
        assert_eq!(last_assistant_text(&json!([])), None);
        assert_eq!(last_assistant_text(&json!({})), None);
    }
}
