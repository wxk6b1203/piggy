# 第三方资产与许可

Piggy 复用了若干上游资产。本文件记录来源、版本与许可义务；**新增可复用资产时必须在此登记**。

Piggy 自身的许可是 **GPL-3.0-or-later**（见 [LICENSE](LICENSE) 与 README「授权」一节）。
下列第三方许可（MIT / CC-BY-4.0）都与 GPLv3 兼容，但**署名与许可声明必须保留**——
这正是本文件存在的理由。

---

## pi（`@earendil-works/pi`，Piggy 驱动的编码代理）

- **用途**：Piggy 是 pi 的图形外壳——会话进程、RPC、扩展、会话文件格式全部由 pi 提供
- **来源**：<https://github.com/earendil-works/pi>
- **取用方式**：
  - **lite SKU**：不使用捆绑 pi，运行期用用户机器上装的 pi（不涉及再分发）；
  - **full SKU**：`apps/desktop/scripts/fetch-pi-standalone.mjs` 从 pi 的 GitHub Release
    下载对应平台的完整分发包，解包到 `src-tauri/resources/pi/`，由 `tauri.full.conf.json`
    的 `bundle.resources` **随安装包一起分发**（版本见该脚本的 `--version`，当前 1.4.0）。
- **许可**：MIT，`Copyright (c) 2025 Mario Zechner`

### 署名（MIT 履行）

pi 的许可全文以 `apps/desktop/src-tauri/resources/pi-LICENSE.txt` **随安装包分发**
（两个 SKU 的 `bundle.resources` 都已登记该文件）。该文件的第一段是 Piggy 自己加的说明，
**正文与上游 `LICENSE` 逐字节一致**（sha256 `0457f5bc…`；改上游版本时要同步重取）。

> 为什么不能指望 pi 的 release 资产里自带许可：`installAssets()` 只保证"二进制之外的
> 文件按原结构拷过来"，而 release 包里有没有 `LICENSE` 属于上游的打包细节、随时可能变。
> MIT 的义务在**分发方**（Piggy）身上，所以这份副本由 Piggy 自己携带。

`packages/piggy-bridge/` 是 Piggy 自己写的 pi 扩展（构建期引用 pi 的类型声明），不是上游代码。

---

## pi-todo（随包分发的 pi 插件）

- **用途**：DSH 风格的任务清单（`todo_write` / `todo_enable` 两个工具 + `/todos` 命令），
  随 Piggy 一起注入到 pi 会话里（`apps/desktop/src-tauri/resources/pi-plugins/pi-todo/`）
- **来源**：<https://github.com/wxk6b1203/pi-todo>（本仓作者的另一个项目）；
  收录方式与漂移检测见 `apps/desktop/scripts/vendor-plugin.mjs` 与插件目录里的 `vendor.json`
  （逐文件 sha256；CI 跑 `--check`）
- **许可**：MIT（上游 `package.json` 的 `license` 字段；收录时由脚本补一份 MIT 正文，
  见插件目录里的 `LICENSE`）。版权人：**wxk6b1203**
- **取用方式**：源码整目录收录（入口 + `src/**` + LICENSE + README），
  运行期由 pi 以 `--extension <dir>` 加载；**不经过 npm**（目标机器上可能没有 node/npm）

> 这一节是 2026-10-09 补的：插件 10-06 就随包分发了，而两份清单（本文件与
> `legal.rs::THIRD_PARTY`）都漏登记 —— 它们互为金标、两边同缺所以测试是绿的。
> 教训见 docs/15 规矩 134：**"互为金标"的两份清单挡不住"两边都忘了"。**

---

## pi-guardrails（随包分发的 pi 插件）

- **用途**：**写前校验护栏** —— 拦「改已存在但没读过的文件」、锁内 CAS（消除 TOCTOU）、
  崩溃安全的原子发布、空响应兜底、bash 证据化、重复调用提醒。
  随 Piggy 一起注入到 pi 会话里（`apps/desktop/src-tauri/resources/pi-plugins/pi-guardrails/`）
- **来源**：<https://github.com/wxk6b1203/pi-guardrails>（本仓作者的另一个项目）；
  收录方式与漂移检测见 `apps/desktop/scripts/vendor-plugin.mjs` 与插件目录里的 `vendor.json`
  （逐文件 sha256；CI 跑 `--check`）
- **许可**：MIT（`Copyright (c) 2026 wxk6b1203`，见插件目录里的 `LICENSE`）
- **取用方式**：源码整目录收录（入口 + `src/**` + LICENSE + README），
  运行期由 pi 以 `--extension <dir>` 加载；**不经过 npm**（目标机器上可能没有 node/npm）。
  它只 import `node:*` 内置模块与 pi 的虚拟模块（`@earendil-works/pi-coding-agent`），
  因此不需要 `node_modules`
- **⚠️ 覆盖型插件**：它注册的是 pi 的**内置同名工具** `write`/`edit`。
  清单里写死 `"allowlist": false`，所以它的工具名**不进**限制档位的 `--tools` 白名单
  （否则「仅可查看」档会凭空获得写能力）。与 Piggy 自己的路径守卫 `piggy-guard.js`
  不冲突：那个挂的是 `tool_call` 钩子，由 pi 的会话层按**工具名**触发，
  与"工具是谁注册的"无关（真机探针里有组合断言）

---

## DeepSeek Harness（DSH，设计参照）

- **用途**：Piggy 的 UI/交互**以 DSH 为参照**（docs/11/12/14 是逐条对照的规格与实测记录）
- **来源**：`deepseek-harness`（`@deepseek-ai/dsh*`），本地检出 `/Users/wxk/Documents/Project/deepseek-harness`
- **取用方式**（**按现状登记，不是"抄了一堆代码"**）：
  1. **设计 token 数值**：`apps/desktop/src/styles/tokens.css` 的取值由
     `apps/desktop/scripts/extract-dsh-tokens.mjs` 从 DSH 的
     `packages/client/ui-theme/src/styles/*.css` 提取（变量名改成 `--pg-*`，逐行注释标出对应的
     DSH 令牌名）；
  2. **措辞/规格对齐**：会话标题生成的提示词逐句对齐 DSH
     `session-title-llm/src/index.ts` 的措辞（`sessions/title.rs::build_prompt` 里注明）；
     RPC 语义、几何常量、命令命名等接口事实散见 docs/11、12、14；
  3. 界面结构（面板划分、选择器位置等）是**照着重画**，不是拷贝实现；
  4. **一个二进制资产**（2026-10-16 起）：运行中指示的鲸尾动图
     `apps/desktop/src/assets/running-whale@2x.png` —— 原样取自 DSH
     `packages/client/ui-chat/src/client/chat/running-whale@2x.png`（APNG，21,631 字节），
     在 `styles.css` 里当 alpha mask 用（`RunningStatus` 的文字扫光那颗图标）。
     这是**直接搬运上游资产**，所以下面那句"若日后直接搬运"对它已经生效：
     它的 MIT 许可与版权声明见本节末尾。
- **许可**：MIT，`Copyright (c) 2026 DeepSeek`

> 说明：DSH 的 `package.json` 带 `"private": true`（那是"不发布到 npm"的意思，与许可无关）。
> 只要保留了版权与许可声明，MIT 允许这样复用；**若日后直接搬运 DSH 的源码文件**
> （而不只是数值/措辞/接口事实），必须把该文件的 MIT 声明一并带过来。

### 署名（MIT 履行，`running-whale@2x.png`）

> MIT License — Copyright (c) 2026 DeepSeek
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software
> and associated documentation files (the "Software"), to deal in the Software without
> restriction, including without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
>
> 上游：`deepseek-harness` 仓库 `LICENSE`（全文同此，仓库根那一份即 MIT）。

---

## @vscode/codicons

- **用途**：UI 图标字体（`Icon` 组件，`src/features/common/Icon.tsx`）
- **来源**：<https://github.com/microsoft/vscode-codicons>（VS Code 官方图标集）
- **取用方式**：npm 依赖 `@vscode/codicons`（与 VS Code 仓库 `package.json` 使用的是同一个包；
  VS Code 在 `build/gulpfile.editor.ts` 中把 `dist/codicon.ttf` 拷入源码树使用）
- **版本**：0.0.46-24

许可分两部分：

| 部分 | 许可 | 义务 |
|---|---|---|
| 图标字形 / 字体文件（`dist/codicon.ttf`、`dist/codicon.svg`） | **CC-BY-4.0** | **必须署名** |
| 构建代码（`dist/codicon.css`、脚本） | MIT | 保留版权声明 |

### 署名（CC-BY-4.0 履行）

> Icon glyphs from **Codicons** by Microsoft Corporation, licensed under
> [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/).
> Source: <https://github.com/microsoft/vscode-codicons>

完整许可文本随依赖分发：`node_modules/@vscode/codicons/LICENSE`（CC-BY-4.0）与 `LICENSE-CODE`（MIT）。

---

## seti-ui（VS Code 内置 Seti 文件图标主题）

- **用途**：文件类型图标（`FileIcon` 组件，`src/features/common/FileIcon.tsx`）
- **来源**：<https://github.com/jesseweed/seti-ui>，经 VS Code 的
  `extensions/theme-seti/`（`icons/seti.woff` + `icons/vs-seti-icon-theme.json`）取用
- **取用方式**：构建期同步，脚本 `apps/desktop/scripts/sync-seti-icons.mjs`
  （产物：`src/assets/seti.woff`、`src/features/common/seti-icons.ts`，均已入库）
- **规模**：383 图标定义 / 238 扩展名关联 / 101 文件名关联 / 83 语言 id
- **许可**：MIT

```
Copyright (c) 2014 Jesse Weed

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
```

（原文见 VS Code 仓库 `ThirdPartyNotices.txt` 的 `seti-ui 0.1.0` 条目。）

> 注：docs/13 的 E2 更正了"Seti 是 SVG，可只取子集"的说法——它实际是 **WOFF 字体**，
> 只能整体 vendor（37 KB）。

---

## Monaco Editor

- **用途**：编辑/预览基座（`MonacoHost`、`monaco-setup`）
- **取用方式**：npm 依赖 `monaco-editor`
- **许可**：MIT

主题桥说明：VS Code 仓库内**不存在** workbench 主题 → `IStandaloneThemeData` 的转换器
（VS Code 自身从不调用 `defineTheme`），因此 `monaco-setup.ts` 里的主题是**手工镜像**
`styles/tokens.css` 的 DSH 令牌值，改 token 时必须同步。

---

## VS Code 内置主题（tokenColors 部分）

- **用途**：Monaco 的**语法着色**（`monaco-setup.ts` 的 `rules`）
- **来源**：VS Code `extensions/theme-defaults/themes/dark_modern.json` 与 `light_modern.json`
  （含 `include` 继承链）
- **取用方式**：构建期同步，脚本 `apps/desktop/scripts/sync-vscode-themes.mjs`
  （产物：`src/features/common/vscode-theme-tokens.ts`，已入库）
- **规模**：Dark Modern 65 条 tokenColors → 168 条 Monaco rule；Light Modern 64 → 187
- **许可**：MIT，Microsoft

**为什么只取 tokenColors，不取整套主题**：docs/13 的 E4 查明主题 JSON 只覆盖
**123/477（26%）** 的颜色 id，缺的键要靠颜色注册表默认值 + 派生变换补齐（估算 1–1.5 人日）。
而 `tokenColors` 是一张独立的 scope → 样式表，**不依赖任何默认值层**，可以单独使用。
外壳颜色继续由 DSH 令牌（`styles/tokens.css`）决定，与"UI 参照 DSH"不冲突。

> 未引入的部分：`extensions/theme-<name>/themes/*.json` 的 9 个第三方主题
> （Monokai / Solarized 等）另有署名要求 —— `Copyright (c) 2015 Colorsublime.com`。
> 若日后引入，须在此补该署名（非 Microsoft）。

---

## 待登记

**已核实不需要登记**（2026-09-25 复核）：

- **VS Code 设计尺寸 ramp**（`src/vs/platform/theme/common/sizes/baseSizes.ts` +
  `sizeUtils.ts`，docs/13 §7 曾列为 copy-with-attribution）：**没有引入**。
  全仓没有 `--vscode-*` 尺寸变量，`tokens.css` 的数值全部来自 DSH（见上）。
  docs/13 里的 986 colors / 54 sizes 是**读取**该文件统计出的事实，不是拷贝代码。
  若日后真的把这套 ramp 抄进来，须在此补 **MIT · Microsoft** 的署名。
- **变量白名单**（`build/lib/stylelint/vscode-known-variables.json`）：同上，只用于统计。
- VS Code 的 9 个第三方主题（Monokai / Solarized 等）：未引入（引入需补
  `Copyright (c) 2015 Colorsublime.com`）。
