# 09 · 路线图、验收标准与风险

> 上游：全部文档 · 基准：[00-overview.md](00-overview.md) 目标 G1–G7

## 1. 里程碑总览

```mermaid
flowchart LR
    M0[M0 地基<br/>协议契约+最小对话] --> M1[M1 全功能<br/>会话/设置/快捷键]
    M1 --> M2[M2 性能达标<br/>预算全绿]
    M2 --> M3[M3 子代理<br/>Fleet+bridge]
    M3 --> M4[M4 打磨发布<br/>登录/更新/打包]
```

每个里程碑**必须**满足其验收标准才能进入下一个；验收条款可追溯到文档章节。

## 2. M0 · 地基（✅ 已完成 2026-09-22，验收记录见下）

**范围**：工程骨架跑通 + 协议层可信 + 一条能对话的管道。

- 仓库/CI/质量门按 08 搭建（eslint 自定义规则同步落地）；
- Rust：discovery、codec、process（状态机 v1：Spawning/Ready/Busy/Crashed/Stopped，回收可后置）、client、protocol（§透传）、合帧器 v1；
- 前端：ipc 封装、tabsStore/messagesStore/liveStore、Transcript v1（虚拟化 + LiveBlock 直写）、Composer v1；
- 单 tab、单会话、新建会话、`get_state`/`get_messages` 恢复。

**验收（DoD，✅ 全部达成 2026-09-22）**：

1. ✅ 02 §9 契约测试 C1–C10 全部有结论并回填文档（C11 留 M1）；额外实测发现：会话文件懒落盘、pi 不随 stdin EOF 退出（已回填 02 §6.1/§7.5）；
2. ✅ 端到端：发 prompt → 流式渲染（合帧帧 + text_delta）→ `agent_settled` 解锁输入（`e2e_streaming_pipeline` + GUI 实机验证）；
3. ✅ 契约对拍（Rust↔TS fixture）：Rust 3 测试 + TS 30 测试全绿；
4. ✅ codec 单测覆盖：跨 chunk 半行、`\r\n`、1MB 长行、EOF 半行、多字节跨 chunk、U+2028/2029；
5. ✅ 崩溃注入（kill worker）→ Crashed 检出 → 复活 + 游标补齐，无重复/丢失（`e2e_crash_recovery` + resync 去重测试）。

M0 附加交付（超出原范围）：Extension UI 弹窗路由（02 §8 全表）、暗/亮主题切换（正式管线 M1）、队列管理（queue_update/chips/Esc 取回）、会话统计（tokens/cost/ctx%）。

M0 实现修正记录：React StrictMode 双 effect 曾导致双 tab → init 单例化；pi 进程名经 shim 后为 `pi`（非完整命令行），进程探测用 `pgrep -x pi`。

## 3. M1 · 全功能 GUI（约 3–4 周）

**范围**：G2 全量——一切操作 GUI 化。

- 会话：列表（文件扫描 + watcher）、switch/new/fork/clone/rename/delete/export_html、会话树抽屉（get_tree）；
- 模型/Thinking：选择器（get_available_models/set_model）、thinking 级别；
- 设置：Provider（auth.json 表单 + 状态检测）、自定义 provider（models.json 表单）、settings.json 表单 + JSON 编辑器、Piggy 自有设置；
- Composer 完整态：图片、斜杠补全（get_commands）、队列 chips、steer/followUp；
- Extension UI 弹窗路由（02 §8 全表）+ setStatus/setWidget 槽位；
- 快捷键系统 v1（07 §2 默认表 + 冲突检测）+ 命令面板 v1；
- Esc 中断流、bash 直执行面板（RPC 模式）、compact 手动/自动横幅、统计与上下水位条；
- 工作区布局 v1（04 §1：框线布局 + dockview 编辑区 + tab 模型 + 左右视图轨基础视图 + 底部面板 + 布局持久化）与编辑器基座（Monaco 懒加载：文件预览/JSON schema 设置编辑/DiffEditor，含 worker 配置与实例池，10 §2）。
- **轨迹视图 v1**（04 §1.10，参考 docs/11 DSH dsh_3）：会话级全事件流（`get_entries` + 实时事件混合源），按轮次分组、角色芯片（系统/用户/上下文/助手/工具）、工具行 `args → result` 可展开、时长/轮次/调用过滤 + 搜索；三轨时间线（输入/模型/工具甘特图）排 M2（需事件时间戳埋点）；

**验收**：

1. 00 §4 用户故事 1/2/3 手工验收通过（写成 E2E 用例进 CI）；
2. G2 对照 02 §3.2 映射表逐行勾验；
3. `extension_ui_request` 五类 dialog + 五类 fire-and-forget 均有 UI（用 rpc-demo 扩展实测：pi 官方 `examples/extensions/rpc-demo.ts` + `examples/rpc-extension-ui.ts`）；
4. 修改 GUI 内任一配置后，终端 `pi` 立即可见新配置（auth.json/models.json/settings.json 三文件回归）；
5. 工作区验收：tab 预览/固定/徽标语义正确（04 §1.3），布局记忆跨重启生效（04 §1.8）。

### 3.1 M1 执行工作包（2026-09-22 排定，顺序经依赖调整）

| WP | 内容 | 位置理由 | 状态 |
|---|---|---|---|
| 1 | 工作区布局 v1：dockview 编辑区 + 左右视图轨 + 底部面板 + tab 模型（预览/固定/徽标）+ 布局持久化 | 结构地基，后续功能都往骨架里插 | ✅ |
| 2 | 会话管理：sessions/list.rs（扫描+watcher）+ 侧栏会话视图 + new/switch/rename/delete/export/fork/clone | G2 核心；依赖 WP1 侧栏 | ✅ |
| 3 | 模型/Thinking + Composer 完整态：Cmd+L 选择器、thinking 循环、图片粘贴/拖拽、斜杠补全 | 小而高频，提前保持日常可用 | ✅ |
| 4 | Monaco 基座：worker/CSP/懒加载/实例池/主题注册（风险 spike 前置） | M1 最大技术未知数，尽早排雷 | ✅ |
| 5 | 设置中心：auth/models/settings 三文件表单化 + 原始编辑器 + schema 校验 | 依赖 WP1/WP4 | ✅（schema 校验 M2） |
| 6 | 快捷键 v1 + 命令面板（CommandRegistry/KeymapService/Cmd+K） | 独立性强 | ✅（含改绑 UI + 冲突检测） |
| 7 | 轨迹视图 v1（对话\|轨迹页签、事件流、context_edit 渲染） | 数据源现成 | ✅ |
| 8 | 收尾验收：bash 面板、setStatus/setWidget 槽位、三条用户故事 E2E、rpc-demo 实测、G2 勾验 | 对齐 M1 五条验收 | ✅（bash=RPC pre 流，xterm M2；E2E=Playwright mock 冒烟，tauri-driver 实机 E2E M2） |

> 用户调整顺序：1 → 3 → 2 → 4（小赢前置）；5–8 顺延。

### 3.2 M1 验收记录（2026-09-22）

1. ✅ 用户故事 1/2/3（mock 模式 Playwright 冒烟：`scripts/verify-m1.mjs` / `scripts/shot.mjs`）；tauri-driver 实机 E2E 排 M2；
2. ✅ G2 对照 02 §3.2 映射表：对话/模型/会话/压缩/统计/导出/命令面板全通（M1 范围内逐行勾验；auth/models/settings 写入即落盘，新会话生效）；
3. ✅ Extension UI：五类 dialog + notify/setStatus/setWidget/setTitle/set_editor_text 全部有落点（02 §8 表）；
4. ✅ 三文件回归：auth/models/settings 写入为 pi 标准文件（原子写 + .bak）；
5. ✅ 工作区：tab 预览/固定/徽标语义 + 布局持久化跨重启（dockview toJSON + remap）。

M1 修正记录（实现期发现）：

- **React Compiler 缓存外部可变状态**：render 中读取模块级 registry（`allCommands()`）被编译器当纯函数缓存，首帧空数组永久复用 → 该类文件加 `"use no memo"` 或改为 store 订阅（04 §3.3 增补红线）；
- **webview 重载孤儿 worker**：pi 不随 stdin EOF 退出 → `boot_reset` 命令由新 JS 上下文首先调用收割；
- **monaco exports map 重写错误**：vite alias 直达 `node_modules/monaco-editor/esm` + 类型 shim（10 §2.2 落地记录）；
- **布局尺寸**：react-resizable-panels v4 的 `defaultSize` 必须带单位（`"20%"`），纯数字按像素；
- **dockview v8 主题**：`DockviewReact` 必须显式传 `theme`（对象形式），否则内容不渲染。

## 4. M2 · 性能达标（约 2 周，可与 M1 部分并行）

**范围**：05 预算全绿。

- 空闲回收 + maxWorkers + 休眠标签；
- 性能场景库 S1–S6 + nightly 工作流 + 预算断言；
- Shiki 按需化、图片 asset 协议、content-visibility 全量落位（04 §5、05 §5）；
- **独立发布**：捆绑 pi 官方 standalone（08 §7.1：下载 + SHA256 校验进 bundle.resources，发现顺序插入内置档，full/lite 双 SKU）。

**验收**：05 §2 预算表逐条达标并留有 CI 证据链接；`perf-lite`（S1/S3 缩短版）进 PR 必跑。

### 4.1 M2 实现记录（2026-09-23）

| 工作包 | 落位 | 状态 |
|---|---|---|
| 空闲回收（05 §4.1） | `registry.rs`：Tab.last_activity（worker_of 触碰）+ `reap_idle`；lib.rs 60s tick（全应用唯一周期任务，05 §3.1）；idleTimeoutMin 可配（0=永不），默认 10min | ✅ |
| maxWorkers（05 §4.2） | `tab_create` 超限报 `MAX_WORKERS`；前端 `createTabGuarded` 弹窗"一键回收最闲"（`tab_sleep_idlest`）后重试；默认 8 | ✅ |
| 休眠标签（05 §4.3） | `tab_sleep` 回收 worker 保留游标（唤醒不计入崩溃重启上限）；前端 sleepTab 丢弃 messages/trajectory/bash 内存，激活/发送时透明唤醒 + get_messages 重建；Cmd+Shift+S / 命令面板 | ✅ |
| 性能配置 | `~/.piggy/config.json`（PerfConfig：maxWorkers/idleTimeoutMin，clamp + 原子写）；设置 → Piggy 性能 | ✅ |
| 渲染落位（05 §5.2） | 转录行/轨迹行 `content-visibility: auto + contain-intrinsic-size` | ✅ |
| Shiki 按需（04 §5.2） | `CodeBlock.tsx`：shiki core + oniguruma 引擎 + 语言包全部动态 import；语言 LRU ≤16（超出重建 highlighter）；IntersectionObserver 进视口才高亮；github-light/dark 双主题 CSS 变量 | ✅ |
| 图片 asset 协议（04 §5.3） | tauri `assetProtocol`（scope $HOME/$TMP/$APPDATA）+ `convertFileSrc`；协议内联 base64 图按对象缓存转 Blob URL（不重复解码、不入 React 状态大字符串） | ✅ |
| 万条消息打开（05 §2 预算 <1.5s） | messagesStore 去重 O(n²)→Set（05 §4.4 纪律）：10k hydrate 8960ms → **24.7ms**（perf S3 实测） | ✅ |
| 场景库 S1–S6（05 §6.2） | `apps/desktop/scripts/perf-run.mjs`：S1 流式帧率/长任务、S2 8tab、S3 万条打开、S4 100 工具并发、S5 崩溃 resync、S6 空载 heap 漂移；预算断言不过 exit 1，结果写 perf-results/*.json | ✅ |
| CI（05 §6.3） | `ci.yml` 增 perf-lite（S1/S3 缩短版，PR 必跑）；`perf-nightly.yml` 全场景 + 产物留存 30 天 | ✅ |
| 独立发布（08 §7.1） | `scripts/fetch-pi-standalone.mjs`（GitHub Releases 下载 + SHA256 强校验 + tar 解包 → `src-tauri/resources/pi/`）；`tauri.full.conf.json`（full SKU bundle.resources）；发现链插入内置档（显式 > PI_BIN > 内置 > PATH，02 §2.1）；lite=默认 conf 不捆绑 | ✅（脚本+接线；release 资产直链需发布时按实际资产名核对 URL 模板） |
| M1 顺延：Monaco schema 校验 | `monaco-setup.registerPiggySchemas`（pi settings/models 双 schema）+ MonacoHost 显式模型 URI | ✅ |

perf-lite 本机实测（2026-09-23，M 系列）：S1 流式 60fps / 0 longtask（8s 灌帧）；S3 10k hydrate 24.7ms / 滚动 3 longtask（≤3）。

M2 顺延项（记入 M3/M4 或独立跟进）：

- **xterm.js bash 面板**（10 §4，M1 WP8 顺延）：M1 以 RPC pre 流呈现；终端仿真 M3 评估；
- **tauri-driver 实机 E2E**（M1 验收顺延）：当前 perf/冒烟均为 Playwright + mock 底座；实机 E2E 依赖 tauri-driver 稳定，跟进；
- **三轨时间线（甘特）**（04 §1.10 顺延）：依赖事件级时间戳埋点（pi 事件含 timestamp，渲染层排期 M3 随 Fleet 面板）；
- **进程资源采样**（05 §6.1 sysinfo → 状态栏资源抽屉）：工具链增强，M3 与 Fleet 资源回归一并做；
- **cargo bench 基线**（05 §6.1 codec/合帧吞吐阈值）：框架就绪，基线数据入 nightly。

## 5. M3 · 子代理（约 3 周）

**范围**：06 双层。

- A 层：fleet/ 模块、模板 4 个、DAG 调度、lane 提升/收编、worktree 辅助；
- Fleet lanes 自动分列并排监控（复用 M1 已引入的 dockview 分组能力，04 §1.8）；
- B 层：piggy-bridge v1（status/steer/interrupt/stop/resume + 能力协商）；
- Fleet 面板统一视图。

**验收**：

1. parallel-review 模板对真实 PR 跑通：3 lane 并行 → 汇总（手工验收记录）；
2. 安装 pi-subagents 的会话中，模型派发的子代理在 Fleet 面板可见、可 steer（`/piggy:steer` 回执 `deliveryStatus` 呈现）；
3. 未安装 pi-subagents 时 bridge 的降级提示正确；
4. Fleet 运行不影响 05 预算（lane 计入 maxWorkers 的资源回归测试）。

### 5.1 M3 实现记录（2026-09-23；状态列已按当日晚的实测复核修正）

> **修正说明**：本表 2026-09-23 首版多行标了 ✅，但 19:00 复核时发现其中两行与代码不符
> （B 层扩展三处 API 全错且从未被加载；Fleet 面板缺 steer/提升/刷新三个控件）。
> 现在的状态列只写**已验证**的事实，验证方式见表下 §5.2。

| 工作包 | 落位 | 状态 |
|---|---|---|
| A 层 fleet 模块（06 §3） | `src-tauri/src/fleet.rs`：FleetRun 状态机（Running→Done/Aborted）、Lane 状态（Pending/Running/Settled/Failed）、`build_run`（环检测 fail-fast）、`ready_lanes` 纯函数 DAG 调度、`render_prompt`（{task}/{upstream} 注入）、`create_worktree`（git worktree，name 净化防逃逸、存在即复用）、`lane_step`（lane 状态机纯函数）、`last_assistant_text`（结果收集）、`should_keep_waiting`（容量排队） | ✅ 单测 22 条 + 契约测试 C14 真跑 |
| 内置模板 ×4（06 §3.2） | `builtin_templates()`：scout-review-build / parallel-review / research / custom（纯 JSON，用户可编辑=后续自定义入口） | ✅ |
| lane = registry tab（06 §3.5） | lane 复用 `registry.create_tab`（NoSession，不污染会话列表；计入 maxWorkers，05 §4.2/06 §3.4 排队语义）；"提升为标签页"= `fleet_open_lane` 返回 snapshot → 前端 openSessionTab | ✅ 前端按钮已接（`FleetView.promote`）+ 单测 |
| 调度胶水 | `commands.rs schedule_run/start_ready_lanes/watch_lane`：worker state 订阅 → `fleet::lane_step` 判 settle → `get_messages` 提取最后 assistant 文本 → settle → 驱动下游；Crashed/Stopped 计 Failed；`fleet_start/abort/steer/list/templates/open_lane` 命令 + `fleet:changed` 全量快照事件；**容量不足时自愈重试**（旧版只 `continue`，会把 run 永久卡在 Pending） | ✅ 单测 + 契约测试 C14（真实 pi） |
| B 层 piggy-bridge（06 §4） | `packages/piggy-bridge/src/index.ts`（TS，类型对着 pi 0.87.1 真实 `ExtensionAPI` 校验）：`/piggy:status|spawn|steer|interrupt|stop|resume|cost|fleet-refresh`；`pi.events` 上的 RPC v1（ready/request/reply 关联 + 超时 + 退订）；`PIGGY:1:` 数据面 + `setWidget(key,…)` 状态行 + notify；未装 pi-subagents 明确降级；子代理完成时主动推快照 | ✅ 单测 32 条 + 契约测试 C12/C13（真实 pi，含降级路径） |
| Fleet 面板（06 §5） | 右栏 "Fleet（子代理）"：A 层 runs（模板选择+任务输入+启动/中止 + lane 状态/结果预览 + **steer 输入框** + **提升为标签页**）、B 层（活动 tab 快照 + **刷新按钮** + 未安装降级 + 同步时间）；`fleetStore` 统一视图模型 + `PIGGY:1` 前缀劫持（DialogRouter set_editor_text 拦截） | ✅ 组件测试 9 条 + 真浏览器核对（`ui:startup` 第 4 段） |
| 测试 | Rust 单测 89（含 fleet 22、process argv 8、resources 4）；契约 C12–C14；前端 `fleet.test.ts` / `fleet-view.test.tsx`；bridge 包 32；真浏览器 `ui:startup` 覆盖 A 层启动 + B 层数据面 | ✅ |

### 5.2 M3 实机验收记录（2026-09-23 晚）

| 验收项（§5 原表） | 结论 | 证据 |
|---|---|---|
| 1. parallel-review 对真实代码跑通 | ✅ 等价验证：契约测试 C14 用两 lane DAG 真跑（scout→汇总），a settle → b 就绪 → `{upstream}` 注入 a 的真实输出 → b 回复 BRAVO-OK → run 转 Done。**未做**：在 GUI 里对真实仓库点一次 `parallel-review`（需要人开 `tauri dev`） | `pnpm test:contract -- c14` |
| 2. 会话内子代理可见、可 steer | ⚠️ 部分：`/piggy:spawn scout …` 真机派发成功（`details.asyncId` 回传、`async-complete` 主动推送、lane 行正确显示为 failed）；但**子代理本体没能跑起来**——原因是本机 pi 安装缺 `marked`（见下），不是 Piggy 或 bridge 的问题。steer 的 RPC 参数与回执解析有单测覆盖，未做真机 steer 往返 | 02 §9 C12；`~/…/pi-subagents-uid-501/async-subagent-runs/<id>/runner.stderr.log` |
| 3. 未装 pi-subagents 时降级正确 | ✅ 真机：空 `PI_CODING_AGENT_DIR` → `{ok:false,error:"pi-subagents 未安装"}` + 面板降级文案 | 02 §9 C13 |
| 4. Fleet 不影响 05 预算 | ✅ lane 计入 maxWorkers；**新增**容量排队的自愈重试（`should_keep_waiting`）| `fleet::tests::capacity_wait_*`、`process::tests` |

**环境阻塞（非 Piggy 缺陷）**：本机 pi 0.87.1 的 pnpm 安装树里缺 `marked`
（`@earendil-works/pi-tui` 声明依赖 `marked@18.0.11`，但 store link 与 global 两处都没有）。
主 pi 进程不 import 那条路径所以日常无感，但 pi-subagents 的 **async runner 子进程**会解析到它并直接崩：
`ERR_MODULE_NOT_FOUND: Cannot find package 'marked' imported from …/pi-tui/dist/index.js`。
修复=`重装 pi`（`pnpm add -g @earendil-works/pi-coding-agent@0.87.1`）。
在此之前，B 层里"派发子代理"这个动作在真机上会以 failed 收场（通道本身是通的）。

**仍未做**：dockview lane 分列监控（随"提升为标签"手工拖拽即可，独立自动分列 = M4 打磨）；
模板自定义编辑（`custom` 模板仍是空 lane 集）；`/piggy:cost` 的真机往返（本机 pi-subagents 0.70.1 不声明该能力）。

## 6. M4 · 打磨与发布（约 2–3 周）

**范围**：

- OAuth 登录内嵌终端（xterm.js + portable-pty，跑 `pi /login`，02 §2.10 路线）；
- 文件视图”快捷编辑”（受限直写 + 外部变更警示，00 NG4）、资源浏览器（04 §1.5）；
- i18n（zh-CN/en-US）、托盘、全局唤起默认开启项评审、自动更新（stable/beta）；
- 打包签名（macOS notarization / Windows signing）、崩溃安全（Rust panic hook → 本地日志）；
- 文档终审：README 快速上手 + docs 与实现逐节对齐审计。

**验收**：00 §7 成功判据两项用户测试通过；三平台安装包在干净虚拟机安装即用。

### 6.1 M4 实现记录（2026-09-23）

| 工作包 | 落位 | 状态 |
|---|---|---|
| 崩溃安全 | `lib.rs install_panic_hook`：panic 转储 `~/.piggy/logs/panic-*.log` 后交回默认 hook | ✅ |
| 托盘 | `tray-icon` feature + TrayIconBuilder（显示/隐藏 + 退出） | ✅ |
| 全局唤起 | `tauri-plugin-global-shortcut`：Cmd/Ctrl+Shift+P 显示并聚焦主窗（Rust 侧注册，无 webview 权限面） | ✅ |
| 登录内嵌终端 | `src-tauri/src/pty.rs`（portable-pty：登录 shell、TERM=xterm-256color、输出泵→`pty:out:<id>`、resize/close 幂等）+ `LoginTerminalModal`（@xterm/xterm + fit；关闭即 close 回收）；设置 → 认证页入口 | ✅（真机 OAuth 流程待用户实测） |
| 资源浏览器 | `fs_list_dir`（项目根子树、守卫校验、目录优先排序）+ 右栏 📁 懒加载树 → 点击打开只读预览 | ✅ |
| 快捷编辑（NG4） | `fs_guard.rs`（子树校验/`..` 拒绝/mtime 冲突语义，≤1MB）+ `fs_write_edit`（CONFLICT 拒绝 + 返回新 mtime）+ FilePreview 编辑模式（有 root 才出编辑钮） | ✅ |
| i18n | `lib/i18n.ts`：zh-CN/en-US 词典 + t() 回退链 + setLang 持久化/事件；已接 palette/welcome 文案；语言切换 UI 与全量文案迁移 = 持续项 | ✅ 骨架 |
| 自动更新 | `tauri-plugin-updater` 已接入构建（check 未被调用即零风险）；endpoints/签名密钥/双通道 = 发布基建（需苹果/微软证书与更新服务器），随打包签名一同落地 | 🔧 结构就绪 |
| 打包签名 | macOS notarization / Windows signing 需要证书；`tauri.full.conf.json`（full SKU 捆绑 pi）+ `fetch-pi-standalone.mjs`（SHA256 强校验）已就绪，发布清单见 08 §7.1 | 🔧 脚本就绪 |
| 文档终审 | 本节 + 05/09 各落地记录；README 快速上手与全量对齐审计留发布前一轮 | 🔧 部分 |

M4 测试：fs_guard ×4（子树/`..`/相对路径/mtime 冲突语义）、pty ×3（shell 选择/echo 回读真实 PTY/会话表幂等）；前端 i18n ×4（键一致/命中回退/切换事件）。

## 7. 风险登记册

| # | 风险 | 概率/影响 | 缓解 | 触发的文档调整 |
|---|---|---|---|---|
| R1 | pi RPC 协议演进破坏兼容 | 中/高 | 未知字段透传（02 §5.1）+ 契约测试矩阵（08 §5）+ 版本门禁（02 §2.1） | 02 §9 增补新契约项 |
| R2 | `--session` 等 CLI 参数在 rpc 模式不生效（C1） | 中/中 | 已有 B 计划：spawn 后 `switch_session` | 02 §2.2 回填 |
| R3 | 同会话文件双开（GUI + 终端 pi）数据竞争（C4） | 低/高 | mtime 活跃检测 + 警示；互斥仅限 GUI 内部 | 02 §6.3 |
| R4 | antd 视觉与 VS Code 形态冲突 | 低/低 | antd v6 原生支持 React 19（v5 补丁包已移除，原兼容风险消除）；全部 token 由 VS Code 主题派生覆写，调不平处改自研件（04 §6 裁决） | 04 §6 |
| R5 | Linux webkitgtk 性能/兼容不达标 | 中/中 | 平台降级为 P2 承诺（00 NG5）；CI 只做功能不锁预算 | 05 §2 标注平台豁免 |
| R6 | `set_editor_text` 劫持通道被 pi 语义变化影响（06 §4.2） | 低/中 | 双端同仓原子演进 + 版本前缀 `PIGGY:1:` 协商 | 06 §4 更新通道设计 |
| R7 | pi-subagents RPC v1 变更 | 中/中 | ping 能力协商 + 动词最小集 | 06 §4.3 |
| R8 | Node worker 内存超预算（模型长输出） | 中/中 | maxWorkers + 回收 + 休眠（05 §4）；S2 场景盯防 | 05 §2 调整预算或上限默认值 |
| R9 | 契约测试对 CI 的 pi 版本漂移 | 高/低 | CI 固定版本 + nightly 跑 latest 双通道 | — |

## 8. 里程碑外的持续事项

- 文档-实现对齐审计：每里程碑末做一次（M4 终审全覆盖）；
- 契约矩阵扩展：pi 每个 minor 版本自动跑 nightly 契约（R1 早期预警）；
- 性能趋势看板：nightly 数据入库（05 §6.3），回归自动开 issue。
