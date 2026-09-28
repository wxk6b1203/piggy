# 14 · Piggy 现状体检与 DSH 对齐改造方案

> 生成时间：2026-09-23 · 方法：`pnpm ui:debug`（Playwright 实机截图 + pageerror/console/布局体检）+ 源码与文档交叉核对
> 上游：[11-dsh-reference.md](11-dsh-reference.md)、[12-dsh-ui-spec.md](12-dsh-ui-spec.md)（实现级规格，冲突时以 12 为准）、[04-frontend-design.md](04-frontend-design.md)、[13-vscode-asset-inventory.md](13-vscode-asset-inventory.md)

## 0. 执行结果（2026-09-23 完成）

> **验收证据**（全部可复现；`pnpm tauri dev` 已由用户人工确认渲染正常）：
> `tsc --noEmit` 通过 · `vitest` **44/44** 通过 · `vite build` 通过 ·
> `ui:debug --strict` 零 pageerror / 零 console error / 零布局问题 ·
> `tauri build --bundles app` 通过，打包版 `Piggy.app` 启动无 panic（`tab_create ok` ×6）。
> 截图脚本：`pnpm --filter @piggy/desktop ui:debug -- --out <path>`（可加 `--click` 切视图）。


| 项 | 状态 |
|---|---|
| 调试工具链 `ui:debug` | ✅ 已交付（截图 + pageerror + console + 失败请求 + 布局体检 + JSON 报告 + `--strict` 进 CI） |
| D1 侧栏按钮 369px 拉伸 | ✅ 已修 |
| D2 favicon 404 | ✅ 已修 |
| D3 硬编码 `M2 perf` 占位符 | ✅ 已移除，换成 DSH 式状态行 |
| D4 emoji 图标 | ✅ 全部换成 `@vscode/codicons`，并加**编译期守卫**（图标名收窄为字面量联合） |
| **额外发现并修复**：`.pg-workspace` 无任何 CSS | ✅ 已补（此前 Composer 不贴底、Transcript 高度失真） |
| token 层 | ✅ 数值**直接取自 DSH 源码**（非截图取样），亮/暗两套齐全，附可复现抽取脚本 |
| 布局对齐 DSH | ✅ 删自绘标题栏（品牌行移入侧栏）、删底部状态栏（状态行移入 Composer dock） |
| Composer 对齐 | ✅ 卡片 r22 / `+` 圆钮 / 模型胶囊 / 34px 圆形发送 / 上下文环 |
| 消息渲染对齐 | ✅ 用户右对齐气泡 r22（无角色芯片）、助手整宽 + hover 操作行 |
| 右栏默认视图 | ✅ 由 `stats` 改为 `files`（统计已归 dock，避免重复） |
| **轨迹视图重写** | ✅ 按 docs/12 §4 重写：**删掉角色过滤器**（DSH 没有）、工具栏改为「轮次/调用」折叠 + 搜索、轮次轨道 + `#N` 标签、7 种角色芯片（含正确配色与图标）、正文去装饰字形 |
| **文档预览重写** | ✅ 按 docs/12 §6.5：面包屑与语言条**同一行 38px**、路径溢出用遮罩淡出、28px 圆钮工具栏、行号交给 Monaco |
| **右栏文件树** | ✅ 懒加载目录树 → 点击开预览 tab（补了 mock 的 `fs_list_dir`） |
| **Monaco 主题对齐** | ✅ 旧色值（`#1e1f22` 等）换成 DSH 令牌值；并注明 Monaco 只能吃字面量、改 token 需同步 |
| **dev 下 Monaco 白屏** | ✅ 修（见 §0.0） |
| **代码块样式** | ✅ DSH CodeCard：r12 / 标题条 11px·18px / 正文 11px·19px / 24×24 r6 图标复制钮；行内 code r6 + padding 0 5px |
| **`ChangedFiles` 卡片** | ✅ 回合尾卡片「已编辑 N 个文件」，r18 / 60px 头部 / 40px 图标砖 / 折叠阈值 4（docs/12 §3.5） |
| **正文不再渲染 tool-call** | ✅ DSH `AssistantMarkdown` 明确此层不渲染 tool-call（归工具行/轨迹）；同时删掉随之失效的 `safeJson` 与 `.pg-toolcall` 死代码 |
| **虚拟列表行重叠** | ✅ 修（见 §0.0b）——这是从会话一开始就存在的潜伏 bug |
| **token 迁移别名区** | ✅ 删除（`styles.css` 里 80+ 处旧变量名全部改为直引 token） |
| **Seti 文件图标** | ✅ 复用 VS Code 内置 Seti 图标主题（383 defs / 238 扩展名 / 101 文件名），构建期同步脚本 + 生成模块；用于右栏文件树与改动文件卡片 |
| **真机验证** | ✅ `cargo build` 通过；**并已产出并运行打包版 `Piggy.app`**，生产 bundle 在真实 WKWebView 中跑完 boot（`tab_create ok` ×6）。详见 §0.0c |
| **CSP** | ✅ 已配置并**用打包版验证**（boot 路径；见 §7 G2） |
| **VS Code 主题（tokenColors）** | ✅ 复用内置 Dark/Light Modern 的 `tokenColors` 作为 Monaco 语法着色（Dark 65→168 rules、Light 64→187）；构建期同步脚本 + JSONC 解析器。外壳颜色仍走 DSH 令牌，两者不冲突（见 §0.0e） |
| **三轨时间线** | ✅ 按 docs/12 §4.7 实现：`laneFor` 三轨归属、44px 标签栏 + 7/21/35px 轨道、span 8px 高 r1、按 kind 着色、轮次边界、hover 高亮线 + 点击选中联动列表、无时间戳自动退化等宽；纯函数有 11 条单测 |
| **VS Code 主题 tokenColors** | ✅ 见 §0.0e |
| **Fleet 视图重建** | ✅ 按 `stores/fleet.ts` 现存接口重建（该视图在事故中随 `RightBar.tsx` 丢失，store 与测试未受损）：编排启动表单 + runs lane 列表 + 会话内子代理；修正了 `fleet_start` 的 `cwd` 必须为字符串（Rust 侧非 Option） |
| 未完成 | ⬜ updater 占位域名（发布门禁 G1，**与 docs/00 的产品目标 G1 同名但无关**，需产品决策）；⬜ 主题 JSON 的**外壳颜色**部分（需先做注册表默认值层，docs/13 E4）；⬜ 构建产物里 codicon.ttf 出现两份（约 150 KB 冗余，见 §0.0d）；⬜ WebKit 渲染未验证（见 §0.0c） |

**验证**：`tsc --noEmit` 通过 · `vitest` 33/33 通过 · `vite build` 成功 · `ui:debug --strict` 零 pageerror / 零 console error / 零布局问题。

### 0.0 本轮额外修复：dev 模式 Monaco 白屏

**现象**：预览 tab / 设置里的 Monaco 编辑器在 `pnpm dev` 下白屏，console 报
`504 (Outdated Optimize Dep)` + `Failed to fetch dynamically imported module: monaco-setup.ts`。
生产构建正常，所以只在开发时暴露。

**根因**：Monaco 走 `monaco-editor/esm/vs/...` 深路径 import，而该包的 `exports` map 对这些路径是坏的
（docs/13 E6）。`vite.config.ts` 的 alias 只修得了 Vite 的**解析器**，修不了**依赖优化器**；
优化器在页面已加载后才重新打包 Monaco，把在途模块 URL 判为过期。

**修法**：`optimizeDeps.exclude: ['monaco-editor']`。Monaco 本身是 ESM，dev server 原样提供即可；
代价是首次打开编辑器请求数偏多（仅 dev，不影响构建产物）。

> 这也说明 `ui:debug` 的价值：它把"看起来白屏、但不知道哪一步坏了"变成了一条带 URL 的 504。

### 0.0b 虚拟列表行重叠（潜伏已久）

**现象**：消息卡片与下一条消息**上下重叠**。例如助手消息里的「已编辑 N 个文件」卡片压住了紧随其后的 toolResult 行。

**根因**：`Transcript` 用 TanStack Virtual 的 `measureElement` 做动态行高，但被测量的行元素上**没有 `data-index`**。
该库靠这个属性把测量结果映射回条目；缺失时它**静默丢弃**测量值，只打一条 warning
（`Missing attribute name 'data-index={index}' on measured element.`），
于是所有行高永远停在 `estimateSize: () => 88`，绝对定位的 `translateY` 互相压叠。

这条 warning 在本次会话最开始的第一份诊断输出里就出现过，当时被判为噪音——**实际是真 bug**。
教训：`ui:debug` 已经把 warning 一并收集，凡 warning 都应当作待查项，而不是"控制台不干净"。

**修复**：给被测量的行加 `data-index={vi.index}`。修完实测行 `y` 依次为 116 / 162 / 485，
首尾相接无重叠，容器总高 473 = 46+323+104，与各行实际高度之和一致。

### 0.0c 真机与打包版验证

前面大量验证跑在浏览器 + mock IPC 上，因此补了真机一档，并最终做到**打包版**：

```bash
cargo build                       # ✅ exit 0
npx tauri build --bundles app     # ✅ exit 0 → Piggy.app
./Piggy.app/Contents/MacOS/piggy-desktop
# [piggy] pi: /Users/wxk/Library/pnpm/bin/pi (0.87.1)
# [piggy] tab_create ok: … (×6)
```

这证明的是**发布产物本身可用**：生产 `dist/`（不是 Vite dev server）在真实 WKWebView 中加载、
执行了前端 boot 流程、经 IPC 驱动 Rust 建出 6 个会话工作面。

六个 `tab_create` 不是 bug——`~/.piggy/layout.json` 里确实持久化了 6 个 `session` 面板，
启动按布局逐个重建 worker，是设计行为。

**仍未能做到：截取 Tauri 窗口。** 打包成 `.app` 后 AppleScript 已能寻址
（`CGWindowListCopyWindowInfo` 取到 `WINID 129420 Piggy`），但 `screencapture -l` 报
`could not create image from window`；全屏 `screencapture` 也只拿到壁纸、拿不到任何窗口——
这是 macOS 14+ 在**缺少"屏幕录制"权限**时的典型表现（返回壁纸而非窗口内容）。
该权限无法由命令行自行授予，故**放弃截图**：不用"看起来像"的图冒充验收。
也因此本轮未保留任何全屏截图（它只会包含与项目无关的桌面内容）。
Playwright 的 WebKit 一档同属环境问题（启动即挂死，见 `ui-debug.mjs` 注释）。

### 0.0e VS Code 主题：只取 tokenColors

`docs/13` 把"主题"列为你点名要复用的资产之一，但直接上整套主题有两个问题：
主题 JSON 只覆盖 **123/477（26%）** 的颜色 id（E4），缺键要靠注册表默认值层补；
而且它会和"UI 参照 DSH"直接冲突（DSH 色板才是默认）。

**折中做法**：只复用主题里**不依赖默认值层**的那部分——`tokenColors`（scope → 样式表），
喂给 Monaco 的 `rules`；外壳颜色继续由 DSH 令牌决定。这样两边都成立。

- 脚本：`sync-vscode-themes.mjs`，自己写了 **JSONC 状态机解析器**
  （E3：19 个主题里 17 个是 JSONC；朴素的 `replace(/\/\/.*$/)` 会把 `"https://…"` 里的
  `//` 之后连字符串一起吃掉——第一版就踩了这个坑）
- 解析 `include` 继承链，`scope → token`、去 `#`、丢弃 deprecated 的 `background`（docs/13 §3.3）
- 实测生效：`"name"` → `#9CDCFE`、`"piggy"` → `#CE9178`、`42` → `#B5CEA8`，
  正是 VS Code Dark Modern 的规范语法色
- 顺带把 mock 的 `fs_preview_read` 改成**按扩展名返回对应内容**——
  原先所有文件都吐同一段文本，语法高亮相关的回归根本走不到

### 0.0d 已知冗余：构建产物里有两份 codicon.ttf

`vite build` 输出 `codicon-Brq4_Ui5.ttf`(140.96 kB) 与 `codicon-CMYWzYni.ttf`(149.51 kB)：
前者来自 Piggy 自己依赖的 `@vscode/codicons`，后者由 `monaco-editor` 自带
（Monaco 的 UI 也从同一套图标字体取字形，但是另一个版本）。两者版本不同、不能简单合并。
约 150 KB 冗余，占总体积 ~2.5%，记为待优化项而非缺陷。

### 0.0f `tauri dev` 黑屏：两个真 bug（2026-09-23 追加）

用户实测反馈：**打包版不黑屏，但 `pnpm tauri dev` 黑屏**。
这条信息很关键——它直接排除了 CSP 与生产 bundle（两者只在打包版生效），
把范围锁到"dev 路径 + WKWebView"。而我的 `ui:debug` 跑的是 Chromium + dev，
恰好不在这个交集里，所以全绿却没发现。

#### bug 1：`OsString` 被序列化成对象 → React 渲染即崩 → 全窗黑

**现象**：`pnpm tauri dev` 起窗后整个内容区全黑，没有任何文字。

**定位**：本轮新增的**错误转发**（见下）把 WKWebView 的错误送到了终端：

```
[piggy][webview][ERROR] [window.error] Objects are not valid as a React child
  (found: object with keys {Unix}).
  span → button → div → DirEntries → FilesView → RightBar → … → App
```

**根因**：`fs_list_dir` 里把 `entry.file_name()`（`OsString`）直接塞进 `serde_json::json!`。
serde 在 Unix 上把 `OsString` 序列化成 **`{"Unix":[字节...]}` 这样的对象**，不是字符串；
`FilesView` 把它当 React child 渲染 → React 19 卸载整棵树 → 全黑。
连带 `entries.sort_by` 里的 `a["name"].as_str()` 也恒为 `None`，排序一并失效。

**修复**：`entry.file_name().to_string_lossy().into_owned()`（非 UTF-8 按 lossy，前端本也只能按字符串展示）。

**为什么全部测试都没抓到**：前端在浏览器里跑的是 `mockBackend`，
它的 `fs_list_dir` 返回的是**普通字符串**——两边形状各写各的，
mock 把真机上必崩的 bug 藏得严严实实。这是 mock 策略的结构性风险，不是手误。

**防线**：新增 Rust 集成测试 `tests/ipc_contract.rs`，对**跨 IPC 边界字段断言基础类型**：
`name` 必须是字符串、`isDir` 必须是布尔、`size` 必须是数字。
已实测该测试在旧实现下**确实失败**（报 `{"Unix":[115,117,98]}`，即 "sub" 的字节），
不是一条永远绿的空测试。

#### bug 2：`optimizeDeps.exclude` 把 Monaco 的依赖注入打散了

**现象**：修完 bug 1 后编辑区仍报一串：

```
[createInstance] CodeLensContribution depends on UNKNOWN service ICodeLensCache.
[createInstance] SuggestController depends on UNKNOWN service ISuggestMemories.
[createInstance] DropIntoEditorController depends on UNKNOWN service treeViewsDndService.
```

**根因**：这是我早先为解决 `504 (Outdated Optimize Dep)` 加的
`optimizeDeps.exclude: ['monaco-editor']` 造成的——它让 Vite 把 Monaco 按**裸 ESM**
逐文件提供，Monaco 的模块级服务注册被拆散，于是 contributions 找不到自己依赖的 service。
而且实测：**去掉 exclude 则 504 立刻回来**（且明确指向两个 `?worker` 入口）。
两个方案各错一半，说明都在绕同一个根因。

**真根因**：monaco-editor 0.56.0 的 exports map 是

```json
{ "./*.js": "./esm/vs/*.js", "./*": "./esm/vs/*.js" }
```

所以 `monaco-editor/esm/vs/editor/editor.api.js` 会被重写成
`esm/vs/**esm/vs**/editor/editor.api.js`——**双写**（docs/13 E6 已记录）。
`vite.config.ts` 里的 alias 只修了 Vite 的解析器，修不了依赖优化器，
于是优化器反复失效 → 504；改用 exclude 又打散 DI。

**修复**：按 exports map 用**规范说明符**，双写问题自然消失，alias 也可以删掉：

| 旧（双写） | 新（规范） |
|---|---|
| `monaco-editor/esm/vs/editor/editor.api.js` | `monaco-editor/editor/editor.api` |
| `monaco-editor/esm/vs/editor/editor.worker.js?worker` | `monaco-editor/editor/editor.worker?worker` |
| `monaco-editor/esm/vs/language/json/json.worker.js?worker` | `monaco-editor/language/json/json.worker?worker` |
| `monaco-editor/esm/vs/language/json/monaco.contribution.js` | `monaco-editor/language/json/monaco.contribution` |

同时删除 `vite.config.ts` 的 `monaco-editor/esm` alias 与 `optimizeDeps.exclude`。
修完实测：Monaco 正常挂载、语法着色生效、**零 504、零 DI 报错**；
`tauri dev` 启动后终端**再无 `[piggy][webview][ERROR]`**。
`src/types/monaco-shim.d.ts` 随之不再需要，留下书面结论备查。

#### 本轮新增的排障能力：黑屏不再无解

黑屏之所以难查，是因为**打包版与 tauri dev 里 DevTools 默认打不开，WebView 的 console 拿不到**。
本轮补了两件东西，这类问题以后是自证的：

1. `ErrorBoundary`（`features/common/ErrorBoundary.tsx`）：渲染期异常**直接画在页面上**
   （消息 + 组件栈 + 重载按钮），肉眼可见、可直接截图；
2. 全局 `error` / `unhandledrejection` → IPC → Rust `webview_log` → **终端 stdout**
   （前缀 `[piggy][webview]`）。本次两个 bug 的定位全靠它。

## 0.1 事故记录（必须看）

**2026-09-23 11:10 · 自伤事故**：为把 antd 静态 `message`/`Modal` 迁移到主题感知的 `App.useApp()`，
执行了一个批量改写脚本。脚本里的 import 重写函数**误把整个文件内容当作返回值丢掉了**，
只保留了新 import 行，导致 10 个源文件被截断为 0–1 行。

**恢复过程**：

1. 从 `git HEAD` 恢复 9 个受版本控制的文件；
2. `lib/tabCreate.ts` 是未跟踪文件，从事故前最后一次构建产物
   （`dist/assets/index-C_CKiE1k.js`）中反查函数体后按原逻辑重建；
3. `SessionsSidebar.tsx` 从 DSH 会话日志中的完整读取记录逐行还原（323 行）；
4. `Composer.tsx` 重做了 DSH 卡片式重写。

**未能恢复**：上一轮 agent 对 `SettingsTab.tsx`（~106 行）、`appCommands.ts`（~24 行）、
`RightBar.tsx`（Fleet/Files/Tree 视图，~420 行 → 现为 157 行）等文件的**未提交改动**。
事故前的构建产物曾格式化保存在 `.recovery/pre-damage-bundle.pretty.js`，
`2026-09-23` 经确认不再需要，该目录（连同 `.gitignore` 条目）已删除；
上表列出的仍未恢复项即最终结论，**不要再去找 `.recovery/`**。

**教训（已加防线）**：批量改写脚本必须**先备份再改**，且改完立即 `tsc --noEmit` 自检；
本次能快速收敛，靠的正是 `ui:debug` 与 `tsc` 这两道已有检查。后续同类脚本一律走
「复制到临时目录 → 改写 → 差异审查 → 落盘」流程。


## 1. 体检方法（可复现）

```bash
pnpm dev                                 # 终端 A：Vite :5195
pnpm --filter @piggy/desktop ui:debug     # 终端 B：截图 + 错误 + 布局体检
```

`ui-debug.mjs` 用 Playwright 打开 Vite 页面（浏览器环境自动切 `mockBackend`，无需 pi/Tauri），
一次性产出：截图、`pageerror` 栈、`console.error/warning`、失败请求、布局越界/拉伸/空色块清单、
关键区域 DOM 骨架，并可 `--json` 落盘、`--strict` 进 CI。这是 Piggy 版的"直观看到页面错误"。

## 2. 结论速览

代码**不是坏的**：`tsc --noEmit` 通过、`vitest` 33/33 通过、应用能起、无 `pageerror`。
问题**全在 UI 层**：多个 agent 先后改写 DOM 结构却未同步 CSS，加上"DSH 化"只做了一半，
留下结构漂移 + 视觉与 DSH 脱节。

## 3. 已确认缺陷（含根因）

| # | 现象 | 根因 | 状态 |
|---|---|---|---|
| D1 | 侧栏「⊕ 新会话」渲染成 285×**369** 的巨大蓝块，挤掉整个会话列表 | `.pg-sidebar-new { flex: 1 }`——原为 `.pg-sidebar-actions` 横向行内"撑满宽度"而写；后来 DOM 改成按钮直接挂在列向 flex 的 `.pg-sidebar` 下，`flex:1` 变成**纵向拉伸** | ✅ 已修 |
| D2 | 每次加载 console 报 `404 /favicon.ico` | `index.html` 无 favicon | ✅ 已修（内联 SVG） |
| D3 | 状态栏右侧恒显 `M2 perf` | `AppFrame.tsx:163` 硬编码开发占位符流进了 UI | ✅ 已移除 |
| D4 | UI 图标全是 emoji（📁 📊 🌿 🛳 ⚙ ☰ ☀ 🐷） | 从未引入图标字体；emoji 跨平台字形不一致、无法着色 | ✅ 已接 codicons（13） |
| **D8** | **Composer 不贴底、Transcript 高度失真** | **`.pg-workspace` 这个类名在 CSS 里根本不存在**——`SessionWorkspace` 被重写时漏了样式表 | ✅ 已补 |
| D5 | `tauri.conf.json` `security.csp: null` | 显式关闭了 CSP | ⬜ 待补 |
| D6 | 打包配置里 updater 指向 `https://updates.piggy.invalid/` | 占位域名未替换 | ⬜ 待处理 |
| D7 | 根目录 `scripts/` 为空目录 | 遗留 | ⬜ 待清理 |

> D1 与 D8 是同一类问题：**DOM 结构被改动，CSS 没有跟上**。这是多 agent 接力改 UI 的典型事故。
> 本次加入两道防线：`ui:debug` 的**布局体检**（自动发现异常高度/越界/空色块）与**图标名编译期守卫**。

## 4. 与 DSH 的形态差距（以 docs/12 源码规格为准，非截图推断）

| 区域 | DSH（源码事实） | Piggy 改造前 | 现状 |
|---|---|---|---|
| 顶栏 | **无自绘标题栏**；品牌行在侧栏顶部 | 自绘 36px 标题栏 | ✅ 已删，品牌行移入侧栏 |
| 底部 | **无横贯底部状态栏**；状态行 = Composer dock | 底部状态栏 + `M2 perf` 占位 | ✅ 已改为 Composer dock |
| 侧栏「新会话」 | 38px 高、r12、中性填充 | `.pg-btn-primary` 蓝色 | ✅ 已对齐 |
| 侧栏选中 | 仅 `interactive-bg-hover`，**无强调条** | 蓝色左边条 + 染色 | ✅ 已对齐 |
| 会话头部 | 标题 + 模式胶囊 + 右侧操作 | **完全缺失** | ✅ 已补 |
| 消息角色 | **无角色芯片/头像**，靠右对齐与结构表达 | `you` / `assistant` 文字标签 | ✅ 已对齐 |
| 消息操作行 | 28×28 按钮，hover 显现 | **缺失** | ✅ 已补（复制 + 时间戳） |
| Composer | r22 卡 + `+` 圆钮 + 权限胶囊 ｜ 模型胶囊 + 圆形发送 | 裸 textarea + 文字按钮 | ✅ 已对齐 |
| Composer `@` | **没有 `@` 按钮**（`@` 是输入触发符） | 有 `@` 按钮 | ✅ 已删 |
| 上下文环 | 在 dock 内、viewBox 14/r5.5 | 不存在 | ✅ 已补 |
| 状态行 | `{轮} 轮 {步} 步 · {tok/s}` + `{总 tok} · 缓存命中 {%}` | 同左 | ✅ 已对齐 |
| 状态行的**数字精度** | DSH 是整数百分比 + 1 位小数 K/M（`token-format.ts`，`decimalPlaces ∈ {0,1}`） | **3 位小数**（`15.400K` / `42.857%`），用户 2026-09-23 明确要求 | ⚠️ 有意偏离（03 §3.0b） |
| 轨迹 | 7 种芯片、**无角色过滤器**、只有搜索 | 过滤按钮 + 自定义芯片 | ✅ 已重写对齐 |
| 轨迹里的**压缩细节** | 选中 `compacted` 记录 → 详情面板「概述」页给状态/时长 + 摘要全文（`TrajectoryTable.tsx:3255-3296`）；cell 的 `text` 是摘要预览、`outputDetail` 是全文（`layout.ts:333-362`）。对话侧的 `CompactionItem` 用「已压缩 {items} 条历史记录（约 {tokens} tokens）」+ Markdown 摘要，摘要不在当前窗口时**置灰并说"压缩摘要不可用"** | 轨迹只有一行「上下文压缩」（**点不开**）；对话行只有摘要 + 此前 token | ⚠️ **有意增强**：Piggy 没有 DSH 那种详情面板，改为**行内展开**，并把 pi 条目里 DSH 没有的字段一并显示（保留边界 `firstKeptEntryId`、涉及文件 `details`、摘要调用 `usage`、`fromHook`）。DSH 的 `items`（被折叠的历史条数）pi 不记录，所以那一句改成「此前 N tok」——**不编数字**（03 §3.0f） |
| 右栏 | 文档/代码预览面板 | 统计 KV 列表 | ✅ 默认文件树 + DSH 式 38px 文档预览 |
| 对话里的**工具行** | 一行 24px：`DisclosureRow`（16px 前导框 + 标题 13/24）+ 2×2 圆点 + 摘要 `flex:1` 省略号，点开才是卡片（`ui-tool/.../ToolRow.module.css`、`ui-primitives/.../DisclosureRow.module.css`） | 每个工具结果是**整块卡片**（6 行 `read` = 258px、3 行 `bash` = 201px，另带 16px 上下外边距） | ✅ 已对齐（04 §5.2）。两处**有意差异**：① 折叠正文用 `hidden="until-found"` 留在 DOM 里（Ctrl+F 可搜），DSH 在分组层用 `useSearchableHidden` 达到同一目的；② DSH 的完成回合整段"过程"还能再折成一行（`TurnProcessNodeView`，33px「已完成工作 / 用时 X」），Piggy **没做**这一层（见 docs/15 §4 待决策） |
| 「本轮文件改动」 | 已是 `ChangedFiles` **卡片**（C1） | 不存在 | ⬜ 待做 |

## 5. 改造原则（已执行）

1. **保留协议/状态逻辑**——`Composer` 的 slash/图片/队列/streamingBehavior、`Transcript` 的虚拟化与 LiveBlock 直写、
   stores 全部经过测试，是资产；本次只换**呈现层**（改完 33/33 测试仍全绿）。
2. **token 数值取自 DSH 源码而非截图**——`scripts/extract-dsh-tokens.mjs` 从
   `design-platform.css` 解析亮/暗两套并输出字面值，可随 DSH 升级重新对拍。
3. **图标统一走 codicons**，并生成字面量联合类型，拼错即编译错误；文件类型图标走 VS Code 内置 **Seti** 图标主题（构建期同步，MIT）。
4. **`docs/11 §2.3` 的旧裁决按 docs/12 更正**：不采纳项里的"保留自绘状态区"与 DSH 事实冲突，已按 DSH 执行。

## 6. 后续施工顺序

- **P0 止血**：D1 / D2 / D3 / D8（✅ 已完成）
- **P1 token 层**：DSH 色板 → `--pg-*`（暗/亮）（✅ 已完成）
- **P2 图标**：codicons 落地 + 编译期守卫（✅ 已完成）
- **P3 区域重构**：侧栏 / 会话头部 / 消息 / Composer / dock / 轨迹（含三轨时间线）/ 右栏（文件树 + 文档预览 + Fleet）/ 代码块 / 改动文件卡片（✅ 全部完成）
- **P4 收尾**：根 `scripts/` 清理（⬜）；其余见下面的发布门禁。

## 6.1 旁证：VS Code 1.140 独立收敛到同一拓扑

这是本轮最有价值的一条**非代码**发现。VS Code 1.140 新增了 `src/vs/sessions/`（约 15 MB），
其中 `LAYOUT.md` 是官方对「会话即主体」工作台的裁决。把它的原话与 DSH、与本次改造并排看：

| 结论 | VS Code `sessions/LAYOUT.md`（1.140） | DSH（docs/12） | Piggy 本次改造 |
|---|---|---|---|
| 去掉活动栏 | "The workbench omits the standard **Activity Bar**" | 无活动栏 | 无（原左轨已是图标轨） |
| **去掉底部状态栏** | "…**Status Bar**, and Banner" | 状态行是 Composer dock | ✅ 已删底部状态栏，状态行移入 dock |
| 去掉横幅 | "…and **Banner**" | — | 保留（仅启动失败时出现，属错误面非品牌面） |
| 侧栏 = 会话列表 | "Sidebar \| **Sessions list** and Sessions-owned sidebar views" | 会话侧栏 | ✅ 一致 |
| 会话是主体、编辑器降级 | "The Sessions Part… Its leaves **are not workbench editor groups**" | 会话是主工作面 | ✅ 一致（dockview 面板承载会话） |
| 右栏 = 会话详情（变更/文件） | "**Auxiliary Bar** \| Session details such as **changes and files**" | 右栏文档预览 | ✅ 一致（文件树 + 文档预览 + 变更卡片） |

三家在互不知情的前提下收敛到同一形态，说明这不是"照抄某个产品的口味"，
而是**会话型 agent 工作台的形态解**。这反过来支持了本次把 DSH 作为形态基准的决定。

> 复用模式按 docs/13 的裁决是 **reference-only**（参考无需署名，0 人日）：
> 只读它回答"为什么这么设计"，实现仍走 Piggy 自己的 dockview + React。
> 相关文件：`src/vs/sessions/LAYOUT.md`、`LAYOUT_CONTROLLER.md`、`SINGLE_PANE_SCENARIOS.md`。

## 7. 发布门禁（发版前必须处理）

以下两项**不是 UI 问题**，但会直接决定能否对外发版，故单列：

### 发布门禁 G1 · `tauri.conf.json` 的 updater 指向占位域名

> ⚠️ **命名冲突提醒**：这里的 G1 是**发布门禁**编号，与 `docs/00-overview.md` 的目标表里
> 那个 G1（「完整对话体验」）**没有任何关系**。说话/写文档时请写全「发布门禁 G1」，
> 否则下一个接手的人会去找对话体验的问题。


```json
"updater": {
  "endpoints": ["https://updates.piggy.invalid/{{target}}/{{current_version}}"],
  "pubkey": ""
}
```

`updates.piggy.invalid` 是 RFC 2606 保留域名，永不解析；`pubkey` 为空。
当前状态是**失败安全**的（检查更新必然失败，不会装到未签名包），
但 `tauri_plugin_updater` 已在 `src-tauri/src/lib.rs:74` 注册，
**不能只删配置块**——删了会复现历史 panic：

```
PluginInitialization("updater", "Error deserializing 'plugins.updater' … invalid type: null, expected struct Config")
```

（该 panic 记录仍留在 `~/.piggy/logs/panic-1790130511507.log`。）

发版前二选一：① 配好真实更新源与签名公钥；② 连同 Rust 侧的 `.plugin(...)` 一起摘掉。
两条路都需要真实打包验证（本轮已具备该能力，见 G2），但**都需要产品决策**：
更新源地址与签名密钥不是工程侧能单方面决定的，因此本轮保持现状。

### G2 · `security.csp` —— ✅ 本轮已解决

原本是 `null`（完全没有 CSP）。本轮**配了真实打包构建来验证**，而不是盲改：

```json
"csp": "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' asset: http://asset.localhost data: blob:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self' ipc: http://ipc.localhost"
```

**验证方法与结果**：CSP 只在打包后生效，因此判据是"打包版的前端还能不能跑起来"——
前端一旦被 CSP 挡死，boot 流程就不会执行，Rust 侧也就不会有 `tab_create` 日志。

```bash
npx tauri build --bundles app          # ✅ exit 0
./Piggy.app/Contents/MacOS/piggy-desktop
# [piggy] pi: …/pi (0.87.1)
# [piggy] tab_create ok: …  (×6)        ← CSP 下前端正常加载并跑完 boot
```

各指令的来由：`worker-src blob:` 给 Monaco 的 worker；`'wasm-unsafe-eval'` 给 Shiki 的
oniguruma WASM；`asset:` 与 `http://asset.localhost` 给 Tauri 资源协议（图片预览）；
`font-src data:` 给 codicon/Seti；`style-src 'unsafe-inline'` 因为 Monaco 与 antd 都在运行时注入样式。

> **验证边界（不夸大）**：本次只覆盖了 **boot 路径**（主 bundle、字体、IPC）。
> Monaco worker、Shiki WASM、asset 协议图片这些**懒加载路径**已按已知要求配好指令，
> 但没有在打包版里实际触发过——要完全确认需人工打开一次预览/设置页。



