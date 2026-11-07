# 21 · dsh 作为基座的三维评估（可观测性 / 性能 / 执行能力）

> 评估日期：2026-11-07。对象：
> - **dsh**（DeepSeek Harness）`0.2.2-rc.1`：源码 `/Users/wxk/Documents/Project/deepseek-harness`（HEAD `fcc0ad4`），
>   运行产物 `npx @deepseek-ai/dsh`（`~/.npm/_npx/b86ed90107c62dab`）。
> - **pi** `1.4.0`（Piggy 锚点）；源码仓 `/Users/wxk/Documents/Project/pi` 已到 `1.5.0+270`，见 §2.1 校正。
>
> ⚠️ 2026-11-07 晚：pi 基线已从 1.4.0 升到 **1.5.0**（六锚点 + 生成器 + 契约，见 docs/15 规矩 164）。
> 本文 §5 的启动/内存实测是在 1.4.0 运行时上做的；1.5.0 的 RPC/事件面未变，数字只作量级参考。
>
> 问题（用户）：Piggy 现在以 pi 为基座；**若换成 dsh 为基座，可观测性、性能、执行能力有没有提效？**
>
> 结论：**执行能力有实打实的提效；可观测性"内部很强、远程面分裂"；性能是混合账。
> 而"换基座"现在比初看更不划算**——dsh 的 stdio SDK 是**提交级**事件面（没有 token 流、没有 cancel/切模型/fork），
> 保住 Piggy 现有流式体验的唯一路是接入它自家 Web Remote（Typert + WS + 鉴权），等于换产品形态。
> 推荐路线见 §8：留在 pi，抄设计与观测口径；按 §9 设触发条件。
>
> 本文只做评估，不改运行时；与 [20-pi-durable-evaluation.md](20-pi-durable-evaluation.md) 同类。

---

## 0. 一句话结论

| 维度 | 判定 | 一句话 |
|---|---|---|
| 可观测性 | **内部 + 显著 / 远程面分裂** | 会话日志有 63 类事件、每事件 `seq`+`time`、`request/header` 快照、keyless 回放；但**stdio SDK 只给提交级事件**，token 级流式只喂给它自家 Web 客户端 |
| 性能 | **换不划算（混合）** | 冷启动 0.45s → 1.09s（−2.4×）、常驻 178MB → 337MB（−1.9×）；但 240 轮 900ms 内打开、127k 事件 220ms、zstd+投影，pi 是整文件读内存 |
| 执行能力 | **换得上（+ 显著）** | 30 工具 vs 4；OS 级沙箱 + 逐次审批 + **运行时可切预设**（Piggy 现在切一档要重启 worker）；内置 subagent/workflow/jobs/schedule/goal |
| 迁移成本 | **很高，且被低估** | Rust 16.8k/25.9k LOC 强绑定；G7 归零；更要命的是**接缝语义不对等**（见 §3.3） |

**一句话给决策**：能力上 dsh 是升级，工程上是换发动机，**而它的传动轴（SDK）接不上 Piggy 的轮子**。

---

## 1. 速览：三项能力逐条对照

| 子项 | pi 1.4.0 | dsh 0.2.2-rc.1 | 谁更好 |
|---|---|---|---|
| 事件信封 | 无 id/ts/span；仅 `message.timestamp`、`tool_execution_end.durationMs` | `{type, seq, time, data, ignorable?}`；`seq` 会话内单调、`time` 墙钟 ms；**无 traceId** | **dsh** |
| 事件种类 | 23 个（含 4 类消息增量事件） | **63 个**已注册类型，分 6 组（生命周期/消息/工具/请求/可靠性/产品态） | dsh |
| token 级流式 | **有**：`message_update` 逐 delta 推给客户端 | **会话日志没有**；`agent/assistant-stream` 是进程内瞬态，**只有 Web Session-follow 适配器远程消费** | **pi** |
| turn/step | `turn_start/end`，无 step | `turn/start`、`step/start`、`turn/end`、`step/end` | dsh |
| 请求可见性 | 无请求事件，靠 session 里的 system message 反推 | `request/header`（provider/model/tools/adapterDefaults）+ `request/context`（contextWindow） | dsh |
| 计时/用量 | `usage` 含 **cost**；`get_session_stats` 每次全量重扫 | 无 duration/cost 字段；`session-stats` 投影给 `llmMs/toolMs/ttftMs/decodeMs`，但**只在 web profile 挂载** | 平（各有缺） |
| 持久化 | 明文 JSONL，**整文件 readSync 进内存** | 追加式 JSONL，默认 **zstd+校验和**，v0→v4 迁移 | dsh（但见 §7） |
| 检索/导出 | 无（Piggy 自建分页） | FTS5 搜索读模型、ZIP/Markdown 导出、`/export` | dsh |
| OTel | 无（coding-agent 不依赖 telemetry 包） | `dsh-otel`：**只有 OTLP logs**，无 span/metrics/采样；默认 `FEEDBACK_ONLY` | dsh（但别当 APM） |
| 冷启动 | **0.45–0.49s** | 1.08–1.09s（sdk）/ **0.42s**（sdk-minimal） | pi / dsh-minimal |
| 常驻内存 | **177–179MB** | 337MB（sdk）/ **139.7MB**（sdk-minimal） | 同上 |
| 长会话 | 整文件读内存，无分页参数 | 240 轮打开 900ms 预算、127k 事件冷开 220ms | **dsh** |
| 工具数 | 4（默认）/ 8（可选） | **30**（sdk 档实测） | **dsh** |
| 沙箱 | **无**（官方自认） | seatbelt / bwrap+Landlock / Windows 受限令牌+ACL | **dsh** |
| 审批 | 无逐工具；`--approve` 是项目信任 | `approval/request` + 三档 preset，运行时可切、按会话持久 | **dsh** |
| 子代理/编排 | 外部 `pi-subagents` 包 | 内置 subagent/fork/control、workflow(JS)、PTC、jobs、schedule、goal、team | **dsh** |
| GUI 远程面 | 33 命令 / 23 事件，含 abort/steer/fork/set_model/get_tree | SDK 8 方法、提交级事件；**cancel/model/fork 只在 Web BFF** | **pi** |
| 会话互通（G7） | 明文 JSONL，`pi -c` 与 GUI 共享 | zstd 帧 + v4 私有格式 + 迁移目录，只能经 dsh 自己的 API 读 | **pi** |
| 稳定性 | semver + session-format 版本 | developer preview，明示破坏性变更，SDK 无版本协商 | **pi** |

---

## 2. 口径与实测方法

### 2.1 版本校正（必读）

| 项 | 事实 | 影响 |
|---|---|---|
| Piggy 锚定 pi `1.4.0`（`apps/desktop/scripts/fetch-pi-standalone.mjs:74`、`check-pi-pin.mjs`） | 本机 `pi --version` = 1.4.0 | pi 侧结论按 1.4.0 运行时口径 |
| `pi/` 源码仓 = `1.5.0+270` | 比 pin 新 270 个提交 | 引用 pi 源码的 `file:line` 可能略前于 1.4.0；方向不受影响 |
| dsh | `0.2.2-rc.1`，developer preview | 能力可能在 rc 间变动；README 明写 "THERE WILL BE COMPATIBILITY-BREAKING CHANGES" |

### 2.2 测量方法（可复现）

- 机器：macOS Apple Silicon，Node `v24.14.0`，Python 子进程计时 + `ps -axo pid=,rss=,ppid=` 汇总进程树 RSS。
- 启动：pi 侧 `pi --mode rpc --no-session`，stdin 发 `{"id":"1","type":"get_state"}`，量到首条 response；
  dsh 侧 `dsh --profile sdk` / `sdk-minimal`，量到 `initialize` 的 result。
- 内存：握手后 1s 采样（含子进程）。每项 2–3 次，波动 <5%。
- 事件样本：`session/prompt` 触发一轮请求（无 API key），抓全部 `session.event` 通知。
- **未做**：真实模型的端到端时延/吞吐对比（需要 key 与同路由），本文不做该推断；
  Web Remote 的 WS 流式开销也未测。

### 2.3 三项能力的定义

- **可观测性** = 事件面（结构/时间/关联）+ 计时与用量 + 回放与检索 + 导出/OTel + **GUI 能否远程消费**。
- **性能** = 冷启动、常驻内存、长会话打开、流式事件路径。
- **执行能力** = 工具面、沙箱与权限、编排、扩展与模型生态。

---

## 3. 接缝：GUI 宿主到底对着什么编程

Piggy 的定位是"驾驶舱"：自己不跑 agent 循环，只驱动、观测、渲染、配置（`docs/00` NG1/NG3）。
所以"基座能力"必须减去"接缝损耗"，才是 Piggy 能拿到的能力。

### 3.1 pi：一条 JSONL/stdio，语义齐全

- 传输：严格 JSONL，stdout 只走协议记录，尊重背压（`pi/packages/coding-agent/docs/rpc.md`）。
- 命令 33 条，**包含 GUI 真正需要的动词**：`prompt`/`steer`/`follow_up`/`abort`/`clear_queue`/`set_model`/
  `cycle_model`/`set_thinking_level`/`compact`/`fork`/`clone`/`switch_session`/`get_tree`/`get_entries`/
  `get_session_stats`/`bash`/`abort_bash`（`docs/rpc-commands.md`、`src/modes/rpc/rpc-types.ts`）。
- 事件 23 个，**含逐 delta 的 `message_update`**——这是 Piggy 流式渲染的原料。
- Piggy 实际用 24 条命令、22 个事件类型（`apps/desktop/src-tauri/src/pi/client.rs`、`protocol.rs`）。

### 3.2 dsh：四个面，能力错位

| 面 | 启动 | 传输 | 有 | 缺 |
|---|---|---|---|---|
| **SDK** | `dsh --profile sdk` | stdio，NDJSON JSON-RPC 2.0 | `initialize`、`session/prompt`、`session/query`、`session/resume`、`session/wait`、`working-directory/{get,set}`、`shutdown`；通知 `session.event`/`session.status`/`approval/request`/`user-question/ask`/`subagent.*` | **无 cancel/close/list**；无切模型；无 fork；无队列控制；无版本协商；**无 token 流** |
| **ACP** | `dsh --profile acp` | stdio ACP v1 | new/list/resume/close/cancel/set_config_option/prompt/update/request_permission | 无 plan/todo/卡片/终端 |
| **Web Remote** | `dsh web` | HTTP + WS（Typert Remote） | `list`/`search`/`create`/`selectModel`/`fork`/`prompt`/`cancel`/`updateQueue`/`page`/`projections`/`follow`（含 `assistantStream` 实时块） | 内部预发布契约；绑定它自家 Web host、鉴权与 client 插件 |
| **headless** | `dsh --profile headless "…"` | stdout 事件流 | 一次性任务 | 非常驻 |

证据：`dsh/packages/sdk/protocol/README.md`（方法表 + "No cancel or session-close methods" + "No protocol-version
negotiation"）、`dsh/packages/api/session-controller/src/index.ts:281-620`。

### 3.3 决定性差异：token 级流式只在 Web 面

dsh 把事件分成**持久**与**瞬时**两类，架构文档写得很清楚：

> "`turn/*`、`step/*`、`system/message`、`user/message`、`assistant/message`、`assistant/attempt`、`tool/*`
> 是持久会话事件…… `agent/assistant-stream` 发布进程内的 start、瞬态 chunk 与 end 帧……
> **Web Session-follow 适配器是该实时事件的唯一远程消费者**。"
> —— `dsh/docs/architecture.md:108`（另见 `:126`）

含义：

- `assistant/attempt` 的载荷是**整段** `stream: AssistantStreamRecord[]`（`core/session/src/types.ts:363`）——
  一次 attempt 落一条，**不是逐 token 落**。
- SDK 的 `session.event` 转发的是会话事件，所以**只有提交级**：`user/message` →（沉默）→ `tool/call` →
  `tool/result` → `assistant/message`。
- 想要 token 级，只有两条路：**接它的 Web Remote（`session/follow` + `assistantStream`）**，
  或者在 dsh 进程里自写一个 Cordis 插件把 `agent/assistant-stream` 转成 stdout——后者等于自己维护一个协议分叉。

**这条直接决定成败**：Piggy 的流式渲染、合帧器、轨迹时间线全部建立在"每 delta 一条事件"上
（`apps/desktop/src-tauri/src/pi/coalesce.rs`）。换到 dsh SDK，UI 会退化成"整段回复一次出现"。

---

## 4. 可观测性：内部很强，远程面分裂

### 4.1 事件面：63 类、全带 seq/time

实测样本（一次失败请求，节选；`seq` 连续、`time` 单调）：

```json
{"type":"permission/preset","seq":0,"time":1794033621367,"data":{"preset":"workspace-write"}}
{"type":"turn/start","seq":4,"time":1794033621370,"data":{"turn":1}}
{"type":"step/start","seq":6,"time":1794033621420,"data":{"turn":1,"step":1}}
{"type":"request/header","seq":12,"time":1794033621423,"data":{"header":{"config":{...},"tools":[...]}}}
{"type":"request/context","seq":13,"time":1794033621424,"data":{"contextWindow":1048576}}
{"type":"assistant/attempt","seq":15,"time":1794033621436,"data":{"stream":[{"type":"chunk","time":1794033621436,"chunk":{...}}]}}
{"type":"step/end","seq":16,"time":1794033621437,"data":{"turn":1,"step":1}}
```

事件信封：`type + seq + time + data + ignorable?`；消息类另带 `surfaceOp`/`sourceEventSeqs`；**没有全局 id/traceId**
（`core/session/src/types.ts:501-524`）。63 个类型见 `core/session/src/known-event-types.ts:22-86`。

对照 pi：Piggy 的 `PiEvent` **没有任何时间字段**（`apps/desktop/src-tauri/src/pi/protocol.rs:24-60`），
合帧器产出的帧也没有 `t`。`docs/11` §2.1 计划的"信封加单调时间戳"至今未实现——首字延迟、每步耗时
只能靠宿主收到事件时打点，回放历史会话时无法重建。

### 4.2 请求快照与"model-visible ⟺ logged"

dsh 的 `request/header` 把**这次模型请求的完整配置**（provider/model/maxTokens/reasoningEffort + 全部工具
schema）写进会话日志，`request/context` 记上下文窗口；请求前有 checkpoint。这对应仓库规则
"Model-visible ⟺ logged"（`dsh/AGENTS.md`）。pi 侧只能从 `system/message` 反推，且没有工具 schema 的条目化记录。

注意边界：dsh 存的是**逻辑请求**，provider 的 wire body 不落盘，replay 用合成的 `{messages:[]}`
（`dsh/test-support/llm-replay/README.md:78`）。所以它能回答"模型看到了什么"，不能回答"HTTP 上发了什么"。

### 4.3 计时与用量：有投影，但只在 Web profile

- `session-stats` 投影产出 `turns/steps/llmMs/toolMs/ttftMs/decodeMs/decodeTokens`，跨分页与压缩稳定
  （`dsh/packages/session/session-stats/src/projection.ts:45-61,151-156`）。
- **但该行只挂在 `web-app` 组合里**（`dsh/packages/bundle/web-app/cordis.patch.yml:98-99`），base/sdk 没有。
  也就是说走 SDK 接缝拿不到现成 TTFT，得自己从 `step/start` 与 chunk 的 `time` 折算。
- 事件本身**没有 duration、没有 cost 字段**；pi 的 `usage` 反而带 `cost{input,output,total}`
  （`packages/pi-protocol/src/index.ts:96-113`）。成本核算这块 dsh 要自己按模型单价算。
- 另有权重投影：`tokenUsage`、`contextPressure`、`per-turn usage`（`dsh/packages/llm/token-meter/src/projection.ts`）。

### 4.4 持久化与检索

| 项 | pi | dsh |
|---|---|---|
| 编码 | 明文 JSONL | 默认 zstd 帧 + 校验和（`session-persistence-jsonl/src/index.ts:69`），可配 `none` |
| 读入 | `readSync` 整文件进内存（`session-manager.ts:640,696`） | 追加式 + 投影缓存 + 懒物化 + 请求前 checkpoint |
| 版本 | v1→v3 | v0→v4，独立迁移包目录，代际不可变 |
| 检索 | 无（只有 `get_entries(since)` 游标） | SQLite **FTS5 搜索读模型**（`session-query-sqlite/src/schema.ts:127`）+ `session-log-export`（ZIP/Markdown）+ `/export` |

### 4.5 OTel：是日志管道，不是 APM

- 只有 **OTLP logs**：每条 `SessionEvent` 一条记录 + ops（agent-error/shutdown）；**无 traces、无 metrics、无 span、无采样**
  （`dsh/packages/telemetry/otel/src/index.ts:22-30`、`session-log.ts:25-31`）。
- 属性是自定义命名（`session.id`/`event.type`/`event.seq`/`cwd`…），不是标准 semconv（`session-telemetry/src/coordinator.ts:290-304`）。
- 默认 `FEEDBACK_ONLY`：只有用户显式反馈才放行此前缀；`DISABLED` 不构造任何 transport；`FULL` 被拒
  （`session-telemetry-otel/README.md:36-37`）。队列 2048/批 512/10s/单请求 4MB/关机 3s。
- 接 Grafana/Datadog 要自建桥。对 Piggy 的含义：零遥测立场需显式 `DISABLED`；想"本地可观测"可以把
  OTLP 指向本地 collector，但只有日志，没有链路。

### 4.6 回放与调试（dsh 的真强项）

- 会话日志 + `request/header` 快照 + 请求前 checkpoint → 崩溃后能恢复请求与工具结果。
- **keyless replay**：录制会话，跑真实子进程，diff 组装请求、工具 schema、系统提示与持久化日志
  （`dsh/vitest.snapshot.config.ts:28-33`）。这是 dsh 敢大改内部结构的原因，pi 侧没有等价物。
- 调试面：`--dump-config`/`--dump-config-schema`、headless `--json`、Chrome DevTools inspector、Session log 表。

### 4.7 GUI 可直接消费的清单（按接缝分）

| 数据 | pi（stdio） | dsh SDK（stdio） | dsh Web Remote |
|---|---|---|---|
| 逐 token 正文 | ✅ `message_update` | ❌ | ✅ `follow` + `assistantStream` |
| turn/step 边界 | turn 级 | ✅ | ✅ |
| 工具调用/结果 | ✅ 含 update 流 | ✅（`tool/call`、`tool/result`） | ✅ |
| 请求头/容量 | ❌ | ✅ `request/header`/`request/context` | ✅ |
| TTFT/decode | ❌（自算） | ❌（无 stats 行，自算） | ✅ 投影 |
| 历史分页 | ✅ `get_entries` | ❌（无分页方法） | ✅ `page`/`projections` |
| 会话列表/搜索 | 宿主自读 JSONL | ❌ | ✅ `list`/`search` |
| 审批 | ❌（守卫自造） | ✅ | ✅ |

### 4.8 裁决

**内部强、远程分裂。** 若 Piggy 愿意接 Web Remote，可观测性是全面升级（请求快照、投影、回放、FTS、导出）；
若只接 SDK，**反而比现在的 pi 更差**——没有 token 流、没有历史分页、没有 stats 行，只有提交级事件。

---

## 5. 性能：不是单调提效

### 5.1 实测（空载最小面）

| 指标 | pi 1.4.0 `--mode rpc` | dsh `--profile sdk` | dsh `--profile sdk-minimal` |
|---|---|---|---|
| 首个协议响应 | **0.45–0.49 s** | 1.08–1.09 s | **0.42 s** |
| 进程树 RSS（1s 后） | **177–179 MB** | 323–337 MB | **139.7 MB** |
| 挂载规模 | 4 工具 + 扩展 | 111 行配置、30 工具 | 37 行配置 |

读法：

- **不是同一量级的比较**。`sdk` 档一次挂上 MCP、skills、sandbox、OTel、SQLite、plugin manager、jobs、
  subagent、schedule——337MB 买的是能力。要"同能力"比，得给 pi 加 piggy-guard + piggy-bridge +
  pi-subagents + 用户扩展（`docs/05` §5.6 实测打开会话 ≈1s，主要就是 pi 启动 + 扩展）。
- **`sdk-minimal` 证明底座本身不慢**：0.42s / 140MB。慢和胖来自"默认全挂"。
- 参考：`dsh web` 到开始监听 1.77s（含 HTTP/WS 与静态资源，非同一口径）。

### 5.2 长会话与 UI 预算

dsh 仓库自带**门禁级**性能预算（`dsh/benchmarks/`，超预算即红）：

| 场景 | 预算（参考机，CI 前） | 证据 |
|---|---|---|
| 240 轮会话打开 | 900 ms（含渲染两帧） | `benchmarks/long-session-browser/long-session.bench.ts` |
| 翻最旧一页 | 700 ms | 同上 |
| 首次进轨迹页 | 520 ms | 同上 |
| 127,400 事件（200 轮 × 500 text + 125 reasoning delta）冷开 | 220 ms；读取 8 ms；恢复 24 ms；投影 14 ms | `benchmarks/session-open/session-open.bench.ts` |
| 同会话重开 | 48 ms；agent resume 40 ms | 同上 |

pi 侧没有仓库级性能门禁（`scripts/profile-coding-agent-node.mjs` 只测启动、不记录数字），
Piggy 的预算表（`docs/05` §2）是自建的。

### 5.3 流式路径

- pi：每个 provider delta 一条记录，**源头不合帧**；Piggy 在 Rust 侧 16ms 合帧降到 ≤60 帧/s
  （`apps/desktop/src-tauri/src/pi/coalesce.rs`）。
- dsh（Web Remote）：`assistantStream` 给瞬态 chunk，带 `time`，同样需要宿主合帧；dsh 自家 Web 客户端也做批量。
- dsh（SDK）：**没有 delta**，这条链路的性能讨论不成立——它根本不流。
- 结论：走 Web Remote 时，换基座不减少 Piggy 的合帧工作，收益是"每 chunk 带时间"可回放；
  走 SDK 时，是功能退化而不是性能优化。

### 5.4 多标签内存账

Piggy 现在 1 tab = 1 worker（`maxWorkers` 默认 8，`docs/05` §4.2）。按实测空载：

| 形态 | 8 个 worker | 隔离性 |
|---|---|---|
| pi | ≈ 1.4 GB | 崩溃只死一个 tab |
| dsh sdk（一进程一会话） | ≈ 2.7 GB | 同上 |
| dsh sdk（一进程 N 会话） | ≈ 0.34 GB + N×Δ（Δ 未实测） | **共享进程，崩全崩** |

dsh 的 SDK 天然支持一个 runtime 里 N 个 session，理论上能把内存账打回来；代价是 Piggy 的
"一会话一 worker / 崩溃隔离 / registry 互斥"整套状态机要重做（`sessions/registry.rs` 1,235 LOC），
而且**一个进程崩 = 所有 tab 崩**，与驾驶舱的可靠性模型相反。

### 5.5 打包成本

dsh 要求 **Node ≥ 24.9**（`dsh/package.json` engines）。Piggy 现在 full SKU 打包的是 pi 独立可执行文件
（`fetch-pi-standalone.mjs`），不需要用户装 Node。换 dsh 要么要求用户自备 Node 24.9+，要么在 Tauri 包里
再塞一个 Node 运行时（+数十 MB、三平台矩阵）。这是**产品级**成本。

### 5.6 裁决

**混合。** 冷启动与常驻内存对 full profile 是退化（−2.4× / −1.9×）；长会话打开、检索、压缩是明显改进；
`sdk-minimal` 证明退化来自"默认全挂"而非底座。若真换，性能策略应是按 tab 能力裁剪 profile，
而不是照搬 base——但那又会砍掉 §6 的能力。

---

## 6. 执行能力：dsh 明显胜出

### 6.1 工具面

dsh `--profile sdk` 实测的模型可见工具（`request/header` 快照，30 个）：

```
ask_user_question, bash, create_goal, edit, get_goal, glob, grep, interrupt_agent,
job_kill, job_list, job_output, list_agents, plugin_manager, present, read, read_image,
schedule_create, schedule_edit, schedule_list, schedule_view, send_message, skill,
subagent, subagent_fork, todo_write, update_goal, web_fetch, workflow, working_directory, write
```

pi 1.4.0：默认 `read`/`bash`/`edit`/`write`，另有 `grep`/`find`/`ls`/`powershell` 与 codemode
（`pi/packages/coding-agent/docs/cli.md`）。Piggy 靠扩展补（guard、bridge、pi-subagents、MCP），
但**内置面差距是数量级的**。

### 6.2 沙箱与审批（差距最大的一项）

| 项 | pi 1.4.0 | dsh |
|---|---|---|
| OS 级沙箱 | **无**（官方原文 "lack of a built-in sandbox"，`docs/security.md:99`） | macOS `sandbox-exec`(seatbelt)、Linux bwrap→Landlock、Windows 受限令牌+ACL（`sandbox/sandbox-local/src/index.ts:42,86`） |
| 权限模型 | `--tools` 白名单（声明式，不阻止执行路径）+ `--approve`（项目信任） | `(sandbox, approval)` 两旋钮 + 三档 preset |
| 逐次审批 | 无（Piggy 用 `piggy-guard.js` 在 `tool_call` 上自己拦） | 原生 `approval/request`，**只放行一次**，断线 fail-closed |
| 切档 | Piggy 要**重启 worker**（`docs/17`、AGENTS.md） | `/permission <preset>` 运行时可切、按会话持久 |
| 守卫 | 任意 `tool_call` 可否决（JS，能力强但语义自造） | 只有 `repeat-tool-reminder` 之类劝告；拦截交给内核沙箱+审批 |

对 Piggy 的含义：三档权限从"重启换 `--tools` + JS 守卫"变成"运行时切预设 + 原生审批 UI"，
**语义更正、交互更顺**，但要重做权限 UI、审批回路与契约测试，并失去"任意 tool_call 否决"的自由度。

### 6.3 编排

| 能力 | pi | dsh |
|---|---|---|
| 子代理 | 非内置，外部 `pi-subagents` + Piggy bridge | 内置 `subagent`/`subagent_fork`/`send_message`/`interrupt`/`list_agents`；深度 1、并发 8 |
| 工作流 | 无 | `workflow`：模型写 JS，`agent()`/`parallel()`/`pipeline()`/`phase()`，可转后台 job |
| PTC | codemode（QuickJS，独立包） | `run_code` 在沙箱 Node 内以 binding 调工具（默认关） |
| 后台作业 | 无 | `jobs` |
| 定时 | 无 | `schedule`（7 种时基） |
| 目标/计划 | 无 | `goal`、`plan` 模式、`team` 任务板 |

Piggy 的 Fleet（`fleet.rs`）是宿主侧对**外部 pi 进程**的编排；dsh 的编排是**会话内部**的。两者不冲突，
也不能互相替代——换 dsh 不代表 Fleet 可以删。

### 6.4 生态与模型

- `llm-pi-ai` **复用 `@earendil-works/pi-ai` 的模型目录**，支持 OpenAI/Anthropic 兼容与自定义 baseURL；
  但**不读** pi 的 `models.json`/`auth.json`，凭据在 `~/.dsh/.credentials.yaml`。
- 扩展是 Cordis 插件/bundle：`dsh plugin --profile sdk add` 或运行时 `plugin_manager`（需审批）；
  sdk/acp 档禁 HMR，改配置要重启。第三方能给工具，**不能给 Piggy 的 UI**。
- 结果：Piggy 现有卖点（与 `pi -c` 共用会话、pi 扩展/skills/models.json 生态）换基座后**全部失效**。

### 6.5 缺口

- SDK 无 cancel：**"停止"= 杀进程 + `session/resume`**，当前 turn 丢失。
- SDK 无切模型：provider/model 绑进程级 `initialize`；多标签不同模型 = 多进程。
- SDK 无 fork/clone、无会话列表、无分页、无队列控制；`session.event` 不按会话过滤。
- **SDK 无 token 流**（§3.3），这是最硬的一条。
- 审批请求不带工具参数（只有 `toolName`/`callId`/`reason`），弹窗信息量不足。

### 6.6 裁决

**+ 显著（作为 agent 执行内核）。** 沙箱、审批、编排、工具面都是 pi 要靠外部包 + 自造守卫补齐的东西。
但收益要落到 Piggy 的交互上，中间隔着 §3.3 的接缝断裂。

---

## 7. 迁移成本（Piggy 侧）

### 7.1 量级（`wc -l` 实测）

| 区域 | LOC | 与 pi 的耦合 |
|---|---|---|
| `apps/desktop/src-tauri/src/pi/*.rs` | 4,257 | 强（argv、RPC 方法、事件名、`-e` 注入、`--tools`） |
| `src-tauri/src/sessions/*.rs` | 5,736 | 强（会话文件路径/格式、registry 互斥、transcript 分页） |
| `src-tauri/src/provider/*.rs` | 1,848 | 强（`models.json`/`auth.json` schema） |
| `src-tauri/src/plugin/*.rs` | 3,051 | 强（pi 扩展发现/信任/安装） |
| `packages/pi-protocol` | 373 | 强（pi RPC 类型 + zod） |
| `resources/piggy-guard.js` / `piggy-bridge.js` / `pi-plugins/` | 394 / 697 / 4,269 | 强（pi 扩展 API、生成物、vendored） |
| Rust 合计 | **25,961** | **强绑定 ≈16.8k（65%）**；与基座无关 ≈8.6k（33%） |
| 前端 | 47,698 | 仅 10 文件 import `pi-protocol`，胶水 ≈3.5k（7%） |

协议面：Rust 实发 **24** 条 RPC、按 **22** 个事件类型分派、**3** 种 delta 合帧。

### 7.2 处置分类

| 模块 | 判定 | 理由 |
|---|---|---|
| `codec.rs` | 复用 | 纯 JSONL 分帧 |
| `client.rs` / `protocol.rs` / `coalesce.rs` | 小改 | 请求/应答/超时/合帧通用；**但合帧器在 SDK 接缝下无用武之地** |
| `process.rs` / `discovery.rs` | 重写 | argv、发现、`--version` 全是 pi CLI |
| `permission.rs` | 重写 | 档位 = `--tools` + 守卫 → 预设 + 审批 |
| `resources.rs` / `plugins.rs` | 重写 | `-e` 注入与 pi 扩展语义 |
| `sessions/*` | 小改→重写 | 生命周期可留；文件格式/v4/zstd/parentId 树要换 |
| `provider/*` / `plugin/*` | 小改/重写 | `models.json`/`auth.json`/trust 语义不同 |
| `pi-protocol` / `guard` / `bridge` | 重写 | pi RPC 类型、`tool_call` 钩子、扩展 API |
| `open_in_app` / `pty` / `legal` / `fs_guard` / `fleet.rs` | 复用 | 与基座无关 |

### 7.3 三个硬约束

1. **G7 消失**：dsh 会话默认 zstd 帧 + v4 私有格式 + 迁移目录，只能经 dsh 自己的 API 读。
   "GUI 开的会话能用 `pi -c` 接着跑"这条产品承诺归零；Piggy 的 transcript 分页也不能再读文本行。
2. **权限语义重写**：从"白名单 + 任意钩子否决"变成"内核沙箱 + 一次性审批"。能力更强，
   但三档 UI、守卫脚本、契约测试重做，并失去细粒度布尔否决。
3. **接缝二选一**：接 SDK = 流式退化（§3.3）；接 Web Remote = 引入 Typert 生成契约、鉴权与
   它自家 client 运行时，等于把 Piggy 的协议层换成 dsh 的 Web 栈。**没有第三条"既保 UX 又轻量"的路。**

---

## 8. 裁决与路线

### A. 全量换基座（Rust 宿主改说 dsh SDK）

- 收益：§6 的能力；可删一批自建可观测性代码。
- 代价：≈17k LOC 重写 + G7 归零 + 打包改造；**流式 UX 退化**，且要等上游补 cancel/切模型/fork。
- **裁决：现在不做。**

### B. 双基座（pi 为主，dsh 跑特定任务）

- 问题：两套会话真相、两套权限、两套包；Fleet/子代理的 run 状态要对账。与 `docs/20` 否决 durable 的
  理由同构（双源真相，收益覆盖不了成本）。
- **裁决：不做。**

### C. 留在 pi，抄 dsh 的设计（推荐）

按性价比排序，三件事可以立刻做，都不动基座：

1. **事件信封补 `seq` + `time`**（宿主侧即可）：Rust 收到事件时打单调时间 + 序号，随帧下发；
   轨迹/统计立刻能算首字延迟与每步耗时，历史回放不再"无时间"。即 `docs/11` M2 计划的 `t`。
2. **请求快照落盘**：`pi:commit` 时把"本轮 system prompt 段 + 工具 schema 清单 + 模型参数"写一份旁路
   JSONL（不进会话文件，不破坏 G7）。对应 dsh 的 `request/header`，排障时能回答"这轮模型看到了什么"。
3. **统计投影化 + 回放测试**：把 `stats` store 从"事件累加"改成"对会话文件的可重放 fold"，
   并把 `docs/05` 的预算接进 perf 门禁；dsh 的 `benchmarks/` 与 keyless replay 是模板。

### D. 直接把 dsh 的 Web UI 嵌进 Tauri

- 收益：前端 47.7k LOC 与宿主协议层几乎全免，能力立刻对齐 dsh。
- 代价：产品不再是 Piggy（UI/交互/品牌/pi 互通全部让位），且 dsh Web 是 developer preview。
- **裁决：仅在"产品目标变更"时重估**，不属于本次技术选型。

### 推荐

**C**，把 A 的触发条件写进 §9。理由：可观测性收益的相当一部分**不依赖换基座**（C1–C3）；
执行能力收益（沙箱/审批/编排）必须换基座才能拿，但它们恰好撞上 Piggy 的 NG1/NG3 与流式体验，
值得等 dsh 的接缝成熟。

---

## 9. 复评触发条件

出现任意一条，再开评估（不要因为"dsh 发了新版"就重启话题）：

1. **SDK 补齐 GUI 动词 + 流式**：`cancel`/`close`、per-session 模型切换、fork/clone、队列控制、
   `session.event` 按会话过滤，**以及 token 级事件（或把 `agent/assistant-stream` 暴露到 stdio）**。
2. **会话格式稳定**：v4 冻结 + 兼容策略 + 非 TS 读取器（或明文 JSONL 成一等选项），使 G7 的替代方案可落地。
3. **运行时依赖可接受**：官方提供免 Node 的分发形态（SEA/单文件），或 Piggy 决定随包分发 Node。
4. **Web BFF 契约公开化**：Typert Remote 成为有兼容承诺的公开 API——此时"接 Web Remote"才不是赌博。
5. **产品边界变化**：需要 OS 级沙箱、内置工作流/后台作业，而 pi 仍无对应能力。

---

## 10. 若要做：PoC 验收清单

真要走 A，先做**单进程、单 tab、只读工作区**的 PoC，逐条验收（不过就别投入）：

1. `dsh --profile sdk` 裁剪后冷启动 ≤0.6s、RSS ≤200MB。
2. **流式**：不接 Web Remote 能否拿到 token 级更新？不能的话，产品能否接受"整段出现"？
3. **停止**：不杀进程能否取消当前 turn（当前：不能）。
4. **切模型**：单 tab 内切 provider/model（当前：不能，需重建 runtime）。
5. 审批：`approval/request` → 弹窗 → `allowed-once`，断线 fail-closed。
6. 三档权限映射 preset，运行时切换不重启。
7. 多 tab：一进程 N 会话的事件分流 + 崩溃隔离方案。
8. 会话列表/分页/搜索：走 Web BFF 还是自读 zstd 日志（写清契约）。
9. 崩溃恢复：`session/resume` + 游标补齐，与 `switch_session + get_entries` 等价。
10. 子代理：Piggy Fleet 与 dsh subagent 的真相源边界。
11. 打包：Node 来源、体积、三平台。
12. 契约测试：C1–C15 改写成 dsh 版，至少覆盖 prompt/abort/审批/恢复/流式。

---

## 11. 证据索引

**dsh**（`/Users/wxk/Documents/Project/deepseek-harness`）

- 接缝：`packages/sdk/protocol/README.md`、`packages/sdk/server/README.md`、`packages/bundle/sdk-app/README.md`、
  `packages/bundle/sdk-minimal/README.md`
- 流式边界：`docs/architecture.md:108,126`（持久 vs 瞬时；Web follow 是唯一远程消费者）、
  `packages/core/session/src/types.ts:363`（attempt 整段 stream）
- 事件与投影：`packages/core/session/src/known-event-types.ts:22-86`、`types.ts:501-524`、
  `packages/session/session-stats/src/projection.ts:45-61,151-156`、`packages/bundle/web-app/cordis.patch.yml:98-99`
- Web BFF：`packages/api/session-controller/src/index.ts:281-620`、`src/types.ts:492-511`
- 持久化：`packages/session/session-persistence-jsonl/src/index.ts:69`、
  `packages/session-query/session-query-sqlite/src/schema.ts:127`、`packages/session-query/session-log-export/`
- OTel：`packages/telemetry/otel/src/index.ts:22-30`、`packages/session/session-telemetry-otel/README.md:36-37`
- 沙箱/审批：`packages/sandbox/sandbox-local/src/index.ts:42,86`、`packages/sdk/protocol/src/types.ts:222-237`
- 性能门禁：`benchmarks/session-open/session-open.bench.ts`、`benchmarks/long-session-browser/long-session.bench.ts`
- 回放：`vitest.snapshot.config.ts:28-33`、`test-support/llm-replay/README.md:78`

**pi**（`/Users/wxk/Documents/Project/pi`，1.5.0+270；运行时按 1.4.0）

- RPC：`packages/coding-agent/docs/rpc.md`、`docs/rpc-commands.md`、`src/modes/rpc/rpc-types.ts`
- 事件/统计：`packages/coding-agent/src/core/agent-session.ts:4350`（全量重扫）
- 会话读入：`packages/coding-agent/src/core/session-manager.ts:640,696`
- 沙箱：`packages/coding-agent/docs/security.md:99`
- 扩展：`packages/coding-agent/docs/extensions.md`、`src/core/extensions/types.ts`

**Piggy**（本仓）

- 协议耦合：`apps/desktop/src-tauri/src/pi/{client,protocol,coalesce}.rs`
- 权限：`apps/desktop/src-tauri/src/pi/permission.rs`、`resources/piggy-guard.js`、`docs/17`
- 会话：`apps/desktop/src-tauri/src/sessions/*`、`docs/02` §7
- 预算：`docs/05` §2、§5.6
- 既有评估：`docs/20-pi-durable-evaluation.md`（同构的"不采用 + 触发条件"体例）

---

## 附录 · 复现命令

```bash
# 0) 看某个 profile 到底挂了多少插件（sdk=111，sdk-minimal=37）
DSH_HOME=$(mktemp -d) dsh --profile sdk --dump-config | grep -c '^- id:'

# 1) 起一次握手，量到 initialize 响应为止（sdk / sdk-minimal 各跑几次）
DSH_HOME=$(mktemp -d) dsh --profile sdk \
  <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"cwd":"/tmp","provider":"deepseek-official","model":"deepseek-flash"}}
EOF
```

```python
# 2) 计时 + 进程树 RSS（pi 与 dsh 同一脚本，换 cmd 即可）
import json, os, signal, subprocess, time

def rss_tree(pid):
    out = subprocess.check_output(["ps", "-axo", "pid=,rss=,ppid="], text=True)
    procs = {int(p): (int(r), int(pp)) for p, r, pp in (l.split() for l in out.strip().splitlines())}
    def walk(root):
        return procs.get(root, (0, 0))[0] + sum(walk(p) for p, (_, pp) in procs.items() if pp == root)
    return walk(pid) / 1024

def measure(cmd, payload, env=None):
    t0 = time.time()
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                         stderr=subprocess.DEVNULL, text=True, bufsize=1,
                         env={**os.environ, **(env or {})}, start_new_session=True)
    p.stdin.write(json.dumps(payload) + "\n"); p.stdin.flush()
    for line in p.stdout:
        if json.loads(line).get("id") == 1:
            break
    ready = time.time() - t0
    rss = rss_tree(p.pid); p.kill(); p.wait()
    return round(ready, 3), round(rss, 1)

print(measure(["pi", "--mode", "rpc", "--no-session"], {"id": 1, "type": "get_state"}))
print(measure(["dsh", "--profile", "sdk"], {"jsonrpc": "2.0", "id": 1, "method": "initialize",
      "params": {"cwd": "/tmp", "provider": "deepseek-official", "model": "deepseek-flash"}}))
```

实测结果（本机，2026-11-07）：pi `0.45–0.49s / 177–179MB`；dsh sdk `1.08–1.09s / 323–337MB`；
dsh sdk-minimal `0.42s / 139.7MB`。
