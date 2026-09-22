# 06 · 子代理设计（Fleet 编排与 pi-subagents 桥接）

> 上游：[01-architecture.md](01-architecture.md)、[02-pi-rpc-integration.md](02-pi-rpc-integration.md) · 下游：[03-module-design.md](03-module-design.md) §2.11

## 0. 设计立场

"子代理"在 Piggy 中有**两个不同的真实所指**，必须分开设计、分开呈现，不能混为一谈：

| 层 | 定义 | 谁是监督者 | 机制 |
|---|---|---|---|
| **A. 宿主 Fleet** | Piggy 自己编排的多个 pi 会话工作进程（并行任务、角色模板） | Piggy（Rust `fleet/`） | 纯 RPC：spawn 多 worker + `prompt`/`steer`/`abort`/结果收集 |
| **B. pi-subagents 桥接** | 用户会话**内部**由 [pi-subagents](https://github.com/nicobailon/pi-subagents) 扩展派生的子代理（模型调用 `subagent` 工具） | pi 进程内的扩展 | piggy-bridge 扩展 + pi-subagents 的 in-process event-bus RPC v1 |

用户价值互补：A 层给用户**直接驱动**的并行编排（不经模型决策）；B 层让**模型自主委派**的子代理在 GUI 中可见、可控。两者共用同一个 Fleet 面板 UI，但数据源与控制通道不同。

## 1. 为什么 A 层不基于 pi-subagents 实现

1. pi-subagents 的 `subagent` 工具是**模型工具**：由模型决定是否/如何调用；Piggy 需要**用户直接驱动**的并行（用户点按钮就开三条 lane），绕过模型决策没有协议通道；
2. A 层只需要 RPC 已有能力（prompt/steer/abort/get_last_assistant_text/agent_settled），零扩展依赖，零版本耦合；
3. 失败域隔离：A 层编排崩溃不影响用户会话内已安装的任何扩展。

## 2. 为什么 B 层不重造子代理运行时

pi-subagents 已解决：子代理定义（agents/*.md）、worktree 隔离、workflows、async runner、watchdog、mission、steer/interrupt/resume 语义。重造 = 与生态为敌。它的官方集成缝（`docs/extension-api.md`）提供了恰好够用的桥面：**in-process event-bus RPC v1**——任何 pi 扩展都可以监听 `subagents:rpc:v1:ready`、经 `subagents:rpc:v1:request/reply:<id>` 调用 `ping/status/manage/spawn/steer/interrupt/stop/resume`。piggy-bridge 就是一个使用该缝的普通扩展。

## 3. A 层：宿主 Fleet 编排

### 3.1 概念模型

```
FleetRun（一次编排任务）
 ├─ template: 模板（内置/用户自定义）
 ├─ lanes[]:  Lane = { key, role, prompt, model?, thinking?, worktree? }
 │    每个 lane 绑定一个 worker（复用 01 §2.3 全套生命周期）
 └─ 状态机: Draft → Running → Settled(collect) → Done | Aborted
```

### 3.2 内置模板（首发）

| 模板 | lanes | 用途 |
|---|---|---|
| `scout-review-build` | scout(只读工具) → review(只读) + build(读写) → review 验证 | 常规特性开发 |
| `parallel-review` | N × reviewer（不同关注点：正确性/测试/复杂度） | 代码评审 |
| `research` | N × researcher（web 工具） + 1 × synthesizer | 调研汇总 |
| `custom` | 用户自由编排 | — |

角色 = 初始 prompt 模板（含工具限制说明）+ 建议 `--provider/--model`（如 scout 走快模型）+ thinking 建议。模板是纯数据（JSON，放 Piggy 配置），用户可编辑。

### 3.3 控制流（全部映射到 02 §3.2 命令）

| 操作 | 实现 |
|---|---|
| 启动 lane | `registry` 申请 worker（spawn cwd=项目；`--no-session` 或独立会话目录 `fleet/` 前缀【`--session-dir` 指向 `~/.pi/agent/sessions` 子目录，避免污染项目会话列表】）→ `prompt(role+task)` |
| 追加指令 | `steer`（或流式外 `follow_up`） |
| 中断 | `clear_queue` + `abort` |
| 进度 | 订阅该 worker 全套事件（与普通 tab 同管线，Fleet 面板呈现摘要视图） |
| 结果 | `agent_settled` 后 `get_last_assistant_text`（+ 最终 `get_session_stats` 成本） |
| 顺序依赖 | 模板声明 lane 依赖边（DAG）；Rust 侧调度（lane settle 后触发下游） |
| 汇总 | 可选开一条 synthesizer lane，输入 = 各 lane 结果文本（用户确认后发送） |

### 3.4 资源与安全

- lane worker 计入 `maxWorkers`（05 §4.2）；DAG 调度器在资源不足时排队而非溢出；
- **写冲突防护**：模板中允许多 lane 声明写权限时，Piggy 强制提示"同 cwd 多写者风险"，建议每条 mutation lane 独立 git worktree（与 pi-subagents 的 lane 实践一致：一个 cwd 一个写者）。M3 提供"创建 worktree"辅助（Rust 调 git），lane prompt 注入 worktree 路径；
- lane 的 bash/审批类弹窗（若装了相关扩展）正常经 Extension UI 通道弹出（02 §8），Fleet 运行时无人值守可开启"Fleet 弹窗自动转交主会话确认"选项。

### 3.5 与普通标签页的关系

lane worker 可以"提升为标签页"（在主窗口获得完整转录视图）——registry 中 tab 与 lane 共用 WorkerHandle 抽象，只是 UI 挂载不同。反向：任何 tab 也能"收编进 Fleet 视图"。

## 4. B 层：piggy-bridge 扩展桥接 pi-subagents

### 4.1 形态

- npm 包 `piggy-bridge`（TS，pi 扩展规范），用户 `pi install npm:piggy-bridge`（或 GUI 设置页一键检测/引导安装）；
- 加载即注册 `/piggy:*` 扩展命令并监听 pi-subagents 的 `subagents:rpc:v1:ready`。

### 4.2 通道设计（只用文档化能力，02 §8 约束内）

**关键约束**：RPC 模式的 extension 能力 = Extension UI 子协议（dialog + fire-and-forget）+ 扩展命令（经 `prompt` 即时执行）。**RPC stdout 不转发任意自定义扩展事件**（02 §4.1 事件表是封闭集合）。因此桥接通道如下：

| 方向 | 机制 | 说明 |
|---|---|---|
| GUI → bridge（请求） | `prompt` 发送 `/piggy:<verb> [argsJson]` | 协议保证扩展命令**流式中也立即执行**（02 §7.2），完美匹配"运行中查询舰队状态" |
| bridge → GUI（应答/数据） | `ctx.ui.set_editor_text`（结构化 JSON 载荷）+ `ctx.ui.notify`（人读摘要） | fire-and-forget，无需用户可见编辑器——载荷约定为 `PIGGY:1:<json>` 前缀，前端拦截解析；`set_editor_text` 语义 = 写用户输入框，Piggy 前端将其劫持为数据通道，不落到真实草稿 |
| bridge → GUI（持续状态） | `ctx.ui.setWidget`（舰队状态行） | 直接落右栏 Widget 区（02 §8），人读 |
| bridge → GUI（需确认） | `ctx.ui.confirm/select` | 正常弹窗 |

> 为什么不用 `pi.sendMessage`（把数据写进会话）？会污染对话上下文、计费 token。`set_editor_text` 劫持是显式声明的数据面，双向都有版本前缀，易演化。该选择属于 Piggy 与自家扩展的私有约定（两端同仓发布，无第三方兼容负担）。

### 4.3 桥接动词（`/piggy:` 命令集）

| 命令 | 转发到 subagents RPC v1 | 说明 |
|---|---|---|
| `/piggy:status` | `status` | 全舰队快照（runs/lanes/状态/成本）→ JSON 载荷回传 |
| `/piggy:steer <runId> <index?> <msg>` | `steer` | 转向（回执含 `deliveryStatus`） |
| `/piggy:interrupt <runId>` | `interrupt` / `stop` | 中断/停止 |
| `/piggy:resume <runId> <msg>` | `resume` | 续跑 |
| `/piggy:fleet-refresh` | `manage`（查询类 action） | 刷新（供轮询替代：状态变化时 bridge 主动 setWidget） |

bridge 内部对 v1 做 `ping` 能力协商（`nonRecoveringSteer` 等能力位），未安装 pi-subagents 时 `/piggy:*` 返回明确的"未安装"提示。

### 4.4 B 层在 UI 的呈现

- 会话内模型调用 `subagent` 工具 → 转录里就是普通 ToolCard（参数含 agent/task，执行期长，卡片显示运行中，结果落地 `tool_execution_end`）——**无需 bridge 也可用**；
- 安装 bridge 后：右栏 Widget 区实时舰队行（setWidget）、Fleet 面板出现"会话内子代理"分组（status 快照渲染）、每条可 steer/interrupt（面板按钮 → `/piggy:verb` → bridge → v1 RPC）。

### 4.5 安全与尊重边界

- bridge 不代用户批准任何 `confirm`；Fleet 面板的操作按钮仅覆盖文档化动词；
- 不抓取/解析 pi-subagents 内部模块（官方缝之外的一切视为私有 API，禁用——升级兼容性的前提）。

## 5. 呈现统一：Fleet 面板

```
Fleet 面板
 ├─ [宿主编排] Runs（A 层）：模板卡片、lane 进度、成本、steer/abort
 └─ [会话内] ×N 会话（B 层）：每会话的子代理快照（来自 /piggy:status）
      └─ lane 行：agent · 状态 · elapsed · tokens/cost · [steer] [stop]
```

两层数据源不同（A：Rust 事件流；B：bridge 查询/推送），但视图模型统一（`fleetStore`），交互动词语义对齐（steer/interrupt 在两层同按钮）。GUI 驻留位置：左侧栏 "Fleet" 视图（导航入口）+ 右侧栏 "子代理" 视图（跟随活动会话上下文，04 §1.4）+ 可展开的工具 tab 大图（04 §1.6）。

## 6. 演进

- M3 后评估：pi-subagents 若官方暴露 stdout 事件或 RPC 命令直连（如 fleet 查询命令），piggy-bridge 的数据面可整体替换为官方通道，UI 不变；
- A 层模板市场：模板即 JSON，社区分发（pi packages 或 Piggy 自有格式）。
