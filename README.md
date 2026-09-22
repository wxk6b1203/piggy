# Piggy 🐷

**pi 的图形驾驶舱**：以 [pi](https://github.com/earendil-works/pi) 为引擎、Tauri 2 为壳、pi RPC mode 为集成协议的桌面 GUI Agent。Piggy 不复制 pi 的大脑——它监督、转发、呈现 pi 进程，与 pi CLI 完全同构（会话/配置双向互通）。

设计与规划文档：[docs/README.md](docs/README.md)（当前阶段：**M0 已完成**，见 [docs/09-roadmap.md](docs/09-roadmap.md)）。

## 当前状态（M0）

✅ 单 tab 对话管道端到端可用：流式渲染（合帧 ≤60Hz + 实时块直写 DOM）、工具调用卡片、Esc 中断还原、Extension UI 弹窗、崩溃自动复活（游标补齐）、暗/亮主题。

## 环境要求

- Node ≥ 20（开发用 24）、pnpm ≥ 10
- Rust stable（≥ 1.80）
- **pi 在 PATH 上**（`pi --version`，当前契约锚定 0.86.1）；或设置 `PI_BIN`

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
