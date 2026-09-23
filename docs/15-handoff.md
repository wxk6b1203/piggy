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
| `vitest` | **173/173**：apps/desktop 173（18 文件，含 20 条守卫扩展、16 条失败回合可见性、9 条布局生命周期判据、2 条恢复时序、8 条 fleetStore、9 条 FleetView、11 条 Composer 斜杠补全、44 条代码块高亮/折叠/源码门、**4 条同一会话重复打开去重**）+ `packages/piggy-bridge` 32（含产物新鲜度门禁）+ `packages/pi-protocol` 30 |
| `cargo test` | **89 + 3 + 1** + fixtures 全绿（新增 fleet 状态机/结果收集/容量排队 16 条、argv 组装 8 条、扩展资源定位 4 条） |
| `cargo test --features contract` | **15/15 全绿**（pi 0.87.1 真实跑，含新增 C12 bridge 数据面 / C13 降级 / C14 两 lane DAG） |
| `ui:debug --strict` | 零 pageerror / 零 console error / 零布局问题（退出码 0） |
| `ui:startup` | 全绿，第 4 段覆盖：右栏 Fleet 面板 → A 层启动 3 条 lane（scout/review/build，验证 camelCase 参数名）→ steer 回车清空 → B 层刷新后 PIGGY:1 载荷落到面板（reviewer · correctness）→ **斜杠补全真滚动**（52 行、`scrollHeight 1508 > clientHeight 258`、`scrollTop` 真的变了、滚到底最后一条在可视区内）→ **代码块真高亮**（4 张卡 / diff 1 增 1 删 1 块头带底色 / go 的 token 有 4 种颜色 / 静默失败数 0） |
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

## 4. 未完成 / 待决策

| 项 | 说明 |
|---|---|
| **M3 剩余** | ①在 GUI 里对真实仓库点一次 `parallel-review`（需人开 `tauri dev`）；②dockview lane 分列监控 / 模板自定义编辑 |
| **发布门禁 G1（updater）** | 注意：这个 G1 是 docs/14 §7 的**发布门禁**编号，跟 docs/00 目标表里那个 G1（完整对话体验）同名但无关。`tauri.conf.json` 仍指向 `updates.piggy.invalid` + 空 pubkey。需产品决策（更新源 + 签名密钥）。**不能只删配置块**——`tauri_plugin_updater` 已在 `lib.rs` 注册，删了会复现历史 panic |
| 主题外壳颜色 | 目前只复用了 VS Code 的 `tokenColors`；整套主题还要先做"注册表默认值层"（docs/13 E4） |
| codicon 双份 | 构建产物里两份 `codicon.ttf`（Piggy 一份 + Monaco 自带一份），约 150 KB 冗余 |
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
