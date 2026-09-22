# 00 · 愿景与总览

> 上游文档：[README.md](README.md) · 下游文档：[01-architecture.md](01-architecture.md)

## 1. 一句话定位

**Piggy = pi 的图形驾驶舱**：把 pi 这个终端 coding agent harness 的全部能力——多会话、多 Provider、流式输出、工具执行、分支树、压缩、子代理——装进一个低资源占用、GPU 加速、全键盘可驱动的原生桌面应用。Piggy 不复制 pi 的大脑，只做 pi 的"宿主"：`piggy`（小猪）骑在 `pi`（pig/猪）上跑，这也是项目名的由来。

## 2. 问题与价值

pi 是一个极简、可扩展的终端 agent harness，其官方集成路径包含四类：interactive（TUI）、print/JSON、**RPC（面向进程集成）**、SDK（面向 Node 内嵌）。终端形态对以下场景不友好：

1. **并行多会话管理**：多个项目、多个任务同时对话，TUI 需要多个终端窗格；
2. **可视化结构数据**：会话分支树、token/成本统计、工具执行 diff、子代理舰队状态，纯文本呈现信息密度低；
3. **配置管理**：provider 认证（`auth.json`）、自定义模型（`models.json`）、`settings.json` 均为手工编辑 JSON；
4. **桌面级体验**：全局唤起、通知、剪贴板/拖拽图片、快捷键体系。

Piggy 用 RPC mode（JSONL over stdio）驱动真实的 pi 进程，因此**与 pi 完全同构**：pi 的全部设置、会话文件、扩展、技能在终端与 GUI 之间互通——你在 GUI 里开始的会话，可以随时 `pi -c` 在终端续跑，反之亦然。

## 3. 目标（G）与非目标（NG）

### 3.1 目标

| # | 目标 | 度量（验收） |
|---|------|--------------|
| G1 | 完整对话体验：流式输出、思考块、工具调用卡片、图片、bash 直执行 | 所有 02 §6 列出的 RPC 事件都有对应 UI 呈现 |
| G2 | 一切操作 GUI 化：对话、模型/Provider 切换、thinking 级别、压缩、会话管理（新建/恢复/分支/fork/clone/重命名/导出）、设置（auth/models/settings）、快捷键自定义 | 无需打开终端或手编 JSON 即可完成全部日常操作 |
| G3 | 低资源占用 | 05 §2 预算表全部达标（空载 RSS < 150MB、空闲 CPU ≈ 0%） |
| G4 | GPU 加速的流畅 UI | 流式输出 60fps、滚动无卡顿、动画只走合成器属性 |
| G5 | 子代理：GUI 内编排并行 agent 任务，桥接 pi-subagents 生态 | 06 双层设计全部落地 |
| G6 | 全键盘操作 + 命令面板 | 07 键位表全部实现，任何菜单操作均有快捷键等价物 |
| G7 | 与 pi 双向互通 | 会话文件、配置文件被 GUI 与 pi CLI 共享且互不破坏 |

### 3.2 非目标（明确不做）

| # | 非目标 | 理由 |
|---|--------|------|
| NG1 | 不实现自己的 agent 循环 / LLM 客户端 | pi 是引擎；复制大脑会造成双源真相与维护地狱 |
| NG2 | 不做 Web 版 / 多用户服务端 | 单用户桌面工具；"服务"指本机常驻（托盘、全局唤起） |
| NG3 | 不 fork/内嵌修改 pi 源码 | 通过 RPC 与扩展机制集成，保持 pi 可独立升级 |
| NG4 | 不做 IDE（项目管理、LSP、调试器） | 右栏“文件”视图只读预览为主（Monaco，懒加载）；M4 提供受限“快捷编辑”（小改动直写 + 外部变更冲突警示），大量编辑交给真实编辑器——写代码的主力仍是 pi |
| NG5 | 首发不支持 Linux webkitgtk 之外的浏览器引擎调优 | 见 01 §3.1 平台权衡 |

## 4. 核心用户故事

1. **日常驾驶**：全局快捷键唤起 Piggy → `Cmd+K` 打开面板 → 选择项目与最近会话 → 流式对话；`Esc` 中断并恢复输入框文本（`clear_queue` + `abort`，见 02 §7.3）。
2. **配置 Provider**：设置 → Provider → 为 Anthropic 填 API Key（写入 `auth.json`）→ 添加本地 Ollama（生成 `models.json` 条目）→ `Cmd+L` 挑选模型（`get_available_models` + `set_model`）。
3. **探索分支**：会话侧栏打开分支树（`get_tree`）→ 从早前某条用户消息 fork（`fork`）→ 两条分支并行对话。
4. **并行舰队**：Fleet 面板 → 选一个"侦察 + 评审 + 实现"模板 → Piggy 以三个 pi 会话并行执行，逐个 steer / 中断 / 汇报（06 §3）。
5. **桥接 pi-subagents**：会话内模型调用 `subagent` 工具时，子代理活动实时显示在 GUI 舰队面板；用户也可从 GUI 对运行中的子代理想 steer（06 §4）。
6. **离线续跑**：关闭窗口后进程回收；重开时按 `get_entries` 游标增量恢复（02 §7.5），长会话秒开。

## 5. 术语表

| 术语 | 定义 |
|------|------|
| **pi** | 底层 agent harness（npm 包 `@earendil-works/pi-coding-agent`，提供 CLI/SDK/RPC） |
| **Piggy** | 本项目，Tauri 2 桌面应用 |
| **RPC mode** | pi 的无头模式：JSONL 命令（stdin）与响应/事件（stdout），见 pi `docs/rpc.md` |
| **会话工作进程（session worker）** | Piggy 为一个标签页管理的 `pi --mode rpc` 子进程 |
| **标签页（tab）** | GUI 中一个对话视图；绑定一个 worker；可 `switch_session` 换绑会话文件 |
| **会话（session）** | pi 的持久化对话，JSONL 树结构文件（`~/.pi/agent/sessions/`，见 pi `docs/session-format.md`） |
| **实时块（live block）** | 正在流式渲染中的消息块，走瞬态渲染通道（04 §4） |
| **合帧器（coalescer）** | Rust 侧把高频增量事件按帧合并的组件（02 §5、05 §3） |
| **Fleet** | Piggy 宿主侧编排的多个 worker/子代理集合（06） |
| **piggy-bridge** | Piggy 附带的 pi 扩展，桥接 pi-subagents 的 in-process RPC（06 §4） |
| **Extension UI 子协议** | pi RPC 中扩展请求用户交互的 `extension_ui_request/response` 通道（02 §8） |

## 6. 技术栈总览

选型论证详见 01；此处只给结论。

| 层 | 选择 | 版本基线 |
|----|------|----------|
| 桌面框架 | Tauri | 2.x |
| 核心语言 | Rust（主进程）/ TypeScript（前端） | Rust ≥ 1.80，TS ≥ 5.6 |
| 引擎集成 | `pi --mode rpc` 子进程 + JSONL stdio | pi ≥ 0.86（契约测试锚定，见 02 §9） |
| 前端 | Vite 6 + React 19 + React Compiler | react-compiler 稳定版 |
| UI 库 | antd 6（≥6.6；React 19 原生支持、默认 CSS 变量模式；`@ant-design/icons` v6 配套） | 6.x |
| 状态 | zustand（+ immer 中间件） | 5.x |
| 编辑器 | Monaco Editor（预览/设置 JSON/Diff 基座；Composer 不用编辑器库，10 §2.1） | 0.5x+ |
| 虚拟化 | TanStack Virtual | 3.x |
| 终端仿真（登录流程/后期） | xterm.js + portable-pty | — |
| 进程/异步 | tokio + serde/serde_json | Rust 侧 |

## 7. 成功判据（产品级）

- 一名只用过终端 pi 的用户，5 分钟内完成：安装 → 配置 API Key → 开启首个会话 → 切换模型 → 建立分支 → 关闭再恢复。
- 一名从未用过 pi 的用户，10 分钟内完成：安装 → 通过 GUI 完成订阅/API Key 引导 → 首次对话。
- 与 pi CLI 混合使用一周后，`~/.pi/agent/` 下没有任何文件损坏或语义冲突。
