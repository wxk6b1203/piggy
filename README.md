# Piggy 🐷

**pi 的图形驾驶舱**：以 [pi](https://github.com/earendil-works/pi) 为引擎、Tauri 2 为壳、pi RPC mode 为集成协议的桌面 GUI Agent。Piggy 不复制 pi 的大脑——它监督、转发、呈现 pi 进程，与 pi CLI 完全同构（会话/配置双向互通）。

设计与规划文档：[docs/README.md](docs/README.md)（当前阶段：**M0 已完成**，见 [docs/09-roadmap.md](docs/09-roadmap.md)）。

## 当前状态（M0）

✅ 单 tab 对话管道端到端可用：流式渲染（合帧 ≤60Hz + 实时块直写 DOM）、工具调用卡片、Esc 中断还原、Extension UI 弹窗、崩溃自动复活（游标补齐）、暗/亮主题。

## 环境要求

- Node ≥ 20（开发用 24）、pnpm ≥ 10
- Rust stable（≥ 1.80）
- **pi 在 PATH 上**（`pi --version`，当前契约锚定 0.87.0；M2 起应用可内置官方 standalone，免安装 pi）；或设置 `PI_BIN`

## 快速开始

```bash
pnpm install
pnpm dev            # 或 pnpm tauri dev：启动桌面应用（开发模式）
```

## 测试

```bash
pnpm test                 # 前端 + 协议包（vitest）
pnpm test:rust            # Rust 单元 + fixtures 对拍
pnpm test:contract        # 契约测试 C1–C10 + E2E（真实 pi；走已配置 provider，最小消耗）
```

## 仓库结构

```
apps/desktop/        # Tauri 应用（src/ 前端 · src-tauri/ Rust 核心）
packages/pi-protocol/ # pi RPC 协议 TS 类型 + Rust↔TS 对拍 fixtures
docs/                # 设计文档（SSOT）
```

模块划分、接口约定、质量门与性能预算见 docs/03、08、05。

## 隐私

零遥测。API Key 只存在于 pi 自己的 `~/.pi/agent/auth.json`，Piggy 不存储任何密钥。

## 授权

Piggy 是自由软件，按 **GNU 通用公共许可证第 3 版（或任何更新版本）** 发布：
SPDX 标识 `GPL-3.0-or-later`。完整条款见 [LICENSE](LICENSE)（GPLv3 原文，逐字节取自
<https://www.gnu.org/licenses/gpl-3.0.txt>，sha256 `3972dc97…`，未做任何改动）。

```
Piggy —— pi 的图形驾驶舱
Copyright (C) 2026 wxk6b1203

本程序是自由软件：你可以按自由软件基金会发布的 GNU 通用公共许可证条款
（第 3 版，或你选择的任何更新版本）重新分发和/或修改它。

本程序的分发是希望它有用，但**没有任何担保**，甚至没有适销性或特定用途适用性的
默示担保。详见 GNU 通用公共许可证。

你应该已经随本程序收到一份 GNU 通用公共许可证的副本；如果没有，见
<https://www.gnu.org/licenses/>。
```

**第三方组件**：Piggy 复用/分发了若干上游资产（VS Code codicons 与主题 tokenColors、
seti-ui 图标、Monaco，以及 full SKU 捆绑的 **pi** 本体），各自的许可与署名义务登记在
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。这些组件的许可（MIT / CC-BY-4.0）
都与 GPLv3 兼容，但**署名必须保留**——新增可复用资产时按该文件的约定登记。

> 注意：GPL 是**传染性**许可。分发修改版（含打包好的安装包）时，必须一并提供
> 对应的完整源码；同时不得给下游附加更严格的条款。
