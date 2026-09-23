# 10 · VS Code 资产复用与编辑器基座（Monaco）

> 上游：[04-frontend-design.md](04-frontend-design.md)、[05-performance.md](05-performance.md) · 关联：[08-project-structure.md](08-project-structure.md) §3

VS Code 是同类产品里被验证最充分的"代码工作台"设计。本文回答两个问题：**哪些资产值得搬**（组件级/概念级），**哪些是陷阱**。结论先行：

| 资产 | 决策 | 一句话理由 |
|---|---|---|
| **Monaco Editor** | ✅ 采纳（编辑基座） | VS Code 内核编辑器；diff（DiffEditor）业界最强、monaco-json + schema 补全开箱即用、多实例共享 worker |
| **xterm.js**（VS Code 终端组件） | ✅ 采纳（P0） | 终端仿真自研不现实；底部面板 + PTY 登录流程 |
| **@vscode/codicons** | ✅ 采纳 | MIT 图标集，体积小，补足 antd 图标在"代码语义"上的缺口 |
| **Seti/vscode-icons 文件图标** | ✅ 采纳（vendor 子集） | 文件面板需要文件类型图标，取 SVG 子集打包 |
| **VS Code 主题 JSON**（Dark+ 等） | ✅ 采纳（一份三吃） | 同一主题文件喂 Monaco（defineTheme）+ Shiki（代码块）+ 应用 CSS 变量 |
| **dockview**（非 VS Code 出身，复刻其 dock 能力） | ✅ 采纳（M1 起，编辑区） | split groups / tab 拖拽 / 分组，最接近 VS Code 工作台布局的开源库 |
| **react-resizable-panels** | ✅ 采纳（外框） | 左右栏/底面板的框线伸缩，轻量（~5KB） |
| **布局形态**（视图轨/侧栏/tab/辅助侧栏/面板） | ✅ 概念复用 | 工作区设计直接采用该心智模型（04 §1） |
| **键位 DSL**（`cmd+k cmd+t` + when-clause） | ✅ 概念复用（自实现解析器） | 字符串格式与上下文条件表达式抄设计不抄代码 |
| **VS Code 源码** | ✅ 本地参考库（§6） | grid/sash、contextkey、keybinding 的实现语义参考；浅克隆只读 |
| **@vscode/webview-ui-toolkit** | ❌ 弃用 | 官方已 deprecated（2024），明确不建议新项目使用 |
| **Theia / OpenSumi / fork VS Code** | ❌ 否决 | 整个 IDE 框架与 Tauri+React 壳、性能预算（00 NG4/NG3）正面冲突 |
| **CodeMirror 6** | ❌ 不采用 | 项目决策：编辑场景统一收敛到 Monaco，避免双编辑器栈（曾作为轻量备选，见 git 历史） |

## 1. 复用三原则

1. **组件级复用**只认"独立、无框架绑定、MIT"的库（monaco/xterm/dockview/codicons 均满足）；
2. **概念级复用**优先于代码级：布局心智、preview tab、when-clause 键位是十年打磨的交互资产，抄概念比抄代码便宜且无升级负担；
3. **一切进入 `apps/desktop` 运行时依赖的资产必须过 05 预算**（08 §3 白名单制）——Monaco 也不例外，靠"懒加载 + 实例纪律"让它过线（§2.3）。

## 2. Monaco 落地方案

### 2.1 场景映射（Monaco 管什么、不管什么）

| 场景 | 用 Monaco？ | 方案 |
|---|---|---|
| 设置 JSON 编辑（settings/models/auth） | ✅ | `monaco-json` + JSON Schema 注册（§3.3），实时校验/补全/格式化 |
| 文件预览 tab（04 §1.6） | ✅ | 只读实例 + 按需语言贡献；大文件（>5MB）降级为纯文本模式 |
| Diff 预览 tab / 变更视图详情 | ✅ | **DiffEditor**（side-by-side / inline 切换） |
| Extension UI `editor` 弹窗（02 §8） | ✅ | 单实例模态挂载 |
| **Composer（消息输入）** | ❌ | 受控 textarea + 自动增高 + IME 友好。理由：聊天框不是代码编辑器——软换行/自动伸缩/输入法体验优先，Monaco 的编辑能力无用武之地且为每 tab 常驻实例付无谓重量 |
| **聊天内嵌 diff 卡片**（04 §5.3） | ❌ | 轻量行级 diff 自绘（卡片内小面积渲染），不为每张卡片实例化 Monaco |
| 聊天代码块高亮 | ❌ | Shiki（只读、VS Code 主题直接可用，§4） |

边界一句话：**"打开一个文件/diff/JSON"= Monaco；"聊天里的内容"= 自研轻渲染**。

### 2.2 打包与加载

1. **ESM 按需 + 语言逐门懒加载**：`monaco-editor/editor/editor.api` **一门语言都不带**（这不是缺陷，是 ESM 发行版的默认形态）。语言定义在 `src/features/common/monaco-langs.ts` 里逐门写成 `import('monaco-editor/languages/definitions/<lang>/register')` 的**字面量**，Vite 才会为每门语言切**独立 chunk**，只有真的打开该语言的文件时才下载。当前白名单 **55 门**（go/python/rust/ts/js/java/c/cpp/md/json/yaml/toml≈ini/sql/sh/dockerfile/…），认不出的扩展名 = `plaintext`、一个字节都不下。
   **禁全语言注册**（`basic-languages/monaco.contribution` / `languages/register.all`，一次进 84 门）：这条红线由 `src/test/preview-lang.test.ts` 的源码门在每次 `pnpm test` 时拦。
   ⚠️ 本行此前写的是"lint 强制"——**当时并没有任何东西在执行它**：`apps/desktop/package.json` 里根本没有 `lint` 脚本，`pnpm lint` 一个文件都扫不到（`eslint.config.js` 里现在确实有这条规则，等 lint 接上即生效）。教训：**写在文档里的"强制"必须能指出是哪条命令在强制**。
   ⚠️ 另一个同类坑：``import(`monaco-editor/languages/definitions/${id}/register`)`` 这种**裸说明符 + 变量**，Vite 的 dynamic-import-vars **不分析裸说明符**，构建期连 warning 都不给、产物里原样保留，运行期才抛（docs/15 规则 22）。代码块高亮就是这么静默死了很久。
2. **Workers**：editor/json/ts worker 经 Vite `?worker` 打成独立 chunk；`MonacoEnvironment.getWorker` 手动映射；CSP 增 `worker-src 'self' blob:`（Tauri 配置，WKWebView/WebView2 均验证通过才可发版）；
3. **React 封装**：`MonacoHost` 直接持有 `monaco-editor` 实例。`@monaco-editor/react` 在依赖表里但**当前没有任何 import**（待清理项）；
4. **懒加载**：Monaco 全家（core+workers+语言）为独立异步 chunk，首次打开预览/设置/diff 才加载——空载会话不付一分钱（05 §5.5）；
5. **创建顺序**：语言定义必须在 `editor.create({language})` **之前** await 完。未注册的 language id 会被 `LanguageService._createAndGetLanguageIdentifier` **静默降级成 plaintext**（源码原话 `Fall back to plain text if language is unknown`）——界面上就是"语言条写着 `go`、正文一片白"，而且不报任何错。（事后 `setModelLanguage` 其实能救回来，但那是"先错后改"：白跑一次 tokenize，还得把 ready 时序接出来。）调用点见 `monaco-setup.ensureLanguage` + `MonacoHost`。

### 2.3 实例纪律（过预算的关键）

- **MonacoHost 单例工厂 + 实例池**：所有 Monaco 挂载点经 `features/common/MonacoHost`（04 §2），全局共享 worker；并发实例上限 6，超限复用（预览 tab 单实例可替换语义天然配合，04 §1.3）；
- **dispose 纪律**：预览 tab 关闭/被覆盖即 `model.dispose()` + `editor.dispose()`；diff 预览的临时 model 用后即弃；
- **预算线**（05 §2/§5.5）：Monaco 异步 chunk ≤ 2MB gzip（core+workers+选定语言）；加载后 RSS 增量 ≤ 60MB；未加载时 = 0；
- 只读预览统一 `readOnly + domReadOnly + minimap:false + wordWrap` 预设，避免每实例开重特性。

### 2.4 主题：一份四吃

`themes/*.json`（VS Code Dark+ 等起步）→ 构建期脚本生成：① **antd v6 theme token**（ConfigProvider，含密度/圆角/字体等 VS Code 形态覆写，04 §6）；② Monaco `defineTheme` 注册表；③ Shiki 主题；④ 应用层 CSS 变量（`--pg-*`）。深浅色切换 = 整套同步换肤，antd/Monaco/Shiki/自研渲染器零色差。antd v6 默认 CSS 变量模式，token→变量映射原生支持，无额外成本。

## 3. 概念级复用明细

### 3.1 布局形态 → 04 §1 工作区设计

视图轨/主侧栏/编辑区 tab 组/辅助侧栏/底部面板/状态栏的分区与折叠语义，连同 preview tab、dirty/pin 徽标、双击固定等交互，整体映射见 04 §1.2–1.4（本文不重复）。

### 3.2 键位 DSL

- 键位字符串采用 VS Code 语法（`cmd+k cmd+t` 支持 chord 序列），解析器自实现（~100 行 + 单测）；实现语义参考 VS Code 源码 `src/vs/platform/keybinding`（§6）；
- `when` 上下文表达式沿用 07 §1 的作用域模型（VS Code when-clause 的简化子集：`contextKey == value` 布尔组合）；求值语义参考 `src/vs/platform/contextkey`；
- 未来可选：导入 VS Code `keybindings.json` 片段（格式兼容收益，非承诺）。

### 3.3 JSON Schema 驱动的设置编辑

- `packages/pi-protocol` 维护 `settings.schema.json`（pi `docs/settings.md` 全量字段化，含枚举/默认值/说明）；
- 双端消费：Monaco（`monaco-json` schema 注册）编辑器内实时校验补全；**Rust 写盘前用 `jsonschema` crate 同一 schema 校验**（03 §2.10 的"保护用户手编内容"再上一道闸）；
- schema 与 pi 版本共同演进（09 R1 契约矩阵发现新字段 → schema 增补）。

### 3.4 Preview Tab / dirty 徽标

- 文件预览采用 VS Code 单预览 tab 语义（点击=预览，编辑/双击=固定），避免浏览文件时 tab 爆炸（04 §1.3）；
- tab 的 `●`（streaming）/`未读`（后台 settle）徽标即 VS Code dirty/通知徽标的心智复用。

## 4. 其余资产的工程注意事项

| 项 | 说明 |
|---|---|
| xterm.js | `@xterm/xterm` + `fit`/`web-links` addon；实例仅在终端面板可见时挂载，隐藏即 `dispose`（面板内存纪律，05 §5.5） |
| dockview（编辑区） | M1 即引入（04 §1.8）：tab 组、split、拖拽；Fleet lanes 自动分列（06）复用同一能力 |
| codicons | 优先 SVG 子集（tree-shakable），icon font 仅在子集不可行时用 |
| 文件图标 | vendor `seti-ui` SVG 子集（~200 常见类型）入 `apps/desktop/src/assets/file-icons/`，构建时生成雪碧图/内联 |
| 主题资产 | `themes/*.json` 入 `packages/pi-protocol` 或 app assets，构建期生成三份产物（§2.4） |

## 5. 依赖白名单增量（08 §3 同步）

新增：`monaco-editor`（ESM 按需 + workers）、`@monaco-editor/react`、`@vscode/codicons`、`@xterm/xterm` + addons、`react-resizable-panels`（外框）、`dockview`（编辑区）。**CodeMirror 全家（core/merge/language-data/codemirror-json-schema）移出白名单**。

## 6. VS Code 源码参考库（回应"要不要拉一份"）

**结论：建议拉取，但定位是"只读参考库"，不阻塞开发。**

- 拉取方式：`git clone --depth 1 https://github.com/microsoft/vscode`（浅克隆，几百 MB；建议放 `~/Documents/Project/reference/vscode`，**不入本仓库**）；
- 参考点映射（只读 + 少量带出处的小段移植，MIT 允许；**不 vendor 大段代码**——升级负担）：

| 想要的能力 | 参考位置 | 用途 |
|---|---|---|
| 分割面板/网格（sash、grid） | `src/vs/base/browser/ui/grid`、`src/vs/base/browser/ui/sash` | 校验 dockview 行为是否达标；自研外框 sash（拖拽手感、双击复位、键盘调整）的语义参考 |
| when-clause 求值器 | `src/vs/platform/contextkey/common` | 07 §3.2 简化子集的语义对齐（优先级/短路/defined） |
| 键位解析与冲突 | `src/vs/platform/keybinding/common` | chord 状态机、平台键映射、`when` 优先级规则 |
| 编辑器 tab 交互细节 | 工作台（workbench）行为观察 | preview→pin 转换时机、dirty 徽标、拖拽预览 |
| Monaco workers 配置 | `src/vs/workbench/services/...` 与 monaco 样例 | worker 分包与 `MonacoEnvironment` 最佳实践 |
| 主题/图标资产 | `extensions/theme-*`、`src/vs/base/common/codicons` | §2.4/§4 资产来源 |

- 边界重申：Monaco/xterm/dockview/codicons 一律走 **npm 依赖**（可升级、有安全补丁）；源码只回答"它当年为什么这么设计"。

## 7. 演进策略

- Monaco 版本：锁 minor 跟进（`~0.5x`），升级走独立 PR + 冒烟（workers/主题/diff 回归）；
- 若未来 VS Code 官方拆出独立发布的 layout/keybinding 包，优先替换自研对应件（接口已在 LayoutManager / KeymapService 边界内，04 §1.8、07 §1）。
