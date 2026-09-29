# 12 · DSH Web 客户端 UI 规格（实现级参考）

> 目的：让 Piggy（Tauri 桌面端）能**逐像素、逐结构**地复刻 DeepSeek Harness (DSH) Web GUI 的界面。
> 方法：全部结论来自 DSH 源码精读（`/Users/wxk/Documents/Project/deepseek-harness`），每条都带 `文件:行号`。
> 上游：[11-dsh-reference.md](11-dsh-reference.md)（截图级参考）、[14-ui-assessment-and-dsh-alignment.md](14-ui-assessment-and-dsh-alignment.md)（差距清单）。
> 约定：`#12-…` 形式的路径一律相对于 DSH 仓库根；「§」引用本文档自身小节。

## 0. 一句话结论

DSH 的 Web UI 是 **Cordis 插件化 React 应用**：外壳（三栏 grid）、主题令牌表、以及每个功能面板都是独立客户端插件；
组件本身是**普通 React + CSS Modules**，但**取数、生命周期、插槽装配**完全依赖 DSH 的 cordis 运行时与生成式 Remote API。
对 Piggy 的正确姿势是：**结构和 CSS 逐条照抄，数据与装配通道换成 Tauri invoke / Zustand**（见 §7）。

---

## 1. 布局骨架

### 1.1 顶层：一个 grid 三栏，无自绘标题栏

真正的外壳是 `@deepseek-ai/dsh-client-ui-layout` 的 `AppFrame`，它注册进内建的 `root` 插槽（Web 外壳只渲染 `root`）。

- 组件：`#12-packages/client/ui-layout/src/client/AppFrame.tsx:139`（`AppFrame`）
- 样式：`#12-packages/client/ui-layout/src/client/AppFrame.module.css:1`
- 几何求解：`#12-packages/client/ui-layout/src/client/columns.ts:52`（`computeColumns`）

DOM 结构（`AppFrame.tsx:276-325`）：

```
div.frame[data-sidebar-collapsed][data-rightbar-collapsed][data-rightbar-fullscreen]
      [data-dragging][data-animating]           ← display:grid; grid-template-rows:100%; height:100%; overflow:hidden
  ├─ div.leadingBand            (仅 darwin；-webkit-app-region: drag 的整条窗口拖拽带，52px / 有页签时 76px)
  ├─ ConversationMarker (null)  (给 frame 打 data-panel-conversation 属性)
  ├─ DocumentTitle (null)
  ├─ div.sidebarCol             → renderSlot('sidebar', { collapsed, width })
  ├─ div.centerCol              → <MainPanel> = renderSlot('main', {}, { entryKey: activePanelId ?? 'conversation' })
  ├─ div.rightbarCol[data-rightbar-col] → renderSlot('rightbar', { width, viewportWidth, canShow })
  ├─ div.overlayLayer[data-shell-overlay]  (z-index:20, pointer-events:none)
  ├─ (darwin && sidebarCollapsed) div.leadingSeat[data-shell-leading]  (z-index:15, top:11px, left:88px)
  ├─ (未折叠) DragHandle side="sidebar"  left={cols.sidebar}
  └─ (rightbarShown && !fullscreen && normal.rightbar>0) DragHandle side="rightbar" left={viewport-normal.rightbar}
```

三栏宽度由 **内联 style 的 `grid-template-columns`** 决定（`AppFrame.tsx:283-285`）：

```
`${cols.sidebar}px minmax(${cols.rightbar === 0 ? 0 : CENTER_MIN}px, 1fr) minmax(0px, ${rightbarMax}px)`
```

> 设计要点：中列自己声明「受保护最小值」，右列自己「出价」，所以窗口 resize 与 grid 在同一 layout pass 落地（`AppFrame.module.css:252-258` 注释解释了为什么不用 JS 全量求解）。

### 1.2 尺寸常量（改名照抄即可）

`#12-packages/client/ui-layout/src/client/columns.ts:11-29`

| 常量 | 值 | 含义 |
|---|---|---|
| `CENTER_MIN` | `400` | 右侧栏打开时中列受保护的最小宽度 |
| `SIDEBAR_MIN` | `264` | 侧栏拖拽下限 |
| `SIDEBAR_MAX` | `420` | 侧栏拖拽上限 |
| `SIDEBAR_DEFAULT` | `280` | 未拖拽前的侧栏宽度 |
| `SIDEBAR_COLLAPSED` | `56` | 折叠态图标轨（24px 图标列 + 左右各 16px padding） |
| `SIDEBAR_AUTO_COLLAPSE` | `1024` | 视口小于此值自动折叠（deepsuite LG 断点） |
| `RIGHTBAR_MIN` | `300` | 右侧栏拖拽下限 |
| `RIGHTBAR_MAX_RATIO` | `0.7` | 右侧栏最大宽度占 frame 比例 |
| `RIGHTBAR_DEFAULT_RATIO` | `0.45` | 首次打开右侧栏的宽度比例 |

求解逻辑（`columns.ts:52-58`）：

```ts
const s = sidebar === 0 ? collapsedWidth : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
const available = viewport - s - CENTER_MIN
const r = rightbar === 0 || available < RIGHTBAR_MIN
  ? 0
  : Math.min(available, clampWidth(rightbar, RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO))
return { sidebar: s, center: Math.max(0, viewport - s - r), rightbar: r }
```

**折叠规则**（`AppFrame.tsx:178-192`）：

- 窄于 1024px → 自动折叠；用户手动切换只翻转 `narrowExpanded` 覆盖位，不写宽度偏好（`stores.ts:108-112`）。
- macOS 桌面（`html[data-platform='darwin']`）与 Windows 标题栏模式（`html[data-windows-titlebar]`）下，折叠宽度取 **0**（完全隐藏，不保留 56px 图标轨）；其余平台保留 56px。
- 侧栏「偏好即宽度」：关闭侧栏会**忘记**拖拽宽度，重开回到默认 280（`stores.ts:70-74` 注释）。
- 右侧栏首次打开取 `viewport * 0.45`，之后保留 px 偏好，跨 resize 与关闭都不丢（`stores.ts:127-136`）。

### 1.3 列皮肤

`AppFrame.module.css`：

```css
.frame          { background: var(--dsw-alias-bg-base); }                  /* :7 */
.sidebarCol     { background: var(--dsw-specific-sidebar-fill);
                  border-right: 0.5px solid var(--dsw-alias-border-l3); } /* :63-68 */
.centerCol      { display:flex; flex-direction:column; overflow:hidden; }  /* :70-75 */
.rightbarCol    { position: relative; min-width: 0; overflow: visible; }   /* :277-281 —— 右栏永不裁剪 */
.overlayLayer   { position:absolute; inset:0; z-index:20; pointer-events:none; } /* :283-291 */
.handle         { position:absolute; top:0; bottom:0; width:8px; margin-left:-4px;
                  cursor:col-resize; z-index:11; touch-action:none; }      /* :234-243 —— 无可见把手 */
.leadingBand    { position:absolute; top:0; right:0; left:0; height:52px;
                  pointer-events:none; -webkit-app-region: drag; }         /* :192-200 */
.frame[data-panel-conversation]:has([data-conversation-tabs]) .leadingBand { height: 76px; } /* :209-211 */
.leadingSeat    { position:absolute; top:11px; left:88px; z-index:15;
                  -webkit-app-region: no-drag; }                           /* :218-226 */
```

**动画**：只有「离散的折叠/展开切换」才给 `grid-template-columns` 加过渡，稳态 resize 必须瞬时（否则中列会橡皮筋抖动）：

```css
.frame[data-animating] { transition: grid-template-columns var(--ds-transition-duration-slow) var(--ds-ease-in-out); } /* :15-17 */
.frame[data-dragging]  { transition: none; }                                                                          /* :21-23 */
```

拖拽手柄用 pointer capture + rAF 节流，按下时把**渲染宽度**（而非偏好宽度）冻结为基准（`AppFrame.tsx:196-250`）。

### 1.4 macOS 桌面专属处理（Piggy 若不做 vibrancy 可跳过）

- frame 背景透明，侧栏只保留半透明 tint，并有蓝色到紫灰的竖向渐变叠层（`AppFrame.module.css:82-126`）。
- 分隔线从中列画（`border-left`）而不是侧栏（`border-right: none`），因为半透明侧栏上的 alpha 边会与壁纸混成暗缝（`:139-142`）。
- `html[data-platform='darwin'] { --dsh-frame-top-clearance: 48px }`（`:93-95`）——窗口顶部条带的恒定层高。
- `--dsh-frame-leading-clearance: 160px`（侧栏折叠）/ `84px`（全屏）（`:165-176`）。
- `@media (prefers-reduced-transparency: reduce)` 时用 90% 不透明填充替换（`:132-137`）。

### 1.5 有没有自绘标题栏？——**没有**

- 浏览器外壳 HTML 只有 `<div id="root">` + 一个 module script：`#12-apps/web/index.html`。
- 桌面端用 Electron 原生标题栏样式：
  - macOS：`titleBarStyle: 'hiddenInset'`，`trafficLightPosition: { x: 16, y: 18 }`，`vibrancy: 'sidebar'`，`backgroundColor: '#00000000'`
  - Windows：`titleBarStyle: 'hidden'` + `titleBarOverlay: { height: 40, color: chromeFallbackFill(), symbolColor: ... }`
  - 见 `#12-apps/desktop/src/main.ts:185-197`；高度常量 `WINDOWS_TITLEBAR_HEIGHT = 40`（`#12-apps/desktop/src/windows-layout.ts:4`）
- 页面侧只做三件事：
  1. `AppFrame` 渲染一条 `-webkit-app-region: drag` 的 `.leadingBand`（高 52px，出现对话页签时 76px）。
  2. Windows 下 preload 打 `document.documentElement.dataset.windowsTitlebar = ''` 并写 `--dsh-windows-titlebar-height: 40px`（`#12-apps/desktop/src/preload-windows.ts:12-14`）；`AppFrame.module.css:26-55` 于是给 frame 加 `padding-top`、在中列左上切 16px 圆角、并用 `::before` 画一条 40px 拖拽带。
  3. macOS 全屏时 `html[data-fullscreen]` 让出红绿灯占位（`AppFrame.module.css:174-180`）。
- **Piggy 结论**：Piggy 现在自绘 36px 标题栏（`14-ui-assessment…` §4）与 DSH 结构不同。要贴 DSH：删掉自绘标题栏，把品牌行放进侧栏顶部，用 Tauri 的 `decorations: false` + 自绘 drag region（等价于 `.leadingBand`），或在 macOS 用 `titleBarStyle: Overlay` + `trafficLightPosition`。

### 1.6 状态栏在哪？

DSH **没有横贯底部的状态栏**。窗口级状态行是 Composer 下方的 dock（§3.9）；连接状态是图标徽标（`#12-packages/client/ui-primitives/src/ConnectionIndicator.tsx`，由 settings 等处消费）。Piggy 的「状态栏」应改为 Composer dock。

---

## 2. 设计令牌（Design Tokens）

令牌系统是**三层 CSS 自定义属性**，全部挂在 `body`（暗色覆盖挂在 `body[data-ds-dark-theme]`），由 `ui-theme` 插件在运行时把 6 张样式表插入 `<head>`：

`#12-packages/client/ui-theme/src/client/styles.ts:11-18` 注入清单（顺序即层叠顺序）：

| 文件 | 作用 |
|---|---|
| `styles/base.css` | 上游基础变量（字体栈、动效曲线），**必须最先** |
| `styles/corner-shape.css` | 全局 `corner-shape: superellipse(1.5)` 圆角曲率 |
| `styles/design-platform.css` | **调色板 + alias 令牌（核心）** |
| `styles/scrollbar.css` | 滚动条皮肤与 `--dsh-scrollbar-*` |
| `styles/gradient-shadow-text.css` | 阴影/elevation + **全部 `--dsw-font-*` 排版令牌** |
| `styles/shiki.css` | 代码高亮 `--shiki-*` 变量 |

> 注入方式（可照抄）：`document.createElement('style')` + `dataset.plugin` + `dataset.pluginCss = '<pluginId>/<basename>'`，`ctx.effect` 返回时移除（`styles.ts:26-35`）。Piggy 直接在 `index.html` 静态引入即可。

### 2.1 基础变量（`base.css`，`:root`）

```css
--dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
  'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
--ds-font-family-code: 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas,
  'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei';
--ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
--ds-transition-duration: 0.2s;
--ds-transition-duration-fast: 0.1s;
--ds-transition-duration-slow: 0.3s;
```
（`#12-packages/client/ui-theme/src/styles/base.css:7-14`；注释说明 code 字体栈**故意不写裸 `monospace` 兜底**，否则 Windows 中文会掉到 SimSun。）

shell 级默认样式在 `#12-packages/client/web/src/base.css`：`html,body,#root { height:100%; margin:0 }`（`:4-9`），`body` 上设字体、`-webkit-font-smoothing: antialiased`、`text-autospace: normal`（`:11-33`），`code/pre/[data-diff]/[data-read]/[data-search]/[data-terminal] { text-autospace: no-autospace }`（`:82-90`）。

### 2.2 调色板（"static" 层，**明暗同值**）

`#12-packages/client/ui-theme/src/styles/design-platform.css:4-83`（`body`）与 `:85-164`（`body[data-ds-dark-theme]`，逐条重复同值）。

暗色主题最常用的几组：

| 组 | 值 |
|---|---|
| `--dsw-static-neutral-bluish-950` | `rgb(21, 21, 23)` ← 暗色底 |
| `-900` | `rgb(27, 27, 28)` |
| `-875` | `rgb(35, 35, 36)` |
| `-850` | `rgb(44, 44, 46)` |
| `-800` | `rgb(53, 54, 56)` |
| `-750` | `rgb(67, 69, 74)` |
| `-600` | `rgb(129, 133, 140)` |
| `-400` | `rgb(173, 178, 184)` |
| `-300` | `rgb(207, 211, 214)` |
| `-50`  | `rgb(249, 250, 251)` |
| `--dsw-static-neutral-*` | `50 rgb(250,250,250)` / `600 rgb(84,85,87)` / `700 rgb(60,60,61)` / `800 rgb(41,41,41)` |
| `--dsw-static-deepseek-400` | `rgb(122, 170, 255)`（暗色主蓝，注释说明是设计特意提亮） |
| `--dsw-static-deepseek-450` | `rgb(86, 134, 254)` |
| `--dsw-static-deepseek-500` | `rgb(65, 118, 230)` |
| `--dsw-static-green-500` | `rgb(34, 197, 94)`；`-500-a12` = `rgb(34 197 94 / 12%)` |
| `--dsw-static-red-400` | `rgb(242, 90, 90)`；`-400-a12` = `rgb(242 90 90 / 12%)` |
| `--dsw-static-amber-500` | `rgb(245, 158, 11)` |

### 2.3 语义层 alias 令牌 —— **暗色主题值全表**

`body[data-ds-dark-theme]`，`#12-packages/client/ui-theme/src/styles/design-platform.css:266-362`。
下表给出「令牌 → 引用 → 解析后的暗色字面值」，工程可直接硬编码右侧值。

**背景 / 表面**

| 令牌 | 暗色值 |
|---|---|
| `--dsw-alias-bg-base` | `rgb(21,21,23)` `#151517` |
| `--dsw-alias-bg-layer-1` | `rgb(35,35,36)` |
| `--dsw-alias-bg-layer-2` | `rgb(44,44,46)` |
| `--dsw-alias-bg-layer-3` | `rgb(53,54,56)` |
| `--dsw-alias-bg-overlay` | `rgb(97,102,107)` |
| `--dsw-alias-bg-module-platform` | `rgb(53,54,56)` |
| `--dsw-alias-bg-multi-select` | `rgb(33,33,35)` |
| `--dsw-alias-bg-skeleton` | `rgba(255,255,255,0.08)` |
| `--dsw-alias-bg-mask-1` / `-2` / `-3` | `rgba(0,0,0,0.5)` / `rgba(0,0,0,0.2)` / `rgba(0,0,0,0.48)` |
| `--dsw-alias-bg-mask-photo` | `rgba(0,0,0,0.88)` |
| `--dsw-alias-bg-mask-drop` | `rgba(39,39,48,0.7)` |
| `--dsw-alias-bg-document-preview` | `rgb(21,21,23)` |

**边框**（全部是 alpha 白，注意 DSH 用 **0.5px** 发丝线）

| 令牌 | 暗色值 |
|---|---|
| `--dsw-alias-border-l1` | `rgba(255,255,255,0.06)` |
| `--dsw-alias-border-l2` | `rgba(255,255,255,0.12)` |
| `--dsw-alias-border-l2-darkmode-thin` | `rgba(255,255,255,0.06)` |
| `--dsw-alias-border-l3` | `rgba(255,255,255,0.16)` |
| `--dsw-alias-border-l4` | `rgba(255,255,255,0.2)` |
| `--dsw-alias-border-inverted` / `-inverted2` | `rgba(255,255,255,0.06)` / `rgba(255,255,255,0.08)` |

**文字**

| 令牌 | 暗色值 |
|---|---|
| `--dsw-alias-label-primary` | `rgb(249,250,251)` |
| `--dsw-alias-label-primary-dimmed` | `rgb(235,238,242)` |
| `--dsw-alias-label-secondary` | `rgb(207,211,214)` |
| `--dsw-alias-label-tertiary` | `rgb(173,178,184)` |
| `--dsw-alias-label-caption` | `rgb(129,133,140)` |
| `--dsw-alias-label-dimmed` | `rgb(67,69,74)` |
| `--dsw-alias-label-primary-foreground` | `rgb(15,17,21)` |
| `--dsw-alias-label-primary-inverted` | `rgb(53,54,56)` |
| `--dsw-alias-label-primary-bluish` | `rgb(249,250,251)` |
| `--dsw-alias-label-document-preview` | `rgb(207,211,214)` |
| `--dsw-alias-link` | `rgb(122,170,255)` |

> ⚠️ 源码里还有两个**只在组件中使用、未在本令牌表定义**的令牌（来自上游 deepsuite `theme/global.css`）：
> `--dsw-alias-separator-primary`（`ui-chat/…/StatsPills.module.css:64`）、
> `--dsw-alias-label-quaternary`（`ui-agent-preset/…/AgentPresetSeat.module.css:44`）。
> Piggy 需自行补一个合理值（建议：separator ≈ `rgba(255,255,255,0.12)`，label-quaternary ≈ `rgb(151,157,166)`）。

**交互态**

| 令牌 | 暗色值 |
|---|---|
| `--dsw-alias-interactive-bg-hover` | `rgba(255,255,255,0.08)` |
| `--dsw-alias-interactive-bg-active` | `rgba(255,255,255,0.14)` |
| `--dsw-alias-interactive-bg-hover-solid` | `rgb(53,54,56)` |
| `--dsw-alias-interactive-bg-hover-accent` | `rgba(255,255,255,0.24)` |
| `--dsw-alias-interactive-bg-hover-danger` | `rgba(242,90,90,0.15)` |

**品牌 / 按钮**

| 令牌 | 暗色值 | 备注 |
|---|---|---|
| `--dsw-alias-brand-primary` | `rgb(249,250,251)` | **近白**，不是蓝！ |
| `--dsw-alias-brand-primary-new-colorprimary-new-color` | `rgb(86,134,254)` | 平台"真蓝"强调色，dockkit 的下落指示用它 |
| `--dsw-alias-brand-text` | `rgb(249,250,251)` | |
| `--dsw-alias-button-primary-fill` | `rgb(249,250,251)` | 主按钮白底 |
| `--dsw-alias-button-primary-hover` | `rgb(235,238,242)` | |
| `--dsw-alias-button-info-fill` | `rgb(122,170,255)` | **发送键的蓝** |
| `--dsw-alias-button-info-hover` | `rgb(65,118,230)` | |
| `--dsw-alias-button-ghost-active-fill` | `rgb(67,69,74)` | |
| `--dsw-alias-button-ghost-active-border` | `rgb(129,133,140)` | |
| `--dsw-alias-button-floating-fill` | `rgb(44,44,46)` | |
| `--dsw-alias-button-floating-hover` | `rgb(53,54,56)` | |
| `--dsw-alias-button-elevated-fill` | `rgb(67,69,74)` | |
| `--dsw-alias-button-contrast-fill` | `rgb(249,250,251)` | |
| `--dsw-alias-button-primary-dimmed` | `rgb(67,69,74)` | |
| `--dsw-alias-button-tool-bar-fill` / `-hover` / `-invisible` | `rgba(84,85,87,0.5)` / `rgba(84,85,87,0.6)` / `rgba(31,31,31,0.36)` | |

**状态**

| 令牌 | 暗色值 |
|---|---|
| `--dsw-alias-state-business-primary` | `rgb(122,170,255)`（选中页签/光标/运行点） |
| `--dsw-alias-state-business-tertiary` | `rgb(52,65,91)` |
| `--dsw-alias-state-success-primary` / `-secondary` / `-tertiary` | `rgb(34,197,94)` / `rgb(78,209,126)` / `rgb(35,60,44)` |
| `--dsw-alias-state-error-primary` / `-secondary` | `rgb(242,90,90)` / `rgb(242,90,90)` |
| `--dsw-alias-state-warn-primary` / `-secondary` / `-label` / `-tertiary` | `rgb(245,158,11)` / `rgb(247,173,49)` / `rgb(221,134,41)` / `rgb(39,36,31)` |
| `--dsw-alias-state-idle-primary` | `rgb(84,85,87)` |
| `--dsw-alias-code-diff-added` | `rgb(34 197 94 / 12%)` |
| `--dsw-alias-code-diff-deleted` | `rgb(242 90 90 / 12%)` |

**产品专属（specific）**

| 令牌 | 暗色值 | 用途 |
|---|---|---|
| `--dsw-specific-sidebar-fill` | `rgb(27,27,28)` | 侧栏底色 |
| `--dsw-specific-sidebar-nav-item-active` | `rgb(67,69,74)` | 会话行选中底 |
| `--dsw-specific-sidebar-nav-item-hover` | `rgb(44,44,46)` | 会话行 hover |
| `--dsw-specific-sidebar-nav-item-active-accent` | `rgb(53,54,56)` | 选中强调 |
| `--dsw-specific-input-major` | `rgb(44,44,46)` | **Composer 卡片底** |
| `--dsw-specific-selector` | `rgb(53,54,56)` | Composer `+` 圆钮底 |
| `--dsw-specific-bubble` | `rgb(44,44,46)` | 用户气泡底 |
| `--dsw-specific-bubble-highlight` | `rgb(67,69,74)` | |
| `--dsw-specific-menu` | `rgba(48,49,54,0.5)` | 菜单面（配 `backdrop-filter`） |
| `--dsw-specific-tip` | `rgb(53,54,56)` | |
| `--dsw-specific-login-input` | `rgb(27,27,28)` | |
| `--dsw-alias-toast-bg` | `rgb(67,69,74)` | |
| `--dsw-alias-tooltip-bg` | `rgb(67,69,74)` | |
| `--dsw-alias-markdown-code-block` | `rgb(27,27,28)` | 代码块底 |
| `--dsw-alias-markdown-code-block-banner` | `rgb(44,44,46)` | 代码块标题条 |
| `--dsw-alias-markdown-inline-code` | `rgb(41,41,41)` | 行内 code |
| `--dsw-alias-markdown-code-segment-selected` / `-unselected` | `rgb(53,54,56)` / `rgb(27,27,28)` | 代码块分段控件 |
| `--dsw-alias-markdown-citation` | `rgb(53,54,56)` | |
| `--dsw-alias-markdown-tag` | `rgb(44,44,46)` | |
| `--dsw-alias-markdown-placeholder` | `rgb(44,44,46)` | |
| `--dsw-alias-scrollbar-bg-l1` / `-l2` | `rgb(60,60,61)` / `rgb(84,85,87)` | |
| `--dsw-alias-scrollbar-hover-l1` / `-l2` | `rgb(84,85,87)` / `rgb(101,103,107)` | |

### 2.4 阴影 / elevation（`gradient-shadow-text.css`）

```css
--dsw-linear-gradient-think: linear-gradient(180deg, #151517 20.19%, rgba(21,21,23,0) 100%);
--dsw-linear-think-select:   linear-gradient(180deg, #232325 20.19%, rgba(35,35,37,0) 100%);
--dsw-shadow-lv1: 0 2px 4px 0 rgba(0,0,0,0.05);
--dsw-shadow-lv1-blur: 0 4px 12px 0 rgba(0,0,0,0.02);
--dsw-shadow-lv2: 0 4px 12px 0 rgba(0,0,0,0.02), 0 2px 8px 0 rgba(0,0,0,0.04);
--dsw-shadow-lv3: 0 0 1px 0 rgba(0,0,0,0.2), 0 0 4px 0 rgba(0,0,0,0.02), 0 12px 32px 0 rgba(0,0,0,0.08);
--dsw-elevation-stroke-color: var(--dsw-alias-border-l4);
--dsw-mask-blur: blur(2px);
--dsw-menu-backdrop-filter: blur(40px) saturate(150%);
```

`body, body *` 上再声明三档「描边 + 柔光」组合（`:27-36`，**逐元素声明**，这样组件重绑 `--dsw-elevation-stroke-color` 才生效）：

```css
--dsw-elevation-stroke: 0 0 0 0.5px var(--dsw-elevation-stroke-color);
--dsw-elevation-panel:     var(--dsw-elevation-stroke), 0 3px 8px 0 rgba(0,0,0,0.03), 0 0 16px 0 rgba(0,0,0,0.02);
--dsw-elevation-prominent: var(--dsw-elevation-stroke), 0 3px 8px 0 rgba(0,0,0,0.04), 0 0 20px 0 rgba(0,0,0,0.05);
--dsw-elevation-soft:      var(--dsw-elevation-stroke), 0 4px 16px 0 rgba(0,0,0,0.03), 0 0 24px 0 rgba(0,0,0,0.03);
```

`--dsw-elevation-soft` 正是 **Composer 卡片**用的那档（`ui-conversation/…/InputBar.module.css:63`）。

### 2.5 排版阶梯（`gradient-shadow-text.css:55-270`）

正文字号由 `--dsh-content-font-size` 驱动（12–17px，默认 14；写在 `body` 上，见 `ui-theme/src/theme-settings.ts:24-30` 与 `boot-theme.ts:33`），派生：

```css
--dsh-content-font-delta: calc(var(--dsh-content-font-size, 14px) - 14px);
--dsh-content-font-size-secondary: min(calc(var(--dsh-content-font-size,14px) - 1px),
                                       max(13px, calc(var(--dsh-content-font-size,14px) - 2px)));
--dsh-content-font-delta-secondary: calc(var(--dsh-content-font-size-secondary) - 13px);
```

markdown 阶梯整体按 0.875 从 Figma 缩放（正文 16→14）：

| 令牌 | 值 |
|---|---|
| `--dsw-font-markdown-h1` | `700 calc(21px + Δ)/calc(30px + Δ) var(--dsw-font-family)` |
| `--dsw-font-markdown-h2` | `700 calc(19px + Δ)/calc(28px + Δ)` |
| `--dsw-font-markdown-h3` | `700 calc(18px + Δ)/calc(26px + Δ)` |
| `--dsw-font-markdown-h4` | `600 var(--dsh-content-font-size)/calc(24px + Δ)` |
| `--dsw-font-markdown-base` | `var(--dsh-content-font-size)/calc(24px + Δ)` |
| `--dsw-font-markdown-base-strong` | `600 …` |
| `--dsw-font-markdown-table` / `-head` | `var(--dsh-content-font-size-secondary)/calc(22px + Δ₂)`，head 用 500 |
| `--dsw-font-markdown-small` | `12px/20px` |
| `--dsw-font-markdown-code` | `12px/19px var(--ds-font-family-code)` |
| `--dsw-font-markdown-code-block` | `11px/19px var(--ds-font-family-code)` |
| `--dsw-font-markdown-code-block-small` | `11px/16px var(--ds-font-family-code)` |

UI 通用阶梯（`:180-269`）：

| 令牌 | 值 |
|---|---|
| `--dsw-font-xl-24` | `600 24px/32px` |
| `--dsw-font-l-20` | `500 20px/28px` |
| `--dsw-font-m-18` | `500 16px/28px` |
| `--dsw-font-base-16` | `16px/24px` |
| `--dsw-font-base-strong-16` | `500 16px/24px` |
| `--dsw-font-s-14` / `-strong-14` | `14px/22px` / `500 14px/22px` |
| `--dsw-font-xs-13` / `-strong-13` | `13px/20px` / `500 13px/20px` |
| `--dsw-font-xxs-12` / `-strong-12` | `12px/18px` / `500 12px/18px` |
| `--dsw-font-xxxs-11` / `-strong-11` | `11px/14px` / `500 11px/14px` |

> 每个令牌都同时导出 `-font-family / -font-weight / -line-height / -font-size / -font-style` 五个分量变量（`--dsw-font-xs-13-font-size: 13px` 等），组件只取单个分量时用它们。
>
> 源码注释提醒：Figma 的 **font-weight 510 一律渲染为 500**（`design-platform.css:1-3`）——Piggy 若有 510/450 之类的中间字重，统一压到 500/400。

### 2.6 圆角 / 滚动条 / 语法高亮

- **圆角曲率**（`corner-shape.css`）：`@supports (corner-shape: superellipse(1.5))` 内 `--dsw-corner-shape: superellipse(1.5)`，并对 `*, *::before, *::after` 设 `corner-shape: var(--dsw-corner-shape)`。**所有"胶囊"（50%/100%/大圆角）必须显式配 `corner-shape: round`**，否则会被切成方角（组件里大量出现这组配对）。
- **滚动条**（`scrollbar.css`）：`--dsh-scrollbar-width: 5px`；`::-webkit-scrollbar { width/height: var(--dsh-scrollbar-width) }`，track 透明，thumb `border-radius: 999px; corner-shape: round; background: var(--dsh-scrollbar-thumb)`（默认 `--dsw-alias-scrollbar-bg-l1`）。Firefox 路径在 `@supports not selector(::-webkit-scrollbar)` 内用 `scrollbar-width: thin; scrollbar-color: … transparent`。**两条路径互斥**，同时声明会让 Chromium/Safari 丢弃全部 `::-webkit-scrollbar*`（`:26-56` 有实测注释）。
- **语法高亮**（`shiki.css`）：`--shiki-background: var(--dsw-alias-markdown-code-block)`、`--shiki-foreground: var(--dsw-alias-label-primary)`；暗色 token 色 `--shiki-token-constant:#4dabf7`、`string:#69db7c`、`comment:#adb5bd`、`keyword:#faa2c1`、`parameter:#ffa94d`、`function:#b197fc`、`string-expression:#8ce99a`、`punctuation:#ced4da`、`link:#74c0fc`。
- **明暗切换开关**：`<html data-ds-theme-source="light|dark|system">` + `<body data-ds-dark-theme>`（布尔属性存在即暗色）。首屏在 head 里内联一段脚本完成，避免闪白：`#12-packages/client/ui-theme/src/boot-theme.ts:15-35`（`LIGHT_BACKGROUND='#fff'`，`DARK_BACKGROUND='#151517'`）。

---

## 3. 对话视图（Chat）组件清单

### 3.0 会话主体：谁拥有什么

- 主面板根：`#12-packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx:11` → `ConversationMainPanel`
- 实际骨架 `#12-packages/client/ui-conversation/src/client/skeleton/ConversationMainPanel.tsx:43-54`：

```tsx
<div className={css.root} data-phase={phase}>            // hero | active | settling
  {renderSlot('conversation.header', {})}
  {renderFactorySlot('conversation.content', { variant:'main', phase, hero },
    { slots: { widthControls: ConversationWidthControls } })}
</div>
```

- 样式 `#12-packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css`

关键 CSS：

```css
.root   { display:flex; flex-direction:column; height:100%; min-width:0;
          background: var(--dsw-alias-bg-base); position:relative; }        /* :1-8 */
.header { display:grid; grid-template-columns: auto minmax(0,1fr);
          flex:none; box-sizing:border-box; min-height:76px;
          padding:10px 28px 0 20px;
          border-bottom:0.5px solid var(--dsw-alias-border-l3); }            /* :15-23 */
.header:where(:not(:has(.tabs))) { min-height:0; padding-bottom:10px; }      /* :25-28 */
.body   { position:relative; display:flex; flex:1; flex-direction:column; min-height:0;
          --dsh-chat-content-width: var(--dsh-chat-user-width,
            clamp(680px, calc(var(--dsh-conversation-column-width,0px) * 0.64), 920px));
          --dsh-composer-card-max-width: calc(var(--dsh-chat-content-width) + 32px);
          --dsh-composer-side-clearance: 16px;
          --dsh-composer-dock-inset: 8px; }                                  /* :368-385 */
.scrollBody { display:flex; flex:1; flex-direction:column; min-height:0;
          margin-right:2px; overflow-y:auto; scrollbar-gutter:stable; }      /* :395-410 */
.composerSeat { position:sticky; bottom:0; z-index:7;
          background: linear-gradient(180deg,
            color-mix(in srgb, var(--dsw-alias-bg-base) 0%, transparent) 0px,
            var(--dsw-alias-bg-base) 36px); }                                /* :424-447 */
.composerHero { align-self:center; gap:8px; padding-bottom:32px;
          width: min(calc(var(--dsh-composer-card-max-width)
                    + 2 * var(--dsh-composer-side-clearance)), 100%); }      /* :501-512 */
```

- **内容宽度轴**是整套布局的锚：`--dsh-chat-content-width = clamp(680px, 列宽×0.64, 920px)`，Composer 卡片 = 内容宽 + 32px（左右各 16px clearance）。Piggy 照抄这两个公式即可保证消息列与输入框左边对齐。
- **吸底输入区**用 `position: sticky; bottom: 0` + 顶部 36px 渐隐遮罩（`color-mix` 从 `bg-base` 0% → 100%，**不用硬编码白色**，这样明暗都从各自底色淡出）。
- `--dsh-composer-stack-gap: 6px`（`:332`）、`--dsh-composer-text-max-height: 336px`（`:351`，= 14 行 × 24px）。
- 宽度拖拽手柄 `.widthHandle`：绝对定位于 `.body`，宽 `min(10px, (100% - content)/2 - 48px)`，hover 时出现 2px 高光条（`:253-319`）。

### 3.1 会话头部（标题面包屑 + 页签）

组件：`#12-packages/client/ui-conversation/src/client/skeleton/ConversationSession.tsx:58`（`ConversationSessionHeader`）

DOM（`:67-158`）：

```
<>
  <div .titleRow>                                        // grid-column:2; min-height:30px; padding-inline-start: max(0, var(--dsh-frame-leading-clearance) - 20px)
    <div .titleCluster>                                  // flex; gap:10px; flex:1
      <nav .crumbs aria-label={t('session.hierarchy')}>   // flex; gap:4px; overflow:hidden; white-space:nowrap
        <span .crumbSeg>                                 // inline-flex; gap:4px
          <span .crumbSep>/</span>                       // 14px/20px, color: label-caption
          <button .crumb | span .crumb.crumbCurrent>…</button>
        </span> …
        <!-- 空谱系时回退为 <span .crumbCurrent>{sessionId}</span> -->
      </nav>
      <div .headerActions>   {renderSlot('conversation.session.header.actions')}     // gap:8px
    </div>
    <div .headerUtilities> {renderSlot('conversation.session.header.utilities')}     // margin-left:20px; gap:8px
    <div .headerCorner[data-conversation-header-corner]> {renderSlot(…corner)}       // margin-left:8px; margin-right:-16px
  </div>
  {showTabs && <div .tabs role="tablist" data-conversation-tabs> … </div>}
</>
```

`.tabs` = **对话 | 轨迹 二级页签**（`ConversationRoot.module.css:185-232`，注释标明对应 Figma `Tab_Group 34:11441`）:

```css
.tabs      { grid-column: 1 / -1; position: relative; z-index: 1;
             display: flex; gap: 36px; margin-top: 10px; padding-left: 8px; }
.tab       { position: relative; padding: 0 0 9px; border: none; background: transparent;
             font-size: 13px; line-height: 16px; font-weight: 500;
             color: var(--dsw-alias-label-tertiary); cursor: pointer; }
.tab::after{ content:''; position:absolute; right:0; bottom:-1px; left:0; height:2px;
             border-radius: 2px; background: transparent; }
.tabActive { color: var(--dsw-alias-state-business-primary); }        /* 暗色 rgb(122,170,255) */
.tabActive::after { background: var(--dsw-alias-state-business-primary); }
```

- 页签数量 >1 才渲染（`ConversationSession.tsx:66`：`const showTabs = !hideChrome && tabs.length > 1`）；`data-conversation-tabs` 是 `ui-layout` 把拖拽带从 52px 加高到 76px 的钩子。
- 头部总高 **76px** = 10px 上内边距 + 30px 标题行 + 页签 10px margin + 16px 文字行 + 9px 下内边距（注释 `:10-14` 明确列出，任何一行都不能长高）。
- 页签数据源：
  - `ui-chat` 注册 `conversation.view`，`id:'chat'`，`order: 0`，`label: () => t('view.chat')` → **对话**（`#12-packages/client/ui-chat/src/client/apply.ts:146-153`；中文字符串 `ui-chat/src/client/locale.ts:51`，英文 `:209`）
  - `ui-trajectory` 注册 `id:'trajectory'`，`order: 10`，`label: () => t('view.trajectory')` → **轨迹**（`#12-packages/client/ui-trajectory/src/client/index.ts:81-84`；中文 `ui-trajectory/src/client/locales.ts:8`，英文 `:210`）
  - 兜底视图 `DEFAULT_VIEW_ID = 'chat'`；开发者工具开关控制 `trajectory` 是否注册（`#12-packages/client/ui-conversation/src/client/view-selection.ts:4-6`）
- **"模式胶囊"在哪**：DSH 的会话头部**没有** mode pill。Agent 预设胶囊位于 **Hero（新会话空态）** 的 workspace 行（`conversation.hero.agentPreset` 槽，`#12-packages/client/ui-agent-preset/src/client/AgentPresetSeat.module.css:18-40`：`inline-flex; gap:4px; min-height:28px; padding:0 8px; border-radius:16px; font:500 13px/20px; color:label-primary`，hover `interactive-bg-hover`）。运行时的"模式"体现为 Composer 行内的 **权限胶囊 / Plan 胶囊 / 模型胶囊**（§3.8）。Piggy 若坚持在标题行放 mode pill，属于偏离 DSH 的加戏，建议放到 Composer 行。

### 3.2 用户消息（气泡）

组件：`#12-packages/client/ui-chat/src/client/chat/MessageItem.tsx`（`UserMessageItem`）
样式：`#12-packages/client/ui-chat/src/client/chat/MessageItem.module.css:1-47`

```
div.userRow                 // flex column; align-items:flex-end; gap:6px
  └ div.userStack           // flex column; align-items:flex-end; gap:8px
                            // max-width: min(calc(var(--dsh-chat-content-width,748px) * 0.702), 82%)
      ├ div.bubble          // 正文（projectUserText 投影后的富文本）
      └ div.attachmentRow   // flex wrap; justify-content:flex-end; gap:8px（图片/文件卡片）
  └ MessageIconActions      // data-clock="start"，见 §3.6
```

```css
.bubble {
  max-width: 100%;
  background: var(--dsw-specific-bubble);      /* 暗色 rgb(44,44,46) */
  border-radius: 22px;
  padding: 10px 16px;
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary);
  white-space: pre-wrap; word-break: break-word;
}
```

> 默认字号下一条单行气泡高 **42px**（22 行高 + 上下各 10px padding）。
> ⚠️ **用户消息没有角色芯片、没有头像、没有 role badge**：全包 grep `avatar` 零命中。身份**只靠右对齐 + 气泡填充**表达。
> 气泡内唯一的"芯片"是 `@file` / `@session` / `/skill` 引用（`projectUserText`，`#12-packages/client/ui-primitives/src/user-text.tsx:121-138`）：

```css
/* ui-primitives/src/user-text.module.css:11-32 */
.refChip { display:inline; max-width:100%; margin: 0 2px;
           color: var(--dsw-alias-state-business-primary);   /* 暗色 rgb(122,170,255) */
           font-weight:500; white-space:inherit; overflow-wrap:anywhere }
.slashChip { font-family: var(--dsw-font-markdown-code-font-family) }
.refIcon { width:1em; height:1em; margin-right:4px; vertical-align:-0.125em }
```

DOM（`MessageItem.tsx:184-228`）：`div.userRow > div.userStack > [div.attachmentRow + div.bubble + div.referenceSummary] + MessageIconActions`。

**附件文件卡片**（用户消息里的文件芯片/卡片，`MessageItem.module.css:335-387`）：

```css
.attachmentRow { display:flex; flex-wrap:wrap; justify-content:flex-end; max-width:100%; gap:8px; }
.fileCard { display:inline-flex; flex:0 0 240px; align-items:center; gap:10px;
            width:240px; min-height:64px; padding:8px 12px;
            border:0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12));
            border-radius:16px; background: var(--dsw-specific-input-major, transparent);
            box-sizing:border-box; }
.fileIcon    { flex:none; width:28px; height:28px; }
.fileContent { display:flex; flex:1; flex-direction:column; min-width:0; }
.fileName    { overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
               color: var(--dsw-alias-label-primary); font-size:14px; font-weight:500; line-height:22px; }
.fileMeta    { overflow:hidden; white-space:nowrap; text-overflow:ellipsis;
               color: var(--dsw-alias-label-tertiary); font-size:12px; line-height:15px; }
```

### 3.3 助手消息与 Markdown / 代码块

助手步骤（`assistant-step`）由 `AssistantMarkdown` 渲染（`#12-packages/client/ui-chat/src/client/chat/AssistantMarkdown.tsx` + `.module.css`），**没有角色芯片**，就是整宽 markdown 正文 + 结尾的操作行。

```css
/* AssistantMarkdown.module.css:9-21, 63-78 */
.root { display:flex; flex-direction:column;
        font-size: var(--dsh-content-font-size, 14px);
        line-height: calc(24px + var(--dsh-content-font-delta, 0px));
        color: var(--dsw-alias-label-primary); }
.body { display:flex; flex-direction:column; gap:16px }      /* 块间距 16px */
.stopped { align-self:flex-start; padding: 0 6px; border-radius:6px;
           background: var(--dsw-alias-interactive-bg-hover);
           color: var(--dsw-alias-label-tertiary);
           font-size:11px; line-height:18px }                /* 被打断时追加的标记 */
.actions { margin-top:16px; margin-left:-6px }               /* 操作行相对正文左移 6px 对齐图标光学边 */
```

块分派（`AssistantMarkdown.tsx:76-135`）：`text` → `MarkdownText`；`reasoning` → `ProcessReasoning` + `ReasoningRow`；图片 → `renderMessageImages({align:'start'})`；`tool-call` → 此层不渲染（归到工具行）；未知块 → `JsonBlock`。

**思考行（Think）** 用共享的 `DisclosureRow`（`#12-packages/client/ui-primitives/src/DisclosureRow.tsx:77-107`），标题 `t('message.think')` = `思考` / `Think`：

```css
/* ReasoningRow.module.css:6-104 */
.root:not([data-expanded]) { contain: size layout;
                             height: calc(24px + var(--dsh-content-font-delta, 0px)) }
.root[data-expanded] [data-open] [data-disclosure-row] {
  position: sticky; top: 0; z-index: 1; background: var(--dsw-alias-bg-base) }
.root[data-state='running'] .row::after {           /* 运行时 300px 宽扫光 */
  content:''; position:absolute; inset-block:0; left:0; width:300px;
  background: linear-gradient(90deg, transparent 0%,
    color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%);
  animation: dsh-reasoning-row-sweep 2.6s ease-out infinite; pointer-events:none }
.separator { flex:none; width:2px; height:2px; margin: 0 8px; border-radius:1px;
             background: var(--dsw-alias-label-caption) }    /* 标题与摘要之间的 2px 圆点 */
.summary { min-width:0; overflow:hidden; flex: 1 1 auto;
           color: var(--dsw-alias-label-tertiary);
           font-size: var(--dsh-content-font-size-secondary, 13px);
           line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
           white-space:nowrap }
.summary[data-streaming] { mask-image: linear-gradient(to right, black calc(100% - 48px), transparent) }
.thinkBody { padding: 4px 0 4px calc(22px + var(--dsh-content-font-delta, 0px)); min-width:0 }
```

**Markdown 阶梯**（`#12-packages/client/ui-primitives/src/markdown/MarkdownText.module.css`）：

| 元素 | 规则 |
|---|---|
| 根 | `.markdown { min-width:0; overflow-wrap:anywhere; font: var(--dsw-font-markdown-base); color: label-primary }`（`:5-10`） |
| h1/h2/h3 | `font: var(--dsw-font-markdown-h1/h2/h3); margin: 32px 0 16px`（21/19/18px 粗体，随字号轴位移） |
| h4 | `font: var(--dsw-font-markdown-h4); margin: 16px 0`（600 14px/24px） |
| p | `margin: 16px 0` |
| 首尾 | `> *:first-child { margin-top: 0 !important }` / `> *:last-child { margin-bottom: 0 !important }` |
| 行内 code | `display:inline-flex; align-items:center; font: var(--dsw-font-markdown-code); font-family: var(--ds-font-family-code); font-size: 0.875em !important; background: var(--dsw-alias-markdown-inline-code); border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 0 5px`（暗色底 `rgb(41,41,41)`） |
| 链接 | `color: var(--dsw-alias-link); font-weight: 500; text-decoration: none`；hover/focus `text-decoration: underline dotted; text-underline-offset: 3px`；用 3px/2px 透明 border + 负 margin 预留焦点环空间 |
| 列表 | `:where(ul, ol) { margin:16px 0; padding-left:18px }`，`li:not(:first-child) { margin-top: 6px }` |
| hr | `height: 0.5px; margin: 32px 0; background: var(--dsw-alias-border-l2)` |
| blockquote | `border-left: 2px solid var(--dsw-alias-label-caption); margin: 16px 0 0; padding-left: 14px` |
| compact 变体 | 13px/20px + `label-tertiary`，段落 margin 4px（思考行正文用） |
| 宽表 | `.md-table-wide` 用 `100cqw` 挣脱到容器宽（`AssistantMarkdown.module.css:33-43`） |

**代码块**（`ui-primitives/src/markdown/CodeBlock.tsx` + `CodeBlock.module.css` + `CodeCard.module.css`）。
聊天里 `markdownLabels(t)` 总是传 `toolbarLabels`，于是走 **card 分支**（带 `md-code-block` 全局类）：

```css
/* CodeBlock.module.css:4-18, 24-43, 78-120 */
.block { --dsl-code-block-banner-background-color: var(--dsw-alias-markdown-code-block-banner);
         --dsl-code-block-border-radius: 12px;
         --dsl-code-block-banner-font: 11px/18px var(--dsw-font-family);
         --dsl-code-block-content-font: var(--dsw-font-markdown-code-block);
         --dsl-code-block-background: var(--dsw-alias-markdown-code-block);
         position:relative; margin: 16px 0; color: var(--dsw-alias-label-primary);
         background: var(--dsl-code-block-background);
         border-radius: var(--dsl-code-block-border-radius) }
.bannerWrap { position: sticky; top: 0; z-index: 6; background-color: var(--dsw-alias-bg-base);
              border-top-left-radius: inherit; border-top-right-radius: inherit }
.block :where(pre) { font: var(--dsl-code-block-content-font); padding: 16px; margin: 0 !important;
                     overflow-x: auto; white-space: pre-wrap; word-break: break-all;
                     background: var(--dsl-code-block-background) }
.card :where(pre) { padding: 6px 22px 20px; word-break: normal; overflow-wrap: anywhere }
.card[data-code-wrap='false'] :where(pre) { white-space: pre; overflow-wrap: normal }
/* CodeCard.module.css:10-21, 56-77 —— 聊天用的标题条 */
.header { display:flex; align-items:center; justify-content:space-between; gap:12px;
          padding: 10px 18px 8px 22px; background: var(--dsl-code-block-background, var(--dsw-alias-markdown-code-block));
          color: var(--dsw-alias-label-secondary); font: 11px/18px var(--dsw-font-family) }
.language { color: var(--dsw-alias-label-tertiary); flex:none; font-family: var(--ds-font-family-code) }
.action { display:inline-flex; align-items:center; justify-content:center;
          width:24px; height:24px; padding:0; border:0; border-radius:6px;
          color: var(--dsw-alias-label-secondary); background:transparent; cursor:pointer }
.action:hover { background: var(--dsw-alias-interactive-bg-hover) }
```

解析值：代码底 `--dsw-alias-markdown-code-block` → 暗色 `rgb(27,27,28)`；标题条 `--dsw-alias-markdown-code-block-banner` → 暗色 `rgb(44,44,46)`；圆角 **12px**；正文 `--dsw-font-markdown-code-block` = **11px/19px** code 栈；标题条 11px/18px；操作按钮 24×24、圆角 6px；行内 code 底暗色 `rgb(41,41,41)`。
`lineNumbers` 时行号走 §6.5 的 CSS counter 方案（`--dsl-code-block-line-number-width`）。

**上下文 / 系统提示词行**：`ContextInjectionRow.tsx`（`DisclosureRow` + 生产者标签），标题 `message.contextInjection`=上下文注入 / `message.contextRecall`=跨会话召回；

```css
/* ContextInjectionRow.module.css:18-64 */
.sep { flex:none; width:2px; height:2px; margin: 0 8px; border-radius:1px;
       background: var(--dsw-alias-label-caption) }
.source, .summary { min-width:0; overflow:hidden; color: var(--dsw-alias-label-tertiary);
       font-size: var(--dsh-content-font-size-secondary, 13px);
       line-height: calc(24px + var(--dsh-content-font-delta, 0px));
       text-overflow:ellipsis; white-space:nowrap }
.body { width: calc(100% - 22px - var(--dsh-content-font-delta, 0px));
        max-height: 141px; margin: 4px 0 0 calc(22px + var(--dsh-content-font-delta, 0px));
        overflow: auto; padding: 10px 16px 12px 12px; border-radius: 8px;
        background: var(--dsw-alias-markdown-code-block);
        color: var(--dsw-alias-label-tertiary);
        font: 400 11px/16px var(--ds-font-family-code) }   /* ← 小号 code 字体 */
```

`SystemPromptRow.tsx` 复用同一张表，标题 `message.systemPrompt`=系统提示词 / `message.systemPromptUpdate`=系统提示词更新。

### 3.4 对话流容器与轮次

组件：`#12-packages/client/ui-chat/src/client/chat/ChatView.tsx`
样式：`#12-packages/client/ui-chat/src/client/chat/ChatView.module.css`

```css
.frame  { position:relative; display:flex; flex-direction:column; min-height:0; flex:1 1 auto;
          container-type: inline-size; }                                     /* :1-7 */
.root   { position:relative; display:flex; flex-direction:column; min-height:0; flex:1 1 auto;
          overflow-x:visible; overflow-y:clip; }                             /* :11-20 */
.scroll { flex:1 1 auto; min-height:0; overflow-y:auto;
          padding: 16px calc(var(--dsh-composer-side-clearance) + 16px);     /* 窄屏时正文比输入卡窄 32px */
          container-type: inline-size; }                                     /* :22-34 */
.column { max-width: var(--dsh-chat-content-width); width:100%; margin:0 auto;
          display:flex; flex-direction:column; }                             /* :57-66 */
.column > :not([hidden]):not(.flowItem:empty) ~ :not([hidden]):not(.flowItem:empty) {
          margin-top: var(--dsh-chat-flow-gap, 16px); }                      /* :68-72 —— 行间距 16px */
.flowItem[data-turn-process-answer] { --dsh-chat-flow-gap: 8px; }            /* :81-85 —— 折叠过程摘要紧贴答案 */
```

每条消息是一个 `.flowItem`（`:75-89`），空座位保持 0 高但保留顺序位。回到底部按钮 `.toBottom` 在 `.toBottomSlot`（`:132-183`，z-index 8，Composer 常态 z-index 7 压在其上，见 §3.0）。

### 3.5 「本轮文件改动」——**它已经不是一行 chips，而是一张卡片**

> ⚠️ **重要更正（Piggy 的 `11-dsh-reference.md` §2.1 写的是旧的"文件链接行"）**
> 字面标签 `本轮文件改动` **已从代码树中删除**。它原先是 `#12-packages/client/ui-deliverables/src/client/ProducedFiles.tsx`
> （`<div className={css.row} data-produced-files-row>`，标签 key `produced.label = '本轮文件改动'`，
> `produced.more = '+ {count} 个文件'`，上限 `SHOWN_LIMIT = 6`，容器查询按 687/583/479/375/271px 分档、每 chip 预算 96px），
> 在 commit `f937f4e23b` 中与 `ProducedFiles.module.css` 一起**被删除**，
> 依据 `.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.zh.md:51`：
> "卡片取代了中英文的『本轮文件改动』行"。
> 当前替代品就是下面这张 `ChangedFiles` 卡片（标题 `已编辑 {count} 个文件`）。
> `selectProducedFiles` 仅作为文件提及解析的输入残留（`ui-deliverables/src/client/index.ts:103-112`）。
> `packages/client/ui-chat/src` 里**不存在任何 `chip` / `Chip` 标识符**。

DSH 里这是**回合尾部的卡片**，属于独立包 `ui-deliverables`（不是 `ui-chat`）。

- 挂载点：回合尾插槽 `conversation.chat.turnTail`，入口 `#12-packages/client/ui-deliverables/src/client/Deliverables.tsx:57`（`DeliverablesTail`）→ `Deliverables`（`:71`）→ `ChangedFiles`（`Deliverables.tsx:95-97`）。注册见 `ui-deliverables/src/client/index.ts:61-81`。
- 组件：`#12-packages/client/ui-deliverables/src/client/ChangedFiles.tsx:38`
- 数据：`ChangesSummary`（宿主服务端读取，`changesSummaryUrl(sessionId, seq)`，`#12-packages/client/ui-deliverables/src/changes.ts`）
- 折叠阈值：`const COLLAPSED_ROWS = 4`（`ChangedFiles.tsx:18`）

DOM（`ChangedFiles.tsx:49-91`）：

```
div.card[data-changed-files]
  ├ button.header                        // 点击 → 在右侧栏打开本回合 review 的第 0 个文件
  │   ├ span.tile > span.tileMark > IconCodeBracketsOutline16 size={10}
  │   └ span.titles
  │       ├ span.title      "已编辑 {count} 个文件"
  │       └ span.stat > span.statCounts(+N -M) | span.previewHint("在侧边栏预览")
  ├ ul.list
  │   └ li > HoverCard(variant="preview", openDelayMs=500)
  │        └ button.row
  │            ├ span.path            // 文件展示路径（code 字体 12px）
  │            └ span.counts          // 二进制 / 过大 / +N -M
  └ (foldable) button.toggle           // "全部 {count} 个文件" / "收起" + chevron
```

样式（`#12-packages/client/ui-deliverables/src/client/ChangedFiles.module.css`，注意该文件是**单行压缩**写法，下面为等价展开）：

```css
.card  { --changes-fill: var(--dsw-static-neutral-50); --changes-hover: var(--dsw-static-neutral-100);
         display:flex; flex-direction:column; min-width:0; margin-top:4px; overflow:hidden;
         border:0.5px solid var(--dsw-alias-border-l2); border-radius:18px;
         background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
body[data-ds-dark-theme] .card { --changes-fill: var(--dsw-static-neutral-850);   /* rgb(44,44,46) */
                                 --changes-hover: var(--dsw-static-neutral-800); } /* rgb(53,54,56) */
.header { display:flex; align-items:center; gap:10px; box-sizing:border-box; width:100%;
          height:60px; margin:0; padding:8px 10px; border:0; background: var(--changes-fill);
          color:inherit; font:inherit; text-align:left; }
button.header:hover { background: var(--changes-hover); transition: background-color 120ms ease; }
.tile   { display:grid; place-items:center; width:40px; height:40px;
          border:0.5px solid var(--dsw-alias-border-l2); border-radius:10px; background: var(--changes-fill); }
.tileMark { display:grid; place-items:center; width:20px; height:20px; border-radius:8px;
          background: var(--dsw-alias-link); color: var(--dsw-static-neutral-00); }   /* 蓝底白图标 */
.title  { font-size:13px; font-weight:500; line-height:20px; ellipsis; }
.stat   { font-size:10px; line-height:16px; color: var(--dsw-alias-label-tertiary); }
.statCounts { display:inline-flex; gap:6px; font-family: var(--ds-font-family-code); }
.added   { color: var(--dsw-alias-state-success-primary); }   /* rgb(34,197,94) */
.deleted { color: var(--dsw-alias-state-error-primary); }     /* rgb(242,90,90)  */
.list  { margin:0; padding:0; list-style:none; border-top:0.5px solid var(--dsw-alias-border-l2); }
.row   { display:flex; align-items:center; justify-content:space-between; gap:10px;
         width:100%; min-height:24px; padding:7px 18px 7px 14px; border:0; background:transparent;
         color: var(--dsw-alias-label-tertiary); cursor:pointer;
         font-family: var(--ds-font-family-code); font-size:11px; line-height:18px; }
.row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.path  { min-width:0; overflow:hidden; font-size:12px; ellipsis; }
.toggle{ display:inline-flex; align-items:center; gap:4px; width:100%;
         padding:10px 18px 10px 14px; border:0; background:transparent;
         color: var(--dsw-alias-label-tertiary); font-size:12px; line-height:18px; }
.toggle svg { width:14px; height:14px; }
@media (pointer: coarse) { .row, .toggle { min-height: 44px; } }
```

文案（`#12-packages/client/ui-deliverables/src/client/locales.ts`）：

| key | 中文 | 英文 |
|---|---|---|
| `changes.title` | `已编辑 {count} 个文件` | — |
| `changes.added` / `changes.deleted` | `+{count}` / `-{count}` | 同 |
| `changes.binary` / `changes.oversized` | `二进制` / `过大` | `Binary` / `Too large` |
| `changes.openReview` | `在侧边栏查看本轮改动` | — |
| `changes.all` | `全部 {count} 个文件` | — |
| `changes.collapse` | `收起` | — |
| `changes.viewDiff` | `查看 {name} 的改动` | — |
| `presented.preview` | `在侧边栏预览` | `Preview in sidebar` |

### 3.6 「交付文件卡片」（file card）

组件：`#12-packages/client/ui-deliverables/src/client/PresentedFileCard.tsx:29`
样式：`#12-packages/client/ui-deliverables/src/client/Deliverables.module.css`

DOM（`PresentedFileCard.tsx:39-59`）：

```
div.file[data-presented-file]
  ├ button.cardPreview            // 绝对定位覆盖整卡的透明按钮（z-index:1），点击 → 侧栏预览
  ├ span.fileIcon > FileTypeIcon size={20}
  └ div.fileBody
      ├ div.details
      │   ├ span.fileName
      │   └ span.description[data-presented-description][role=status?]
      │       ├ span.secondaryText    // 扩展名大写 / 打开状态文案
      │       └ span.previewHint      // hover 时替换 secondaryText
      └ div.actions                   // 贡献式原生动作（打开方式等）
```

```css
.presented { display:grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap:10px; }
.presented[data-single='true'] { grid-template-columns: minmax(0,1fr); }
@container (max-width: 620px) { .presented { grid-template-columns: minmax(0,1fr); } }
.file   { position:relative; box-sizing:border-box; display:flex; align-items:center; gap:10px;
          min-width:0; height:60px; padding:8px 10px; overflow:hidden;
          border:0.5px solid var(--dsw-alias-border-l1); border-radius:18px;
          background: var(--deliverable-fill);        /* 暗色 rgb(44,44,46) */
          color: var(--dsw-alias-label-primary); transition: background-color 120ms ease; }
.fileIcon { display:grid; place-items:center; width:40px; height:40px; overflow:hidden;
          border:0.5px solid var(--dsw-alias-border-l1); border-radius:10px;
          background: var(--deliverable-fill); color: var(--dsw-alias-link); }
.fileName { font-size:13px; font-weight:500; line-height:20px; ellipsis; }
.description { color: var(--dsw-alias-label-tertiary); font-size:10px; line-height:16px; ellipsis; }
```

> 两张卡共用的视觉母题：**60px 高、18px 圆角、0.5px 发丝边、暗色填充 `rgb(44,44,46)`、hover 变 `rgb(53,54,56)`、左侧 40×40 图标砖（10px 圆角）**。Piggy 的事件流/文件行建议直接沿用这套尺寸。

### 3.7 消息操作行（复制 / 分支 / 用量 / 时长 / 时间戳）

组件：`#12-packages/client/ui-chat/src/client/chat/MessageIconActions.tsx:45`
样式：`#12-packages/client/ui-chat/src/client/chat/MessageIconActions.module.css`

DOM（`:82-113`）：

```
div.actions[data-clock="start"|"end"]
  ├ (clock==='start') span.timeStart          // 用户消息：时间在图标左侧
  ├ Tooltip > button.action (copy | check)
  ├ {extraActions}                            // 其他插件贡献的按钮（反馈等）
  ├ (onBranch) Tooltip > button.action (branch)
  └ (clock==='end') span.endInfo > {usageAction}{span.timeEnd}
```

```css
.actions { display:flex; align-items:center; gap:8px; height: calc(28px + var(--dsh-content-font-delta, 0px)); }
.timeStart { padding-right:12px; font-size: var(--dsh-content-font-size-secondary, 13px);
             line-height: calc(24px + var(--dsh-content-font-delta, 0px));
             color: var(--dsw-alias-label-tertiary); white-space:nowrap; }
.timeEnd   { font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);
             line-height: calc(24px + var(--dsh-content-font-delta, 0px)); color: inherit; white-space:nowrap; }
.endInfo   { display:inline-flex; align-items:center; gap:8px; margin-left:8px;
             color: var(--dsw-alias-label-tertiary); }
.action    { display:inline-flex; align-items:center; justify-content:center;
             width/height: calc(28px + var(--dsh-content-font-delta, 0px));
             padding:6px; border:none; border-radius:28px; background:transparent;
             color: var(--dsw-alias-label-tertiary); cursor:pointer; }
.action svg { width/height: calc(15px + var(--dsh-content-font-delta, 0px)); }
.actions[data-clock='end'] .action svg { width/height: calc(17px + var(--dsh-content-font-delta, 0px)); }
.action:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-secondary); }
.action[data-unavailable] { opacity: 0.4; cursor: default; }
```

- **悬停显示**（`:42-61`）：仅在有 hover 的设备上，对 `[data-actions-reveal='hover']` 的回合尾、或"后面还有用户消息"的历史用户行，`.actions { opacity: 0 }`，`hover`/`focus-within` 时 `opacity: 1`，过渡 `80ms ease`。**用 opacity 不用 display，保证布局不跳。**
- 复制成功：图标切换为 `IconCheckOutlineRegular`，1000ms 后复原（`:62-76`）。
- 时间戳格式（`#12-packages/client/ui-chat/src/client/chat/message-chrome.ts:112-136`）：同一天 → `HH:mm`；同年 → `clock.md` 模板 + 时间；跨年 → `clock.ymd`。中文模板 `'{m}月{d}日'` / `'{y}年{m}月{d}日'`（`ui-chat/src/client/locale.ts:157-158`），英文 `'{m}/{d}'` / `'{y}-{m}-{d}'`（`:315-316`）。
- 回合尾装配见 `#12-packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:64-87`：`data-actions-reveal={endsWithResponse ? 'always' : 'hover'}`，`usageAction` 仅在"性能与用量 = 详细"模式且该回合有 tokenUsage 时传入 `TurnUsagePanel`。

### 3.8 Composer（输入区）

组件：`#12-packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:45`
样式：`#12-packages/client/ui-conversation/src/client/skeleton/InputBar.module.css`

DOM（`InputBar.tsx:353-505`）：

```
div.root[.hero]
  ├ Toast（错误/提示，1 秒 hold 后淡出）
  ├ div.notice[role=status]                      // info 级提示
  ├ div.card[data-composer-card]                 // ← 输入卡本体
  │   ├ div.overlayAnchor      → renderSlot('conversation.input.overlay')
  │   ├ div.accessory          → owner accessory
  │   ├ renderSlot('conversation.input.attachments', …)   // 附件条
  │   ├ DraftEditor            // Lexical contenteditable + 绝对定位 placeholder
  │   └ div.row                // toolbar 行
  │       ├ div.tools   (hidden={activity})
  │       │   ├ Tooltip > button.add  → IconPlusOutlineMedium size={14}     // "+" 按钮
  │       │   ├ input[type=file][hidden]                                    // 真实文件选择器
  │       │   ├ div.modes  → renderSlot('conversation.input.permission')     // 权限胶囊
  │       │                → renderSlot('conversation.input.plan')           // Plan 胶囊
  │       │   └ renderSlot('conversation.input.left')
  │       └ div.trailing[.trailingActive]
  │           ├ div.standardControls (hidden={activity})
  │           │   ├ renderSlot('conversation.input.right')
  │           │   └ renderSlot('conversation.input.model', { locked })       // 模型胶囊
  │           ├ div.activity|activityExpanded → renderSlot('conversation.input.activity')
  │           ├ (interruptible) Tooltip > button.primary (停止方块)
  │           └ Tooltip > button.primary (发送箭头 / 停止方块)
  └ div.dock
      ├ (variant==='composer') renderSlot('conversation.composer.dock')      // 状态行（StatsPills）
      └ (活动态隐藏) <ContextMeter/>                                          // 上下文环
```

关键 CSS：

```css
.root { display:flex; flex-direction:column; align-items:center;
        padding: 0 var(--dsh-composer-side-clearance) 4px; }                 /* :2-11 */
.card { box-sizing:border-box; position:relative; display:flex; flex-direction:column;
        gap:12px; width:100%; max-width: var(--dsh-composer-card-max-width); padding-top:8px;
        border:0; --dsw-elevation-stroke-color: var(--dsw-alias-border-l2);
        border-radius: 22px;
        background: var(--dsw-specific-input-major);           /* 暗色 rgb(44,44,46) */
        box-shadow: var(--dsw-elevation-soft);
        font-size: var(--dsh-content-font-size, 14px);
        line-height: calc(24px + var(--dsh-content-font-delta, 0px));
        --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
        --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }  /* :45-77 */
.scroll { max-height: var(--dsh-composer-text-max-height);                   /* 336px = 14 行 */
          overflow-y:auto; margin-right:4px; }                               /* :128-134 */
.input  { box-sizing:border-box; min-height:36px; padding: 4px 8px 0 14px;
          font-family: var(--dsw-font-family); font-size:inherit; line-height:inherit;
          white-space:pre-wrap; word-break:break-word; overflow-wrap:anywhere; outline:none;
          color: var(--dsw-alias-label-primary);
          caret-color: var(--dsw-alias-state-business-primary); }            /* :169-185 */
.placeholder { position:absolute; inset: 4px 8px auto 14px;
          color: var(--dsw-alias-label-caption);
          white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
          pointer-events:none; user-select:none; }                           /* :213-222 */
.hero .input { min-height: 52px; }                                           /* :235-237 */
.row    { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between;
          gap:12px; padding: 2px 8px 6px; min-width:0; container-type: inline-size; }  /* :251-267 */
.tools  { gap: 12px; }   .modes { gap: 12px; }   .trailing { margin-left:auto; gap:12px; }  /* :285-302 */
@container (max-width: 560px) { .tools, .modes, .trailing { gap: 8px; } }     /* :305-311 */
.add    { display:grid; place-items:center; width:28px; height:28px; border:none;
          border-radius:999px; corner-shape:round;
          background: var(--dsw-specific-selector);        /* 暗色 rgb(53,54,56) */
          color: var(--dsw-alias-label-primary); cursor:pointer; }           /* :314-326 */
.select { max-width:220px; height:28px; padding: 0 20px 0 8px; border:none; border-radius:8px;
          background-color:transparent;
          background-image:url("data:image/svg+xml,…stroke='%2381858C'…");   /* 12px chevron */
          background-position: right 4px center; background-size: 12px 12px;
          color: var(--dsw-alias-label-secondary);
          font-size:13px; line-height:20px; font-weight:500; appearance:none; } /* :339-358 */
.primary{ display:grid; place-items:center; width:34px; height:34px; border:none;
          border-radius:999px; corner-shape:round;
          background: var(--dsw-alias-button-info-fill);   /* 暗色 rgb(122,170,255) */
          color:#fff; cursor:pointer; transition: background-color 100ms ease;
          transform: translateY(-2px); }                                     /* :372-391 */
.primary:hover:not(:disabled) { background: var(--dsw-alias-button-info-hover); }  /* rgb(65,118,230) */
.primary:disabled { opacity: 0.4; cursor: default; }
```

**发送 / 停止图标**（内联 SVG，`InputBar.tsx:484-492`）——发送是 16×16 的向上箭头 path，停止是 `<rect x=3 y=3 width=10 height=10 rx=3 fill="currentColor"/>`。可直接复制这两段 path。

**Placeholder 文案**（`#12-packages/client/ui-conversation/src/client/locales.ts`）：

| 场景 | 中文 | key |
|---|---|---|
| 默认（会话内） | `发消息或创建任务, / 调用指令, @ 文件或对话` | `placeholder.default`（`:16`） |
| Hero（空态） | `描述你想要构建的内容, / 调用指令, @ 文件或对话` | `placeholder.hero`（`:19`） |
| 无工作区 | `选择一个工作区开始` | `placeholder.workspace`（`:20`） |
| 会话不可用 | `会话不可用` | `placeholder.unavailable`（`:17`） |
| 父会话离线 | `父会话离线，无法继续发送；仍可停止当前运行` | `placeholder.parentOffline`（`:18`） |
| 排队插话提示 | `Cmd/Ctrl+Enter 插话发送全部排队消息` | `placeholder.steerQueue`（`:21`） |
| 优先级 | steer 提示 > Plan 占位 > 默认（`InputBar.tsx:342-351`） | |

**`+` 按钮 vs `@` 按钮**：
- `+`（`.add`，`aria-label = t('input.commands') = "添加文件或调用指令"`，`InputBar.tsx:419-432`）打开命令菜单（`aria-haspopup="listbox"`），同时它旁边的隐藏 `<input type="file" multiple>` 承担文件选择。
- **没有 `@` 按钮**。`@` 是**输入框内的触发符**：`ui-input-trigger` 监听草稿/光标，检测到 `@` 就打开引用菜单。触发源注册见 `#12-packages/client/ui-reference/src/client/index.ts:52`（`trigger: '@'`，文件 + 会话候选，`relativeTime` 标注会话年龄）。`/` 同理（命令菜单）。Piggy 若想要 `@` 图标按钮，属于额外加戏，DSH 只支持键入。

**权限胶囊**：由 `ui-permission-presets` 注册到 `conversation.input.permission`（`#12-packages/client/ui-permission-presets/src/client/index.ts:167-168`），组件 `PermissionSelect.tsx`（样式 `PermissionSelect.module.css`，102 行），并用 `@container (max-width:…)` 在窄卡下退化为纯图标（`InputBar.module.css:262-265` 的匿名容器说明：CSS Modules 会给 `container-name` 加哈希，跨模块命名容器永远匹配不上，所以必须用匿名容器查询）。

**模型胶囊**：`ui-model-selection` 注册到 `conversation.input.model`（`#12-packages/client/ui-model-selection/src/client/index.ts:181-182`），组件 `ModelSelect.tsx` + `ModelSelect.module.css`（289 行）；紧凑模式由 `.row[data-model-compact]` 把文字换成图标（`--dsh-composer-model-text-display/--dsh-composer-model-icon-display`，`InputBar.module.css:269-272`）。

### 3.9 状态行（Composer dock）

组件：`#12-packages/client/ui-chat/src/client/chat/StatsPills.tsx:316`
注册：`#12-packages/client/ui-chat/src/client/apply.ts:229-233`（`conversation.composer.dock`，`id:'stats'`，`order:0`）
样式：`StatsPills.module.css`

```css
.root { display:flex; justify-content:center; gap:12px; min-width:0; max-width:100%;
        font-size: calc(var(--dsh-content-font-size-secondary, 13px) - 1px);   /* 12px @ 默认 */
        line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px)); }
.pill { display:inline-flex; align-items:center; gap:6px; padding: 1px 8px;
        border:none; border-radius:24px; background:transparent;
        color: var(--dsw-alias-label-tertiary); font:inherit;
        font-variant-numeric: tabular-nums; white-space:nowrap; }
.pill svg { width:14px; height:14px; flex:none; }
button.pill:hover { background: var(--dsw-alias-interactive-bg-hover);
                    color: var(--dsw-alias-label-secondary); }
```

> ⚠️ `--dsw-alias-separator-primary`（`StatsPills.module.css:64`）在**整个仓库里从未被定义**（`grep -- "--dsw-alias-separator-primary:"` 零命中），因此该声明在计算值阶段失效，`.sep` 回落到继承的 pill 颜色。Piggy 直接把它绑成 `--dsw-alias-border-l2` 更稳妥。

两种模式（settings「性能与用量」）：

- **简洁**（`mode === 'compact'`，`StatsPills.tsx:332-346`）：只显示 `tok/s`（`IconGaugeOutlineRegular`）与 `缓存命中 xx%`（`IconDatabaseOutlineRegular`），两者都无则整行不渲染。
- **详细**（`:347-371`）：`{turns} 轮 {steps} 步 · {tps}` 胶囊 + `{总 tok} · 缓存命中 {%}` 胶囊，点开为对话框（`stat-dialog.module.css`）。

文案（`ui-chat/src/client/locale.ts`）：`stats.counts = '{turns} 轮 {steps} 步'`（`:57`）、`stats.cacheHit = '缓存命中 {percent}%'`（`:58`）、`stats.dialog.title = '会话统计'`（`:59`）、`stats.dialog.usageTitle = 'Token 用量'`、`stats.dialog.llmTime = '模型用时'`、`stats.dialog.toolTime = '工具调用用时'`、`stats.dialog.ttft = '首 token 平均（TTFT）'`、`stats.dialog.speed = '输出速度（TPS）'`。

### 3.10 上下文环（Context ring）

组件：`#12-packages/client/ui-conversation/src/client/skeleton/ContextMeter.tsx:56`
样式：`ContextMeter.module.css`

- 几何：`viewBox="0 0 14 14"`，`r = 5.5`，`strokeDasharray = ${C/100*percent} ${C}`（`C = 2π·5.5`），`transform="rotate(-90 7 7)"`（`ContextMeter.tsx:17-19,119-129`）。
- 触发器：`<button class="trigger">` 内是 14×14 SVG + 百分比文字，`aria-haspopup="dialog"`，Tooltip 文案 `t('context.aria', { percent })`。
- 面板（portal 到 `document.body`，`role="dialog"`，`useAnchoredPosition({ side:'top', gap:8, margin:12 })`）：标题行（`~已用 / 窗口`）+ 分段条（系统 / 工具 / 消息 三段，各带 `colorSystem/colorTools/colorMessages` 类）+ `dl.rows` 图例。
- 空态：pressure 或容量缺失时 `return null`（`:89`）。
- 位置：在 `.dock` 中，与 StatsPills 并排（`InputBar.tsx:498-503`）。

### 3.11 轮次行家族与「角色标签」真相

对话里**没有角色芯片 / 徽章 / 头像**。角色是靠**结构**表达的：

| node key | 渲染器 | 可见文字（中 / 英） | locale key |
|---|---|---|---|
| `user` / `steering` | `MessageItem.tsx:315-338`（`UserStyleBubble`） | **无**——就是右对齐气泡 | — |
| `assistant-step` | `AssistantNodeView.tsx:9-47` | **无**——正文 + 操作行；思考行是 `思考` / `Think` | `message.think` |
| `context` | `MessageItem.tsx:341-352` → `ContextInjectionRow.tsx` | `上下文注入` / Context injection；`跨会话召回` / Session recall | `message.contextInjection` / `contextRecall` |
| `system-prompt` | `SystemPromptRow.tsx:25-49` | `系统提示词` / System prompt；`系统提示词更新` / System prompt update | `message.systemPrompt*` |
| `turn-trigger` | `TurnTriggerNodeView.tsx:29-49` | `收到执行请求` / Execution requested；`定时任务` / Scheduled task；… | `message.trigger.*` |
| `turn-process` | `TurnProcessNodeView.tsx:10-67` | `深度求索中，用时{duration}`；`用时 {duration}`；`已停止` | `message.turnProcess.*` / `message.stopped` |
| `turn-error` / `turn-max-tokens` / `model-retry` / `compaction` / `unknown` | `MessageItem.tsx:125-154,355-387` | `本轮运行失败`；`已达到输出 token 上限`；`上下文已压缩` | `message.turnError` / `message.maxTokens` / `message.retry.*` / `message.compaction` |
| `command` | `CommandNodeView.tsx` | `指令` / Command | `command.title` |

> ⚠️ **常见误解纠正**：**人类输入的提示不是 `TurnTriggerNodeView`**。人类提示是 node kind `user` → `MessageItem.tsx` 的 `UserStyleBubble`（右对齐气泡）。
> `TurnTriggerNodeView` 是**非人类触发器**的通知卡（收到执行请求 / 定时任务 / webhook / 子任务状态更新…）。

**`turn-trigger` 通知卡**（`TurnTriggerNodeView.tsx:37-48`）：

```
section.root[data-turn-trigger]
└ button.header[aria-expanded][aria-controls] > span.icon + span.title + time.time + IconChevronDownOutlineRegular
  (展开) div#bodyId.body > p.explanation + div.content > NoticeBody
```

```css
/* TurnTriggerNodeView.module.css:1-29 */
.root { min-width:0; border: 0.5px solid var(--dsw-alias-border-l1); border-radius: 16px;
        background: var(--dsw-alias-markdown-code-block);      /* 暗色 rgb(27,27,28) */
        transition: background-color 100ms ease }
.root:hover { background: var(--dsw-alias-interactive-bg-hover) }
.header { display:flex; align-items:center; gap:10px; width:100%; padding: 12px 16px;
          border:0; background:none; color: var(--dsw-alias-label-primary);
          font: inherit; text-align:left; cursor:pointer }
.icon  { display:inline-flex; flex:none; color: var(--dsw-alias-label-tertiary) }
.title { flex:none; font: var(--dsw-font-xs-13) }             /* 13px/20px */
.time  { flex:none; margin-left:auto; color: var(--dsw-alias-label-caption); font: var(--dsw-font-xxs-12) }
.openChevron { transform: rotate(180deg) }
.body  { padding: 0 16px 12px 40px }
.content { max-height:240px; overflow:auto; white-space:pre-wrap; overflow-wrap:anywhere; font: var(--dsw-font-xxs-12) }
```

说明文案 `t('message.trigger.explanation')` = `这条通知触发了本轮回复。`。

**`turn-process`「深度求索中 / 用时 Ns」行**（`TurnProcessNodeView.tsx:48-65`）——**单个 `<button>`**：

```css
/* TurnProcessNodeView.module.css:1-50 */
.root { box-sizing:border-box; display:flex; align-items:center; width:100%; min-width:0;
        height: calc(33px + var(--dsh-content-font-delta, 0px)); padding: 0 0 8px;
        border: none; border-bottom: 0.5px solid var(--dsw-alias-border-l2);
        background: none; color: var(--dsw-alias-label-tertiary);
        cursor:pointer; text-align:left; transition: color 100ms ease }
.root:not([data-open]) { margin-bottom: 8px }
.chevron { flex:none; width:14px; height:14px; margin-left:4px;
           color: var(--dsw-alias-label-caption); transition: transform 100ms ease }
.root[data-open] .chevron { transform: rotate(180deg) }
.label { min-width:0; overflow:hidden;
         font-size: var(--dsh-content-font-size-secondary, 13px);
         line-height: calc(24px + var(--dsh-content-font-delta, 0px));
         text-overflow:ellipsis; white-space:nowrap }
```

数据属性 `data-open`、`data-turn-process={turn}`、`data-turn-process-messages|tool-calls|subagents`；另有 `role="status" aria-live="polite"` 的视觉隐藏区（`accessibility.module.css:1-8`）。

**`turn-tail` 回合尾**（`TurnTailNodeView.tsx:56-79`）：`div.root[data-turn-tail={turn}][data-actions-reveal={endsWithResponse?'always':'hover'}]`；先 `renderSlot('conversation.chat.turnTail', owner)`（文件卡就挂在这），再 `MessageIconActions`。

```css
/* TurnTailNodeView.module.css:1-12 */
.root { display:flex; flex-direction:column; gap:16px }
.actions { margin-top: 4px; margin-left: -6px }
```

**对话滚动容器补充数值**（`ChatView.module.css:110-178`）：

```css
/* 加载更早的胶囊 */
.older button { border-radius:14px; padding: 4px 12px; font-size:12px;
                color: var(--dsw-alias-label-secondary);
                background: var(--dsw-alias-interactive-bg-hover-solid) }  /* 暗色 rgb(53,54,56) */
/* 回到底部（浮动 34px 圆钮，z-index 8；Composer 常态 z-index 7 不会盖住它） */
.toBottomSlot { position:absolute; right:0; bottom:16px; left:0; z-index:8; height:0;
                display:flex; justify-content:flex-end;
                padding-right: max(calc(var(--dsh-composer-side-clearance) + 16px),
                                   calc((100% - var(--dsh-chat-content-width)) / 2));
                pointer-events:none }
:global([data-conversation-scroll]) .toBottomSlot { position: sticky;
                bottom: calc(var(--dsh-composer-height, 152px) + 16px) }
.toBottom { display:flex; align-items:center; justify-content:center;
            width:34px; height:34px; margin-top:-34px; padding:0; border:0;
            --dsw-elevation-stroke-color: var(--dsw-alias-border-l3);
            border-radius:100px; corner-shape:round;
            color: var(--dsw-alias-label-primary);
            background: var(--dsw-alias-button-floating-fill);  /* 暗色 rgb(44,44,46) */
            box-shadow: var(--dsw-elevation-panel); cursor:pointer; pointer-events:auto }
.toBottom:hover { background: var(--dsw-alias-button-floating-hover) }      /* 暗色 rgb(53,54,56) */
```

**轮次分组靠数据属性，不靠包裹元素**：每个座位输出 `data-chat-flow-key`、`data-chat-anchor-key`、`data-chat-flow-kind={kind}`、`data-chat-turn={turn}`、`data-chat-group-part`（`ChatNodeSeat.tsx:146-160`），轮次轨道/视口靠读 `data-chat-turn` 定位（`chat/use-chat-viewport.ts:233,262`）。

**读到哪记到哪 = 行锚点，不是裸像素**（Piggy 2026-09-23 对齐）：DSH 的阅读位置是
`ChatScrollPosition = { anchorKey, anchorTop, scrollTop }` —— 视口顶端那一行的
`data-chat-anchor-key` + 它到视口顶的距离，裸 `scrollTop` 只作兜底
（`chat/use-chat-viewport.ts:166-200` 的 `capturePosition`：先用 `elementsFromPoint`
取顶部那一行，退化时用二分找第一行，返回 `{anchorKey, anchorTop, scrollTop}`）。
打开会话时 `ChatReading.restore()` 先读这份记忆，**没有记忆才贴底**
（`chat/use-chat-reading.ts:82-95`：`const saved = this.store.read(); if (saved === null) { this.followTail(); return }`）。
跟随意图与读者采样在 `chat/use-scroll-follow.ts`（`ScrollFollow.sample/settle/jump/toBottom`，
`sampledTop` 用来把"程序化滚动"排除在读者意图之外），容差 `FOLLOW_THRESHOLD = 24`
（`use-chat-reading.ts:9`；Piggy 用 25，见 04 §2.1.1）。
Piggy 的对应实现：`readerAnchorOf` / `readerTopFrom`（`features/chat/transcriptScroll.ts`），
锚点按虚拟化器的 **`getItemKey`（行键）** 找回，找不到那一行才退回裸位置。

---

## 4. 轨迹视图（Trajectory）

包：`#12-packages/client/ui-trajectory/src/client/`（下文 `TR = ui-trajectory/src/client`）。

### 4.1 注册与宿主

`TR/index.ts:79-112`：

```ts
ctx.slots.register({
  name: 'conversation.view', id: 'trajectory', order: 10, locale: NS,
  label: () => t('view.trajectory'),                       // 轨迹 / Trajectory（TR/locales.ts:8 / :210）
  children: { 'conversation.trajectory.images': { kind: 'single', scope: 'session' } },
  inject: …,
}, TrajectoryView)
```

- **轨迹页签受"开发者工具"开关控制**：`apply.ts:182` 在 `!ctx.configForms.developerTools.enabled` 时跳过 `DEVELOPER_TOOLS_VIEW_ID = 'trajectory'`（`ui-conversation/src/client/view-selection.ts:7`）。Piggy 若不做开关，直接常驻即可。
- 视图挂载点：`ui-conversation/src/client/skeleton/DefaultConversationViews.tsx:35-46` → `<div className={css.viewArea}>{renderSlot('conversation.view', …, { only: viewId })}</div>`。
- 轨迹自己拥有滚动容器，所以 `ConversationRoot.module.css:460-480` 的 `:has([data-conversation-composer-overlay])` 规则把宿主 `.viewArea` 变成 `flex:1 1 0; overflow:hidden` 且 `scrollbar-gutter: auto`。

### 4.2 根结构（`TrajectoryView.tsx:510-576` + `views.module.css`）

```
div.root[data-conversation-composer-overlay]
├─ TrajectoryToolbar      // sticky，32px
├─ TrajectoryTimeline     // 固定 50px 总览带，z-index:1
└─ div.ledger
   └─ TrajectoryTable     // div.split → div.tablePane（真正滚动）+ aside.details
```

```css
/* views.module.css:1-28（全文） */
.root {
  --dsh-trajectory-toolbar-height: 32px;
  display: flex; flex-direction: column; overflow: hidden; height: 100%;
  min-height: 0; width: 100%; box-sizing: border-box;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-1);        /* 暗色 rgb(35,35,36) */
}
.ledger {
  position: relative; z-index: 0; isolation: isolate;
  display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden;
  --dsh-trajectory-bottom-clearance: calc(var(--dsh-composer-height, 152px) + 16px);
}
```

滚动容器是 `TrajectoryTable` 内的 `div.tablePane[data-trajectory-scroll]`（`TrajectoryTable.tsx:2583-2586`）；`.ledger` 本身 `overflow:hidden`，整体不滚。

**折叠状态**：`collapsedTurns: ReadonlySet<number>` / `collapsedAssistants: ReadonlySet<string>`（`TrajectoryView.tsx:139-146`）。可折叠判定：轮次需 >1 个非系统、非 requestOnly 单元（`:428-441`）；助手折叠 = 消息单元后面紧跟 tool/subtool（`:444-458`）。`timelineMode`（`:346-348`）= `actualDuration ? (actualTime ? 'actual' : 'duration') : (actualTime ? 'time' : 'sequence')`。

### 4.3 虚拟行（`TR/trajectory-virtual-rows.ts`）

| 常量 | 值 |
|---|---|
| `CONTENT_ROW_HEIGHT` | `30` |
| `COLLAPSED_SUMMARY_HEIGHT` | `20` |
| `TERMINAL_BOUNDARY_HEIGHT` | `9` |

关键设计：`requestOnly`（压缩边界、无可见行）的记录**前插进下一条内容行的 `entries`**，虚拟器永远不会持有 0 高项；尾部连续的 requestOnly 合并成一条 9px 行（`:57-80`）。虚拟化阈值：`VIRTUALIZATION_THRESHOLD = 100` 条记录或 `hasOlderRecords`；`VIRTUAL_OVERSCAN_ROWS = 12`；`VIRTUAL_INITIAL_VIEWPORT_HEIGHT_PX = 600`；`anchorTo:'end'`，`followOnAppend:'auto'`，`scrollEndThreshold = 2px`（`TrajectoryTable.tsx:2166-2190`）。上下 spacer 是 `tr.virtualSpacer[data-virtual-spacer='top'|'bottom'] > td`，高度走 `--trajectory-virtual-spacer-height`（`:2648-2657, :2913-2922`；CSS `TrajectoryTable.module.css:161-169`）。

### 4.4 工具栏（`TrajectoryToolbar.tsx` + `.module.css`）

> ⚠️ **没有角色过滤器**。工具栏只有 4 个按钮 + 1 个搜索框；唯一的"过滤"是文本搜索（全包 `grep filter` 只命中 `TrajectoryTable.tsx:514` 的 `filterRecords`）。`11-dsh-reference.md` §2.1 写的"过滤 + 搜索"应更正为"折叠控制 + 搜索"。

```
div.root[role=toolbar][aria-label="轨迹工具栏"]
└─ div.inner
   ├─ div.actions
   │  ├─ button.toggle[aria-pressed][title="使用实际时长"|"使用等宽操作"] > svg.toggleIcon + "时长"
   │  ├─ button.control[role=switch][aria-checked][hidden] > span + span.controlTrack > span.controlThumb
   │  ├─ button.action[aria-pressed][title="收起所有轮次"] > span.actionIcon("⊟"/"⊞") + "轮次"
   │  └─ button.action[aria-pressed][title="收起所有调用"] > span.actionIcon("⊟"/"⊞") + "调用"
   └─ div.search > IconSearchOutlineRegular(size 11) + input.searchInput[type=search][placeholder="搜索"]
```

文案（`TR/locales.ts:9-21` 中文 / `:211-223` 英文）：

| 元素 | key | 中文 | 英文 |
|---|---|---|---|
| toolbar aria | `toolbar.aria` | 轨迹工具栏 | Trajectory toolbar |
| 时长开关标签 | `toolbar.duration` | 时长 | Duration |
| 时长开关 title（关） | `toolbar.useActualDuration` | 使用实际时长 | Use actual duration |
| 时长开关 title（开） | `toolbar.useEqualWidth` | 使用等宽操作 | Use equal-width operations |
| 隐藏开关 | `toolbar.actualTime` | 实际时间 | Actual time |
| 轮次按钮 | `toolbar.turns` | 轮次 | Turns |
| 轮次 aria | `toolbar.expandTurns` / `toolbar.collapseTurns` | 展开所有轮次 / 收起所有轮次 | Expand turns / Collapse turns |
| 调用按钮 | `toolbar.calls` | 调用 | Calls |
| 调用 aria | `toolbar.expandCalls` / `toolbar.collapseCalls` | 展开所有调用 / 收起所有调用 | Expand calls / Collapse calls |
| 搜索 aria / placeholder | `toolbar.search` / `toolbar.searchPlaceholder` | 搜索轨迹 / 搜索 | Search trajectory / Search |

`⊞`/`⊟` 是纯文本字形（`TrajectoryToolbar.tsx:96, :109`）。"实际时间"开关被渲染但 `hidden`（`:79`），`.control[hidden]{display:none}`（`TrajectoryToolbar.module.css:87-89`）。

```css
/* TrajectoryToolbar.module.css */
.root { position:sticky; top:0; z-index:4; box-sizing:border-box; width:100%;
        height: var(--dsh-trajectory-toolbar-height);            /* 32px */
        border-bottom: 0.5px solid var(--dsw-alias-border-l2);
        background: var(--dsw-alias-bg-layer-1); }               /* :1-10 */
.inner  { display:flex; align-items:center; width:100%; height:100%; padding:0 6px; gap:8px }  /* :12-19 */
.actions{ display:flex; flex:none; align-items:center; gap:2px }                               /* :21-27 */
.toggle { inline-flex; height:20px; padding:0 7px; gap:4px; border:0; border-radius:3px;
          color: var(--dsw-alias-label-tertiary); background:transparent; font: var(--dsw-font-xxs-12) }  /* :29-42 */
.toggle[aria-pressed='true'] { color: var(--dsw-alias-label-primary);
                               background: var(--dsw-alias-interactive-bg-hover) }             /* :49-52 */
.toggle:focus-visible { outline: 1px solid var(--dsw-alias-state-business-primary); outline-offset:1px } /* :54-57 */
.toggleIcon { width:12px; height:12px; stroke:currentColor; stroke-width:1.25 }                /* :59-67 */
.controlTrack { width:20px; height:10px; border-radius:5px; background: var(--dsw-alias-border-l2);
                transition: background-color 120ms var(--ds-ease-in-out) }                     /* :107-116 */
.controlThumb { position:absolute; top:2px; left:2px; width:6px; height:6px;
                border-radius:50%; corner-shape:round; background: var(--dsw-alias-bg-layer-1) } /* :118-128 */
.controlTrack[data-on='true'] { background: var(--dsw-alias-state-business-primary) }
.controlTrack[data-on='true'] .controlThumb { transform: translateX(10px) }                    /* :130-136 */
.action { inline-flex; height:20px; padding:0 5px; gap:4px; border:0; border-radius:3px;
          color: var(--dsw-alias-label-tertiary); background:transparent; font: var(--dsw-font-xxs-12) }  /* :138-151 */
.actionIcon { color: var(--dsw-alias-label-tertiary); font: 14px/14px var(--ds-font-family-code) }        /* :163-166 */
.search { display:flex; flex: 0 1 164px; align-items:center; min-width:84px; height:22px;
          margin-left:auto; padding:0 6px; gap:4px;
          border: 0.5px solid var(--dsw-alias-border-l4); border-radius:4px;
          color: var(--dsw-alias-label-caption); background: var(--dsw-alias-bg-layer-2) }     /* :168-181 */
.search:focus-within { border-color: var(--dsw-alias-state-business-primary);
                       background: var(--dsw-alias-bg-layer-1) }                               /* :187-190 */
.searchInput { width:100%; min-width:0; padding:0; border:0; outline:0;
               color: var(--dsw-alias-label-primary); background:transparent; font: var(--dsw-font-xxs-12) } /* :196-205 */
```

### 4.5 事件账本（`TrajectoryTable.tsx` 3506 行 + `TrajectoryTable.module.css` 1984 行）

```
div.split[style=--trajectory-tool-request-width]     // container-type: inline-size
├─ div.tablePane[data-trajectory-scroll]             // ★ 唯一滚动容器
│  ├─ div.historyLoading[role=status] > span.historyLoadingBar > StateDot + "正在加载轨迹…"
│  └─ table.table[data-scroll-ready][aria-rowcount]
│     ├─ colgroup > col.eventColumn + col.contentColumn
│     └─ tbody
│        ├─ tr.historyLoadRow[data-history-load] > td[colspan=2] > button.historyLoadButton
│        ├─ tr.virtualSpacer[data-virtual-spacer=top] > td
│        ├─ tr[data-kind][data-record-index][data-turn-start][data-turn-end][data-selected]
│        │  ├─ td.event
│        │  │  ├─ button.requestBoundaryControl[data-label][data-request-status]
│        │  │  ├─ span.turnRail / span.selectionRail
│        │  │  ├─ span.turnLabel(.turnLabelActive) > span.turnLabelFull + span.turnLabelCompact
│        │  │  └─ div.eventInner > span.kindSlot > span.kindTag[data-role-kind]
│        │  │        > span.kindTagIcon(Icon) + span.kindTagLabel("助手")
│        │  └─ td.content > span.contentText | span.resultPreview
│        │        > span.resultRequest > span.toolCallNameTypeface + span.toolCallPayload
│        │        + span.inlineResult > span.arrow"→" + span.inlineResultText
│        └─ tr.virtualSpacer[data-virtual-spacer=bottom] > td
└─ aside.details[aria-label="事件详情"] > div.detailsResizeHandle[role=separator]
                                          + div.detailsHeader + div.detailTabs + div.detailBody
```

> 实测：渲染里**没有 `<thead>`/`<th>`**（`.table th` / `.eventHeader` 是死 CSS）。

```css
/* TrajectoryTable.module.css:99-125, 151-159, 369-373, 426-436 */
.table { --trajectory-turn-accent: color-mix(in srgb, var(--dsw-static-blue-500) 22%, var(--dsw-alias-bg-layer-1));
         table-layout: fixed; border-spacing: 0; font: var(--dsw-font-xxs-12); }
.eventColumn   { width: 122px }   .eventColumn:where(:lang(zh)) { width: 84px }   /* 中文更窄！ */
.contentColumn { width: auto }
.table td { box-sizing:border-box; height:30px; padding:0 8px; overflow:hidden;
            border-bottom: 0.5px solid var(--dsw-alias-border-l1);
            text-overflow:ellipsis; white-space:nowrap }
.event    { overflow:visible !important; padding-right:4px !important; padding-left:36px !important }
.kindSlot { display:flex; flex:none; align-items:flex-end; justify-content:flex-end; width:76px }
.kindSlot:where(:lang(zh)) { width: 44px }
```

响应式：`@container trajectory-table (max-width: 620px)`（`:491-537`）把 `eventColumn` 收窄到 50px、`.event` padding-left 到 28px、`.kindSlot` 到 19px，并折叠 `.kindTagLabel`（`max-width:0; opacity:0`），轮次标签换成 `#N`。

轨道与边界：`.turnRail{z-index:4; top:-1px; bottom:-1px; width:2px; background:var(--trajectory-turn-accent)}`（`:320-326`）；`.selectionRail{z-index:5; top:0; bottom:0; width:3px; background:var(--dsw-alias-brand-primary-new-colorprimary-new-color)}`（`:332-337`，暗色 `rgb(86,134,254)`）；错误变体换成 22% error 混合 / `--dsw-alias-state-error-primary`（`:339-349`）；`tr[data-turn-start]:not(:first-child) td::before` 画 2px、`translateY(-50%)` 的 `border-l1` 分隔（`:356-367`）；请求点 = 16×16 命中区 + 5px 圆点（`:216-247`），tooltip 用 `content: attr(data-label)` 做 9px/12px 等宽字（`:249-270`）。

**工具行 `args → result`**（`TrajectoryTable.tsx:2879-2906`）：

```tsx
<span className={resultText === undefined ? css.contentText : css.resultPreview}
      title={resultText === undefined ? listDisplayText : `${listDisplayText} → ${resultText}`}>
  <span className={resultText === undefined ? undefined : css.resultRequest}>
    <RecordListText displayText={displayText} toolCallOnly={toolCallOnly}
                    toolCallText={toolCallText} t={t} />
  </span>
  {resultText !== undefined && (
    <span className={record.cell.isError ? `${css.inlineResult} ${css.error}` : css.inlineResult}>
      <span className={css.arrow}>→</span>
      <span className={resultText === t('record.noOutput')
        ? `${css.inlineResultText} ${css.noOutputText}` : css.inlineResultText}>
        {resultText}
      </span>
    </span>
  )}
</span>
```

```css
/* TrajectoryTable.module.css:764-825 */
.resultPreview {
  display: grid;
  grid-template-columns: clamp(180px,
    var(--trajectory-tool-request-width, calc(36cqw - 56px)), 480px) minmax(0, 1fr);
  align-items: center; min-width: 0; gap: 8px;
}
.resultRequest, .inlineResultText { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.toolCallNameTypeface { color: var(--dsw-alias-label-primary);
  font: 400 12px/18px Menlo, Consolas, 'Liberation Mono', 'PingFang SC', 'Microsoft YaHei' }
.toolCallPayload { margin-left:7px; color: var(--dsw-alias-label-secondary); font: 400 12px/18px var(--ds-font-family-code) }
.table tbody tr[data-kind='tool'] .contentText,
.table tbody tr[data-kind='subtool'] .contentText,
.table tbody tr[data-kind='tool'] .resultPreview,
.table tbody tr[data-kind='subtool'] .resultPreview { font-family: var(--ds-font-family-code); font-size: 12px }
.table tbody tr[data-kind='subtool'] .content { padding-left: 26px }
.inlineResult { display:flex; align-items:center; min-width:0; color: var(--dsw-alias-label-secondary) }
.noOutputText { color: var(--dsw-alias-label-caption) }
.arrow { flex:none; margin-right:8px; color: var(--dsw-alias-label-caption) }
.error { color: var(--dsw-alias-state-error-primary) }
```

文案：`record.noOutput` = `无输出` / `No output`（`TR/locales.ts:107` / `:309`）；仅工具调用 = `（仅工具调用）` / `(tool call only)`；缺 payload 显示 `—`（`TrajectoryTable.tsx:1110`）。请求列默认宽 `calc(58cqw - Npx)`（`TOOL_REQUEST_SHARE=0.58`、`DEFAULT_TOOL_REQUEST_SHARE=0.36`、`DEFAULT_TOOL_REQUEST_OFFSET=56`，min/max 180/480，`:217-221, :2330-2334`）。

详情面板：`.details{width:clamp(320px, 38%, 440px); max-width:calc(100% - 280px); border-left:0.5px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1)}`（`:853-864`）；`.detailsHeader{height:42px}`（`:885-894`）；`.detailTabs{height:34px; padding:0 8px; gap:1px; overflow-x:auto}`（`:949-965`）；`.detailTabActive::after{height:2px; background:var(--dsw-alias-state-business-primary)}`（`:987-1000`）；`DETAILS_MIN_WIDTH 320 / DETAILS_MAX_WIDTH 720 / TABLE_MIN_WIDTH 280 / DETAILS_RESIZE_STEP 16`（`:213-216`）。

### 4.6 角色芯片（kind tag）

标签映射（`TrajectoryTable.tsx:52-60`）：

```ts
const KIND_LABEL_KEY: Record<TrajectoryCellKind, TrajectoryKey> = {
  system: 'kind.system', user: 'kind.user', context: 'kind.context', compacted: 'kind.compacted',
  message: 'kind.assistant',      // 账本把 assistant 叫「助手」
  tool: 'kind.tool', subtool: 'kind.subtool',
}
```

| kind | key | 中文 | 英文 | 色类 |
|---|---|---|---|---|
| system | `kind.system` | 系统 | **SYSTEM** | `systemNeutral` |
| user | `kind.user` | 用户 | **USER** | `.user` |
| context | `kind.context` | 上下文 | **CONTEXT** | `contextGreen` |
| message | `kind.assistant` | 助手 | **ASSISTANT** | `assistantVioletBright` |
| tool | `kind.tool` | 工具 | **TOOL** | `toolAmber` |
| subtool | `kind.subtool` | 子工具 | **SUBTOOL** | `subtoolAmber` |
| compacted | `kind.compacted` | 已压缩 | **COMPACTED** | `.compacted` |

> 注意：**中文标签是中文，英文标签是全大写**；`label` 字段名是 `kind.assistant`（不是 `kind.message`）。

图标（`KIND_ICON`，`:123-131`）：system→settings、user→user、context→information、compacted→compact、message→sparkle、tool/subtool→wrench。
**`11-dsh-reference.md` 提到的 `label` / `分支` 芯片在 kind 枚举里不存在**——轨迹的 kind 只有上面 7 种（"label" 是文档转述误差）。

芯片 DOM（`:2830-2866`）：

```tsx
<span className={css.kindSlot}>
  <span
    className={`${css.kindTag} ${
      record.cell.kind === 'system' ? css.systemNeutral
      : record.cell.kind === 'context' ? css.contextGreen
      : record.cell.kind === 'compacted' ? css.compacted
      : record.cell.kind === 'tool' ? css.toolAmber
      : record.cell.kind === 'message' ? css.assistantVioletBright
      : record.cell.kind === 'subtool' ? css.subtoolAmber
      : css[record.cell.kind]}`}
    data-role-kind={record.cell.kind}
  >
    <Tooltip label={t(KIND_LABEL_KEY[record.cell.kind])} side="right">
      <span className={css.kindTagIcon} aria-hidden="true">{KIND_ICON[record.cell.kind]}</span>
    </Tooltip>
    <span className={css.kindTagLabel}>{t(KIND_LABEL_KEY[record.cell.kind])}</span>
  </span>
</span>
```

```css
/* TrajectoryTable.module.css:450-484 */
.kindTag { display:inline-flex; flex:none; align-items:center; box-sizing:border-box;
           height:19px; padding:0 5px; border:1px solid transparent; border-radius:4px;
           font-size:10px; line-height:16px; font-weight:650; letter-spacing:0.035em;
           user-select:none }
.kindTagIcon { display:inline-flex; flex:none; align-items:center; justify-content:center;
               width:0; height:13px; overflow:hidden; opacity:0; transform:scale(0.8) }
.kindTagLabel { display:inline-block; max-width:72px; overflow:hidden; opacity:1; white-space:nowrap }
```

各角色配色（`:581-707`）与**暗色解析值**：

```css
.user        { color: var(--dsw-alias-state-business-primary); background: var(--dsw-alias-state-business-tertiary) }
.systemNeutral{ color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform) }
.contextGreen{ color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 68%, var(--dsw-alias-label-secondary));
               background: var(--dsw-alias-state-success-tertiary) }
.compacted   { color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-module-platform) }
.assistantVioletBright {
  color: color-mix(in srgb, var(--dsw-alias-brand-primary-new-colorprimary-new-color) 60%,
                           var(--dsw-alias-state-error-secondary));
  background: color-mix(in srgb, color-mix(in srgb,
      var(--dsw-alias-brand-primary-new-colorprimary-new-color) 55%,
      var(--dsw-alias-state-error-secondary)) 15%, var(--dsw-alias-bg-layer-1)); }
.toolAmber   { color: var(--dsw-alias-state-warn-label); background: var(--dsw-alias-state-warn-tertiary) }
.subtoolAmber{ color: color-mix(in srgb, var(--dsw-alias-state-warn-label) 62%, var(--dsw-alias-label-tertiary));
               background: color-mix(in srgb, var(--dsw-alias-state-warn-tertiary) 58%, var(--dsw-alias-bg-layer-1)); }
```

| 角色 | 暗色文字 | 暗色底 |
|---|---|---|
| 系统 / 已压缩 | `rgb(207,211,214)` | `rgb(53,54,56)` |
| 用户 | `rgb(122,170,255)` | `rgb(52,65,91)` |
| 上下文 | ≈ `rgb(89,201,132)` | `rgb(35,60,44)` |
| 助手 | ≈ `rgb(148,116,188)` | ≈ `rgb(53,47,58)` |
| 工具 | `rgb(221,134,41)` | `rgb(39,36,31)` |
| 子工具 | ≈ `rgb(203,151,95)` | ≈ `rgb(37,36,33)` |

（混色为 sRGB 直线插值结果。Piggy 直接写 `color-mix()` 更稳，不必硬编码。）

### 4.7 三轨时间线（`TrajectoryTimeline.tsx` 739 行 + `.module.css` 327 行 + `timeline.ts` 205 行）

三轨定义（`timeline.ts:51-55`）：

```ts
function laneFor(kind: TrajectoryCellKind): number {
  if (kind === 'tool' || kind === 'subtool') return 2      // 工具
  if (kind === 'message' || kind === 'compacted') return 1 // 模型
  return 0                                                 // 输入（system | user | context）
}
```

轨道名直接复用轮次表头列名（`TrajectoryTimeline.tsx:192-200`）：lane0 = `column.input` 输入 / Input，lane1 = `column.model` 模型 / Model，lane2 = `column.tools` 工具 / Tools（`TR/locales.ts:31-36`）。

几何：以自定义属性逐 span 发出（`TrajectoryTimeline.tsx:703-729`），lane 顶 = `lane * 14px`，高 8px，左右各内缩 `min(8% 宽, 1px)`：

```tsx
<span aria-hidden="true" className={css.span}
  data-timeline-span={span.kind} data-timeline-record-index={span.index}
  data-assistant-timing={ttftFraction === null ? undefined : 'true'}
  data-error={span.isError || undefined}
  data-equal-duration={mode === 'time' || undefined}
  data-current={span.index === selectedIndex || undefined}
  data-hovered={hover?.recordIndex === span.index || undefined}
  data-search-match={searchMatchIndexes === null ? undefined
    : searchMatchIndexes.has(span.index) ? 'true' : 'false'}
  data-selected={activeRange === null ? undefined
    : span.start <= activeRange.end && span.end >= activeRange.start ? 'true' : 'false'}
  style={{
    '--trajectory-span-left': `${left * 100}%`,
    '--trajectory-span-width': `${widthPercent}%`,
    '--trajectory-span-gap': `min(${widthPercent * 0.08}%, 1px)`,
    '--trajectory-span-lane': span.lane,
    ...(ttftFraction === null ? {} : { '--trajectory-assistant-ttft': `${ttftFraction * 100}%` }),
  } as CSSProperties} />
```

```css
/* TrajectoryTimeline.module.css:1-8, 14-58, 118-125, 153-170 */
.root { position:relative; z-index:1; isolation:isolate; flex:none;
        border-bottom: 0.5px solid var(--dsw-alias-border-l2); user-select:none }
.plot { display:grid; grid-template-columns: 44px minmax(0,1fr); height:50px;
        overflow:hidden; background: var(--dsw-alias-bg-layer-2) }      /* 暗色 rgb(44,44,46) */
.labels { position:relative; border-right: 0.5px solid var(--dsw-alias-border-l1);
          color: var(--dsw-alias-label-caption); font: var(--dsw-font-xs-13); font-size:10px; line-height:1 }
.labels span { position:absolute; right:3px; display:flex; align-items:center;
               justify-content:flex-end; height:8px; text-align:right }
.labels span:nth-child(1) { top:7px }  .labels span:nth-child(2) { top:21px }  .labels span:nth-child(3) { top:35px }
.track { position:relative; overflow:hidden; cursor:crosshair; touch-action:none }
.track[data-panning='true'] { cursor:grabbing }
.lanes { position:absolute; z-index:2; top:7px; bottom:7px;
         left: var(--trajectory-domain-left); width: var(--trajectory-domain-width) }
.span  { position:absolute; top: calc(var(--trajectory-span-lane) * 14px);
         left: calc(var(--trajectory-span-left) + var(--trajectory-span-gap));
         width: max(2px, calc(var(--trajectory-span-width) - var(--trajectory-span-gap) - var(--trajectory-span-gap)));
         height:8px; min-width:2px; border-radius:1px;
         background: var(--dsw-alias-label-secondary); opacity:0.78 }
```

三轨在 50px 内的 y 位置：**7px / 21px / 35px**，与左侧 44px 标签栏的 3 个标签严格对齐；标签栏右侧一条 0.5px `border-l1`。

Span 颜色（`:172-227`）：默认（system/compacted）`label-secondary` @0.78；`user` = `state-business-primary`；`context` = 与芯片同款 68% success 混色；`message` = `--trajectory-assistant-decoding-color` @1，其中 TTFT 段用 `--trajectory-assistant-ttft-color`（decoding 色的 54% 混 `bg-layer-2`），以 `var(--trajectory-assistant-ttft)` 为断点画横向两段渐变；`tool`/`subtool` = `state-warn-label`；`[data-error='true']` = `state-error-primary`；`[data-equal-duration='true']{width:8px;min-width:8px}`；`[data-selected='false']{opacity:0.2}`；`[data-search-match='false']{opacity:0.14}`；hover/current 加 `z-index:1; opacity:1` + 双环 `box-shadow`。

暗色字面值：默认轨 `rgb(207,211,214)`；用户 `rgb(122,170,255)`；上下文 ≈`rgb(89,201,132)`；助手 decoding ≈`rgb(148,116,188)`、TTFT ≈`rgb(100,83,123)`；工具 ≈`rgb(221,134,41)`；错误 `rgb(242,90,90)`。

叠层与 z 序：`.earlierHistory` z5（`:64-102`，28px 宽渐隐、`opacity:0.72`、tooltip `点击加载更早的历史` / `Click to load earlier history`）；`.turnBoundaries` z3 + 0.5px `.turnBoundary`（`:127-151`）；`.selectionEdges` z4，3px business-primary 双边（拖动时 2px）（`:272-319`）；`.hoverLine` z4，2px business-primary（`:283-296`）；`.selection` z1 = `color-mix(business-primary 12%, transparent)`（拖动 18%）+ 两侧 `±100vw` 的 58% `bg-layer-1` 遮罩（`:253-270, :321-326`）；`.lanes` z2；root z1；`.ledger` z0 + `isolation:isolate`，保证时间线永远不盖到表上。

缩放/平移：域宽由 `--trajectory-domain-left/width` 驱动（`TrajectoryTimeline.tsx:340-346`），`prefers-reduced-motion: no-preference` 下 `left 180ms ease-out`（`:137-142`）；滚轮缩放因子 `Math.exp(deltaY * 0.0015)`，sequence 模式最小 4 次操作、其他模式 20 次（`:19-24, :366-372`）；右键拖动平移（`:432-447`）；位移 < `MINIMUM_DRAG_PX = 3` 视为点击；`Escape` 与双击清空选择（`:571-575, :603-606`）。空态文案 `timeline.noTimingData` = `无计时数据` / `No timing data`（`:394`）。aria：根 `轨迹时间线` / `Trajectory timeline`，track `时间线概览；水平拖动可聚焦事件` / `Timeline overview; drag horizontally to focus events`。tooltip = kind 标签 + `Total {duration}` / `Started {time}` / `TTFT {ttft} · Decoding {decoding}`（`:106-131`）。

`trajectoryTimelineFocusIndexes`（`timeline.ts:194-205`）：返回 `span.start <= range.end && span.end >= range.start` 的下标。sequence 模式给每条可见记录一个单位槽，轮次开始时插一条边界（`:86-118`）；计时模式在 `compressIdle` 时扣掉空闲间隙，`!actualDuration` 时把每个 span 收成 0 宽（`:147-168`）。

### 4.8 搜索（`trajectory-search-index.ts`）

索引源（`:39-73`）：轮次（`turn N` / `between turns`）、分组标题、kind、message 加 `'assistant'`、`text`、`previewMarkdown`、input/output/thinking/schema 细节、`result`、`resultPreviewMarkdown`、`callId`，以及每个 source/output 块的 type/content/callId/toolName/附件名，外加 `messageSource`/`promptDetail`/`previousPromptDetail` 的 JSON；再补 `trajectoryPreviewText(previewMarkdown)` 与 `trajectoryPreviewText(resultPreviewMarkdown)`，用 `\n` 连接并 `toLocaleLowerCase()`（`:99-106`）。只有 `sources` 数组真变了才重建（`:22-24, :96-98`）。

```ts
// trajectory-search-index.ts:124-132
search(query: string): ReadonlySet<string> | null {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return null
  const matches = new Set<string>()
  for (const [id, entry] of this.entries) {
    if (terms.every(term => entry.text.includes(term))) matches.add(id)
  }
  return matches
}
```

**匹配语义：空白切词的 AND、大小写不敏感的子串包含；不做模糊、不排序、不给字符偏移。**

> ⚠️ **没有高亮类也没有 `<mark>`**（全包 grep `highlight|<mark` 零命中）。真实效果只有两个：
> 1. **账本过滤**：命中集替换折叠投影 —— `if (searchMatchIndexes !== null) return filterRecords(allRecords, searchMatchIndexes)`（`TrajectoryTable.tsx:2152-2153`），`filterRecords` 丢掉不匹配行并重算 `groupStart/turnStart/turnEnd`（`:514-537`）。
> 2. **时间线变暗**：未命中 span 得 `data-search-match='false'` → `opacity: 0.14`。
> 索引首次布局立即构建，之后按 `SEARCH_INDEX_THROTTLE_MS = 3000` 节流（`TrajectoryView.tsx:34, :359-374`）。

### 4.9 分组 / 轮次 / 折叠

**注意**：`TrajectoryTurn.tsx`、`TrajectoryTurnHeader.tsx`、`TrajectoryCell.tsx`、`TrajectoryGroupHeader.tsx` 都是**历史遗留/仅测试引用**（全包无生产 import；`TrajectoryCell.tsx:1` 自述 "Legacy standalone trajectory cell retained for direct consumers and specs"）。线上账本是 `TrajectoryTable` 自己的 `<table>` + `span.turnLabel`。下面是它们的规格（若 Piggy 想要更简单的轮次卡片视图，这套反而更好抄）：

- `TrajectoryTurn.tsx:22-29`：`<section className={css.root} data-turn={turn}><TrajectoryTurnHeader …/><div className={css.body}>{children}</div></section>`；`.body{display:flex; flex-direction:column; gap:10px; max-width:880px; margin:0 auto; padding:8px 16px 22px}`。
- `TrajectoryTurnHeader.tsx:6-8`：列 `['column.input','column.output','column.think','column.time']` → 输入/输出/思考/时间（英文 Input/Output/Think/Time）；标题 `t('turn.label',{turn})` = `第 {turn} 轮` / `Turn {turn}`。`.root{position:sticky; top:0; z-index:1; height:44px; background:var(--dsw-alias-button-ghost-active-fill)}`（暗色 `rgb(67,69,74)`）；`.columns{width:320px; gap:12px}`、`.column{width:71px; font:var(--dsw-font-xs-13); color:var(--dsw-alias-label-secondary)}`（4×71 + 3×12 = 320）。
- `layout.ts:26-36`：`TrajectoryGroupModel{title, description?, cells}` / `TrajectoryTurnModel{turn: number|null, groups}`。分组标题 `t('group.message')` / `t('group.step',{step})` / `t('group.compaction',{seq})` → 消息 / 第 {step} 步 / 压缩 {seq}（`:196, :201, :212, :366`）。分组描述 = 墙钟跨度 + 工具直方图，如 `1.5 s bash×6`（`:629-659`）。轮次只以 `data-turn-start` 行 + 轨道呈现，`sectionLabel(turn)` = `第 N 轮` 或 `轮次之间`（`TrajectoryTable.tsx:564-566`）。
- 折叠（`TrajectoryTable.tsx:601-655, :673-724`）：收轮次时保留第一个非 system/non-requestOnly 记录，追加合成 `collapsedSummary` 行（`collapsedSummaryKind:'turn'`），摘要 = `summarizeTurn` → `N 个步骤 · M 个工具调用`；助手折叠保留消息行、把其后的 tool/subtool 串换成 `"{count} tool calls · name, name"`。折叠行高 **20px**，带 `data-collapsed-summary='turn'|'assistant'`。交互：单击切换折叠行，双击折叠/展开轮次或助手的工具串（`:2731-2763`），`Enter`/`Space` 选中（`:2764-2775`）。
- **Token 数在详情面板，不在行里**：`TokenRows` 输出 `输出 Token / 推理 / 内容`，`UsageRows` 加 `输入/缓存读取/缓存写入/其他/输出`，分组标题 `本次请求` / `会话累计`（`TrajectoryTable.tsx:751-855`）。
- `trajectory-preview.ts:5-20`：`PREVIEW_SOURCE_CHARACTERS = 2048`、`PREVIEW_OUTPUT_CHARACTERS = 512`；`extractMarkdownPlainText(text.slice(0,2048)).replace(/\s+/g,' ').trim()` 再 `slice(0,512).trimEnd()`，任一截断则补 `…`。
- `TrajectoryGroupHeader`：`.root{height:36px; padding:0 20px; gap:24px}`、`.title{font:var(--dsw-font-xs-13); color:label-primary}`、`.description{font:var(--dsw-font-xs-13); color:label-tertiary}`。

### 4.10 轨迹用到的令牌（暗色）

| 令牌 | 暗色 | 用途 |
|---|---|---|
| `--dsw-alias-bg-layer-1` | `rgb(35,35,36)` | 视图底 / 详情面板底 |
| `--dsw-alias-bg-layer-2` | `rgb(44,44,46)` | 时间线 plot 底 / 搜索框底 |
| `--dsw-alias-bg-layer-3` | `rgb(53,54,56)` | |
| `--dsw-alias-bg-module-platform` | `rgb(53,54,56)` | 系统/已压缩芯片底 |
| `--dsw-specific-sidebar-fill` | `rgb(27,27,28)` | （旧表头 th） |
| `--dsw-alias-border-l1` | `rgba(255,255,255,0.06)` | 行下边线 |
| `--dsw-alias-border-l2` | `rgba(255,255,255,0.12)` | 工具栏/时间线/详情左边界 |
| `--dsw-alias-border-l4` | `rgba(255,255,255,0.2)` | 搜索框边 |
| `--dsw-alias-label-primary/secondary/tertiary/caption/dimmed` | `rgb(249,250,251)` / `rgb(207,211,214)` / `rgb(173,178,184)` / `rgb(129,133,140)` / `rgb(67,69,74)` | 文字四级 |
| `--dsw-alias-interactive-bg-hover` / `-active` | `rgba(255,255,255,0.08)` / `rgba(255,255,255,0.14)` | |
| `--dsw-alias-brand-primary-new-colorprimary-new-color` | `rgb(86,134,254)` | 选择轨 / 助手混色基 |
| `--dsw-alias-state-business-primary` | `rgb(122,170,255)` | 用户芯片 / 用户轨 / 焦点环 |
| `--dsw-alias-state-business-tertiary` | `rgb(52,65,91)` | 用户芯片底 |
| `--dsw-alias-state-success-primary` / `-tertiary` | `rgb(34,197,94)` / `rgb(35,60,44)` | 上下文 |
| `--dsw-alias-state-error-primary` / `-secondary` | `rgb(242,90,90)` / `rgb(242,90,90)` | 错误 |
| `--dsw-alias-state-warn-label` / `-tertiary` | `rgb(221,134,41)` / `rgb(39,36,31)` | 工具 |
| `--dsw-alias-button-ghost-active-fill` | `rgb(67,69,74)` | 旧轮次表头底 |
| `--dsw-static-blue-500` | `rgb(59,130,246)` | 轮次轨强调色基（22% 混 `bg-layer-1` ≈ `rgb(40,56,82)`） |
| `--dsw-font-xxs-12` / `-xs-13` / `-xs-strong-13` / `-xxxs-11` | `12px/18px` / `13px/20px` / `500 13px/20px` / `11px/14px` | 字号阶梯 |

---

## 5. 侧栏（Sidebar）

包：`#12-packages/client/ui-sidebar/`（外壳）+ `#12-packages/client/ui-workspace/`（会话行）+ `#12-packages/client/ui-brand-official/`（品牌）。

### 5.1 归属与槽位

- 外壳声明 `sidebar` 槽（`#12-packages/client/ui-layout/src/client/index.ts:61`，owner props `{ collapsed: boolean; width: number }`），在 `AppFrame.tsx:260-263` 渲染：`renderSlot('sidebar', { collapsed: sidebarCollapsed, width: cols.sidebar })`。
- 列皮肤：`.sidebarCol { background: var(--dsw-specific-sidebar-fill); border-right: 0.5px solid var(--dsw-alias-border-l3) }`（`AppFrame.module.css:63-68`）。
  > 注：`SidebarRoot.module.css:1-7` 的注释说"1px 右边框"是**过时描述**，实际画的是 0.5px。
- `SidebarRoot` 声明 7 个子槽（`#12-packages/client/ui-sidebar/src/client/index.ts:72-85`）：

| 槽位 | 基数 | owner props |
|---|---|---|
| `sidebar.brand.mark` | single | `{ size: number }` |
| `sidebar.brand.name` | single | `{ children?: never }` |
| `sidebar.toggle.badge` | single | `{}` |
| `sidebar.panellist` | **list** | `{ size: number; active: boolean }` |
| `sidebar.workspaces` | single | `{ wide: boolean; expandSidebar: () => void }` |
| `sidebar.settings` | single | `{ wide: boolean }` |
| `sidebar.footer.action` | **list** | `{ wide: boolean }` |

占用方：`sidebar.workspaces` ← ui-workspace；`sidebar.settings` ← ui-settings-general（`SettingsRoot`）；`sidebar.panellist` ← ui-plugin-manager（`order: 0`）；`sidebar.toggle.badge` ← `DesktopUpdateBadge`；`sidebar.brand.mark|name` ← ui-brand-official（仅 `DSH_CLIENT_BUILD_PROFILE === 'official'`）；`shell.leading` ← ui-sidebar 的 `HeaderLeadingControls`。

每个槽占用者被渲染器包成 `<div data-slot="sidebar.workspaces" style="display: contents;">`（真实 DOM，见快照 `#12-packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap:1-80`）。

### 5.2 列外壳 `SidebarRoot.tsx`（306 行）+ `SidebarRoot.module.css`（589 行）

```
div.root[.collapsed][.railIn][.fading][.quietBars]              SidebarRoot.tsx:196-208
├─ div.topStrip              ← 仅 darwin 桌面（红绿灯行）        :211
│  └─ Tooltip > button.iconButton.toggle                        :175-192
├─ div.logoRow                                                  :212-251
│  ├─ (wide) button.brand.wide  [darwin: span.brand]            :238-248
│  │  └─ span.brandIdentity > span.brandMark + span.brandName
│  │        └─ span.fallbackBrandName | span.localBuildBrand
│  │              > span.localBuildTitle + span.buildVersion
│  └─ (!darwin) Tooltip > button.iconButton.toggle              :250
├─ Tooltip > button.newSession                                  :254-268
│  └─ svg(14 Medium / 18 Regular / 16 windows) + span.newSessionLabel.wide
├─ (panels.length > 0) nav.panelList[aria-label=t('panels.label')]  :270-284
│  └─ Tooltip > button.panelRow[.panelActive]                   :59-81
│     ├─ span.panelGlyph > renderSlot('sidebar.panellist',{size:wide?16:18, active})
│     └─ (wide) span.panelTitle.wide
├─ div.regionArea > renderSlot('sidebar.workspaces',{wide, expandSidebar})  :288-293
└─ div.footArea                                                 :296-303
   ├─ div.footerActions > renderSlot('sidebar.footer.action',{wide})
   └─ div.settingsArea  > renderSlot('sidebar.settings',{wide})
```

三个状态类：`.quietBars`（指针离开 `SCROLLBAR_LINGER_MS = 2000` 后隐藏滚动条）、`.fading`（折叠但宽内容仍挂载 `COLLAPSE_SETTLE_MS = 150`）、`.railIn`（仅"正在折叠"时播放入场动画）。

关键 CSS：

```css
.root { --dsh-sidebar-inline-padding: 12px;
        display:flex; flex-direction:column; height:100%;
        padding: 6px var(--dsh-sidebar-inline-padding); box-sizing:border-box;
        background: var(--dsw-specific-sidebar-fill);     /* 暗色 rgb(27,27,28) */
        color: var(--dsw-alias-label-primary); font-size:14px;
        --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
        --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2); }   /* :9-23 */
:global([data-platform='darwin']) .root { background: transparent }          /* :27-29 */
.root.collapsed { padding: 18px 10px 6px; }                                  /* :34-36 */
.root.quietBars { --dsh-scrollbar-thumb: transparent;
                  --dsh-scrollbar-thumb-hover: transparent; }                /* :129-132 */
.fading > * { opacity:0; transition: opacity 150ms var(--ds-ease-in-out) }   /* :136-139 */
.wide { animation: wide-in 200ms var(--ds-ease-in-out) }                     /* :142-148 */
.railIn .iconButton, .railIn .newSession, .railIn .panelList, .railIn .regionArea {
  animation: rail-in 150ms var(--ds-ease-in-out) backwards; }                /* :155-161 */
@keyframes rail-in { from { opacity:0; transform: translateX(49px) } }       /* :168-171 */

.topStrip { flex:none; display:flex; align-items:center; justify-content:flex-end;
            height:52px; box-sizing:border-box;
            margin: -6px calc(-1 * var(--dsh-sidebar-inline-padding)) 0;
            padding: 0 12px 2px; }                                           /* :181-193 */
.topStrip + .logoRow { margin-top: -12px }                                   /* :204-206 */
.logoRow  { flex:none; display:flex; align-items:center; justify-content:flex-end;
            gap:8px; height:60px; padding: 8px 0 8px 4px; margin-bottom:4px;
            box-sizing:border-box; overflow:hidden; }                        /* :211-222 */
.collapsed .logoRow { height:36px; padding:0; margin-bottom:12px; justify-content:flex-start; } /* :224-229 */
.brandIdentity  { display:inline-flex; align-items:center; gap:8px; height:24px; min-width:0 }   /* :266-272 */
.brandName      { gap:6px; height:24px; font-size:18px; font-weight:600;
                  line-height:24px; letter-spacing:0.04em }                  /* :281-291 */
.localBuildTitle{ font-size:12px; line-height:13px; letter-spacing:0 }       /* :310-314 */
.buildVersion   { height:10px; padding:0 3px; border-radius:2px;
                  color: var(--dsw-alias-label-primary-inverted);
                  background: var(--dsw-alias-label-primary);
                  font-family: var(--ds-font-family-code);
                  font-size:6px; font-weight:500; line-height:10px; white-space:nowrap } /* :371-385 */
.regionArea { flex:1; min-height:0; display:flex; flex-direction:column;
              margin-left:-4px; margin-right: calc(-1 * var(--dsh-sidebar-inline-padding));
              padding-left:4px; overflow:hidden; }                           /* :531-541 */
.footArea   { flex:none; display:flex; flex-direction:column }               /* :550-554 */
.settingsArea, .footerActions { flex:none; min-width:0; width:100% }         /* :556-561 */
.collapsed .footArea { align-items:center }
.collapsed .settingsArea, .collapsed .footerActions { display:flex; justify-content:center; width:auto } /* :567-576 */
```

Windows 标题栏变体（`:38-119`）：`.logoRow { height:40px; margin:0; padding:0 }`，折叠开关 `position:fixed; top: calc((var(--dsh-windows-titlebar-height) - 28px)/2); left:12px; z-index:30`，折叠时隐藏 `panelList/regionArea/footArea`，"新会话"固定在 `left:48px`。
`prefers-reduced-motion` 下全部动画关闭（`:578-589`）。

### 5.3 品牌行 + 新建会话按钮 + 折叠开关

- 品牌：`ui-brand-official` 只提供内容 —— `OfficialBrandMark({size}) => <FishLogo size={size}/>`、`OfficialBrandName() => <BrandWordmark includeMark={false}/>`（`Brand.tsx:9-11, :17-19`），几何由外壳的 `.brandMark`（24px 盒）与 `.brandName`（18px/600，字距 0.04em）决定。兜底：`<FishLogo size={24}/>` + `t('brand.localBuild')`（=`DSH 本地构建` / `DSH Local Build`，定义在 **common 命名空间** `#12-packages/client/locale/src/locales/zh.ts:34`），有 `DSH_CLIENT_VERSION` 时改渲染 `.localBuildBrand`（标题 + `.buildVersion` 小胶囊）。
- 折叠开关：`Tooltip(label = collapsed ? t('toggle.open') : t('toggle.collapse'), delayMs=500, side = darwin?'bottom':'right')` > `button.iconButton.toggle`；折叠态左侧换成 `span.railMark`（`renderSlot('sidebar.brand.mark',{size:24}, fallback <FishLogo size={24}/>)`），hover 时 logo 换回面板图标（`:344-363`）。
- 新建会话：`button.newSession`，宽态用 `IconNewChatOutlineMedium size={14}` + `span.newSessionLabel.wide` = `t('session.new')`；折叠态用 `IconNewChatOutlineRegular size={windowsTitlebar?16:18}`，无文字。

```css
.iconButton { width:28px; height:28px; border-radius:50%; corner-shape:round;
              padding:0; border:none; background:transparent;
              color: var(--dsw-alias-label-secondary); }                     /* :316-331 */
.iconButton:hover { background: var(--dsw-alias-interactive-bg-hover) }      /* :333-335 */
.collapsed .iconButton { width:36px; height:36px; border-radius:12px;
                         color: var(--dsw-alias-label-primary) }             /* :337-342, :365-369 */
.newSession { display:flex; align-items:center; justify-content:center; gap:6px;
              height:38px; padding:8px 16px; margin: 0 2px 12px; box-sizing:border-box;
              border: 0.5px solid var(--dsw-alias-border-l3); border-radius:12px;
              background: var(--dsw-alias-button-elevated-fill);   /* 暗色 rgb(67,69,74) */
              color: var(--dsw-alias-label-primary);
              font-size:14px; font-weight:500; line-height:22px; cursor:pointer;
              overflow:hidden; }                                             /* :389-408 */
.newSession:hover { background: var(--dsw-alias-button-floating-hover) }     /* :410-412 */
.collapsed .newSession { align-self:flex-start; width:36px; height:36px; padding:0;
                         margin:0 0 12px; gap:0; border-color:transparent; background:transparent } /* :433-446 */
.newSessionLabel { max-width:200px; overflow:hidden; white-space:nowrap }
.collapsed .newSessionLabel { max-width:0 }                                  /* :448-456 */
.panelList { flex:none; display:flex; flex-direction:column; gap:4px; margin-bottom:8px }  /* :458-464 */
.panelRow  { display:flex; align-items:center; gap:8px; margin:0 2px; min-height:36px;
             padding:7px 8px; border:none; border-radius:12px; background:transparent;
             color: var(--dsw-alias-label-primary); line-height:22px;
             text-align:left; cursor:pointer }                               /* :468-484 */
.panelRow:hover, .panelRow.panelActive { background: var(--dsw-alias-interactive-bg-hover) } /* :486-493 */
.panelRow:focus-visible { outline: 2px solid var(--dsw-alias-label-primary); outline-offset:-2px }
```

**列外变体**：`HeaderLeadingControls.tsx`（51 行）是 `shell.leading` 占用者，仅在 `darwin && sidebarCollapsed` 时挂载（`AppFrame.tsx:274, :314-318`）到 `.leadingSeat`（绝对定位 `top:11px; left:88px; z-index:15`）。它渲染两个 28×28 圆形按钮：`IconPanelLeftOutlineRegular size={16}`（打开侧栏）+ `IconNewChatOutlineRegular size={16}`（新建会话），`gap:8px`。

### 5.4 会话列表：`WorkspaceBrowser.tsx` + `Rows.tsx`

```
div.root[.rail]                                        WorkspaceBrowser.tsx:1143
├─ div.sectionHeader                                   :1144-1255
│  ├─ (wide) span.sectionLabel.wide  = groupBy==='flat' ? t('section.sessions') : t('section.workspaces')
│  ├─ (wide) div.searchSlot > div.search
│  │  ├─ button.searchButton > IconSearchOutlineRegular size={expanded?11:14}
│  │  ├─ input.searchInput[placeholder=t('search.placeholder')][maxLength=500]
│  │  └─ (expanded) button.clearButton > IconCloseFillRegular
│  ├─ div.headerActions
│  │  ├─ (wide) Menu(视图选项, align="end", dense, portal) > button.iconButton > IconSlidersTwoOutlineRegular
│  │  └─ (directoryFlowAvailable) button.iconButton > IconProjectAddOutlineRegular size={wide?16:18}
│  └─ WorkspacePickFlow (anchor = ＋, side="right")
├─ (!wide) div.search > button.searchButton > IconSearchOutlineRegular size={18}
├─ div.listArea → SearchResults | FlatList | SessionTree
└─ Modal rename / Modal delete
```

`SessionTree` = `div.treeBody.wide > AnimatedRows.className="list"[role=tree] + span.fade`（`:580-595`）；分组 = `div.groupSection`（内联 `--dsh-workspace-indent: depth*12px`）→ `ProjectRowItem` → 子分组 `div[role=group]` → 会话行 → 溢出按钮。

```css
.root { --dsh-session-list-edge-inset: var(--dsh-sidebar-inline-padding);
        --dsh-session-list-scrollbar-width: 5px;
        --dsh-session-list-scrollbar-offset: 2px;
        flex:1; min-height:0; display:flex; flex-direction:column; box-sizing:border-box;
        padding-right: var(--dsh-session-list-edge-inset); }                 /* WorkspaceBrowser.module.css:1-11 */
.sectionHeader { height:36px; padding-left:4px; margin-bottom:4px; gap:4px;
        border-radius:12px; overflow:hidden; color: var(--dsw-alias-label-tertiary) } /* :45-58 */
.search { height:28px; border-radius:50%; corner-shape:round; background:transparent;
          cursor:text; color: var(--dsw-alias-label-secondary) }             /* :137-170 */
.search.searchExpanded { width: calc(100% + 4px); height:30px; margin-inline:-2px;
          padding: 0 4px 0 0; border: 0.5px solid var(--dsw-alias-border-l4);
          border-radius:10px; color: var(--dsw-alias-label-caption) }
.searchInput { font-size:13px; line-height:18px; color: var(--dsw-alias-label-primary); opacity:0 } /* :201-224 */
.list { flex:1; min-height:0; overflow-y:auto;
        margin-left:-4px; margin-right: var(--dsh-session-list-scrollbar-offset);
        padding-left:4px;
        padding-right: calc(var(--dsh-session-list-edge-inset)
                          - var(--dsh-session-list-scrollbar-width)
                          - var(--dsh-session-list-scrollbar-offset));
        padding-bottom:16px; scrollbar-gutter: stable; }                      /* :349-369 ★ 唯一滚动区 */
.flatList > * + *, .searchTree > [role='treeitem'] + [role='treeitem'],
.groupSection > * + * { margin-top: 2px }                                     /* :371-375 */
.groupSection + .groupSection { margin-top: 4px }                             /* :442-444 */
.fade { position:absolute; left:0; right: var(--dsh-session-list-edge-inset); bottom:0;
        height:24px; background: linear-gradient(to bottom, transparent, var(--dsw-specific-sidebar-fill));
        pointer-events:none }                                                 /* :322-338（darwin 下 display:none） */
```

**会话行 / 工作区分组行**：

```
ProjectRowItem                                          Rows.tsx:204-312
└ div.projectRow[.menuOpen][role=treeitem][aria-expanded][draggable]
   data-row-key="workspace:<key>"                       :226-242
  ├─ span.slot.folder[.folderActive] > IconFolderOpen/CloseRegular   :243-245
  ├─ span.slot.chevron > IconTriangleRightFillRegular.arrow[.arrowOpen]  :246-248
  ├─ span.projectText > span.title                    :249-251
  └─ span.rowActions                                  :252-291
     ├─ Menu(portal) > button.iconButton > IconEllipsisOutlineRegular
     └─ Tooltip > button.iconButton > IconNewChatOutlineRegular

SessionNodeItem                                         Rows.tsx:529-687
└ div.sessionRow[.selected][.menuOpen][.archived][.flatSessionRowWithoutStatus][.dropBefore|.dropAfter]
   [role=treeitem][aria-selected][draggable]  data-row-key="session:<id>"   :568-608
  ├─ (!flat || showStatus) span.slot > StateDot + span.visuallyHidden       :614-618
  ├─ span.title（双击改名；hover 走 marquee）                                :619-627
  ├─ (hasActiveSchedule) span.scheduleIndicator > IconAlarmClockOutlineRegular  :628
  ├─ (!blank) span.time = primaryStatus.trailingLabel ?? timeLabel(updatedAt, now, t)  :633-640
  ├─ (pinned && !archived) span.pinIndicator > IconPinFillRegular size={14}  :643
  └─ (!blank) span.rowActions                                              :647-673
     ├─ Menu(portal) > button.iconButton > IconEllipsisOutlineRegular
     ├─ renderSlot('sidebar.workspaces.session.menu.item', …)
     └─ renderSlot('sidebar.workspaces.session.row.action', …)
```

```css
/* Rows.module.css —— 共享底座 :1-17 */
.projectRow, .sessionRow {
  display:flex; align-items:center; gap:6px; border-radius:8px;
  padding: 0 8px; padding-inline-start: calc(8px + var(--dsh-workspace-indent, 0px));
  cursor:pointer; user-select:none; color: var(--dsw-alias-label-primary); }
.projectRow:hover, .sessionRow:hover { background: var(--dsw-alias-interactive-bg-hover) }
/* 高度 */
.projectRow { height: 34px }                       /* :94-98 */
.sessionRow { height: 32px; gap: 0 }               /* :105-108 */
.sessionRow .title { margin: 0 6px 0 4px }         /* :110-116 */
.flatSessionRowWithoutStatus .title { margin-left: 0 }
/* ★ 选中态 = 与 hover 同一个填充，没有强调条 */
.sessionRow.selected { background: var(--dsw-alias-interactive-bg-hover) }    /* :19-21 */
/* 槽位与文字 */
.slot  { flex:none; width:16px; height:20px; display:inline-flex;
         align-items:center; justify-content:center;
         color: var(--dsw-alias-label-tertiary) }  /* :118-126 */
.folderActive { color: var(--dsw-alias-state-business-primary) }              /* :137-139 */
.title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
         font-size:14px; line-height:20px }        /* :164-171 */  .sessionRow .title { flex:1 }  /* :190-192 */
.time  { flex:none; font-size:10px; line-height:16px;
         color: var(--dsw-alias-label-caption) }   /* :221-226 */
.pinIndicator { width:16px; height:20px; margin-left:6px; color: var(--dsw-alias-label-caption) }   /* :244-253 */
.scheduleIndicator { width:16px; height:20px; margin-right:6px; color: var(--dsw-alias-label-tertiary) } /* :228-237 */
/* 行内动作：默认隐藏，hover / 菜单打开时出现（display，不是 opacity） */
.rowActions { flex:none; display:none; align-items:center; gap:10px }          /* :271-… */
.sessionRow:hover .rowActions, .sessionRow.menuOpen .rowActions,
.projectRow:hover .rowActions, .projectRow.menuOpen .rowActions { display:inline-flex }
.sessionRow:hover .time, .sessionRow.menuOpen .time { display:none }
.sessionRow:hover .pinIndicator, .sessionRow.menuOpen .pinIndicator { display:none }
.iconButton { width:16px; height:16px; border-radius:4px; border:none;
              background:transparent; color: var(--dsw-alias-label-tertiary) }  /* :409-426 */
.iconButton:hover { color: var(--dsw-alias-label-primary) }
/* 归档 */
.sessionRow.archived .title, .sessionRow.archived .time { color: var(--dsw-alias-label-caption) }  /* :255-265 */
/* 标题 marquee 遮罩 */
.sessionRow .title[data-scrolled] { mask-image: linear-gradient(to right, transparent, #000 12px) }
.sessionRow .title[data-clipped]  { mask-image: linear-gradient(to left, transparent, #000 12px) } /* :194-210 */
/* 拖拽插入标记：12px 高规则 + 两个 5×7 箭头渐变，business-primary，left:0; right:4px */
```

> ⚠️ **两处需要纠正的常见误解**：
> 1. **选中高亮没有左侧强调条**，就是 `--dsw-alias-interactive-bg-hover`（暗色 `rgba(255,255,255,0.08)`）的 8px 圆角填充，与 hover 同色；
> 2. `--dsw-specific-sidebar-nav-item-active` / `-active-accent` 这两个令牌**在侧栏里没被用到**（只被 settings 弹窗的导航项 `SettingsRoot.module.css:105-161` 用），别把它们当成会话行选中色。

**相对时间戳**（`#12-packages/client/ui-primitives/src/relative-time.ts:25-36`）：分桶 `now`(<60s) / `minutes`(<1h) / `hours`(<1d) / `days`(<30d) / `months`(<365d) / `years`；`n = Math.floor(diff/unit)`。
渲染（`Rows.tsx:121-131`）：`timeLabel = unit === 'now' ? t('time.now') : t(\`time.${unit}\`, { n })`；hover 卡片用 `t('time.ago', { t })`。中文 `刚刚 / 5分钟 / 3小时 / 2天 / 4个月 / 1年`，hover `5分钟前`；英文 `now / 5min / 3h / 2d / 4mo / 1y`，hover `5min ago`（`ui-workspace/src/client/locales.ts:107-113` / `:219-225`）。空白会话不渲染时间格；等待交互的行用 `status.compact.*` 替换（`Rows.tsx:345-371, :636-639`）。

**行动画**（`AnimatedRows.tsx`）：`ROW_FADE_MS = 100`、`ROW_GLIDE_MS = 200`；`getSnapshotBeforeUpdate` 量 `[data-row-key]` 的 rect 并把被删除的行克隆进一个惰性覆盖层，`componentDidUpdate` 做 FLIP 位移与透明度淡入淡出；只有第一次指针/键盘输入之后才启用动画，`prefers-reduced-motion` 下跳过。覆盖层 `.exits { position:absolute; inset:0; contain:strict; overflow:clip; pointer-events:none }`。

### 5.5 "展开其余 N 个" 折叠（精确规格）

- 阈值：`const COLLAPSED_SESSION_LIMIT = 5`（`WorkspaceBrowser.tsx:53-54`）。
- 配额规则 `collapsedSessionRows`（`:56-69`）：`blank || running || runningSubagentCount > 0` 的行**永远保留且不占**普通配额；返回 `{ rows, hiddenCount: sessions.length - rows.length }`。
- 控件（`:552-573`）仅在 `collapsed.hiddenCount > 0` 时渲染：
  `button.sessionOverflowButton[data-row-key="overflow:<key>"][aria-expanded]`，文案 `sessionsExpanded ? t('sessions.collapse') : t('sessions.expand', { n })`。
- 行为：隐藏数 ≤ 5 时一次全展开（`Infinity`），否则每次 +5；收起重置回 5。折叠工作区分组时把该组上限重置为 5。搜索命中隐藏目标时强制展开（`Infinity`）。

```tsx
// WorkspaceBrowser.tsx:56-69
function collapsedSessionRows(sessions: readonly SessionNode[], limit = COLLAPSED_SESSION_LIMIT): {
  rows: readonly SessionNode[]; hiddenCount: number
} {
  let idleCount = 0
  const rows = sessions.filter((session) => {
    if (session.blank || session.running || session.runningSubagentCount > 0) return true
    if (idleCount >= limit) return false
    idleCount += 1
    return true
  })
  return { rows, hiddenCount: sessions.length - rows.length }
}
```

```tsx
// WorkspaceBrowser.tsx:552-573
{collapsed.hiddenCount > 0 && (
  <button type="button" className={css.sessionOverflowButton}
    data-row-key={`overflow:${group.key}`} aria-expanded={sessionsExpanded}
    onClick={() => {
      setSessionLimits(limits => ({
        ...limits,
        [group.key]: sessionsExpanded
          ? COLLAPSED_SESSION_LIMIT
          : visible.hiddenCount <= COLLAPSED_SESSION_LIMIT
            ? Infinity
            : (limits[group.key] ?? COLLAPSED_SESSION_LIMIT) + COLLAPSED_SESSION_LIMIT,
      }))
    }}>
    {sessionsExpanded ? t('sessions.collapse') : t('sessions.expand', { n: visible.hiddenCount })}
  </button>
)}
```

```css
/* WorkspaceBrowser.module.css:494-514 */
.sessionOverflowButton {
  width: 100%; height: 28px; border: none; border-radius: 8px;
  padding: 0 12px 0 calc(28px + var(--dsh-workspace-indent, 0px));
  background: transparent; cursor: pointer; text-align: left;
  font-size: 12px; color: var(--dsw-alias-label-tertiary);
}
.groupSection > .sessionOverflowButton { margin-top: 0 }
.sessionOverflowButton:hover { background: transparent; color: var(--dsw-alias-label-secondary) }
```

**文案**：`sessions.expand` = `展开其余 {n} 个会话` / `Show {n} more sessions`；`sessions.collapse` = `收起` / `Show less`（`ui-workspace/src/client/locales.ts:26-27` / `:138-139`）。实际渲染如 `展开其余 2 个会话` / `收起`。

### 5.6 底部设置入口

- 贡献方：`ui-settings-general` 把 `SettingsRoot` 注册进 `sidebar.settings`（`#12-packages/client/ui-settings-general/src/client/index.ts:171-181`）。
- 外壳座位：`div.settingsArea > renderSlot('sidebar.settings', { wide })`，footer actions 叠在它上面。

```
div.triggerRow[.railRow]                              SettingsRoot.tsx:223
├─ renderSlot('settings.launcher', {wide, openSettings, openOnboarding}, fallback→)
│  └─ button.trigger[.rail][aria-label=t('trigger')][aria-haspopup=dialog][aria-expanded]
│     └─ renderSlot('settings.trigger',{wide}) → IconSettingsOutlineMedium size={wide?16:18}
│                                                 + (wide) span.triggerLabel
├─ ConnectionIndicator（仅宽态）
└─ DesktopUpdateIndicator（宽态，连接指示可见时隐藏）
+ (打开时) div.overlay > div.mask + div.panel[role=dialog][aria-modal] > nav.nav + div.content …
```

```css
/* SettingsRoot.module.css:1-52 */
.triggerRow { position:relative; flex:none; display:flex; align-items:center; gap:8px;
              width: calc(100% + 4px); margin: 4px -2px }
.trigger { flex:1; min-width:0; display:flex; align-items:center; gap:8px; height:42px;
           padding: 0 10px 0 8px; box-sizing:border-box; border:none; border-radius:12px;
           background:transparent; cursor:pointer; overflow:hidden;
           color: var(--dsw-alias-label-primary); font-size:14px; line-height:22px }
.trigger:hover { background: var(--dsw-alias-interactive-bg-hover) }
.triggerRow.railRow { width:36px; margin: 8px 0 10px }
.trigger.rail { flex:none; width:36px; height:36px; margin:0; justify-content:center; gap:0; padding:0 }
/* 设置弹窗（供参考） */
.overlay { position:fixed; inset:0; z-index:1000 }                            /* :59-… */
.mask    { background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur) }
.panel   { width:800px; height: min(800px, calc(100vh - 2 * max(24px, var(--dsh-frame-top-clearance, 24px))));
           max-width: calc(100vw - 48px); border-radius:32px;
           background: var(--dsw-alias-bg-layer-2); box-shadow: var(--dsw-elevation-prominent) }
.navCell { height:40px; padding: 9px 16px 9px 12px; border-radius:12px }       /* :105-161 */
```

### 5.7 侧栏文案（中文 / 英文）

`ui-sidebar/src/client/locales.ts`：`session.new` 新会话 / New Session；`session.new.label` 新建会话 / New session；`toggle.open` 打开侧边栏 / Open sidebar；`toggle.collapse` 收起侧边栏 / Collapse sidebar；`panels.label` 全局面板 / Global panels。

`ui-workspace/src/client/locales.ts`（namespace `workspace`）：

| key | 中文 | 英文 |
|---|---|---|
| `section.workspaces` / `section.sessions` | 工作区 / 会话 | Workspaces / Sessions |
| `group.ungrouped` | 未分组 | Ungrouped |
| `sessions.expand` / `sessions.collapse` | 展开其余 {n} 个会话 / 收起 | Show {n} more sessions / Show less |
| `empty.none` | 暂无会话 | No sessions yet |
| `search.placeholder` | 搜索会话名称 | Search session names |
| `workspace.add` | 添加工作区 | Add workspace |
| `viewOptions.label` | 视图选项 | View options |
| `groupBy.label` / `.workspace` / `.workspaceTree` / `.flat` | 分组方式 / 按工作区 / 按工作区树 / 单列表 | Group by / WorkSpace / Workspace Tree / In one list |
| `orderBy.label` / `.manual` / `.updated` | 排序方式 / 手动排序 / 最近更新 | Order by / Manual / Last updated |
| `filterBy.label` / `viewOptions.showArchived` / `.onlyArchived` | 筛选会话 / 显示已归档 / 仅显示已归档 | Filter sessions / Show archived / Archived only |
| `menu.pinSession` / `menu.unpinSession` | 置顶会话 / 取消置顶 | Pin session / Unpin session |
| `menu.archiveSession` / `menu.unarchiveSession` | 归档会话 / 取消归档 | Archive session / Unarchive session |
| `row.pinned` / `row.archived` | 已置顶 / 已归档 | Pinned / Archived |

`ui-settings-general`（namespace `settings`）：`trigger` / `title` = 设置 / Settings，`close` = 关闭 / Close。

### 5.8 侧栏实现要点（Piggy 直接照做）

1. `--dsh-sidebar-inline-padding: 12px` 是**整个侧栏唯一的水平内衬**，其它包裹层靠负 margin + 正 padding 抵消（`.regionArea`、`.list`、设置触发器 `width: calc(100% + 4px)`）。改动它必须同步这几处。
2. `.quietBars` 必须把 `--dsh-scrollbar-thumb` 与 `-hover` **两个**都绑成 `transparent`，且**不要**在这里用 `scrollbar-gutter`（预留由 ui-workspace 的 `.list` 负责）。
3. 折叠滑出期间外壳**不卸载**宽内容：它把宽度内联冻结再淡出，`COLLAPSE_SETTLE_MS = 150` 后才卸载。
4. 会话行圆角 8px，栏内/面板/设置类控件圆角 12px，圆形按钮（`iconButton`）28px 圆形、折叠态 36px / 12px 圆角。

---

## 6. 右侧预览面板（Rightbar）

包：`#12-packages/client/ui-sidebar-right/`（面板外壳 + tab 注册表）、`#12-packages/client/ui-dockkit/`（**页签条由它绘制**）、`#12-packages/client/ui-sidebar-documentpreview/`（文档预览）、`ui-sidebar-terminal` / `ui-sidebar-browser` / `ui-sidebar-files`（其他 tab）、`ui-open-in-app`（"打开方式"）。

### 6.1 元素树（真实类名）

```
div.frame                                        AppFrame.module.css:1
└ div.rightbarCol[data-rightbar-col]             AppFrame.tsx:69 / AppFrame.module.css:277   position:relative; overflow:visible
  └ div.session[data-sidebar-right-session=SID]  RightbarRoot.tsx:22 / SidebarRight.module.css:23   display:contents
    └ div.panel[data-sidebar-right-panel=push|fullscreen][data-sidebar-right-open]  SidebarRight.tsx:294-301
      └ div.panelBody                             SidebarRight.module.css:162
        └ div.surface[data-dockkit-surface][data-dockkit-drop-zones=horizontal]    dockkit.module.css:125
          └ div.tabLayout[data-dockkit-split]     dockkit.module.css:134
            └ div.tabCell[data-dockkit-host=dock][data-dockkit-column=0]           dockkit.module.css:142
              └ section.tabHost.pane[data-dockkit-pane=pane1]                      dockkit.module.css:209
                ├ div.tabHostHeader → div.tabStrip[role=tablist]                   dockkit.module.css:177, 232
                └ div.paneBody → renderTab(active)                                 dockkit.module.css:576
```

### 6.2 面板外壳

**锚定方式：frame 只给"轨道"，面板把自己贴在 frame 右边缘。**

```css
/* AppFrame.module.css:277-281 —— 右列永不裁剪 */
.rightbarCol { position: relative; min-width: 0; overflow: visible; }
/* SidebarRight.module.css:31-42 */
.panel { --dsh-dockkit-dock-layer: 10; --dsh-dockkit-float-layer: 60;
         position: absolute; top: 0; right: 0; bottom: 0;
         display: flex; flex-direction: column; min-width: 0; pointer-events: none; }
```

因为 grid 模板是 `... minmax(0px, ${rightbarMax}px)`（`AppFrame.tsx:283-284`），轨道宽度可以是 **0**，面板仍能从零宽列悬垂到中列之上。

**三种宽度状态**（`SidebarRight.tsx:343-351`）：

```tsx
const shown = active && surface !== undefined && surface.layout.expanded
const autoFullscreen = viewportWidth < 768
const fullscreen = autoFullscreen || surface?.layout.mode === 'fullscreen'
const track = shown && !autoFullscreen
```

- **normal（push）** = `width` px 且保留 grid 轨道；
- **fullscreen** = `100vw`，按注释"shown wide panel retains its track in fullscreen, preserving the conversation width"**仍保留轨道**；
- **auto-fullscreen** = 视口 < 768px 强制全屏**并放弃轨道**（`track = shown && !autoFullscreen`），不改变手动 mode。

面板盒（`SidebarRight.tsx:297-298`）：`style={{ width: fullscreen ? '100vw' : width, '--dsh-sidebar-width': fullscreen ? '100vw' : `${width}px` }}`。

**折叠 = 平移出右边缘，不是卸载**（`SidebarRight.module.css:44-62`）：

```css
.panel :global([data-dockkit-host='dock']),
.panel :global([data-dockkit-empty]),
.panel :global([data-dockkit-divider]) {
  transform: translateX(var(--dsh-sidebar-width));
  visibility: hidden;
  transition: transform var(--ds-transition-duration-slow) var(--ds-ease-in-out),
              visibility 0s linear var(--ds-transition-duration-slow);
}
.panel[data-sidebar-right-open] :global([data-dockkit-host='dock']), … {
  transform: none; visibility: visible;
  transition: transform var(--ds-transition-duration-slow) var(--ds-ease-in-out);
}
```

**z-index 阶梯**（集中一处，便于照抄）：

| 层 | 值 | 来源 |
|---|---|---|
| 停靠面板格 / 空宿主 | `var(--dsh-dockkit-dock-layer, 10)`（面板设 10） | `dockkit.module.css:147`；`SidebarRight.module.css:32` |
| 面板分栏分隔条 | `calc(var(--dsh-dockkit-dock-layer,10) + 1)` | `dockkit.module.css:189` |
| frame 右列拖拽手柄 | `11` | `AppFrame.module.css:241` |
| `shell.leading` 座位 | `15` | `AppFrame.module.css:222` |
| frame 覆盖层 | `20` | `AppFrame.module.css:285` |
| 全屏面板 | `--dsh-dockkit-dock-layer: 40` | `SidebarRight.module.css:77-79` |
| 浮动面板 | `var(--dsh-dockkit-float-layer, 60)`（面板设 60） | `dockkit.module.css:159` |
| 页签右键菜单（portal） | `70` | `dockkit.module.css:541-543` |

**边框与底色由 dockkit 画，不由面板画**：

```css
/* dockkit.module.css:168-175 */
.tabHost:not(.float), .emptyTabHost { background: var(--dsw-alias-bg-base); }   /* 暗色 rgb(21,21,23) */
.tabCell[data-dockkit-host='dock'][data-dockkit-column='0'] > .tabHost {
  border-left: 0.5px solid var(--dsw-alias-border-l4);                          /* 暗色 rgba(255,255,255,0.2) */
}
```

**没有面板标题栏**——`SidebarRight.tsx:15-18` 注释：面板自己的两个控制钮"ride the docking kit's chrome seat at the end of the top-right pane's tab strip, so the strip is the panel's whole top edge"。chrome 座位只渲染给右上角那个 pane（`DockSurface.tsx:288` + `TabPanel.tsx:381-391`），面板贡献 `chrome={<PanelChrome …/>}`（`SidebarRight.tsx:319`）——两个 28px 按钮：全屏/退出全屏（`data-sidebar-right-mode`）与收起（`data-sidebar-right-toggle`），均包 `Tooltip side="bottom" delayMs={500}`。

```css
/* dockkit.module.css:288-298 */
.stripChrome { display:flex; flex:none; gap:8px; align-items:center; height:28px; margin-left:4px; }
/* SidebarRight.module.css:130-160 */
.iconButton { width:28px; height:28px; padding:6px; border-radius:28px; border:none;
              background:transparent; color: var(--dsw-alias-label-secondary); }
.iconButton svg { width:15px; height:15px; }
.iconButton:hover { background: var(--dsw-alias-interactive-bg-hover); }
.collapseGlyph { transform: scaleX(-1); }
```

平台覆盖：Windows 全屏 `max-width: calc(100vw - var(--dsh-windows-sidebar-width))` + 首个 pane `border-radius: var(--dsh-windows-content-radius) 0 0 0`（16px）（`SidebarRight.module.css:93-100`）；macOS 全屏红绿灯下把 `--dsh-dockkit-strip-inline-start` 从 10px 改成 88px（`:106-120`）。

**缩放**：frame 拥有手柄（`AppFrame.tsx:322-324`，`left: viewport - normal.rightbar`），8px 命中带、无可见把手；拖动时 `setRightbar(base - dx)`，夹在 `[300, viewport*0.7]`（`stores.ts:125`）。

**展开**：折叠后要回来，用会话头部角落座位的 `ExpandButton`（`ExpandButton.tsx:30-47`，`data-sidebar-right-expand`，`IconPanelLeftOutlineRegular` + `transform: scaleX(-1)`，样式与 `.iconButton` 同款 28px 圆钮）。

### 6.3 页签条（tab strip）

DOM（`TabPanel.tsx:212-394`）：

```
div.tabStrip[role=tablist][data-dockkit-strip=pane1]
├ div.stripTabs[role=presentation]                        TabPanel.tsx:242
│  ├ div.slot[.slotCaret?][data-dockkit-caret=i?]         （chip 之间 / 末尾的插入位）  :252-257, :339
│  └ div.tab[role=tab][aria-selected][tabIndex=0|-1]      :258-307
│     [data-dockkit-tab=tabN][data-dockkit-tab-quiet?]
│     ├ span.tabTitle[data-dockkit-tab-title][data-dockkit-tab-clipped?]   TabTitle.tsx:36
│     ├ button.tabClose[data-dockkit-tab-close=tabN]                       :310-324
│     └ (打开右键菜单时) TabMenu portal                                     :326-334
├ button.addTab[data-dockkit-add-tab=pane1]               :341-356
├ div.stripFill[data-dockkit-strip-fill]                  :357
├ button.iconButton[data-dockkit-split-button=pane1][data-dockkit-split-blocked]  :358-378
└ div.stripChrome[data-dockkit-strip-chrome]              （仅右上角 pane）  :381-391
```

```css
/* dockkit.module.css:232-241 */
.tabStrip { display:flex; flex:none; gap:4px; align-items:center; height:28px;
            padding: 10px 6px 0 var(--dsh-dockkit-strip-inline-start, 10px);   /* → 38px 头部块 */
            touch-action:none; }
/* :355-372 */
.tab { position:relative; display:flex; flex: 0 1 auto; align-items:center;
       min-width:80px; max-width:170px; height:28px; padding: 0 10px;
       color: var(--dsw-alias-label-secondary);
       font-size: var(--dsh-content-font-size-secondary, 13px); line-height:1;
       white-space:nowrap; border-radius:12px; cursor:pointer;
       touch-action:none; user-select:none; }
/* :411-426 —— 关闭按钮默认透明且不可点（防止触摸误关） */
.tabClose { position:absolute; top:4px; right:4px; display:flex; align-items:center;
            justify-content:center; width:20px; height:20px; padding:0;
            color: var(--dsw-alias-label-tertiary); background:transparent; border:none;
            border-radius:20px; cursor:pointer; opacity:0; pointer-events:none; }
.tab:hover .tabClose, .tab:focus-within .tabClose, .tabActive .tabClose {
  opacity:1; pointer-events:auto; }
/* :464-501 —— 选中 = 填充胶囊；其余是裸文字 */
.tab:hover { background: var(--dsw-alias-interactive-bg-hover); }
.tabActive { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-markdown-tag); }
                                                                /* 暗色 rgb(44,44,46) */
.tab.tabQuiet, .tab.tabQuiet:hover { color: var(--dsw-alias-label-primary);
                                     background: transparent; cursor: default; }
.tabDragging { opacity: 0.5; }
/* :318-349 —— 插入位与拖拽 caret */
.slot { width:10px; height:28px }
.slot::before { width:0.5px; height:14px; background: var(--dsw-alias-border-l4) }
.slotCaret::before { width:2px; height:20px;
                     background: var(--dsw-alias-brand-primary-new-colorprimary-new-color) }
                                                                /* 暗色 rgb(86,134,254) */
/* :393-407 —— 标题裁剪是 mask，不是省略号 */
.tabTitle[data-dockkit-tab-clipped] {
  mask-image: linear-gradient(to right, black calc(100% - 16px), transparent); }
.tab:has(.tabClose) .tabTitle[data-dockkit-tab-clipped] {
  mask-image: linear-gradient(to right, black calc(100% - 30px), transparent calc(100% - 14px)); }
```

**顺序**：每个 pane 的 `tabs` 数组，按到达顺序（`TabPanel.tsx:243`）。没有任何排序；`paint order` 由 tab id 决定（`TabLayout.tsx:142`）。拖动时**不移动 chip**，只在插入位画 caret。窄 pane 下 `.stripTabs` 横向滚动并带 24px 渐隐遮罩（`STRIP_FADE = 24`），而"新增/分栏/chrome"全部 `flex: none`——"a narrow pane costs chips, never controls"（`dockkit.module.css:230-231`）。键盘按 WAI-ARIA tabs 手动激活：←/→ 环绕、Home/End 跳转、Enter/Space 选择。

**页签文案**：`ui-sidebar-right` 只提供字典与 live title；chip 文字 = 类型注册的 live title，否则用开启时捕获的 `title(address)`。各内置类型标题：guide `开始`/`Start`；`text` = 文件名（解码后 basename）；`files` `文件`/`Files`；`terminal` `终端`/`Terminal`；`browser` `浏览器`/`Browser`。live title 组件在 chip 内前置 16px 图标（`GuideTitle` 罗盘 / `TextTitle` FileTypeIcon / `FilesTitle` 文件夹 / `TerminalTitle` 终端图标且双击可改名）。

字典（`ui-sidebar-right/src/client/locales.ts:10-32` 中文 / `:38-60` 英文）：`dock.closeTab` 关闭 / Close；`dock.addTab` 新标签页 / New tab；`dock.splitPane` 分栏 / Split；`dock.splitPaneDisabled` 已达两格上限 / Two panes is the limit；`dock.splitPaneNarrow` 栏宽不足，拖宽侧边栏后再分栏；`dock.emptyPane` 空面板 / Empty pane；`tab.guide.title` 开始 / Start；`tab.unavailable` 这类内容还没有可用的查看方式。；`chrome.toFullscreen` 全屏 / Fullscreen；`chrome.exitFullscreen` 退出全屏；`chrome.collapse` 收起侧边栏 / Collapse sidebar。

### 6.4 每个会话的 tab 状态与持久化

- 每个会话一个 store 实例（`scope: 'session'`），形状 `{ bySession: Record<sessionId, { layout, history, minted }> }`。
- 初始态 = **折叠、一个 pane、无 tab**；默认页不是初始态的一部分，而是在首次展开导致列空时由 `planSettle` 播种（`stores.ts:196-199`）。
- `defaultSeed`（`contract/seed.ts:26-33`）：**恰好只有一个注册的 guide 条目 → 用它的 page；0 个或 ≥2 个 → 用 `guide` 页**（`sidebar://guide`，chip 文字 `开始`）。内置 guide 条目：`files` order **10**、`terminal` order **20**、`browser` order **30** → 默认 profile 有 2~3 个 → **首个标签页是"开始"（guide）**。
- 持久化名字空间：`export const sidebarPersistence = 'dsh.sidebar-right.v1'`（`persistence.ts:7`），每会话 key `` `${sidebarPersistence}.${sessionId}` ``；payload `{ bySession: { [sid]: { layout, minted } } }`，undo 历史不落盘，非法 layout 被清空。
- ⚠️ **面板像素宽度不持久化**：`layoutInfo.rightbar` 只活在 frame 的内存 store 里（默认 `null`，首次打开按 `viewport*0.45` 计算）。持久化的只有 pane 树、浮动位置、`expanded` 与 `mode`。
- 最多 **两个** 停靠 pane；drop zone 只有 `horizontal`；`minPaneFraction = 0.2`；"新增页签"按钮仅在 pane 内没有 guide 时出现。

### 6.5 文档预览（`kind: 'text'`，tab id `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`）

**面包屑行 + 语言条 = 同一行，38px。**

```
div.preview[data-textpreview-state=text][data-document-preview=<rendererId>]        TextPreview.tsx:231-322
├ p.changed[data-textpreview-changed]                                              :239-263
└ div.header                                                                       :264-322
  ├ span.path[data-path-label][title=<完整路径>] → span.text > span.directory + span.name   PathLabel.tsx:33-40
  ├ (Menu → button.tool.viewerTool[data-document-viewer-menu])  仅当候选 >1         :266-283
  ├ button.tool[data-textpreview-tool=wrap][aria-pressed]       仅当该渲染器支持 wrap  :284-299
  ├ slot 'sidebar.right.tab.document.action'                                        :300
  ├ span[hidden] > button.tool[data-textpreview-tool=auto-refresh]                  :301-309
  ├ button.tool[data-textpreview-tool=reload]                                       :310-320
  └ slot 'sidebar.right.tab.document.actions' → 「打开方式」分裂按钮                   :321
div.body[data-textpreview-body][data-textpreview-wrap]                              :323-337
```

```css
/* TextPreview.module.css:20-33, 256-288 */
.header { display:flex; flex: 0 0 auto; gap:4px; align-items:center; box-sizing:border-box;
          height:38px; padding: 0 6px 0 16px;
          border-bottom: 0.5px solid var(--dsw-alias-border-l3); }   /* 暗色 rgba(255,255,255,0.16) */
.path { margin-right: 12px }
.tool { display:inline-flex; flex:none; align-items:center; justify-content:center;
        width:28px; height:28px; padding:6px; color: var(--dsw-alias-label-secondary);
        line-height:1; background:transparent; border:none; border-radius:28px; cursor:pointer }
.tool svg { width:15px; height:15px }
.tool:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-interactive-bg-hover) }
.viewerTool { flex:none; width:auto; max-width:160px; padding: 0 6px; overflow:hidden;
              color: var(--dsw-alias-label-secondary); font-size:12px;
              white-space:nowrap; text-overflow:ellipsis }
/* PathLabel.module.css:1-28 —— 溢出时保留文件名在右侧 */
.path { display:flex; flex: 1 1 auto; justify-content:flex-end; min-width:0; overflow:hidden;
        font-size:12px; white-space:nowrap }
.path[data-path-clipped] { mask-image: linear-gradient(to right, transparent, black 28px) }
.text { flex:none; margin-right:auto }
.directory { color: var(--dsw-alias-label-tertiary) }
.name { color: var(--dsw-alias-label-primary) }
```

`data-path-clipped` 是**测量出来**的：`outer.toggleAttribute('data-path-clipped', inner.offsetWidth > outer.clientWidth)`（`PathLabel.tsx:24-27`）。

**代码区（行号）**：`CodeBody` 把 `lineNumbers` 打开（`code/CodeBody.tsx:14-34`）：

```
div.renderer[data-code-preview][data-wrap=true|false]
└ div.block.md-code-block.card.numbered[data-line-numbers][data-code-wrap]
  ├ div.bannerWrap > div.header[data-code-block-banner]
  │  ├ div.heading > span.language        （语言标签；无语法时回退 t('codeBlock.title')='代码'）
  │  └ div.actions > button.action        （复制）
  └ div.content[data-code-block-content]
     └ pre.shiki.css-variables[tabindex=0] > code > span.line × N
```

**行号是 CSS counter，不是 DOM 数字**（`CodeBlock.tsx:74-75, 178-193` + `CodeBlock.module.css:122-145`）：

```css
.numbered :where(pre) code { display:block; counter-reset: source-line; white-space: normal }
.numbered :where(pre) code > :global(.line) {
  position: relative; display: block; min-height: 1lh;
  padding-inline-start: calc(var(--dsl-code-block-line-number-width) + 12px);
  counter-increment: source-line;
  white-space: var(--dsl-code-block-line-white-space, pre-wrap); }
.numbered :where(pre) code > :global(.line)::before {
  position: absolute; inset-inline-start: 0;
  width: var(--dsl-code-block-line-number-width);
  color: var(--dsw-alias-label-tertiary);      /* 暗色 rgb(173,178,184) */
  text-align: end; content: counter(source-line); user-select: none; }
```

行号槽宽由 TSX 内联写出：`'--dsl-code-block-line-number-width': `${Math.max(2, String(sourceLines.length).length)}ch``（`CodeBlock.tsx:191-193`）。字体 `--dsw-font-markdown-code-block` = **11px/19px** code 栈。

侧栏覆盖（`code/CodeBody.module.css:1-61`）：**圆角 0**、代码底透明（露出面板的 `--dsw-alias-bg-base` = 暗色 `rgb(21,21,23)`）、`pre` 内衬 16px、wrap 切换 `pre / pre-wrap + overflow-wrap:anywhere`。

```css
.renderer .code {
  --dsl-code-block-border-radius: 0px;
  --dsl-code-block-line-white-space: pre;
  --dsl-code-block-background: transparent;
  display:flex; flex:1 1 auto; flex-direction:column; height:100%; min-height:0;
  position:static; margin:0; min-width:0; }
.renderer .code > [data-code-block-content] { position:relative; display:block; flex:1 1 auto;
  min-width:0; min-height:0; overflow:auto; }
.renderer .code pre { box-sizing:border-box; padding:16px; min-width:100%;
  overflow:visible; white-space:pre; word-break:normal; overflow-wrap:normal; }
.renderer[data-wrap='true'] .code pre { white-space: pre-wrap; overflow-wrap: anywhere; }
```

**没有 `::selection` 规则**（唯一的 selection 样式在 PDF 文本）。语法色来自 §2.6 的 `--shiki-*`。跳转到某行是靠 class 而非高亮器：`.lineTarget { background: var(--dsw-alias-interactive-bg-hover) }`。

其他渲染模式：纯文本 `div.textDocument[data-textpreview-plain] > pre.page > div.line`（**没有行号槽**）；Markdown `div.document[data-document-markdown] > MarkdownText`（`padding: 10px 12px`）；HTML `<iframe sandbox=""|"allow-scripts">`；PDF 把 body 底色换成 `--dsw-alias-bg-document-preview`。

### 6.6 终端 / 浏览器 / 文件 tab（结构级）

- **终端**：注册 `kind: 'terminal'`、`multiple: true`、guide `order: 20`。DOM `section.root[data-sidebar-terminal] > div.status[role=status]? + div.screen`，xterm 挂到 `.screen`，构造参数 `{ minimumContrastRatio: 4.5, cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', scrollback }`。`.root { padding-top: 8px }`（**没有自己的 38px 工具栏行**，页签条就是它的全部 chrome）；`.screen { flex:1; padding:8px; background: var(--dsw-alias-bg-base) }`。
- **浏览器**：注册 `kind: 'browser'`、`multiple: true`、guide `order: 30`，`keepMounted: desktop !== undefined`。DOM `div.root > form.toolbar(38px) + div.content > div.viewport`；`.toolbar { height:38px; padding:5px 6px; gap:4px; border-bottom:0.5px solid var(--dsw-alias-border-l3) }`、`.tool` 28×28 圆角 6px、`.address { height:28px; padding: 0 34px 0 9px; background: var(--dsw-alias-bg-layer-1); border:0.5px solid var(--dsw-alias-border-l2); border-radius:6px; font: var(--dsw-font-xxs-12) }`。Web profile 下该插件被禁用（`bundle/web-app/cordis.patch.yml:253-255`）。
- **文件树**：注册 `kind: 'files'`（page 类型）、guide `order: 10`；body 复用与文档预览同款的 38px 头（`.header { height:38px; padding: 0 6px 0 16px; border-bottom:0.5px solid var(--dsw-alias-border-l3) }`）。
- **打开方式（已实现，M1）**：Piggy 落在**会话头部右侧**（`SessionHead` 的 ops 区，DSH 的 `conversation.session.header.utilities` 位）。
  形态照搬：`div.pg-openin-split > button.main + button.chevron`，高 26px、全圆角、1px 边框、主按钮 hover 底色、失败态描边变红。
  **一处有意的偏离**：DSH 主按钮只有图标，Piggy 主按钮**带应用名** —— 用户对这个位置的原话是「稍微显著一点」，
  纯图标在深色头部里太隐形（`ui:startup` 第 8 段量的就是"宽度 ≥70px 且边框宽度 >0"）。
  另：菜单**向下**弹（会话头部在窗口顶部），复用 `Picker` 的 `side="down"`。
  命令面板里也有一个 `openin.pick`（**无默认键位**）：它发 `open-in-app-picker` 信号让胶囊展开菜单
  —— 和 `model.pick` → `Picker.openSignal` 同一条路，所以"键盘可达"不是靠一颗隐藏按钮。
  选择是**跨头部共享**的（DSH 的 choice 是一份共享 store；Piggy 用 `windowEvents` 广播）。
  失败时除红框外，Rust 那句话会挂到 `title` 上并经 `webview_log` 转进宿主终端（打包版没有 DevTools）。
- **打开方式（文件级，已实现，M1）**：DSH 源码把它注入到 `sidebar.right.tab.document.actions` /
  `…document.unpreviewable` / `deliverables.*.file.actions`；Piggy 落在**预览 tab 头部最后一格**
  （wrap/reload/copy 之后，与 DSH 的文档动作位同一个位置）。数据源是**操作系统文件关联**而不是白名单目录：
  macOS 走 `osascript -l JavaScript` + AppKit `NSWorkspace`（`URLForApplicationToOpenURL` /
  `URLsForApplicationsToOpenURL`，实测本机 README.md 有 20 个处理器、默认 Typora），
  Linux 走 `gio info` + `gio mime`，Windows 的处理器枚举要 COM（`SHAssocEnumHandlers`）**没做**。
  三个动作：默认应用打开 / 用某个已注册处理器打开 / 在文件管理器里显示（Windows 上枚举为空，
  于是主按钮退成"显示文件位置" —— 与 DSH 拿不到默认应用时的 `revealDefault` 同款行为）。
  两档共用 DSH 的 `OpenTargetButton` 形状（`data-open-target=directory|file`、`data-size=large|compact`）。
- **失败反馈**：DSH 用 `open-failure-toast` 逐控件弹一次；Piggy 走 `lib/feedback` 的 `toast.error`，
  文案带 Rust 那句原因（`打开失败，请重试：目录不存在: /x/y`）。文案与 DSH 的 zh 词典逐条对齐。
- **打开方式（原 DSH 形态）**：不贡献 tab，而是注入 `sidebar.right.tab.document.actions` 与 `…document.unpreviewable`；控件是分裂胶囊 `div.split[data-open-target=file][data-size=compact|large] > button.main + button.chevron`，`.split { height:24px; border:0.5px solid var(--dsw-alias-border-l4); border-radius:9px }`（large: `height:36px; border-radius:14px`），非桌面环境返回 `null`。

### 6.7 默认有哪些 tab、顺序如何

**(a) 注册/声明顺序**（`bundle/web-app/cordis.patch.yml` 中浏览器插件行序）：`ui-sidebar-right` → `ui-sidebar-documentpreview` → `ui-sidebar-browser`（desktop-only）→ `ui-sidebar-terminal` → `ui-sidebar-files` → … → `ui-deliverables` → `ui-subagent` → `ui-plan`。注册顺序是 `candidates()` 的**最后**一个 tiebreaker。

| kind | band | multiple | guide 条目（order） |
|---|---|---|---|
| `guide` | builtin | – | 无 |
| `text` | **fallback**，`patterns: ['dsh-resource://file/**']`，仅 session 作用域 | – | 无 |
| `files` | builtin（page） | – | `workspace` @ **10** |
| `terminal` | builtin（page） | ✅ | `new` @ **20** |
| `browser` | builtin（page） | ✅ | `new` @ **30** |
| `plan` | builtin（resource） | – | 无 |
| `subagentchat` | builtin（resource） | – | 无 |
| changes-review | （deliverables） | – | 无 |

**(b) 条内顺序** = 每个 pane 的 `tabs` 数组（到达顺序）。
**(c) 首个打开的 tab** = §6.4 的 `defaultSeed`：默认 profile 有 2~3 个 guide 条目 → **guide 页（"开始"）**。

---

## 7. 复用结论：哪些能抄、哪些只能当参考

### 7.1 判据

DSH 每个客户端包都被 tsdown 打成「client bundle」，通过 `dsh.client` 声明 + cordis Loader 装配（见 `#12-docs/subsystems/client-modules.md`）。判断可复用性看两点：

1. 该包的 `src` 里有多少文件 `import ... from 'cordis'`（运行时耦合，不是 type-only）；
2. 该包的 DOM/CSS 是否自包含（`*.module.css` 无外部类名依赖）。

实测（`grep -rl "from 'cordis'" packages/client/*/src`，2026-09 状态）：

| 包 | cordis 文件 / ts+tsx 总数 | 结论 |
|---|---|---|
| `ui-primitives` | **0 / 77** | ✅ 纯 React + CSS Modules，`package.json` 描述直言 "Pure React atoms … (zero cordis)" |
| `ui-dockkit` | **0 / 22** | ✅ 纯布局引擎 + React 面，但它是 `ui-sidebar-right` 的内部依赖，接口不承诺稳定 |
| `client/store` | **0 / 2** | ✅ 极小的 observable store（`defineStore` / `ObservableSnapshot`） |
| `ui-brand-official` | 1 / 3 | 🟡 只有 `index.ts`（apply）碰 cordis，组件是纯的 |
| `ui-sidebar` | 1 / 7 | 🟡 同上：`SidebarRoot.tsx` / `HeaderLeadingControls.tsx` 是纯 React |
| `ui-renderer` | 4 / 10 | ❌ 唯一允许把裸 observable 通过 `useSyncExternalStore` 绑定、持有 React context、渲染根树 |
| `ui-slots` | 1 / 3 | ❌ 插槽注册表与生命周期账本本身 |
| `ui-layout` | 1 / 9 | 🟡 `AppFrame.tsx` / `AppFrame.module.css` / `columns.ts` **可直接抄**（零 cordis import，注释明说 "zero cordis or framework imports"），`service.ts`/`apply` 才耦合 |
| `ui-conversation` | 13 / 68 | ❌ 装配 + 事件/视图注册表；但 `skeleton/*.tsx` + `*.module.css` 是纯展示层 |
| `ui-chat` | 19 / 90 | ❌ 同上；`chat/*.tsx` 里 `ChatView / MessageItem / MessageIconActions / StatsPills / TurnTailNodeView` 是纯展示层 |
| `ui-trajectory` | 7 / 31 | ❌ 同上；`Trajectory*.tsx` + `.module.css` 是纯展示层 |
| `ui-sidebar-right` | 2 / 23 | 🟡 外壳 CSS 可抄；tab 注册表/服务是 cordis |
| `ui-theme` | 3 / 10 | ✅ **样式与令牌表零依赖**（纯 CSS 文件 + 注入函数），直接拿来即用 |

### 7.2 可直接 vendor / 复制的清单（按性价比排序）

1. **`ui-theme/src/styles/*.css`（6 张表，共 ~830 行）** —— 令牌、阴影、排版、滚动条、shiki、圆角曲率。**零改动可用**，只需把 `src/styles/base.css` 的变量提到 `:root`、把 `design-platform.css` 原样引入。Piggy 的 `apps/desktop/src/styles.css` 应以此替换手写色值。
2. **`ui-layout/src/client/AppFrame.{tsx,module.css}` + `columns.ts` + `stores.ts` 的几何常量** —— 三栏 grid、拖拽手柄、折叠动画、responsive 规则。`AppFrameProps` 需要替换成 Piggy 的 props（`useStore`/`renderSlot`/`t` 换成 zustand + 直接子组件），但**组件体几乎逐行可用**。
3. **`ui-primitives`（77 文件）** —— 图标集（`icons/index.tsx`，1612 行，全部是内联 SVG path）、`Button / Pill / Tag / Menu / Modal / Tooltip / Toast / SegmentedTabs / Switch / Checkbox / Input / DisclosureRow / StateDot / FileTypeIcon / ConnectionIndicator / CodeBlock / MarkdownText / JsonTree / DiffBlock / WebBlock / TerminalBlock / ReadBlock / SearchBlock`。**唯一外部依赖**是 `@deepseek-ai/dsh-util-workspace-path`（路径缩写）与 `clsx`，去掉这两个即可整包 vendor。**这是 DSH 视觉一致性的最大红利。**
4. **纯展示层组件 + CSS Modules**（逐个 copy，去掉 inject/slot props，把数据改成 props）：
   - Composer：`ui-conversation/src/client/skeleton/{InputBar,ContextMeter,ConversationRoot,ConversationSession,ConversationHeader,EmptyHero,QueueDock,TodoPanel}.tsx` + 同名 `.module.css`
   - 消息：`ui-chat/src/client/chat/{MessageItem,MessageIconActions,StatsPills,TurnUsagePanel,TurnTailNodeView,TurnProcessNodeView,TurnTriggerNodeView,ReasoningRow,ContextInjectionRow,AssistantMarkdown,SystemPromptRow,CompactionItem}.tsx` + `.module.css`，加 `chat/stat-dialog.module.css`
   - 卡片：`ui-deliverables/src/client/{ChangedFiles,PresentedFileCard,Deliverables,FileDiff,ReviewTab}.tsx` + `.module.css`
   - 轨迹：`ui-trajectory/src/client/{TrajectoryView,TrajectoryToolbar,TrajectoryTable,TrajectoryTimeline,TrajectoryGroupHeader,TrajectoryTurn,TrajectoryTurnHeader,TrajectoryCell}.tsx` + `.module.css` + `views.module.css`
   - 侧栏：`ui-sidebar/src/client/{SidebarRoot,HeaderLeadingControls}.tsx` + `.module.css`、`ui-workspace/src/client/rows/{WorkspaceBrowser,Rows,AnimatedRows}.tsx` + `.module.css`、`ui-workspace/src/client/WorkspacePicker.tsx`
   - 右栏：`ui-dockkit/src/components/{TabPanel,TabTitle,TabLayout,DockSurface,TabMenu}.tsx` + `dockkit.module.css`（页签条就在这里，**注意它是单张 sheet，别拆**——`dockkit.module.css:1-14` 解释了原因：消费方 bundle 按 `<pluginId>/<basename>` 去重样式，第二个同名 sheet 会被静默丢弃）、`ui-sidebar-right/src/client/shell/{SidebarRight,ExpandButton}.tsx` + `.module.css`、`ui-sidebar-documentpreview/src/client/{TextPreview,PathLabel,TextTitle}.tsx` + `TextPreview.module.css` + `code/CodeBody.{tsx,module.css}`
   - 胶囊：`ui-model-selection/src/client/ModelSelect.{tsx,module.css}`、`ui-permission-presets/src/client/PermissionSelect.{tsx,module.css}`、`ui-agent-preset/src/client/AgentPresetSeat.{tsx,module.css}`
5. **纯计算工具**（无 React 也无 cordis，直接搬）：
   - `ui-primitives/src/relative-time.ts`（相对时间分桶）、`file-size.ts`（`fileSizeText`）、`clipboard.ts`（`writeClipboard`）
   - `ui-layout/src/client/columns.ts`（列宽求解）
   - `ui-chat/src/client/chat/message-chrome.ts`（时钟/时长/tok-s 格式化）、`token-format.ts`、`stat-dialog.ts`
   - `ui-trajectory/src/client/timeline.ts`（三轨时间线几何）、`trajectory-virtual-rows.ts`（虚拟行高度契约）、`trajectory-preview.ts`（单行截断）、`trajectory-search-index.ts`（搜索语义）
   - `ui-dockkit/src/engine/*`（若 Piggy 要做分屏拖拽）

### 7.2b M1 最小可抄子集（按 §11 的排期）

若只做 Piggy 的 M1，按这个顺序抄，其余留到 M2：

1. `ui-theme` 6 张样式表（半天，收益最大）
2. `AppFrame` + `columns.ts`（三栏 + 折叠 + 拖拽）
3. `ui-primitives` 的 `icons/index.tsx` + `Button/Pill/Tag/Menu/Modal/Tooltip/Toast/DisclosureRow/StateDot/FileTypeIcon/Tooltip`（先把 emoji 换掉）
4. `ui-conversation` 的 `ConversationRoot.module.css` + `InputBar` + `ContextMeter`（Composer M1）
5. `ui-chat/chat/ChatView` + `MessageItem` + `MessageIconActions` + `AssistantMarkdown`/`ReasoningRow`（消息 M1）
6. `ui-deliverables/ChangedFiles` + `PresentedFileCard`（本轮改动 M1）
7. `ui-sidebar/SidebarRoot` + `ui-workspace/rows/*`（侧栏 M1）
8. `ui-trajectory/*`（轨迹 M1）+ `ui-dockkit` 页签条 + `TextPreview`（右栏预览 M1）

### 7.3 只能当视觉/结构参考（不可直接复用）

| 包 | 不可复用的原因 |
|---|---|
| `ui-slots` + `ui-renderer` | 组件 props 由插槽契约「派生」而来（`PropsRuntime / PropsRenderSlots / PropsStore / PropsLocale / InjectFace`），依赖 cordis 的 `ctx.slots`、`ctx.uiSession.provide`、`useSyncExternalStore` 绑定。Piggy 应换成显式 props + zustand selector。 |
| `ui-conversation` 的装配层 | `conversation/event-registry.ts`、`view-registry.ts`、`group-registry.ts`、`assembler.ts` 是 DSH durable 事件 → 视图快照的解释器，绑定 DSH 的 `SessionEventLikeEntry` 模型。Piggy 的 `pi` RPC 事件信封不同（见 `02-pi-rpc-integration.md`），只能参考其分层思想（Context 身份 / 目标快照 / keyed 渲染）。 |
| `ui-chat`/`ui-trajectory` 的 `conversation-nodes/*` | 每个 Definition 消费 DSH 的 durable 事件族（`assistant/message`、`tool/call`、`compaction/*`…），是数据解释器而非 UI。 |
| `ui-sidebar-right` 的 tab-registry / service / persistence | 地址族 `dsh-resource://…`、`ctx.sidebarRight.openResource()`、dockkit 的 `LayoutState/LayoutOp` 都是 DSH 专有协议。 |
| `connection` / `modules` / `resources` / `hmr` / `store` 之外的所有 client 基础设施 | 浏览器侧 cordis Loader、`window.__DSH_BOOT__`、生成式 Remote（typert）——**Piggy 已有 `02-pi-rpc-integration.md`，完全走另一条路**。 |
| `ui-settings-*` 全家桶 | 依赖 Host user-settings 文档与 `ctx.settings`，表单控件本身在 `ui-primitives/settings-form/*` 里（那部分可抄）。 |

### 7.4 给 Piggy 的落地姿势（建议）

1. `apps/desktop/src/styles/` 下建 `tokens.css`（= `base.css` + `design-platform.css` + `gradient-shadow-text.css` + `scrollbar.css` + `shiki.css` + `corner-shape.css` 合并），Piggy 现有 `styles.css` 改为只引用令牌。
2. `packages/ui/`（或 `apps/desktop/src/ui/`）建三个纯 React 层：`primitives/`（vendor `ui-primitives`）、`layout/`（抄 `AppFrame`）、`chat/`（抄 `ui-chat` 展示层）。全部零 cordis、零 DSH 类型导入，props 显式。
3. 保留 Piggy 自己的状态层（zustand + Tauri invoke）作为「Host 事件 → 视图快照」的解释器，输出与 DSH chat node 结构同形的 `ChatSnapshot`，这样展示层几乎不用改。
4. 图标一律从 `ui-primitives/src/icons/index.tsx` 取，删掉现有 emoji（`14-ui-assessment…` D4）。
5. 三栏几何常量严格抄 §1.2；`--dsh-chat-content-width` / `--dsh-composer-card-max-width` 两个公式照抄，否则消息列与输入框对不齐。

---

## 附录 A · 扩展槽位速查（Piggy 若要保留 DSH 的装配自由度）

来自 `#12-packages/client/ui-conversation/src/client/apply.ts` 与各包注册：

| 槽位 | 基数 | 作用域 | 提供方 |
|---|---|---|---|
| `root` | single | — | `ui-layout` AppFrame |
| `sidebar` | single | root | `ui-sidebar` SidebarRoot |
| `main` | single | root | `ui-conversation`（`entryKey = activePanelId ?? 'conversation'`） |
| `rightbar` | single | root | `ui-sidebar-right` |
| `shell.overlay` / `shell.leading` | single | root | 覆盖层 / macOS 窗口控件 |
| `conversation.header` | single | session-maybe | `ConversationHeader` |
| `conversation.header.leading` | single | root | 导航按钮 |
| `conversation.session.header` | single | session | `ConversationSessionHeader` |
| `conversation.session.header.{lineage,actions,utilities,corner}` | single/list | session | 谱系、动作、工具、右角 |
| `conversation.content` | factory | session-maybe | `ConversationContent` |
| `conversation.session` | single | session | `ConversationSession`（视图区） |
| `conversation.view` | list | session | `ui-chat`（order 0）、`ui-trajectory`（order 10） |
| `conversation.composer` | chain | session | composer 接管 |
| `conversation.composer.bar` | single | session-maybe | `InputBar` |
| `conversation.input.{attachments,overlay,permission,left,plan,right,model,activity}` | single/list | session | 附件、浮层、权限胶囊、左槽、Plan、右槽、模型、活动态 |
| `conversation.composer.dock` | list | session | `ui-chat` StatsPills（order 0） |
| `conversation.hero.{brand.mark,workspace,agentPreset}` | single | root / session-maybe | Hero 品牌、工作区选择、Agent 预设 |
| `conversation.chat.turnTail` | list | session | `ui-deliverables` 文件卡 |
| `conversation.chat.assistant-actions` | list | session | 反馈等 |
| `sidebar.right.pane.tab(.title)` / `sidebar.right.tab.guide` / `.menu.item` / `.document` | keyed/chain/list | session | 右侧栏各 tab 与文档渲染器 |

## 附录 B · 对 Piggy 现有认知的关键更正

读完 DSH 源码后，以下几条与 `11-dsh-reference.md` / `14-ui-assessment-and-dsh-alignment.md` 的表述不一致，**以本文档为准**：

| # | 现有表述 | 源码事实 | 依据 |
|---|---|---|---|
| C1 | 「本轮文件改动 chips（消息下方的文件链接行）」 | **该行已被删除**（commit `f937f4e23b`），现在是 `ChangedFiles` **卡片**，标题 `已编辑 {count} 个文件`，顶部 60px 头部 + 可折叠文件行（默认 4 行） | `.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.zh.md:51`；`ui-deliverables/src/client/ChangedFiles.tsx:38-91` |
| C2 | 轨迹有「角色芯片（系统/用户/**上下文**/助手/工具/**压缩**/**label**/**分支**）」 | kind 枚举只有 7 种：`system / user / context / message(助手) / tool / subtool / compacted`。**没有 `label`、没有 `分支`**；`子工具` 也常被漏掉。英文标签是**全大写**（SYSTEM/USER/CONTEXT/ASSISTANT/TOOL/SUBTOOL/COMPACTED） | `TrajectoryTable.tsx:52-60`；`TR/locales.ts:22-29`(zh) / `:224-231`(en) |
| C3 | 轨迹有「过滤 + 搜索」 | **没有角色过滤器**。工具栏只有 4 个按钮（时长 / 实际时间(隐藏) / 轮次 / 调用）+ 1 个搜索框；唯一过滤是**文本搜索**（空白切词 AND、大小写不敏感子串，**无高亮**，未命中行直接不渲染 + 时间线 span 变暗到 0.14） | `TrajectoryToolbar.tsx:51-127`；`trajectory-search-index.ts:124-132` |
| C4 | 状态行 = 「轮/步 · tok/s · 总 tok · 缓存命中」 | 对，但它就是 **Composer dock**（`conversation.composer.dock` 槽里的 `StatsPills`），**不是窗口底部横条**；DSH 没有底部状态栏 | `ui-chat/src/client/apply.ts:229-233`；`InputBar.tsx:498-503` |
| C5 | Composer 有「`+` / `@` 按钮」 | **只有 `+` 按钮**（`aria-label = 添加文件或调用指令`，`<IconPlusOutlineMedium size={14}/>`）。**`@` 没有按钮**，它是输入框内的触发符（`ui-reference` 注册 `trigger: '@'`），`/` 同理 | `InputBar.tsx:419-432`；`ui-reference/src/client/index.ts:52` |
| C6 | 消息操作行含「反馈按钮」 | DSH 内置操作只有 **copy + branch**（+ 时间戳 + 详细模式下的用量胶囊）；反馈是**外部插件贡献**到 `conversation.chat.assistant-actions` 槽的，不是 ui-chat 自带 | `MessageIconActions.tsx:82-113`；`TurnTailNodeView.tsx:53-55` |
| C7 | 顶栏 / 标题栏 | DSH **不自绘标题栏**。品牌行在侧栏顶部；macOS 用 `titleBarStyle:'hiddenInset'` + 红绿灯 x16/y18，Windows 用 `hidden` + `titleBarOverlay` 高 40px；页面侧只有一条 `-webkit-app-region: drag` 的 52px（有页签时 76px）拖拽带 | `apps/desktop/src/main.ts:185-197`；`AppFrame.module.css:192-211` |
| C8 | 侧栏会话选中 = 高亮 + 强调条 | **没有强调条**。选中就是 `--dsw-alias-interactive-bg-hover`（暗色 `rgba(255,255,255,0.08)`）的 8px 圆角填充，与 hover 同色。`--dsw-specific-sidebar-nav-item-active(-accent)` 只被设置弹窗的导航项用到 | `ui-workspace/src/client/rows/Rows.module.css:19-21` |
| C9 | 右侧面板宽度 / 布局会被记住 | **面板像素宽度不持久化**（只在内存 store，首次打开按视口 45%）。持久化的只有 pane 树、浮动位置、`expanded`、`mode`，key 前缀 `dsh.sidebar-right.v1.<sessionId>` | `ui-layout/src/client/stores.ts:33,86,132`；`ui-sidebar-right/src/client/persistence.ts:7,66` |
| C10 | 右侧面板「tab + 面包屑 + 语言条 + 行号高亮」 | 页签条由 **`ui-dockkit`** 绘制（`ui-sidebar-right` 不自绘）；面板**没有标题栏**，两个控制钮挂在页签条末端的 chrome 座位；面包屑与"语言条"是**同一行 38px**（路径 + 工具按钮），代码区行号是 **CSS counter**（`--dsl-code-block-line-number-width: max(2, 位数)ch`），代码区**无 `::selection` 规则**；"行高亮"是给目标行加 `.lineTarget` 类 | `TabPanel.tsx:212-394`；`SidebarRight.tsx:15-18`；`TextPreview.tsx:264-322`；`CodeBlock.module.css:122-145` |
| C11 | —（新增发现） | `--dsw-alias-separator-primary` 与 `--dsw-alias-label-quaternary` 在 `ui-theme` 令牌表里**不存在**（来自上游 deepsuite 主题），Piggy 需自补 | `StatsPills.module.css:64`；`AgentPresetSeat.module.css:44` |

## 附录 C · 关键尺寸速查卡（可直接建常量表）

| 名称 | 值 | 出处 |
|---|---|---|
| 侧栏默认/最小/最大/折叠宽 | 280 / 264 / 420 / 56 px | `columns.ts:13-19` |
| 侧栏自动折叠断点 | 1024 px | `columns.ts:23` |
| 中列保护最小宽 | 400 px | `columns.ts:11` |
| 右栏最小/最大比例/默认比例 | 300 px / 0.70 / 0.45 | `columns.ts:25-29` |
| 右栏自动全屏断点 | 768 px | `SidebarRight.tsx:344` |
| 会话头部高 | 76 px（无页签时收缩；10px 上衬 + 30px 标题行 + 10px margin + 16px 页签 + 9px 下衬） | `ConversationRoot.module.css:15-28` |
| 页签间隙 / 字号 | `gap: 36px` / `13px/16px` 500 | `ConversationRoot.module.css:187-210` |
| 选中页签指示条 | 2px，圆角 2px，`bottom: -1px` | `ConversationRoot.module.css:212-232` |
| 对话内容宽 | `clamp(680px, 列宽×0.64, 920px)` | `ConversationRoot.module.css:378-381` |
| Composer 卡片宽 | 内容宽 + 32px；圆角 22px | `ConversationRoot.module.css:382`；`InputBar.module.css:61` |
| Composer 文本上限 | 336 px（14 行 × 24px） | `ConversationRoot.module.css:351` |
| Composer 吸底 z-index | 7（菜单打开时 9） | `ConversationRoot.module.css:435,454` |
| 气泡最大宽 | `min(内容宽 × 0.702, 82%)`；圆角 22px；内衬 `10px 16px` | `MessageItem.module.css:11-41` |
| 对话行间距 | 16px（折叠过程摘要后 8px） | `ChatView.module.css:68-85` |
| 对话滚动区内衬 | `16px (clearance+16px)` | `ChatView.module.css:27` |
| 消息操作按钮 | 28×28，圆角 28px；图标 15px（尾行 17px） | `MessageIconActions.module.css:63-87` |
| 变化卡片 / 交付卡片 | 高 60px；圆角 18px；发丝边 0.5px；图标砖 40×40 圆角 10px | `ChangedFiles.module.css:2-10`；`Deliverables.module.css:10-14` |
| 轨迹工具栏 / 时间线 / 行高 | 32 px / 50 px（三轨 y=7/21/35，轨高 8px，轨距 14px） / 30 px（折叠摘要 20px、终止边界 9px） | `views.module.css:3`；`TrajectoryTimeline.module.css:14-58`；`trajectory-virtual-rows.ts:6-8` |
| 轨迹 kind 芯片 | 高 19px；内衬 `0 5px`；圆角 4px；`10px/16px` 650；字母距 0.035em | `TrajectoryTable.module.css:450-467` |
| 轨迹事件列宽 | 122px（`:lang(zh)` 84px；窄容器 50px） | `TrajectoryTable.module.css:115-121` |
| 侧栏行高 | 工作区行 34px / 会话行 32px；圆角 8px | `Rows.module.css:94-108` |
| 「展开其余 N 个」 | 高度 28px；圆角 8px；左衬 `28px + 缩进`；字号 12px；阈值 5 | `WorkspaceBrowser.module.css:494-505`；`WorkspaceBrowser.tsx:53-54` |
| 右侧面板页签 | 高 28px；`min-width 80px` / `max-width 170px`；圆角 12px；关闭钮 20×20 | `dockkit.module.css:232-241, 355-372, 411-426` |
| 面板 38px 行（文档头 / 浏览器工具栏） | 高 38px；工具钮 28×28 圆角 28px；图标 15px | `TextPreview.module.css:20-33, 256-288`；`Browser.module.css:52-68` |
| 面板切换动画 | `transform 0.3s cubic-bezier(0.4,0,0.2,1)` | `SidebarRight.module.css:44-62`；`base.css:11,14` |
| 代码块 | 圆角 12px（面板内 0）；正文 `11px/19px` code 栈；标题条 `11px/18px`；行号槽 `位数ch + 12px` | `CodeBlock.module.css:4-18, 122-145`；`CodeBody.module.css:1-20` |

## 附录 D · 关键文件索引

| 主题 | 路径 |
|---|---|
| 三栏外壳 | `#12-packages/client/ui-layout/src/client/{AppFrame.tsx,AppFrame.module.css,columns.ts,stores.ts}` |
| 令牌 | `#12-packages/client/ui-theme/src/styles/{base,design-platform,gradient-shadow-text,scrollbar,shiki,corner-shape}.css` |
| 首屏主题注入 | `#12-packages/client/ui-theme/src/boot-theme.ts` |
| 会话骨架 | `#12-packages/client/ui-conversation/src/client/skeleton/{ConversationRoot.tsx,ConversationRoot.module.css,ConversationMainPanel.tsx,ConversationHeader.tsx,ConversationSession.tsx}` |
| Composer | `#12-packages/client/ui-conversation/src/client/skeleton/{InputBar.tsx,InputBar.module.css,ContextMeter.tsx}` |
| 表单编辑 | `#12-packages/client/ui-conversation/src/client/input/editor/{DraftEditor.tsx,ComposerContentEditable.tsx,composer-editor.module.css}` |
| 对话渲染 | `#12-packages/client/ui-chat/src/client/chat/*` |
| 文件卡 | `#12-packages/client/ui-deliverables/src/client/*` |
| 轨迹 | `#12-packages/client/ui-trajectory/src/client/*` |
| 侧栏 | `#12-packages/client/ui-sidebar/src/client/*`、`#12-packages/client/ui-workspace/src/client/rows/*` |
| 右栏 | `#12-packages/client/ui-sidebar-right/src/client/shell/*`、`#12-packages/client/ui-sidebar-documentpreview/src/client/*` |
| 通用原子 | `#12-packages/client/ui-primitives/src/*` |
| 窗口壳 | `#12-apps/desktop/src/{main.ts,preload-windows.ts,preload-menu.ts,windows-layout.ts}` |
