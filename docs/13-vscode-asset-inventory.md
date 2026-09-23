# 13 · VS Code 资产清单（对 10 的核验与扩充）

> 上游：[10-vscode-assets.md](10-vscode-assets.md)、[04-frontend-design.md](04-frontend-design.md) · 关联：[05-performance.md](05-performance.md)、[08-project-structure.md](08-project-structure.md) §3
> 核验基准：`/Users/wxk/Documents/Project/vscode` — **VS Code 1.140.0**，commit `b761e4ed5a30fd66137ea5fab7f3b36d341b5d24`（Code - OSS 变体）。该 checkout **未安装 `node_modules`**，因此仓库内**不存在 `codicon.ttf`**（编译期从 npm 复制，见 §1.2）；字体体积数据取自 npm registry 上与本仓库 pin 一致的 `@vscode/codicons@0.0.46-40` tarball。
> 定位：本文是 10 的**核验 + 扩充**，不是替代。10 的方向全部成立；本文修正其中的**事实性错误**并补上 10 完全遗漏的一整层资产（设计 token 注册表）。

---

## 0. 对 10 的勘误（TL;DR）

| # | 10 的说法 | 核验结果 | 影响 |
|---|---|---|---|
| **E1** | §0 表格：「`@vscode/codicons` ✅ 采纳 — **MIT** 图标集」 | ❌ **错**。npm `license` 字段 = **`CC-BY-4.0`**；MIT 只覆盖**代码**（包内另有 `LICENSE-CODE`）。`ThirdPartyNotices.txt:2698` 原文：`vscode-codicons 0.0.46-0 - MIT and Creative Commons Attribution 4.0` | 复用模式从「vendor（MIT）」升级为「**vendor + 强制署名**」。CC-BY-4.0 不可省略署名，且**不授予商标权** |
| **E2** | §4 表格：「文件图标：vendor `seti-ui` **SVG 子集**（~200 常见类型）」 | ❌ **错**。`extensions/theme-seti/icons/` 下**零个 `.svg`**；图标是**字体**——`seti.woff`（37,284 B）+ `vs-seti-icon-theme.json`（54,732 B，383 个 `iconDefinitions`，每项形如 `{"fontCharacter":"\\E001","fontColor":"#519aba"}`） | 「取 SVG 子集」不可行；只能整体 vendor WOFF+映射（或另找 SVG 图标源） |
| **E3** | §2.4：「`themes/*.json`（VS Code Dark+ 等起步）→ 构建期脚本生成 … 一份四吃」 | ⚠️ **不完整**。这些文件是 **JSONC**（含 `//` 注释与尾随逗号），**`JSON.parse` / Vite 的 JSON import 会直接抛错** | 构建管线必须先过 JSONC 解析器，或预转换为严格 JSON |
| **E4** | §2.4 隐含「主题文件 = 颜色事实来源」 | ⚠️ **不成立**。`dark_modern.json` 直接定义 152 个键，仅覆盖注册表中 **123/477** 个颜色 id（**26%**）；其余靠注册表默认值（`dark`/`light`/`hcDark`/`hcLight`）与派生变换（`transparent()`/`lighten()`）补齐 | 必须引入「注册表默认值层」。否则 `list.*`、`scrollbarSlider.*`、`diffEditor.*`、`textLink.*` 等一大批变量为空，深浅色切换会出现死色 |
| **E5** | 全文未提及设计 token 注册表 | ➕ **遗漏的高价值资产**。1.140 已有 `src/vs/platform/theme/common/sizeUtils.ts` + `sizes/baseSizes.ts`（机器可读的间距/字号/圆角/描边 ramp），并统一以 CSS 变量输出；另有 `build/lib/stylelint/vscode-known-variables.json`（**986 colors + 54 sizes + 287 others**） | 这是**最便宜、最高回报**的资产：直接给出 Piggy 设计系统的数值骨架（§4） |
| **E6** | §2.2 第 1 条：「`monaco-editor/esm/vs/editor/editor.api` + 显式语言贡献」 | ❌ **已失效的写法**。`monaco-editor@0.56.0` 引入了 `exports` 字段：`{"./*.js":"./esm/vs/*.js","./*":"./esm/vs/*.js"}`，导致 `monaco-editor/esm/vs/...` 被重写成 `…/esm/vs/esm/vs/...`（**文件不存在**）。实测 `vite@7.3.6 build` 报 `Rollup failed to resolve import "monaco-editor/esm/vs/editor/editor.worker?worker"` | 必须改用 `monaco-editor/editor/editor.api` 与 `monaco-editor/editor/editor.worker?worker`。**这是发版阻断级问题**，见 §3.5 |
| **E7** | §2.4 隐含「主题 JSON 的 `type` 决定深浅色」 | ⚠️ **`type` 字段在运行时被完全忽略**。唯一的判据是扩展 `package.json` 里的 `uiTheme`（`colorThemeData.ts:720` `theme.uiTheme \|\| 'vs-dark'`，`get type()` 按 `classNames[0]` 分派）。schema 里**根本没有声明 `type`** | 消费主题时必须从 contribution 元数据取 `uiTheme` 映射到 Monaco 的 `base`，不能读 JSON 的 `type` |

10 中**成立**的结论（复核无误）：Monaco 采纳、xterm.js 采纳、dockview 采纳、`@vscode/webview-ui-toolkit` 弃用、Theia/fork 否决、键位 DSL 概念复用、源码只读参考库定位（§6 的路径映射表逐条存在）。

---

## 1. Codicons

### 1.1 源码树中的位置与体积

| 路径 | 体积 | 作用 |
|---|---|---|
| `src/vs/base/common/codicons.ts` | 3,058 B | 出口：`Codicon = { ...codiconsLibrary, ...codiconsDerived }`；`getAllCodicons()` |
| `src/vs/base/common/codiconsLibrary.ts` | **37,536 B**（774 行） | **762 条** `register('name', 0xXXXX)`；文件头注明由 `vscode-codicons/scripts/export-to-ts.js` 自动生成 |
| `src/vs/base/common/codiconsUtil.ts` | 1,034 B | `register(id, fontCharacter)` + `getCodiconFontCharacters()`，产出 `{ [id]: number }` **码点映射表** |
| `src/vs/platform/theme/common/iconRegistry.ts` | 11,652 B | 把 `getCodiconFontCharacters()` 转成 `.codicon-xxx::before { content: '\eXXX' }` 规则 |
| `src/vs/platform/theme/browser/iconsStyleSheet.ts` | — | 把上述规则注入样式表 |
| `src/vs/base/browser/ui/codicons/codicon/codicon.css` | 874 B | `@font-face { font-family:"codicon; src:url("./codicon.ttf") }` + `.codicon[class*='codicon-']` 基线样式 |
| `src/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css` | 948 B | `.codicon-modifier-spin`（1.5s steps(30) 旋转）、`.codicon-modifier-disabled`（opacity .4） |
| `src/vs/base/browser/ui/codicons/codiconStyles.ts` | 427 B | 仅两行 `import './codicon/codicon.css'` + modifiers |
| `src/vs/base/browser/ui/codicons/codicon/README.md` | 157 B | 原文：*"It is added via the `@vscode/codicons` npm package, then copied to this directory during compile time."* |

> ⚠️ **`codicon.ttf` 不在 git 中。** 复制任务：`build/lib/compilation.ts:372-373`
> ```ts
> const codiconSource = path.join(root, 'node_modules', '@vscode', 'codicons', 'dist', 'codicon.ttf');
> const codiconDest   = path.join(root, 'src', 'vs', 'base', 'browser', 'ui', 'codicons', 'codicon', 'codicon.ttf');
> ```
> 同一逻辑在 `build/gulpfile.editor.ts:39-46`（`extract-editor-src` 任务）重复一次。

### 1.2 npm 包实际内容（`@vscode/codicons@0.0.46-40`，与 `package.json:113` 的 `^0.0.46-40` 对齐）

| 文件 | 体积 | 用途 |
|---|---|---|
| `dist/codicon.ttf` | **153,228 B** | 图标字体本体 |
| `dist/codicon.css` | 39,730 B | 完整 CSS：`@font-face` + **762 条** `.codicon-*::before` 规则（含码点），MIT 头 |
| `dist/codicon.csv` | 14,202 B | **机器可读码点表**：`short_name,character,unicode`（645 行数据，如 `zoom-in,,EB81`） |
| `dist/metadata.json` | 128,092 B | 元数据/映射 |
| `dist/codiconsLibrary.ts` | **37,536 B** | 与 `src/vs/base/common/codiconsLibrary.ts` **逐字节相同**（已 `diff` 验证） |
| `dist/codicon.svg` | 454,982 B | SVG sprite |
| `dist/codicon.html` | 1,499,973 B | 预览页（不需要） |
| `src/icons/*.svg` | 655 个 | 原始 SVG 源 |
| `LICENSE` | **19,242 B** | **CC-BY-4.0** 全文（约束字体美术） |
| `LICENSE-CODE` | 1,162 B | **MIT**（约束 CSS/TS 代码） |
| `package/LICENSE` = 19,242 B · `package/LICENSE-CODE` = 1,162 B · tarball 1,036,327 B · unpacked 3,663,735 B / 714 files | | |

### 1.3 数量核对（容易踩的坑）

| 指标 | 值 |
|---|---|
| `codiconsLibrary.ts` 条目 | **762** |
| `codiconsDerived`（`codicons.ts`）条目 | 30（18 条为字符串别名指向已有图标；12 条数值但与库中**重复**，新增码点 **0**） |
| **对外 id 总数** | **792** |
| **唯一字形码点数** | **655**（与 npm 包内 655 个源 SVG 一致） |
| 码点区间 | `0xEA60` – `0xECF7` |
| `codicon.css` 中 `::before` 规则 | 762（每个库 id 一条；`export`/`newline` 等 derived id 因库中已存在而天然覆盖） |

> 结论：**以 `codiconsLibrary.ts`（或 `codicon.css`）为唯一事实来源**，不要用 `codicon.csv`（645 行，少于 655 字形）。`Codicon` 里 792 个 id 有别名冗余，Piggy 只需按字形（655）建索引。

### 1.4 三种 vendor 方式

| 方式 | 产物 | 体积 | 适用 |
|---|---|---|---|
| **A. 整包字体（推荐）** | `codicon.ttf` + 自生成 CSS（`.codicon-*::before`） | 153 KB + ~40 KB CSS | 需要全部图标；实现最省事，与 VS Code 视觉零差异 |
| **B. SVG 子集** | 从 `src/icons/` 655 个 SVG 里挑 ~80 个 | ~30–60 KB | 只要少量图标、希望 tree-shaking。**代价**：需自建 name→SVG 映射与 `currentColor` 处理；且 SVG 受 CC-BY-4.0 同样约束 |
| **C. 不 vendor，改选 MIT 图标集** | e.g. Lucide（ISC） | — | 若法务不接受 CC-BY-4.0。**代价**：丢失 VS Code 语汇（`codicon-chevron-right`、`codicon-git-compare` 等），与 10 的「补足 antd 图标在代码语义上的缺口」目标冲突 |

**推荐 A**：153 KB 字体在 Tauri 里是本地文件、零网络、可被系统字体缓存；CSS 规则构建期生成 762 条（gzip 后约 6–8 KB）。与 10 §4「优先 SVG 子集，icon font 仅在子集不可行时用」相反——**字体方案在 Tauri 桌面场景更优**（无网络加载、无 FOUT、无雪碧图维护成本），且 CC-BY-4.0 对 SVG 与字体一视同仁，改 SVG 并不免除署名义务。

**许可必带文件**（缺一不可）：`LICENSE`（CC-BY-4.0 全文，19,242 B）、`LICENSE-CODE`（MIT，1,162 B），外加 Piggy 的 `THIRD_PARTY_NOTICES` 中一条满足 CC-BY-4.0 §3(a) 的署名：创作者（Microsoft Corporation）、版权声明、许可声明与免责声明、来源 URI（`https://github.com/microsoft/vscode-codicons`）、**是否修改**的说明、许可链接。注意 CC-BY-4.0 §2(b)(2)：*"Patent and trademark rights are not licensed under this Public License."*

---

## 2. Themes

### 2.1 文件清单（全部主题 JSON）

**`extensions/theme-defaults/themes/`** — Microsoft 自研，MIT，无 `cgmanifest.json`：

| 文件 | 体积 | 直接 `colors` | `tokenColors` | `include` | 解析后 colors / tokenRules |
|---|---|---|---|---|---|
| `2026-dark.json` | 19,306 B | 290 | 53 | `./dark_modern.json` | **325 / 118** |
| `2026-light.json` | 19,264 B | 297 | 49 | `./light_modern.json` | **339 / 113** |
| `dark_modern.json` | 5,390 B | 130 | 0 | `./dark_plus.json` | 152 / 65 |
| `dark_plus.json` | 4,700 B | 0 | 15 | `./dark_vs.json` | 43 / 65 |
| `dark_vs.json` | 8,601 B | 43 | 50 | — | 43 / 50 |
| `light_modern.json` | 6,450 B | 153 | 0 | `./light_plus.json` | 161 / 64 |
| `light_plus.json` | 4,783 B | 0 | 15 | `./light_vs.json` | 48 / 64 |
| `light_vs.json` | 9,623 B | 48 | 49 | — | 48 / 49 |
| `hc_black.json` | 9,272 B | 14 | 54 | — | 14 / 54 |
| `hc_light.json` | 11,475 B | 6 | 68 | — | 6 / 68 |

**`extensions/theme-*/themes/`** — 第三方（Colorsublime-Themes，MIT © 2015 Colorsublime.com，见 §5.1）：

| 文件 | 体积 | 直接 `colors` | `tokenColors` | 解析后 colors |
|---|---|---|---|---|
| `theme-monokai/themes/monokai-color-theme.json` | 11,984 B | 103 | 52 | 103 |
| `theme-monokai-dimmed/themes/dimmed-monokai-color-theme.json` | 14,608 B | 75 | 72 | 75 |
| `theme-solarized-dark/themes/solarized-dark-color-theme.json` | 12,695 B | 106 | 41 | 106 |
| `theme-solarized-light/themes/solarized-light-color-theme.json` | 12,814 B | 96 | 41 | 96 |
| `theme-abyss/themes/abyss-color-theme.json` | 11,449 B | 103 | 34 | 103 |
| `theme-kimbie-dark/themes/kimbie-dark-color-theme.json` | 8,633 B | 59 | 43 | 59 |
| `theme-quietlight/themes/quietlight-color-theme.json` | 11,802 B | 76 | 56 | 76 |
| `theme-red/themes/Red-color-theme.json` | 9,412 B | 67 | 41 | 67 |
| `theme-tomorrow-night-blue/themes/tomorrow-night-blue-color-theme.json` | 7,859 B | 66 | 31 | 66 |

**文件/产品图标主题**（`iconDefinitions` 计数）：

| 文件 | 体积 | iconDefinitions | 备注 |
|---|---|---|---|
| `extensions/theme-seti/icons/vs-seti-icon-theme.json` | 54,732 B | 383 | + `seti.woff` 37,284 B；238 `fileExtensions` / 101 `fileNames` / 83 `languageIds` |
| `extensions/theme-modern-icons/fileicons/vscode-modern-icons-icon-theme.json` | 15,176 B | 117 | + 62 `languageIds` |
| `extensions/theme-defaults/fileicons/vs_minimal-icon-theme.json` | 1,496 B | 10 | 最小集 |

主题注册入口：`extensions/theme-defaults/package.json` → `contributes.themes`（10 项，含 `id`/`label`/`uiTheme`/`path`）；`product.json` 的 `onboardingThemes` 把 **Dark 2026 / Light 2026 / Solarized / HC** 列为推荐项。

> ⚠️ **`uiTheme` 必须与主题 JSON 一起 vendor。** contribution schema（`themeExtensionPoints.ts:41-44`）规定 `uiTheme` 枚举为 `[vs, vs-dark, hc-black, hc-light]` 且 `required: ['path','uiTheme']`；`colorThemeData.ts:719-732` 取 `const baseTheme = theme.uiTheme || 'vs-dark'`、`const id = \`${baseTheme} ${themeSelector}\``，`get type()`（`:632-639`）按 `classNames[0]` 分派 `ColorScheme`。**这是深浅色的唯一判据**（主题 JSON 的 `type` 字段在运行时从不被读取，见 E7）。到 Monaco 的映射就是 `uiTheme` → `IStandaloneThemeData.base`，一一对应。

### 2.2 JSON 形态（**JSONC**，这是最大的工程坑）

schema：`src/vs/workbench/services/themes/common/colorThemeSchema.ts`（273 行），`colorThemeSchemaId = 'vscode://schemas/color-theme'`。注意其定义：

```ts
const colorThemeSchema: IJSONSchema = {
	type: 'object',
	allowComments: true,        // ← 允许 // 与 /* */ 注释
	allowTrailingCommas: true,  // ← 允许尾随逗号
	properties: {
		colors:            { $ref: workbenchColorsSchemaId, additionalProperties: false },
		tokenColors:       { anyOf: [ {type:'string'}, { $ref: textmateColorsSchemaId } ] },
		semanticHighlighting: { type: 'boolean' },
		semanticTokenColors:  { $ref: tokenStylingSchemaId }
	}
};
```

实际顶层键（各文件并集）：`$schema` · `name` · `include` · `type`（`dark`/`light`）· `colors` · `tokenColors[]` · `semanticTokenColors{}` · `semanticHighlighting`。

> ⚠️ **schema 只声明 4 个键**：`colors`（`additionalProperties: false`）、`tokenColors`、`semanticHighlighting`、`semanticTokenColors`。**`type` / `name` / `include` 都没有被 schema 声明**（根节点也没有 `additionalProperties: false`，故被容忍但不校验）。其中 **`include` 仅在运行时被处理**（`colorThemeData.ts:759-761`），而 **`type` 字段在运行时被完全忽略**——深浅色唯一判据是扩展 `package.json` 的 `uiTheme`（见 E7 与 §3.3）。

- **`tokenColors` 是联合类型**：数组（内联规则）**或**字符串（指向 `.tmTheme` 文件的相对路径）。Piggy 只需处理数组分支。
- **`semanticHighlighting`** 是 boolean（是否开启语义高亮），不是颜色表。
- 实测：**19 个颜色主题 JSON 中 17 个不是严格 JSON**（仅 `hc_black.json`、`hc_light.json` 是严格 JSON）。`dark_plus.json` 第 13 行有 `//` 注释，`monokai-color-theme.json` 首行即注释。**必须用 JSONC 解析器**——Vite 的 JSON import 与 `JSON.parse` 均会失败。

### 2.3 覆盖率问题（核心结论，回应 E4）

颜色 id 的**三个不同口径**（别混用）：

| 口径 | 数量 | 来源 |
|---|---|---|
| **仓库全量注册** | **849** | `grep -rho "registerColor(\s*'[^']*'" src/vs --include=*.ts` 去重。分布：`platform` 253 · `editor` 153 · `workbench/common` 187 · `workbench/contrib` 255 |
| **「外壳」子集**（本文覆盖率的分母） | **477** | `platform/theme/common/colors/*.ts`（9 文件）+ `workbench/common/theme.ts` + `sessions/common/theme.ts`——即 Piggy 布局真正用到的 chrome + 编辑器核心 |
| **CSS 变量总数** | **986** | `build/lib/stylelint/vscode-known-variables.json` 的 `colors` 数组（含 `--vscode-icon-*` 等派生/图标变量） |

**主题 JSON 相对这两个口径的覆盖率**：

| 文件 | 直接键 | vs 849 全量 | vs 477 外壳子集 |
|---|---|---|---|
| `2026-light.json` | 339 | — | 253 / 477 (**53%**) |
| `2026-dark.json` | 325 | 285 / 849 (34%) | 244 / 477 (**51%**) |
| `light_modern.json` | 161 | 153 / 849 (18%) | 128 / 477 (27%) |
| `dark_modern.json` | 152 | 142 / 849 (17%) | 123 / 477 (**26%**) |
| `monokai-color-theme.json` | 103 | — | 65 / 477 (14%) |
| `dark_plus.json` | 43 | 37 / 849 (4%) | 38 / 477 (**8%**) |

**主题 JSON 是「覆盖层」，不是「完整调色板」。** 例：`dark_modern.json` 里 `list.activeSelectionBackground`、`scrollbarSlider.background`、`diffEditor.insertedTextBackground`、`textLink.foreground`、`terminal.background` 全部**缺席**，其值由注册表默认值经派生变换（`transparent()` / `lighten()` / `darken()` / `oneOf()`）算出。**即便最完整的 `2026-*` 也缺将近一半**。

VS Code 官方解法在 `src/vs/workbench/services/themes/browser/colorThemeCss.ts`（72 行，`generateColorThemeCSS`）：

```ts
// Color CSS variables
for (const item of getColorRegistry().getColors()) {
	const color = theme.getColor(item.id, true);   // ← true = 缺失时回退注册表默认值
	if (color) { variables.push(`${asCssVariableName(item.id)}: ${color.toString()};`); }
}
// Size CSS variables
for (const item of getSizeRegistry().getSizes()) {
	const sizeValue = getSizeRegistry().resolveDefaultSize(item.id, theme);
	if (sizeValue) { variables.push(`${asSizeCssVariableName(item.id)}: ${sizeValueToCss(sizeValue)};`); }
}
ruleCollector.addRule(`${scopeSelector} { ${variables.join('\n')} }`);
```

CSS 变量命名规则（`src/vs/platform/theme/common/colorUtils.ts:35`，`sizeUtils.ts:50`）：

```ts
export function asCssVariableName(colorIdent: ColorIdentifier): string {
	return `--vscode-${colorIdent.replace(/\./g, '-')}`;
}
```
即 `sideBar.background` → `--vscode-sideBar-background`；`spacing.size80` → `--vscode-spacing-size80`。

**完整变量规模**：986 colors + 54 sizes = **1,040 个 CSS 变量/主题**，未压缩约 **50 KB/主题**（gzip 后约 6–8 KB）。双主题约 100 KB 静态 CSS，可接受；也可只导出 Piggy 实际用到的子集（§2.5 表格约 48 个）。

### 2.4 消费方案（构建期管线）

```
themes/*.json (JSONC)
   │ ① JSONC 解析（去注释 + 去尾随逗号，或 json5 / ts.parseConfigFileTextToJson）
   ▼
   │ ② 解析 include 链并深合并（colors 覆盖；tokenColors 追加；semanticTokenColors 合并）
   ▼
   │ ③ 叠加注册表默认值（dark / light / hcDark / hcLight）+ 执行派生变换
   ▼
resolved-theme.json（外壳子集 477 键 / 全量 849 键，严格 JSON）
   ├─▶ ④ CSS 变量表  --vscode-*      → Piggy 应用皮肤（--pg-* 映射层）
   ├─▶ ⑤ Monaco defineTheme({ colors, rules })   ← §3.4
   ├─▶ ⑥ Shiki theme（tokenColors 直接可用）
   └─▶ ⑦ antd v6 ConfigProvider token（数值映射，04 §6）
```

**步骤 ③ 是 10 遗漏的关键环节**，且是唯一有实现量的部分。三条路径：

| 路径 | 做法 | 工作量 | 评价 |
|---|---|---|---|
| **③-a 官方导出（推荐）** | 仓库内已有导出钩子：`src/vs/workbench/contrib/themes/test/node/colorRegistryExport.test.ts`（23 行），设环境变量 `VSCODE_COLOR_REGISTRY_EXPORT=1` 跑该测试即打印 `#colors:[...]`。它 dump 的是 `themingRegistry.getColors()`——**全量 849 个 id**，含 description 与四套默认值（`Color` 经 `Color.Format.CSS.formatHexA` 序列化） | **0.5–1 人日**（需一次性 `npm install` + 编译 vscode） | 数据 100% 权威、覆盖最全，可随 VS Code 升级重新生成。**唯一的代价是要装一次 node_modules 并编译** |
| **③-b 手工抄默认值** | 从 `src/vs/platform/theme/common/colors/*.ts`（9 文件）+ `src/vs/workbench/common/theme.ts` + `src/vs/sessions/common/theme.ts` 里抽 **477 条** `registerColor(id, {dark,light,hcDark,hcLight})`，再实现 `transparent/lighten/darken/oneOf` 四个变换（`colorUtils.ts:319-350`，语义约 40 行） | 1–1.5 人日 | 无需装 vscode，纯文本正则可抽。**覆盖 Piggy 布局所需的全部 chrome 色**；建议与 ③-a 交叉校验 |
| **③-c 只取已解析键** | 只用 `2026-dark.json`（解析后 325 键）当完整表，缺失键回落硬编码 | 0.5 人日 | 覆盖率 51%+，剩余键必须硬编码兜底——**不推荐**，深浅色易死色 |

**建议 ③-b 落地 + ③-a 定期校验**：把抽取脚本放 `packages/pi-protocol/scripts/`（或 `apps/desktop/scripts/`），产物 `tokens.generated.json` 入库，CI 里比对 VS Code 版本号，升级时重跑。

### 2.5 约 48 个最重要的 workbench 颜色键（面向「聊天会话即编辑器」布局）

覆盖 Piggy 的五个区域：左栏（会话列表）/ 中区（会话 tab + 消息流）/ 右栏（变更、文件）/ 底部面板（终端）/ 状态栏。`Dark Modern` 列为空者标 *derived* ——**这些正是必须靠 §2.3 步骤 ③ 补齐的键**。

| color id | CSS 变量 | Dark Modern | 2026 Dark | 声明处 |
|---|---|---|---|---|
| **根 / 全局** | | | | |
| `foreground` | `--vscode-foreground` | `#CCCCCC` | `#bfbfbf` | `baseColors.ts` |
| `descriptionForeground` | `--vscode-descriptionForeground` | `#9D9D9D` | `#8C8C8C` | `baseColors.ts` |
| `errorForeground` | `--vscode-errorForeground` | `#F85149` | `#f48771` | `baseColors.ts` |
| `focusBorder` | `--vscode-focusBorder` | `#0078D4` | `#3994BCB3` | `baseColors.ts` |
| `icon.foreground` | `--vscode-icon-foreground` | `#CCCCCC` | `#8C8C8C` | `baseColors.ts` |
| `widget.border` | `--vscode-widget-border` | `#313131` | `#2A2B2C` | `editorColors.ts` |
| `progressBar.background` | `--vscode-progressBar-background` | `#0078D4` | `#878889` | `miscColors.ts` |
| **标题栏** | | | | |
| `titleBar.activeBackground` | `--vscode-titleBar-activeBackground` | `#181818` | `#191A1B` | `theme.ts` |
| `titleBar.activeForeground` | `--vscode-titleBar-activeForeground` | `#CCCCCC` | `#8C8C8C` | `theme.ts` |
| `titleBar.border` | `--vscode-titleBar-border` | `#2B2B2B` | `#2A2B2C` | `theme.ts` |
| **视图轨（Activity Bar）** | | | | |
| `activityBar.background` | `--vscode-activityBar-background` | `#181818` | `#191A1B` | `theme.ts` |
| `activityBar.foreground` | `--vscode-activityBar-foreground` | `#D7D7D7` | `#bfbfbf` | `theme.ts` |
| `activityBar.inactiveForeground` | `--vscode-activityBar-inactiveForeground` | `#868686` | `#8C8C8C` | `theme.ts` |
| `activityBar.border` | `--vscode-activityBar-border` | `#2B2B2B` | `#2A2B2C` | `theme.ts` |
| `activityBarBadge.background` | `--vscode-activityBarBadge-background` | `#0078D4` | `#307E9F` | `theme.ts` |
| `activityBarBadge.foreground` | `--vscode-activityBarBadge-foreground` | `#FFFFFF` | `#FFFFFF` | `theme.ts` |
| **主侧栏（会话列表）** | | | | |
| `sideBar.background` | `--vscode-sideBar-background` | `#181818` | `#191A1B` | `theme.ts` |
| `sideBar.foreground` | `--vscode-sideBar-foreground` | `#CCCCCC` | `#bfbfbf` | `theme.ts` |
| `sideBar.border` | `--vscode-sideBar-border` | `#2B2B2B` | `#2A2B2C` | `theme.ts` |
| `sideBarSectionHeader.background` | `--vscode-sideBarSectionHeader-background` | `#181818` | `#191A1B` | `theme.ts` |
| `sideBarSectionHeader.foreground` | `--vscode-sideBarSectionHeader-foreground` | `#CCCCCC` | `#bfbfbf` | `theme.ts` |
| `sideBarSectionHeader.border` | `--vscode-sideBarSectionHeader-border` | `#2B2B2B` | `#2A2B2C` | `theme.ts` |
| `sideBar.dropBackground` | `--vscode-sideBar-dropBackground` | *derived* | *derived* | `theme.ts` |
| **编辑区（会话 tab 容器）** | | | | |
| `editor.background` | `--vscode-editor-background` | `#1F1F1F` | `#121314` | `editorColors.ts` |
| `editor.foreground` | `--vscode-editor-foreground` | `#CCCCCC` | `#BBBEBF` | `editorColors.ts` |
| `editor.lineHighlightBackground` | `--vscode-editor-lineHighlightBackground` | *derived* | `#242526` | `editorColors.ts` |
| `editor.selectionBackground` | `--vscode-editor-selectionBackground` | *derived* | `#276782dd` | `editorColors.ts` |
| `editorGroup.border` | `--vscode-editorGroup-border` | `#FFFFFF17` | `#FFFFFF17` | `theme.ts` |
| `editorGroupHeader.tabsBackground` | `--vscode-editorGroupHeader-tabsBackground` | `#2B2B2B` | `#202122` | `theme.ts` |
| `editorGroupHeader.tabsBorder` | `--vscode-editorGroupHeader-tabsBorder` | `#2B2B2B` | `#2A2B2C` | `theme.ts` |
| **Tab（会话 tab）** | | | | |
| `tab.activeBackground` | `--vscode-tab-activeBackground` | `#1F1F1F` | `#121314` | `theme.ts` |
| `tab.activeForeground` | `--vscode-tab-activeForeground` | `#FFFFFF` | `#bfbfbf` | `theme.ts` |
| `tab.activeBorderTop` | `--vscode-tab-activeBorderTop` | `#0078D4` | `#3994BC` | `theme.ts` |
| `tab.inactiveBackground` | `--vscode-tab-inactiveBackground` | `#2B2B2B` | `#202122` | `theme.ts` |
| `tab.inactiveForeground` | `--vscode-tab-inactiveForeground` | `#9D9D9D` | `#8C8C8C` | `theme.ts` |
| `tab.border` | `--vscode-tab-border` | `#2B2B2B` | `#2A2B2C` | `theme.ts` |
| `tab.hoverBackground` | `--vscode-tab-hoverBackground` | `#1F1F1F` | `#121314` | `theme.ts` |
| `tab.unfocusedActiveBackground` | `--vscode-tab-unfocusedActiveBackground` | *derived* | `#121314` | `theme.ts` |
| **辅助侧栏 / 右栏** | | | | |
| `editorWidget.background` | `--vscode-editorWidget-background` | `#202020` | `#202122` | `editorColors.ts` |
| `editorWidget.foreground` | `--vscode-editorWidget-foreground` | *derived* | `#bfbfbf` | `editorColors.ts` |
| `editorWidget.border` | `--vscode-editorWidget-border` | *derived* | `#2A2B2C` | `editorColors.ts` |
| **底部面板** | | | | |
| `panel.background` | `--vscode-panel-background` | `#181818` | `#191A1B` | `theme.ts` |
| `panel.border` | `--vscode-panel-border` | `#2B2B2B` | `#2A2B2C` | `theme.ts` |
| `panelTitle.activeForeground` | `--vscode-panelTitle-activeForeground` | `#CCCCCC` | `#bfbfbf` | `theme.ts` |
| `panelTitle.inactiveForeground` | `--vscode-panelTitle-inactiveForeground` | `#9D9D9D` | `#8C8C8C` | `theme.ts` |
| `panelTitle.activeBorder` | `--vscode-panelTitle-activeBorder` | `#0078D4` | `#3994BC` | `theme.ts` |
| **状态栏** | | | | |
| `statusBar.background` | `--vscode-statusBar-background` | `#181818` | `#191A1B` | `theme.ts` |
| `statusBar.foreground` | `--vscode-statusBar-foreground` | `#CCCCCC` | `#8C8C8C` | `theme.ts` |
| `statusBar.border` | `--vscode-statusBar-border` | `#2B2B2B` | `#2A2B2C` | `theme.ts` |
| `statusBarItem.hoverBackground` | `--vscode-statusBarItem-hoverBackground` | `#F1F1F133` | `#323233` | `theme.ts` |
| `statusBarItem.errorBackground` | `--vscode-statusBarItem-errorBackground` | *derived* | *derived* | `theme.ts` |
| `statusBarItem.warningBackground` | `--vscode-statusBarItem-warningBackground` | *derived* | *derived* | `theme.ts` |

**次优先（列表/输入/菜单/滚动条/diff，聊天布局同样高频，共约 40 键）**：`list.activeSelectionBackground` · `list.activeSelectionForeground` · `list.inactiveSelectionBackground` · `list.hoverBackground` · `list.hoverForeground` · `list.focusOutline` · `list.highlightForeground` · `list.errorForeground` · `list.warningForeground` · `input.background` · `input.foreground` · `input.border` · `input.placeholderForeground` · `dropdown.background` · `dropdown.border` · `button.background` · `button.foreground` · `button.hoverBackground` · `button.secondaryBackground` · `button.secondaryForeground` · `badge.background` · `badge.foreground` · `menu.background` · `menu.foreground` · `menu.border` · `menu.selectionBackground` · `menu.separatorBackground` · `quickInput.background` · `quickInputList.focusBackground` · `textLink.foreground` · `textCodeBlock.background` · `textBlockQuote.background` · `textPreformat.foreground` · `scrollbarSlider.background` · `scrollbarSlider.hoverBackground` · `scrollbarSlider.activeBackground` · `diffEditor.insertedTextBackground` · `diffEditor.removedTextBackground` · `diffEditor.insertedLineBackground` · `diffEditor.removedLineBackground` · `gitDecoration.modifiedResourceForeground` · `gitDecoration.deletedResourceForeground` · `gitDecoration.untrackedResourceForeground` · `notifications.background` · `notifications.border` · `terminal.background` · `terminal.foreground`

**额外收获——VS Code 1.140 自带的「Agent Sessions」配色（Piggy 直接对口，共 29 个 id，`src/vs/sessions/common/theme.ts`）**：
`agents.background` · `agentsPanel.background` · `agentsPanel.foreground` · `agentsPanel.border` · `agentsCard.border` · `agentsBottomPanel.border` · `agentsGradient.tintColor` · `agentFeedbackEditorWidget.background` · `agentFeedbackEditorWidget.border` · `agentFeedbackInputWidget.border` · `agentsUpdateButton.downloadingBackground` · `agentsUpdateButton.downloadedBackground` · `agentsChatInput.background` · `agentsChatInput.foreground` · `agentsChatInput.border` · `agentsChatInput.focusBorder` · `agentsChatInput.placeholderForeground` · `agentsNewSessionButton.{background,foreground,border,hoverBackground}` · `agentsBadge.{background,foreground}` · `agentsUnreadBadge.{background,foreground}` · `activeSessionView.{background,foreground}` · `inactiveSessionView.{background,foreground}`

其中 `activeSessionView.*` / `inactiveSessionView.*` / `agentsUnreadBadge.*` 是**为「多会话并排 + 未读角标」量身定制的语义色**，与 10 §1 的会话 tab 心智完全一致——建议直接纳入 Piggy 的 `--pg-*` 语义层。

---

## 3. Monaco Editor

### 3.1 VS Code ↔ Monaco 的生成关系

```
src/vs/editor/**  +  src/vs/base/**  +  src/vs/platform/**
        │  build/gulpfile.editor.ts  (task: extract-editor-src → compile-editor-esm)
        ▼
out-editor-src/  →  out-monaco-editor-core/esm/**   ⇒  npm 包 monaco-editor-core
        │            （typings: ./esm/vs/editor/editor.api.d.ts, module: ./esm/vs/editor/editor.main.js）
        │  再叠加 basic-languages + json/css/html/ts 语言服务
        ▼
npm 包 monaco-editor  ⇒  Piggy 的依赖（0.56.0，MIT，unpacked 97.9 MB / 1909 files）
```

| 关键文件 | 体积 | 说明 |
|---|---|---|
| `src/vs/monaco.d.ts` | **274,467 B** | 公开 API 声明，**由 recipe 生成**（勿手改） |
| `build/monaco/monaco.d.ts.recipe` | 6,392 B | 生成 DSL：`#include(vs/...js): A, B` / `#includeAll(...)` / `//dtsv=3` |
| `build/monaco/monaco.usage.recipe` | 1,049 B | 追加 usage 片段 |
| `build/monaco/package.json` | 439 B | `name: monaco-editor-core`, `private: true`, `license: MIT` |
| `build/monaco/LICENSE` | 1,098 B | MIT |
| `build/monaco/ThirdPartyNotices.txt` | 3,038 B | core 的三方声明 |
| `build/gulpfile.editor.ts` | — | `editor-distro` 任务（`:215-225`）= rimraf → `extract-editor-src` → `compile-editor-esm` → `final-editor-resources`。`extract-editor-src`（`:38-70`）入口 3 个：`vs/editor/editor.main.ts`、`vs/editor/editor.worker.start.ts`、`vs/editor/common/services/editorWebWorkerMain.ts`；`shakeLevel: 2`（`:65`）；`importIgnorePattern: /\.css$/`（`:66`）。`final-editor-resources`（`:132-206`）把 `src/vs/monaco.d.ts` 同时放到包根与 `esm/vs/editor/editor.api.d.ts`（经 `toExternalDTS()` 去掉 `declare namespace monaco {` 外壳、`declare namespace monaco.x` → `export namespace x`、`declare var MonacoEnvironment` → `declare global { … }`），并把 `package.json` 的 `private` 改 `false`、按 `cgmanifest.json` 注入 `dependencies{marked, dompurify}`（`:156-180`） |
| `build/lib/monaco-api.ts` | — | 解析 recipe（`RECIPE_PATH :18`、`DECLARATION_PATH :19`）；`#include(module.js): A, B` / `#includeAll(module.js;from=>to)` 语义在 `:427-504`；`//dtsv=3` 版本闸在 `:513-520`；同时产出 `usageContent`（`:175-179`）供 tree-shaking 存活引用 |
| `build/lib/compilation.ts:234-251` | — | `gulp watch` 时按 recipe 增量重生成 `src/vs/monaco.d.ts` **与** `src/vs/editor/common/standalone/standaloneEnums.ts`；非 watch 模式下漂移会报 `monaco.d.ts is no longer up to date` |

> **结论 1**：`src/vs/monaco.d.ts`（274,467 B / **8,813 行**）是**只读产物**；Piggy 要的是 npm `monaco-editor`，不是这个仓库。10 §6「Monaco 一律走 npm 依赖」正确。
> **结论 2**：`build/monaco/` 只是 **`monaco-editor-core`** 的种子，**VS Code 仓库不产出 `monaco-editor`**——后者在独立的 `microsoft/monaco-editor` 仓库中由 core + basic-languages + json/css/html/ts 语言服务组装。因此 `monaco-editor` 的版本与本文的 commit **不同源**（`monaco-editor@0.56.0` 记录 `vscodeCommitId: f487add297079a02eb836810185b165e50cadabc` ≠ `b761e4ed…`）。**推论：主题/编辑器 API 存在轻微漂移**（实测 `IStandaloneThemeData` 的 `.d.ts` 文本仅差 2 行），引用行号时以本 checkout 为准，引用 npm 包时以包内 `.d.ts` 为准。
> npm 上 `monaco-editor@0.56.0`：`exports` = `{".":{"types":"./esm/vs/index.d.ts","import":"./esm/vs/index.js"},"./*.js":"./esm/vs/*.js","./*":"./esm/vs/*.js"}`，依赖仅 `marked@14.0.0` + `dompurify@3.4.8`；`monaco-editor-core@0.56.0` **没有 `exports` 字段**（故其深层导入不受影响）。

### 3.2 内置 standalone 主题

`src/vs/editor/standalone/common/themes.ts`（271 行 / 10,751 B）定义 4 套，**全部 `inherit: false`**：

| 导出 | `base` | 行号 | `rules` 数 | `colors` 键数 | `editorBackground` / `editorForeground` |
|---|---|---|---|---|---|
| `vs` | `'vs'` | `:11-78` | 46 | 6 | `#FFFFFE` / `#000000` |
| `vs_dark` | `'vs-dark'` | `:83-149` | 45 | 6 | `#1E1E1E` / `#D4D4D4` |
| `hc_black` | `'hc-black'` | `:155-210` | 36 | 4 | `#000000` / `#FFFFFF` |
| `hc_light` | `'hc-light'` | `:214-269` | 36 | 4 | `#FFFFFF` / `#292929` |

注册与默认值：`browser/standaloneThemeService.ts:247-251`（注册 4 套）、`:261`（默认 `setTheme('vs')`）。

```ts
export type BuiltinTheme = 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
export type IColors = { [colorId: string]: string };

export interface IStandaloneThemeData {
	base: BuiltinTheme;
	inherit: boolean;
	rules: ITokenThemeRule[];
	encodedTokensColors?: string[];
	colors: IColors;
}

export interface ITokenThemeRule {
	token: string;
	foreground?: string;
	background?: string;
	fontStyle?: string;
}
```
（`src/vs/editor/standalone/common/standaloneTheme.ts:13-22` + `src/vs/editor/common/languages/supports/tokenization.ts:10-15`；API 签名 `standaloneEditor.ts:404-410`；生成结果 `src/vs/monaco.d.ts:1182-1201`）

> ⚠️ **Monaco 默认主题与 workbench 主题是两套独立数据，且内置主题只有 4–6 个颜色键。**
> - `vs-dark` 的 `editor.background` = **`#1E1E1E`**，而 workbench `dark_modern.json` = **`#1F1F1F`**、`2026-dark` = **`#121314`** —— 三者互不相等。
> - `vs` 的背景是 **`#FFFFFE`**，而 workbench 浅色主题用 `#FFFFFF`（`colors/editorColors.ts:19-21`）。
> **不做桥接 → Piggy 的 Monaco 与外壳必然色差。** 这正是 10 §2.4「一份四吃」要解决的问题，但 10 未指出「Monaco 侧默认值本身就对不上」。
> 另注：内置主题的 `rules[].token` 用的是 **Monaco dot-path**（如 `string.key.json`、`keyword.flow.scss`、`predefined.sql`），**不是 TextMate scope**。

### 3.3 主题桥接：**仓库内不存在现成实现**（Piggy 必须自己写）

**关键发现：VS Code 从不调用 `monaco.editor.defineTheme`。** 全仓库唯一 `.defineTheme(` 调用点是 API 包装本身（`standaloneEditor.ts:409`）；`IStandaloneThemeData` 仅出现在 `standaloneTheme.ts`、`browser/standaloneThemeService.ts`、`standaloneEditor.ts`、`standalone/common/themes.ts` 与一个单测中。**即：不存在「workbench 主题 JSON → `IStandaloneThemeData`」的转换器可供抄袭。**
（附带勘误：`src/vs/editor/standalone/common/standaloneThemeService.ts` **不存在**；只有 `common/standaloneTheme.ts`（42 行，纯接口）与 `browser/standaloneThemeService.ts`（436 行，实现）。）

Monaco 侧真正的桥接在 `browser/standaloneThemeService.ts:130-161` 的 `tokenTheme`：

```ts
// :141-153  从 colors 里的 editor.foreground / editor.background 合成根规则
const editorForeground = this.themeData.colors['editor.foreground'];
const editorBackground = this.themeData.colors['editor.background'];
if (editorForeground || editorBackground) { const rule: ITokenThemeRule = { token: '' }; … rules.push(rule); }
rules = rules.concat(this.themeData.rules);                  // :154
if (this.themeData.encodedTokensColors) { … }                // :155-157
this._tokenTheme = TokenTheme.createFromRawTokenTheme(rules, encodedTokensColors);  // :158
```

要点：
- `colors` 里的 `editor.foreground` / `editor.background` 会**自动提升为 `token:''` 根规则**——所以只需在 `colors` 里给对这两个，就不必手工造根规则（`dark_plus.json` 正是靠这条把 Dark+ 的默认前景色带进 Monaco 的）。
- `getColor()` 缺失时回落 `colorRegistry.resolveDefaultColor()`（`:96-115`），`type` 由 `base` 决定：`vs→LIGHT`、`hc-black→HIGH_CONTRAST_DARK`、`hc-light→HIGH_CONTRAST_LIGHT`、默认 `DARK`（`:121-128`）。**因此 `base` 一项就已提供该明暗模式下全部编辑器默认色，`colors` 只需覆盖差异项。**
- `defineTheme` 有硬校验（`:311-331`）：主题名必须匹配 `/^[a-z0-9\-]+$/i`，否则 `throw new Error('Illegal theme name!')`；`base` 必须是内置主题之一（否则 `'Illegal theme base!'`）。
- ⚠️ **`semanticTokenColors` 在 Monaco 中完全无效**：standalone 主题硬编码上报 `semanticHighlighting = false`（`:186`），语义 token 样式走同一套 token 规则（`:163-176`）。**workbench 主题 JSON 的 `semanticTokenColors` 在 Monaco 侧是死数据**——Shiki / 自研高亮若想用，需另接。
- `colors` 与 `rules` 最终会被转成 CSS：每个注册色 → `--vscode-<id，点转横线>`，注入 `.monaco-editor, .monaco-diff-editor, .monaco-component`（`:382-417`）；token 色 → `.mtk<i>{color:…}` + `.mtki/.mtkb/.mtku/.mtks`（`generateTokensCSSForColorMap`，`tokenization.ts:413-425`）。**这与 §2.3 的 `--vscode-*` 变量体系同名——Monaco 内部也靠它，双重印证「Piggy 直接用 `--vscode-*` 命名」的正确性。**

workbench 侧读 JSON 的完整键集（`colorThemeData.ts:749-808`）：`include`（`:759-761`，递归）、`settings`（旧 tmTheme，`:762-765`）、`semanticHighlighting`（`:766`）、`colors`（`:767-781`，`'default'` 表示删除该键）、`tokenColors`（`:782-791`，数组或 tmTheme 路径）、`semanticTokenColors`（`:792-804`）。规则形状：

```ts
export interface ITextMateThemingRule {   // workbenchThemeService.ts:488
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}
export interface ITokenColorizationSetting {   // workbenchThemeService.ts:494
	foreground?: string; background?: string; fontStyle?: string;
	fontFamily?: string; fontSize?: number; lineHeight?: number;
}
```

**`tokenColors[]` → `rules[]` 的映射规则**（Piggy 需自己实现，约 30 行）：

| 源（TextMate 形态） | 目标（Monaco `ITokenThemeRule`） | 注意 |
|---|---|---|
| `scope`（string 或 string[]） | `token` | **数组需决策**：Monaco 的 `token` 是单串。可用空格连接，或**展开为多条规则**（更安全，语义等价） |
| `settings.foreground`（`#CCCCCC`） | `foreground`（`CCCCCC`） | **必须去掉 `#`**；Monaco 用无 `#` 的 6/8 位 hex |
| `settings.background` | `background` | ⚠️ schema 对该字段标了 `deprecationMessage: "Token background colors are currently not supported."`（`colorThemeSchema.ts:145-148`）→ **建议丢弃** |
| `settings.fontStyle` | `fontStyle` | `italic\|bold\|underline\|strikethrough` 空格分隔；schema 正则 `^(\s*\b(italic\|bold\|underline\|strikethrough))*\s*$`（`:152`） |
| `settings.fontFamily` / `fontSize` / `lineHeight` | — | Monaco 无对应字段，丢弃 |
| `semanticTokenColors` | — | Monaco 忽略（见上） |

> ⚠️ **TextMate scope → Monaco token 名是手工映射，vscode 与 monaco-editor 两侧都没有转换器。** 实践中 Monaco 的 tokenizer 能接受 TextMate 风格 scope 串（`parseTokenTheme`，`tokenization.ts:48-101`），内置主题却用 dot-path。**建议 Piggy 原样透传 `scope`（展开数组），并在冒烟测试里验证关键字/字符串/注释三类着色**，不要试图做语义翻译。

### 3.4 Piggy 的 Monaco 主题方案（补充 10 §2.4）

**单一事实来源 = §2.4 产出的 `resolved-theme.json`**，同时喂 CSS 变量与 Monaco：

```ts
// ⚠️ 导入路径按 §3.5 的 exports 规则书写（不要用 monaco-editor/esm/vs/...）
import * as monaco from 'monaco-editor/editor/editor.api';

// 一次注册，深浅色各一次；Piggy 的 ThemeService 切换时调用 setTheme
monaco.editor.defineTheme('piggy-dark', {
	base: 'vs-dark',        // 由 contribution 的 uiTheme 映射而来（见 E7）；提供未覆盖项的兜底
	inherit: false,         // ← 关键：不要继承 vs-dark 的 colors，否则与 --pg-* 打架
	colors: {
		// 直接把 workbench 颜色 id 原样传进去（Monaco 认得同一套 id；非 editor.* 键被静默忽略）
		'editor.background':            cssVar('--vscode-editor-background'),
		'editor.foreground':            cssVar('--vscode-editor-foreground'),
		'editor.lineHighlightBackground': cssVar('--vscode-editor-lineHighlightBackground'),
		'editor.selectionBackground':   cssVar('--vscode-editor-selectionBackground'),
		'editorWidget.background':      cssVar('--vscode-editorWidget-background'),
		'editorWidget.border':          cssVar('--vscode-editorWidget-border'),
		'scrollbarSlider.background':   cssVar('--vscode-scrollbarSlider-background'),
		'diffEditor.insertedTextBackground': cssVar('--vscode-diffEditor-insertedTextBackground'),
		'diffEditor.removedTextBackground':  cssVar('--vscode-diffEditor-removedTextBackground'),
		// …按需扩展
	},
	rules: toMonacoRules(resolvedTokenColors)   // 见 §3.3 的映射表
});
```

要点：
1. **主题名只能是 `[a-z0-9-]`**（`'piggy-dark'` 合法；`'Piggy Dark'` 会抛 `Illegal theme name!`）。
2. **`colors` 的键与 workbench 颜色 id 完全相同**——同一份映射表双向复用，无需第二套命名。
3. **`editor.*` 之外的 workbench 专属键（`sideBar.*`、`statusBar.*` 等）Monaco 会静默忽略**，因此「把整张表都塞进去」是安全的、可省一层过滤。
4. `inherit: false` 是避免与外壳色差的关键；`base` 仍建议由 `uiTheme` 映射（`vs-dark`/`vs`/`hc-black`/`hc-light`），以保留 Monaco 内置的 diff 装饰、suggest widget 等未显式覆盖项的合理兜底。
5. **`encodedTokensColors` 不要手写**——由 Monaco 在 `defineTheme` 时按 `rules` 自动分配（`ColorMap` 惰性分配 id，`tokenization.ts:187-189, 213-215`）。
6. Piggy 的 CSS 变量若用 `--pg-*`，需要一层 `--vscode-*` → `--pg-*` 映射。**强烈建议直接用 VS Code 命名**（`--vscode-sideBar-background`）：省掉整层翻译、与 Monaco 内部变量同名（§3.3）、且未来可直接吃第三方 VS Code 主题。
7. **Shiki 复用同一份 `tokenColors`**（10 §2.4 的「一份四吃」成立），且 Shiki 反而是**唯一能用上 `semanticTokenColors`** 的消费方（Monaco 用不了，见 §3.3）。注意 Shiki 需要严格 JSON（§2.2 的 JSONC 问题）。

### 3.5 【发版阻断】`monaco-editor@0.56.0` 的 `exports` 字段与 Vite 打包

**这是 10 §2.2 需要立即修订的地方。** `monaco-editor` 在 0.55.0 引入、0.56.0 收紧了 `exports`：

| 版本 | `exports` | 深层导入 `monaco-editor/esm/vs/...` |
|---|---|---|
| 0.52.2 · 0.54.0 | 无 | ✅ 可用 |
| 0.55.0 | `{".":{…},"./*":"./*"}` | ✅ 可用 |
| **0.56.0** | `{".":{"types":"./esm/vs/index.d.ts","import":"./esm/vs/index.js","require":"./min/vs/index.js"},"./*.js":"./esm/vs/*.js","./*":"./esm/vs/*.js"}` | ❌ **失效** |

失效机理：`"./*": "./esm/vs/*.js"` 会把 `monaco-editor/esm/vs/editor/editor.api` 重写为 `monaco-editor/esm/vs/esm/vs/editor/editor.api.js`（路径里 `esm/vs` 出现两次，**文件不存在**）。实测：
- `import.meta.resolve('monaco-editor/esm/vs/editor/editor.api')` → `…/esm/vs/esm/vs/editor/editor.api.js`（不存在）；
- `vite@7.3.6 build` 直接失败：`Rollup failed to resolve import "monaco-editor/esm/vs/editor/editor.worker?worker"`。

**可用写法**（Vite 7.3.6 + monaco-editor 0.56.0 实测 `vite build` exit 0）：

```ts
import * as monaco from 'monaco-editor';                              // → esm/vs/index.js（注册全部语言，较重）
import editorWorker from 'monaco-editor/editor/editor.worker?worker';
import jsonWorker   from 'monaco-editor/language/json/json.worker?worker';

self.MonacoEnvironment = {
	getWorker: (_id, label) => label === 'json' ? new jsonWorker() : new editorWorker()
};
```

**瘦身写法**（10 §2.2「禁止全语言打包，≤10 门」的目标仍可达成）：

```ts
import * as monaco from 'monaco-editor/editor/editor.api';   // 无语言注册
// 再按需 import 'monaco-editor/language/json/…' 等；或 import 'monaco-editor/basic-languages/...'
```
`esm/vs/index.js`（根导出）会注册**所有**语言并拉入 `esm/external/monaco-lsp-client/`，与 10 §2.2 的按需目标冲突——**故必须走 `monaco-editor/editor/editor.api` 而非根导入**。

其他实证事实：
- 随包发布的 worker 文件：`esm/vs/editor/editor.worker.js`、`esm/vs/language/{json,css,html,typescript}/*.worker.js`。注意 `monaco-editor-core` **不含** `editor.worker.js`——worker 入口是 `esm/vs/editor/common/services/editorWebWorkerMain.js`（= `bootstrapWebWorker(() => new EditorWorker(null))`），与 `gulpfile.editor.ts:54` 一致。
- 安装体积：`monaco-editor@0.56.0` 共 1,909 文件 / 解包 97.9 MB（`esm/` 31 MB、`min/` 24 MB、`dev/` 43 MB）——**打包时必须只引 `esm`**，并靠 Vite tree-shaking + 动态 import 达到 10 §2.3 的「异步 chunk ≤ 2 MB gzip」。
- **VS Code 自带的 Vite 配置不能作为 Monaco 打包参考**：`build/vite/vite.config.ts` 是 workbench 源码构建 harness（`base:'./'` `:164`、`root:'../..'` `:188`、入口 `workbench-vite.html` `:191-196`、`server.port 5199` `:200`），`build/vite/package.json` 用的是 `vite: npm:rolldown-vite@latest`，`build/vite/index.ts:6-21` 直接 import `../../src/vs/editor/editor.main`。仅可参考其 `server.fs.allow` 注释（`:202-205`：「not needed when loading monaco-editor from npm package」）。
- ⚠️ `monaco-editor` 官方文档（`docs/integrate-esm.md`）与其 Vite+React 示例（`samples/browser-esm-vite-react/src/userWorker.ts`，`devDependencies.monaco-editor` 仍为 `^0.32.0`）记录的是**旧版** `monaco-editor/esm/vs/...?worker` 路径，**对 0.56.0 已失效**——勿照抄。

---

## 4. Workbench CSS / 设计语言

### 4.1 【10 遗漏】机器可读的设计 token 注册表

**这是本次核验发现的最有价值资产。** VS Code 1.140 已把「间距 / 字号 / 字重 / 圆角 / 描边」抽成带默认值的注册表，并自动导出为 CSS 变量。

| 文件 | 体积 | 内容 |
|---|---|---|
| `src/vs/platform/theme/common/sizeUtils.ts` | 8,881 B | `registerSize()` / `getSizeRegistry()` / `asCssVariableName()` / `sizeValueToCss()`；`SizeUnit = 'px'\|'rem'\|'em'\|'%'\|''` |
| `src/vs/platform/theme/common/sizeRegistry.ts` | 465 B | 汇总出口 |
| `src/vs/platform/theme/common/sizes/baseSizes.ts` | **7,570 B / 180 行** | **全部 token 的数值定义** |
| `src/vs/sessions/common/sizes.ts` | 3 KB / 113 行 | `agents.*` 旧 token → 新规范 token 的弃用映射（示范迁移策略） |
| `src/vs/platform/theme/test/common/sizeRegistry.test.ts` | — | 命名规则单测：`asCssVariableName('font.size.large') === '--vscode-font-size-large'` |

```ts
export function asCssVariableName(sizeIdent: SizeIdentifier): string {
	return `--vscode-${sizeIdent.replace(/\./g, '-')}`;
}
export function sizeForAllThemes(value: number, unit: SizeUnit): SizeDefaults { /* light=dark=hcDark=hcLight */ }
export function registerSize(id: string, defaults: SizeDefaults | SizeValue | null,
                             description: string, deprecationMessage?: string): SizeIdentifier;
```

### 4.2 完整 token 表（`baseSizes.ts` 逐条，可直接抄成 Piggy 的 `tokens.css`）

| Token id | CSS 变量 | 值 | 用途 |
|---|---|---|---|
| **字号 ramp** | | | |
| `fontSize.heading1` | `--vscode-fontSize-heading1` | 26px | 最大标题 |
| `fontSize.heading2` | `--vscode-fontSize-heading2` | 18px | 标题 |
| `fontSize.heading3` | `--vscode-fontSize-heading3` | 13px | 副标题 |
| `fontSize.body1` | `--vscode-fontSize-body1` | **13px** | 主正文（会话消息默认） |
| `fontSize.body2` | `--vscode-fontSize-body2` | 11px | 次正文 |
| `fontSize.label1` | `--vscode-fontSize-label1` | 12px | 段标题 / tab |
| `fontSize.label2` | `--vscode-fontSize-label2` | 11px | 元数据 |
| `fontSize.label3` | `--vscode-fontSize-label3` | 10px | 角标 |
| `bodyFontSize`(弃用) | `--vscode-bodyFontSize` | 13px | → `fontSize.body1` |
| `bodyFontSize.small`(弃用) | `--vscode-bodyFontSize-small` | 12px | → `fontSize.label1` |
| `bodyFontSize.xSmall`(弃用) | `--vscode-bodyFontSize-xSmall` | 11px | → `fontSize.body2` |
| **字重** | | | |
| `fontWeight.regular` | `--vscode-fontWeight-regular` | 400 | 正文 / 标签 |
| `fontWeight.semiBold` | `--vscode-fontWeight-semiBold` | 600 | 标题 / 强调（**没有 bold 700 档**） |
| **图标字号** | | | |
| `codiconFontSize` | `--vscode-codiconFontSize` | 16px | codicon 基准 |
| `codiconFontSize.compact` | `--vscode-codiconFontSize-compact` | 12px | codicon 紧凑 |
| **圆角** | | | |
| `cornerRadius.xSmall` | `--vscode-cornerRadius-xSmall` | 2px | 极紧凑 |
| `cornerRadius.small` | `--vscode-cornerRadius-small` | 4px | 紧凑 |
| `cornerRadius.medium` | `--vscode-cornerRadius-medium` | **6px** | 基准 |
| `cornerRadius.large` | `--vscode-cornerRadius-large` | 8px | 强调 |
| `cornerRadius.xLarge` | `--vscode-cornerRadius-xLarge` | 12px | 强强调 |
| `cornerRadius.circle` | `--vscode-cornerRadius-circle` | 9999px | 全圆（pill） |
| **描边** | | | |
| `strokeThickness` | `--vscode-strokeThickness` | 1px | 边框 / 描边基准 |
| **间距 ramp**（数值 = 十分之一 px） | | | |
| `spacing.sizeNone` | `--vscode-spacing-sizeNone` | 0 | — |
| `spacing.size20` | `--vscode-spacing-size20` | 2px | ramp 起点 |
| `spacing.size40` | `--vscode-spacing-size40` | 4px | |
| `spacing.size60` | `--vscode-spacing-size60` | 6px | |
| `spacing.size80` | `--vscode-spacing-size80` | 8px | |
| `spacing.size100` | `--vscode-spacing-size100` | 10px | |
| `spacing.size120` | `--vscode-spacing-size120` | 12px | |
| `spacing.size160` | `--vscode-spacing-size160` | 16px | |
| `spacing.size200` | `--vscode-spacing-size200` | 20px | |
| `spacing.size240` | `--vscode-spacing-size240` | 24px | |
| `spacing.size280` | `--vscode-spacing-size280` | 28px | |
| `spacing.size320` | `--vscode-spacing-size320` | 32px | 会话内容水平内边距（`sessionView.css:17`） |
| `spacing.size360` | `--vscode-spacing-size360` | 36px | |
| `spacing.size400` | `--vscode-spacing-size400` | 40px | ramp 终点 |

**布局常量**（`src/vs/sessions/common/layoutConstants.ts`，仅 2 行）：`AGENTS_FLOATING_PANEL_GAP = 4`、`AGENTS_CENTERED_CONTENT_MAX_WIDTH = 950`（已注册为 `agents.layout.floatingPanelGap` → `--vscode-agents-layout-floatingPanelGap`）。

### 4.3 【10 遗漏】全套变量清单与 lint 规则

| 文件 | 体积 | 内容 |
|---|---|---|
| `build/lib/stylelint/vscode-known-variables.json` | **55,136 B** | **`colors`: 986 个 `--vscode-*` 颜色变量名** · **`sizes`: 54 个尺寸变量名** · **`others`: 287 个其余变量**（其中 242 个非 `--vscode-` 前缀，45 个 `--vscode-` 前缀） |
| `build/lib/stylelint/validateDesignTokens.ts` | 20,095 B | 设计 token 校验：把硬编码 px 吸附到 ramp 并给出变量建议 |
| `build/lib/stylelint/validateVariableNames.ts` | 1,562 B | 校验 CSS 里每个 `var(--x)` 是否在 known-variables 白名单内 |
| `build/lib/stylelint/validateHasSelectors.ts` | 21,129 B | 选择器校验 |
| `build/stylelint.ts` | — | 驱动（`package.json:81` → `"stylelint": "node build/stylelint.ts"`） |

`validateDesignTokens.ts` 里藏着**权威 ramp 定义**（可直接复用为 Piggy 的 lint 规则）：

```ts
const SPACING_SCALE: readonly number[] = [2, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 36, 40];
const CORNER_RADIUS_TOKENS = [ {px:2,name:'xSmall'}, {px:4,name:'small'}, {px:6,name:'medium'},
                               {px:8,name:'large'}, {px:12,name:'xLarge'} ];  // + circle(9999, ≥100px 阈值)
const FONT_SIZE_RAMP = new Map([[26,'heading1'],[18,'heading2'],[13,'body1 | heading3'],
                                [12,'label1'],[11,'body2 | label2'],[10,'label3']]);
const FONT_WEIGHT_TOKENS = [ {weight:400,name:'regular'}, {weight:600,name:'semiBold'} ];
const ALLOWED_CODICON_PX = new Set([16, 12]);   // 13/14/15px 一律判为「应为 12 或 16」的近失
```

规则语义（`validateDesignTokens.ts`）：
- **间距**：`padding`/`margin`/`gap`/`row-gap`/`column-gap` 的 px 必须落在 `SPACING_SCALE`，否则吸附到最近档（平局向上取整）并提示 `var(--vscode-spacing-size{px*10})`；`0` → `sizeNone`。
- **圆角**：`border-radius` 首个 px 吸附到五档；`≥100px` 视为 `circle`；`0`/`50%`/`inherit`/`var()`/`calc()` 不动。
- **字号**：`font-size` 的 px **恰好命中** ramp 值时才提示（14/16px 合法，不报）；codicon 选择器跳过。
- **字重**：`normal`→400、`bold`→700；数值吸附到 400/600（500 平局取 600）。
- **描边**：`border`/`border-*-width`/`outline` 的 `1px` 提示改用 `var(--vscode-strokeThickness)`。
- **弃用映射表**（第 495-507 行）：`--vscode-agents-fontSize-*` → `--vscode-fontSize-*`；`--vscode-bodyFontSize*` → 新 ramp。

### 4.4 组件级布局 token（`others` 类，242 个非 `--vscode-` 变量）

这些**不在注册表内**，是各组件 CSS 里自定义的局部 token，但命名与数值极具参考价值。样例（按类别）：

| 类别 | 变量 |
|---|---|
| 视图轨 / 侧栏 | `--activity-bar-width` · `--activity-bar-icon-size` · `--activity-bar-action-height` · `--activity-bar-action-gap` |
| 会话视图 | `--session-view-background` · `--session-view-foreground` · `--session-view-centered-content-max-width` · `--session-view-content-horizontal-padding` · `--session-chat-base-height` · `--agent-sessions-editor-tab-padding` |
| 聊天输入 | `--chat-input-own-radius` · `--chat-input-notice-radius` · `--chat-input-notification-line-height` · `--chat-input-notice-severity` |
| 轨迹 / 时间线 | `--prompt-timeline-rail-width` · `--prompt-timeline-content-gap` · `--prompt-timeline-gutter-dot-size` · `--prompt-timeline-gutter-dot-gap` · `--prompt-timeline-bottom` |
| 语法高亮（移动端 diff） | `--mobile-diff-tok-comment` · `--mobile-diff-tok-string` · `--mobile-diff-tok-keyword` · `--mobile-diff-tok-number` |

定义方式（`src/vs/sessions/browser/parts/media/sessionView.css:14-18`）示范了「组件 token 引用注册表 token」的分层：

```css
/* Shared inset for the header content, transcript, and composer. */
.session-view {
	--session-view-content-horizontal-padding: var(--vscode-spacing-size320);
}
```

### 4.5 【概念级金矿】`src/vs/sessions/` —— VS Code 自己的 Agent 会话工作台

`src/vs/sessions/` 共 **15 MB**，是 1.140 新增的「Agents Window」——**与 Piggy 解决同一个问题**（会话即主体、编辑器降为附属）。这是 10 §6 参考点表里**缺失的一整块**。

| 文件 | 体积/行数 | 对 Piggy 的价值 |
|---|---|---|
| `src/vs/sessions/LAYOUT.md` | 136 行 | **工作台拓扑规范**：`Title bar → Content → { Sidebar, Main region → { Sessions Part \| Editor \| Auxiliary Bar \| Custom View Grid }, Panel }`；明确「**省略标准 Activity Bar、Status Bar、Banner**」「**Sessions Part 含自己的水平网格，其叶子不是编辑器组**」「最多一个高优先级 surface 可见」——直接对应 04 §1 的布局裁决 |
| `src/vs/sessions/LAYOUT_CONTROLLER.md` | 168 行 | 每会话的布局捕获/恢复规则、持久化与测试归属 |
| `src/vs/sessions/SINGLE_PANE_SCENARIOS.md` | 174 行 | 单栏（编辑器+右栏合成一个侧窗）与经典布局的转换目录 |
| `src/vs/sessions/SESSIONS.md` / `SESSIONS_LIST.md` | 239 / 122 行 | `ISessionsService` 契约：可见会话身份与顺序、活动会话、每会话活动 chat、恢复 |
| `src/vs/sessions/MOBILE.md` | 86 行 | 手机布局对 part 的替换与导航 |
| `src/vs/sessions/common/theme.ts` | 207 行 / 29 色 id | Agent 会话语义色（§2.5 末） |
| `src/vs/sessions/common/sizes.ts` | 113 行 | Agent token 弃用映射 |
| `src/vs/sessions/contrib/chat/browser/media/chatWidget.css` | 22,197 B | 聊天消息流样式参考 |
| `src/vs/sessions/contrib/chat/browser/media/chatInput.css` | 22,689 B | Composer 样式参考（对应 04 §5、11 的 Composer 细节） |
| `src/vs/sessions/contrib/chat/browser/media/chatView.css` | 18,258 B | 会话视图容器 |
| `src/vs/sessions/contrib/sessions/browser/media/sessionsList.css` | 31,813 B | **会话列表**（左栏核心） |
| `src/vs/sessions/browser/parts/media/chatCompositeBar.css` | 20,161 B | 会话 tab 条 |
| `src/vs/sessions/contrib/changes/browser/media/changesView.css` | 10,434 B | 右栏「变更」视图（diff 卡片） |
| `src/vs/sessions/browser/media/workbench.css` | 16,394 B | 会话工作台外壳 |
| `src/vs/sessions/browser/parts/mobile/mobileChatShell.css` | 33,807 B | 移动端聊天外壳 |

**用法：`reference-only`（只读参考，抄设计不抄代码）**——这些 CSS 深度依赖 workbench 的 DOM 结构与 `--vscode-*` 变量体系，直接移植会连带整棵依赖树。但它们**逐条回答了 04/11 正在裁决的问题**：会话列表项的信息层级、tab 条与未读角标、右栏变更视图的分组、Composer 的 pill 构成、轨迹时间线的 gutter 尺寸。**强烈建议作为 04 §1 与 11 的补充阅读材料**（尤其 `LAYOUT.md` 的拓扑表与 `SINGLE_PANE_SCENARIOS.md`）。

### 4.6 其他可抽取项

- **主题 CSS 生成器**：`src/vs/workbench/services/themes/browser/colorThemeCss.ts`（72 行，纯函数 `generateColorThemeCSS(theme, scopeSelector, participants?, env?)` → `CSSValue{code}`）。**这是 10 §2.4 那条「构建期脚本」的官方实现**，MIT，可直接移植其两个 for 循环（§2.3 已引）。
- **codicon 样式表注入**：`src/vs/platform/theme/browser/iconsStyleSheet.ts` + `iconRegistry.ts` 的 `getCodiconFontCharacters()` 用法。
- **workbench 基础 CSS**（参考用）：`src/vs/workbench/browser/media/style.css`（12,648 B）、`floatingPanels.css`（38,956 B）、`chatPills.css`（8,591 B）、`part.css`（2,290 B）。
- **编辑器 CSS**：`src/vs/editor/` 下 67 个 `.css`；最大的几个：`diffEditor/style.css`（15,379 B）、`suggest/media/suggest.css`（14,531 B）、`multiDiffEditor/style.css`（12,956 B）、`findWidget.css`（7,040 B）。
- **⚠️ 仓库内只有 3 个字体文件**（不含 `node_modules`）：`extensions/theme-seti/icons/seti.woff`（37,284 B）、`extensions/copilot/assets/copilot.woff`（1,632 B）、`extensions/vscode-colorize-tests/producticons/ElegantIcons.woff`（63,664 B，**测试夹具，勿用**）。**workbench 本身不内置 UI 字体**——字体族由系统/设置决定，Piggy 无需搬运字体（codicon 是唯一例外）。

---

## 5. 不可复用清单

### 5.1 许可边界（逐项核验）

| 资产 | 许可 | 依据 | Piggy 可用性 |
|---|---|---|---|
| VS Code 仓库整体 | **MIT** | `LICENSE.txt`（1,109 B / 21 行）：`Copyright (c) 2015 - present Microsoft Corporation`；**无商标 carve-out** | ✅ 可抄代码片段（带出处） |
| `theme-defaults`（Dark+ / Dark Modern / Light+ / Light Modern / 2026 Dark / 2026 Light / HC Black / HC Light） | **MIT（Microsoft 自研）** | `extensions/theme-defaults/package.json` → `"license": "MIT"`；**无 `cgmanifest.json`**；`ThirdPartyNotices.txt` **无对应条目** | ✅ vendor |
| `theme-monokai` · `-monokai-dimmed` · `-solarized-dark` · `-solarized-light` · `-abyss` · `-kimbie-dark` · `-quietlight` · `-red` · `-tomorrow-night-blue` | **MIT（第三方）** | `ThirdPartyNotices.txt:588`：`Colorsublime-Themes 0.1.0` / `https://github.com/Colorsublime/Colorsublime-Themes` / `Copyright (c) 2015 Colorsublime.com`；9 个 `cgmanifest.json`（各 309 B，abyss 为 452 B）均指向 `Colorsublime-Themes@c10fdd8b144486b7a4f3cb4e2251c66df222a825` | ✅ vendor **+ 署名 Colorsublime** |
| Seti 文件图标（`seti.woff` + `vs-seti-icon-theme.json`） | **MIT（第三方）** | `ThirdPartyNotices.txt:2257`：`seti-ui 0.1.0` / `Copyright (c) 2014 Jesse Weed`；`theme-seti/cgmanifest.json`（281 B）→ `seti-ui@2d6c5e68b4ded73c92dac291845ee44e1182d511`；`theme-seti/ThirdPartyNotices.txt`（1,794 B）与 `package.json` `"license":"MIT"` 一致 | ✅ vendor **+ 署名 Jesse Weed** |
| **Codicon 字体** | **CC-BY-4.0** | npm `@vscode/codicons` 的 `license` 字段；包内 `LICENSE`（19,242 B）；`ThirdPartyNotices.txt:2698` `MIT and Creative Commons Attribution 4.0` | ✅ vendor **+ 强制署名**（§1.4） |
| Codicon 的 CSS/TS 代码 | **MIT** | 包内 `LICENSE-CODE`（1,162 B）；`dist/codicon.css` 头部 `Licensed under the MIT License` | ✅ |
| `theme-modern-icons` | MIT | `package.json` `"license":"MIT"` | ✅（未在 `ThirdPartyNotices.txt` 单列） |
| **VS Code 商标 / 图标 / 产品名** | **不可用** | 仓库内**无商标声明**（`README.md` 无 Trademark 节，无 `TRADEMARK*` 文件）；权威来源为 <https://code.visualstudio.com/brand>：*"Visual Studio Code, VS Code, and the Visual Studio Code icon are trademarks of Microsoft Corporation. All rights reserved."* | ❌ **禁止** |

**无 copyleft 阻碍**。`ThirdPartyNotices.txt`（183,203 B / 3,439 行）中 `\bLGPL\b` 0 次、`\bAGPL\b` 0 次、`\bMPL\b` 0 次、`Copyleft` 0 次、`ShareAlike` 0 次、`NonCommercial` 0 次。唯一 `\bGPL\b` 命中（第 1089 行）是 **fish shell 的引用性说明**（block 1086-1092，非捆绑组件）；`grep -i MPL` 的 143 次命中**全部来自单词 "IMPLIED"**（假阳性）。许可标签分布：`50 MIT` · `11 TextMate Bundle License` · `3 MIT License` · `3 Apache-2.0` · `1 W3C` · `1 ISC` · `1 BSD` · `1 MIT and CC-BY-4.0`。

**MIT 的实务含义**：MIT 的条件是 *"included in all copies or **substantial portions** of the Software"*。
- **抄小段代码 + 出处**（键位数组、颜色映射、几个 helper）：文件头注释写明真实权利人 + `MIT` + 源文件链接即可。
- **vendor 整个目录**（`themes/*.json`、`seti.woff` + 映射）：逐文件注释不现实 → **在 Piggy 根放 `THIRD_PARTY_NOTICES.md`，逐字复制以下 4 块**：
  1. 仓库 MIT 块 — `Copyright (c) 2015 - present Microsoft Corporation`；
  2. `Colorsublime-Themes 0.1.0` MIT 块 — `Copyright (c) 2015 Colorsublime.com`（覆盖 9 个第三方主题）；
  3. `seti-ui 0.1.0` MIT 块 — `Copyright (c) 2014 Jesse Weed`；
  4. **CC-BY-4.0 署名块**（`codicon.ttf`：创作者 Microsoft Corporation + 版权声明 + 许可声明与免责声明 + 来源 URI + **是否修改**说明 + 许可链接）**+ MIT `LICENSE-CODE` 声明**（CSS/映射代码）。
- MIT 与 CC-BY 均为**宽松许可、非 copyleft**：不要求 Piggy 开源、不要求 Piggy 采用同许可、不产生 share-alike。

### 5.2 架构边界（看似可复用，实则不可）

| 资产 | 为什么不能搬 |
|---|---|
| **完整 workbench 源码**（`src/vs/workbench/**`，含 `workbench.common.main.ts` 的数百个 contribution） | 依赖整套 **DI/服务系统**（`createDecorator` + `Registry` + `IInstantiationService`）、layout grid、contextkey、命令/菜单/键位注册表、以及 **gulp + AMD/ESM 自定义打包链**。与 Vite + React 19 + Tauri 的技术栈正面冲突（10 §0 已否决 Theia/fork，理由成立） |
| **扩展宿主**（`src/vs/workbench/api/**`、`src/vs/workbench/services/extensions/**`） | 为**第三方扩展隔离**设计的进程分离 + RPC 协议；Piggy 是单一用途 cockpit，无此需求；引入即背上 `extensionHost` 进程与 `IExtensionService` 全部契约 |
| **Electron 专属层** | `src/vs/platform/*/electron-main/**`、`src/vs/workbench/electron-browser/**`、`themeMainService.ts` 等；Tauri 用不上 |
| **`vs/base/browser/ui/*` 原语**（`grid` / `sash` / `list` / `tree` / `splitview`） | 纯 TS class，各自依赖 `Disposable` store、`IListRenderer`、`IMouseEvent`/`IKeyboardEvent` 抽象与自己的 DOM helper——**复制一个要连带复制一张依赖网**。10 §0 选 dockview + react-resizable-panels 的决策正确 |
| **`product.json` 品牌标识** | `nameShort`/`nameLong` = `"Code - OSS"`、`applicationName` = `"code-oss"`、`win32DirName` = `"Microsoft Code OSS"`、`darwinBundleIdentifier` = `"com.visualstudio.code.oss"`、`win32RegValueName` = `CodeOSS` 及各类 `win32*AppId` GUID —— **标识的是 Microsoft 的发行版，勿抄** |
| **`resources/` 品牌图** | `resources/darwin/code.icns`（189,124 B）、`resources/win32/code.ico`（90,909 B）、`resources/linux/code.png`（2,721 B）、`resources/server/favicon.ico`（34,494 B）、`server/code-192.png` / `code-512.png`（各 2,721 B）及整套 per-language `.icns`/`.ico` —— **全部 Microsoft 品牌资产，禁止复用**（§5.1 商标）。Piggy 需自备图标；命名上不得暗示 Microsoft 背书（官方认可形式为 *"[My Product] for Visual Studio Code"*，而非 *"Visual Studio Code [My Product]"*） |
| **`extensions/*` 里其他扩展的 JS 实现** | 各扩展通常有独立 `LICENSE.txt` 与 `ThirdPartyNotices.txt`（如 `extensions/copilot/LICENSE.txt`、`extensions/mermaid-markdown-features/ThirdPartyNotices.txt` 含 MPL-2.0 块）——**逐个核验成本高，且大多与 Piggy 无关**。需要具体能力时按功能单点评估，勿整目录搬运 |

---

## 6. 可执行抽取脚本（一次性）

```bash
# 0) 前置：浅克隆（10 §6 建议放参考目录，不入 Piggy 仓库）
git clone --depth 1 https://github.com/microsoft/vscode ~/Documents/Project/reference/vscode

# 1) Codicons（字体 + 码点 + CSS）—— npm 路径最省事，且版本可与 VS Code pin 对齐
npm pack @vscode/codicons@0.0.46-40 && tar -xzf vscode-codicons-0.0.46-40.tgz
# → package/dist/codicon.ttf(153228) · codicon.css(39730) · codicon.csv(14202) · LICENSE(CC-BY-4.0) · LICENSE-CODE(MIT)
# 或从源码树取码点表（与 npm 逐字节相同）：
#   src/vs/base/common/codiconsLibrary.ts        762 条 register('id', 0xXXXX)
#   src/vs/base/common/codiconsUtil.ts           getCodiconFontCharacters()

# 2) 主题：拷贝 + include 解析 + JSONC → 严格 JSON
cp extensions/theme-defaults/themes/*.json            <piggy>/assets/themes/
cp extensions/theme-{monokai,monokai-dimmed,solarized-dark,solarized-light,abyss,kimbie-dark,quietlight,red,tomorrow-night-blue}/themes/*.json <piggy>/assets/themes/
#   ⚠️ 必须同时保留各扩展 package.json 的 contributes.themes（id/label/uiTheme/path）——
#      uiTheme 是深浅色唯一判据，也是映射到 Monaco `base` 的依据（见 §2.1 与 E7）
node -e "for(const d of ['theme-defaults','theme-monokai','theme-solarized-dark',/*…*/]){const p=require('./extensions/'+d+'/package.json');console.log(JSON.stringify(p.contributes.themes))}"
#   JSONC 解析：json5 / ts.parseConfigFileTextToJson / 自写去注释+去尾随逗号（约 20 行）
#   实测：19 个颜色主题 JSON 中 17 个是 JSONC（仅 hc_black/hc_light 是严格 JSON）
#   include 链：2026-dark → dark_modern → dark_plus → dark_vs

# 3) 颜色注册表全量导出（含四套默认值 + description）—— 需先 npm install + 编译
VSCODE_COLOR_REGISTRY_EXPORT=1 ./scripts/test.sh --run src/vs/workbench/contrib/themes/test/node/colorRegistryExport.test.ts
#   输出形如  #colors:[{"id":"...","description":"...","defaults":{...}}]

# 4) 设计 token（无需编译，纯文本可读）
cat src/vs/platform/theme/common/sizes/baseSizes.ts        # 全部 token 数值
grep -n 'SPACING_SCALE\|CORNER_RADIUS_TOKENS\|FONT_SIZE_RAMP\|FONT_WEIGHT_TOKENS\|ALLOWED_CODICON_PX' \
     build/lib/stylelint/validateDesignTokens.ts           # 权威 ramp 定义
cp build/lib/stylelint/vscode-known-variables.json  <piggy>/assets/vscode-known-variables.json   # 55136 B, 986+54+287

# 5) 文件图标（字体方案）
cp extensions/theme-seti/icons/seti.woff extensions/theme-seti/icons/vs-seti-icon-theme.json <piggy>/assets/file-icons/
```

---

## 7. 排序推荐表（资产 → 复用模式 → 工作量）

排序依据：**（单位工作量带来的形态收益）× （许可清晰度）× （升级维护成本）**。

| # | 资产 | 精确路径 | 复用模式 | 许可/署名 | 工作量 | 理由 |
|---|---|---|---|---|---|---|
| **1** | **设计 token ramp**（间距/字号/字重/圆角/描边） | `src/vs/platform/theme/common/sizes/baseSizes.ts`（7,570 B）+ `sizeUtils.ts`（8,881 B） | **copy-with-attribution**（≈150 行常量 + 6 行命名函数） | MIT · Microsoft | **0.5 人日** | 一次定死 Piggy 设计系统的数值骨架；`--vscode-*` 命名让后续主题资产即插即用。**回报/成本比最高** |
| **2** | **变量白名单 + lint 规则** | `build/lib/stylelint/vscode-known-variables.json`（55,136 B）+ `validateDesignTokens.ts`（20,095 B）+ `validateVariableNames.ts`（1,562 B） | **copy-with-attribution** | MIT · Microsoft | **0.5–1 人日** | 把 986 色 + 54 size 变成可校验契约；`validateDesignTokens` 的 5 条规则可直接改成 Piggy 的 stylelint 插件，杜绝硬编码 px（对应 05 的性能/一致性纪律） |
| **3** | **Codicon 字体 + 码点映射 + CSS** | npm `@vscode/codicons@0.0.46-40`：`dist/codicon.ttf`（153,228 B）+ `codicon.css`（39,730 B）+ `codicon.csv`（14,202 B）；源码映射 `src/vs/base/common/codiconsLibrary.ts`（37,536 B） | **vendor**（字体 + 生成 CSS） | **CC-BY-4.0 署名（强制）** + MIT（代码） | **0.5 人日** | 一次拿到 655 个代码语义图标；体积仅 153 KB 且本地零网络。**注意许可从 MIT 更正为 CC-BY-4.0**（E1） |
| **4** | **`theme-defaults` 主题**（Dark Modern / Light Modern / 2026 Dark / 2026 Light / HC ×2） | `extensions/theme-defaults/themes/*.json`（10 个，4,700–19,306 B） | **vendor** → 构建期转 `resolved-theme.json` | MIT（Microsoft 自研，无三方条目） | **1–1.5 人日**（含 JSONC + include + 默认值三层管线） | 深浅色 + 高对比全套；`2026-*` 解析后 325/339 键，覆盖率最高。**前提是先做 #5 的默认值层** |
| **5** | **颜色注册表默认值导出**（477 id × 4 主题，含派生变换） | 导出钩子 `src/vs/workbench/contrib/themes/test/node/colorRegistryExport.test.ts`（23 行）；默认值源 `src/vs/platform/theme/common/colors/*.ts`（9 文件）+ `src/vs/workbench/common/theme.ts`（66,522 B）+ `sessions/common/theme.ts`（10,752 B）；变换语义 `colorUtils.ts:319-350` | **copy-with-attribution**（抽成生成脚本 + 产物入库） | MIT · Microsoft | **1–1.5 人日** | **是 #4 的前置**。没有它，主题 JSON 只覆盖 26% 的键，外壳会出现死色（E4） |
| **6** | **主题 CSS 生成器**（颜色 + size → `--vscode-*`） | `src/vs/workbench/services/themes/browser/colorThemeCss.ts`（72 行） | **copy-with-attribution**（或按描述重写，逻辑仅两个 for 循环） | MIT · Microsoft | **1 人日** | 让「一份四吃」（CSS / Monaco / Shiki / antd）落到同一份 resolved 数据上（10 §2.4 的落地件） |
| **7** | **Agent 会话语义色（29 个 id）** | `src/vs/sessions/common/theme.ts`（207 行） | **copy-with-attribution** | MIT · Microsoft | **0.5 人日** | `activeSessionView.*` / `inactiveSessionView.*` / `agentsUnreadBadge.*` / `agentsChatInput.*` 与 Piggy 的会话模型 1:1 对应，省一轮设计 |
| **8** | **Seti 文件图标（字体方案）** | `extensions/theme-seti/icons/seti.woff`（37,284 B）+ `vs-seti-icon-theme.json`（54,732 B，383 defs / 238 ext / 101 name / 83 lang） | **vendor**（**整体**，非 SVG 子集） | MIT · `Copyright (c) 2014 Jesse Weed` | **0.5 人日** | 422 条文件关联开箱即用。**修正 E2：是 WOFF 不是 SVG，「取子集」不可行** |
| **9** | **第三方主题**（Monokai / Solarized ×2 / Abyss / Kimbie / Quiet Light / Red / Tomorrow Night Blue） | `extensions/theme-*/themes/*.json`（9 个，7,859–14,608 B） | **copy-with-attribution** | MIT · `Copyright (c) 2015 Colorsublime.com` | **0.5 人日**（管线复用 #4/#5） | 免费扩充主题库；边际成本极低。署名须写 Colorsublime（非 Microsoft） |
| **10** | **Monaco Editor** | npm `monaco-editor`（0.56.0，MIT）；生成链见 `build/gulpfile.editor.ts`、`build/monaco/*`、`src/vs/monaco.d.ts`（274,467 B / 8,813 行） | **依赖（不 vendor）** + 自建 `defineTheme` 桥 | MIT | **3–4 人日**（含 worker/懒加载/实例纪律，10 §2 已规划；**新增 exports 路径修正与自研主题桥**） | 10 的决策成立。**两项新增要求**：① 导入路径必须改为 `monaco-editor/editor/editor.api` 与 `monaco-editor/editor/editor.worker?worker`（10 §2.2 原写法在 0.56.0 已失效，见 E6/§3.5）；② 必须自研「resolved 主题 → `defineTheme({inherit:false})`」桥（仓库内无现成转换器，§3.3），否则与外壳有色差（§3.2） |
| **11** | **`sessions/` 布局规范与聊天 CSS** | `src/vs/sessions/LAYOUT.md`（136 行）· `LAYOUT_CONTROLLER.md`（168）· `SINGLE_PANE_SCENARIOS.md`（174）· `SESSIONS.md`（239）· `SESSIONS_LIST.md`（122）· `MOBILE.md`（86）；CSS：`chatInput.css` 22,689 B · `chatWidget.css` 22,197 B · `sessionsList.css` 31,813 B · `chatCompositeBar.css` 20,161 B · `changesView.css` 10,434 B | **reference-only** | MIT（参考无需署名） | **0 人日**（阅读成本 ≈ 0.5 人日） | **10 §6 遗漏的高价值参考**：VS Code 官方对「会话即主体、编辑器降级」的拓扑裁决，逐条对应 04 §1 / 11 待决问题 |
| **12** | **`vs/base` 原语实现语义**（grid / sash / contextkey / keybinding） | `src/vs/base/browser/ui/grid`、`.../sash`、`src/vs/platform/contextkey/common`、`src/vs/platform/keybinding/common` | **reference-only** | MIT | **0 人日**（10 §6 已列，路径复核存在） | 保持 10 的定位：只回答「为什么这么设计」，实现走 dockview / 自研 |
| **13** | **workbench 基础 CSS** | `src/vs/workbench/browser/media/style.css`（12,648 B）· `floatingPanels.css`（38,956 B）· `chatPills.css`（8,591 B）· `part.css`（2,290 B）；`src/vs/editor/**/*.css`（67 个） | **reference-only** | MIT | **0** | 依赖 workbench DOM 与变量体系，移植会连带整棵依赖树 |
| **14** | **完整 workbench 源码 / 扩展宿主 / DI / 构建链 / Electron 层** | `src/vs/workbench/**`、`src/vs/workbench/api/**`、`src/vs/platform/*/electron-main/**` | **❌ 不复用** | MIT 但架构不兼容 | — | DI + 服务 + 扩展宿主 + gulp/AMD 打包链与 Vite+React+Tauri 正面冲突（10 §0 否决 Theia/fork 的理由同样适用） |
| **15** | **VS Code 品牌资产**（图标 / 产品名 / `product.json` 标识） | `resources/darwin/code.icns`（189,124 B）· `resources/win32/code.ico`（90,909 B）· `resources/linux/code.png`（2,721 B）· `resources/server/favicon.ico`（34,494 B）· `product.json`（7,958 B） | **❌ 禁止复用** | 商标，非开源许可范围 | — | <https://code.visualstudio.com/brand>：*"Visual Studio Code, VS Code, and the Visual Studio Code icon are trademarks of Microsoft Corporation."* 仓库内**无**商标声明文件，勿据此推断可用 |
| **16** | `@vscode/webview-ui-toolkit` | — | **❌ 已弃用** | — | — | 10 §0 结论复核成立（官方 2024 deprecated） |

### 7.1 与 10 §5 依赖白名单的差异

- **`@vscode/codicons` 保留**，但需在 08 §3 白名单标注**许可例外（CC-BY-4.0，非 MIT）**，并要求 `THIRD_PARTY_NOTICES.md` 覆盖。
- **新增（非 npm，走构建期资产）**：`assets/themes/*.json`（resolved）、`assets/tokens.generated.json`、`assets/vscode-known-variables.json`、`assets/codicon.ttf` + `codicon.css`、`assets/file-icons/seti.woff` + `vs-seti-icon-theme.json`。这些**不进运行时依赖白名单**（不是代码），但进 05 的体积预算：**主题 CSS ≈ 50 KB/主题、codicon 153 KB、seti 92 KB、resolved JSON ≈ 20–40 KB/主题**。
- **建议新增一键生成脚本**：`scripts/sync-vscode-assets.mjs`（实现 §6），输入 `VSCODE_REF` 路径 + 版本号，产物入库并在 CI 比对版本，使 VS Code 升级成为可重复的机械动作（对应 10 §7 的演进策略）。
- **`monaco-editor` 版本策略需加一条硬性冒烟项**：`exports` 字段在 0.55.0 引入、0.56.0 收紧，**深层导入路径在 minor 升级中被破坏过**（E6）。10 §7「锁 minor 跟进（`~0.5x`）」不足以防住这类破坏——应改为**锁精确版本（`0.56.0`，无 `~`/`^`）+ 升级 PR 必跑「worker 解析 + 主题注册 + diff 渲染」三项冒烟**。
- **`theme-defaults` / `theme-*` 主题需要一并 vendor 其 `package.json` 的 `contributes.themes` 元数据**（`id`/`label`/`uiTheme`/`path`）：`uiTheme` 是深浅色的唯一判据（E7），丢了它就无法把主题映射到 Monaco 的 `base`。

---

## 8. 结论

1. **10 的方向全部正确**，但需修正 7 处事实（§0 E1–E7），其中 **E1（codicons 非 MIT）、E4（主题 JSON 只覆盖 26%）、E6（Monaco 0.56.0 深层导入失效）会影响发版合规、视觉正确性与构建可行性**，必须落文档。**E6 是唯一的发版阻断级问题。**
2. **最高性价比的复用不是 Monaco 也不是主题，而是设计 token 层**（推荐表 #1/#2）：约 1–2 人日换来 Piggy 全套间距/字号/圆角契约 + 可执行的 lint 规则，且顺带获得 `--vscode-*` 变量命名体系这一「未来免费吃第三方 VS Code 主题」的接口（Monaco 内部也用它，§3.3 双重印证）。
3. **主题复用是三层管线**（JSONC → include 解析 → 注册表默认值），不是「拷 JSON 就完事」；三层齐备后，10 §2.4 的「一份四吃」才真正成立。**且第四吃（Monaco）需要自研桥**——VS Code 从不调用 `defineTheme`，仓库内没有任何可抄的转换器（§3.3）。
4. **`src/vs/sessions/` 是本次最大的意外收获**：VS Code 1.140 官方已经用「会话即主体、编辑器降级、省略 Activity Bar/Status Bar」的拓扑实现了与 Piggy 同构的工作台。其 6 篇规范文档应纳入 04 / 11 的必读清单（reference-only，零许可负担）。
5. **许可上唯一需要注意的是 `codicon.ttf` 的 CC-BY-4.0 署名义务**；主题（Microsoft MIT + Colorsublime MIT）与 Seti（Jesse Weed MIT）均为宽松 MIT。**全部目标资产零 copyleft**。
6. **明确禁止**：`resources/` 品牌图、`product.json` 品牌标识、VS Code 产品名与图标（商标）。
7. **Monaco 侧的三条硬约束**（10 §2.2/§2.4 需据此改写）：① 导入走 `monaco-editor/editor/editor.api`（非 `…/esm/vs/…`，也非根导入——后者会注册全部语言）；② `defineTheme` 的主题名只能 `[a-z0-9-]`，`base` 必须由 `uiTheme` 映射（主题 JSON 的 `type` 字段无效）；③ `semanticTokenColors` 在 Monaco 中是死数据，只能喂 Shiki。
