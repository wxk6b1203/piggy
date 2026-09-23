# 第三方资产与许可

Piggy 复用了若干上游资产。本文件记录来源、版本与许可义务；**新增可复用资产时必须在此登记**。

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

- 其他（VS Code 设计尺寸 ramp `baseSizes.ts`、变量白名单等，见 docs/13 §7）。
