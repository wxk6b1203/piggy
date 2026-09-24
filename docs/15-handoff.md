# 15 · 会话交接（2026-09-23）

> 用途：给**下一个接手的 agent / 会话**的一页速览，避免重读全过程。
> 设计细节见 [12](12-dsh-ui-spec.md)/[13](13-vscode-asset-inventory.md)/[14](14-ui-assessment-and-dsh-alignment.md)。
> pi 的配置来源与扩展机制见 [16](16-pi-config-and-extensions.md)；
> 权限档位与自定义 pi 打包见 [17](17-pi-permissions-and-packaging.md)。

## 1. 当前状态

DSH UI 对齐 + 权限档位 + pi 打包修复 + **子代理双层（M3）** 已完成并验证。

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` | 通过（apps/desktop + packages/piggy-bridge，后者对着真实 pi 类型） |
| `vitest` | **286/286**：apps/desktop **219**（24 文件，含 20 条守卫扩展、16 条失败回合可见性、9 条布局生命周期判据、2 条恢复时序、8 条 fleetStore、9 条 FleetView、11 条 Composer 斜杠补全、44 条代码块高亮/折叠/源码门、4 条同一会话重复打开去重、5 条子代理委派开关、8 条预览语言表、5 条折叠侧栏图标轨、4 条空编辑区占位、**22 条「打开方式」**、**2 条 IPC 命令名契约**）+ `packages/piggy-bridge` **37**（含产物新鲜度门禁 + 5 条自动激活判据）+ `packages/pi-protocol` 30 |
| `cargo test` | **158 + 3 + 8** + fixtures 全绿（fleet 状态机/结果收集/容量排队 16 条、argv 组装 13 条含**委派开关的档位组合/缺失 fail-closed**、扩展资源定位 4 条、**「打开方式」64 条**：目录表自检 / 三平台定位链（脚本化假宿主）/ 观察窗四态真进程 / macOS 真机解析与图标提取 / 文件关联真机查询（20 个处理器、默认项唯一）/ 路径校验与拒绝面 / base64 向量） |
| `cargo test --features contract` | **15/15 全绿**（pi 0.87.1 真实跑，含 C12 bridge 数据面 / C13 降级 / C14 两 lane DAG）；另 IPC 契约 8 条：`fs_list_dir` 形状 + 「打开方式」id 数组 / **图标真的是 128×128 PNG data URL** / 文件关联 `{id,name,default,icon}` 形状（默认项恰好一个）/ 目录也能查关联 / 拒绝面 |
| `ui:debug --strict` | 零 pageerror / 零 console error / 零布局问题（退出码 0） |
| `ui:startup` | 全绿，第 4 段覆盖：右栏 Fleet 面板 → A 层启动 3 条 lane（scout/review/build，验证 camelCase 参数名）→ steer 回车清空 → B 层刷新后 PIGGY:1 载荷落到面板（reviewer · correctness）→ **斜杠补全真滚动**（52 行、`scrollHeight 1508 > clientHeight 258`、`scrollTop` 真的变了、滚到底最后一条在可视区内）→ **代码块真高亮**（4 张卡 / diff 1 增 1 删 1 块头带底色 / go 的 token 有 4 种颜色 / 静默失败数 0） |
| `ui:startup` 第 5 段 | **文件预览真高亮**：README.md 语言条 `markdown` + 4 种 token 类 / 3 种颜色（标题 `rgb(86,156,214)`）；main.go 9 种颜色（注释绿/关键字蓝/字符串橙）；`notes.zzz` 老实 `plaintext` 只有 1 色；外加**按需门**（开了 2 个文件只许下 `markdown`/`go` 两门语言定义，多一门就红） |
| `ui:startup` 第 6 段 | **折叠侧栏不许进死胡同**：关掉全部标签 → 收起侧栏 → 断言图标轨恒 56px + 展开按钮 36×36 + 三个按钮都有可访问名 → 点回来 → 侧栏 254px、图标轨消失、标签数不变；连做 2 轮 |
| `ui:startup` 第 7 段 | **空编辑区占位**：关光标签 → 水印 🐷（opacity ≤0.15）+ ≥5 条快捷键（逐条与**应用自己那份命令注册表**核标题与键位）+ ≥3 个中央入口；每个入口做 `elementFromPoint` 命中判定（防被 dockview 的 `.dv-watermark-container` 盖住）+ 真点一下建出标签 + 再关光后占位回来 |
| `ui:startup` 第 8 段 | **「打开方式」分裂胶囊**：会话头部右侧**位置对**（`.pg-session-head-ops` 内、置灰占位已被替掉、「更多」占位还在）+ **够显眼**（26px 高、1px 边框、≥70px 宽、`elementFromPoint` 可点）+ 菜单**向下弹且不出屏** + 5 项里真图标与通用图标**两条渲染路径都出现** + 点 GoLand → **送给宿主的是 `{id:'goland', path:<会话 cwd>}`** + 选择落 localStorage + 重载后冷启动读回 |
| `ui:startup` 第 9 段 | **「打开方式」文件那一档**（预览头部，真浏览器）：胶囊在文档动作位的**最后一格**、compact 24px、有边框、`elementFromPoint` 可点、主按钮名字 = **系统默认应用**（Typora.app）且真图标渲染出来 → 点主按钮送出 `{path:<预览的那个文件>, action:'open', application:'/Applications/Typora.app'}` → 菜单 2 个处理器 + 「显示文件位置」（真图标与通用方块两条路径都出现）→ 点它送出 `{action:'reveal', application:null}`。**顺带锁住语言判定**：`lib.rs` 的语言条必须是 `rust`、token 类 ≥2（预览头部原来那张 16 项本地表认不出 `.rs`） |
| 真机人工确认 | 「打开方式」在 `tauri dev` 窗口里**由用户手动点过，应用真的弹出来了**（2026-09-24）。这是唯一能证明「操作系统真的把窗口开出来」的一步 —— agent 侧没有窗口驱动能力，也没法在不打扰用户的前提下自己点一次 |
| 真实 pi 0.87.1 加载 piggy-bridge | `/piggy:status` 回 `ok:true` + 真实 fleet/asyncSnapshot；空配置目录回 `ok:false` 降级（C12/C13） |
| 真实 pi 0.87.1 跑 Fleet DAG | 两 lane：a settle → b 就绪 → `{upstream}` 注入真实输出 → b 回 BRAVO-OK → run Done（C14） |

### 1.1 权限档位（Composer 工具行左侧）

三档：**仅可查看**（`--tools read,grep,find,ls`）/ **工作区内修改**（默认；加 `write,edit` + 守卫扩展）/
**完全权限**（不传 `--tools`，含 shell 与插件工具）。

关键事实：**pi 没有权限模型**，只有 `--tools` 白名单和扩展 `tool_call` 钩子两个原语，
且都只能在启动时决定 —— 所以**切档 = 带同一会话文件重启 worker**（复用崩溃复活路径，会话不丢）。
另外 pi 的 `write`/`edit` **不做工作区边界检查**，所以「工作区内修改」靠
`resources/piggy-guard.js` 拦截，不能只靠 `--tools`。详见 docs/17。

## 2. 常用命令

```bash
pnpm dev                                        # Vite :5195
pnpm build:bridge                               # piggy-bridge 源码 → resources/piggy-bridge.js（改扩展后必跑）
pnpm --filter piggy-bridge test                 # 桥接扩展单测 + 产物新鲜度门禁
pnpm test:contract                              # 真实 pi 契约测试（C12–C14 覆盖子代理双层，会消耗少量 token）
pnpm --filter @piggy/desktop ui:debug           # 截图 + 错误 + 布局体检（--strict 进 CI）
pnpm --filter @piggy/desktop ui:startup         # 启动核对：布局恢复一致性 + Fleet 面板 A/B 两层
pnpm --filter @piggy/desktop icons:gen          # 重生成 codicon 名联合类型
pnpm --filter @piggy/desktop icons:seti         # 同步 Seti 文件图标（需 VSCODE_REF）
pnpm --filter @piggy/desktop themes:sync        # 同步 VS Code tokenColors
pnpm --filter @piggy/desktop tokens:extract     # 从 DSH 源码抽设计令牌
pnpm tauri dev                                  # 真机开发（会自己起 Vite）
```

## 3. 几条"踩过才知道"的规矩

1. **改 `styles/tokens.css` 必须同步 `monaco-setup.ts`**——Monaco 的 `defineTheme`
   只吃字面色值，读不到 CSS 变量，两边是手工镜像。
2. **Monaco 只能用规范说明符**（`monaco-editor/editor/editor.api`）。
   用 `monaco-editor/esm/vs/...` 会因 exports map 双写而 504；用
   `optimizeDeps.exclude` 绕过又会打散它的服务注册。alias 也修不了优化器。
3. **Rust 侧往 JSON 里放 `OsString`/`PathBuf` 必须先 `to_string_lossy()`**，
   否则 serde 会产出 `{"Unix":[...]}` 对象，前端渲染即崩。
   `tests/ipc_contract.rs` 守这条。
4. **`mockBackend` 与真后端形状不一致会藏真机 bug**——加新 IPC 命令时，
   两边都要改，并优先给 Rust 侧补契约断言。
   2026-09-23 又踩一次：mock 对任何 `tabId` 都照常回答，于是"界面显示着这个标签、
   registry 里却没有它"这类 bug 在 mock 里完全测不出来（真机是所有命令一起报
   「tab 不存在: <uuid>」）。现在 mock 有 `liveTabs` 注册表 + `TAB_SCOPED` 命令集，
   并用 sessionStorage 跨页面重载保存（真机的 registry 活在 Rust 进程里，同样跨重载）。
   新增 tab 级命令时**必须**加进 `TAB_SCOPED`，否则 mock 又比真机宽松。
5. **批量改写脚本必须先备份再改，改完立刻 `tsc`**。2026-09-23 有一起自伤事故
   （见 docs/14 §0.1），丢了上一轮 agent 对 `SettingsTab.tsx` 等的未提交改动。
6. **黑屏时先看终端**：`ErrorBoundary` + `webview_log` 会把渲染错误打到 stdout
   （前缀 `[piggy][webview]`），不用猜。
7. **`tauri::Builder::setup` 是覆盖不是追加**（`self.setup = Box::new(setup)`）。
   一个 Builder 链里写两个 `.setup()`，前一个会被**静默丢弃**。本项目踩过：
   托盘、内置 pi 接线、权限守卫、会话 watcher 因此从未运行过（docs/17 §3 第 9 条）。
   要加启动逻辑就写进**同一个**闭包。
8. **权限档位的文案不写死在前端**：档位名与工具清单从 `permission_modes` 命令读，
   避免 UI 描述与 `pi/permission.rs` 的真实行为漂移。
9. **改 `pi_files.rs` 里的 pi 配置文件形状，先去 docs/16 查真实 schema**：
   `auth.json` 的字段是 `key` 不是 `api_key`，且 pi 对非法条目**直接抛错**（整个文件不可用）。
   这个 bug 让"设置里填的 API Key"静默失效了很久。
10. **dockview 的主题是"结构 + 配色"两部分，变量全在 `.dockview-theme-*` 下。**
    用自定义主题类 = 内置的 112 个变量一个都继承不到。只搬颜色会踩的坑：
    `--dv-overlay-z-index` 缺失 → 浮层 `z-index` 退化成 auto → 溢出下拉菜单**看得见点不到**；
    `--dv-context-menu-background-color` 缺失 → 右键菜单背景透明、文字叠在面板上。
    判断"缺哪些"要看**被 `var()` 引用且无 fallback** 的变量，而不是拿某个内置主题做差集
    （老主题 `dockview-theme-dark` 与新主题 `abyss` 的变量集并不相同，参照物选错会漏）。
11. **dockview-react 的默认标签组件只能用 `defaultTabComponent` 这个独立 prop 传**。
    写成 `tabComponents={{ default: X }}` 会注册组件但**永远不生效**
    （见 dist/package/main.esm.mjs:559-566），dockview 会退回它自己的默认 tab。
    带"流式 ● / 未读 •"徽标的 `PgTab` 曾因此从未渲染过。
12. **pi 的「失败回合」是一条普通的 assistant 消息，不是错误事件。**（2026-09-23 用真实 pi 抓包确认）
    模型报错 → `{content: [], stopReason: 'error',   errorMessage: '401: {"message":"Authentication Fails, …"}'}`；
    用户中断 → `{content: [], stopReason: 'aborted', errorMessage: 'Request aborted'}`。
    `content` 是空数组，所以**只渲染 content 的视图会画出一片空白**，
    用户看到的现象是「消息发出去就再也回不来了」——而错误文本一直在消息里没人读。
    判读统一走 `src/lib/turnFailure.ts`（转写 `MessageView` 与轨迹 store 共用一份规则，
    别再各写一套）。排查这类"没反应"时：**先看会话 jsonl 里 assistant 消息的 `stopReason`/`errorMessage`**
    —— 那比看 UI 快得多（`sessionDir` 见 docs/16）。
13. **StrictMode / HMR 会把 dockview 卸载重挂，而布局恢复是异步的**——两者叠加会静默搞坏
    "哪些 tab 还算活着"（界面照常，坏的是 store 与 registry）。三条已固化的规矩：
    - `restore()` 必须在**开始时捕获目标实例**，落地前用 `shouldApplyLayout(target, api())` 校验。
      否则两轮恢复会把同一份布局套到同一个实例上；而 `fromJSON()` 是**先清空再重建**，
      第二次套用触发的 remove 被当成"用户关标签"→ 刚恢复的 tab 全被关掉。
      实测症状：面板还显示着、`useTabs` 空了、Rust registry 也空了 →
      该标签下所有命令一起报「tab 不存在: <uuid>」（模型列表空白、转写空白、发送无响应）。
    - **「面板被移除」≠「用户关了标签」**，判据在 `lib/layoutLifecycle.ts`
      （套用布局期间 / 已失效实例 / 活实例里还有面板在用同一 tabId，三者任一成立就不关）。
    - **`boot_reset` 与 `createTab` 之间必须有确定先后**：Rust 侧是先取 id 快照再逐个
      `close_tab`，建 tab 抢在快照之前完成就会被立刻关掉。统一走 `lib/boot.ts` 的
      `bootGate()`（`createTab` 内部已 await）。
14. **恢复布局后，dockview 面板 id 与 `params.tabId` 会分叉**：面板 id 是上一进程留下的
    `session:<旧 uuid>`，`params.tabId` 是这次新建 worker 的 uuid（`restore()` 只改写后者，
    因为面板 id 还挂在 grid 树里）。所以**任何"按 tabId 找面板"的地方都必须按
    `params.tabId` 找**，不能拼 `session:${tabId}`——拼字符串永远找不到，表现为点侧栏里
    已经打开的会话时又开一个重复标签，Rust 还会以「会话文件已被标签页 X 打开」拒绝。
    见 `EditorArea.findSessionPanel`。
15. **`get_messages` 的 data 是 `{"messages":[…]}`，不是裸数组**（`docs/rpc-commands.md` 明写）。
    只认裸数组的解析器会**静默返回空**——Fleet 的 lane 结果收集就这样错过过：每条 lane
    都正常 settle，但结果恒为空、下游 `{upstream}` 永远显示"(无输出)"，界面看不出异常。
    现在 `fleet::last_assistant_text` 两种形状都认，且契约测试 C14 用真实 `get_messages` 兜住。
16. **给 pi 写扩展时，先读它自己的类型，别照文档猜**（`@earendil-works/pi-coding-agent`
    `dist/core/extensions/types.d.ts`；workspace 里已把它作为 `packages/piggy-bridge` 的
    devDependency，可直接 `tsc` 校验）。三条曾经全写错、且因为"从未被加载"而长期没暴露：
    - 注册命令是 `pi.registerCommand(name, { description, handler })`（**对象形参**，不是 `(name, fn)`）；
    - UI 在 **`ctx.ui`** 上，不是 `pi.ui`；`setWidget` 签名是 `setWidget(key, content, options)`；
    - 跨扩展通信是 **`pi.events`**（`on/emit`），`pi.on` 只吃 pi 自己的生命周期事件名。
    加载一个 `handler` 不是函数的命令，pi 只发 `extension_error{error:"command.handler is not a function"}`，
    而 `prompt` 的 response 仍是 `success:true`——**"命令被受理"不等于"命令跑起来了"**，
    验证必须看回执（C12 就是为此存在的）。
17. **`cmd()` 直传 camelCase，mock 也必须读 camelCase**（Tauri 侧才做 snake_case 映射）。
    mock 的 `fleet_start` 曾读 `a.template_id` → 浏览器里 `templateId` 恒为 `"undefined"`、
    lane 集合永远走默认分支，而真机正常。**mock 撒谎比 mock 缺失更危险**。
18. **mock 不能把自己的内部对象直接 emit 给 store**：immer 的 auto-freeze 会冻结写进 state 的对象，
    之后 mock 的定时器再改它就会 `TypeError: Cannot assign to read only property 'status'`。
    真机每次发的是新 JSON，所以 mock 也要 `structuredClone` 后再发。
19. **bridge 的载荷与 store 的解析必须成对改**：`lanes` 在**顶层**（bridge 归一化产物），
    不是 `status.lanes`。这两处曾各自按不同理解实现 → 真机上"载荷到了、面板永远空白"。
    改任一侧都要动 `src/test/fleet.test.ts` 里那份**真实抓包 fixture**。
20. **pi-subagents 的 async runner 与 pnpm 软链布局不兼容**（子代理"派发成功但秒 failed"的根因）。    `runner-aliases.js` 把 peer 包别名指向 **pnpm 软链路径**，runner 再把它当模块 URL 用，
    于是被别名包**自己的依赖**从软链路径解析不到（它们躺在真实路径的兄弟位）——
    报错形如 `ERR_MODULE_NOT_FOUND: Cannot find package 'marked' / '@earendil-works/pi-telemetry'`。
    注意：**不是"没装"**（重装 pi 无效，补一个依赖只会冒下一个）。
    **上游已修复并发布**：报告 #2409 / 修复 #2413（`aliases[specifier] = fs.realpathSync(target)`），
    **0.71.0 起自带**。本机 0.70.1 上曾打一行临时补丁，升级到 0.71.0 时被官方版覆盖——正常，不用再打。
    判断某个版本有没有这个修复**只看一处**（修复改的是 `resolveHostPeerAliases` 的赋值，
    **不是** `findPeerPackageDir` 末尾那行 `candidates.find`——我一度看错这行而误判 0.71.0 未修）：
    ```bash
    grep -n "realpathSync(target)" ~/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/runner-aliases.js
    ```
    完整根因、A/B 复现实验与复验记录见 **docs/18**。
    排查入口：`$TMPDIR/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/runner.stderr.log`。
21. **列表类 UI：「看得见的条数」是 CSS 的事，不许写进数据层。**
    Composer 的斜杠补全曾经是 `.slice(0, 8)` + 容器 `overflow: hidden` + ↑↓ 被 `preventDefault`
    却什么都不做 —— 三件事叠起来的效果是"第 9 条以后**根本不在 DOM 里**、也滚不到、键盘也够不着"。
    在只有 3 条内建命令时看不出来；装了 pi-subagents 变成 50+ 条后，用户第一眼就是"无法滚动"。
    正确形态：全部条目渲染进 DOM，容器给 `max-height` + `overflow-y: auto` + `overscroll-behavior: contain`，
    ↑↓ 环绕移动选中项并 `scrollIntoView({block:'nearest'})`。
    另外两点容易漏：**异步数据到达后要按当前输入重算一次**（否则第一轮永远是空列表）；
    **jsdom 的 `scrollHeight` 恒为 0**，所以"能不能滚"只能在真浏览器里断言（`ui:startup` 第 4 段）。
    同类隐患：任何"只渲染前 N 条"的地方（会话列表、文件树、命令面板）都要先问一句
    "第 N+1 条用户怎么够到"。
22. **动态 import 的说明符不许是「裸包名 + 变量」。**
    `import(`shiki/langs/${id}.mjs`)` 里 Vite 的 dynamic-import-vars **不支持裸说明符**：
    **构建期连一条 warning 都不给**（我实测过 `vite build` 全量日志），产物里原样保留，
    运行期才抛 `TypeError: Failed to resolve module specifier`。外面再套一层
    `.catch(() => setHtml(null))`，异常就被吞成"降级为纯文本"——
    净效果是**语法高亮从来没生效过，而控制台和界面都干干净净**。
    用户看到的是"代码块没有高亮"，第一反应会去查 CSS，其实是语言包根本没下载下来。
    正确形态：写死字面量 `import('shiki/langs/go.mjs')`（Vite 才能切出独立 chunk）。
    两条配套纪律：
    - **不许把异常吞成"什么都没发生"**。降级可以，但要留下痕迹
      （这里：标题栏打「未能高亮」+ `console.warn`）。
    - **这类 bug 单测抓不到**：vitest 走 Vite 的 SSR transform，模板串那条路径在 Node 里
      **能解析成功** —— 把代码改回坏写法，44 条 codeblock 单测依然全绿。只有真浏览器
      的 ESM 解析 + 真实产物认得出，所以断言必须落在 `ui:startup` 的真实 DOM 上
      （`.shiki` 是否存在、token 颜色是否不止一种、diff 增删行有没有底色）。
      兜底一道便宜的源码门在 `src/test/codeblock.test.tsx`（扫 `src/**`，正则命中即红）。
23. **"先查 store 再 await" 跨越 await 就失效 —— 需要 in-flight 表。**
    2026-09-23 用户日志「非常偶尔会报错」：
    ```
    [piggy] tab_create ok: 3a8c24e9-…    --session …/2c118184-….jsonl
    [piggy] tab_create FAILED: 会话文件已被标签页 3a8c24e9-… 打开: …/2c118184-….jsonl
    ```
    `SessionsSidebar.openSession` 查的是 zustand store，而 store 要到
    `openSessionTab → ensureTab → addTab` 才更新 —— **整个 `tab_create` IPC 往返期间
    store 里都还没有这个标签**。两次点击落进同一个窗口，就都查到"没打开"、都去建 worker，
    第二个被 Rust 的会话互斥锁挡下，变成一条红色 toast。双击就会触发，所以"非常偶尔"。
    规矩：**任何"检查 → 异步 → 提交"都要有一张 in-flight 表**，把不变量收到唯一漏斗里
    （这里是 `createTabGuarded` 对会话文件幂等；`EditorArea.createTabForRestore` 早有同款）。
    两个配套细节：
    - **别在 settle 时逐出缓存**：那会在"promise 落定"与"调用方写 store"之间再开一个口子。
      改为命中时校验标签是否还活着，已关闭才逐出重建（否则"关掉再打开"会拿到死快照）。
    - **写测试时先确认 mock 的形状是真的**：这条测试第一版少了 `snap.state`，
      `addTab` 里 `snap.state.model` 抛异常 → 标签压根没进 store → 第二次"重建"是假红。
      假红比不写更坏。
    顺带修掉一个**必现**（不是偶尔）的同类问题：`doExport` 导出已打开的会话时无条件
    `createTabGuarded` → 必然撞互斥锁；而且不能顺手把用户正在用的标签关掉。

24. **要"改模型行为"，先 dump 它真正收到的东西，别照着文档猜。**
    问的是"为什么 pi 几乎不用子代理"。读 pi-subagents 源码能猜到"有劝退措辞"，但只有把
    **真机系统提示词 + `getAllTools()`** dump 出来才看清全貌：`subagent` **根本不在工具表里**
    （默认只有 `subagents_enable`，模型得先主动调它一次），外加 rules 段里那条
    "Do not invoke subagents unless the operator requested delegation..."。
    做法：写一个一次性扩展 hook `before_agent_start`，把 `event.systemPrompt` 与
    `pi.getAllTools()/getActiveTools()` 写到 /tmp，然后 `pi -p "只回复：收到"` 跑一轮。
    **成本一轮极小的 token，换掉一整类猜测。**
    顺带两条只能靠实测得到的结论：
    - `--tools read,grep,…` 会把**扩展工具整个过滤掉**（`getAllTools()` 只剩白名单那几个），
      所以任何依赖插件工具的功能在限制档位下都不存在 —— 这不是"可能不生效"，是**进程里没有**；
    - 在 `before_agent_start` 里 `setActiveTools`，**本次请求的工具表已经定死**，
      要从下一轮才生效。`systemPromptOptions.selectedTools` 在此之前就取好快照了。

25. **"声明"和"结果"要分开量：配了 ≠ 生效，这类 bug 全是静默降级。**
    用户截图："打开 README.md，语言条写着 `markdown`，正文一行都不上色。"
    查下来：Monaco 的 ESM 发行版**一门语言都不带**，而本项目只静态引了 json
    —— 除 `.json` 外所有文件都被 `LanguageService` 那句
    `Fall back to plain text if language is unknown` 悄悄降级成纯文本。
    **不抛错、不警告、语言条还是照写**，所以肉眼和"看代码"都发现不了。
    做法：断言**结果**而不是断言**声明** —— `ui:startup` 第 5 段数的是真实 DOM 里
    `.view-line span[class^=mtk]` 的**类数与颜色数**（markdown 3 色 / go 9 色），
    外加一个"语言条声称 X、正文却只有一个色"的静默失败计数器。
    通则：凡是"声明式配置 + 缺省回退"的地方（语言、主题、字体、图标集、权限档），
    都要有一条量结果的断言；否则改坏了永远是"看起来没问题"。
    这条与规则 22 是**同一类根因的第二次**：Vite 解析不了的东西（裸说明符 + 变量）
    也是构建期静默、运行期才炸 —— 现在那条源码门扫的是整个 `src/`。

26. **"折叠"不等于"删掉"：任何能收起/能关掉的东西，收起后必须留下一个可点的出口。**
    用户截图："缩小之后，没有一个细的 dock 栏，就无法展开了"——窗口里没有标签、
    侧栏也不见了，一屏黑，**没有任何可点的地方**能把它叫回来（只剩 ⌘B 与命令面板，
    对不知道快捷键的人等于没有）。
    根因是一行 JSX：`{sidebarOpen && <Panel…>}` —— 折叠把侧栏连同它的展开入口一起
    从 DOM 里删掉了。DSH 的折叠态是留一条 56px 图标轨（`SIDEBAR_COLLAPSED = 56`，
    docs/12 §1.5）；macOS 上它确实取 0，但代价是必须另给标题栏里的
    `HeaderLeadingControls`。**两条路选一条，不能不选。**
    检查法：对每个"能关掉/能收起"的东西问一句"关掉之后我用什么把它打开"，
    答案**不能是快捷键**。同类的第二处也已经补上：关光全部标签后编辑区只剩一片黑，
    现在盖一层 `<EmptyEditor/>`（水印 + 基础快捷键 + 中央入口，仿 VS Code 空编辑组）。
    ⚠️ 那层占位第一版**按钮点不动**：dockview 自己有个全屏的 `.dv-watermark-container`
    （`z-index: 1`，它拿来做空组的拖放目标）压在上面。jsdom 看不见这一层，
    是 `ui:startup` 第 7 段的 `elementFromPoint` 命中判定抓出来的 ——
    **能给"可点"下断言就别只靠 Playwright 的点击超时**（超时会让整个脚本崩掉，
    而不是报一条红）。
    ⚠️ 环境差异一条：jsdom 里"折叠→展开"会抛
    `Panel constraints not found for index 3`（react-resizable-panels 用 ResizeObserver
    的 `borderBoxSize` 量 group 尺寸，量到 0 就整段 `return`，`separatorToPanels` 于是
    一直是旧的）。真浏览器连折带展 3 轮都干净 —— **别拿这个去改布局**，
    把回路交给 `ui:startup` 第 6 段，jsdom 里只测"按钮 → store"那一跳。

27. **"反向核对"需要一份独立于被测数据的金标，否则是循环论证。**
    移植 DSH「打开方式」时我写了一条看起来很像样的核对：
    "本机装了目录里声明的那些 bundle，就必须都被解析出来"。
    它**抓不到它最该抓的错**：把 `iTerm.app` 写成 `iTerm2.app`，那个 bundle 就变成
    "没装"，断言根本不触发 —— 判定"装没装"用的是**同一份被怀疑的数据**。
    做法：把 DSH `catalog.ts` 的 macOS bundle 拼写**再抄一遍**当金标
    （`DSH_MAC_BUNDLES`），于是 ①目录必须逐字包含金标里的拼写（拼写漂移当场红）；
    ②金标里那些 bundle 在本机真实存在的，必须解析出来（定位链断了也红）。
    通则：写"X 必须都在结果里"之前先问一句"我拿什么判定 X 应该存在"——
    如果那个判据来自被测对象本身，这条测试只能证明自洽。
    同一个方法也用在了"图标"上：`ui:startup` 断言菜单里**真图标与通用图标两条渲染路径都出现**，
    而不是断言"图标都拿到了"（后者在"全都退化成方块"时照样绿）。

28. **跨进程/IPC 的载荷要校验形状，别信 TypeScript 的返回类型。**
    `loadApps()` 写的是 `cmd<string[]>('open_in_app_list')`，类型上它一定是数组；
    实际运行期后端可能回**任何东西**（旧版后端、反序列化失败、以及最常遇到的：
    测试里那种 `return {}` 的通配 mock）。少一步 `Array.isArray` 校验，
    渲染期就是 `apps.find is not a function` —— **整棵会话树跟着卸载**，
    而"打开方式"本来只是个可有可无的按钮。
    这次是**既有用例**逼出来的：`app-init` / `empty-editor` / `sidebar-rail` 三处
    通配 mock 都回 `{}`，装上新组件后那三处全红。DSH 的 controller 同样有
    `if (Array.isArray(payload.apps))` —— 不是防御性编程，是跨进程序列的常态。
    通则：**每一个新加的"页面级一次性读取"都会打到所有通配 mock 上**；
    要么校验形状后降级，要么准备好改一堆既有用例。
    同一轮补上的另一半门禁：`src/test/ipc-names.test.ts` 把**前端 `cmd('x')` 的字面量**
    与 Rust `generate_handler!` 的注册表对了一遍 —— 跨进程的**命令名是字符串**，
    拼错一个字母编译期毫无反应，而浏览器门禁跑的是 mock，**永远看不见**。
    （反证：前端改成 `open_in_app_lst` → 红；Rust 侧删掉一行注册 → 红。）


29. **"表写好了"不等于"接线接上了"：一份被写出来却没人调用的表，就是静默降级。**
    上一轮加了 55 门语言的懒加载表（`monaco-langs.ts`：`EXT_LANG` 150 项 + 整文件名表 + 55 个
    loader + 8 条测试 + 门禁"只许下这两门"），但**预览头部还在用它自己那张 16 项的本地表**：
    `.rs`/`.java`/`.toml`/`.rb`/`.php`/`.sql`/`Dockerfile`… 全部落进 `plaintext` ——
    语言条写着 plaintext、正文一行不上色，而那 8 条测试与门禁（当时只开 md/go）**全是绿的**。
    本轮做文件级「打开方式」时顺手发现（要在同一个文件里加按钮），改成 `langForPath` 一处判定，
    并把门禁第 9 段换成 `.rs`（只在新表里）来锁死。
    通则：**新写了一张"查表函数"之后，必须找到它的每一个应该被调用的地方**；
    找不到调用点的表要按"未接线"对待。同族的有：`needsLoad`、`seti-icons`、主题令牌表。
    （反证：只把 `.rs` 改回本地表行为 → 门禁第 9 段立刻报"lib.rs 的语言条是 plaintext，应为 rust"。）

## 4. 未完成 / 待决策

| 项 | 说明 |
|---|---|
| **M3 剩余** | ①在 GUI 里对真实仓库点一次 `parallel-review`（需人开 `tauri dev`）；②dockview lane 分列监控 / 模板自定义编辑 |
| **发布门禁 G1（updater）** | 注意：这个 G1 是 docs/14 §7 的**发布门禁**编号，跟 docs/00 目标表里那个 G1（完整对话体验）同名但无关。`tauri.conf.json` 仍指向 `updates.piggy.invalid` + 空 pubkey。需产品决策（更新源 + 签名密钥）。**不能只删配置块**——`tauri_plugin_updater` 已在 `lib.rs` 注册，删了会复现历史 panic |
| 主题外壳颜色 | 目前只复用了 VS Code 的 `tokenColors`；整套主题还要先做"注册表默认值层"（docs/13 E4） |
| codicon 双份 | 构建产物里两份 `codicon.ttf`（Piggy 一份 + Monaco 自带一份），约 150 KB 冗余 |
| **`pnpm lint` 是空转** | docs/08 §4 与 docs/10 §2.2 都写着某些红线"lint 强制"，但 `apps/desktop/package.json` **没有 `lint` 脚本**，`pnpm -r --if-present lint` 一个文件都扫不到。手工 `npx eslint .` 现存 **189 error / 35 warning**（含 `no-undef` 打在 `src-tauri/resources/*.js` 这类构建产物上）。二选一：①接上 lint 并清存量（要先把构建产物加进 ignores）；②把文档里的"lint 强制"改成实际执行者（本轮预览语言表那条红线就是这么办的——由 `src/test/preview-lang.test.ts` 承担） |
| `@monaco-editor/react` 未被使用 | 在 `apps/desktop/package.json` 依赖表里，但全仓没有任何 import（预览用 `MonacoHost` 直接持有 `monaco-editor`）。可直接删，或按 docs/10 §2.2 的旧描述接回来 |
| 左侧"常驻视图轨"没做 | docs/04 §1.2 原本规划了一条常驻的 L 轨（VS Code 活动栏语义：切换 会话/Fleet/搜索/资源）。目前只有**折叠态**才出现的 56px 图标轨（= DSH 的折叠侧栏）。两者不是一回事，别混 |
| `SIDEBAR_AUTO_COLLAPSE = 1024` 没接 | docs/12 §1.5：视口 < 1024px 自动折叠侧栏。Piggy 是纯百分比布局，620px 窗口下侧栏被压到 122px 也不折叠。现在折叠是安全的（有图标轨可点回来），接不接是产品决策 |
| 「打开方式」文件级的 **Windows 处理器枚举** | DSH 为此内嵌了一段 C#（`SHAssocEnumHandlers` + `IShellItem` + `SHDefExtractIcon` COM 互操作）。本机无法验证，所以**没写**：Windows 上关联列表返回空，主按钮退成「显示文件位置」，`open`/`reveal` 仍可用（`Invoke-Item` 与 `explorer /select,<file-url>`，后者的 URL 编码有单测）。指定应用打开在 Windows 上明确报错（而不是静默乱开） |
| 「打开方式」文件级的 **Linux 真机** | `gio info` / `gio mime` / desktop entry 解析都有夹具单测（含嵌套 desktop id、`Name[zh_CN]` 回退、默认项排序），但**没在真 Linux 桌面上跑过** |
| 「打开方式」的 **Windows 图标** | DSH 那一支用生成的 PowerShell 调 `ExtractAssociatedIcon`（32px）。**本机无法验证**，所以没写：`icons.rs::icon_png(IconSource::Executable)` 直接返回 `None`，前端退化成通用圆角方块（不残废，只是不显示真图标）。要补需在 Windows 上实测 |
| 「打开方式」的 **Windows/Linux 定位链** | 已按 DSH 逐条移植，并有脚本化假宿主的单测（`reg.exe` 输出解析、`.desktop` 解析、版本目录数值排序、`TryExec→Exec` 回退、无 DISPLAY 时 `xdg-open` 不出现），但**没有在真 Windows/Linux 机器上跑过**。macOS 那一条是真机验证过的 |
| 「打开方式」真机弹窗 | **已由用户手动确认**（2026-09-24：点了就弹出来了）。自动化侧覆盖：①解析结果里每个启动器都真实存在于磁盘；②图标真抠出来（128×128 PNG）；③启动语义用真实进程测了四态（仍在跑=成功 / 早退非零=失败 / 退出 0=成功 / 不存在=Missing）。剩下没自动化的是「操作系统把窗口开出来」这一步本身 —— 需要驱动 Tauri 窗口，agent 侧没有这个能力 |
| 「打开方式」的 **分屏假设** | `openin.pick` 命令发的是**无载荷信号**，谁在听谁展开菜单。M1 是单组布局（非活动 tab 卸载 DOM），同时只有一个会话头部在听；M3 分屏之后会**同时展开两个菜单**。到时要给信号加 tabId 过滤（代码里已留注释） |
| 「打开方式」的 **文件级入口** | DSH 还把「打开方式」注入到右侧文档预览的 actions（对**当前文件**打开）。Piggy 只做了工作区目录那一档（会话头部）。文件级要等预览 tab 的 action 位 |
| **WebKit 渲染** | 未验证（本机缺"屏幕录制"权限 + Playwright WebKit 挂死）。打包版已在真机跑通，但那是启动路径，不等于逐像素复核 |
| dockview 主题变量漂移 | 已补齐当前被引用的全部变量，但 dockview 升级时可能新增。`src/styles.css` 的 dockview 段落记了自检方法（按"被引用且无 fallback"算差集） |
| 自定义 pi 的配置目录 | `pi_files.rs` 硬编码 `$HOME/.pi/agent`，且 spawn 时**不传** `PI_CODING_AGENT_DIR`（`SpawnArgs.envs` 已具备透传能力，只差设置项）。要支持需加设置项（docs/17 §2.3） |
| `--tools` 与插件工具 | 限制档位的白名单会连**扩展/自定义工具一起过滤**（pi 的设计）。自定义 pi 的插件工具只在「完全权限」档可见。若希望插件只读工具在限制档也可用，需改用 `--exclude-tools` 语义并重新论证边界 |
| pi 扩展 API 版本耦合 | `packages/piggy-bridge` 的类型对着 pi 0.87.1 校验；pi 升级后需重跑 `pnpm --filter piggy-bridge typecheck` 与 `pnpm test:contract`（C12–C14）。这是唯一会因 pi 升级而静默失效的接缝 |

## 5. 验收方式

**已完成。** `pnpm tauri dev` 起窗、人工确认渲染正常（2026-09-23）；
打包版 `Piggy.app` 启动 0 条 webview 错误，日志确认以 `workspace` 档拉起 pi 并加载包内守卫脚本。

agent 侧没有窗口截图能力（本机缺"屏幕录制"权限，见第 4 节），因此这一步必须人工做。
后续若再遇到界面异常，终端会直接打出 `[piggy][webview][ERROR] ...`（`ErrorBoundary`
与全局 handler 经 `webview_log` 转发），把那段贴出来即可定位，不必靠猜。
