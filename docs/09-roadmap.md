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

## 4. M2 · 性能达标（约 2 周，可与 M1 部分并行）

**范围**：05 预算全绿。

- 空闲回收 + maxWorkers + 休眠标签；
- 性能场景库 S1–S6 + nightly 工作流 + 预算断言；
- Shiki 按需化、图片 asset 协议、content-visibility 全量落位（04 §5、05 §5）。

**验收**：05 §2 预算表逐条达标并留有 CI 证据链接；`perf-lite`（S1/S3 缩短版）进 PR 必跑。

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

## 6. M4 · 打磨与发布（约 2–3 周）

**范围**：

- OAuth 登录内嵌终端（xterm.js + portable-pty，跑 `pi /login`，02 §2.10 路线）；
- 文件视图“快捷编辑”（受限直写 + 外部变更警示，00 NG4）、资源浏览器（04 §1.5）；
- i18n（zh-CN/en-US）、托盘、全局唤起默认开启项评审、自动更新（stable/beta）；
- 打包签名（macOS notarization / Windows signing）、崩溃安全（Rust panic hook → 本地日志）；
- 文档终审：README 快速上手 + docs 与实现逐节对齐审计。

**验收**：00 §7 成功判据两项用户测试通过；三平台安装包在干净虚拟机安装即用。

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
