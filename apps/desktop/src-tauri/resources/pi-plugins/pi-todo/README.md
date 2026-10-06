# pi-todo

一个 pi 扩展：把 **DSH 的 `todo_write` 任务清单**搬到 pi，并补上 DSH 没有的两件事 ——
**复杂度闸门**与**主动激活**。

```text
默认：模型只看得见 todo_enable 一个工具
  ├─ 多步活儿 → 调 todo_enable → 下一轮起 todo_write 可用 → 每次提交整份清单
  ├─ 干的活够多（默认 5 次工具调用）→ 插件**主动**激活，并提醒模型去写清单
  └─ 复杂度闸门：**默认关闭**。打开后才会有"清单太短就拒"这条（见下）
```

Piggy（本仓的桌面 GUI）会探测这个插件：**探测到且已启用**才显示任务清单界面
（转录里的清单行 + 输入框上方的计划面板）。

## 安装

```bash
# 方式一：软链进 pi 的发现目录（支持 /reload 热更新，推荐开发用）
ln -s /Users/wxk/Documents/Project/pi-todo ~/.pi/agent/extensions/pi-todo

# 方式二：显式加载
pi -e /path/to/pi-todo/index.ts

# 方式三：当包装
pi install /Users/wxk/Documents/Project/pi-todo
```

装完在 pi 里敲 `/todos` 能看到当前清单与激活状态。

## 模型看到什么

| 工具 | 常驻？ | 什么时候用 |
|---|---|---|
| `todo_enable` | 是 | 判断"这活儿是多步"时调用它（一次调用即激活） |
| `todo_write` | **默认潜伏** | 激活后可用；每次提交**完整**清单，整表替换 |

`todo_write` 的 description 是 DSH 原文的搬运
（`packages/todo/tool-todo/src/index.ts:45-78`，连"并行/单活跃决定哪一段"都一样），
只在结尾多了一段**闸门说明** —— DSH 没有闸门所以不用说，我们有，模型必须知道
"可能被拒以及为什么"。

### 清单的形状（与 DSH 逐字一致）

```jsonc
{ "todos": [ { "content": "写迁移脚本", "status": "in_progress" } ] }
```

* `status`：`pending` / `in_progress` / `completed`，三态，没有别的字段
  （DSH `src/types.ts:14-24`：整表替换下条目不需要 id/priority）；
* **每次都要发整份清单**，没有局部更新、没有按条编辑；
* 成功回执逐字为 `Updated todo list: 3 pending, 1 in progress, 0 completed.`
  （DSH `src/index.ts:200`）；
* 失败文案也与 DSH 逐字一致：空内容 / 重复内容 / 超过一条 `in_progress`
  （`src/index.ts:98-108`），外加本仓的条数上限防呆。

## 复杂度闸门（本仓独有，**默认关闭**）

> **默认关闭**（2026-09-29 用户裁定）：闸门是启发式，"措辞短但实际多步"的请求会被低估，
> 而默认拦人比默认放行更烦人。**Piggy 里默认就不会被拦**（Piggy 不传任何 pi-todo 配置，
> 插件的默认值说了算）。想打开就三条通道任选：配置文件 `"enforceComplexity": true`、
> 环境变量 `PI_TODO_ENFORCE_COMPLEXITY=1`、或 `pi --todo-enforce`（**只影响那一次调用** ——
> 终端里想试就试，Piggy 不受影响）。

打开之后，它做的事情如下。DSH 对"什么时候该用清单"只有描述里的一句话 —— `Skip the list
for trivial single-step tasks.`（`src/index.ts:64`），**代码里没有任何判定**（`execute`
只校验 `exec.agent` 与 `in_progress` 条数，见 `:203-220`）。本插件把这句话变成**可观测、
可复现、可解释**的判定：

| 证据 | 来源 | 说明 |
|---|---|---|
| `prompt` | `before_agent_start` 的 `event.prompt` | 这一轮用户的原始请求 |
| `turnToolCalls` | `tool_execution_end` 计数 | 本轮（agent run）已真实执行完的工具调用数 |
| `items` | 模型提交的清单 | 只在 `todo_write` 时有值 |

打分量出四个信号（`src/complexity.ts` 的 `promptSignals`）：枚举行 ≥3（+2）、
句子 ≥2（+2 若 ≥4）、流程连接词 ≥2（+2 若 ≥3）、长度 ≥240（+2 若 ≥600），
上限 8 分。闸门规则：

```text
todo_enable（激活）：explicit ‖ score ≥ 3 ‖ turnToolCalls ≥ 3
todo_write（写入）：items ≥ 2  且  ( items ≥ 3 ‖ explicit ‖ score ≥ 2 ‖ turnToolCalls ≥ 2 )
```

读法：**清单自己有 3 条以上就自证多步**（最常见、也最该放行的路径）；两条时要旁证；
一条直接拒（一条不是计划）。用户**明确要求**清单（"用 todo 跟一下"）时一律放行 ——
人的明确要求压过任何启发式，这是唯一的"人工越权通道"。

拒绝时抛错（pi 的失败工具结果），文案把差在哪摊开，例如：

```text
pi-todo: todo_write refused — this task does not look multi-step enough yet.
Why: prompt score 0/8 (sentences 1, connectives 0, enumerated 0, chars 12).
Missing: prompt score ≥ 2 (got 0); 2 tool calls in this request (got 0).
Todos are for work with several concrete steps. Either do this task directly without a
todo list, or wait until the request shows more steps / more work has already happened.
```

**诚实的边界**：这是启发式。"把这个迁移到 v2"这种措辞简短、实际十步的请求会被低估
—— 这正是它**默认关闭**的原因。打开后仍有旁证通道（跑几次工具后 `turnToolCalls` 上来）
与人工越权通道（用户明说要清单）。真机两跑的证据见下面「验证」。

## 主动激活（"像 subagents 一样"）

pi 从 **0.86.1** 起提供动态工具激活：`getAllTools` / `getActiveTools` / `setActiveTools`。
`pi-subagents` 用它做了加载器工具（`subagents_enable` → `subagent`），本插件照搬这个形状，
两条激活路径：

1. **模型主动**：调 `todo_enable`（带闸门）；
2. **插件主动**：本轮工具调用累计到 `proactiveAfterToolCalls`（默认 5）且闸门放行时，
   自动激活并 `sendMessage(..., { deliverAs: "steer" })` 提醒一次（每轮最多一次）。

激活状态落在**会话条目** `pi-todo/state` 里，`session_start` / `session_tree` 时
从活动分支重建 —— fork / 回退之后状态与历史一致（不依赖 pi 的内部投影 API）。

**宿主太老怎么办**：没有那三个 API 时**不静默降级** —— 打一条明确的警告，
`todo_write` 保持常驻，闸门仍在 `execute` 里生效（约束不消失，只是从"工具表里没有"
退化成"调了会被拒"）。

## 配置

优先级：**默认值 → 配置文件 → 环境变量 → 命令行 flag**。

配置文件 `<agentDir>/pi-todo.json`（`agentDir` = `$PI_CODING_AGENT_DIR` 或 `~/.pi/agent`）：

```jsonc
{
  "piTodo": {
    "allowParallelInProgress": true,   // 允许多条同时 in_progress（DSH 同名配置；本仓默认 false）
    "proactiveActivation": false,      // 关掉主动激活
    "enforceComplexity": true,         // 打开复杂度闸门（默认关闭）
    "minPlanItems": 3,                 // 少于这么多条时要求旁证
    "proactiveAfterToolCalls": 5
  }
}
```

环境变量是**机械命名**：`allowParallelInProgress` → `PI_TODO_ALLOW_PARALLEL_IN_PROGRESS`；
布尔认 `1/true/yes/on` 与 `0/false/no/off`。拼错的 `PI_TODO_*` 会被点名（不静默忽略）。

命令行：`--todo-parallel`、`--todo-no-proactive`、`--todo-enforce`（**显式打开**闸门，只管这一次运行）。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（false = 两个工具都不注册） |
| `allowParallelInProgress` | `false` | 允许多条 `in_progress` |
| `enforceComplexity` | **`false`** | 是否执行复杂度闸门（要拦就显式打开） |
| `minPlanItems` | `3` | 清单"自证多步"的条数 |
| `enableMinScore` / `enableMinToolCalls` | `3` / `3` | 激活门槛 |
| `writeMinScore` / `smallPlanToolCalls` | `2` / `2` | 短清单的旁证门槛 |
| `rejectNoopWrites` | `true` | 拒绝与上一份完全相同的写入（省 token） |
| `maxItems` | `30` | 单份清单条数上限 |
| `proactiveActivation` / `proactiveAfterToolCalls` | `true` / `5` | 主动激活 |
| `promptGuidance` | `true` | 是否把用法写进系统提示词 |
| `debug` | `false` | stderr 调试日志 |

**配置有问题会吵**：未知键、类型不对、越界数字都会打到 stderr 并**回落到默认值**
（该字段），不让一个拼错的键静默失效。

## 验证（都是真跑出来的，不是"应该没问题"）

```bash
npm install && npm run link   # link 把本机 pi 的类型软链进来（见 scripts/link-dev-deps.mjs）

# 四条门禁，前三条不需要凭据、不联网、不花 token
npm run check            # tsc --noEmit
npm test                 # 60 条用例（mock ExtensionAPI）
npm run verify-load      # 走 pi 自己的 loader 装载本扩展
npm run verify-runtime   # 真起一个 pi --mode rpc 进程，确认 /todos 被注册
npm run verify           # 上面四条串起来跑

npm run verify-live      # 需要本机配好模型：真模型两跑（会产生少量 token 费用）
```

* `npm test`：mock ExtensionAPI 驱动真实事件序列，60 条用例（闸门表、潜伏、主动激活、
  分支重建、降级、配置）；
* `npm run verify-load`：走 **pi 自己的加载器**（`discoverAndLoadExtensions`）装载本扩展，
  断言两个工具注册成功、schema 是对象根、四个事件钩子与 `/todos` 都在；**并断言出厂默认
  （闸门关闭）下两份工具描述都不提"会被拒"** —— 模型看到什么由描述决定，默认值改了而描述
  没改，模型就会按一句假话做决定（本机若配了 `PI_TODO_*` / `pi-todo.json`，这条会跳过并说明）；
* `npm run verify-runtime`：真起一个 `pi --mode rpc` 子进程（临时工作目录 + 临时会话目录），
  问它的命令表里有没有 `todos` —— 证明扩展从 `~/.pi/agent/extensions/` 被**真的发现并加载**
  （`sourceInfo.path` 就是那个软链路径）；
* `npm run verify-live`：真模型两跑 ——
  - 「该激活的」：模型调 `todo_enable` → `todo_write`（4 次，逐步完成），会话里留下
    `pi-todo/state` + 4 条 `todo/write`；
  - 「不该激活的」：单步任务下 `todo_enable` 被**真拒**，模型如实汇报
    （实测文案：`prompt score 1/8 … Missing: prompt score ≥ 3 (got 1); 3 tool calls in this request (got 0)`）。

红检（把实现故意改坏，门禁必须变红）：拿掉潜伏 → 5 条红；拿掉闸门 → 8 条红；
拿掉空操作检测 → 1 条红；拿掉主动激活 → 3 条红；**把闸门默认值改回开 → 2 条红；
忽略 `--todo-enforce` → 6 条红；忽略配置文件 → 2 条红**。

## 与 DSH 的差异（一处不落地写清楚）

| 项 | DSH | 本插件 | 为什么 |
|---|---|---|---|
| 复杂度闸门 | **没有**（只有描述里一句话） | 有（打分 + 阈值），**默认关闭、可显式打开** | 用户要求过这条约束，后来裁定"默认别拦人" |
| 工具可见性 | 无条件注册即可见 | `todo_write` 默认潜伏，`todo_enable` 常驻 | 用户要求"像 subagents 一样主动激活" |
| 主动激活 | 没有 | 有（本轮工具调用数触发 + steer 提醒） | 同上 |
| `allowParallelInProgress` | 必填、无默认 | 默认 `false` | 插件没有"部署时强制二选一"的位置，取更保守的一侧 |
| 条数上限 | 无 | `maxItems`（默认 30） | 防呆：整表替换下 200 条会烧掉大量 token |
| 空操作写入 | 放行（UI 只标"没有变化"） | 默认拒 | 整表替换下重发同一份只花 token |
| 状态存放 | 会话事件 `todo/write` + 投影单元 | 同名条目 `todo/write` + 本扩展内存 | 条目名相同，Piggy 的投影逻辑才能与 DSH 逐行对照 |
| 单活跃纪律 | 由配置决定 | 同 | — |

## 已知限制

* 闸门是**启发式**：措辞简短的多步请求会被低估（有旁证通道与人工越权通道兜底）；
* 动态激活要求 **pi ≥ 0.86.1**；更老的宿主会退化成"常驻工具 + 执行期拒绝"（会警告）；
* 清单属于**一个会话**：子代理各自一份，插件之间不共享（与 DSH 的 single-owner 一致）；
* `todo_write` 的执行模式是 `sequential`（整表替换的语义在并发下没有意义）。

## 开发

```bash
npm run link     # 每次 npm install 之后跑一次（pi 不进 dependencies，见脚本注释）
npm run check    # tsc --noEmit
npm test         # 60 条用例
```

代码地图：

| 文件 | 角色 |
|---|---|
| `index.ts` | 入口：flag / 工具注册 / 事件接线 / `/todos` |
| `src/model.ts` | 清单模型与校验（DSH 逐字对照） |
| `src/complexity.ts` | 复杂度闸门（打分、两个判定、拒绝文案） |
| `src/config.ts` | 配置解析（文件/环境/flag，未知即拒绝） |
| `src/state.ts` | 会话状态与分支重建（`pi-todo/state`、`todo/write`） |
| `src/activation.ts` | 动态工具激活（潜伏 / 同步 / 提示词可见性） |
| `src/tools.ts` | 两个工具的定义与 description |
| `src/prompt.ts` | 系统提示词那一节 + 主动激活提醒文案 |
