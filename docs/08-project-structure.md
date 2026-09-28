# 08 · 工程结构、构建链与质量策略

> 上游：[03-module-design.md](03-module-design.md) · 下游：[09-roadmap.md](09-roadmap.md)

## 1. 仓库布局（pnpm monorepo + Tauri）

```
piggy/
├─ docs/                          # 本文档集（设计 SSOT）
├─ apps/
│  └─ desktop/                    # Tauri 应用
│     ├─ src/                     # React 前端（03 §3）
│     │  ├─ app/  features/  stores/  lib/  components/  hooks/
│     │  └─ main.tsx
│     ├─ src-tauri/               # Rust 主进程（03 §2）
│     │  ├─ src/
│     │  │  ├─ main.rs  lib.rs
│     │  │  ├─ commands/          # IPC 薄层（pi_*.rs session_*.rs config_*.rs fleet_*.rs app_*.rs）
│     │  │  ├─ pi/                # discovery process codec client protocol coalesce
│     │  │  ├─ sessions/          # registry list tree transcript（转录取页，03 §2.19）
│     │  │  ├─ config/            # paths auth models settings app（03 §2.10/§2.18）
│     │  │  ├─ provider/          # 提供商目录/总览/编辑/联网列模型（03 §2.12）
│     │  │  ├─ plugin/            # 插件盘点/安装升级/启停/路径登记（03 §2.15）
│     │  │  ├─ fleet/
│     │  │  ├─ legal.rs           # 许可与第三方声明 + 系统菜单（03 §2.17）
│     │  │  └─ events.rs  shortcuts.rs
│     │  ├─ tests/path_separators.rs # join 字面量不许带分隔符（03 §2.18）
│     │  ├─ tests/contract.rs     # 02 §9 契约测试（需 PATH 上的 pi）
│     │  ├─ tests/menu_smoke.rs   # 系统菜单结构（harness=false：muda 只能在主线程建菜单）
│     │  ├─ capabilities/         # Tauri 权限清单（§6）
│     │  └─ tauri.conf.json
│     ├─ index.html
│     ├─ vite.config.ts           # @vitejs/plugin-react + babel-plugin-react-compiler
│     └─ package.json
├─ packages/
│  ├─ pi-protocol/                # TS 协议类型 + zod schema（与 Rust protocol.rs 对拍）
│  │  └─ src/{commands,events,messages,entries}.ts
│  └─ piggy-bridge/               # pi 扩展（06 §4，独立发布 npm）
│     └─ src/index.ts
├─ pnpm-workspace.yaml
├─ package.json                   # workspace root：scripts · devDeps（lint/test 工具）
├─ tsconfig.base.json
├─ LICENSE                        # GPLv3 原文（逐字节取自 gnu.org，未改动）
├─ THIRD_PARTY_NOTICES.md         # 第三方资产的来源与署名义务（新增资产必须登记）
├─ .github/workflows/             # ci.yml · nightly-perf.yml · release.yml
└─ README.md
```

许可的**事实源**是三处，一致性由 `src/test/license.test.ts` 锁住：`LICENSE`（GPLv3 原文）、
每个 `package.json` / `Cargo.toml` 的 `license: GPL-3.0-or-later`、README「授权」一节
（`or later` 只能由项目自己的声明表达——GPLv3 原文本身不含这句话）。
第三方署名义务见 `THIRD_PARTY_NOTICES.md`；**full SKU 随包分发 pi**，其 MIT 声明副本
（`src-tauri/resources/pi-LICENSE.txt`）登记在两个 SKU 的 `bundle.resources` 里。

为什么 monorepo：piggy-bridge 与主应用**共享私有协议语义**（`PIGGY:1:` 载荷、命令集），同仓演进、原子 PR；pi-protocol 与 Rust 类型对拍需要同一 fixture 集，跨仓无法维持。

## 2. 构建链

| 环节 | 工具 | 要点 |
|---|---|---|
| 前端 | Vite 6（`@vitejs/plugin-react` + `babel-plugin-react-compiler`） | SWC 不用于 JSX（compiler 是 Babel 插件，走官方组合）；生产构建禁 sourcemap 内联 |
| 类型 | tsc --noEmit（独立于构建的 typecheck 脚本） | workspace 引用走 `exports` 字段 |
| Rust | cargo（workspace 单 crate + 未来按需拆分） | `cargo clippy -D warnings`；MSRV 1.80 |
| 桌面打包 | `tauri build`（dmg/nsis/appimage）+ tauri-plugin-updater | 签名与更新元数据在 release.yml（M4） |
| 格式化 | prettier + rustfmt（CI 校验） | — |
| Lint | eslint（含自定义规则，§4）+ clippy | — |

## 3. 依赖纪律

- 前端运行时依赖白名单：`react` `react-dom` `antd`（≥6.6，React 19 原生支持，无需 v5-patch 包）`@ant-design/icons`（v6，与 antd 配套） `zustand` `immer` `@tanstack/react-virtual` `@tauri-apps/api` `@tauri-apps/plugin-*` `unified/remark/rehype 系` `shiki` `monaco-editor`（ESM 按需 + workers）`@monaco-editor/react` `@vscode/codicons` `@xterm/xterm` + addons `react-resizable-panels` `dockview` `zod`。CodeMirror 全家不在白名单；Monaco 禁全语言打包（lint 强制，10 §2.2）；antd 遵循 04 §6（VS Code 形态覆写、mask blur 关闭、禁用 Splitter）。新增依赖 = PR 说明 + 体积/性能影响评估；
- Rust 依赖最小化：tokio、serde/serde_json、tauri、notify、sysinfo、portable-pty（M4）；不引重型框架；
- `reqwest` + `rustls` 是**例外但为零成本**：两者早已在依赖树里（`tauri-plugin-updater` 用它们），
  加为直接依赖只是让"检测 / 获取可用模型"能真发一次 HTTP（03 §2.12）。features 必须与 updater
  保持一致（`default-features = false, features = ["json","stream"]` + `rustls/ring`）：
  换成 reqwest 的默认 features 会把 rustls 的 aws-lc-rs 供应商拽进来（镜像上取不到，且平白多编一份 TLS 栈）。
  注意 reqwest 走的是 rustls 的 **no-provider** 变体 —— 建 Client 前必须自己
  `install_default()`，否则**直接 panic**（03 §2.12 要点 3）；
- **零遥测 SDK、零分析 SDK**（00 隐私立场；崩溃遥测若未来引入须 opt-in 并单列 ADR）。

## 4. 代码规范与质量门（PR 阻断项）

1. `tsc` / `clippy -D warnings` / `eslint --max-warnings 0` 通过；
2. **eslint 自定义规则**：
   - `apps/desktop/src/features/chat/**` 禁 `antd` 导入（04 §2 铁律）；
   - `pi:frame` 处理路径禁 `setState` 类 API（04 §4.1，按文件路径匹配）；
   - 禁 `setInterval`（05 §3.1，白名单：回收计时器所在文件）；
   - 禁 `dangerouslySetInnerHTML`（白名单：Shiki/rehype 输出容器，必须伴随 sanitize 上游断言注释）；
3. 协议类型改动必须同步 `packages/pi-protocol` 与 Rust `protocol.rs`（对拍测试强制，§5）；
4. 行为变更必须附 docs/ 修改（docs README 闭环规则 2/4）；
5. 性能红线清单（04 §9）勾选确认。

## 5. 测试策略（金字塔）

| 层 | 范围 | 工具 |
|---|---|---|
| Rust 单元 | codec（分帧边界）、coalesce（合帧语义）、config 原子写、registry 状态机 | `cargo test` |
| 协议对拍 | Rust 序列化 ↔ TS zod 对同一 fixture 集双向解析 | fixture JSON 入库，两侧测试读取（CI 作业 `contract-matrix`） |
| 契约测试 | 02 §9 C1–C11 对真实 pi 二进制 | `tests/contract.rs`（本地/CI 装 pi；CI 环境 `npm i -g @earendil-works/pi-coding-agent`） |
| 静态纪律 | 跨平台路径不许在 `join` 字面量里写分隔符（macOS 上测不出，只能扫源码） | `tests/path_separators.rs` |
| 前端单测 | store reducer（commit 批量应用）、视图模型转换、键位解析、Windows 路径取末段 | vitest |
| 组件/集成 | 转录虚拟化 + 实时块转正、Composer 流式态、palette 导航 | vitest + @testing-library/react（jsdom 下无 Tauri，mock `lib/ipc`） |
| 真布局门禁 | 转录分页（打开即贴底 / 翻页不跳 / 回到底部）、刻度梯几何、斜杠列表真滚动、Monaco 高亮 | `ui:startup`（Playwright + Chrome，跑在 mock IPC 上） |
| 真机探针 | 会话文件尾页读取的成本对照、真实会话形状、插件发现 | `cargo test -- --ignored`（需要本机真实环境） |
| E2E | 关键旅程（00 §4 的 1/2/3） | tauri-driver（WebDriver）+ WebdriverIO；性能场景走 §6 |
| 性能 | 05 §6 场景库 S1–S6 | nightly 工作流 + 预算断言 |

测试数据：录制脱敏的 pi 会话 JSONL 作为 fixture（含多分支、压缩、工具调用、图片块的形态多样性）。

## 6. Tauri 权限与能力清单（最小化）

`capabilities/default.json`：

- `core:default`（窗口/事件基础）；
- `core:window:allow-*`（标题/焦点，按需子集）；
- 插件：`global-shortcut`（可关）、`updater`（M4）、`dialog:allow-open/save`、`opener:default`、`clipboard-manager:allow-read/write`；
- `fs`：**scope 显式列举** `$HOME/.pi/**`（读写）+ 会话导出/日志目录；项目目录访问只在用户通过 dialog 选择后以运行时 scope 追加；
- shell：不启用自由 shell；
- **`opener` 不启用**（与本节旧版规划不同）：原计划用 `tauri-plugin-opener` 做「打开方式」，
  但它的权限面是"任意路径 / 任意 URL"。实际实现改为三个自建窄命令
  （`open_in_app_list` / `open_in_app_icon` / `open_in_app_open`，见 03 §2.11）：
  只能启动**宿主自己解析过的白名单应用**，且只能打开**已存在的绝对目录** ——
  没有 URL、没有任意命令、没有前端可控的 argv。
  文件级同款：`open_path_available` / `open_path_applications` / `open_path_open`，
  只认"已存在的绝对路径"，指定应用时必须**此刻真的注册在系统关联里**；
  当前 `capabilities/default.json` 仍然是 M0 那三行（`core:default` + `core:window:allow-set-title`），
  自建命令走 Tauri 的命令通道，不需要额外 capability；
- CSP：`default-src 'self'`；`connect-src` 无需外网（LLM 请求都发生在 pi 进程）。

## 7. 发布与版本

### 7.1 独立发布（捆绑 pi，M2）

目标：最终用户**零前置安装**（无需 Node/npm/pi），安装 Piggy 即用。

- **捆绑物**：pi 官方 standalone 二进制（自包含运行时；MIT，保留归属声明）。release 构建按 target triple 从 pi GitHub Releases 下载资产（v0.87.0 实测：darwin-arm64 29MB / linux 40MB / windows 42MB 压缩级），**SHA256SUMS 校验**后解包进 `src-tauri/resources/pi/`，经 tauri `bundle.resources` 随应用分发；
- **发现顺序**：见 02 §2.1（显式路径 > PI_BIN > 内置 > PATH）；
- **版本策略**：Piggy 版本 ↔ pi 版本成对锚定（02 §9 契约矩阵验证该组合）；运行时 `pi --version` 门禁照常；"pi 运行时应用内更新"（拉取新 standalone，opt-in）= M3 评估；
- **双 SKU**：`full`（捆绑 pi，默认）/ `lite`（不捆绑，体积敏感用户自装 pi）——同一构建管线，bundle.resources 条件化；
- **认证不捆绑**：pi 仍读 `~/.pi/agent/`（auth.json/API key）；首启 onboarding 检测未认证 → 引导 API Key 表单或内嵌终端 `/login`（M4）；构建 standalone 用 `--offline-model-data` 免首次联网拉模型目录；
- **契约矩阵**：CI contract 作业增加"用捆绑产物跑 C1–C10"项（发布前必过）。

### 7.2 版本

- 语义版本：0.x 阶段 minor=功能、patch=修复；
- 契约锚定：每个 release 注明验证过的 pi 版本区间（当前 **0.87.0**，2026-09-22 重跑 C1–C10 全绿；0.86.1→0.87.0 RPC 命令/事件面无变化，新增 `context_edit` 会话条目类型，透传兼容，M1 轨迹视图需渲染）；
- 更新通道：stable / beta（tauri-plugin-updater endpoints）；
- piggy-bridge 随主应用节奏发布，但允许独立小版本（它只依赖文档化的扩展 API 与 subagents RPC v1 的能力协商，06 §4.3）。

## 8. 本地开发体验

- `pnpm dev`：Vite dev server + `tauri dev`（HMR）；Rust 侧 `cargo watch` 由 tauri dev 内建处理；
- `pnpm test:contract -- --pi /path/to/pi`：本地跑契约；
- 调试面板：`app:stats`（05 §6.1 IPC 计量、worker 资源采样）+ 协议日志环形查看器（`PIGGY_DEBUG=1` 时启用完整事件落盘）。
