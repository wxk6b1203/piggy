# 15 · 会话交接（2026-09-23）

> 用途：给**下一个接手的 agent / 会话**的一页速览，避免重读全过程。
> 设计细节见 [12](12-dsh-ui-spec.md)/[13](13-vscode-asset-inventory.md)/[14](14-ui-assessment-and-dsh-alignment.md)。
> pi 的配置来源与扩展机制见 [16](16-pi-config-and-extensions.md)；
> 权限档位与自定义 pi 打包见 [17](17-pi-permissions-and-packaging.md)。

## 1. 当前状态

DSH UI 对齐 + 权限档位 + pi 打包修复 + **子代理双层（M3）** + **提供商配置页（本轮）** 已完成并验证。

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` | 通过（apps/desktop + packages/piggy-bridge，后者对着真实 pi 类型） |
| `vitest` | **320/320**：apps/desktop **253**（28 文件，含 20 条守卫扩展、16 条失败回合可见性、9 条布局生命周期判据、2 条恢复时序、8 条 fleetStore、9 条 FleetView、11 条 Composer 斜杠补全、44 条代码块高亮/折叠/源码门、4 条同一会话重复打开去重、5 条子代理委派开关、8 条预览语言表、5 条折叠侧栏图标轨、4 条空编辑区占位、22 条「打开方式」、6 条 Monaco 池策略、2 条 IPC 命令名契约、**17 条提供商配置页**、**8 条提供商 IPC 边界**、**3 条 mock 形状跨语言金标**）+ `packages/piggy-bridge` **37**（含产物新鲜度门禁 + 5 条自动激活判据）+ `packages/pi-protocol` 30 |
| `cargo test` | **197 + 3 + 11**（另有 2 条 `#[ignore]` 的真机核对：`real_home` / `real_network`）全绿：fleet 状态机/结果收集/容量排队 16 条、argv 组装 13 条（含**委派开关的档位组合/缺失 fail-closed**）、扩展资源定位 4 条、「打开方式」64 条（目录表自检 / 三平台定位链 / 观察窗四态真进程 / macOS 真机解析与图标提取 / 文件关联真机查询 / 路径校验与拒绝面 / base64 向量）、**提供商 40 条**（生成目录的自检 + 手写金标 / 总览合成的来源与优先级 / models.json 增删改与未知字段保留 / **真 socket 的列举请求与解析**（含 401、非 JSON、超大、单行坏数据）/ auth.json 写入往返） |
| `cargo test --features contract` | **15/15 全绿**（pi 0.87.1 真实跑，含 C12 bridge 数据面 / C13 降级 / C14 两 lane DAG）；另 IPC 契约 **11** 条：`fs_list_dir` 形状 + 「打开方式」id 数组 / 图标真的是 128×128 PNG data URL / 文件关联 `{id,name,default,icon}` 形状 / 目录也能查关联 / 拒绝面 + **提供商行键集合逐个锁死**、保存返回值与落盘一致、被拒请求一个字节都不写 |
| `ui:debug --strict` | 零 pageerror / 零 console error / 零布局问题（退出码 0） |
| `ui:startup` | 全绿，第 4 段覆盖：右栏 Fleet 面板 → A 层启动 3 条 lane（scout/review/build，验证 camelCase 参数名）→ steer 回车清空 → B 层刷新后 PIGGY:1 载荷落到面板（reviewer · correctness）→ **斜杠补全真滚动**（52 行、`scrollHeight 1508 > clientHeight 258`、`scrollTop` 真的变了、滚到底最后一条在可视区内）→ **代码块真高亮**（4 张卡 / diff 1 增 1 删 1 块头带底色 / go 的 token 有 4 种颜色 / 静默失败数 0） |
| `ui:startup` 第 5 段 | **文件预览真高亮**：README.md 语言条 `markdown` + 4 种 token 类 / 3 种颜色（标题 `rgb(86,156,214)`）；main.go 9 种颜色（注释绿/关键字蓝/字符串橙）；`notes.zzz` 老实 `plaintext` 只有 1 色；外加**按需门**（开了 2 个文件只许下 `markdown`/`go` 两门语言定义，多一门就红） |
| `ui:startup` 第 6 段 | **折叠侧栏不许进死胡同**：关掉全部标签 → 收起侧栏 → 断言图标轨恒 56px + 展开按钮 36×36 + 三个按钮都有可访问名 → 点回来 → 侧栏 254px、图标轨消失、标签数不变；连做 2 轮 |
| `ui:startup` 第 7 段 | **空编辑区占位**：关光标签 → 水印 🐷（opacity ≤0.15）+ ≥5 条快捷键（逐条与**应用自己那份命令注册表**核标题与键位）+ ≥3 个中央入口；每个入口做 `elementFromPoint` 命中判定（防被 dockview 的 `.dv-watermark-container` 盖住）+ 真点一下建出标签 + 再关光后占位回来 |
| `ui:startup` 第 8 段 | **「打开方式」分裂胶囊**：会话头部右侧**位置对**（`.pg-session-head-ops` 内、置灰占位已被替掉、「更多」占位还在）+ **够显眼**（26px 高、1px 边框、≥70px 宽、`elementFromPoint` 可点）+ 菜单**向下弹且不出屏** + 5 项里真图标与通用图标**两条渲染路径都出现** + 点 GoLand → **送给宿主的是 `{id:'goland', path:<会话 cwd>}`** + 选择落 localStorage + 重载后冷启动读回 |
| `ui:startup` 第 9 段 | **「打开方式」文件那一档**（预览头部，真浏览器）：胶囊在文档动作位的**最后一格**、compact 24px、有边框、`elementFromPoint` 可点、主按钮名字 = **系统默认应用**（Typora.app）且真图标渲染出来 → 点主按钮送出 `{path:<预览的那个文件>, action:'open', application:'/Applications/Typora.app'}` → 菜单 2 个处理器 + 「显示文件位置」（真图标与通用方块两条路径都出现）→ 点它送出 `{action:'reveal', application:null}`。**顺带锁住语言判定**：`lib.rs` 的语言条必须是 `rust`、token 类 ≥2（预览头部原来那张 16 项本地表认不出 `.rs`） |
| `ui:startup` 第 10 段 | **Monaco 实例池**（真浏览器）：连开 8 个预览标签 → 池里活着 ≤ 水位（实测恒 6）、界面上零「已达上限」提示、当前预览有实例且语言条 `rust` → 切回第 1 个（多半已被回收）→ 编辑器**重建**、token 类 ≥2、首行内容正确 → 全程堆增长 ≤40MB。（旧行为：第 7 个标签直接显示「请关闭部分预览标签」，且关掉也不恢复） |
| `ui:startup` 第 11 段 | **提供商配置页**（真浏览器 + mock IPC）：左导航 `模型/通用设置/高级` → 列表两行（自定义/默认标记 + 状态点 + **密钥来源写在 meta 里**）→ 点「编辑」出卡片（密钥框提示"已配置"、自定义设置默认折叠）→ 点「检测」**真发 `provider_discover`**（带 provider/baseUrl/api，密钥留空=用已存的那把）且界面写出"连上了哪个地址、列了几个模型" → 「获取可用模型」把清单拉进对话框（已在表里的禁用）→ 勾一个「添加所选」进模型表 → 输密钥点「保存」→ **先 `provider_save` 再 `provider_set_key`**、存储位置跟随现状（这一行本来在 models.json 就还写 models.json）、列表 meta 刷新 + "已保存 XX" 回执 → 从目录添加（下拉里已配置的不出现、地址预填目录默认值、保存后进列表） |
| `ui:startup` 第 12 段 | **用户反馈的两个坑**（2026-09-24）：①「检测」按钮几何（`white-space: nowrap` + `scrollHeight≈clientHeight` + 高 ≤36px，实测修前 51×44 竖排 → 修后 54×27）；②两次进「高级」内容必须一致（第一次 14 行 → 第二次 14 行；修前第二次是 1 行 `{}`）且**保存按钮必须仍是灰的**（编程式写入不算编辑）；③**编辑器贡献**（折叠控件 >0、⌘F 真按键唤出 `.find-widget`）—— 这条刻意排在打开「高级」**之前**，否则 JSON 语言服务会把贡献自己拽进依赖图，核对永远绿 |
| 真机 `~/.pi/agent` 跑总览 | `cargo test --lib -- --ignored real_home --nocapture` 打印出这台机器上配置页会显示的两行：`DeepSeek (cc-switch-deep-seek)` / `Zhipu GLM (cc-switch-zhipu-glm)`，**密钥来源都是 `models_json`（内联）**、默认项是后者、内置目录 41 条 10 种协议。这正是这个功能存在的理由：本机 auth.json 是空的，**旧配置页因此什么也不显示** |
| 真机网络核对 | `cargo test --lib -- --ignored real_network --nocapture`：不带密钥打 `https://api.deepseek.com/models` → 拿到 `HTTP 401（API 密钥可能不对或没有权限）：Authentication Fails (governor)`。证明 DNS + TLS + 真 HTTP + 状态码映射 + 端点原文这一整条链路是通的（刻意不用用户的密钥） |
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

30. **同一个东西能存在三处时，界面必须显示"哪一处生效"。**
    pi 解析 API 密钥的优先级是 `auth.json` 凭据 > `models.json` 的 `apiKey` > 环境变量
    （`provider-composer.ts:347-375`）。而本机真实形态就是"两处都有"：cc-switch 那类工具把密钥
    写进 models.json，auth.json 是空的。如果配置页只写"已配置"，用户改了 models.json 里那把旧 key
    会以为生效了 —— 实际一直是 auth.json 里那把在赢。**这类"改错了也不知道"比报错难查十倍。**
    所以 `provider_overview` 的每一行都带 `keySource`/`hasInlineKey`，列表与编辑卡片都显示来源，
    两处都有时给黄条警告 + 一键"从 models.json 删掉它"（门禁第 11 段核对 meta 里真的有来源）。
    通则：**凡是"有默认值 / 有回退 / 有多来源"的配置项，界面上都要能看出当前生效的是哪一个**
    （同族：pi 二进制来源、会话目录、API 地址来自目录还是 models.json）。

31. **异步到达的值必须能写进"已经建好的东西"里——初值只在创建那一刻取一次，就是一颗定时炸弹。**
    Monaco 的 `editor.create({ value })` 只认创建时的值。设置页的 JSON 是 IPC 读回来的，
    第一次打开「高级」时 Monaco 还在下 chunk，值先到 → 看起来一切正常；**第二次打开 chunk 已在内存里**，
    编辑器在一个微任务内建好、值还没回来 → 界面永远停在初始的 `{}`。
    用户的原话是"第一次点击高级会有配置，第二次点击就没了"（2026-09-24），
    而**所有既有门禁都是绿的**：jsdom 跑不了 Monaco、浏览器门禁当时只开过一次「高级」。
    修法：给组件加"外部值同步"（只在真的不同时写），并用 `v === valueRef.current` 把编程式写入
    与用户打字区分开 —— 否则载入会被当成编辑，保存按钮会在什么都没改的时候亮起来。
    通则：**凡是把"值"交给一个会长期活着的对象（编辑器/播放器/图表）的地方，都要问一句
    "值晚到会怎样、值变了会怎样"**。同族：`MonacoHost` 的 `language`、`Picker` 的 items。
32. **"看起来像坏了"的几何问题，jsdom 一条都量不到。**
    配置页的「检测」按钮在 flex 行里被挤窄，中文按钮的 min-content 宽度 = **一个字**，
    于是"检测"两字各占一行、按钮变成 51×44 的竖排方块（用户截图："检测的字体变竖了"）。
    jsdom 没有布局，这类 bug 只有真浏览器能量：门禁现在断言 `white-space: nowrap` +
    `scrollHeight ≈ clientHeight` + 高度 ≤36px。
    通则：**给按钮加 `white-space: nowrap` 应当是全局默认**（宁可溢出也不要竖排），
    flex 行里被挤压的应当是输入框而不是按钮（`flex: none`）。
    同族：菜单出屏、被水印层挡住、胶囊高 0px —— 都是"DOM 对了但人看不到"。

33. **"开关"这种控件会替用户脑补一套语义；当底层的语义不是布尔时，必须把依据写在旁边。**
    pi 没有 `enabled` 字段，停用只有 `-`/`!` 通配符（松散扩展）与 `autoload:false`（包）
    两条路，而且**每个来源只受自己那个作用域的通配符影响**（全局的 `-x` 管不到项目发现目录）。
    插件页因此每行都带 `enabledBy`（展开可见），写的是"哪份 settings.json 里的哪条规则"。
    只说"已停用"是同义反复——用户想知道的是**他该去改哪儿**。
    同族：模型页的 `keySource`、pi 二进制来源、会话目录（规矩 30）。
    反面教材就在这一页的开关上：一旦只给开关不给依据，"我明明开着 pi 却没加载"
    和"我点了停用它还在跑"这两类问题都无从查起。

34. **门禁的选择器写错，是不会报错的——它只会静默地什么都没选中，然后断言"没打开"。**
    插件页的门禁一开始用 `.ant-modal-content` 找对话框。那是 **antd v5 的类名**；
    6.6.5 换成了 rc-dialog 1.10 的结构，只生成 `-body` / `-footer`
    （`@rc-component/dialog/es/Dialog/Content/Panel.js:59,101`），没有 `-content`。
    于是弹窗明明开着、里面的按钮也点得到，断言却一路判"没打开"，还连带
    编出一个"弹窗要 6 秒才出现"的假象（实测改对选择器后是 **101ms**）。
    通则：**门禁里选择器选空时要当成失败，而不是当成"条件不成立"**；
    能用 `[role=...]` 或 `data-*` 就别用组件库的内部类名（它们随版本改）。

35. **"隐藏元素 focus() 会静默失败"——而这正是菜单类组件的第一帧。**
    右键菜单要先按原坐标渲染、量出尺寸、再挪到贴边内收的位置；量尺寸那一帧必须
    `visibility: hidden`（否则会看到菜单从错位置跳一下）。于是"打开就聚焦"如果写在
    普通 effect 里，跑的是**隐藏的那一帧**，`focus()` 静默失败：菜单看着完全正常，
    键盘却一点用没有（Escape 关不掉、方向键没反应）。
    **jsdom 的 focus 不做可见性判断，所以单测永远"通过"**——这条是浏览器门禁量出来的。
    修法：把焦点动作挂在"位置算完"这个状态上（`ready = pos !== null`），而不是挂在"打开了"上。
    通则：**凡是"先渲染再测量再调整"的组件，任何依赖最终布局的副作用都要等测量之后**。
    同族：菜单出屏、tooltip 定位、Monaco 的 layout()。

36. **一个动作有多个入口时，"哪个入口做了什么"必须收敛到一个函数。**
    会话标题生成有三个入口（右键菜单、行上图标、命令面板）。分叉的表现不是崩溃，
    而是**只在某一条路上复现的怪事**："右键生成完侧栏变了、图标生成完没变"
    （某个入口忘了重新拉列表）、"某条路上能连点两次"（某个入口没判 busy）。
    Piggy 里这类"多入口"已经不少（新建会话的 ⌘N 与图标轨、打开方式的分屏假设），
    做法统一是：入口只负责"拿到参数"，行为写在一个函数里。

37. **Rust 的 struct 漏了 `rename_all = "camelCase"` 时，两边都不会报错——只是把 `NaN` 渲染给用户。**
    真机点「生成标题」，用户收到的是：
    `标题已更新为「问候与日期询问」（cc-switch-zhipu-glm/glm-5.3-flash · NaNs · 素材 undefined 字）`。
    根因是 `Generated` 发 `elapsed_ms` / `prompt_chars` / `model_id`，前端读 `elapsedMs` /
    `promptChars` / `modelId`：`undefined / 1000` 是 `NaN`，模板串照单全收。
    **为什么门禁全绿也抓不到**：前端单测与浏览器门禁跑的都是 **mock**，而 mock 是按前端读法
    手写的——两边自洽，真机那一侧没有任何检查。这与规矩 27 是同一件事的另一面：
    **两份手写清单互为金标**，前提是**两侧都有测试各自对着自己的实现**。
    修法：① 结构加 `rename_all`；② `ipc_contract.rs` 里逐个键名写死（不复用字段名）；
    ③ 前端在 IPC 边界归一化（`normalizeTitleResult`），让任何漂移退化成"少说一句"
    而不是 `NaN`。
    顺带扫出**同类的第二起**：`PiBinary.from_env` vs 前端 `fromEnv`——
    表现是「被 `PI_BIN` 覆盖」那条警告**从来没显示过**（静默缺失，比 NaN 更难发现）。
    ⚠️ 扫描时**差点改坏一个对的**：`PathApplication` 字段叫 `is_default`，线格式却是
    `default`（字段级 `#[serde(rename)]`）。**判形状要看真正的序列化结果，不要看字段名**——
    这条被新加的契约测试当场拦下，也写进了那条用例的注释里。

38. **给人看的输出当接口用时，认不出就"整行丢掉"，别猜；一个都认不出时把原话交给用户。**
    pi 没有 `--json`（`cli/list-models.ts` 只打一张 padEnd 对齐的表），"标题模型"下拉只能解析它。
    这类解析的危险不在崩，而在**悄悄少几行**或**把列认错**：把 `1M` 当成 reasoning，界面就会
    显示"这个模型不支持思考"——一个看起来很像事实的错误结论。所以规则是：
    表头按**首两列的字面量**识别（不靠"第一行是表头"，pi 以后加一行 banner 也不会错位）；
    列数不对、`thinking` 列不是 `yes`/`no` 的行**跳过**；解析结果为空时把 pi 的**原话**
    （`note`）交给界面显示——"没配密钥"和"表格变了"是两件完全不同的事，界面必须说清是哪件。
    用**真输出**当金标（`parses_the_real_list_models_table`），另有一条 `--ignored` 的
    `real_machine_lists_models_from_pi` 真的去跑这台机器上的 pi。

39. **外部 CLI 对不认识的参数常常"只警告不报错"，所以本地必须自己校验一遍。**
    pi 拿到 `--thinking bogus` 时只在 stderr 打一行
    `Warning: Invalid thinking level "bogus"`，然后**静默用默认档**把活干完（真机验证过）。
    也就是说：拼错一个字母 = 用户以为设了、实际没设，界面上**完全看不出区别**。
    更麻烦的是"值合法但模型不支持"这一层：pi 的 `clampThinkingLevel` 会按模型声明的能力
    把它换成另一档（用本地假服务器抓请求体实测：请求 `xhigh` 发出 `high`、请求 `low` 发出
    `medium`，不支持推理的模型直接把 `reasoning_effort` 整个省掉）。结论两条：
    ① 档位清单**照抄 pi 且两侧互为金标**（`title.rs::THINKING_LEVELS` ↔ `lib/thinking.ts`），
    写配置时报错、读配置时丢掉非法值；
    ② 客户端**拿不到**收敛后的实际值，就别假装知道——报"请求值"，并在界面上写明
    "pi 还会按模型能力再收敛一次"。宁可说清楚，也不要让用户以为选了就一定按选的走。

40. **测量工具自己会说谎：`page.evaluate` 返回的是"evaluate 结束那一刻"的序列化结果。**
    门禁要核对"选了模型之后存下来的是什么"，探针开头写了 `const base = cfg()`。
    但 `cfg()` 返回的是模块里那**同一个对象**的引用——Puppeteer 等 evaluate 整体跑完才序列化，
    于是 `base` 读到的是**后面几步操作之后**的状态。表现是那条
    "核对开始时配置里就有思考档（xhigh），这条核对失去意义"的断言自己红了，
    而另外两条（`afterModel` / `afterThinking`）**看起来通过了**——它们读的也是最终状态，
    属于**假绿**。修法：每个快照都 `{ ...cfg() }`。
    教训：断言"某个时刻的状态"时，先确认那个快照**真的被拷下来了**；
    断言红了不一定是产品坏了，也可能是**尺子**坏了。

41. **`flex-wrap` 的换行是按 `flex-basis` 决定的，不是按内容宽度；而"哪几个在同一行"
    不能拿 `top` 比——同一行的按钮和下拉本来就不同高。**
    用户报"标题模型两个选择框换行了，缩一点"时，第一反应是调 `max-width`。
    没用：`flex-wrap` 先按每个 item 的**假定主尺寸**（`flex-basis`，被 min/max 夹住）
    贪心分行，**分摊伸缩发生在分行之后**。所以固定 `width: 320px` 时，哪怕它明明
    缩得下去，也会先把后面的控件挤到下一行。真正控制换行的旋钮是 `flex-basis`
    （180px）——宽窗口靠 `flex-grow` 再长回去，`max-width` 只封顶。
    另一个坑在**量法**上：第一版用"`top` 是否相同"判行数，而 antd 的 `Button`（24px）
    与 `Select`（32px）在 `align-items: center` 下 `top` 天然差 4px，于是同一行被数成两行——
    差点据此"修"一个不存在的问题。改用**中线相差 > 20px** 才算换行。
    这类几何只有真浏览器量得出来（规矩 32），所以三个宽度（1280 / 1180 / 900）
    各锁了一条门禁断言，反证时把它们退回固定宽度，报的正是用户看到的那句话。

42. **许可这类"事实散在多个文件里"的东西，要靠测试锁，不能靠人记得。**
    加 GPL-3.0 时同一个事实出现在四处：`LICENSE`（原文）、5 个 manifest 的 `license` 字段、
    README「授权」一节、`THIRD_PARTY_NOTICES.md`。它们的失效方式**全是静默的**：
    新加一个 workspace 包忘了写 `license`（`pnpm -r` 照样跑，只是那个包"保留所有权利"）；
    重排 `bundle.resources` 时把 `pi-LICENSE.txt` 顺手删掉（**打包完全成功**，
    只是安装包少了一张纸，而 MIT 的义务恰好就是那张纸）。
    所以 `src/test/license.test.ts` 逐个键断言（11 条），三条反证都确认变红。
    附带两条经验：
    · **GPL 原文一个字都不能改**（原文写着 *changing it is not allowed*），所以落地前先
      逐字节对拍上游——本机随手找的副本就有一份是**被 FSF 更新过版权行**的
      （wget 的 `COPYING` 写 `2007, 2023`，gnu.org 是 `2007`），拿错就等于改了原文；
    · `or later` **不在 GPLv3 原文里**（原文只写 v3），它必须由**项目自己的声明**表达
      —— README 的 notice 段 + `license` 字段写 `GPL-3.0-or-later`，两者缺一不可。

## 4. 未完成 / 待决策

| 项 | 说明 |
|---|---|
| **GPL §5(d) 的「Appropriate Legal Notices」还没有界面** | GPLv3 对**有交互界面**的作品要求显示版权声明 + 无担保声明 + 如何查看许可（§0 定义、§5(d) 义务）。现在这三样只存在于仓库文件里，应用内**没有任何入口**（侧栏那颗 `Piggy v0.1.0` 是纯文本，点不动；设置页也没有「关于」）。分发安装包之前应当补一个：点版本号 → 弹「关于」，含 `Copyright (C) 2026 wxk6b1203`、无担保那句、LICENSE 全文入口（可复用 `resources/pi-LICENSE.txt` 的做法把 LICENSE 也打进包）。本轮只做了文件层（LICENSE / manifest / README / THIRD_PARTY_NOTICES + 一致性测试），界面这一层**没做** |
| **M3 剩余** | ①在 GUI 里对真实仓库点一次 `parallel-review`（需人开 `tauri dev`）；②dockview lane 分列监控 / 模板自定义编辑 |
| **发布门禁 G1（updater）** | 注意：这个 G1 是 docs/14 §7 的**发布门禁**编号，跟 docs/00 目标表里那个 G1（完整对话体验）同名但无关。`tauri.conf.json` 仍指向 `updates.piggy.invalid` + 空 pubkey。需产品决策（更新源 + 签名密钥）。**不能只删配置块**——`tauri_plugin_updater` 已在 `lib.rs` 注册，删了会复现历史 panic |
| 主题外壳颜色 | 目前只复用了 VS Code 的 `tokenColors`；整套主题还要先做"注册表默认值层"（docs/13 E4） |
| codicon 双份 | 构建产物里两份 `codicon.ttf`（Piggy 一份 + Monaco 自带一份），约 150 KB 冗余 |
| **`pnpm lint` 是空转** | docs/08 §4 与 docs/10 §2.2 都写着某些红线"lint 强制"，但 `apps/desktop/package.json` **没有 `lint` 脚本**，`pnpm -r --if-present lint` 一个文件都扫不到。手工 `npx eslint .` 现存 **189 error / 35 warning**（含 `no-undef` 打在 `src-tauri/resources/*.js` 这类构建产物上）。二选一：①接上 lint 并清存量（要先把构建产物加进 ignores）；②把文档里的"lint 强制"改成实际执行者（本轮预览语言表那条红线就是这么办的——由 `src/test/preview-lang.test.ts` 承担） |
| `@monaco-editor/react` 未被使用 | 在 `apps/desktop/package.json` 依赖表里，但全仓没有任何 import（预览用 `MonacoHost` 直接持有 `monaco-editor`）。可直接删，或按 docs/10 §2.2 的旧描述接回来 |
| ~~左侧"常驻视图轨"~~ **已决定不做**（2026-09-24） | docs/04 §1.2 曾规划一条常驻的 44px L 轨（VS Code 活动栏语义）。查 DSH 源码：`ui-layout/.../AppFrame.tsx:183-186` 写明 *neither platform keeps an icon rail* —— 折叠后的重开控件走标题栏（macOS `shell.leading` 座位 / Windows caption 行）。而且左栏只有一个视图（会话列表），轨上没有可切的东西。**计划已从 docs/04 删除**；左侧只有折叠态那条 56px 轨（`SidebarRail`），右侧那条 40px 常驻轨（`RightBar`）保留（它本身也是对 DSH 的偏离 —— DSH 右栏用 dockview tab 条，若哪天要百分百对齐，该动的是这条） |
| `SIDEBAR_AUTO_COLLAPSE = 1024` 没接 | docs/12 §1.5：视口 < 1024px 自动折叠侧栏。Piggy 是纯百分比布局，620px 窗口下侧栏被压到 122px 也不折叠。现在折叠是安全的（有图标轨可点回来），接不接是产品决策 |
| 「打开方式」文件级的 **Windows 处理器枚举** | DSH 为此内嵌了一段 C#（`SHAssocEnumHandlers` + `IShellItem` + `SHDefExtractIcon` COM 互操作）。本机无法验证，所以**没写**：Windows 上关联列表返回空，主按钮退成「显示文件位置」，`open`/`reveal` 仍可用（`Invoke-Item` 与 `explorer /select,<file-url>`，后者的 URL 编码有单测）。指定应用打开在 Windows 上明确报错（而不是静默乱开） |
| 「打开方式」文件级的 **Linux 真机** | `gio info` / `gio mime` / desktop entry 解析都有夹具单测（含嵌套 desktop id、`Name[zh_CN]` 回退、默认项排序），但**没在真 Linux 桌面上跑过** |
| 「打开方式」的 **Windows 图标** | DSH 那一支用生成的 PowerShell 调 `ExtractAssociatedIcon`（32px）。**本机无法验证**，所以没写：`icons.rs::icon_png(IconSource::Executable)` 直接返回 `None`，前端退化成通用圆角方块（不残废，只是不显示真图标）。要补需在 Windows 上实测 |
| 「打开方式」的 **Windows/Linux 定位链** | 已按 DSH 逐条移植，并有脚本化假宿主的单测（`reg.exe` 输出解析、`.desktop` 解析、版本目录数值排序、`TryExec→Exec` 回退、无 DISPLAY 时 `xdg-open` 不出现），但**没有在真 Windows/Linux 机器上跑过**。macOS 那一条是真机验证过的 |
| 「打开方式」真机弹窗 | **已由用户手动确认**（2026-09-24：点了就弹出来了）。自动化侧覆盖：①解析结果里每个启动器都真实存在于磁盘；②图标真抠出来（128×128 PNG）；③启动语义用真实进程测了四态（仍在跑=成功 / 早退非零=失败 / 退出 0=成功 / 不存在=Missing）。剩下没自动化的是「操作系统把窗口开出来」这一步本身 —— 需要驱动 Tauri 窗口，agent 侧没有这个能力 |
| 「打开方式」的 **分屏假设** | `openin.pick` 命令发的是**无载荷信号**，谁在听谁展开菜单。M1 是单组布局（非活动 tab 卸载 DOM），同时只有一个会话头部在听；M3 分屏之后会**同时展开两个菜单**。到时要给信号加 tabId 过滤（代码里已留注释） |
| 「打开方式」的 **文件级入口** | DSH 还把「打开方式」注入到右侧文档预览的 actions（对**当前文件**打开）。Piggy 只做了工作区目录那一档（会话头部）。文件级要等预览 tab 的 action 位 |
| 编辑器**右键菜单**未验证 | 加载编辑器贡献后折叠与 ⌘F 已实测可用，但右键菜单在无头 Chrome 里用真实 `button:2` 点击仍未唤出 `.monaco-menu-container`（真机 `tauri dev` 里没试过）。**不声称它可用**；要确认需在真窗口里右键一次 |
| **WebKit 渲染** | 未验证（本机缺"屏幕录制"权限 + Playwright WebKit 挂死）。打包版已在真机跑通，但那是启动路径，不等于逐像素复核 |
| dockview 主题变量漂移 | 已补齐当前被引用的全部变量，但 dockview 升级时可能新增。`src/styles.css` 的 dockview 段落记了自检方法（按"被引用且无 fallback"算差集） |
| 自定义 pi 的配置目录 | `pi_files.rs` 硬编码 `$HOME/.pi/agent`，且 spawn 时**不传** `PI_CODING_AGENT_DIR`（`SpawnArgs.envs` 已具备透传能力，只差设置项）。要支持需加设置项（docs/17 §2.3） |
| `--tools` 与插件工具 | 限制档位的白名单会连**扩展/自定义工具一起过滤**（pi 的设计）。自定义 pi 的插件工具只在「完全权限」档可见。若希望插件只读工具在限制档也可用，需改用 `--exclude-tools` 语义并重新论证边界 |
| **提供商目录随 pi 版本漂移** | `provider/catalog_generated.rs` 是从 pi v0.87.1 源码生成的快照。pi 升级后必须重跑 `node apps/desktop/scripts/gen-provider-catalog.mjs <pi 源码根>`（可用 `--check` 复核）。不重跑不会报错，只会"少几个新提供商"或"某个 baseUrl 过时"—— 属于**静默漂移**，所以这一行留在这里当提醒 |
| 提供商「检测」的 **Windows/Linux 真机** | 列举端点的 URL/鉴权头规则有单测（含 anthropic 系的 `/v1/models` 与 `x-api-key`）、真 socket 集成测试、以及一次**真机网络**核对（`cargo test --lib -- --ignored real_network`：不带密钥打 `https://api.deepseek.com/models`，拿到 401 + 端点原文"Authentication Fails"）。但只在 macOS 上跑过；代理/企业证书等环境差异未验证 |
| 提供商「检测」的 **非标准鉴权协议** | Azure（`api-key` 头 + `api-version` 查询）、Codex（OAuth）这类**不猜**：`discovery.ts` 的 DSH 版本也把它们排除在外（"猜错会把鉴权失败报成'这家没有模型'"）。这些提供商仍可保存配置，只是「获取可用模型」会返回明确的"不支持列举" |
| 提供商「检测」的 **自定义 headers** | pi 支持 `providers.<id>.headers`（含 `${ENV}` 模板），但配置页不编辑它们，检测请求也不带 —— 靠 header 鉴权的网关会得到 401。要支持得先决定**怎么把带密钥的 header 安全地送到前端以外的 Rust 侧**（现在的做法是前端只送 baseUrl/api/一次性 key） |
| auth.json **没有原始 JSON 编辑器** | 有意为之：密钥只在 Rust 侧脱敏读出（`provider_list` 的 `keyMasked`），明文不进渲染进程。「高级」节只有 models.json / settings.json。要改密钥走「模型」页 |
| 提供商页的 **模型能力标记** | pi 的模型定义还有 `cost`、`compat`、`thinkingLevelMap`、`inputLimits` 等界面没暴露的字段。现在靠"未知字段原样保留"保证不丢，但没有表单 —— 要改用「高级」节的原始 JSON 编辑器 |
| **插件内置表随 pi 版本漂移** | `plugin/builtins_generated.rs` 是从 pi v0.87.1 源码的 `builtInExtensions` 生成的快照（目前只有 `llama.cpp`，且 `hidden: true`）。pi 升级后要重跑 `node apps/desktop/scripts/gen-plugin-builtins.mjs <pi 源码根>`（`--check` 可复核）。与提供商目录同类的**静默漂移** |
| 插件页的 **Windows/Linux 真机** | 发现规则、路径解析、通配符判定、落点布局都有单测，且有一条**真机核对**（`cargo test --lib -- --ignored real_machine`：读出这台机器真实的 3 个 npm 包 + `pi-guardrails` 发现目录 + `llama.cpp` 内置）。但只在 macOS 上跑过；Windows 的盘符/`\` 路径与 git-bash 路径未验证 |
| 插件**安装/升级没在真机上完整跑过一次** | 参数拼装（`plugin_cli_plan_matches_pi_flags`）与流式任务机制有单测 + 门禁（mock），但"点安装 → npm 真的从网上装下来"这一步要联网，没在自动化里跑。失败路径（网络/权限/依赖冲突）靠任务面板显示原始输出，**未实测各种失败文案** |
| 插件**工具名冲突会让 pi 直接退出** | 两个扩展注册同名工具时 pi 在**所有模式**下 `exit(1)`（`resource-loader.ts:1064-1100` + `main.ts:896-906`），而且是启动即失败。界面**不检测**这种情况（要检测得先真的加载一遍扩展）。用户看到的现象是"新装的插件一装上 pi 就起不来了"，只能靠 `pi -ne` 或删插件自救。已记在 docs/03 §2.15 的来源说明里 |
| 插件**没有权限模型** | pi 的扩展在进程内以用户权限运行，没有沙箱、没有签名、没有安装前审批（`docs/security.md`），`-a/--approve` 只管项目信任。安装对话框里有明确提示，但**这是提示不是防线** |
| 插件页的 **skills/prompts/themes** | pi 的 `PackageSource` 可以过滤四类资源（`extensions`/`skills`/`prompts`/`themes`），本页只做 `extensions`。启停包时会保留其它三类的规则（不清掉），但它们没有界面 |
| 插件**升级的版本比较** | 调 `pi update --extension <source>` 由 pi 自己判断（npm 比 `npm view`、git 比 `ls-remote`），界面**不显示"有新版"**（那需要额外的网络查询）。所以"升级"按钮是无条件可点的，点了才知道有没有更新。pinned 的源（`@1.0.0` / `@v1`）pi 明确不移动 |
| **标题生成没在真机上跑过一次完整往返** | 参数拼装、stdout 解析、失败路径、字数截断都有单测；真 pi 的 `pi -p --no-session -nt -nc --system-prompt` 往返也手工实测过（模型正文原样进 stdout、sessions 目录多 0 个文件）。**更好的一次**：用一个本地假 OpenAI 服务 + 临时 `PI_CODING_AGENT_DIR` 走通了"Rust 侧真 pi 生成 → 拿到标题"，并抓下请求体验证 `--thinking` 真的落到了 `reasoning_effort`（见 03 §2.16 的表）。但"从界面点一下 → **真的联网**到某个 provider → 写回会话名"这条仍没跑过（要花一次真模型调用）。失败文案（密钥过期、模型名写错）没实测 |
| 标题的**思考档位会被 pi 静默收敛** | 界面上能选 pi 的 7 个档位，但 pi 会按模型自己声明的 `thinkingLevelMap` 换成另一档，而**客户端拿不到收敛后的值**（`pi -p` 不回传任何状态）。界面上写了这一句提示，但"实际发出去的是什么档"在 Piggy 里看不到。要真的显示出来，得走 RPC 会话（`get_state` 给的是 `thinkingLevel`，但那是标题进程之外的一次性进程，拿不到）。补充：会话里的那颗思考强度胶囊是按 `get_available_thinking_levels` 显示的，所以它**没有**这个问题——只有全局设置这一处是盲的 |
| 「标题模型」列表只覆盖**全局**配置 | `title_model_options` 用 `HOME` 当 cwd（`pi --list-models` 会读 `<cwd>/.pi/…`），所以项目级 `.pi/models.json` 里声明的模型不在下拉里。标题进程真正跑在**会话的 cwd**，理论上那个项目级模型是能用的。手动输入这条路留着，所以不是死路，但下拉里看不到 |
| `pi --list-models` 的**表格格式**随版本漂移 | 解析规则、真输出金标、`--ignored` 真机用例都在（见规矩 38）。但 pi 换列名/换分隔符时**不会报错**：只会"一个模型都解析不出来"，此时界面会显示 pi 的原话 + 退回手动输入（不静默）。同类静默漂移见上面两条 `*_generated.rs` 的提醒 |
| 标题的**取材里没有"全部消息"** | 只有 first / recent(3) / both 三种。DSH 的 all-prompts 会把全部合格消息塞进去（有 `maxInputBytes` 超限就失败）。会话很长且话题漂移时，只看第一条+最近三条可能起不出好标题。要加得先决定超限怎么办（截断还是失败） |
| 标题**不区分来源** | pi 的会话名只有 `session_info.name` 一个字段，没有 DSH 的 `source: fallback/provider/user`。所以"这个标题是生成的还是用户改的"界面分不出来，菜单文案只能按"有没有名字"退化成「生成/重新生成」。也没法实现 DSH 的"用户改名钉住标题"语义 |
| 标题**没有"输出 token 上限"** | DSH 有 `maxOutputTokens`（默认 64）。`pi -p` 没有对应命令行参数，所以只能靠提示词约束 + 结果截断。模型话痨时那次调用会多花一点钱 |
| 标题生成的**并发** | 界面上同一时刻只允许一个（`titling` 状态），但后端没有全局队列——多窗口/多入口同时点会并发起多个 pi 进程。概率低，先不做 |
| 右键菜单**没有子菜单/快捷键提示列** | 也不在多个位置复用（只有会话行）。要做成通用组件得先有第二个用它的地方 |
| pi 扩展 API 版本耦合 | `packages/piggy-bridge` 的类型对着 pi 0.87.1 校验；pi 升级后需重跑 `pnpm --filter piggy-bridge typecheck` 与 `pnpm test:contract`（C12–C14）。这是唯一会因 pi 升级而静默失效的接缝 |

## 5. 验收方式

**已完成。** `pnpm tauri dev` 起窗、人工确认渲染正常（2026-09-23）；
打包版 `Piggy.app` 启动 0 条 webview 错误，日志确认以 `workspace` 档拉起 pi 并加载包内守卫脚本。

agent 侧没有窗口截图能力（本机缺"屏幕录制"权限，见第 4 节），因此这一步必须人工做。
后续若再遇到界面异常，终端会直接打出 `[piggy][webview][ERROR] ...`（`ErrorBoundary`
与全局 handler 经 `webview_log` 转发），把那段贴出来即可定位，不必靠猜。
