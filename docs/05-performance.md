# 05 · 性能与资源优化专章（内存 / CPU / GPU）

> 上游：[01-architecture.md](01-architecture.md)、[04-frontend-design.md](04-frontend-design.md)、[02-pi-rpc-integration.md](02-pi-rpc-integration.md)

性能是 Piggy 的一等需求（00 G3/G4），不是事后调优。本文给出：预算表（§2）、每条预算对应的机制（§3–§5）、测量与回归方法（§6）。

## 1. 资源画像（现实约束）

| 项 | 量级 | 来源 |
|---|---|---|
| pi worker（Node 进程） | 空闲 RSS ≈ 60–120MB，流式中峰值更高 | Node 运行时 + 会话状态 + 扩展 |
| WebView 基线 | ≈ 60–120MB（平台相关） | 系统 WebView |
| 事件速率 | `message_update` 可达数百~数千条/秒（逐 token） | 协议 §4.2 |
| 长会话 | 数千消息、单消息可含大 diff/长输出 | session-format |

结论：**最大内存变量 = 活跃 worker 数量；最大 CPU 变量 = 事件处理路径上的每条开销**。两者都必须被结构性约束，而非尽力而为。

## 2. 预算表（验收线）

| 指标 | 预算 | 对应机制 |
|---|---|---|
| 应用空载 RSS（0 worker） | < 150MB（含 WebView） | §4.1 回收、无轮询 |
| 每增 1 活跃 tab（worker） | 增量 ≤ 130MB | §4.2 上限 |
| Monaco 按需加载后增量 RSS | ≤ 60MB（含 workers；未加载时 = 0） | 10 §2.3 实例池 + 懒加载 |
| 空载 CPU | < 1%（无动画时 ≈ 0%） | §3.1 无轮询、§5.4 |
| 流式期间主进程 CPU | < 10%（M2 机器基线） | §3.2/§3.3 |
| 流式期间 UI 帧率 | ≥ 55fps（录制判定） | 04 §4 |
| 键入到渲染延迟 | < 16ms | 04 §7 |
| 冷启动到可交互 | < 2s（SSD，无 worker） | §4.1 会话列表零进程 |
| 打开 1 万条消息会话 | < 1.5s 首屏，滚动 55fps+ | 04 §4.5、§5.1 |
| 标签页切换 | < 100ms | §4.3 |
| 泄漏 | 30 分钟持续流式，WebView RSS 增幅 < 5% | §3.3 字符串策略、§5.2 |

预算进入 CI 冒烟（§6.3），超线即失败。

## 3. CPU：事件路径削减

### 3.1 零轮询架构

- 一切状态由事件驱动（pi 事件 / fs watcher / 状态机迁移）；**禁止任何 `setInterval` 轮询**（前端 lint 禁用、Rust 侧评审清单）；
- 唯一周期任务：空闲回收计时器（每 60s 一 tick，O(worker 数)）。

### 3.2 Rust 合帧器（第一道削峰）

见 03 §2.6。关键决策与理由：

- **delta 合并、非 delta 直通**：`text_delta` 类是高频小载荷，合并无信息损失（顺序保持）；生命周期类事件低频且驱动状态迁移，合并反而增加延迟与语义风险；
- **16ms 窗口**：对齐显示帧率；窗口内的多个 delta 拼接为单帧字符串（`String` push，一次 IPC 序列化）；
- **块边界立即冲刷**：`text_end`/`toolcall_end` 等边界事件触发冲刷，避免"块已结束但文本还压在帧里"的视觉滞后；
- **效果**：IPC 消息量从 token 速率（N 千/s）降到 ≤60/s；JSON 序列化次数同比例下降；前端事件循环压力与输出速率解耦。

### 3.3 前端瞬态通道（第二道）

04 §4：帧 → 入队 → rAF 批量 `appendData`。要点重申（CPU 视角）：

- 无 React 渲染参与 → 无 reconciliation；
- `appendData` 是文本节点原地追加 → 无 DOM 重建；
- zod 只校验 envelope（类型判别字段），不深扫文本载荷。

### 3.4 React Compiler

- 全组件自动 memoization；配合 zustand selector 订阅，消息提交只渲染受影响行；
- 转录行组件保持"输入少而稳"（协议对象引用稳定 + UI 态分离），让编译器跳过率最大化。

### 3.5 Markdown 预算

- 只在转正时解析一次（04 §5.1）；解析按块 memo；
- Shiki 语言包 LRU ≤ 16、可视区外不高亮（04 §5.2）——Shiki 完整包是前端最大的可选依赖，绝不全量打包。

## 4. 内存：worker 与数据治理

### 4.1 空闲回收（最有效的一条）

worker 空闲（`agent_settled` 后）超过 `idleTimeout`（默认 10min，可配 0=永不）→ 优雅退出；tab 保留（transcript 由 store 渲染，无需 worker）。再次交互时 respawn + `switch_session` + 游标补齐（02 §7.5）。**后台标签页不加速回收**（保证挂起的 Fleet 任务完整），但用户可手动"休眠标签"。

### 4.2 并发上限

`maxWorkers` 默认 8（可配）。超限时打开新 tab → 提示并建议回收最闲 worker（一键执行）。Fleet 任务同样计入上限（06 §3.4）。

### 4.3 标签页内存策略

- 非活动 tab：DOM 卸载（Workspace 按 tab 条件渲染），store 数据保留（消息为紧凑协议对象，1 万条 ≈ 数十 MB 内）；
- "休眠标签"操作：丢弃 store 中的消息数据（保留会话文件指针 + 游标），激活时 `get_messages` 重建——内存换取秒级恢复的选择权交给用户。

### 4.4 数据结构纪律

- messagesStore normalized（03 §3.2），共享引用而非拷贝；
- Rust pending map、环形 stderr 缓冲、合帧缓冲全部有界；
- 不缓存 `get_tree` 全树超过最近 2 个会话（LRU）。

### 4.5 大载荷

- bash 截断输出、diff、图片：协议侧已含截断语义（`truncated`/`fullOutputPath`，02 §3.2）；GUI 永远不把 >64KB 文本塞进 DOM（折叠 + 按需读文件）。

## 5. GPU 与渲染合成

### 5.1 合成器友好

- 动画/交互反馈只动 `transform` 与 `opacity`（04 §9 红线）；侧栏折叠、面板滑入、Toast 均如此；
- 滚动条自绘（overlay，`transform` 定位），不引入模拟滚动库；
- 流式光标闪烁用 CSS `steps()` 动画（合成器驱动，无 JS）。

### 5.2 绘制面积控制

- 转录行 `content-visibility: auto` + `contain-intrinsic-size`（离屏行跳过 layout/paint）；
- 虚拟化窗口 overscan 有限（前后各 6 行）；
- 主题色一律 CSS 变量（换主题零重绘重排）；antd v6 默认 CSS 变量模式 + `hashed:false`，Modal/Drawer mask blur 保持关闭（04 §6）。

### 5.3 WebView 配置

- macOS：`transparent: false`（合成器直通，避免每帧透明混合）；标题栏 `titleBarStyle: Overlay`；
- Windows：WebView2 默认 GPU 管线，`disable_web_security` 等危险项一律不碰；
- Linux：禁用 `WEBKIT_DISABLE_COMPOSITING_MODE` 相关 workaround 的自动注入，按发行版白名单处理。

### 5.4 能耗

- 无动画空闲态零重绘（DevTools performance 面板验证：无 rAF 待续、无定时器）；
- 空闲回收直接消灭 Node 进程空转（对笔记本电池友好——这也是选 Tauri 的动因之一，01 §3.1）。

### 5.5 编辑器与重资产分块

- Monaco 全家（core+workers+选定语言）为独立异步 chunk，首次打开预览/设置/diff 才加载：chunk ≤ 2MB gzip，加载后 RSS 增量 ≤ 60MB，未加载时 = 0（10 §2.2–2.3）；MonacoHost 单例工厂 + 实例池（**可见才创建 + LRU 保留水位 6**，见 10 §2.3 —— 每实例实测 ~0.5–1.5MB / ~70ms，真正要防的是「标签数量把实例数堆起来」）；
- Shiki 语言包 LRU 策略不变（§3.5）；聊天内嵌 diff 用自绘轻渲染，不实例化 Monaco（10 §2.1）；
- xterm.js 实例仅在终端面板可见时挂载，隐藏即 `dispose`（10 §4）。

## 6. 测量与回归

### 6.1 工具链

| 层 | 工具 |
|---|---|
| Rust 基准 | `cargo bench`（codec 吞吐：目标 >200MB/s 分帧；合帧器：10k delta/s 下 CPU < 单核 5%） |
| IPC 计量 | Rust 侧事件计数器（每通道 QPS/字节）暴露 `app:stats` 调试面板 |
| 前端 | React DevTools Profiler + Compiler 日志（`__compile_time_report`）；Chrome 性能面板记录流式 60s trace |
| 进程资源 | 每 worker RSS/CPU 采样（Rust sysinfo）→ 状态栏"资源"抽屉（用户可见，也是遥测来源） |

### 6.2 场景库（性能测试固定剧本）

S1 单会话长流式（30min）；S2 8 tab 并发流式；S3 万条消息会话打开与滚动；S4 100 并行工具执行；S5 崩溃重启恢复；S6 空载 1h 泄漏观察。

### 6.3 CI 冒烟

- 每次 PR：S1/S3 缩短版（M 机器分类：`perf-lite`）；
- 每夜：全场景 + 预算断言（RSS/帧率/CPU 阈值来自 §2）；
- 数据入库画趋势线，回归 >10% 自动标记 issue。

### 6.4 反模式黑名单（评审速查）

`setInterval` 轮询 / data URI 图片 / 每帧 setState / 完整 Markdown 解析流式文本 / antd 进转录子树 / 无界缓冲 / 动画 layout 属性 / 全量 Shiki 打包 / Monaco 全语言打包与无 dispose 挂载 / 键盘事件里做重计算。
