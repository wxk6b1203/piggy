# 20 · pi-durable 评估（2026-10-22）

> 评估对象：`@earendil-works/pi-durable` **1.4.0**（与 pi 1.4.0 同批发布）。
> 结论：**当前不采用**；只把它当参考架构与观察项。若上游出现"coding-agent 采用 durable"
> 或"durable 提供 RPC/CLI 适配层"这类变化，再按 §6 的触发条件重评。
> 本文只记录评估，不改变运行时；Piggy 仍然只通过 `pi --mode rpc` 驱动真实 pi。

## 1. 一句话结论

`pi-durable` 不是"给 pi coding agent 加持久化"的插件，而是**另一套可嵌入的 agent harness**：
它自己拥有会话、条目、任务、文档和存储，自己跑模型与工具。Piggy 的定位是 pi 的驾驶舱，
不是第二个 agent runtime；把它接进来只有两条路——**替换 pi**（违反 00 NG1/NG3 与 G7）
或**在旁边再维护一份状态**（双源真相，收益覆盖不了成本）。因此现在不采用。

## 2. 它是什么

| 事实 | 证据 |
|---|---|
| 定位是"durable, extensible agent harness"，不是 pi 的会话存储插件 | `pi/packages/durable/docs/spec.md:3`、`README.md:5` |
| 核心规则：一次 commit 原子写入条目、任务记录与文档；**只有已提交状态可观察** | `spec.md:41-44` |
| 抽象：Harness / Conversation / Entry / Commit / Document / Task / Submission；任务可形成 task graph、有 child tasks、等待/中止/重启恢复语义 | `README.md:683-724`、`spec.md:48+` |
| 存储后端：Memory / IndexedDB / SQLite / JSONL / Cloudflare Durable Object | `README.md:763-767` |
| 是 **in-process TypeScript 库**：`package.json` 没有 `bin`，`exports` 只有库子路径；没有 CLI、没有 RPC server | `package.json:2-8`、`README.md:9-30` |
| 标记为 **Experimental**："API changes without notice between releases" | `README.md:3` |
| 依赖 `pi-ai` / `pi-codemode` / `chord` 等，**不依赖** `pi-coding-agent`；coding-agent 的依赖表里也没有它 | `packages/durable/package.json`、`packages/coding-agent/package.json:43-66` |
| `pi-agent-core` **1.0.0** 删掉了旧的 experimental harness，并把 SDK 用户指向 durable；但 coding-agent **没有**改成 durable | `packages/agent/CHANGELOG.md:37`（属于 `[1.0.0]` 段） |

**最容易误解的一点**：`pi-agent-core` 1.0.0 的 changelog 说"durable sessions 用 `pi-durable`"，
这句话的对象是**直接使用 agent-core 的 SDK 用户**，不是 `pi` CLI / coding-agent。
pi 1.4.0 的 CLI 仍然用 `SessionManager` + 自己的 append-only JSONL 树
（`packages/coding-agent/docs/session-format.md:3`、`packages/coding-agent/src/core/session-manager.ts:987+`）。
所以"官方出了 durable"不等于"pi 的会话已经 durable 化"。

## 3. 与本项目边界的逐项对照

| Piggy 的约束 | pi-durable 的事实 | 结论 |
|---|---|---|
| **G7 双向互通**：GUI 与 `pi -c` 共享 `~/.pi/agent/sessions/**.jsonl` | durable 的 JSONL 是 `main.jsonl` + `doc-N.jsonl` / `task-N.jsonl` 的 **commit log + sidecar**，不是 pi 的 `session` 头 + `id/parentId` 树；SQLite 是另一套 schema | **格式不兼容**，不能直接读写 Piggy 现有会话 |
| **NG1 不实现自己的 agent 循环** | durable 自己调用模型、执行工具、做 generation/tool task、compaction | 采用 = 把 pi 的大脑换成 durable 的大脑，直接违反 NG1 |
| **NG3 不 fork/内嵌修改 pi** | durable 不是 pi 的扩展，而是平级 runtime；接进来要新增 Node sidecar 或替换 worker | 采用 = 新进程/新协议/新生命周期，违反 NG3 的"保持 pi 可独立升级" |
| **每 tab 一个 `pi --mode rpc` worker** | durable 是 in-process 库，Rust 不能直接调用 TS；要么 Node sidecar，要么把整个 worker 换成 durable | 现有 supervision/coalescer/registry/权限档位全部要重做，收益不明 |
| **一个会话文件至多一个 worker（registry 互斥）** | durable 明确"**One process owns a storage at a time; there is no cross-process locking**" | 与 Piggy 的"GUI + 终端 pi 可同时打开同一文件（靠 mtime 警示）"模型冲突 |
| **会话可能几十 MB、按页读** | durable 的 JSONL 后端"Keeps the whole history in memory too, so memory grows with it" | 对长会话不友好；SQLite 后端可用，但又是另一套存储 |
| **Fleet = 宿主侧监督多个 pi 进程** | durable 的 child tasks/task graph 是**它自己的** conversation/task 内部编排，不监督外部 `pi` 进程 | 不能直接替换 `fleet.rs`；硬接会出现两套 run 状态 |
| **扩展/skills/MCP/models.json 生态** | durable 的工具是它自己的 `defineTool` / `ExecutionEnv`，扩展是 durable extension；不复用 pi 的扩展、skills、MCP、模型配置 | 采用 = 放弃 Piggy 最大的生态卖点 |
| **桌面单用户、零服务端（NG2）** | durable 的部署面包含宿主服务与 Cloudflare Durable Object，存储/任务模型按"可恢复服务"设计 | 能力过剩；Piggy 不需要为此引入服务端形态 |

## 4. 可选方案与裁决

### A. 用 durable 完全替换 pi 运行时

- 改动面：废除 RPC 集成、重写会话/转录/权限/扩展/Fleet 的整条数据面；Rust 需要 Node sidecar 或
  直接嵌入 JS runtime；所有 pi CLI 互通能力消失。
- 收益：commit-before-show、任务恢复、task graph 是现成的。
- 裁决：**拒绝**。违反 NG1/NG3/G7；等于把 Piggy 从"驾驶舱"改成"另一个 agent 产品"。

### B. 只把 durable 当 Fleet 的任务账本 / 子任务图

- 改动面：新增 Node sidecar + 一套 RPC 把 `fleet.rs` 的 run/lane 状态镜像到 durable；
  或者用 durable 的 child task 取代 `fleet.rs` 的 DAG。
- 问题：Fleet 的 lane 是**外部 pi 进程**，durable 的 task 是**它自己的 generation/tool task**；
  两者生命周期语义不同。镜像会制造第二个真相源，崩溃恢复时还要对账"durable 说 running、
  pi 进程已经死了"。
- 裁决：**不采用**。现有 `fleet.rs` 的状态机（Draft/Running/Settled/Done/Aborted + DAG 纯函数）
  已经覆盖需求，且有 C14 真机契约；为"跨重启恢复 Fleet"引入 durable 不划算。
  若将来 Fleet 真的要求跨应用重启续跑，优先加一个**小的 Rust 日志**，而不是再起一个 agent runtime。

### C. 用 durable 做会话崩溃恢复 / 投影缓存

- 改动面：把 pi 的会话 JSONL 导入 durable，或让 pi 把每次 commit 同步给 durable。
- 问题：没有官方导入/导出；格式不兼容（§3）；pi 本身已经是 append-only + 游标重放，
  Piggy 的崩溃恢复（`switch_session` + `get_entries(since=...)`）已经能补齐。
- 裁决：**拒绝**。这是重复建设，且会把"pi 是唯一会话真相"变成两个真相。

### D. 不采用，保留观察（推荐）

- 运行时零改动；只在文档/风险登记里留触发条件。
- 继续用 pi 的 JSONL + registry 互斥 + 游标重放；继续用 `fleet.rs` 的 DAG。
- 把 durable 的设计当**参考**（§5），不把它当依赖。

## 5. 值得借鉴的设计（不是依赖）

这些点在我们的代码/文档里已经有对应物，价值在于"对照检查"，不是"引入库"：

| durable 的做法 | Piggy 现有的对应物 | 是否值得补 |
|---|---|---|
| commit 成功后才发布 UI | pi 的 append-only 会话 + `message_end` 后 `pi:commit` | 已有；不需要 durable |
| `requestId` 幂等提交 | pi 的 RPC id + registry 去重 | 已有 |
| 任务重启计数/restart limit | worker 崩溃退避（≤3 次） | 可借鉴"计数 + 上限"的显式语义，但不是现在 |
| task graph / child tasks | `fleet.rs` 的 run/lane DAG | 已有；不需要 durable |
| 文档保留上限（documentRetentionMs） | 转录分页窗口 / row memory | 已有类似预算 |
| 单写者 mutation line | registry 的"一会话一 worker" | 已有；durable 的跨进程限制反而更严 |

## 6. 重新评估的触发条件

只有出现下面任意一条，才值得再开一次评估（否则不要因为"官方出了新包"而引入）：

1. **coding-agent 自己采用 durable**：`packages/coding-agent` 的依赖表出现
   `@earendil-works/pi-durable`，或 `pi` 新增 `--durable` / durable session backend，
   并且 `pi -c` 仍能打开同一会话文件。
2. **durable 提供 RPC/CLI 适配层**：能对外暴露与 pi RPC 对等的会话/队列/工具事件面，
   且能导入/导出 pi 的 `session-format` JSONL。
3. **Piggy 的产品边界变化**：从"单用户桌面驾驶舱"扩展到"托管/多用户/自定义 agent"
   （当前 NG2/NG3 明确不做）。
4. **Fleet 出现真实的跨重启续跑需求**：此时先评估"Rust 日志 + pi 会话"能否满足；
   只有满足不了，才考虑 durable 的 task graph，并且仍应让它**只做账本**、不接管 agent。

## 7. 证据索引

- pi-durable：
  - `pi/packages/durable/README.md:3,5,763-767,790`
  - `pi/packages/durable/docs/spec.md:3,41-44`
  - `pi/packages/durable/package.json:2-8`
  - `pi/packages/durable/src/storage/jsonl/storage.ts:30,101`
- pi coding-agent / session：
  - `pi/packages/coding-agent/package.json:43-66`
  - `pi/packages/coding-agent/docs/session-format.md:3`
  - `pi/packages/coding-agent/src/core/session-manager.ts:987+`
  - `pi/packages/agent/CHANGELOG.md:37`
- Piggy 边界：
  - `docs/00-overview.md:32,38,40`（G7 / NG1 / NG3）
  - `docs/01-architecture.md:103-115`（RPC vs SDK 内嵌的裁决）
  - `docs/06-subagents.md:9-20`（Fleet 为什么不用 pi-subagents；同理也不该用 durable）
  - `apps/desktop/src-tauri/src/fleet.rs:57-125,314+`
  - `apps/desktop/src-tauri/src/sessions/registry.rs:136,451+`
