# 02 · pi RPC 集成规格

> 上游：[01-architecture.md](01-architecture.md) · 下游：[03-module-design.md](03-module-design.md)、[04-frontend-design.md](04-frontend-design.md)
> 事实来源：pi 官方 `docs/rpc.md`（命令/事件/类型）、`docs/session-format.md`、`docs/sessions.md`、`docs/settings.md`、`docs/models.md`、`docs/providers.md`。本文所有引号内语义均出自上述文档。

本文是 Rust 侧 `pi/` 模块与前端协议层的实现规格。规则：**本文没写的 pi 行为不得被代码假设**；标记 `【契约验证】` 的条目进入 09 M0 契约测试。

## 1. 协议总则与分帧（Framing）

RPC mode 是 stdio 上的 JSONL 协议：

- 命令：JSON 对象写入 stdin，**每行一条**；
- 响应：`type:"response"`，含命令回执（可携带请求 `id` 用于关联）；
- 事件：agent 事件以 JSON 行流式写往 stdout，无 `id`（`bash_execution_update` 例外，携带来源 `bash` 命令的 `id`）。

**分帧规则（协议文档原文要求）**：

1. **只以 LF（`\n`）切分记录**；接受可选的尾部 `\r`（剥离之）；
2. **不得**使用会把 Unicode 行分隔符（U+2028/U+2029）当作换行的通用行读取器——它们是 JSON 字符串的合法字符（Node `readline` 因此不合格）。

Piggy 实现约定：

- **Rust codec（03 §2.2）按字节扫描 `b'\n'` 分帧**：Rust 字符串以 UTF-8 编码，`0x0A` 字节只会作为换行符出现（多字节 UTF-8 序列的续字节最高位恒为 1，不可能等于 `0x0A`），天然规避 U+2028/2029 问题；跨 chunk 的半行必须缓冲；对 stdout 的**最后一行无换行结尾**的情况按 `end` 信号冲刷（进程退出前）。
- **写侧同理**：每条命令必须以 LF 结尾——`serde_json::to_string` 不自带换行，stdin 单写者统一补齐（M0 实测教训：漏 LF 会让 pi 永远等不到完整行，全部命令超时）。
- 前端永远不直接接触原始流（只见 Rust 合帧后的结构化事件），因此 TS 侧不存在分帧风险。

## 2. pi 二进制定位与启动

### 2.1 发现顺序

1. Piggy 设置中的显式路径（`piPath`）；
2. 环境变量 `PI_BIN`；
3. **应用内置 pi（捆绑官方 standalone，M2 起默认存在，08 §7.1）**；
4. `PATH` 上的 `pi`（Windows 为 `pi.exe` / `pi.cmd`）。

内置优先于 PATH 的理由：**发布确定性**——每个 Piggy 版本与契约矩阵验证过的 pi 版本成对发布；追求最新版的用户可在设置开启"优先使用系统 pi"。捆绑使最终用户**零前置安装**（无需 Node/npm/pi）。

启动时执行 `pi --version` 做版本门禁：低于契约锚定版本（见 §9）时 UI 警告并阻止创建会话（给出升级命令）。未找到二进制时进入引导页（含 `curl -fsSL https://pi.dev/install.sh | sh` 与 `npm install -g --ignore-scripts @earendil-works/pi-coding-agent` 两种安装指引）。

### 2.2 spawn 参数

```
pi --mode rpc
   [--provider <p>] [--model <pattern>]        # 仅当 tab 显式指定启动模型
   [--name <显示名>]                            # 新会话且用户已命名
   [--no-session]                              # 临时草稿
   [--session-dir <path>]                      # 用户覆盖了会话目录时
   [--session <path|id>]                       # 打开既有会话【契约验证 C1：rpc.md "Common options" 未列 --session，但 sessions.md 表明其为全局 CLI 参数；M0 实测，若不支持则改用 spawn 后首条 switch_session】
```

**环境与 cwd**：

- `cwd` = tab 绑定的项目目录（决定 pi 的项目资源发现与会话目录命名，01 §2.2）；
- 环境**继承宿主**，另注入 `PI_OFFLINE=0` 缺省与用户在设置中配置的代理变量；不清洗用户环境（pi 需要读取 `ANTHROPIC_API_KEY` 等既有变量，见 pi `docs/providers.md` 的解析顺序：runtime override → auth.json → 环境变量 → fallback）；
- Windows 上 `pi.cmd` 需经 `cmd /C` 包装 spawn【契约验证 C2】。

### 2.3 就绪握手

spawn 后依次：`get_state` →（若返回 `sessionFile`）绑定 tab↔session。`get_state` 5s 超时视为 spawn 失败（进入 01 §2.3 的 Failed 分支，展示 stderr 尾部）。

## 3. 命令层（Rust `pi/client.rs`）

### 3.1 关联与超时

- 每条命令分配**进程内单调递增 `id`**（u64→字符串），写入 pending map（`id → oneshot sender + 截止时间`）；
- 响应到达：按 `id` 路由到 oneshot；无 `id` 的响应按 `command` 字段与最近同类型未决请求关联（协议允许省略 id）【契约验证 C3：观察实际实现是否总是回显 id；Piggy 默认总是携带 id，规避该歧义】；
- 超时默认 30s；`bash`/`compact` 类长命令不设超时（由 abort 类命令取消）；
- **stdin 单写者**：所有命令经 mpsc 通道串行写入并 flush，避免交错写坏 JSONL。

### 3.2 命令 → UI 能力映射总表

Piggy 前端能力到 RPC 命令的完整映射（实现闭环校验：G2 的每项操作都在此表）：

| UI 能力 | RPC 命令 | 备注 |
|---|---|---|
| 发送消息（含图片） | `prompt` + `streamingBehavior` | 流式中发送必须带 `steer`/`followUp`，否则协议报错（见 §7.2）；`images: [{type:"image",data,mimeType}]` |
| 打断执行 | `abort` | 等 idle 后才回响应 |
| 清空排队并还原输入 | `clear_queue` → `abort` | 实现"Esc 还原编辑器文本"（协议文档明示此流程），返回的 steering/followUp 文本回填 composer |
| 排队转向消息 | `steer` / `follow_up` | 与 prompt+streamingBehavior 等价的两条直达命令 |
| 队列模式 | `set_steering_mode` / `set_follow_up_mode` | `all` / `one-at-a-time` |
| 新建会话 | `new_session`（可带 `parentSession`） | 注意 `data.cancelled`（扩展可取消） |
| 恢复/切换会话 | `switch_session(sessionPath)` | 注意 `cancelled` |
| 分支 | `fork(entryId)` / `clone` / `get_fork_messages` | fork 返回被 fork 的原文，回填 composer |
| 会话树 | `get_tree` / `get_entries(since)` | 游标增量同步见 §6.4 |
| 全量消息 | `get_messages` | 消息为 `AgentMessage`（§5.2） |
| 重命名会话 | `set_session_name` | `get_state.sessionName` 回读 |
| 切模型 | `set_model(provider, modelId)` / `get_available_models` / `cycle_model` | 模型选择器数据源 |
| Thinking | `set_thinking_level` / `get_available_thinking_levels` / `cycle_thinking_level` | 级别：off/minimal/low/medium/high/xhigh/max |
| 压缩 | `compact(customInstructions?)` / `set_auto_compaction` | 结果含 summary/usage |
| 自动重试 | `set_auto_retry` / `abort_retry` | |
| 直执行 bash | `bash(command)` + `id` | 流式 `bash_execution_update` 按 id 关联；结果可能 `truncated:true` + `fullOutputPath`（GUI 提供"打开完整日志"） |
| 取消 bash | `abort_bash` | |
| 统计 | `get_session_stats` | tokens/cost/contextUsage（上下水位条） |
| 导出 HTML | `export_html(outputPath?)` | |
| 命令面板数据 | `get_commands` | 扩展命令/技能/提示模板 → `/name` 经 `prompt` 调用；注意协议注明：TUI 内建命令（/settings 等）不在此列、经 prompt 发送不会执行，GUI 需过滤或映射为本地功能 |

### 3.3 bash 语义（易错点）

协议明确：`bash` 结果在**下一次 `prompt` 时**才进入 LLM 上下文（转为 `Ran \`cmd\`\n输出` 格式的 UserMessage）；多次 bash 可先于一次 prompt 累积。GUI 的"终端页签"必须按此语义呈现（显示"将随下一条消息注入上下文"提示），不得假装即时对话可见。

## 4. 事件层（Rust 路由 → 前端）

### 4.1 事件 → UI 映射总表

| 事件 | 前端呈现 |
|---|---|
| `agent_start` | 输入区锁定为"运行中"状态 |
| `agent_end(messages, willRetry)` | 运行指示器过渡；`willRetry` 时保留 |
| `agent_settled` | 终态：输入区解锁、队列清空确认 |
| `turn_start` / `turn_end(message, toolResults)` | 转录"回合"分隔；回合折叠分组 |
| `message_start(message)` | 开启实时块（§5.1） |
| `message_update(usage, assistantMessageEvent)` | 瞬态通道直写 DOM（§4.2） |
| `message_end(message)` | 权威快照入 store，实时块转正 |
| `tool_execution_start/update/end` | 工具卡片：args 摘要 → 累积输出（update 的 `partialResult` 是**累积量非增量**，直接替换显示）→ 终态 + isError |
| `bash_execution_update(id, delta)` | 终端页签按 id 追加 |
| `queue_update(steering, followUp)` | composer 上方队列 chips（可逐条撤回 = `clear_queue` 后重排队） |
| `compaction_start(reason)` | 顶部横幅 + 进度；`reason: manual/threshold/overflow` |
| `compaction_end(reason, result, aborted, willRetry, errorMessage?)` | `result` 的字段见下；**失败/中断时 pi 不落盘条目**，所以界面必须改口（不许说"完成"）；`willRetry` 时保留指示器 |
| `entry_appended(entry)` | **durable 条目落盘的唯一通知**（`agent-session.js:487/680/2419`，rpc-mode 原样转发）。`entry.type === "compaction"` 时它就是压缩的权威形状——`summary` / `firstKeptEntryId` / `tokensBefore` / `usage` / `details` / `fromHook` 都在里面（轨迹行据此构造，见 03 §3.0f） |
| `auto_retry_start/end` | toast 显示 attempt/maxAttempts/delayMs 倒计时，`abort_retry` 可取消 |
| `summarization_retry_*` | 状态条轻提示 |
| `extension_error` | 开发者日志 + 可选 toast |
| `extension_ui_request` | 弹窗/通知路由（§8） |

**压缩的载荷形状**（pi `dist/core/agent-session.d.ts:54-71` + `dist/core/compaction/compaction.d.ts:18-27`，
落盘条目见 pi `docs/compaction.md` §CompactionEntry Structure）：

```ts
// compaction_end.result
{ summary: string; firstKeptEntryId: string; tokensBefore: number;
  estimatedTokensAfter?: number;            // ⚠️ 只在事件里，不落盘
  usage?: Usage; details?: unknown }        // 默认实现：{ readFiles, modifiedFiles }
// entry（会话文件 / get_entries 里的那条）
{ type: "compaction"; id; parentId; timestamp; summary; firstKeptEntryId;
  tokensBefore; usage?; fromHook?; details? }   // 另有 systemMessage（压缩后的整份系统提示词）
```

**`systemMessage` 永远不进转录**：它是压缩后的整份新系统提示词（真机一条 10 KB+），
带上它等于把刚省下的载荷又还回去。Rust 侧 `compaction_row` 只转上表那些字段，
并有测试钉住（03 §2.19）。

### 4.2 `message_update` 的组装规则（协议重点）

协议已移除累计快照，客户端必须**自行组装**：

- 按 `contentIndex` 定位块；
- `toolcall_start` 给出 `id`+`toolName`，`toolcall_delta.delta` 是参数分片（**缓冲拼接，不渲染**），`toolcall_end.toolCall` 才是完整调用；
- `text_delta`/`thinking_delta` 即时可渲染；
- 顶层 `usage` 是累计用量（流式期间可能为 0）。

Rust 合帧器（§5）负责把这些 delta 按 16ms 窗口合并后再过 IPC，前端只在块边界做状态提交。

## 5. 类型与数据模型

### 5.1 内容块与消息（serde 透传原则）

`AgentMessage` = `UserMessage | AssistantMessage | ToolResultMessage | BashExecutionMessage | CustomMessage`（role 判别）。Assistant 内容块：`text` / `thinking` / `toolCall`；UserMessage.content 可为字符串或 `TextContent|ImageContent` 块数组，带 `attachments`。

**Rust `protocol.rs` 只强类型化 Piggy 需要读写的字段，其余以 `serde_json::Value` 透传**（`#[serde(flatten)] extra`）。理由：pi 协议向前演进（新增块类型/字段）时 Piggy 不崩、不丢数据——未知块在 UI 显示为"未知块（原始 JSON 可查看）"。前端 `packages/pi-protocol` 同样以 zod schema `passthrough` 校验。

### 5.2 会话条目（entries vs messages）

- `get_messages`：**当前上下文视图**（压缩后历史不在内）；
- `get_entries`：**append-only 全量树**（含压缩前历史与废弃分支），条目含 message/modelChange/thinkingLevelChange/usage/compaction/branchSummary/custom/label/sessionInfo 等（`docs/session-format.md`）。

Piggy 的转录视图默认走 messages；"历史考古"视图与分支树走 entries/tree。

## 6. 会话文件管理（Rust `sessions/`）

### 6.1 存储（事实）

会话文件位于 `~/.pi/agent/sessions/--<path>--/<timestamp>_<session-id>.jsonl`（`<path>` 为 cwd 路径分隔符替换为 `-`；版本 v3 树结构；首行 SessionHeader）。删除 = 删文件（pi 有 trash 机制，Piggy 优先移入系统回收站/`.trash` 兜底）。

**根目录可以被改**（`main.ts:675-679`）：`--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `settings.json` 的 `sessionDir` > 默认 `<agent>/sessions`；agent 目录本身又被 `PI_CODING_AGENT_DIR` 覆盖。注意自定义 `sessionDir` 在 pi 那边是**叶子**目录——所有项目的会话平铺在里面，不再有 `--<path>--` 那一层。Piggy 侧解析口径与两种布局的扫描见 03 §2.18 / §2.8。

**懒落盘【M0 契约实测】**：`get_state.sessionFile` 在 spawn 后即分配路径，但文件**首个 LLM 回合完成才写盘**；bash 直执行等仅追加内存条目的操作不触发落盘。依赖文件存在性的功能（列表扫描 §6.2、互斥 §6.3、崩溃恢复 §7.5）必须容忍"已分配未落盘"中间态。

**新会话预落盘【M1 实测】**：pi 对 `--session <空文件>` 会立即写入 SessionHeader 并置 flushed（`_setSessionFile` 的空文件分支），此后所有条目直接追加。Piggy 新建会话（`tab_create` 无 session_path）据此先按 pi 命名约定预创建空文件再打开，空白会话从创建起即持久化、重启可见；预创建失败时回退懒落盘。终端 pi 自建的会话仍是懒落盘，扫描器保留对"已分配未落盘"的容忍。

**转录的显示真相是文件，不是 `get_messages`【2026-09-23 改】**：打开会话时前端调
`session_page`（Rust 直接读文件尾部一页，03 §2.19），不再用 `get_messages` 一次性搬整段上下文。
理由有三条，都是实测的：

1. **`get_messages` 给的是"当前上下文"**（`agent-session.ts:1303` = `agent.state.messages`）：
   压缩过的会话里，压缩之前的历史已经被摘要取代——而文件里那些条目**还在**，
   它们才是"这个会话发生过什么"。分页读文件顺带把压缩行、`bashExecution` 一起带回来；
2. **代价**：真机 11.7 MB 的会话，`get_messages` 要等 pi 载入并把整段上下文序列化过 IPC，
   而尾部一页只要读 269 KB（最后 50 行）；同一台机器上 Rust 侧量到 5.1 ms vs 93 ms；
3. **顺序与去重**：文件是 append-only 的权威序列，用 `role:timestamp` 去重后，
   实时 `pi:commit` 继续往里追加，两条来源不会打架。

兜底：没有会话文件（尚未落盘）或文件读不出来 → 退回 `get_messages`，此时不显示「加载更早」。
**磁盘一个字节都不省**——Piggy 只读会话文件，绝不改写 pi 的 JSONL。

### 6.2 列表扫描（零进程成本）

`sessions/list.rs` 直接扫描目录：读每个文件**首行** SessionHeader（含 name/时间戳）+ stat（size/mtime）→ 会话侧栏数据。不 spawn 任何 pi 进程。带 debounce 的 fs watcher（notify crate）保持列表新鲜（pi CLI 在终端产生的会话也实时出现）。

**pi 的内建斜杠命令不在 RPC 协议里【2026-09-23 核实】**：`get_commands` 只返回
扩展命令（`extensionRunner.getRegisteredCommands()`）、prompt 模板与 skills
（`rpc-mode.ts:682-712`）；pi 自己那 24 条内建命令（`core/slash-commands.ts` 的
`BUILTIN_SLASH_COMMANDS`：`compact` / `new` / `model` / `thinking` / `name` / `export` /
`copy` / `resume` / `tree` / `fork` / `clone` / `reload` / `quit` …）是**交互模式本地解析**的，
协议里一个字都没有。所以界面必须自己补一张表（03 §3.0c）：能做的映射到已有 RPC
（`compact` → `pi_compact`、`name` → `set_session_name`、`export` → `export_html`…），
做不到的明确标"暂无入口"——**绝不能把 `/compact` 当普通消息发给模型**。

### 6.3 打开互斥

registry 保证一个会话文件同时只被一个 worker 打开（01 §2.2）。若文件正被终端里的 `pi` 使用：pi 侧自身行为未文档化【契约验证 C4：双开同文件的实测行为；Piggy 保守策略 = GUI 打开前检测 mtime 活跃度并警示，不强制锁】。

**这个不变量由两层共同守，缺一层都会漏**（2026-09-23 用户日志实证）：

| 层 | 职责 | 漏掉会怎样 |
|---|---|---|
| Rust（`registry.open_files`） | 真互斥：在同一把 registry 锁里查表 + 登记，并发调用被串行化 | 两个 worker 同时写一个 jsonl |
| 前端（`lib/tabCreate.ts` 的 `createTabGuarded`） | **幂等**：同一会话文件的并发创建复用同一个 promise / 同一份快照 | 第二次请求被 Rust 挡下 → 用户看到红色 toast「会话文件已被标签页 X 打开」 |

前端的坑在于**时序**：`openSession` 的"已经开着就聚焦"查的是 zustand store，
而 store 要到 `openSessionTab → ensureTab → addTab` 才更新 —— 也就是
**整个 `tab_create` IPC 往返期间 store 里都还没有这个标签**。
两次点击落进同一个窗口就都会去建 worker（双击是最常见的触发方式）。
所以"查 store 再 await"这种写法**只在 await 之前有效**，跨越 await 的检查必须有 in-flight 表兜。
Rust 侧拒绝前会 `worker.shutdown()`（`child.kill()`），所以被挡下的那次没有进程泄漏。

### 6.4 游标增量同步（恢复与复活）

`get_entries` 支持 `since=<entryId>` 且响应带 `leafId`：

- worker 复活/崩溃重启后：`get_entries(since=lastSeenEntryId)` 一步补齐，并比对 `leafId` 判断活动分支是否移动（协议原文：entry id 是持久游标，跨客户端重启有效）；
- `since` 不匹配（如文件被外部 fork/裁剪）返回 `success:false` → 降级为全量 `get_entries`。

## 7. 生命周期与容错语义

### 7.1 受理 ≠ 完成

`prompt` 响应 `success:true` 仅表示"已受理/已排队/已即时处理"；受理后的失败走事件与消息流，**不会**对同一 id 再发第二条 response（协议原文）。前端不得把 invoke resolve 当作"发送成功且模型已回复"。

### 7.2 流式中发送的规则

- agent 已在流式中：`prompt` **必须**带 `streamingBehavior`（`steer`/`followUp`），否则协议报错；
- 扩展命令（`/xxx`）例外：流式中也立即执行（扩展自管 LLM 交互）；
- `steer`/`follow_up` 命令不能用于扩展命令（协议禁止）。

**两者到底差在哪（2026-09-23 从 pi 自己的类型注释核对，不是推测）**

pi `AgentSession` 的原文：

| | 投递时机 | 一句话 |
|---|---|---|
| `steer`（界面：「转向」） | **"Delivered after the current assistant turn finishes executing its tool calls, before the next LLM call."** | 当前这批工具调用跑完、**下一次 LLM 调用之前**就插进去 → agent 不用停下来，但下一个 thought 就会看到你的话 |
| `followUp`（界面：「追加」） | **"Delivered only when agent has no more tool calls or steering messages."** | 一直排到 agent **彻底没活**（没有更多工具调用、也没有待投递的 steer）才投递 → 相当于"这一轮干完之后再说的事" |

两点容易误解：
- **都不是 abort**。两条都只是排队；真正停下 agent 的是 `abort`（界面 `Esc`）。
  pi 在 `PromptOptions` 上把 steer 注成 `"steer" (interrupt)`，那个 interrupt 指的是
  "打断流程、插队"，不是"中断会话"——别和 `Esc` 混为一谈；
- 排队条数与投递粒度另有 `steeringMode` / `followUpMode`（`all` / `one-at-a-time`）控制，
  Piggy 目前不暴露（用 pi 默认值）。

界面：Composer 的「转向 / 追加」两个按钮，以及 `⏎`=转向 / `⇧⏎`=追加 / `Esc`=中断并取回排队文本（§7.3）。

### 7.3 Esc 中断流（协议推荐流程）

`clear_queue` → 取回排队文本回填 composer → `abort`（响应到达 = 已 idle）。绑定到 `Esc`（07 键位表）。

### 7.4 新会话/切换/分叉可被扩展取消

`new_session` / `switch_session` / `fork` / `clone` 响应带 `data.cancelled`：为 true 时 UI 回滚 tab 状态（扩展 `session_before_switch`/`session_before_fork` 处理器否决了操作）。

### 7.5 崩溃、退出与恢复

- 会话文件由 pi 写盘（时机见 §6.1 懒落盘）：worker 崩溃不损坏文件；恢复 = respawn + `switch_session` + 游标补齐（§6.4）；
- **pi 不随 stdin EOF 退出【M0 契约实测】**：宿主强杀后 worker 存活成孤儿。因此 Piggy 退出必须走显式 shutdown（abort→kill，已实现于窗口销毁钩子）；开发期 `kill -9` 宿主后需手动清理孤儿；
- 正在流式中的生成会丢失（预期行为，UI 明示）；
- 应用退出走 01 §2.3 的优雅停机序列。

### 7.6 背压

- pi stdout 读取循环 → `codec` → `router` 全部有界通道（默认 1024 条）；满时**阻塞读**（让 OS 管道缓冲自然反压 pi），绝不丢事件；
- coalescer 合帧本身是削峰器：文本 delta 可从每秒数千条合并到 ≤60 帧（05 §3.2）。

## 8. Extension UI 子协议（弹窗路由）

两类方法（协议原文）：

- **Dialog**（`select`/`confirm`/`input`/`editor`）：阻塞等待 GUI 回 `extension_ui_response`；带 `timeout` 的由 pi 侧自动超时默认值，**GUI 不必自己计时**；
- **Fire-and-forget**（`notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text`）：无需响应。

Rust 把 `extension_ui_request` 原样转发前端；前端 `features/dialogs` 路由：

| method | UI | 响应 |
|---|---|---|
| `select` | antd Modal + 列表（键盘可选） | `value` / `cancelled:true` |
| `confirm` | antd Modal.confirm | `confirmed` / `cancelled:true` |
| `input` | Modal + Input | `value` / `cancelled` |
| `editor` | Modal + 多行编辑器 | `value` / `cancelled` |
| `notify` | antd notification（info/warning/error） | 无 |
| `setStatus` | 状态栏 key→text 槽位 | 无 |
| `setWidget` | composer 上/下小部件面板（`aboveEditor`/`belowEditor`，字符串行） | 无 |
| `setTitle` | 窗口标题 | 无 |
| `set_editor_text` | composer 预填 | 无 |

**响应写回**必须经 Rust 写入该 worker 的 stdin（同一单写者通道）。同一 worker 同时只按序处理弹窗（排队渲染，防 Modal 叠加）。

另注意协议列出 RPC 模式下退化/不支持的 UI 方法（`custom()` 恒 undefined 等）——piggy-bridge 扩展（06 §4）设计时必须遵守：`ctx.mode === "rpc"`、`ctx.hasUI === true`，仅使用上表能力。

## 9. 契约测试清单【M0 已实测 ✅ 2026-09-22，pi 0.86.1 / macOS；C12–C14 于 2026-09-23 补测，pi 0.87.1 + pi-subagents 0.70.1】

实现：`src-tauri/tests/contract.rs`（`pnpm test:contract`）。结论已回填下表；C11 留待 M1。

| # | 验证项 | 结论 |
|---|---|---|
| C1 | `--session <path\|id>` 启动参数 | ✅ 生效：`get_state.sessionFile` 与传入 path 一致，无需 switch_session 兑底 |
| C2 | Windows spawn 方式 | ⏸ 非 Windows 跳过，留待 Windows CI |
| C3 | response 是否回显请求 id | ✅ 总是原样回显（发 string 回 string）；Piggy 恒带 id 规避歧义 |
| C4 | 同一会话文件双开 | ⚠️ 第二进程 `switch_session` 成功且双方均可写（pi 不互斥）——Piggy 维持自身 registry 互斥 + mtime 警示（02 §6.3） |
| C5 | `get_entries.since` 游标 | ✅ 跨客户端重启增量可见（文件重读语义）；**非**跨进程实时可见；非法 since 返回 `success:false`（"Entry not found"） |
| C6 | `--no-session` 的 get_state | ✅ `sessionFile: null`，但 `sessionId` 仍存在（用 UUID） |
| C7 | >1MB 单事件管道 | ✅ 正常：`bash_execution_update` 分片流式（23 片/1.5MB），响应 `truncated:true` + `fullOutputPath` |
| C8 | `export_html` 默认路径 | ✅ 返回**相对路径** `pi-session-<ts>_<id>.html`（cwd 相对）；GUI 需解析为绝对路径 |
| C9 | `prompt.images` | ✅ 受理成功（anthropic-messages 兼容 provider 实测） |
| C10 | idle 状态 abort | ✅ 立即 success（data=null） |
| C11 | 就地分支导航 RPC 入口 | ⏳ M1（04 §4.5） |
| C12 | `-e piggy-bridge.js` + `/piggy:status` 数据面 | ✅ 实测（0.70.1 与 **0.71.0** 各一轮）：载荷经 `extension_ui_request{method:set_editor_text, text:"PIGGY:1:{…}"}` 回传，`ok:true` + 真实 `fleet`/`asyncSnapshot`；`setWidget`(widgetKey=`piggy-fleet`) 与 `notify` 同时到达；**扩展命令不消耗 token**（无 message_start/agent_start） |
| C13 | 无 pi-subagents 时 bridge 降级 | ✅ 实测：`PI_CODING_AGENT_DIR` 指向空目录 → `{kind:"status",ok:false,error:"pi-subagents 未安装"}`；顺带证明 pi 在**无凭据的空配置**下仍能启动 RPC 并执行扩展命令 |
| C14 | A 层 lane 机制（DAG/settle/结果收集） | ✅ 实测两 lane DAG：a settle 后 b 才就绪 → `{upstream}` 注入 a 的真实输出 → b 回复 BRAVO-OK → run 转 Done。**顺带修掉一个真 bug**：`get_messages` 的 data 是 `{"messages":[…]}` 而非裸数组，旧的 `last_assistant_text` 只认裸数组 → 每条 lane 结果恒为空、下游永远"(无输出)"（docs/15 规矩 15） |

> M3 的 B 层另有两项真机往返（不在这份 M0 契约清单里，记在 docs/09 §5.2 与 docs/18 §4）：
> `/piggy:spawn` → 子代理真跑到 `complete`；`/piggy:steer` → 回执 `delivered`（pi-subagents 记录 `requested:1, delivered:1`）。

实测额外发现的协议事实（已回填正文）：

- **会话文件懒落盘**（§6.1）：session 文件路径在 spawn 后即分配，但**首个 LLM 回合完成才写盘**；bash-only 追加只进内存。依赖文件存在性的功能（列表扫描/互斥/恢复）必须容忍“已分配未落盘”状态；
- **pi 不随 stdin EOF 退出**（§7.5）：宿主被强杀后 worker 成为孤儿——Piggy 必须在窗口销毁时显式 shutdown 全部 worker（已实现，lib.rs `on_window_event`）；
- `message_end` 对 **system** 角色消息也会发出（前端跳过渲染）；
- 事件序列实测（一次工具回合）：`agent_start → (turn_start → message_start/end ×N → tool_execution_* → turn_end)×2 → agent_end → agent_settled`，user/toolResult/system 均走 message_start/end；
- **`get_messages` 的 data 是 `{"messages":[…]}`**（不是裸数组），`/piggy:*` 之外的所有消费方都要按这个形状读（C14 实测踩到）。

## 10. 错误处理矩阵

| 错误源 | 表现 | Piggy 行为 |
|---|---|---|
| 命令失败 | `response.success:false` + `error` | invoke 透传给 UI，antd message 呈现 |
| stdin 解析失败 | `command:"parse"` 响应 | 视为 bug：日志 + 遥测自留（不上报） |
| worker 崩溃 | 管道 EOF / 非零退出 | 01 §2.3 状态机；stderr 尾部展示 |
| spawn 失败 | 立即错误 | 引导页（§2.1） |
| 事件解析失败 | 单行 JSON 非法 | 计数 + 原始行留存日志，不中断流【pi 保证合法 JSONL，防御性处理】 |
| 契约版本不符 | `pi --version` 低于锚点 | 阻断 + 升级指引 |
