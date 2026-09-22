# Piggy 设计文档

Piggy 是一个以 [pi](https://github.com/earendil-works/pi) 为引擎、**Tauri 2** 为壳、**pi RPC mode** 为集成协议的桌面 GUI Agent 服务。本文档集是项目的唯一设计事实来源（Single Source of Truth），覆盖架构、模块、协议对接、前端、性能、子代理、快捷键、工程结构与路线图。

## 文档地图与阅读顺序

| # | 文档 | 内容 | 适合谁 |
|---|------|------|--------|
| 00 | [overview.md](00-overview.md) | 愿景、目标/非目标、用户故事、术语、技术栈总览 | 所有人，先读 |
| 01 | [architecture.md](01-architecture.md) | 整体架构、进程模型、数据流、关键技术选型与理由 | 所有人 |
| 02 | [pi-rpc-integration.md](02-pi-rpc-integration.md) | pi RPC 协议对接：命令/事件映射、生命周期、容错、Extension UI 子协议 | 后端/协议开发 |
| 03 | [module-design.md](03-module-design.md) | Rust 侧与前端侧的模块划分、职责边界、接口约定 | 全体开发 |
| 04 | [frontend-design.md](04-frontend-design.md) | 前端架构：布局、状态管理、流式渲染分帧管线、antd 使用边界 | 前端开发 |
| 05 | [performance.md](05-performance.md) | 内存/CPU/GPU 优化专章、性能预算表、测量方法 | 全体开发 |
| 06 | [subagents.md](06-subagents.md) | 子代理双层设计：宿主侧 Fleet 编排 + pi-subagents 桥接 | 后端/前端 |
| 07 | [keybindings-and-commands.md](07-keybindings-and-commands.md) | 快捷键体系、命令面板、默认键位表、可配置方案 | 前端开发 |
| 08 | [project-structure.md](08-project-structure.md) | 仓库结构、monorepo 布局、构建链、测试与质量策略 | 全体开发 |
| 09 | [roadmap.md](09-roadmap.md) | 里程碑 M0–M4、验收标准、风险登记 | 所有人 |
| 10 | [vscode-assets.md](10-vscode-assets.md) | VS Code 资产复用清单、Monaco 基座落地方案、源码参考点 | 前端开发 |
| 11 | [dsh-reference.md](11-dsh-reference.md) | DSH 界面参考裁决（轨迹视图、Composer 细节、侧栏语义） | 前端开发 |

推荐阅读路径：

- **快速理解项目**：00 → 01 → 09
- **开始写 Rust 侧代码**：01 → 02 → 03 → 08
- **开始写前端代码**：01 → 04 → 10 → 07 → 05
- **做子代理功能**：01 → 06 → 02
- **评审性能**：05 → 04 §4 → 02 §5

## 闭环承诺

本文档集自成闭环，规则如下：

1. **任何进入代码的决策必须能溯源到某篇文档**；无法溯源时，先补文档（或 ADR）再写代码。
2. **每个模块**（03）都能在架构图（01）中找到位置；**每条 UI 操作**都能在协议映射表（02）中找到对应的 RPC 命令；**每个性能预算**（05）都对应 04/02 中的具体机制。
3. 协议对接以 pi 官方文档为准（`pi --version` 对应版本的 `docs/rpc.md` / `docs/sdk.md` / `docs/session-format.md`）；02 中所有"待契约验证"标记必须在 M0 契约测试中落实（见 09 M0 验收标准）。
4. 文档随代码演进：行为变更 PR 必须附带对应文档修改；docs 评审是代码评审的一部分。

## 顶层技术栈（详见 01 选型论证）

| 层 | 选择 |
|----|------|
| 桌面壳 | Tauri 2（Rust 核心） |
| 引擎集成 | pi RPC mode（每会话一个 `pi --mode rpc` 子进程，JSONL over stdio） |
| 前端构建 | Vite + React 19 + React Compiler（babel-plugin-react-compiler） |
| UI 组件 | antd 6（≥6.6；应用壳/设置/表单，VS Code 主题覆写）+ 自研轻量渲染器（会话转录流） |
| 编辑器/终端 | Monaco Editor（编辑基座，懒加载）+ xterm.js（终端）+ dockview（编辑区布局）（见 10） |
| 状态管理 | zustand（细粒度订阅 + 瞬态更新双通道） |
| 子代理 | 宿主侧 Fleet 编排 + piggy-bridge 扩展桥接 pi-subagents |

## 约定

- 文档语言：中文，技术名词保留英文。
- 交叉引用格式：`NN §x.y` 指向第 NN 篇文档的章节。
- 标记 `【契约验证】`：表示该行为来自 pi 文档推断，需在 M0 契约测试中确认（见 02 §9）。
- 图表：Mermaid（GitHub 原生渲染）。
