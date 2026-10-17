# 15 · 会话交接（2026-09-23）

> 用途：给**下一个接手的 agent / 会话**的一页速览，避免重读全过程。
> 设计细节见 [12](12-dsh-ui-spec.md)/[13](13-vscode-asset-inventory.md)/[14](14-ui-assessment-and-dsh-alignment.md)。
> pi 的配置来源与扩展机制见 [16](16-pi-config-and-extensions.md)；
> 权限档位与自定义 pi 打包见 [17](17-pi-permissions-and-packaging.md)。

## 1. 当前状态

DSH UI 对齐 + 权限档位 + pi 打包修复 + **子代理双层（M3）** + 提供商配置页 + **任务清单（todo，本轮）** 已完成并验证。

| 检查 | 结果 |
|---|---|
| `tsc --noEmit` | 通过（apps/desktop + packages/piggy-bridge，后者对着真实 pi 类型） |
| `vitest` | **2026-10-16 复核（macOS，主键三态 + 运行中指示后）**：**74 文件 / 748 passed**（新增 `src/test/composer-primary-button.test.tsx` 6 条：停止键可点且真发 `pi_abort` / 停止不动队列 / 有草稿不发停止 / 工具执行期也能停 / 空闲灰键 / 停完复位；`src/test/running-status.test.tsx` 11 条：用时格式 / 每秒跳 / 不足 1 秒按 1 秒 / 无起点不编数字 / 读屏只念状态 / 猪头图标（内联 SVG、`currentColor`、不依赖位图）/ 分隔线判据 / `agent_start` 记起点 / 落定与中断清起点。两处红检都做过 —— 把主键的 `disabled`、`onClick` 还原成老写法红 4 条；把时钟 tick 去掉、`turnStartedAt` 不记、分隔线恒画，running-status 红 3 条）。历史：**2026-10-15 复核（macOS，队列重做后）**：**71 文件 / 711 passed**（新增 `src/test/queue-dock.test.tsx` 31 条 + `src/test/image-preview.test.tsx` 13 条：对账 / 手势表 / 取回-放回事务 / dock 交互 / 落定 / 工具行无按钮 / 图片预览三条路；并把 `composer-slash` 那条「流式中 Enter 什么都不发」改成新契约）。⚠️ 退出码仍可能是 1（已知 flake，见 §4.3）。历史：**2026-10-14 复核（macOS）**：**70 文件 / 684 passed** —— 本轮新增 `src/test/right-rail.test.tsx` 7 条（折叠后图标轨常驻 / 三条入口写同一个 store / 折返不丢当前视图 / `⌘\` 真的按得动）。**2026-10-09 本机（Windows）复核**：**66 文件全过 / 633 passed + 7 skipped（640）**。⚠️ 两点与 macOS 上不同：① `permission-guard.test.ts` 有 **7 条 skip**（POSIX 专属，见 §4.2）；② **exit code 仍可能是 1** —— React scheduler 的 `setImmediate` 在 jsdom 拆除后才跑，vitest 记为 unhandled error（已知 flake，见 §4.3）。本轮修掉两条稳定超时（`session-name-sync` / `feedback`，原因都是"用例体里 `await import()` 一棵重模块树"，见 §4.2）。历史留档：**2026-09-25 复核**：apps/desktop **599（61 文件）**、`packages/piggy-bridge` **37/37**、`packages/pi-protocol` **30/30** —— 全部通过。⚠️ 本节下面那段历史留档里写的「572（57 文件）」与「bridge `artifact.test.ts` 既存红」**都已过期**：产物是新鲜的（`node packages/piggy-bridge/scripts/build.mjs --check` → ✓），那条用例也一直绿；本地若要复现，先 `pnpm install`（`packages/*/node_modules/vitest` 的软链会随 lockfile 更新而悬空）。以下为历史明细（数字按当时算）：apps/desktop 明细：**566**（57 文件）。**2026-09-24 本轮（转录重整 + 流式 Markdown）：删 11 条旧实时块引擎单测（`live.test.ts`，那个引擎没有了）、新增 5 条**流式行模型**（两条助手消息不串块 / 工具结果并进调用行 / 转正不重挂 / 新一轮落定掉队行 / 换窗期间不建流式行）、`transcript-scroll` 从 12 条改成 16 条（跟随判定改测 `ScrollFollow` 类）、`stores.test` 增 1 条（工具结果不单独成行 + 调用不在窗口时的兜底）、**`markdown.test` 增 6 条流式增量（节点身份跨冻结边界不变 / 尾部跟长 / 非追加输入整段重置 / 六种构造不变义 / 安全口径一致 / 流式围栏不上色）**。其余明细（历史留档）：含 20 条守卫扩展、16 条失败回合可见性、9 条布局生命周期判据、2 条恢复时序、8 条 fleetStore、9 条 FleetView、20 条 Composer 斜杠补全、44 条代码块高亮/折叠/源码门、4 条同一会话重复打开去重、5 条子代理委派开关、8 条预览语言表、5 条折叠侧栏图标轨、4 条空编辑区占位、22 条「打开方式」、6 条 Monaco 池策略、2 条 IPC 命令名契约、**17 条提供商配置页**、**8 条提供商 IPC 边界**、**3 条 mock 形状跨语言金标**、**本轮新增 73 条：13 条数字口径（`formatPercent` 的 3 位小数 / 整数模式 / 夹取）、8 条尺寸订阅（全应用一个 `ResizeObserver` + 代码块不自建 + 探针把「我们/别人」分开）、7 条错误上报（三种 `window.onerror` 形状 / 探针现场 / 连发折叠）、3 条上下文占用百分比端到端、**9 条压缩细节**（轨迹快照/实时三事件合成一行/失败不说完成/中断改口、对话行的边界+文件+用量+systemMessage 不外泄）**）、**本轮新增 56 条：21 条清单模型（含与 Rust 状态白名单的跨语言一致性）、8 条清单行、9 条计划面板、16 条 todo store（能力探测的坏形状 / seed / 实时增量 / 项目级补探）、2 条转录接线（端到端两行写入，钉住差异基线按调用 id 配对）**）、**本轮新增 20 条：7 条行内展开态记忆（键口径 / LRU / 清理）、7 条展开态跨卸载重挂（思考行 / 工具行 / 工具正文代码块 / 行与行·标签与标签不串 / 关标签要忘）、4 条读者位置锚点（口径 / 钳制 / 行没了退回裸位置）、2 条面板不在前台的几何（隐藏期间不许写位置·不许丢跟随 / 读者接管则分毫不差还回去）**）、**本轮新增 8 条：会话名的同步（按会话文件推给打开的标签 / 不误改别的会话 / 空白=清掉 / 路径字面比较 / 头部响应式跟着变 / 命令面板那条入口也会推 / 后端说没写下去就不许本地改口）**）、**本轮新增 3 条：连点两次只 addPanel 一次且不弹报错 / 同一快照连开两次只加一个面板 / 双击只读一次尾页**）、**本轮新增 6 条：4 条实时块引擎（节点摘掉再挂到新节点不丢字 / 块的形状随 pending 重建 / 同一节点重复 attach 幂等 / 无布局不写 scrollTop 且有布局才贴底）、2 条转录接线（实时行滚出窗口再回来必须长在可见节点上 / 新一轮清掉上一轮残留）**）、**本轮新增 4 条：1 条引擎跟随意图（读者接管之后一个像素都不写 / 交还后继续贴底）、3 条转录回滚（上滚交还且内容继续长也不拽回 / 一格 25px 也交还 —— 容差不许吞手势 / 滚回底部跟随自己回来）**）|
| `cargo test` | **336 + 3 + 21 + 2**（另有 9 条 `#[ignore]` 的真机核对：`real_home` / `real_network` / `real_machine_page` 等）全绿。本轮新增：`plugin::capabilities` 9 条、`transcript::todo_projection` 12 条（折叠/清空/坏形状/预筛/分支/**载荷在前的 custom 条目**/半行/真机）、`tests/ipc_contract.rs` 2 条（两个新命令的返回形状逐个锁死）。**2026-10-14 复核（macOS）**：`cargo test --lib` = 384 passed / 1 failed / 9 ignored，失败的是既存的那条 Windows 形状断言 `pi::process::tests::extension_args_never_carry_the_verbatim_prefix`（见仓根 `AGENTS.md` 第 13 条，不是本轮引入）；`tests/{path_separators,fixtures_parse,ipc_contract}` 26 条全绿。本轮补 `config::shell_env` 10 条（哨兵解析 4 / PATH 合并 2 / shell 选择 1 / 超时 1 / **`exec node` 垫片端到端 1** / 兜底 1）|
| `cargo clippy --all-targets -- -D warnings` | **通过**（本轮新加的这条比原来的 `cargo clippy -- -D warnings` 更严：后者不 lint test 目标）。清掉的 5 处：`tests/fixtures_parse.rs` 的单分支 `match`、`sessions/transcript.rs` 的死赋值与 `format!` 套 `format!`、`open_in_app/icons.rs` 测试桩里没人读的字段、`fleet.rs` 的 `== false` |
| `cargo test --features contract` | **17/17 全绿**（**2026-10-13 起在 pi 1.2.0 上重跑**，含 C12 bridge 数据面 / C13 降级 / C14 两 lane DAG / C15 建 tab 不持锁）；另 IPC 契约 **19** 条（2026-09-23 复核：文件里就是 19 个 `#[test]`，此前这里写的 11 是旧数）：`fs_list_dir` 形状 + 「打开方式」id 数组 / 图标真的是 PNG data URL（**2026-10-09 改口径：macOS 128×128、Windows 32×32**，Windows 那一支此前返回 None，写死 128 会在 Windows 上误报）/ 文件关联 `{id,name,default,icon}` 形状 / 目录也能查关联 / 拒绝面 + **提供商行键集合逐个锁死**、保存返回值与落盘一致、被拒请求一个字节都不写 |
| `ui:debug --strict` | 零 pageerror / 零 console error / 零布局问题（退出码 0） |
| `ui:startup` | 全绿，第 4 段覆盖：右栏 Fleet 面板 → A 层启动 3 条 lane（scout/review/build，验证 camelCase 参数名）→ steer 回车清空 → B 层刷新后 PIGGY:1 载荷落到面板（reviewer · correctness）→ **斜杠补全真滚动**（52 行、`scrollHeight 1508 > clientHeight 258`、`scrollTop` 真的变了、滚到底最后一条在可视区内）→ **代码块真高亮**（4 张卡 / diff 1 增 1 删 1 块头带底色 / go 的 token 有 4 种颜色 / 静默失败数 0） |
| `ui:startup` 数字口径（本轮新增） | **百分比不许露出 f64 尾巴**（用户报的 `上下文占用 20.316000000000003%`）：先核对夹具**有复现能力**（mock 的原始 `percent` = `15400/75800×100` 必须 >3 位小数），再断言三处显示——环的短标签 `20%`（DSH 整数口径）、环的 title `上下文占用 20.317%（15.400K / 75.800K）`、右栏「上下文」`20.317%` 且与 `data-ctx-percent` 一致。红检实测：把三处改回 `${pct}%` 时门禁逐条点名（原文就是 `20.316622691292878%`） |
| `ui:startup` 压缩细节（本轮新增） | **压缩行必须看得见细节**：对话行（分页从会话文件读出来那行）断言此前 token / 保留边界 `firstKeptEntryId` / 涉及文件计数 / 摘要调用用量 / 可展开摘要，并断言分页行里**没有** `systemMessage`；轨迹行断言「已压缩」行**可展开**、点开后有保留边界与摘要全文；实时路径断言 `start`+`entry_appended`+`compaction_end(result)` **只多一行**且带 `estimatedTokensAfter`；失败态断言写「压缩失败：…」+ `data-failed`、中断态断言不再留「正在压缩…」。红检实测：把轨迹行改回不可展开 + 对话行去掉两行细节 → 门禁逐条点名（含「点不开 —— 用户报的就是这条」） |
| `ui:startup` 工具窄行（本轮新增） | **空间利用率**变成可断言的真几何：行高 ≤26（实测 24）、连续三行 ≤76（实测 72）、标题/摘要逐条核对（`读取 · src/module1.ts`、`运行命令 · pnpm test -- --grep boundary-1`，且 `data-summary-source=args`）、折叠时正文**仍在 DOM 里**且 `display:none`、点开出现代码卡片（182px）再点收起。红检实测：把工具行改回默认展开 / 摘要不读参数 / 折叠时卸载正文 / 去掉 `toolCalls` 索引 → 单测与门禁逐条点名 |
| `ui:startup` Markdown（本轮新增） | **记号必须真的变成元素**：h1/h2/strong/行内 code/列表/引用/hr/表格单元格/围栏卡片（含行数条）逐条断言，正常链接 href 正确；安全两条在真浏览器里量——原始 HTML **不进 DOM**（`document.querySelectorAll('.pg-md img, .pg-md script')` 为 0、`window.__pwned` 未被写）且 `javascript:` 链接降级成纯文本；最后断言正文里**没有 `##`/`**`/``` 残留**。红检实测：白名单失效 / 围栏不走代码卡片 / 链接点击不交宿主 → 单测逐条点名 |
| `pi:cost`（本轮新增，**诊断不是门禁**） | 「打开会话的 1 秒花在哪」逐段实测：`pi --mode rpc --no-session` 裸启动 214 ms → 加载用户已装扩展后 **744 ms**（其中 pi-subagents **+431 ms**、pi-web-access +32、pi-todo +50、pi-guardrails +55）→ 我们的 bridge/守卫只 +12 ms → 11.13 MB 会话文件本身 +50 ms → 我们的 `get_entries(None)` 游标初始化 **+74 ms**（回包 10.90 MB，只要 leafId —— 已挪到后台）。结论写进 docs/05 §5.6/§5.7 |
| `ui:startup` 连点两次（本轮新增） | **第 18 段**：同一个会话行连发两次 click，断言 `addPanel` 只被调**一次**、没有重复 id、`addPanel` 没抛、界面上没有报错提示、转录只有一份。这一段专门抓"去重只做了一半"：`createTabGuarded` 让两次点击拿到同一个快照之后，还会各自 `addPanel`。红检实测（去掉 `openSessionTab` 的幂等守卫）：门禁逐条点名，其中一条就是用户原话里的 `Error: dockview: panel with id session:<uuid> already exists` |
| `ui:startup` 流式内容在 store 里（2026-09-24 重整） | **第 19 段**：用户报"有时候不会滚动输出？会等到完成后再全部输出"。自己建一个会话标签、灌 200 行（保证流式行能真的滚出虚拟窗口），用 `__piggyPerf.streamFor(3400, 16, tabId)` 走真实帧通道（它现在按真机顺序发 `agent_start` → `message_start` → 帧 → `message_end` → `agent_settled`），判据是**通道发出的字数**（`__piggyMock.mockOn` 订阅同一条通道）而不是时间：① 往上滚 → 断言流式行**真的被卸载**（前置）→ 回到底部，`lostOnScroll ≤ 60`、长度把卸载期间的补上；② 切到另一个会话（断言旧转录被摘出 DOM）再切回 → `behindAfterSwitch ≤ 90` 字；③ 收尾断言 `streaming=false`、`data-streaming` 撤掉，且**转正后可见字数 === 通道发出字数**（少了是丢字、多了就是用户报的"最后又打印一遍"）|
| `ui:startup` 实时行 = 提交行（2026-09-23） | **第 21 段**：`__piggyPerf.streamMixed` 发思考 + 工具参数 JSON 增量 + 正文，与同一份参数 hydrate 出来的提交行逐项对比（标题/摘要/行高/`data-variant`/`data-summary-source`）。工具行现在**同一行**从 `data-state="running"` 走到 `ok`，不重挂 |
| `ui:startup` 会话标题三处一致（本轮新增） | **第 14b 段**：点会话行上的生成图标（用户那条原路），断言**侧栏 / 上方的会话头部 / 活动标签页标题**三处都变了**且彼此一致**（`agree`）。三个显示点来源不同（`session_list` / tabs store / dockview 面板 title），只测侧栏就会漏掉"左边变了、上面还是旧的"。红检实测两条：去掉 `PgTab` 的同步 → 门禁点名「改名之后标签页标题还是「插件管理页的标题生成」」+「三处标题不一致」；去掉侧栏那次 `applySessionName` → 点名「改名之后**上方的标题**还是…（用户报的就是这条）」 |
| `ui:startup` 流式中手动往上滚（本轮新增） | **第 20 段（真滚轮）**：用户报「一直向下滚动，我希望手动向上翻滚时，不会被自动跳到最底下」。判据不是"看有没有滚"而是**位置有没有被拽动**：先贴底 → `page.mouse.wheel(0,-60)`×4（trackpad 手感，每 25ms 采样）。⚠️ 2026-09-25 改过一次步长：原来写的是 **-25**，正好压在跟随容差（`FOLLOW_THRESHOLD_PX = 25`，口径是 `gap ≤ 25` 仍算贴底）的边界上 —— 每一步滚完 gap 恰好 25 → 判定继续跟随 → 拽回底部 → 下一步又是 25，读者永远逃不掉，量到的东西取决于那个窗口里流式内容有没有长过 1px（同一份代码时红时绿，实测 4 挂 3）。容差边界本身由 `transcript-page.test.tsx` 的「容差就是容差」钉着，这一段要量的是"读者明确说接管之后就别再拽"，手势必须真的超出容差→ 断言第一次上滚就出现「回到底部」、位置留在原地 → 内容继续长 1.1s，断言 `movedDuringHold ≤ 6px` 而 `scrollHeight` 长了 >100px（"流式在跑"要用 `scrollHeight` 量：跟随时 `gap` 恒为 0，拿 gap 当增长量会把"没在流"和"被拽着走"混成一件事）→ 再滚回底部，断言跟随自己回来（`gap ≤ 25` 且按钮消失）并保持。实测：`nudge` 第一次就是 `13429/25B`、`afterNudge {gap:268}`、`hold: 13354/292B … 13354/580B`（`movedDuringHold 0`、`grewDuringHold 288`）。红检（把 `Transcript.tsx`/`live.ts` 退回上一版）：4 条断言点名 ——「滚轮往上之后还贴着底（gap=0）—— 滚轮被无视了（采样：13454/0 13478/0 … 13598/0）」「读者往上滚了却没出现「回到底部」」「位置被拽动了 288px」「「回到底部」消失过」 |
| `ui:startup` 展开态与切标签（本轮新增） | **第 17 段：只有真浏览器能量的两条**（用户 2026-09-23 报）。① 长思考行展开（24 → 1456px）→ 滚到顶（**断言这一行确实被卸载了**：`[data-thinking-row]` 数 0，"虚拟化卸载没发生"时这条核对会自报失去意义）→ 滚回底部仍展开、高度还是 1456px；② 会话被切到后台（断言 `isConnected=false`、三个读数全 0）→ 后台真流式跑完 → 切回来 `gap=0` 且不冒「回到底部」；③ 读者往上滚到 400 → 切走再切回（浏览器会把位置清零）→ 仍停在 400 且「回到底部」还在；④ 重载（启动恢复）之后恢复出来的会话也贴在结尾。红检实测：去掉"重新有布局就收尾"那条 effect → 门禁点名「读者位置：切走再切回被拽动了（0，切走前是 400）」 |
| `ui:startup` 任务清单（本轮新增） | **行与面板的真几何 + 能力闸门正反两面**：清单行高 ≤26（实测 24）、摘要逐字（`0/3 已完成` → `1/3 已完成 · 跑回归测试`）、并行 `+1` 报出、第二行差异 `新增 1 · 更新 2 · 移除 1`（基线配错会集体显示"首次记录"）、零行退回通用工具行；面板在输入卡**正上方**（面板底 ≤ 卡顶，把它挪到下面即红，已验证）、默认折叠、点开后 `max-height: 180px`、项高 20、项距 8、三态顺序与条文字逐条核对；最后**关掉能力探测并重载页面**，断言面板 0 个、清单行 0 行、通用工具行 ≥1 |
| `ui:startup` 门禁自身的空转（本轮修） | 「回到底部」按钮是 `.pg-transcript` 的**兄弟**（挂在 `.pg-transcript-wrap` 上），而门禁三处都用 `tr.querySelector('[data-to-bottom]')` —— **永远读到 null**：一次"点了没反应"的点击 + 两条恒真断言，全都没在核。现在查询口径改到 wrap 上，并补上"往上滚离开底部之后按钮必须出现"这条此前只收数据、没有断言的检查 |
| 真机 todo 链条（本轮新增） | 三段独立证据：① 真 pi 在**本仓**跑一场带清单的会话（`pi -p` 用 todo 列 3 件事并逐条完成）→ 会话文件里 8 条 `todo/write`；② Piggy 的 Rust 投影读那份真会话（`PIGGY_TODO_SESSION=<path> cargo test --release --lib real_machine_todo -- --ignored --nocapture` → 3 条 / 来源 `event` / 901µs）；③ 真机能力探测（`real_machine_todo_capability` → 命中 `pi-todo`、声明式凭据、`pi-web-access/dist/index.js` 超限被如实标出）。性能：11.7 MB 会话 15.5 ms（对照同一次运行的轮次轮廓 8.8 ms） |
| `ui:startup` 第 5 段 | **文件预览真高亮**：README.md 语言条 `markdown` + 4 种 token 类 / 3 种颜色（标题 `rgb(86,156,214)`）；main.go 9 种颜色（注释绿/关键字蓝/字符串橙）；`notes.zzz` 老实 `plaintext` 只有 1 色；外加**按需门**（开了 2 个文件只许下 `markdown`/`go` 两门语言定义，多一门就红） |
| `ui:startup` 第 6 段 | **折叠侧栏不许进死胡同**：关掉全部标签 → 收起侧栏 → 断言图标轨恒 56px + 展开按钮 36×36 + 三个按钮都有可访问名 → 点回来 → 侧栏 254px、图标轨消失、标签数不变；连做 2 轮 |
| `ui:startup` 第 6b 段 | **折叠右栏不许进死胡同**（2026-10-14）：收起右栏 → 断言**折叠宽 === 图标轨宽**（`RIGHT_RAIL_W` ↔ `.pg-rightrail` 这对镜像数字）、内容真的卸载（不是 CSS 藏起来）、轨道按钮都有可访问名（`展开右栏`/`文件`/`统计`）、开关的 `aria-expanded` 跟着走 → 点回来内容回来且面板比轨道宽，连做 2 轮；再加**拖 sash 的两个方向**（折叠态往左拖出来 → 内容回来且按钮改口「收起右栏」；往右拖过阈值 → 面板自己收起来且按钮改口「展开右栏」）—— 后半段是"面板 → store"那条同步方向，只有真拖才走得到。**红检实测**：①把 `.pg-rightrail` 改成 44px（与 `RIGHT_RAIL_W` 失配）→ 三条断言逐条点名（两轮 + 拖那一档）；②把 `onResize` 回写摘掉 → 实测"拖出来后按钮仍写着「展开右栏」、内容不回来"（面板 200px、body 不在 DOM 里），正是那两条断言要拦的 |
| `ui:startup` 第 7 段 | **空编辑区占位**：关光标签 → 水印 🐷（opacity ≤0.15）+ ≥5 条快捷键（逐条与**应用自己那份命令注册表**核标题与键位）+ ≥3 个中央入口；每个入口做 `elementFromPoint` 命中判定（防被 dockview 的 `.dv-watermark-container` 盖住）+ 真点一下建出标签 + 再关光后占位回来 |
| `ui:startup` 第 8 段 | **「打开方式」分裂胶囊**：会话头部右侧**位置对**（`.pg-session-head-ops` 内、置灰占位已被替掉、「更多」占位还在）+ **够显眼**（26px 高、1px 边框、≥70px 宽、`elementFromPoint` 可点）+ 菜单**向下弹且不出屏** + 5 项里真图标与通用图标**两条渲染路径都出现** + 点 GoLand → **送给宿主的是 `{id:'goland', path:<会话 cwd>}`** + 选择落 localStorage + 重载后冷启动读回 |
| `ui:startup` 第 9 段 | **「打开方式」文件那一档**（预览头部，真浏览器）：胶囊在文档动作位的**最后一格**、compact 24px、有边框、`elementFromPoint` 可点、主按钮名字 = **系统默认应用**（Typora.app）且真图标渲染出来 → 点主按钮送出 `{path:<预览的那个文件>, action:'open', application:'/Applications/Typora.app'}` → 菜单 2 个处理器 + 「显示文件位置」（真图标与通用方块两条路径都出现）→ 点它送出 `{action:'reveal', application:null}`。**顺带锁住语言判定**：`lib.rs` 的语言条必须是 `rust`、token 类 ≥2（预览头部原来那张 16 项本地表认不出 `.rs`） |
| `ui:startup` 第 10 段 | **Monaco 实例池**（真浏览器）：连开 8 个预览标签 → 池里活着 ≤ 水位（实测恒 6）、界面上零「已达上限」提示、当前预览有实例且语言条 `rust` → 切回第 1 个（多半已被回收）→ 编辑器**重建**、token 类 ≥2、首行内容正确 → 全程堆增长 ≤40MB。（旧行为：第 7 个标签直接显示「请关闭部分预览标签」，且关掉也不恢复） |
| `ui:startup` 第 11 段 | **提供商配置页**（真浏览器 + mock IPC）：左导航 `模型/通用设置/高级` → 列表两行（自定义/默认标记 + 状态点 + **密钥来源写在 meta 里**）→ 点「编辑」出卡片（密钥框提示"已配置"、自定义设置默认折叠）→ 点「检测」**真发 `provider_discover`**（带 provider/baseUrl/api，密钥留空=用已存的那把）且界面写出"连上了哪个地址、列了几个模型" → 「获取可用模型」把清单拉进对话框（已在表里的禁用）→ 勾一个「添加所选」进模型表 → 输密钥点「保存」→ **先 `provider_save` 再 `provider_set_key`**、存储位置跟随现状（这一行本来在 models.json 就还写 models.json）、列表 meta 刷新 + "已保存 XX" 回执 → 从目录添加（下拉里已配置的不出现、地址预填目录默认值、保存后进列表） |
| `ui:startup` 第 12 段 | **用户反馈的两个坑**（2026-09-24）：①「检测」按钮几何（`white-space: nowrap` + `scrollHeight≈clientHeight` + 高 ≤36px，实测修前 51×44 竖排 → 修后 54×27）；②两次进「高级」内容必须一致（第一次 14 行 → 第二次 14 行；修前第二次是 1 行 `{}`）且**保存按钮必须仍是灰的**（编程式写入不算编辑）；③**编辑器贡献**（折叠控件 >0、⌘F 真按键唤出 `.find-widget`）—— 这条刻意排在打开「高级」**之前**，否则 JSON 语言服务会把贡献自己拽进依赖图，核对永远绿 |
| 真机 `~/.pi/agent` 跑总览 | `cargo test --lib -- --ignored real_home --nocapture` 打印出这台机器上配置页会显示的两行：`DeepSeek (cc-switch-deep-seek)` / `Zhipu GLM (cc-switch-zhipu-glm)`，**密钥来源都是 `models_json`（内联）**、默认项是后者、内置目录 41 条 10 种协议。这正是这个功能存在的理由：本机 auth.json 是空的，**旧配置页因此什么也不显示** |
| 真机网络核对 | `cargo test --lib -- --ignored real_network --nocapture`：不带密钥打 `https://api.deepseek.com/models` → 拿到 `HTTP 401（API 密钥可能不对或没有权限）：Authentication Fails (governor)`。证明 DNS + TLS + 真 HTTP + 状态码映射 + 端点原文这一整条链路是通的（刻意不用用户的密钥） |
| 真机人工确认 | 「打开方式」在 `tauri dev` 窗口里**由用户手动点过，应用真的弹出来了**（2026-09-24）。这是唯一能证明「操作系统真的把窗口开出来」的一步 —— agent 侧没有窗口驱动能力，也没法在不打扰用户的前提下自己点一次 |
| 真实 pi（0.87.1 起，1.1.0 复跑）加载 piggy-bridge | `/piggy:status` 回 `ok:true` + 真实 fleet/asyncSnapshot；空配置目录回 `ok:false` 降级（C12/C13） |
| 真实 pi（0.87.1 起，1.1.0 复跑）跑 Fleet DAG | 两 lane：a settle → b 就绪 → `{upstream}` 注入真实输出 → b 回 BRAVO-OK → run Done（C14） |

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
pnpm --filter @piggy/desktop ui:debug           # 截图 + 错误 + 布局体检（--strict 给发布前/本地用，**未接 CI 作业**）
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
    **同一条规矩的第二层**（2026-09-23 晚，用户报 `dockview: panel with id session:<uuid>
    already exists`）：in-flight 表只保证了"建一个 worker"；两次点击拿到**同一个快照**
    之后还会各自去 `addPanel` —— 同一条双击路径换个地方继续炸。
    教训：**幂等要一路做到终点**。"检查 → 异步 → 提交"里每一个**有副作用**的提交点都得
    自己幂等（这里是 `openSessionTab` 按 `params.tabId` 查面板、`ensureTab` 查装过没有），
    别指望上游去重能替你兜住下游。

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


43. **把 `loading` 放进 `useEffect` 依赖、而失败路径又复位 `loading`，等于写了一个无限重试循环。**
    「关于与许可」对话框第一版是这么写的：
    `if (!open || info || loading) return;` + `[open, info, loading]` 依赖，
    靠 `loading` 挡重入。成功时没事（`info` 有值就停了），但**失败时**
    `finally { setLoading(false) }` 会重新满足条件 → 再拉一次 → 再失败 →
    无限刷 IPC。单测表现是**用例超时**，真机表现是转圈不停、后端被自己刷屏。
    修法：用显式的"这次打开试过了吗"闸门（`attempted`，关闭时复位），失败就停在失败态，
    另给一个「重试」按钮。这条是**用例抓出来的**，不是看代码看出来的——
    所以用例里除了断言错误文案，还断言了**只调一次**（`invokeMock.mock.calls.length === 1`）。

44. **antd 关闭的 Modal 仍留在 DOM 里；按 `[role="dialog"]` 找元素的代码会先命中它。**
    加「关于与许可」之后，插件页门禁整段变红（"裸包名没有被拦下"、`""` 之类的空字符串）——
    因为那段用 `document.querySelector('[role="dialog"]')` 找安装对话框，
    先命中了我的（隐藏的）对话框，于是后面所有断言都在一个空壳上做。
    两条修法都做了：新组件加 `destroyOnHidden`；门禁改成**只认可见的那个**
    （`closest('.ant-modal-wrap')` 的 `display !== 'none'`）。
    与规矩 33（`.ant-modal-content` 是 v5 类名）同源：**antd 的 DOM 约定要按当前版本实测**。


45. **“两侧一起加留白”这类布局约束，只能靠真浏览器量——而且必须写成断言。**
    预览滚动条要放在正文一侧，但又不能把正文挤偏（用户明确要求“除了滚动条之外主体
    还是居中的”）。做法是**两侧同时**加 `--pg-rail-clearance`（44px），刻度梯落在
    留白里。这条约束在 jsdom 里完全不存在（`getBoundingClientRect` 全是 0），
    所以门禁里量的是 `|正文列中心 − 转录容器中心|`，右置与左置各一次。
    反证（改成只给滚动条那一侧加 padding）当场报 **“左侧档下正文列偏了 22px”** ——
    22px 就是“看得出来但说不清哪里怪”的那种偏差。
    另外两条同源断言：刻度梯与正文列**不重叠**、刻度梯竖直居中于可视带。

46. **“亮度跟着滚动走”必须真的滚一下才算验过。**
    滚动条的当前刻度（用户说的“亮色的条子”）是滚动事件的产物。单测里可以断言
    `activeTurn` prop 变了之后哪条刻度带 `is-active`，但那**证明不了**它跟着滚动走——
    第一版把 `setActiveTurn(activeTurnOf(...))` 写死成第 1 轮时，13 条单测全绿
    （它们只是把 prop 传进去），是门禁里“滚 718px 后当前刻度没变”抓出来的。
    教训与规矩 20 同源：**prop 对 ≠ 行为对**，跨事件链路的那一半得在真环境里驱动。


47. **“悬停显示”必须成对实现：那条自己的 `pointerenter` 只负责“显示这一条”，
    整块的 `pointerleave` 才负责“消失”。**
    预览滚动条第一版照着 DSH 给每条刻度挂了 `onPointerEnter`，却漏了把
    `onPointerEnter/onPointerLeave` 挂在**整条梯子**上——用户报的 bug 就是
    “鼠标移开后预览框不消失”。两个细节让它格外容易漏：
    ① 刻度只有 10px 高、彼此相邻，指针从一条移到另一条会重设预览，
       **“移出整块”是唯一会清空的路径**，所以漏了就永远不会消失；
    ② 我当时还写了一个 `pointerInside` ref（DSH 用它避免把梯子从指针底下滚走），
       但因为它只在 `pointerleave` 里被置回 false，**那段逻辑其实一直是死的**——
       漏掉成对实现时，顺带废掉的是另一条不显眼的行为。
    单测也漏了：我写了 hover 进、focus/blur 出，**唯独没写指针移出**。
    补法：单测里派发 `pointerout`（带 `relatedTarget`，React 的 `onPointerLeave`
    是由它推出来的，原生 `pointerleave` 不进处理函数），门禁里用**真鼠标**
    `page.mouse.move` 移进去再移开——后者才是用户那条路径。


48. **`-webkit-line-clamp` 的效果取决于**行高**，而"看起来像 overflow:hidden 硬切"
    多半是父容器的 `max-height` 把最后一行连省略号一起切了。**
    预览框第一版只写了 `font-size`（DSH 那边用的是 `font` 简写令牌，含行高），
    行高于是继承正文的 24px：1 行标题 + 3 行正文 = 10 + 24 + 4 + 3×24 + 10 = **120px**，
    而容器是 `max-height: 100px` → 第三行和它上面的省略号一起被切掉，
    用户看到的就是"好像 overflow hidden 的样子"（他报的正是这句）。
    修法是把 DSH 的两个 font 令牌原样搬过来（500 13px/20px、12px/18px）→ 98px ≤ 100px。
    两条教训：
    ① **抄外部实现时，抄它们的令牌而不是自己拼 font-size**（简写里带着行高，
       拆开写必然丢东西）；
    ② 这类"数字之间要自洽"的约束值得单独一条测试：现在 `turn-rail.test.tsx`
       从真 CSS 里读出四个数去核对 `1×lh13 + margin + 3×lh12 + 2×padding ≤ max-height`，
       门禁再在真布局里量"正文恰好 3 行 + 容器没有裁掉内容"。反证两条都红：
       拿掉行高 → 单元测试报"找不到含 line-height 的规则"、门禁报
       "内容 102px 超过容器高度"；把 `--pg-lh-12` 改成 24px → 报"内容 116px 超过容器 100px"。


49. **“PATH 里有它”不等于“能执行它”——Windows 上 npm/pnpm 放的是无扩展名的 shell 脚本。**
    真机（Windows debug run）报的是 `pi --version 失败: %1 不是有效的 Win32 应用程序 (os error 193)`，
    紧接着一句“pi 未找到”，而 pi 明明在 PATH 里。根因：`which_pi` 的候选顺序是
    `["pi", "pi.exe", "pi.cmd"]`，Windows 的 bin 目录里那个无扩展名的 `pi` 是**给 Git Bash 的
    POSIX shell 脚本**，`is_file()` 为真就被当成结果返回；而**绝对路径 Rust 不会再补 `.exe`**
    （`std::process::Command` 的平台说明：只有“省略扩展名的可执行文件”才补），
    于是 `CreateProcess` 直接吃了一个 shell 脚本 → 193。
    修法两层，互相独立（反证时各自都能单独拦住）：
    ① **候选名**按 `PATHEXT` 生成、无扩展名排**最后**；
    ② **内容筛子**：无扩展名的候选只在其头两字节是 `MZ`（PE）时才接受。
    顺带修掉同一来源的另一处：兜底目录以前只有 Unix 路径（且用 `HOME`，Windows 上一般是
    `USERPROFILE`），所以 Windows 上 PATH 未命中时**连试都没试**。
    教训：这类“平台语义差异”要在**纯函数 + 夹具**层面测（`exec_names(windows,…)`、
    `first_pi_in(dir, names, windows)`），否则本机是 macOS 就永远测不到；
    被验证的是“选哪个名字/哪个文件”，不需要真的执行它。

50. **`#[cfg]` 分支里的 `use` 必须条件导入，否则只有别的平台会报 `unused_imports`。**
    `legal.rs` 里 `MenuItemKind` 只在 macOS 那一支用到，我写成无条件导入 → macOS 编译干净，
    **Windows 上冒出一条 warning**（用户在 Windows debug run 里看到的）。
    改成 `#[cfg(target_os = "macos")] use tauri::menu::MenuItemKind;` 后，
    两种 cfg 组合下都不可能 unused（按构造成立，不必真去编译另一个平台）。
    这也是本机验证不了的点：`rustup target add x86_64-pc-windows-msvc` 在本机镜像上 404
    （Tsinghua 镜像没有该组件），所以 **Windows 的编译与运行只有用户那台机器能确认**。

51. **`HOME` 在 Windows 上默认不存在——凡是解析主目录的地方都必须有平台兜底。**
    Windows debug run 的第二批报障：默认地址显示成 `.pi/agent\sessions`，新建会话报
    「无法确定 cwd」。根因一个：`std::env::var_os("HOME")` → `None` →
    `unwrap_or_default()` → **空路径** → `join(".pi/agent")` 退化成**相对路径**。
    同一个根因在四处冒头（会话目录 / 新建 cwd / `~/.piggy` 配置与 panic 日志 / 文件预览沙箱），
    所以修法不是打四个补丁，而是收成一个模块 `config/paths.rs`：
    主目录按平台给顺序（Windows `USERPROFILE` → `HOMEDRIVE`+`HOMEPATH` → `HOME`；
    其它 `HOME` → `USERPROFILE` → `HOMEDRIVE`+`HOMEPATH`），空串当未设置，
    agent 目录认 `PI_CODING_AGENT_DIR`（同 pi 的 `getAgentDir()`）。
    三条教训：
    ① **空路径是"合法的"前缀**：`Path::starts_with("")` 恒为真，于是预览沙箱在 Windows 上
       等于不存在（任意文件可读）。凡是"拿 home 做前缀校验"的地方，空值必须**直接拒绝**；
    ② 这类 bug 在本机（macOS）**测不出来**——它是"环境变量缺失"的 bug，不是"平台代码"的 bug。
       所以值不值得写"抹掉 `HOME` 起子进程跑真正生产入口"的端到端探针：值得，
       红检时它原样打印 `probe sessions=.pi/agent/sessions`，就是用户看到的那一幕；
    ③ 主目录这种"到处都要用"的事实只允许有一个出口。老代码在 12 处各写各的，
       修一处不修一处，症状就会以完全不同的面目出现（cwd 报错 vs 路径显示错）。
52. **跨平台路径只准用 `Path::join` 拼，字面量里不许写分隔符。**
    `.pi/agent\sessions` 这种"半反斜杠半正斜杠"就是这么来的。这条纪律**只能在源码层面守**：
    `PathBuf::from("C:\\Users\\x").join(".pi/agent")` 与 `.join(".pi").join("agent")`
    在 macOS/Linux 上产生**完全相同**的字符串（`/` 是分隔符，`\` 只是普通字符），
    单元测试永远分不出对错——所以加了 `tests/path_separators.rs` 静态扫描
    （豁免注释、`join("/")` 归一化、含空格的显示分隔符、`#[cfg(test)]` 之后的夹具）。
    守卫自身也带自检（喂进原始 bug 那行必须报错），免得扫描器悄悄失效。
53. **界面里的路径来自 Rust，是平台原生的——`split('/')` 在 Windows 上等于不切。**
    同一个报障的另一半：项目分组标题 / 标签页标题 / 右栏根名会显示**整条路径**，
    Monaco 认不出 `Makefile`（`lastIndexOf('/')` 返回 -1，`FILE_LANG` 永远命中不了）。
    前端统一走 `lib/paths.ts` 的 `baseName` / `splitPath`（`/` 与 `\` 都算分隔符），
    测试用 Windows / POSIX / 混合分隔符 / UNC / 末尾分隔符五组输入锁住。

54. **自定义 `sessionDir` 是"叶子"目录——pi 的布局规则跟着它变，读写两边都要跟。**
    修 51/52 的过程中顺手在**本机**核了一遍生效会话根：`settings.json` 的 `sessionDir` 指到
    `~/Documents/Project/tmp/session`，那里根下 88 个平铺 `.jsonl`（pi 自己写的）
    外加 `--Users-wxk--/` 里 39 个（Piggy 预创建写的）。原因是 pi 的两套规则：
    **默认根**按 cwd 分子目录（`--<cwd 编码>--`），**自定义根**当叶子用、平铺
    （列举走 `listSessionsFromDir`，`session-manager.ts:941-953` **只读该目录下的 `*.jsonl`**）。
    Piggy 老代码读只认子目录、写永远建子目录，于是"侧栏看不见自己的会话"且
    "终端 pi 的会话选择器也看不见"——两个方向同时坏，而界面上只表现为"少了一堆会话"。
    修法是把决策抽成纯函数 `precreate_dir(&(root, is_custom), cwd)`，与扫描器共用同一份
    `sessions_root_spec()`。教训：**"落点"和"列举"必须是同一个函数说了算**，
    否则一个平台/配置分支上就会悄悄分叉（这次是"自定义目录"这一支，恰好是用户在用的那支）。
    另一条：单测不要往真实的生效会话根里写文件——第一版接线测试就是这么写的，
    红检失败后留了一个探针目录；改成纯函数断言后既没副作用又照样能红。

55. **"多了一堆会话"和"会话不见了"可以是同一件事——排序把真项目挤下去了。**
    会话根改成"两种布局都认"之后，用户报「原来的会话没有了，多了一堆新的会话」。
    先按数据核实：**一个会话都没丢**——自定义 `sessionDir` 下 pi 会平铺写自己的
    `pi -p` 会话（`/private/tmp/...`、`/var/folders/...`），侧栏因此从 2 组 28 个
    变成 82 组 117 个，而真项目的两个组按"最新会话"排到了第 16、27 位。
    两条教训：
    ① **改"看得见什么"之前，先算一遍新集合的排序位置**——新增的都是"最近的"，
       就必然把用户的常驻项目推到屏幕外（这就是"不见了"的机制）；
    ② 目录已不存在的会话要**汇总沉底、默认收起，而不是过滤**：文件还在，
       pi 的 `--resume` 也能看到，替用户隐藏等于悄悄改数据。判据用后端已有的
       `cwd_missing`，前端不额外查盘。
    顺带记住这条自查手法：**用真机数据（而不是 mock）算一遍视图模型**——
    这次是拿 117 个真实会话的形状写了一条回归测试，红检时它打印的正是用户看到的那一幕
    （`expected ['case-75','case-74',…] to deeply equal ['wxk','1m-go-websockets',…]`）。

56. **"打开会话在结尾"是个几何问题，不能只做一次，也不能盯错元素。**
    用户报"长上下文的时候，打开会话，都是在开头"。默认跟随尾部（DSH `ScrollFollow`，
    容差 25px）只解决一半：第一页贴底之后，虚拟化器**量出行高**会把底部重新顶走。
    所以还要 `ResizeObserver` 盯内容层再贴一次 —— 第一版盯的是 `el.firstElementChild`，
    而分页之后第一个子元素是「加载更早」那颗按钮（高度永远不变），
    于是"量完再贴"这条永不触发，浏览器门禁量到 **198px 的缝**。
    教训：**观察者要盯"会变的那个节点"**，别盯"第一个孩子"这种位置假设；
    几何判断抽成纯函数（`transcriptScroll.ts`）+ 真布局门禁量，jsdom 里 `clientHeight` 恒为 0。

57. **分页省的是客户端计算，不是磁盘；而且"翻页不许跳"。**
    用户问"部分加载能否节省计算/存储"——**存储不省**：会话文件是 pi 的 append-only JSONL，
    Piggy 只读。省的是打开时的 IPC 载荷（真机 11.7 MB 的会话只传 269 KB）、JSON 解析、
    store 内存与刻度梯重建；Rust 侧实测尾部一页 5.1 ms vs 整文件读+解析 93 ms
    （`cargo test --lib -- --ignored real_machine_page` 可复现）。
    翻页不跳的做法：先量旧 `scrollTop`/`scrollHeight` → await 取页 → 下一帧按高度差补回去。
    另一条：**一页 = 一页看得见的行**（`system`/`custom` 不占额度），否则"点了没反应"。

58. **"看不到某个东西"要先分清是"没有"还是"没显示"——pi 的内建斜杠命令属于后者。**
    用户报"类似 /compact 这个基础命令好像没有体现"。核实：pi 的 `get_commands` RPC
    **只返回扩展/prompt/skill 命令**，24 条内建命令是交互模式本地解析的，协议里没有；
    而 Piggy 当时会把 `/compact` 当普通消息**发给模型**（模型会一本正经地回答"好的，我来压缩"）。
    修法：界面自己维护内建表，能做的映射到已有 RPC，做不到的**仍然显示并解释**"为什么没有"。
    通用教训：**"暂无入口"必须可见**——静默的缺席会被读成"这个产品没有这个能力"。

59. **同一组数字只允许有一个格式化出口。**
    15400 在一处是 `15.4K`、另一处是 `15K`，用户看到的是"前后不一致"。
    上下文长度与缓存命中率现在统一走 `lib/tokenFormat.ts`（3 位小数，常量 `DECIMALS` 一处），
    并且**照抄 DSH 的诚实规则**：只要有 1 个 token 没命中就绝不显示 `100%`
    （四舍五入到 100 时自动加小数位区分，`99.9999%`）——这个数就是用来判断缓存有没有生效的。
    顺带用整数运算算百分比，不让浮点表示误差在百分数上放大。

60. **"预览全部"和"只载入一部分"必须由两个不同的事实支撑，不能混成一个。**
    用户第二轮反馈："预览滚动条好像不是全部的预览，变成最高一条线是虚线，是无法实现
    预览全部、展示部份，然后还比较节省计算资源吗"。答案是可以，DSH 就是这么做的：
    刻度梯吃**宿主侧的轮次轮廓**（一次扫描整个会话，只有锚点+预览文字），
    内容照旧按页载入，两边用锚点对上（`mergeRailItems`）。
    教训：**"画什么"和"读什么"是两条独立的预算**——上一版把刻度绑在了已载入的行上，
    于是分页省下的计算被拿去砍掉了梯子的信息量，用户一眼就看出来了。
    实测成本：11.7 MB / 1070 行的会话，轮廓扫描 26.9 ms（只解析占 17% 的正文行）。

61. **跳转要"换窗"，不要"累加"——否则一次跳转等于取消分页。**
    同一个追问的后半句："会不会导致其实已经加载了整个文本，然后并不节省资源"。
    第一版是往上累加页直到目标进来：跳第 1 轮就把整段历史读进内存（实测 50 → 100 行）。
    改成 DSH 的 repage：只取以目标锚点为右界的一页、丢掉旧窗口，页里带 `hasNewer`，
    界面给「回到最新」。三条随之而来的纪律：
    ① 换窗期间**不**把实时消息追加进窗口（会插在错误的上下文里），回到最新整页重载；
    ② 落位**不许**再补"高度差"——那是"往上加页"用的，换窗后整段都换了，
       补偿会把落点推走（实测目标 52 轮、补偿后停在 73 轮）；
    ③ "到底了"取的是窗口里最后一条**已载入**刻度，不是列表最后一条（换窗到中间时
       列表末尾是未载入的更新轮次，取错高亮就跑到没内容的地方）。

62. **梯子"疯狂跳动"的根因是"跟随策略与间距不匹配"，不是渲染性能。**
    刻度改成整段会话后，梯子从 ~250px 涨到 1000px+，于是每次自动跟随都在内部滚动。
    DSH 的居中策略配它自己的**比例间距**没问题，配上 Piggy 的**固定 10px 间距**
    就变成"每十几轮整体跳 200px"（实测轨迹 592 → 311 → 521）。
    改成最小幅度跟随（只在跑出可视带时拉回来），轨迹只剩一次调整。
    同类教训见规矩 56：几何行为要能量、要能红。

63. **"闪动"和"跳动"是两个 bug；判定用"意图"还是"瞬时几何"决定了会不会闪。**
    用户第二轮说"不行，还是疯狂闪动"。按帧采样（33ms）才看清：贴底跟随时内容每帧都在长高，
    而"离底多远"是拿**旧 scrollTop** 与**新 scrollHeight** 算的，于是
    ① 跟随意图被自己贴的底弄丢（实测当前刻度 60 → 58 且不再跟随）；
    ② "当前是哪一轮"在最新那轮与阅读线那轮之间逐帧翻（58 ↔ 61）→ 亮条以帧率闪。
    两条修法都照 DSH：`movedByReader` 比 `sampledTop`（位置等于我们设的就不算读者滚的）；
    "当前轮次"取**跟随意图**（还在跟随时，当前就是最新那轮，与几像素瞬时差无关）。
    通用教训：**凡是"状态"能从意图推出来，就不要用瞬时测量去反推**——
    流式下每一帧的测量都在变，反推出来的状态就会跟着抖。

64. **做不出复现的"假几何"，等于没测。**
    第一版 jsdom 用例里的 `scrollTop` 不钳制（`scrollTop = scrollHeight` 得到越界值），
    结果"贴底之后内容长高、scroll 事件用旧位置处理"这一幕根本造不出来 ——
    红检时两条用例在**故意改坏的实现**下照样绿。改成真浏览器那样钳制
    （`min(v, scrollHeight - clientHeight)`）之后，两条用例分别在
    "跟随被弄丢"和 `expected '10' to be '40'`（亮条跳到阅读线那轮）上红掉。
    同类教训：红检不是"跑一遍看红不红"，是**验证这条测试到底测没测到那个 bug**。

65. **观察者不许观察"由自己的输出决定大小"的元素。**
    用户第三轮：多次截图里梯子的位置都不一样，但他没滚；控制台连着三条
    `ResizeObserver loop completed with undelivered notifications`。
    根因：`railRef.current.parentElement` 恰好就是 `.pg-rail`，而它的高度是由
    量出来的 `bandH` 算的 —— 量自己 → 自己变 → 再量，一个极限环
    （420 → 356 → 292 → … → 0 → 420）。表现不是"明显的循环"，而是
    **"没人动，它在动"**：梯子的高度与可滚范围每帧都不同，自动跟随于是把它推到不同位置。
    同类第二处：贴底改变了滚动位置 → 虚拟化器渲染新行 → 行高被测量 → 内容高度又变 →
    观察者再触发。修法是"幂等"：已经在底部（差 ≤1px）就什么都不做 + rAF 合并每帧一次。
    通用教训：**RO 回调要么不改布局，要么改完必须能收敛**；两条都要有测试——
    断言"观察的是哪个元素"和"已到位时不再写"，都比事后看画面靠谱。

66. **报错日志里的那句话往往就是根因的名字。**
    用户贴的三条 `ResizeObserver loop ...` 直接把范围缩到"观察者自触发"，
    比"闪动"这个描述精确得多。以后遇到"界面自己在动"，先让用户把
    `[piggy][webview][ERROR]` 那几行贴出来——门禁只跑 mock，这类只在真机出现
    （真实内容的高度分布、真实窗口尺寸）的时序问题，日志比截图有用。

67. **"页"的粒度要跟着用户读的单位走，不是跟着存储的单位走。**
    用户第三轮："大部分都是虚线，不是实线"。核到根上：他那场会话 **30 轮 / 1028 步**
    （平均一轮 34 行），而"一页 50 行"只装得下 1 轮多 —— 于是打开只看得到一轮，
    刻度梯 28/30 条是"未载入"。**行**是存储单位，**轮**才是用户读的单位。
    改法是把收页规则变成"50 行 **且** 5 轮，最多 300 行 / 1 MiB"（两道闸门防一轮几百行、
    防一行 3 MB 的极端形状），并让 mock 用同一条规则（不跟上的话门禁量到的不是真机行为）。
    顺带一个好处：按轮兜底之后 `has_more` 变成精确判定（读到文件头才为 false），
    不再需要"装满一页就乐观地说还有"那种权宜口径。

68. **"看起来像坏了"也是一种 bug，虚线就是例子。**
    同一轮反馈的后半句：未载入的刻度画成虚线（照 DSH 的 `markUnloaded`）本意是"这些还没取"，
    但在"大部分刻度都未载入"的真实分布下，整条梯子看起来像"缺了一半/坏了"。
    改成同族形状 + 更短更暗之后，它一眼仍是"整段会话的地图"，而"还没取"这层意思
    交给悬停提示与点击行为去表达。教训：**视觉区分要按"最坏分布"检验**，
    在 2/30 未载入时虚线很好看，在 25/30 未载入时它就变成"坏了"。

69. **测试夹具自己会造出被测代码正确识别的形状——别急着怀疑产品代码。**
    写"工具密集会话"的夹具时，我把一轮里的 12 条工具结果全挂在了同一个父节点上
    （本意是省事），结果 `parentId` 链检查正确识别出"这是分支"，走了慢路径，
    量到 24 行。第一反应是"分页坏了"，其实是夹具造了个分支。
    教训：夹具要**造出真实形状**（链式父节点），否则测的是另一件事。

70. **"往下滚卡住"是分页只做了一个方向；而"自动续页"必须绑在用户意图上。**
    用户第四轮："点了预览滚动条非常高的位置，向下滚动就卡住，只能点按钮到最低位"。
    补了向下续页（`read_after` + `end_offset` 游标，双向都按轮收尾）。
    更要紧的是**怎么触发**自动续页：第一版挂在"滚动 + 离底距离"上，门禁实测一跳就把
    200/200 行全读进来（正是用户上一轮担心的"其实全载入了"），而且隐藏面板
    `clientHeight=0` 会让距离恒为 0、照样级联。改成**只认滚轮**：一次手势最多续一页，
    程序化滚动、布局变化、观察者回调都不会触发；滚轮之外的路径交给右下角的
    「继续往下」按钮。教训：**"自动"类行为要绑在最不容易被自己触发的事件上**
    （用户输入 > 滚动 > 状态变化），否则它一定会自我放大。

71. **判"是不是读者在滚"要问原因，不能只比位置。**
    上一轮用"位置等于我们钉的值吗"（DSH `sampledTop` 的口径）。这一轮门禁又红了：
    刚 `loadTail` 换完页就流式，视图停在离底 163px。原因是**滚动锚定**——
    内容整段换掉时浏览器会自己挪 `scrollTop`，于是"对不上钉住的值"被读成"读者滚了"。
    改成问"这段距离是谁造成的"：内容比**贴底那一刻**更高 → 是内容推的；
    位置没往上走 → 不是离开底部；只有"位置变小且内容没长"才算读者滚。
    还有一个边界：**基线不可信时不要归因**（首帧/隐藏面板量到的高度是 0，
    拿它当基线会把之后所有真实采样都判成"内容长高"）——没有可靠基线就按几何判。

72. **单测绿 ≠ 命令接上了。**
    `read_after` 自己的 20 条用例全绿，但 `session_page` 一开始**没把 `after` 路由过去**
    （红检发现：改坏命令层，Rust 单测照样全绿）——界面上点「继续往下」只会拿到同一页。
    所以补了一条**走命令**的用例（`#[tokio::test]` 直接调 `commands::session_page`，
    断言 after/before/默认三条路径各自的返回）。跨层接线要有跨层的测试。

73. **"按钮没显示"经常是"盒子装不下文字"，不是渲染没跑。**
    用户第五轮："继续往下这几个字的这个按钮就不显示了"。量 DOM 得到的事实：
    按钮**在**（`textContent` 正确、`display: grid`、可见），但盒子是 **34×34**
    —— 我加「回到最新」时只给那一个类写了宽度，另一个类沿用圆钮尺寸，
    四个字溢出到圆外，观感就是"没这个按钮"。
    两条教训：
    ① **同类按钮要用同一条规则**（写成 `.pg-to-bottom.pg-to-latest, .pg-to-bottom.pg-to-newer`
       一起给），只加一个必然漏一个；
    ② 带文字的控件要按**几何**守：门禁现在断言"盒宽 ≥ 中文 12px × 字数、高度 24~40"，
       红检时它如实报 `「继续往下」的文字被盒子裁掉（盒宽 34px，文字至少需要约 48px）`。
       单测/JSDOM 量不到这类问题（`clientWidth` 恒为 0），只有真布局门禁能拦。

74. **"点了没反应"和"动了但没用"是两种 bug，判据要写在可观察量上。**
    用户第五轮："按了继续往下结果停留在原地"。原因是向下续页只**在下面追加** ——
    追加不移动视口，所以用户看到的就是没反应。修法：点按钮时先量当前行数，
    追加后把"新进来的第一行"滚到视口顶部（滚轮触发的自动续页**不滚**，用户自己在滚）。
    门禁的判据也换掉了：不写"移动超过 200px"这种魔法数（页大小不同、mock 与真机不同），
    改成**"视口顶端那一行换成了新内容"**（`topText !== beforeText`）—— 这才是用户看得见的性质。

75. **门禁的段落之间有状态耦合，顺序就是语义。**
    这一轮门禁自己错了三次，全部是"前一段改变了后一段的前提"：
    滚轮那段一旦跑过，整段会话就读进来了，于是后一段"点未载入的刻度换窗"根本没得换
    （`hasNewer=false`、按钮也不在）；单调性检查把"手动 push 的起始状态"也算进去，
    于是第一次滚轮之前的那次换窗被读成"倒退"。
    两条例律：**① 需要"未载入"前提的段落必须排在会读完整段的段落之前**；
    **② 每个段落自己记录起始状态，别把它混进"本段内的变化"里**。

76. **同一句日志可能把三种事件写成一种。**
    `[piggy][webview][ERROR] 资源加载失败: ? ResizeObserver loop completed...`
    —— 明明不是资源加载。`window.onerror` 的三种形状（运行时异常 / 资源失败 / 浏览器合成事件）
    必须分开打，否则日志会把人带到错误的方向（这次差点让我去查资源加载）。

77. **没有调用栈的警告，就给它装一个"现场证人"。**
    合成事件（ResizeObserver 循环警告、跨域脚本错误）在 `window.onerror` 里
    **既没有 `error`、也没有栈**，靠读代码猜是谁干的——这次猜了三轮。
    正确做法是包住那个 API（`lib/resizeProbe.ts` 包 `ResizeObserver` 构造器），
    记下"谁 new 的 + 最后一次回调来自哪个创建点"，下次警告到达时直接点名。
    诊断成本一次付清，比每轮猜便宜。

78. **同一帧里连发 N 条的同一条日志＝一条。**
    用户贴的三行 `ResizeObserver loop ...` 让他以为出了三个问题。按"同文本 + 3 秒窗口
    （从第一条算起，不顺延）"折叠，窗口过后补一条 `（同类已折叠 N 条）`。
    别把折叠做成静音：数量信息必须留在日志里。

79. **观察者/监听器的数量本身就是风险指标。**
    每个"回调 → setState → 布局变"都是一条级联链的环。几百个代码块各建 1~2 个
    `ResizeObserver`，就是几百次让浏览器判定"循环没收敛"的机会。收成一个共享实例
    （`lib/resizeWatch.ts` 的 `watchSize`）之后，一次投递跑完全部回调、React 合成一次渲染。
    新写尺寸订阅前先问：能不能挂到那一个上。

80. **同一条警告在不同引擎上的"吵闹程度"不一样，别拿门禁没红当没事、也别拿真机有红当有 bug。**
    这条 `ResizeObserver loop` 在 Chromium（门禁）里从不出现，在 WKWebView（真机 macOS）
    里偶发——按规范逻辑实现会发出远多于 Chrome 的通知（csswg-drafts #6610）。
    判据只能是**可见副作用**：抖动、跳动、位置乱走算 bug；控制台多一行不算。
    这条要写进文档，否则下一轮又要重新怀疑一遍。

81. **凡是"算出来的数"直接进界面的地方，都要问一句"它是什么精度"。**
    用户报的 `上下文占用 20.316000000000003%` 不是错误值，是 f64 商没格式化。
    同一个数在三处露面（环标签、环 title、右栏），所以三处共用 `formatPercent`，
    并且**夹具要故意留尾巴**（`15400 / 75800 × 100`），否则断言是空转：
    改回整数就再也测不出这个 bug 了。

82. **"看不到细节"先分清是"没有数据"还是"没往下传"。**
    用户报"上下文压缩的轨迹无法看到细节"。核实：pi 的 `CompactionEntry` 里
    `firstKeptEntryId` / `details` / `usage` / `fromHook` 全都有，**是我们的 Rust 投影只转了 3 个字段**
    （`summary`/`tokensBefore`/`timestamp`）——数据一直在，被中间层丢了。
    投影/映射函数每加一层就有一次"字段静默丢失"的机会，判据只能是对着**上游的类型定义**
    （pi `docs/compaction.md` §CompactionEntry Structure）逐字段点一遍，而不是看界面像不像。

83. **转换层要防"把刚省下的载荷还回去"。**
    同一条目里还有个 `systemMessage`：压缩后的**整份新系统提示词**，真机一条 10 KB+。
    补字段时最容易顺手 `entry.clone()` 全转——那样一页的载荷立刻膨胀。
    所以投影函数**白名单式**逐字段列出，并用一条"塞 2 万字假系统提示词、断言它不出现"的测试钉住。

84. **`expandable` 这种开关，要有一条"它真的能打开"的门禁。**
    轨迹行的折叠分支条件是 `row.expandable && row.detail`，而构造器从来没设过这两个字段——
    于是那一行**连点都点不开**，而且没有任何测试或门禁碰过轨迹页（新写的门禁段一跑就报
    「轨迹里的压缩行点不开」）。教训：**"有折叠 UI" ≠ "有东西可折"**，
    每条可折叠的行类型都该有一条"点开后有正文"的断言。

85. **同一件事的多个事件，必须落在同一行上；失败态不许说成成功。**
    一次压缩在实时流里是三个事件（`compaction_start` → `entry_appended` → `compaction_end`），
    早先每个各推一行：轨迹里一次压缩留三行，最后一行永远写「上下文压缩完成」——
    而 pi 在 `aborted` / `errorMessage` 时**根本不落盘条目**，一次失败的压缩看起来像成功了。
    做法：`compaction_start` 建占位行 + 记 id，后两个事件按 id 复用同一行；
    失败/中断各自改口，并把"为什么没有摘要与计数"写进展开正文。

86. **"空间利用率低"是可以用像素量出来的，量完再改。**
    用户说"多工具消息时主工作区空间利用率非常低"。先写一个一次性测量脚本
    （mock + 真布局，量 `.pg-vrow` 的高度构成），拿到事实：**一个 6 行 `read` 结果 258px、
    3 行 `bash` 201px、每行还有 16px×2 外边距**，而 DSH 的一行是 24px —— 差 10 倍。
    改完用同一个脚本复量（24px / 连续三行 72px），并把数字写进门禁断言。
    **没有这一步就会变成"我觉得有点挤"**，改多改少全凭手感。

87. **学 DSH 的"窄行"，要连它的数字一起学。**
    `DisclosureRow.module.css`：行高 24、前导框 16（字形 14）、标题 13px/24px `flex:none`；
    `ToolRow.module.css`：圆点 2×2 `margin: 0 8px`、摘要 `flex:1` + 单行省略号；
    折叠时前导框显示图标、**hover/聚焦才换成箭头**。这些不是审美偏好，是设计稿定死的；
    "差不多 26px 也行"会把用户已经指出的问题原样留下。

88. **跨行的数据要先问"它在哪一行里"。**
    窄行摘要要显示命令/路径，而这些**参数不在结果行里** —— 在**上一条助手消息**的
    `toolCall` 块里（`toolResult` 只有 `toolCallId/toolName/content/isError`）。
    做法是在 store 的 `register()`（所有行的唯一入口）顺手建 `toolCallId → {name, args}` 索引；
    放在渲染层每次重算会 O(行数)，而且分页/换窗那几条路径最容易漏。
    索引断了就退到结果首行，并把来源标进 DOM（`data-summary-source`）——**别编数据**。

89. **"折叠"和"不渲染"是两件事，别用卸载去实现折叠。**
    窄行的正文用 `hidden="until-found"` + `beforematch` 留在 DOM 里：Ctrl+F 能搜到、
    读屏与复制拿得到（规矩 21）。附带好处：折叠时 `IntersectionObserver` 见不到它，
    shiki 不会白跑。门禁直接断言折叠态下正文**仍在 DOM 里**且 `display:none`。

90. **改了行的几何，所有"量几何"的门禁都要跟着改。**
    工具行一折叠，代码块探针量到的 `clientHeight` 全是 0 → "没有溢出/没有显示更多/静默失败"
    集体假红。修法是**先点开再量**（顺带把"点得开"也验了）；而且点击必须等 React 落地
    （`hydrate` 同步写 store，DOM 不是同步更新的——第一版点了空集，一段断言全红）。

91. **"输出没渲染成 markdown"这类 bug，先查"有没有那一层"，再查"那层对不对"。**
    用户截图里 `## 标题`、`**粗体**`、`---` 全是原样文本 —— 不是渲染错了，是
    **根本没有 markdown 渲染层**：`MessageView` 的 text 分支只做了围栏切分，
    而 docs/04 §5 早就写着"转正时解析一次"。文档里写着的机制没落地，比机制写错更难发现
    （读文档的人以为有）。

92. **用别人的 parser，也**别**用它的输出格式。**
    marked 的默认用法是 `marked.parse()` → HTML 串 → `innerHTML`，而它 README 第一条警告
    就是"不 sanitize，请配 DOMPurify"。我们只用 `marked.lexer()` 拿 token 树、自己出
    React 元素：于是全仓没有 `dangerouslySetInnerHTML`、原始 HTML 只当文本、
    围栏能直接换成我们那块代码卡片、外链能挂 onClick（HTML 串里只能事件委托）。
    结论：**"用哪个 parser"和"用什么格式交给渲染层"是两个决定**，别捆在一起接受。

93. **依赖一换，正在跑的 Vite dev server 就是脏的。**
    换 parser 后真机报 `this.getData is not a function`（两个 markdown 包的版本树错配），
    而 vitest 全绿 —— 因为 vitest 走 SSR transform，浏览器走 `node_modules/.vite/deps`
    的**预打包缓存**。实测缓存文件比依赖修复早 19 秒生成，所以它拿着旧版本树继续服务。
    规矩：**改完依赖 → `rm -rf node_modules/.vite` → 重启 dev server**；排查这类
    "单测绿、真机红"时，第一步是确认缓存时间戳与依赖时间戳的先后。

94. **换 parser 之前先把渲染层的契约冻住，换起来就是换一行 import。**
    这次先写了 17 条 DOM 契约测试（h1/h2/strong/li/table/code 卡片/白名单/原始 HTML…），
    然后从 micromark 换到 marked：**一条断言都没改**，全绿。反过来说，
    如果测试是断言"解析出来的 AST 长什么样"，这次换 parser 就得重写全部测试。

95. **"探测到插件才开功能"这条闸门，必须**双向**都验。**
    todo 界面由 pi 扩展提供（docs/03 §2.20）：探测到且已启用才显示。只验"装了会显示"
    等于没验 —— 反向（关掉探测后**一点都不出现**）才是用户要的那条分界线。
    浏览器门禁里这一条特别麻烦：mock 的能力开关如果只放模块变量，**重载页面就重置**，
    于是反向永远测不到；最后把它放进 localStorage（`piggy:mock:todo-capability`），
    再用一条 init script 在导航前写进去（脚本开头那条 init script 会清 localStorage，
    所以必须注册在它**之后** —— init script 按注册顺序执行）。

95b. **Piggy 不替用户打开插件里那些"拦人"的开关。**
    todo 的复杂度闸门在插件里默认关闭（`pi-todo/src/config.ts` 的默认值），而 Piggy
    **不传任何 `pi-todo` 配置、也不设 `PI_TODO_*`** —— 所以"Piggy 里默认不被拦"是
    "插件默认值说了算"的自然结果，而不是 Piggy 里埋了一条特例。反过来，用户想在终端里
    临时试一把闸门，用 `pi --todo-enforce`（只影响那一次运行），Piggy 那边毫无感觉。
    纪律：**宿主不要替插件决定策略**，否则"终端里关了、GUI 里还开着"这种分叉没人查得出来。

96. **判断"这份 JSONL 是不是线性"时，别在前缀里找 `"id":"`。**
    真机 11.7 MB 的会话里有一个 `web-search-results` 条目，写成
    `{"type":"custom","customType":"…","data":{"id":"…"},"id":"…","parentId":"…"}` ——
    结构字段在**最后 80 字节**，而载荷里的 `data.id` 与要找的 `"id":"` 一模一样。
    早先的实现把 `data.id` 当条目 id，于是"parentId 对不上"→ 整份**线性**会话被判成
    有分支 → 走整文件解析的慢路径（真机 400 ms；修好后 15.5 ms）。
    三条修正：① 只看**结构头部**（到第一个载荷键为止）；② 头部没有就看**尾部窗口**
    （最后 512 字节）且 `id`/`parentId` 必须**成对**；③ 取窗口内**最后一次**出现。
    教训：**"前缀里找字段"这类捷径，必须拿真机文件验一遍**，
    因为 pi 写条目的键顺序不保证（同一个仓里就有两种写法）。

97. **判分支前先想清楚"根条目"长什么样。**
    `"parentId":null`（根）与"没有这个键"是两件事：前者是链条的**终点**，后者是
    "这一行不在链条上"。第一版把两者都 `flatten()` 成 `None`，于是根条目被踢出链条 →
    沿 parentId 走到根时报"父条目找不到" → 整份文件被误判成走断。
    这类"两个不同的东西塌成同一个 `None`"的错，在 Rust 里尤其常见（`Option<Option<T>>`
    是有意义的，别顺手 flatten）。

98. **性能优化要用"同一次运行里的对照"说话。**
    todo 投影的 15.5 ms 单看没有意义 —— 同一份 11.7 MB 文件、同一次运行里，
    本来就要付的轮次轮廓是 8.8 ms。把对照量出来写进文档，别人才知道这个数该不该紧张。
    另外：**debug 构建的数不是数**（同一段代码 debug 400 ms / release 15.5 ms），
    报性能必须注明 profile。

99. **mock 的语义要照抄宿主，否则测的是空气。**
    单测 mock `pi.registerTool` 时，必须模拟"注册即自动激活"
    （`core/agent-session.ts:3195-3234`）—— 少了这一条，"todo_write 默认潜伏"这个
    小节的用例全绿而毫无意义。凡是被测对象依赖宿主某个**副作用**，mock 里就得有它，
    并在注释里写明出处。同样地，虚拟化器的 mock 必须让 `getVirtualItems()` 用
    **传进来的 `getItemKey`**（行键）而不是下标 —— 拿下标当键时"按行键找回锚点"
    那条路径永远走不到，用例假绿。

100. **行内的 UI 状态不许住在行组件里**（转录是虚拟化的）。
    滚出窗口的行会被**卸载**，`useState` 跟着丢。用户看到的是"我明明展开了，滚回来又折上"
    （2026-09-23 报：长思考/工具行"无法看到过程"）。凡是要活过卸载的行内状态
    （展开/折叠/显示更多）都走 `lib/rowMemory`：键 = `tabId \0 行键 \0 插槽 \0 开关名`，
    只记布尔**意图**、不记测量结果，关标签与休眠时清理。
    ⚠️ 自动判定（比如"长输出默认折叠"）必须让位于已有记忆 —— 否则卸载重挂会把用户的
    选择重新盖掉，看起来像"记忆没生效"。

101. **几何三个读数一起归零，不是"贴着底"，是"没有布局"。**
    dockview 把非活动面板的内容**摘出 DOM**（组件不卸载），此时
    `scrollTop/scrollHeight/clientHeight` 全是 0。这一对 0 有两个致命用法：
    ① 当基线记住（`gap = 0` 会被读成"已贴底"）→ 回来时 `nextFollowingFromSample`
       的"没有可靠基线"分支把跟随意图判死，视图停在半空且**再也不跟**；
    ② 当采样输入（0 位置 + 旧钉住位置 = "读者往上滚了"）→ 同样丢掉跟随。
    所以 `pinToBottom` / `recomputeActive` 都要 `clientHeight <= 0` 直接返回。
    而"有布局了吗"这个信号**不用自己挂观察者**：虚拟化器的 `scrollRect` 就是它内部那个
    观察者的读数（实测摘出时 0、回来时 622），每次变化都会让它重渲染。

102. **浏览器不还的东西，得自己记：被摘出文档的元素没有滚动位置。**
    实测 Chrome：`removeChild` → `appendChild` 之后 `scrollTop` 从 300 掉到 **0**；
    只有 `display:none` 才保留（250）。dockview 走的是前者，所以"切到别的标签再切回来"
    必然回到那一页的高位 —— 除非我们自己把位置记回来。记**行锚点**（行键 + 行顶到视口顶
    的距离，DSH `ChatScrollPosition` 同构），不记裸像素：隐藏期间上面的行完全可能变高。
    （同类：`display:none` 与"摘出 DOM"在滚动位置上**不是**一回事，dockview 源码里那句
    "scroll position is maintained" 只对前者成立。）

103. **门禁里查一个元素之前，先确认它挂在谁的子树下。**
    「回到底部」按钮是 `.pg-transcript` 的**兄弟**（挂在 `.pg-transcript-wrap` 上），
    而门禁三处都在用 `tr.querySelector('[data-to-bottom]')` —— 永远读到 `null`：
    一次"点了没反应"的点击 + 两条恒真的断言，全都没在核。凡是"断言某元素不存在/点了没变"
    的写法都要反问一句：**它有可能永远读到 null 吗**？现在那条断言补上了
    "往上滚之后按钮必须出现"，点击也真的点到了。

104. **一个名字，几个显示点，就有几条同步路径 —— 只改一处就是"左边变了、上面还是旧的"。**
    会话名在界面上有**三个来源不同**的显示点：侧栏那一行（`session_list`）、
    上方的会话头部（tabs store 的 `sessionName`）、标签页标题（dockview 面板的 `title`）。
    2026-09-23 用户报"点击重新生成标题之后，上方的标题也要更新"就是只刷新了侧栏。
    两条纪律：① 改名只有一个漏斗（`applySessionName`），侧栏/命令面板/重命名/`/name`
    都走它；② 能**派生**的就别各写一遍（标签页标题订阅 store，而不是每个入口 `setTitle`）。
    另外：后端的两个来源也要排优先级（调用方给的 vs pi 从会话文件读出来的），
    少了兜底会让"打开一个已命名的会话"显示成第一条用户消息。

105. **mock 比真机宽松，等于把 bug 藏起来。**
    mock 的 `tab_create` 以前给每个带会话文件的标签硬写 `session_name: '恢复的会话'`，
    而真机那里是 `Option<String>`：没名字就是 `null`（pi 的 `get_state.sessionName` 才
    是文件里的名字）。于是"打开已命名会话，上方标题对不对"这条在 mock 下**永远复现不出来**。
    写 mock 时对着 Rust 的类型抄（这里是 `MockTabSnapshot` 的 `session_name: string | null`），
    宁可比真机更严，也别更宽松。

106. **"打开慢"要分段量，别猜；量出来之后先看是谁的时间。**
    用户问"这 1s 是 pi 的还是你们的"。答案只有量出来才算：
    `pnpm --filter @piggy/desktop pi:cost` 逐项加扩展、逐段计时（docs/05 §5.6）。
    结果是 **pi 的地板 214 ms + 用户装的扩展 530 ms + 会话文件 50 ms**，
    我们注入的扩展与 Rust 数据面只有 12 / 25 ms 量级 —— 而**我们唯一可省的一笔**
    （`get_entries(None)` 74 ms，随会话线性）就在打开路径上。
    两条附带结论：
    · **"长会话更慢"未必是解析文件**：11.13 MB 对 0.14 MB 只差 50 ms；线性的是我们那次
      "把整段会话要回来只为拿一个 leafId"的调用；
    · **别人的配置不许我们替他改**（规矩 95b 的同一立场）：扩展慢是用户装了什么决定的，
      Piggy 不能为了快就 `-ne` 掉它们（工具会凭空消失）。

107. **恢复用的元数据不许压在用户操作的关键路径上。**
    游标（`last_cursor`）只被崩溃恢复（`revive_tab` 的增量 resync）用，
    却在 `create_tab` 里同步等了一次"整段会话"的往返 —— 打开会话每次都要付。
    改成 `spawn_cursor_init` 后台补之后，语义只弱化了"崩溃恰好发生在这 100 ms 内"
    这一种情形（退回全量 resync，前端按 `role:timestamp` 去重，不丢数据）。
    写入判据 `fill_cursor_if_empty` 抽成纯函数并有单测：**迟到的叶子不许覆盖更新的值**
    —— 游标比"前端已看到的"更新会让 resync **跳过**条目，那是静默丢消息，
    比多传一段严重得多。判据本身错了，是数据丢失级别的事故，所以它必须有测试。

108. **流式的这一行就是转录里的那一行 —— 内容必须活在 store 里。**
     用户报"工具之类的会被逐步输出，最后打印，这就非常诡异了"、"中途输出出现了错乱"。
     2026-09-24 复现（`src/test/transcript-live.test.tsx`，同一轮两次助手消息 + 一次工具执行，
     全部走真实帧通道），旧实现（`lib/live` 直写 DOM）同时犯了三个**结构性**错误：

     ```
     转正行 0  思考 · 先看看目录里有什么          ← 第一条助手消息的思考
     转正行 1  运行命令 · ls -la                  ← 工具结果
     实时行    思考 · 先看看目录里有什么现在读源码  ← ① 与行 0 重复；② 两条消息串成一句
     实时行    运行命令 · ls -la                  ← ③ read 的调用被并进 bash 行，整行消失
     ```

     · ① **两套渲染器**：提交往 store 加行，DOM 引擎那份不会自己消失 → 同一内容出现两遍；
     · ② **块按 `contentIndex` 全局编号**：而它在 pi 里是**每条助手消息从 0 重新开始**的
       （`AssistantMessageEvent.contentIndex`）→ 第二条消息的思考追加进第一条、工具调用
       追加进第一条的工具行（**静默吃掉**一个工具行）；
     · ③ **工具行由 `toolResult` 消息渲染**：助手消息里的 `toolCall` 块 `return null`，
       于是工具要等执行完才出现，工具一多就是"先长出来、再重新打印"。

     现在的模型（与 DSH 的 `assistant-step` 同构）：`message_start` 就把那一行建进 `ids`
     （带 `live` 槽位）→ 帧按**消息内**的 `contentIndex` 往槽位里累加 → `message_end` 把权威内容
     填进**同一行**并清槽位 —— 行的 id 与下标都不变，React 不重挂、不重排、不重复。
     工具行由助手消息里的 `toolCall` 块渲染（`data-state="running"`），结果按 `toolCallId`
     并进同一行（`toolResults` 索引）；调用不在窗口里时才退化成单独一行。
     推论：**"节点身份"这类 bug 从结构上消失** —— 不需要回调 ref、不需要 `attach`/`detach`、
     也不需要"一轮结束才清"。历史教训（那一轮的探针序列 `… → 11 11 11`）见 04 §4.6。

109. **可见文本要对得上"通道上发出去的字数" —— 而且只许出现一次。**
     旧口径下这是唯一的判据（`引擎的 container === .pg-live`，身份断言）：内容只在 DOM 里，
     写错节点时 DOM 上完全看不出来（那一行空着，字在看不见的节点里继续长）。
     现在内容在 store 里，等价且更强的判据是**对账**：门禁第 19 段量
     "通道发出的字数 vs 转正后可见的字数"（`committedLen === sentTotal`）**再加**
     "那段文本在转录里出现几次"—— 少了是丢字，多了就是用户报的"最后又打印一遍"。
     单测里同一个口径：两条助手消息各一行思考、工具行是 `['bash','read']` 且摘要各自正确。
     教训保留：**能被断言的东西必须有一个稳定的出口**（这里是 store 的 `ids`/`live`/`toolResults`
     与 DOM 的 `data-streaming` / `data-tool-row` 标记）。

110. **归因要看读者的手势，不能只看几何；而且只许有一条贴底路径。**
     用户报"一直向下滚动，我希望手动向上翻滚时，不会被自动跳到最底下"。
     旧实现里归因是四条规则的堆叠（`pinnedTop` + `pinnedHeight` + 手势时间戳 + 上滚意图），
     每条都为某一个 bug 打补丁 —— 其中"内容比上次采样更高 → 继续跟随"这条在流式时每 16ms
     命中一次，于是读者滚轮那次采样也被它吞掉，下一帧贴底把人拽回去；实时块引擎自己那条
     rAF 贴底还在同一侧加一脚（真浏览器实测：`wheel(0,-25)`×4 之后 `gap` 恒为 0）。
     现在两层各自只有一句话：
     · **归因**（`TranscriptViewport.readScroll`）= "位置相对**上一次被认可的位置**变了没有"，
       变了才算读者滚的（程序化贴底、内容长高都不算）；
     · **跟随**（`ScrollFollow`）= "读者自己滚过才重新判定意图"，而**贴底只有一条路径**
       （`following` 为假时 `toBottom` 根本不会被调用）—— 不存在"第二只手"。
     另加一条用户明确要的行为：**上滚手势当场交还控制权**，并在 400ms 的兑现窗口内不许被
     "贴着底"的 25px 容差反悔（一格滚轮正好 25px 上下，容差会把每一格都吞掉；门禁实测
     4 格全被按回底部，读者永远翻不上去）。兑现（位置真的往上走了一格）或超时才回常规规则。
     门禁第 20 段用**真滚轮**（合成 `WheelEvent` 不会真的滚）量：第一次 `wheel(0,-25)`
     就出现「回到底部」→ 1.1s 内容长 288px 而位置 `movedDuringHold 0` → 滚回底部 `gap 0`。

111. **流式正文也要渲染 Markdown —— 但不许每帧全量 parse，也不许重挂。**
     2026-09-24 用户问"对于模型输出，可以做到部份渲染 markdown 吗？"。
     早先的口径是"流式纯文本、转正才 parse"（04 §5.1），理由是"中间态的 Markdown 是非法文法，
     每个 delta 跑一遍 parser 必然抖动且浪费 CPU"——前半句对，后半句只对**全量** parse 成立：
     5.8KB 全文 ≈541 µs/次，80 字符尾部 ≈11 µs/次；1.47KB 文档按 24 字符/帧流式，
     解析字符数少 90.4%。而"抖"的真正来源不是解析、是**重挂**。
     三条实现约束（每条都踩过或量过）：
     · **键 = 块的绝对源偏移**（`marked` 的 token 带 `raw`，累加严格等于源串长度）——
       用下标的话，前面的块一合并/拆分，后面全部重挂；
     · **切点落在空行之后**（或文末）：就地切开会让 setext 标题、缩进代码、列表惰性续行变义。
       守卫是"冻结区的 DOM **节点身份**不变"（`toBe`，不是内容相等 —— 整棵重建但内容恰好一样
       正是要拦的那种），六种构造逐个流式跑；
     · **冻结段与尾部拼成同一个数组**：写成 `{frozen}{tail}` 两个数组兄弟时 React 按"第几个数组"
       给隐式键加前缀，块从尾部挪进冻结区就换了键 → 卸载重建（实测：标题在冻结那一帧闪掉）。
     固有代价（写进文档，别当 bug）：尾部 1~2 块会看到"字面符号 → 成形"的跳变；
     流式中的围栏不上色、不自动折叠。门禁第 21 段断言"流式途中标题与粗体已经成形"。

112. **不要给 DSH 已有的行为自造规则 —— 逐条对标，偏离清单定期清零。**
     2026-09-24 用户："有意偏离 DSH 的行为，都对标 DSH，无需发明创造。"这句话值得当成一条
     长期纪律，因为偏离的代价不是"风格不同"，而是**两份行为契约**：门禁、单测、文档都要维护
     两套口径，而 DSH 那边的实现是经过真实使用检验的。这一次清掉的（清单见 docs/14 §4.1）：
     · 滚轮往上当场交还控制权 + 400ms 兑现窗口 → 回到 DSH 的**采样**口径（`scrollend`/500ms，
       窗口内谁都不许贴底）；
     · `hidden="until-found"` 折叠正文留在 DOM → 回到 DSH 的 `{open && children}`；
     · 自造的 opacity 呼吸 → DSH 的 `TextShimmer`（复制文字 + 移动遮罩，几何不变）；
     · 思考摘要首行 → DSH 的"最后一个已完成段落的首行"（+ 折叠行 `contain: size layout`）；
     · 刻度梯"最小幅度修正" → DSH 的 `scrollToIndex(activeIndex, 'if-needed')`（居中 + 平滑）；
     · 未载入刻度/忙碌刻度的数值与动效 → 照抄 DSH。
     为什么要写下来：每一条"我觉得这样更好"都曾经**看起来**是对的（甚至当过用户反馈的修复），
     真正的问题是它们**只在一个方向上被验证过** —— 而 DSH 的口径在那儿跑了很久。
     判据：动手改 DSH 已有行为之前，先在 DSH 源码里找到对应实现；找不到再自己定，
     并在这里记一条。

113. **间距挂在容器上，不要挂在兄弟选择器上。**
     用户报"输出有时候行间距很大，有时候很小"。量出来的现场是三种间距在同一屏里交替：
     转录行之间 16px 或 32px（`.pg-message` 16px、`.pg-user-row` / `.pg-compaction` 各写各的）、
     正文与工具行之间 **0px**（`.pg-assistant-body > * + * { margin-top }` 被窄行自己的
     `.pg-trow { margin: 0 }` 顶掉）、窄行之间 16px。
     现在统一到 DSH 的两级节奏：转录行 12px（DSH 的 response flow gap）、窄行之间 6px
     （DSH 的 process flow gap）、正文两侧 12px、改动文件卡片 4px、操作行 16px —— 全部有
     DSH 源码逐条对应（04 §2.5b 有表）。
     判据：**flex `gap` 长在容器上，子元素的 margin 顶不掉它**；反过来，只要间距写成
     `> * + * { margin-top }`，任何一个"自己写了 margin: 0"的组件都会悄悄改掉节奏。

114. **输入法合成期的回车必须挡掉 —— `isComposing` 单独用不够。**
     用户报"macOS 下如果输入中文，回车是选择，但是消息还是被发出去了"。原因是**时序**：
     确认候选词时浏览器先发 `compositionend`、**再**发那个 `keydown`，于是 `isComposing`
     已经是 `false`。照抄 DSH 的 `observeComposition`（`ui-primitives/src/keyboard-composition.ts`）：
     记住"合成刚刚结束"（`ended`），把紧随其后的那一次 keydown 也算作合成，直到 `keyup`
     释放；另补 `keyCode === 229`（老引擎唯一的线索）与 `blur`（输入法被系统收走）。
     守卫挂在 document 上（合成事件不一定落在 textarea 上），Composer 的 keydown 第一行就查它。
     守卫单测 6 条 + Composer 端到端 1 条（红检：去掉守卫 → "合成期的回车把半成品发出去了"）。

115. **一个类名给两个东西用，就是在给自己埋雷 —— 改哪个都像在修另一个。**
     用户报"如果会话预览滚动条设置为左边，显示就会很奇怪，有错误"。现场：转录的刻度梯左置时
     nav 变成 **56px 宽的深色竖条**（正文左边一条黑带），里面的滚动容器宽度塌成 **0**
     —— 刻度一根都看不见、点不到，预览框也弹不出来。
     根因不是几何算错，是**类名撞车**：刻度梯的左右两态原来叫 `.pg-rail-left` / `.pg-rail-right`，
     而 `.pg-rail-left` 早被**折叠后的侧栏图标轨**占了（56px、flex 列、侧栏底色 + 右边框）。
     nav 同时命中两条规则，后出现的那条（侧栏）赢。
     现在刻度梯用 `pg-rail-at-*`（与 `data-rail-side` / `data-rail-placement` 同一套词）。
     判据：**给元素起类名前，先在整个 `styles.css` 里搜一遍这个名字**；
     而"只在一种状态下量过"的功能，另一种状态必须有一条断言 —— 门禁第 15b 段就是走
     「设置页 → 左侧」那条真实路径量几何（宽 28、滚动容器有宽度、预览框朝正文那侧弹）。

116. **会话级的状态不许写到应用级的位置上。**
     用户："本会话内的提示，比如重试中这种，不要展示全局，展示在会话内即可。"
     重试/压缩原先写 `tab.banner` 字符串 → `AppFrame` 渲染成**应用顶部横幅**（外加一条
     同文案挂在输入框上方）。后果：看 B 会话时顶部在报 A 会话正在重试，而且横幅与它描述的
     那一轮**没有任何位置关系**。
     现在它们是转录里的行（`role: 'notice'`），三条纪律见 04 §2.1.2，其中最容易漏的是
     **位置**：提示行必须进 `ids`，否则重试之后新起的流式行会插到它前面，读起来像"先回答、后重试"。
     判据：写状态之前先问"这是**谁的**状态" —— 属于一个会话的就进那个会话的转录/面板，
     应用顶部只留"整个应用的事"（启动失败、worker 反复崩溃）。

117. **没有读者的字段就是纯粹的扫描与 IPC 负载 —— 连 Rust 侧一起删。**
     `session_todo` 的投影曾经多转 `clearedByTurn`（"被新一轮清空"还是"从来没写过"）与
     `writes`（写过几次）。前端在同一个改动里就把它们删了（那条"上一轮的任务清单已归档"的
     弱提示也删了），但 Rust 侧还在**每次打开会话时**扫全文件把它们算出来、序列化、过 IPC。
     现在连字段一起删；`turn/start` 清空这条**行为**保留（`fold_projection` 里仍有 `cleared`
     决定要不要回 `None`），只是不再对外声明"这是被清空的"。
     判据：删前端消费点时顺手 `grep` 一遍后端字段名 —— 反过来也一样。

118. **能拿"实际结果"就不要拿"意图" —— diff 尤其如此。**
     用户："DSH 可以展示 DIFF，我们能不能也搞。" DSH 的 diff 由宿主服务给（工作区快照），
     Piggy 没有那套服务，但**也不需要**：pi 的 `edit` 结果 `details.patch` 就是
     标准统一 patch，**实际落盘**的结果（模糊匹配、行尾归一化、`replace_all` 都算进去了）。
     拿调用参数（`edits[].oldText/newText`）自己推一份是**猜**——DSH 在工具还没返回时
     只能这么猜，并把那份叫 *intended* diff。Piggy 不在没结果时显示 diff（宁可不显示）。
     两个附带教训：
     · **派生值的依赖要数全**：改动行数在 `indexToolResult` 时算好，派生表按
       `commitSeq` **和 `ids`** 重算 —— `hydratePage` 不涨 `commitSeq`，
       只订阅它会让"打开会话时算出的空表"被一路记住（实测卡片上的 `+N -M` 永远是空的）。
     · **没有的数据不要编**：`write`（pi 的 write 结果没有 `details`）与"结果还没到"的
       文件**只显示路径**，不显示 `+0 -0`（卡片早先只敢显示文件计数，正是这个原因）。


119. **折叠/展开这类"用户意图"，键要挑跨载入稳定的那个，写入要换引用。**
     做回合级过程折叠（DSH `TurnProcessNodeView`）时踩到两类，都记在这里：
     · **键**：第一版想用行 id（`role-时间戳-序号`）当"哪一轮"的身份 —— 它是每次载入现生成的，
       重开同一会话就变，折叠记忆等于每次重置。改用**会话文件里的字节偏移**（分页读来的行都带），
       重开也稳；实时追加的行没有偏移时退回行 id（至少同一次载入内是对的）。
     · **写入**：`stores/turnFold.ts` 第一版在 `set` 里就地改 `s.open[tabId][key]` 并 `return s` ——
       zustand 见到"新状态 === 旧状态"**不通知订阅者**，而选择器 `s.open[tabId]` 因 `Object.is`
       相等也不重渲染：**点了没反应**（实测：store 里值已经翻了，DOM 一个字节没变）。
       浅拷贝两层换引用之后才对。判据：**凡是"界面要点一下才变"的 store，写入必须换引用**。

120. **新加一层折叠，等于给所有"量行"的门禁加了一个前置条件。**
     回合级折叠上线后，门禁里 7 段、单测里 3 个文件立刻变红 —— 它们量的是**行**
     （工具行 24px、清单行、分页锚点文本），而**折叠 = 不渲染**，行根本不在 DOM 里。
     这类"全局默认值改动"的连带影响不可能靠逐段打补丁收场，处置口径应当统一：
     · **单测**：那几个文件在最外层显式把档位设成"关掉折叠"（`verbose`），并写明为什么；
     · **门禁**：整轮跑 `verbose`，但**每次 `page.goto`/`page.reload` 之后都要重设一次**
       （档位是 store 状态，重载就回默认；中途几段还会保存设置，也不能只在开头设一次）。
       走 `__piggyStores.useAppConfig`（应用自己那一份实例）而不是另 `import` 模块。
     判据：**加一个"默认生效"的显示层，先问"哪些门禁量的是它藏起来的东西"**，
     再决定是放开门禁还是让门禁显式关掉它（这里选后者，因为那些段测的不是折叠）。


121. **界面状态一旦落到 localStorage，测试之间就会互相串。**
     跨重启的阅读位置（04 §2.1.7）进 `localStorage` 之后，`transcript-page.test.tsx` 里
     一条"打开即贴底"的断言开始读到 1300 而不是 1600 —— 看着像滚动逻辑坏了，其实是
     **上一个用例存下的位置被下一个用例还了回来**（jsdom 的 localStorage 在同一文件内共享）。
     处置：`src/test/setup.ts` 里每个用例前清一次。⚠️ 那里还有一个更隐蔽的坑：
     守卫写成 `if (typeof beforeEach === 'function')` —— 本仓**没开 `globals`**，
     这个判断永远为假、静默不生效（红了才被发现）。要么显式 `import { beforeEach } from 'vitest'`，
     要么别写守卫。

122. **门禁"每次导航清 localStorage"与"跨重启"是天生冲突的，得显式重播。**
     `ui-startup-check.mjs` 第一条 init script 每次导航都 `localStorage.clear()`
     （"干净启动"的口径），于是想核对"重载之后还记得读到哪"就必须自己造现场：
     在重载**之前**再注册一条 init script（注册顺序 = 执行顺序，它排在清空之后），
     把**这段会话的数据与刚存下来的位置**重新写进去。真机不需要这一手 ——
     pi 的 JSONL 与我们的 localStorage 本来就在磁盘上。另外两条同源的坑：
     · mock 的转录是模块级内存状态，重载即回内置演示会话（所以那一段要显式重播数据）；
     · 重载恢复的是**更早那份布局快照**，不一定是刚才那个会话 —— 要像真用户那样，
       重启之后再按 `data-session-path` 精确点开同一个会话，别假设"重载完还在原地"。


123. **immer 生产者里不许再 `set`；闭包里的旧状态不许写回。**（2026-09-25，插件与提问卡这一批）
     两条都是"红了才发现"的类型，记在这里：
     · **嵌套 set**：把"扩展报错行"抽成一个 action（`extensionError`）之后，`applyCommit` 的
       `case 'extension_error'` 里改成 `get().extensionError(...)` —— 那已经在 immer 生产者的
       `set` 里面了，**再调一次 set 会被静默吞掉**：转录里那一行又不见了，而代码看起来更整洁。
       处置：抽出**模块级**函数（`pushExtensionNotice`），生产者里直接调用它。
     · **闭包里的旧状态**：提问卡的自由文本 `onChange` 原来是
       `setDraft((d) => ({...d, [q.id]: {...state, custom: e.target.value}}))` —— `state` 来自
       那次渲染的闭包，"先点选项、紧接着打字"时两次更新会在同一批里合并，于是刚点的选项被
       空 `selected` 覆盖。单测（`act` 会强制刷新之间）**测不出来**，是门禁第 27 段
       （真浏览器、真点击、真打字）抓到的。处置：从 `d` 里取当前值。

124. **宿主与插件之间的"信封协议"，两边都要有契约测试。**（2026-09-25）
     提问卡靠一个约定通信：插件在 `ui.select` 的**标题**里写 `piggy:ask:v1:<toolCallId>`。
     这类约定最容易烂在"两边都改了一点"。`src/test/plugin-contract.test.ts` 钉住：
     前缀与提交选项两边一字不差、`piggy-plugin.json` 申报的工具/命令在 `index.js` 里真的注册了、
     宿主卡片处理的工具名与清单一致、**不允许出现 npm 依赖**（目标机器可能没有 node/npm）、
     目录内容白名单（多一个文件就该有人解释为什么）。
     另一头是**真机探针**：`node scripts/pi-plugin-probe.mjs` 用系统上的 pi 真跑一遍
     （能加载 / 命令与工具在 / `--tools read` 会把插件工具过滤掉 / 加进白名单后回来 /
     两份同名插件会让 pi 不进会话）。门禁跑在 mock 上，这两层缺一不可。


125. **"等用户回答"也是一种"没结束"——折叠/省略这类默认值要先想清楚"什么不能被藏"。**（2026-09-25）
     回合级过程折叠上线后，提问卡所在的工具行**属于过程**：pi 正阻塞在工具调用里，
     既没有流式行、`streaming` 也是 false，于是按"有流式行才算没结束"的判据，那一轮被
     判成已结束 → 整段过程连同**提问卡**一起被折起来 —— 用户看到的是一个
     「已完成工作 · 0s」，而"要回答什么"根本不在屏幕上。门禁当时跑在"完全展开"档下，
     **全绿**；是截图时肉眼发现的（`lib/turnFold.ts` 的 `pendingQuestion` 就是为它加的）。
     两条教训：① 给"默认折叠"这类功能列不折清单时，要把**交互中**的状态都列一遍
     （正在跑 / 等回答 / 中止 / 失败）；② 门禁跑在某档位下时，**要有一个段专门跑默认档**
     —— 否则默认档的 bug 会被"统一口径"藏起来。


126. **"回合尾"的东西挂在回合上，不要塞进某一行里。**（2026-09-25，用户指着 DSH 的改动卡片提要求）
     DSH 的 `ChangedFiles` 挂在 `conversation.chat.turnTail`（回合尾插槽），Piggy 原先把它渲染在
     **助手行内部**。回合级过程折叠上线后，那一行属于"过程"→ 被折起来 → **卡片一起消失**：
     用户折起过程就再也看不到"这轮改了哪些文件"（截图才发现；门禁当时也跑在"完全展开"档）。
     处置：`Transcript` 按段聚合改动文件，挂在**这一段最后一行的槽位**上（折叠只藏过程行、
     不藏卡片），`MessageView` 不再自己渲染它。判据：**新一轮"默认折叠/隐藏"的东西上线时，
     先问"哪些内容是回合级的、必须留在外面"**（提问卡、改动卡片都是这一类）。

127. **门禁的手势别压在判定的边界值上。**（2026-09-25）
     第 20 段（流式中读者上滚）原来用 `mouse.wheel(0, -25)`，而跟随容差恰好是 25px
     （口径 `gap ≤ 25` 算贴底）：每一步滚完 gap 正好 25 → 判"还在底部"→ 拽回去 → 下一步又是 25，
     读者永远逃不掉；量到的东西取决于那个窗口里流式内容有没有长过 1px —— 同一份代码
     **4 次里挂 3 次**（时红时绿，最难查的那种）。改成 -60 之后连续两次全绿。
     边界本身该由**单测**钉（`transcript-page.test.tsx` 的「容差就是容差」），门禁量的是
     "明确超出容差之后行为对不对"。判据：**写门禁手势时先看一眼判定阈值**，
     用"明显不在边界上"的输入。

128. **「spawn 之后的失败必须收树」要有唯一漏斗，漏没漏由源码闸门管。**（2026-10-09 复查）
     这条不变量是 `e8c4b02` 写下的，但它只落在 `create_tab` 一条路上 ——
     `revive_tab`（崩溃复活 / 休眠唤醒 / 切权限档）里还有**四处裸 `?`**：
     worker 既不在 `tabs` 里、进程又活着，而 `spawn_worker` 的 stdout/stderr reader
     任务各持一份 `Arc<WorkerInner>`，所以连 `kill_on_drop(true)` 都触发不了。
     症状不是报错，而是"某个标签页崩过一次之后，打开会话越来越慢"（孤儿握着会话文件）。
     处置：`bind_or_kill(worker, fut)` 做唯一漏斗，复活路径每一处失败都走它；
     再加一条**源码文本闸门** `revive_reaps_the_worker_on_every_post_spawn_failure`
     （扫函数体里有没有 `worker.*.await?` 不带 `bind_or_kill`）—— 这类"少写一处"的错误
     类型系统表达不了，只能让它在 CI 里红。判据：**写下一个"凡 X 必须 Y"的不变量时，
     先数清 X 有几条路径，并给它一条能在 CI 里红的闸门。**

129. **别把"要等几十秒的事"放在全局锁里 —— 时间性质的不变量要用契约级用例量。**
     （2026-10-09 复查）`create_tab` 原来是「锁内 spawn → **锁内** `get_state`（40s 预算）
     → 锁内记账」，而 `worker_of` 走同一把全局锁：一次慢启动会让**所有标签页**的命令一起卡住。
     处置：三段式 `create_tab_unlocked`（锁内 spawn → **锁外**握手 → 锁内记账），
     复活同理（`revive_unlocked`，还多了"正在复活"占位防止两个调用给同一份会话文件拉两个 pi）。
     **这条不变量单测证明不了**（它说的是"锁没被占着"），所以加了契约用例 C15：
     真 pi 建 tab 的同时不停抢锁，断言最久一次等待 < 300ms（红检过：把锁握过握手 → 480ms 红）。
     判据：**"耗时 × 持锁"这种组合要么拆开，要么用能红的时间断言钉住。**

130. **`--tools` 不是权限边界。**（2026-10-09，pi 1.1.0 实测）
     pi 1.1.0 的 MCP 过滤判据是"白名单里有没有 `mcp__` 前缀的名字"（`agent-session.ts`），
     所以「仅可查看」档**照样会把用户配的 MCP 服务器拉起来**（stdio stub 实测被 spawn）。
     工具本身不会声明给模型（要走 `tool_search`/`codemode`，而它们也被过滤了，
     pi 自己会回一句 "MCP tools are only reachable from the codemode or tool_search tool"），
     但"限制档去启动本地进程 / 打开网络出口"与这一档对用户的承诺不符。
     处置：限制档的 argv 末尾显式加 `--no-mcp`（放末尾是因为老版本 pi 把它当未知 flag 收进
     `unknownFlags`，后面跟值才会被吃掉）。判据：**"我不给模型这个工具"与"我不启动这个东西"
     是两件事，权限档位要为后者单独表达。**

131. **回答一个"已经不存在的提问"，绝不该拉起新进程。**（2026-10-09 复查）
     `ui_reply` 原来走 `worker_of`（会按需复活）：worker 崩了/被回收之后，用户点提问卡的
     "提交"会**复活一个新 pi** 再把 `extension_ui_response` 写进去 —— 新进程从来没发过那个
     `extension_ui_request` id，回答被静默吞掉，用户看到的是"点了没反应"。
     处置：`ui_reply` 只认 `ready_worker`（拿不到就明说"提问所属的会话已经不在了"），
     前端在 `crashed`/`sleeping` 时清掉待答卡片（与 `agent_settled` 那支对称）。
     判据：**"按需复活"只适用于"用户要继续用这个会话"，不适用于"回答一件已经过期的事"。**

132. **升级 pi 时要"六处锚点 + 一次真机契约"一起走，缺一处就是静默漂移。**（2026-10-09）
     用户把本机 pi 从 0.87.1 升到 1.1.0，复查发现：**协议面是透传兼容**
     （`git diff v0.87.1 v1.1.0 -- src/modes/rpc/` 的全部差异只有 `prompt/steer/follow_up`
     响应多一个 `data.disposition`；26 个用到的 RPC 方法、事件联合、`extension_ui_request`
     的七个 method、会话 JSONL 条目类型**逐字段无破坏**；bridge 对着真实 1.1.0 的
     `dist/index.d.ts` 跑 `tsc --noEmit` 零错误），但**我们自己的锚点全过期了**：
     两个生成物快照（provider 目录 41→42 条、`azure-openai-responses`→`azure`；
     内置扩展 1→4 条）、`fetch-pi-standalone` 的默认下载版本、bridge 的 devDependency、
     文档里的"当前 0.87.x"、以及一条 `assert!(text.contains("0.87"))`。
     更糟的是**CI 里没有任何一条会发现**：契约作业装的是不带版本的 `@latest`，
     两个生成器的 `--check` 需要 pi **源码**（CI 只有 npm 包）。
     处置：把"验证过的 pi 版本"收成**一个锚点**（`fetch-pi-standalone.mjs` 的默认
     `--version`），其余五处由 `apps/desktop/scripts/check-pi-pin.mjs` 对账
     （frontend 与 contract 两个作业都跑；contract 作业另加 `--installed` 比对真机版本），
     CI 安装版本也固定下来。判据：**"我们一起验证过的东西"必须有一个可对账的单一锚点；
     散落的版本号迟早会互相矛盾，而且不会有人报错。**

133. **快照的"事实性描述"也是快照的一部分。**（2026-10-09，同一次复查）
     两个 `*_generated.rs` 里都写着**给用户看的结论**，而结论会随 pi 版本失效：
     · 内置扩展那句"随 pi 发布，不可增删，`-ne` 也关不掉" —— 1.1.0 起它们是合成路径
       `builtin:<name>`，走普通资源解析，settings 写 `-builtin:<name>` 就能单独关掉
       （真机核对 mcp 与 llama.cpp 各一遍），`-ne` 也真的能关。于是插件页的"开关禁用"
       成了假话 —— 已改成**可停用**（写全局 settings 的规则），并补 `replaceable`
       （`omitReplacedExtensions`：codemode / tool-search / mcp 可被别的扩展顶替）。
     · 文档里那句"`pi --version` 低于锚点就阻断建会话" —— 全仓根本没有 semver 比较，
       `--version` 只被存进 `PiBinary.version` 供显示。已改成实话（并说明为什么不加门禁：
       它会在"用户自己装了更新的 pi"时挡住一个实测能用的组合）。
     判据：**拍快照时，凡是"因为当时的事实才成立"的说明，都要在同一行标出它的前提**
     （版本号 / 实测日期），否则下一个人会把结论当常量用。

134. **"互为金标"的两份清单挡不住"两边都忘了"。**（2026-10-09）
     `legal.rs::THIRD_PARTY`（应用内「许可与第三方声明」）与 `THIRD_PARTY_NOTICES.md`
     互为金标、有双向核对测试 —— 但 `pi-todo` 从 10-06 起就随包分发，
     **两份清单都没登记**，而测试是绿的（两边同缺 = 一致）。
     处置：补登记（版权人 `wxk6b1203`、MIT），并在这里写下真正的判据：
     **"两份清单互相一致"与"清单是完整的"是两件事**；前者能测，后者只能靠
     "新增资产时有一处**必须**改的入口"（这里是 `vendor-plugin.mjs` 的收尾提示
     与 docs/17 §2.2c 的清单）。同族的还有"生成物快照与 pi 源码一致"（规矩 132）——
     一致 ≠ 最新。

135. **给模型看的工具名，和给权限档位看的工具名，不是同一张表。**（2026-10-09）
     `--tools` 白名单是权限档位的**边界**，而插件的 `tools[]` 是"我注册了什么"的申报。
     把两者直接取并集，在"插件顶替内置工具"这一情形下会**静默提权**：
     pi-guardrails 注册的是内置同名 `write`/`edit`（写前校验），并进「仅可查看」档的
     白名单就等于把只读档变成可写档 —— 而当时的单测全是静态常量，一条都没抓到。
     处置：清单加 `"allowlist"`（默认 true 保持老行为），覆盖型插件显式写 false；
     闸门两条：`plugin-contract.test.ts`（申报内置工具名 → 必须显式 allowlist:false）
     与 `pi/process.rs` 的 **argv 级**用例（限制档的 `--tools` 里不许出现 write/edit）。
     判据：**凡是"合并两张表"的地方，先问这两张表的语义是不是同一件事** ——
     不是的话，合并规则本身要能被显式关闭，并且要有闸门盯着合并结果（不是盯着输入）。

136. **"等得久"与"看起来像卡住"是两个问题，先解决后者。**（2026-10-09，用户："每个新的会话打开都要等时间"）
     实测（docs/05 §5.6b）：打开一个会话的 527 ms **几乎全是 pi 自己的启动**
     （node + 用户的扩展 + 读会话文件），我们这边能省的只有几十毫秒 ——
     也就是说"把时间压下去"这条路当时只剩预热池（§5.7）。
     但用户真正受困的不是那 500 ms，而是**这 500 ms 里屏幕上什么都没有**：
     `createTabGuarded` 要等 IPC 回来才 `addPanel`，用户点了没反应只能再点一次
     （于是又撞上重复创建那条路）。处置：乐观 UI —— 点击后立刻画占位标签
     （`session:pending:*`），`tab_create` 回来换成真面板；门禁第 29 段量到
     **13.7 ms 出现**（mock 的 tab_create 是 250 ms）。
     实现里的四条纪律：① 占位必须是**另一个面板 id**（真 dockview 对重复 id 直接抛），
     换的时候先加真面板再关占位；② 同一份"要打开的会话"只允许一个占位（连点两次）；
     ③ 占位**不进布局持久化**（否则重启后多一个「会话文件不存在」的僵尸标签）；
     ④ 只在**一个漏斗**里实现（`openSessionTabOptimistic`），四个入口都走它。
     判据：**遇到"用户说慢"，先分成"实际耗时"与"第一帧反馈"两笔账** ——
     后者通常便宜得多，而且它才是"卡住"的来源。

137. **把"进程复用"做进事件通道时，第一件事是让"我是谁"变成可重绑的。**（2026-10-09，预热 worker）
     worker 的 stdout reader 与合帧器各自把 `tab_id` 拷进闭包，于是"这个进程往哪个通道发事件"
     在 spawn 那一刻就定死了。这在"一个会话一个进程"下一辈子不会出错，而预热池要做的正是
     **把一个已经起好的进程交给另一个标签页** —— 此时错误的形式是**静默串台**
     （新标签的流式内容发到旧标签的通道上，两边都不报错）。
     处置：`tab_id` 改成 `Arc<RwLock<String>>`（`client.rs::TabSlot`），reader 与合帧器
     **每次发送前读一次**。
     ⚠️ **2026-10-13 更新**：预热池整体删掉了（理由见 docs/05 §5.7）——
     它唯一的改写入口 `rebind_tab()`、契约用例 C16 都随之删除。
     **但这条判据本身没过期**：共享槽留着（没退回成裸 `String`），
     `coalesce.rs::frames_follow_a_rebind` 也留着 —— "帧的通道名在 flush 时读、不在构造时拷"
     与预热无关，坏了就是静默串台。
     判据：**只要一个标识是在"创建时"被捕获的，而系统打算复用那个对象，就先把标识改成可重绑的** ——
     并在改完的那一刻补一条"改绑之后行为跟着变"的用例。
     （补一条 2026-10-13 的教训：**删掉复用方之后，别把这条不变量一起删掉** ——
     它当初是为复用立的，但它保护的是"事件归属"这件独立的事。）

138. **"收录别人的代码"要先把署名权弄清楚，再谈机制。**（2026-10-09，收录 pi-guardrails）
     pi-guardrails 是作者自研、`package.json` 写着 MIT，但**仓库里没有 LICENSE 文件**。
     `vendor-plugin.mjs` 遇到这种情况会按 SPDX 补一份正文 —— 而**版权人只能写成占位符**
     （"上游作者（见 vendor.json 的 source）"），也就是说"随包分发"这件事的署名义务
     实质上没有被履行，只是脚本替我们闭了一只眼。
     处置：作者补上 `LICENSE`（写明版权人），脚本侧同时修一处：**有 LICENSE 文件时
     以前会把 SPDX 丢掉**（清单里显示"见 LICENSE"，用户在设置页看到的是"不知道什么许可"），
     现在文件优先、SPDX 仍作标签，两者不一致时以文件为准并打印提醒。
     加上 **`--no-allowlist`**（覆盖型插件，见规矩 135）才是完整的一次收录。
     判据：**许可证闸门只能证明"有正文"，不能证明"署名对"** ——
     收录第三方时人工确认版权人是谁，比让脚本生成占位符更省事。

139. **"顶替内置工具"与"限制档位的边界"是两个正交的机制，组合起来才要证据。**
     （2026-10-09）pi-guardrails 注册 pi 的内置同名 `write`/`edit`，而 Piggy 的
     「工作区内修改」边界挂在 `piggy-guard.js` 的 **`tool_call` 钩子**上。
     这两者会不会互相顶掉？读 pi 源码可以确定不会：`tool_call` 由**会话层**在
     `beforeToolCall` 里按**工具名**触发（`core/agent-session.ts::_beforeToolCall`），
     与"这个工具是谁注册的"无关；注入顺序（守卫 → 桥接 → 捆绑插件）还保证守卫先判定。
     但"读源码确定"不够 —— `apps/desktop/scripts/pi-plugin-probe.mjs` 里补了两条**真机组合断言**：
     守卫 + pi-guardrails + `--tools read,grep,find,ls` → `getAllTools()` 里没有
     `write`/`edit`；**不传** `--tools` → 两个都在（这条反向断言让上面那条不至于"永远绿"）。
     再加一条**行为层**的组合检查（`apps/desktop/scripts/guard-combo-probe.mjs`，三次极小模型调用、
     不进 CI）：越界写被路径守卫拦、未读就改被 pi-guardrails 拦、新建文件放行。
     判据：**凡是"两个机制各自都对、合起来才对"的地方，闸门要量组合后的结果**，
     并且配一条反向断言证明被测对象真的在场。
     ⚠️ 这条行为检查的断言必须是**"那次调用被拒了、理由属于哪个护栏"**，不能是"文件最终没变"：
     后者假绿 —— 模型被拦后自己 `read` 再重试（拦截文案就是这么建议的）→ 文件真的变了 → 拦了判红；
     模型压根没调工具 → 文件没变 → 没拦判绿。两种情况的终态完全同形。第一版踩了这个坑，
     2026-10-09 修掉，并做了反向验证（摘掉两个 `-e` → ①② 如期变红、③ 仍绿）。
     判据补一条：**凡是用"终态"当证据的地方，先问一句"机制失效时这个终态会不会一样"。**

140. **"进程复用"会把"启动时算一次"的策略变成过期策略。**（2026-10-10，预热 worker 审计）
     「工作区内修改」档的写边界原本读 `PIGGY_GUARD_ROOTS` —— 那是 **spawn 那一刻**写死的
     （`pi/process.rs`），而预热 worker 会被复用去开**别的项目**的会话：
     `switch_session` 改的是**会话 cwd**，**不改进程环境**。于是被复用的进程切到项目 B 之后，
     边界还停在项目 A —— **写 B 被拦、写 A 反而放行**（两个方向都错，且完全静默）。
     修法：边界**每次 `tool_call` 现算**，权威来源是**会话自己的 cwd**
     （`ctx.sessionManager.getCwd()`；⚠️ **不能**用 `ctx.cwd` —— 那是 pi 的**冻结值**，
     `switch_session` 之后不会变），环境变量降级为兜底，两者都没有才 fail-closed。
     判据：**凡是"复用同一进程去干另一件事"的地方，先查一遍"哪些状态是启动时算的"** ——
     进程启动那一刻的环境/参数里，凡是描述"这次会话"的部分都会过期。
     反向验证：把守卫改回"加载时算一次"，入口那条用例立刻变红
     （注意：`boundaryFor` 的纯函数用例**照样全绿** —— 所以"逻辑对"不等于"接线对"，
     接线必须有自己的一条断言）。
     ⚠️ **2026-10-13 更新**：预热池已删（docs/05 §5.7），这段注释里"被复用去开别的项目"
     那个现场不复存在 —— **但修法与用例原样保留，因为它们与预热无关**：
     `switch_session`（崩溃复活、切权限档位重启）照样会在**同一个进程里**把会话切到别处，
     环境变量照样不会跟着变。判据不变。



141. **升级 pi 时，先看"生成器读的是哪种写法"，再看版本号。**（2026-10-13，1.1.0 → 1.2.0）
     这次升级的六个锚点全是机械替换，真正有信息量的是**生成物**那一格：
     pi 1.2.0 把 openrouter 的 `baseUrl: "https://…"` 改成了 `baseUrl: OPENROUTER_BASE_URL`
     （同文件常量）—— 而 `gen-provider-catalog.mjs` 只认字面量，于是**静默记成空串**。
     危害是用户可见的：配置页里 OpenRouter 的 API 地址不再预填、模型探测也没了默认端点，
     而 `--check` 会显示"目录不一致"看起来像"pi 改了内容"（其实是我们的解析器瞎了）。
     修法：解析**同文件**的 `const NAME = "字面量"`（只在同文件、只认字符串字面量；
     解析不出来照旧记空串 —— "不替 pi 推断"的原则没变）。
     判据：**生成器的输入是"源码写法"而不是"语义"**，所以上游一次无害的重构
     （抽个常量）就能让它静默降级；升级时**先 `--check`、再逐行看 diff**，
     凡是"内容变了"都要问一句"是 pi 变了，还是我的解析器漏了"。
     这次 1.2.0 的结论：① `modes/rpc/` 与 1.1.0 **零 diff**；② 扩展 API 是**加法**
     （`BeforeAgentStartEvent` 变成 user/custom 联合、新增 `ToolDefinition.reachesTools`
     与 `ToolNamespace.aliases`）；③ 两个快照的**内容**与 1.1.0 完全相同，只有版本头变。
     验证：契约 17/17、真机插件探针全绿、pi-guardrails 对 1.2.0 `tsc` 干净 + 90/90 通过、
     bridge 类型校验与 37 条单测干净。

142. **`if linux { A } else { B }` 等于把 Windows 当成 macOS。**（2026-10-14，用户报"用文件资源管理器打开目录失败了"）
     `LaunchSpec::ShellOpen` 的启动器选择写成了 `if cfg!(target_os = "linux") { "xdg-open" } else { "open" }`
     —— 两个分支都写对了（Linux / macOS），但**Windows 落进 else**，去起 macOS 的 `open`。
     Windows 上没有这个命令也没有 `.lnk` 之外的同名关联 ⇒ `Command::new("open")` 直接 `NotFound`
     ⇒ 被映射成 `LaunchOutcome::Missing` ⇒ 上层按"这份解析过期了"报错（"explorer 的启动器失效了"）。
     **报错信息把人指向"启动器失效"，而真相是我们从来没起过它。**
     判据：**平台分支必须显式三分（macos / linux / 其它）**，不许用 else 兜一个具体平台 ——
     else 的语义是"剩下全部"，而"剩下全部"里恰好住着另外一个真实存在的平台。
     同类形状还有第 51 条（`HOME` 只在 unix 有）与第 53 条（分隔符）。
     **同一个错误当时写了两份**：`mod.rs::open_external_url` 也有这一句，
     于是受害面是两片功能 ——「打开方式」的文件管理器 + **界面里所有外部链接**
     （markdown 链接、许可原文点了都没反应）。处置是把选择收成一个纯函数
     `host::shell_launcher(is_url) -> ShellLauncher`，判据只此一份、且**任何平台都能断言**。
     验证：四条用例钉住（派发表 + 目录真 spawn + URL 真 spawn + "目录那条成功也返回 1"这个平台事实），
     **红检过两次**：把 Windows 格改回 `("open", true)`，两条立刻红、且消息点名
     "不许去起 macOS 的 `open`"。
     **旧用例为什么没抓住**：`shell_open_uses_the_platform_opener` 只断言了 `describe() == "shell-open"`
     —— 一个字符串常量，跟"到底起哪个可执行文件"毫无关系。**名字级的断言要对着那个名字。**

143. **修完一处不要顺手把"另一种载荷"也归到同一个启动器名下 —— 先量。**（2026-10-14，同一天的第二个报障）
     142 那条修完，用户回报：「文件管理器」好了，但**「关于」里的许可原文链接点了没反应**。
     我当时的"修法"是把目录与 URL 合并成"Windows 一律 `explorer.exe`"，依据是两条推理：
     ① `explorer.exe <目录>` 成功时退出码是 1；② `explorer.exe <url>` 实测也返回 1 ——
     于是我把它当成"explorer 的成功怪癖"，还写进了注释和文档。
     **②那条推断是错的**：返回 1 不是怪癖，就是失败。真机对照（同机、同 URL 形状、数浏览器进程增量）：

     | 方式 | 退出码 | 浏览器进程增量 |
     |---|---|---|
     | `explorer.exe <https url>` | 1 | **0（什么都没开）** |
     | `cmd /c start "" <https url>` | 0 | **+1（真的开了）** |

     判据：**"退出码非零"这种观测在解释成"平台的怪癖"之前，必须先量出"效果发生了没有"** ——
     我只量了退出码就下了结论，而"退出码 1 + 什么都没发生"本来是最自然的解释。
     量效果只需数一下目标进程数（浏览器/资源管理器），成本是两条命令。
     **另一个教训**：把两种载荷（目录 / URL）归到一个名字下，等于替它们假设了同一套语义 ——
     `explorer.exe` 的位置参数只认文件系统路径，URL 它**静默**什么都不做（不报错、不弹窗）。
     现在的形状是 `shell_launcher(is_url)` 显式区分，两条路各有自己的用例与红检。
     修法：Windows 上目录走 `explorer.exe`（不看退出码），URL 走 `cmd /c start "" <url>`
     （退出码 0 可信；`""` 是 `start` 的窗口标题占位，不传它 URL 会被当标题吞掉 ——
     那是同一类"静默什么都没发生"）。

144. **被环境清洗洗掉的那个变量，会让命令"报成功、什么都没发生"。**（2026-10-14，同一天的第三次）
     143 那条修完，外链**还是**打不开。原因是 `spawn_watched` 会 `env_clear()` 再放
     `scrubbed_env`（洗掉 `*KEY*`/`*SECRET*`/`*TOKEN*`… 那批凭据），而 **`cmd /c start`
     需要 `SystemRoot` 才能解析 URL 关联**：缺了它 `start` **静默什么都不做**，有时还返回 0。
     最小环境矩阵（同机、数浏览器进程增量）：

     | 环境 | 退出码 | 浏览器 |
     |---|---|---|
     | 空（≈ `env_clear()`） | 1 | **没开** |
     | **只加 `SystemRoot`** | 0 | **开了** |
     | 只加 `USERPROFILE` | 1 | 没开 |
     | 只加 `PATH` | 1 | 没开 |

     判据：**"擦干净环境再启动"是个好默认，但它会顺手擦掉子进程的运行必需品** ——
     给外部进程传环境时，凡是"这个程序跑起来要用"的（`SystemRoot`、`HOME`…）都要显式补回，
     不能假设"洗掉的一定是凭据"。修法：URL 这条把 `SystemRoot` 作为 `extra_env` 补回去
     （`windir` 也认，兜底 `C:\Windows`），其它变量照旧洗掉。
     ⚠️ **这个坑不可能靠退出码发现**，所以我把断言往前提了一层：
     新增 `url_launch_spec_keeps_system_root_alive` 直接钉"argv 形状 + `SystemRoot` 在 extra_env 里"，
     而那条"真 spawn"的用例保留、但注释里写明**它证明不了"浏览器真的开了"**。
     这是本轮第三次犯同一类错：**断言验的不是那个会坏的东西**
     （第一次是旧用例只断言 `describe()` 字符串；第二次是我那条只看 `Launched` 的真 spawn）。

145. **JS 里的几何常量与 CSS 里的同一条几何，必须让门禁量"两者的关系"，别量写死的数。**
     （2026-10-14，右栏折叠）折叠的实现是"面板收成图标轨那么宽"：
     `AppFrame.tsx` 的 `RIGHT_RAIL_W = 40` 与 `styles.css` 的 `.pg-rightrail { width: 40px }`
     是**两处手写的同一个数**（CSS 读不到 JS 常量，反过来也一样，同规矩 1 的
     `tokens.css` ↔ `monaco-setup.ts`）。这类镜像数字的失效方式全是**静默**的：
     改了一处，界面照常渲染 —— 只是轨道被裁掉 1px、或者折叠后旁边留一条空白；
     jsdom 里量不到（没有排版），单测怎么写都绿。所以 `ui:startup` 第 6b 段钉的是
     **相等关系**（折叠后 Panel 宽 === 轨道宽），不是 `=== 40`。
     同一段里还有一条同族但更隐蔽的：折叠/展开是**两个方向**的状态同步
     （store → 面板：按钮/⌘\/命令面板；面板 → store：用户拖 sash）。
     只做前者时，"拖 sash 把面板收起来"会让按钮说反话 —— 界面收着、按钮写着"收起右栏"，
     点下去是个空操作（已经折叠了），用户看到的是**按钮坏了**。
     这条只有真拖才走得到（jsdom 里连拖都拖不动），所以它也在第 6b 段里。

146. **`.app` 的环境来自 launchd，不是你的终端 —— 而"找得到 pi"与"跑得动 pi"是两件事。**
     （2026-10-14，用户报「`pnpm tauri build` 打包后使用本地 pi 会找不到 node」）
     日志只有一句 `pi --version 失败: ~/Library/pnpm/bin/pi: line 48: exec: node: not found`。
     真机复现不需要真去双击：
     `env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin ./Piggy.app/Contents/MacOS/piggy-desktop`
     一句就复现。三层拼起来才是全貌：
     ① Finder 启动的进程只有 launchd 那套 `PATH`；
     ② pnpm/npm 装的 `pi` 是 `#!/bin/sh` + `exec node …` 的垫片，
     而发现链的「常见安装位置」兜底**照样找得到它** —— 所以界面不是"pi 未找到"，
     是"pi 明明在、就是起不来"，很容易被误判成用户没装 pi；
     ③ node 在 nvm 手里，而 nvm 的 PATH 注入通常在 `.zshrc`。
     修法：启动第一件事问一次 `$SHELL -ilc '<哨兵>; env'`，把 `PATH` 并回进程环境。
     **`-i` 不能省**：`zsh -lc` 只读 `.zshenv`+`.zprofile`，本机上 node 根本补不进来；
     少了它，这条修复看起来"做了"，实际还是报同一句错。
     代价要给护栏：rc 可能慢（本机 0.5–0.9 s）或挂住 → 5 s 超时 + stdin=null；
     rc 会往 stdout 打横幅 → 只认哨兵之后的内容；**只改 PATH**，不动其它变量。
     门禁 `login_shell_path_makes_a_node_shim_runnable` 造一个真的 `exec node` 垫片，
     先断言干净 `PATH` 下它报 `node: not found`（复现），再断言补齐后真的跑出 `1.2.0`；
     **红检**：把 `-ilc` 改回 `-lc` → 报的就是用户那句原文。

147. **"设计一个 UI"之前先把能力边界从上游源码里读出来 —— 否则做出来的东西是纸糊的。**
     （2026-10-15，会话等待队列照 DSH 重做）用户说"参照 DSH 实现会话等待队列"，
     DSH 那套是 `updateQueue(itemId, {kind:'edit'|'remove'|'steer'})` **按 id 原地改**。
     差点就照着做了 —— 直到去读 pi：它的队列是**两个 `string[]`**（`agent-session.ts:394-396`），
     `queue_update` 只给文本（**没 id、没图片**），33 条 RPC 里**没有任何按条操作**，
     唯一能读出队列内容的 `clear_queue` 还是**破坏性的**（`:2427-2435`）。
     结论直接改写了设计："取回"只能是"把这一条和它后面的**整条尾巴**一起取出来、
     缓存在本地、改完按原序放回"（`stores/queue.ts` 的事务）。这次核实的硬事实表在
     `docs/02 §7.2b`（附出处行号）；`docs/12` 那张差异表说明为什么 Piggy 的 QueueDock
     看起来像 DSH、字段却不一样。教训是**顺序**：先有事实表，再画 UI；
     反过来做，边角全是"NoSuchMethod"。

148. **"从快照里消失"是有歧义的 —— 别用一句话表达两件事。**
     （同一次，队列影子对账）`queue_update` 是**全量快照**，"某条不在快照里了"既可能是
     **被消费**（消息已进转录，再也不该出现），也可能是**被我们 `clear_queue` 取回**
     （要保住、等会儿放回）。只按快照对账时两种含义撞在一起，实测出两类事故：
     ① 已消费的行在下一次对账里被当成"外来行"**重新造一条**（界面上凭空多一条）；
     ② `clear_queue` 的响应还没回来，pi 自己那次"空快照"的 `queue_update` 先到，
     把**正要取回**的那批行抹光（取回完一半、另一半消失）。
     修法两条：每个 tab 记一份 `consumed` 文本记忆（+ 事务期间不收对账），
     事务结束时用 `clear_queue` 的**返回值**把影子重建到位。
     普适形态：**上游给的是"快照 + 若干事件"时，先问清"消失"有几种原因**，
     再决定要不要自己记一份"我做过什么"。

149. **mock 比真机宽松，会把"静默失败"演成"看起来没问题"。**
     （同一次）队列手势的 5 个真 bug 全是 mock 逼出来的，而不是读代码读出来的：
     ① 空闲发送被写成 `streamingBehavior:'followUp'`；② 发出去的字面量是内部名
     `'steering'` 而不是线上值 `'steer'`（pi 当"没指定"直接拒，而拒绝发生在 await 里，
     表现是"点了插话什么也没发生"）；③ `⌘⇧↵` 分支多写了 `!e.shiftKey`，
     于是它**两支都不满足**、静默失效；④ 手势语义在 `await` 之后才计算，
     一次 IPC 往返里 `streaming` 翻面就把"插话"降级成"入队"；⑤ `putBack` 把影子行
     （有 `target`）直接丢给要 `behavior` 的函数，于是下发不带 `streamingBehavior`。
     关键动作是让 mock **照真机的语义**维护 pi 那两条队列（带行为才入队、
     `clear_queue` 返回被清掉的那批、忙时缺 `streamingBehavior` 直接报错）——
     它一严，上面五个就全暴露了。反面教材见规矩 4（mock 比真机宽松 = 藏真机 bug）。

150. **"整清"型接口把"局部操作"变成"整体重建" —— 重建时别忘了那些"没动"的部分。**
     （2026-10-15，用户实报「编辑打勾确认之后，等待区另外一个也没了」）
     pi 的 `clear_queue` 是**整清**，所以"取回中间某一条"实际上把**前面那截也清了**。
     老实现只在"继续发送"时才重发暂停的那些，前缀则留在界面上当"还在队列里"——
     可 pi 那边已经没有了：中间任何一次对账都会把它判成"已消失"（删掉，或者当成外来行
     重造一条）。用户的观感就是"我编辑了一条，另一条也没了"。
     修法：`take` 清完**立刻把前缀按原序重发**（同内容、同位置，用户看不到变化），
     `putBack` 用一份 `alreadySent` 注册表跳过它们、不重复投递。
     另一条同源教训（同一张截图）：**回合结束时 pi 不推 `queue_update`**，
     所以 `settled()` 之后最先到的那条快照可能是**回合结束前**的旧状态；
     拿它删行会把"等下一轮就发"的 followUp 行一起抹掉。修法是落定后那一次对账
     只做增量（`turnEnded` 标志），删除交给明确信号（`delivered` / `take` / `clearAll`）。
     普适形态：**上游只给你"整清 + 快照"时，"我没动的那部分"要自己负责补回去**。

151. **"跟随鼠标 / 贴着内容"的预览不能用 CSS 伪元素凑。**
     （2026-10-15，用户："悬停在上方放大预览 这个功能好像没生效"）
     第一版是 `.pg-img-chip:hover::after` + `background-image: var(--pg-img-preview)`。
     失败有三个原因，任何一个单独都够让它"看起来没做"：
     ① 伪元素没有边框也没有底色 → **透明 PNG / 深色内容在深色界面上就是一片空白**；
     ② 伪元素只能贴在自己的宿主上，**跟随不了光标**；
     ③ 宿主是 `overflow-x: auto` 的滚动容器（而且整个输入区在屏幕最底部）→
     往上一长就被裁掉。现在换成 `position: fixed` + portal 的真实 `<img>`
     （`features/common/ImageHoverPreview.tsx`），尺寸按原图宽高比夹在 96–140px。
     这一条的普适形态：**凡是"位置或尺寸要随外部状态变"的浮层，都别指望伪元素** ——
     它没有自己的盒模型，也不能越出宿主的裁切与层叠上下文。

152. **一个按钮的状态属性、`disabled` 与 `onClick` 必须描述同一个动作 —— 否则它就是"假按钮"。**
     （2026-10-16，用户："发送出去之后，不是停止键而是置灰的发送键"）
     导火索是上一轮删「转向 / 追加」：删的时候把**中断那粒圆钮一起删了**，说好的替代是
     "主键 `title` 随状态说明按下去会发生什么"。但主键当时是这么写的：

     ```tsx
     data-send-mode={streaming ? (text.trim() ? 'queue' : 'stop') : 'send'}
     disabled={!text.trim() && images.length === 0}   // ← 运行中 + 空草稿 = 灰
     onClick={() => void submit()}                    // ← 空草稿的 submit() 直接 return
     ```

     三处各说各的：属性说"这是停止键"、`disabled` 说"没东西可发"、`onClick` 什么都不做。
     结果流式中草稿一空，界面上只剩一个**按不动的灰键**，停止这个动作**只活在 `Esc` 里** ——
     而用户在屏幕上找不到它。DSH 的口径本来就在那儿（`InputBar.tsx:303` 的 `primaryStops`：
     运行中 + 草稿为空 → 主键变停止），删按钮时没去对那一条。

     两条普适形态：
     - **删掉一个入口之前，先数一遍它承担的动作还有几个入口**；
     - **`data-*` / `title` / `aria-label` 不是装饰**：它们和 `disabled`、`onClick` 是同一份
       契约的四个投影，单测要拿"点下去真的发生了什么"来验，而不是验属性字符串。
     `src/test/composer-primary-button.test.tsx` 6 条钉住三态（停止可点且真发 `pi_abort` /
     停止不动队列 / 有草稿不发停止 / 工具执行期也能停 / 空闲灰键 / 停完复位）。

153. **「还在跑」必须看得见，而且那个时间必须是活的 —— 死时钟比没有时钟更糟。**
     （2026-10-16，用户："之前类似 DSH 一样有个 assistant 指示，后来没有了……
     类似 DSH 加个运行时间"）
     一轮跑起来之后，转录里除了流出来的字什么都不动；**工具在跑而模型没出字时更是彻底
     静止** —— 用户分不清"在干活"还是"卡住了"。DSH 在内容流末尾挂一行
     「深度求索中，用时 12 秒 ···」（`RunningStatus.tsx`），Piggy 之前没有这一行。

     四条口径，每条都踩过或差一点踩：
     - **起点必须有权威来源**：取 `agent_start` 的时刻，不要拿"最后一条用户消息的时间戳"
       倒推 —— 流式中用户还能继续入队（`⏎`/`⌘⏎`），那条消息不是本轮起点，时钟会被拨回去；
     - **时钟必须真的在走**：写死一个初次渲染的时间戳，界面会永远停在"1 秒"，
       比没有这行更让人以为卡死（红检就把它按"不跳"验过）；
     - **不要在无障碍树里每秒播报**：数字放进 `aria-live` 等于逼读屏每秒念一遍，
       隐藏状态句只写「运行中」；
     - **本仓禁 `setInterval`**（eslint 红线：轮询会把"看起来在跑"变成"真的在跑"）——
       用能被 cleanup 停掉的递归 `setTimeout`。

     文案口径：**「运行中」，不是 DSH 的「深度求索中」**（用户明确要求；那句话是品牌说法，
     在这一行里它只表达"还在跑"）。`src/test/running-status.test.tsx` 11 条钉住：
     格式（`1秒`/`1分5秒`/`1小时2分5秒`）/ 每秒跳 / 不足 1 秒按 1 秒 / 没有起点不编数字 /
     读屏只念状态 / 猪头图标（内联 SVG、`currentColor`、不依赖位图）/ 分隔线判据 / `agent_start` 记起点 / 落定与中断清起点。

154. **文档里的 ✅ 会替代码作证 —— 打勾之前先去找到调用点。**
     （2026-10-17，用户："看有没有可以简化的补丁代码"，顺手扫出来的两处假 ✅）
     `docs/09-roadmap.md` 里写着「M1 顺延：Monaco schema 校验 ✅」与「登录内嵌终端 ✅」，
     实际是：

     - `monaco-setup.ts::registerPiggySchemas`（外加一段 40 行的 `PI_SCHEMAS` 常量 **全仓零调用点**）——
       schema 从来没被注册过，编辑器的 JSON 校验一直是 Monaco 自带的空 schema；
     - `LoginTerminalModal`（80 行）+ `pty_open/pty_write/pty_resize/pty_close` **后端全在、前端零渲染点**，
       设置页里没有任何"登录/认证"入口，`@xterm/xterm` 也只被这一个组件 import。

     两处都是"写完组件就标完成"，而**门禁抓不到**：`lint` 不报"导出了没人用"，
     `cargo test` 不测"前端有没有接"，`ui:startup` 只走真实可达的路径。两份文档自己也不会互相对账。

     规矩：
     - 给功能打 ✅ 之前，**贴一条调用点证据**（`grep -rn 名字 apps/desktop/src` 的命中行，
       而不是"文件存在"）；只写"组件在"不算完成；
     - 发现"文档 ✅ / 代码没接"时，**两条路选一条并写进文档**：要么接上入口，
       要么把死代码删掉、把状态改成 ❌ 并写清"重做要从哪一步开始"——**不许两者都不做**；
     - 这一轮的处理：`registerPiggySchemas` 那套死代码**删掉**（docs/09 改成 ❌ + 重做路径）；
       `LoginTerminalModal` + `pty_*` 是一整条**没出口的路**（约 280 行 + 两个 npm 依赖），
       留待决策（接入口 or 整体删除），文档已如实标 ❌。

## 4. 未完成 / 待决策

| 项 | 说明 |
|---|---|
| **系统菜单在 Windows/Linux 上未验证** | macOS 已实测（`tests/menu_smoke.rs` 锁结构：App 子菜单第一项是「关于」、第二项是我们的条目、Edit 子菜单仍是 7 项）。Windows/Linux 走 `append_to_help`（`Menu::default` 本机只在 macOS 自动安装，我们显式装），但**没有真机跑过**——那两平台会因此多出一条菜单栏。真机确认前不要声称可用 |
| **自定义会话目录的布局改动只在 macOS 上验过** | 本机 `sessionDir` 恰好是自定义的（`…/tmp/session`），所以「平铺写入」这条在真机上验到了（红检时如实写进 `--tmp-piggy-wiring-probe--/`）。但 Windows 上 `sessionDir` 若指向 `D:\sessions`，`--cwd--` 编码（`C--Users-x--`）与平铺两种落点都没在真机跑过 |
| **Windows 的路径解析只有静态与模拟证据** | `config/paths.rs` 的四条环境形状、`~` 展开、`is_under`、会话根优先级都有测试，端到端探针也在子进程里抹掉 `HOME` 跑过；但**真机 Windows 上的渲染**（`C:\Users\…\sessions` 全反斜杠）只有 `#[cfg(windows)]` 断言在用户机器上生效。这次修完需要用户在 Windows 上复验：新建会话不再报「无法确定 cwd」、设置页「当前生效」显示带盘符的绝对路径 |
| ~~会话没有“加载更早”分页~~ **已过期（2026-09-25 核对）** | 分页**做了**：`lib/transcriptPage.ts` + `session_page`/`session_outline` 命令 + 门禁第 15 段（打开即贴底 / 翻页不跳 / 换窗跳转 / 继续往下 / 滚轮续页）。这一行是历史留档，**不要按“没做”排期**（原来的说法是“一次性读整段”，那是分页之前的状态） |
| 预览滚动条的**窄窗口行为** | DSH 在转录容器 < 900px 时直接**隐藏**滚动条（`@container`）。Piggy 没做这条：转录因为侧栏 + 右栏通常只有 530–700px，照搬会让功能在多数窗口下“看起来是坏的”。现在由用户的开关决定，代价是窄窗口下两侧各 44px 留白会挤压正文。要改成自适应得先定“多窄算窄”，而 Piggy 的转录宽度与 DSH 不是一个量级 |
| 预览滚动条只在 **Chrome** 里量过 | 刻度几何、跟随、预览框、居中都在 Playwright/Chromium 下量的（门禁）。WebKit（Tauri 在 macOS 用的引擎）与 Windows/Linux **未跑过**——`mask-image` 渐隐在 WebKit 的差异未验证 |
| **Windows 上的 pi 发现：本轮修了，但只在我这边做了纯函数验证** | `exec_names` / `first_pi_in` / `well_known_candidates` 都是纯函数，5 条测试在 macOS 上跑（覆盖 `PATHEXT`、shell 垫片、PE 筛子、两套兜底目录）。但**本机无法给 Windows 交叉编译**（`rustup target add x86_64-pc-windows-msvc` 在配置的镜像上 404），所以“在 Windows 上真的能找到 pi.cmd 并跑起来”要靠用户那台机器确认。下一次 Windows debug run 应该看到实际的 pi 版本，而不是 os error 193 |
| ~~对话要不要做「回合过程」折叠~~ **已做（2026-09-25，B 期第 2 条）** | 完成的一轮把过程（思考/工具/中间助手消息）折成一行 33px「已完成工作 · 用时」；正在跑、中止、失败、没有过程、分页半途 —— 五种情况都不折（理由逐条见 04 §2.1.6）。四档密度 `transcript_detail`（简洁/标准/详细/完全展开）落在 `PerfConfig` 与设置页「通用设置 → 工作步骤展示」。实现三条纪律：不动行数组（折起来的行占下标、高度归零）、折叠记忆按**会话文件偏移**存（行 id 每次载入都变）、store 写入必须换引用（zustand 同引用不通知 → 点击"没反应"）。钉住它的：`turn-fold.test.tsx`（11 条）+ 门禁第 25 段（走设置页真实路径切四档）。原提问留档：*折叠态存哪、`/compact` 边界与轮次分组怎么交互、"用户刚发的那一轮永远展开"怎么保证* —— 答：per-tab per-turn 存偏移；`/compact` 是独立行不参与折叠；最后一段 + streaming 视为未结束 |
| **M3 剩余** | ①在 GUI 里对真实仓库点一次 `parallel-review`（需人开 `tauri dev`）；②dockview lane 分列监控 / 模板自定义编辑 |
| ~~预热 worker~~ **已删（2026-10-13）** | 先按上一版留的话"**Windows 上量到 before/after 再决定**"把它量了：C16 在 Windows 上连跑 6 次，**复用 218–858 ms vs 冷启动 1204–2491 ms（每次省 1.0–2.1 s）**。收益是真的，但它落在**已经被乐观 UI 占位遮住**的"打开会话"那一段（13.7 ms 出第一帧），而且**每次启动的第一个会话永远吃不到**（预热池在 `create_tab` 之后才补位，补位本身还要 1.2–1.8 s，保鲜期 10 分钟）—— "开一个会话就干活"的用法命中不到。代价是常驻 RSS 173→199 MB + 一条"进程池/会话切换"的复杂度。判据沿用 macOS 那次的同一把尺子：**省下的时间必须大于用户能感知到的等待**。删除见 docs/05 §5.7 |
| **发布门禁 G1（updater）** | 注意：这个 G1 是 docs/14 §7 的**发布门禁**编号，跟 docs/00 目标表里那个 G1（完整对话体验）同名但无关。`tauri.conf.json` 仍指向 `updates.piggy.invalid` + 空 pubkey。需产品决策（更新源 + 签名密钥）。**不能只删配置块**——`tauri_plugin_updater` 已在 `lib.rs` 注册，删了会复现历史 panic |
| 主题外壳颜色 | 目前只复用了 VS Code 的 `tokenColors`；整套主题还要先做"注册表默认值层"（docs/13 E4） |
| codicon 双份 | 构建产物里两份 `codicon.ttf`（Piggy 一份 + Monaco 自带一份），约 150 KB 冗余 |
| **UI 门禁（`ui:startup` / `ui:debug --strict`）没有 CI 作业** | 它们是最强的门禁（真布局、真 DOM），但只在本地跑：需要 runner 上有 Chrome（脚本写的是 `channel:'chrome'`）与一个 :5195 的 dev server。要接进 CI 就得像 perf-lite 那样**先确认在 runner 上真的绿过**再宣布——本轮没有 runner 可用，所以只把文档里"`--strict` 进 CI"的说法改成实际执行者（本地 + 发布前手动）。同理 `ui:startup` 也不在 CI 里 |
| **perf-lite 的 CI 一格从没跑过（2026-09-23 查到并修）** | 两处都坏：① `.github/workflows/ci.yml` 与 `perf-nightly.yml` 跑的是 `node scripts/perf/run.mjs`，而脚本实际在 `apps/desktop/scripts/perf-run.mjs`（产物路径也少一层）；② 脚本的就绪探针写的是 `window.__piggyCommands.size()`，而 `__piggyCommands` 早就是**模块命名空间**（导出 `registrySize/allCommands/…`），于是探针一升级就永久抛 `size is not a function`。也就是说 docs/05 §6.3 与 docs/09 里"PR 必跑的性能冒烟"从来没绿过（`cargo fmt` 那格的同类问题）。**已修**：CI 路径与产物路径改正、探针改 `registrySize()`、并给 `apps/desktop` 加了 `perf` / `perf:lite` 两个脚本；本机实测 `perf:lite` 通过（S1 60fps/0 longtask，S3 hydrate 34ms/1 longtask）。教训：**"CI 里写了" ≠ "CI 跑过"**——新增门禁后要去 Actions 里看那一次真的绿了 |
| **CI 的 `cargo fmt --check` 一直是红的** | docs/08 §2 写着「格式化：prettier + rustfmt（**CI 校验**）」，`.github/workflows/ci.yml` 也真的跑 `cargo fmt --check`；但仓库里**没有 `rustfmt.toml`**，而现有 Rust 代码是按 ~120 列写的（`cargo fmt --check` 实测 **390 处差异**）。也就是说那一格从来没绿过。两条路：①加 `rustfmt.toml`（`max_width = 120`）再跑一次全仓格式化（会是一个巨大的无关 diff）；②把 docs/08 那句改成实际执行者。**本轮没动它**——不在这个功能的范围内，但它是"文档说有、实际没有"的又一处 |
| **CI 的 `cargo clippy -- -D warnings` 曾经也是红的** | 2026-09-25 核对：本轮之前 lib 有 **2 条** error（`lib.rs` 的 `match` 单分支 + `perf_config_save` 参数过多）。前者本轮顺手修成 `if let`；后者是 **IPC 界面决定的**（前端送扁平对象，每个字段一个开关），已显式 `#[allow(clippy::too_many_arguments)]` 并注明"合并成结构体 = 线格式变更"。现在这一格**通过**了。2026-09-23 又补一条：只跑 `-- -D warnings`（默认 lib target）**看不见 test 目标里的提示**——加 `--all-targets` 会多出 5 处（单分支 `match`、死赋值、`format!` 套 `format!`、测试桩里没人读的字段、`== false`），本轮全部清掉，所以现在 `cargo clippy --all-targets -- -D warnings` 也是绿的。**门禁口径以后按 `--all-targets` 算**（CI 若只跑 lib，这 5 处会悄悄长回来） |
| ~~`pnpm lint` 是空转~~ **已修（2026-09-25，见 A 期）** | 现在 `apps/desktop` 有 `lint: eslint src scripts --max-warnings 0`，CI 的 `frontend` 作业会跑 `pnpm -r --if-present lint`；四条红线（禁 antd / 帧路径禁 React / 禁轮询含裸 `setInterval` / 禁 `dangerouslySetInnerHTML`）逐条在 `eslint.config.js` 里有对应规则，`react-hooks` 两条也接上了。存量清干净：563 → **0 error / 0 warning**（其中 600 条是 scripts 的 globals/no-console 配置噪音）。历史留档：当时手工 `npx eslint .` 是 189 error / 35 warning |
| `@monaco-editor/react` 未被使用 | 在 `apps/desktop/package.json` 依赖表里，但全仓没有任何 import（预览用 `MonacoHost` 直接持有 `monaco-editor`）。可直接删，或按 docs/10 §2.2 的旧描述接回来 |
| ~~左侧"常驻视图轨"~~ **已决定不做**（2026-09-24） | docs/04 §1.2 曾规划一条常驻的 44px L 轨（VS Code 活动栏语义）。查 DSH 源码：`ui-layout/.../AppFrame.tsx:183-186` 写明 *neither platform keeps an icon rail* —— 折叠后的重开控件走标题栏（macOS `shell.leading` 座位 / Windows caption 行）。而且左栏只有一个视图（会话列表），轨上没有可切的东西。**计划已从 docs/04 删除**；左侧只有折叠态那条 56px 轨（`SidebarRail`），右侧那条 40px 常驻轨（`RightBar`）保留（它本身也是对 DSH 的偏离 —— DSH 右栏用 dockview tab 条，若哪天要百分百对齐，该动的是这条） |
| `SIDEBAR_AUTO_COLLAPSE = 1024` 没接 | docs/12 §1.5：视口 < 1024px 自动折叠侧栏。Piggy 是纯百分比布局，620px 窗口下侧栏被压到 122px 也不折叠。现在折叠是安全的（有图标轨可点回来），接不接是产品决策 |
| **Windows/Linux 上默认键位一个都按不动**（2026-10-14 查右栏 `⌘\` 时发现，**未修**） | `lib/keymap.ts` 的 `chordOf` 只把 `metaKey` 记成 `cmd`，而 `ctrlKey` 原样记成 `ctrl`；可 `DEFAULT_KEYS` 里**每一条**默认键位写的都是 `cmd+…`（`sidebar.toggle`=cmd+b、`palette.open`=cmd+k、本轮新增的 `rightpanel.toggle`=cmd+\\），匹配是 `keysFor(id) === chord` 的字面比较 —— 于是在非 macOS 上按文档里的 `Ctrl+B` 得到 `ctrl+b`，**永远匹配不上**（macOS 上的 ⌘ 一切正常，所以本机怎么测都是绿的）。判断依据：`chordOf` 是全应用唯一的 keydown 分发，没有别处补偿；docs/07 §2 每一条都写成 `Cmd/Ctrl+…`，说明**意图**就是平台无关。修法（未实施，因为 Windows 侧本机验证不了、且它一次性影响所有默认键位）：`chordOf` 里把**平台主键统一记成 `cmd`**（`isMac ? e.metaKey : e.ctrlKey` → `cmd`；mac 上额外的 `ctrlKey` 仍记 `ctrl`），并补一条"非 mac 上 Ctrl+X 与注册表里的 cmd+X 是同一个 chord"的用例（`vi.stubGlobal('navigator', …)` + `vi.resetModules()` 后再 import，因为 `isMac` 是模块级常量）。⚠️ 谁在 Windows 上复核这条，顺手确认设置页改绑出来的 override 存的是 `cmd+…` 还是 `ctrl+…`：修之前若已有 `ctrl+…` 的 override 存进用户的 localStorage，修之后会失配 |
| ~~「打开方式」的 **Windows 图标**~~ **已补（2026-10-09，Windows 真机）** | DSH 那一支用生成的 PowerShell 调 `ExtractAssociatedIcon`（32px）；这条曾在 macOS 上无法验证而故意留空，**现在在真 Windows 上实现并实测**：`icons.rs` 写临时 `.ps1`（`-File` + `-Source/-Target` 位置参数）→ `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass` → 读回 PNG。本机实测 **250-350 ms/个**，产物是 32×32 PNG（1-3 KB）。三处工程细节都是踩出来的：①脚本**必须纯 ASCII**（PS 5.1 按 ANSI 解无 BOM 的 `.ps1`，一句中文注释就让整套语法失效，实测 `Unexpected token '}'`）；②**产物只能走文件**，PNG 进 stdout 会被控制台编码毁掉（DSH 的 Node 版能直接读 stdout buffer，Rust 侧 `run` 返回 `String` 装不下）；③菜单是**按需逐个**拉图标的，于是加了「按 exe 路径缓存 + 启动后台预热」，否则第一次打开菜单会看到方块逐个亮。尺寸从 128 降到 32 是平台事实（`ExtractAssociatedIcon` 的上限，DSH README 同样承认），菜单里渲染 15-18 CSS px 够用。**仍未做**：文件级那档的处理器枚举（下一条） |
| 「打开方式」文件级的 **Windows 处理器枚举** | DSH 为此内嵌了一段 C#（`SHAssocEnumHandlers` + `IShellItem` + `SHDefExtractIcon` COM 互操作）。**仍未写**：Windows 上关联列表返回空，主按钮退成「显示文件位置」，`open`/`reveal` 仍可用（`Invoke-Item` 与 `explorer /select,<file-url>`，后者的 URL 编码有单测）。指定应用打开在 Windows 上明确报错（而不是静默乱开）。补充（2026-10-09）：`SHDefExtractIcon` 本机试过，它只对一部分 exe 给出 64px（7 个候选里 1 个），换来的清晰度不值那份失败面，所以图标那一档也没用它 |
| 「打开方式」文件级的 **Linux 真机** | `gio info` / `gio mime` / desktop entry 解析都有夹具单测（含嵌套 desktop id、`Name[zh_CN]` 回退、默认项排序），但**没在真 Linux 桌面上跑过** |
| 「打开方式」的 **Windows/Linux 定位链** | 已按 DSH 逐条移植，并有脚本化假宿主的单测（`reg.exe` 输出解析、`.desktop` 解析、版本目录数值排序、`TryExec→Exec` 回退、无 DISPLAY 时 `xdg-open` 不出现），但**没有在真 Windows/Linux 机器上跑过**。macOS 那一条是真机验证过的 |
| 「打开方式」真机弹窗 | **已由用户手动确认**（2026-09-24：点了就弹出来了）。自动化侧覆盖：①解析结果里每个启动器都真实存在于磁盘；②图标真抠出来（128×128 PNG）；③启动语义用真实进程测了四态（仍在跑=成功 / 早退非零=失败 / 退出 0=成功 / 不存在=Missing）。剩下没自动化的是「操作系统把窗口开出来」这一步本身 —— 需要驱动 Tauri 窗口，agent 侧没有这个能力 |
| 「打开方式」的 **分屏假设** | `openin.pick` 命令发的是**无载荷信号**，谁在听谁展开菜单。M1 是单组布局（非活动 tab 卸载 DOM），同时只有一个会话头部在听；M3 分屏之后会**同时展开两个菜单**。到时要给信号加 tabId 过滤（代码里已留注释） |
| 「打开方式」的 **文件级入口** | DSH 还把「打开方式」注入到右侧文档预览的 actions（对**当前文件**打开）。Piggy 只做了工作区目录那一档（会话头部）。文件级要等预览 tab 的 action 位 |
| 编辑器**右键菜单**未验证 | 加载编辑器贡献后折叠与 ⌘F 已实测可用，但右键菜单在无头 Chrome 里用真实 `button:2` 点击仍未唤出 `.monaco-menu-container`（真机 `tauri dev` 里没试过）。**不声称它可用**；要确认需在真窗口里右键一次 |
| **WebKit 渲染** | 未验证（本机缺"屏幕录制"权限 + Playwright WebKit 挂死）。打包版已在真机跑通，但那是启动路径，不等于逐像素复核 |
| dockview 主题变量漂移 | 已补齐当前被引用的全部变量，但 dockview 升级时可能新增。`src/styles.css` 的 dockview 段落记了自检方法（按"被引用且无 fallback"算差集） |
| 自定义 pi 的配置目录 | `pi_files.rs` 硬编码 `$HOME/.pi/agent`，且 spawn 时**不传** `PI_CODING_AGENT_DIR`（`SpawnArgs.envs` 已具备透传能力，只差设置项）。要支持需加设置项（docs/17 §2.3） |
| `--tools` 与插件工具 | 限制档位的白名单会连**扩展/自定义工具一起过滤**（pi 的设计）。自定义 pi 的插件工具只在「完全权限」档可见。若希望插件只读工具在限制档也可用，需改用 `--exclude-tools` 语义并重新论证边界 |
| **提供商目录随 pi 版本漂移** | `provider/catalog_generated.rs` 是从 pi v1.2.0 源码生成的快照（2026-10-13 重生成；**内容与 1.1.0 相同** —— 只有版本头变了）。pi 升级后必须重跑 `node apps/desktop/scripts/gen-provider-catalog.mjs <pi 源码根>`（可用 `--check` 复核）。不重跑不会报错，只会"少几个新提供商"或"某个 baseUrl 过时"—— 属于**静默漂移**，所以这一行留在这里当提醒 |
| 提供商「检测」的 **Windows/Linux 真机** | 列举端点的 URL/鉴权头规则有单测（含 anthropic 系的 `/v1/models` 与 `x-api-key`）、真 socket 集成测试、以及一次**真机网络**核对（`cargo test --lib -- --ignored real_network`：不带密钥打 `https://api.deepseek.com/models`，拿到 401 + 端点原文"Authentication Fails"）。但只在 macOS 上跑过；代理/企业证书等环境差异未验证 |
| 提供商「检测」的 **非标准鉴权协议** | Azure（`api-key` 头 + `api-version` 查询）、Codex（OAuth）这类**不猜**：`discovery.ts` 的 DSH 版本也把它们排除在外（"猜错会把鉴权失败报成'这家没有模型'"）。这些提供商仍可保存配置，只是「获取可用模型」会返回明确的"不支持列举" |
| 提供商「检测」的 **自定义 headers** | pi 支持 `providers.<id>.headers`（含 `${ENV}` 模板），但配置页不编辑它们，检测请求也不带 —— 靠 header 鉴权的网关会得到 401。要支持得先决定**怎么把带密钥的 header 安全地送到前端以外的 Rust 侧**（现在的做法是前端只送 baseUrl/api/一次性 key） |
| auth.json **没有原始 JSON 编辑器** | 有意为之：密钥只在 Rust 侧脱敏读出（`provider_list` 的 `keyMasked`），明文不进渲染进程。「高级」节只有 models.json / settings.json。要改密钥走「模型」页 |
| 提供商页的 **模型能力标记** | pi 的模型定义还有 `cost`、`compat`、`thinkingLevelMap`、`inputLimits` 等界面没暴露的字段。现在靠"未知字段原样保留"保证不丢，但没有表单 —— 要改用「高级」节的原始 JSON 编辑器 |
| **插件内置表随 pi 版本漂移** | `plugin/builtins_generated.rs` 是从 pi v1.2.0 源码的 `builtInExtensions` 生成的快照（**4 条**：`llama.cpp` + `codemode`/`tool-search`/`mcp`，后三条 `replaceable: true`）。pi 升级后要重跑 `node apps/desktop/scripts/gen-plugin-builtins.mjs <pi 源码根>`（`--check` 可复核）。与提供商目录同类的**静默漂移** |
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
| pi 扩展 API 版本耦合 | `packages/piggy-bridge` 的类型对着 pi 1.2.0 校验（devDependency 已随之升到 1.2.0）；pi 升级后需重跑 `pnpm --filter piggy-bridge typecheck` 与 `pnpm test:contract`（C12–C15+）。这是唯一会因 pi 升级而静默失效的接缝 |
| ~~worker 崩/休眠时"这一轮"没有落地信号~~ **已修（2026-09-25，B 期第 1 条）** | 现场（当时记的）：探针 `streamFor(2400,16,tabId)` 跑到一半 → `pi:state:crashed`，之后 `streaming` 仍是 **true**、实时行还挂着、"停止"按钮仍可用 —— 界面**假装还在跑**，而那个能把这一轮落地的 `message_end` 永远不会来。<br>现在：`stores/messages.ts::interruptTurn(tabId, reason)` 把实时块**转正**成一条 `stopReason:'aborted'` 的助手消息（`TurnFailureCard` 直接画「已中止」+ 原因，已流出的字一个字不丢）并落地 `streaming=false`；触发点是 `lib/tabEvents.ts` 的两处：`pi:state` 报 `crashed`/`sleeping`，以及 `agent_settled` 时**还挂着流式行**（用户中断、pi 直接收尾等）。<br>两个当时没定的口径现在定了：① **部分输出算一条消息**（它就是用户已经看到的东西，丢掉才是 bug）；② 与 `piggy:resync` 的去重靠行上的 `interrupted` 标记 —— resync 前先 `dropInterrupted`（那一行不在会话文件里，pi 只在 `message_end` 落盘），所以文件里那一轮的真身回来时**不会出现两行**。一个字都没流出来时**不留空行**。<br>钉住它的：`turn-interrupt.test.tsx`（5 条：崩溃/休眠/空输出/settled 无 end/resync 去重）+ 门禁第 24 段（在"崩"与"resync"之间量，所以 `mockCrash`/`mockRevive` 拆成了两个 helper） |
| **todo 界面没在真窗口里点过一次** | 已验证的是三段：① 真 pi 在**本仓**跑了一场带清单的会话（`pi -p …` → 会话文件里有 `pi-todo/state` + 8 条 `todo/write`）；② Piggy 的 Rust 投影读那份真会话（`PIGGY_TODO_SESSION=<path> cargo test --release --lib real_machine_todo -- --ignored` → 3 条、来源 `event`、677 µs）；③ 浏览器门禁在真布局里量了行高/面板位置/闸门正反两面（mock IPC，形状由 `ipc_contract` 锁着）。**没做**的是：在真 Tauri 窗口里打开那场会话、用眼睛确认一遍（agent 没有截图权限，见第 4 节） |
| todo 能力探测的 **Windows/Linux 真机** | 声明式/内容探测、目录入口下探、截断标记、未知能力报错都有单测，真机核对只在 macOS 上跑过（`cargo test --lib real_machine_todo_capability -- --ignored --nocapture` → 命中 `pi-todo`、`pi-web-access/dist/index.js` 超限被如实标出）。Windows 的盘符路径与 CRLF 未验证 |
| **todo 的安全边界靠约定，不靠机制** | "只显示已启用插件"这条判断读的是 pi 的同一套规则（复用 `plugin/inventory.rs`），但**任何**扩展都能自称提供 `todo` 能力（声明 `pi.piggy.capabilities` 即可）。内容探测（找 `todo_write`）也只是字符串匹配，不做代码审计。界面上不显示"这个插件是谁装的"之外的信任信息 —— 与 pi 本身"扩展=用户权限运行"的立场一致（见上面"插件没有权限模型"那条） |
| todo 的**复杂度闸门是启发式** | 打分规则可复现、可解释，但会低估"措辞简短、实际多步"的请求 —— 因此**默认关闭**（2026-09-29 用户裁定；要拦得用配置文件 `enforceComplexity:true` / `PI_TODO_ENFORCE_COMPLEXITY=1` / `pi --todo-enforce`）。真模型上只跑了两跑（该激活/该拒绝各一，且那两跑是在"闸门打开"的状态下做的），**没有**统计过误判率 |

| **A 期审计里"没做"的几条**（2026-09-25，明确留档，不是遗忘） | ① `pi_fork`/`pi_clone_session`/`pi_get_tree` 与 `fs_write_edit`：**Rust 与测试就绪、前端没有入口**（docs/09 的 ✅ 已改正）；接前端要产品决策（分支入口形态、快捷编辑的边界警示）。② `auth_list`/`auth_set_key`/`auth_remove` 三条 IPC 命令**当前没有渲染点**（真正的密钥路径是 `provider_set_key`；`AdvancedSection` 的注释已改成实话）——留着是因为它们对应的 pi_files 形状有单测锁着，删了会连测试一起删。③ `session_page`/`session_outline`/`fs_list_dir` 还**没有跨语言形状金标**（现有 3 组：providers / plugins / session-title；`fs_list_dir` 的 `OsString` 全窗黑屏就是形状漂移造成的）。④ **没有覆盖率配置**（`vite.config.ts` 无 coverage 段、devDeps 无 `@vitest/coverage-*`），"哪些文件没被测到"只能靠猜。⑤ `ui:startup`（26 段）**仍不在 CI**：需要 runner 上有 Chrome（脚本写死 `channel:'chrome'`）与 :5195 的 dev server。⑥ 没有任何**发布工作流**（tag → 三平台构建/签名/上传）。⑦ 两份 `*_generated.rs` 快照（provider 目录 / pi 内置扩展）随 pi 版本**静默漂移**：本机 pi 源码是 v1.0.4、快照是 v0.87.1，`--check` 因此对不上（与代码无关，但提醒：升级 pi 时要重跑生成器）。 |

## 4.1 Windows 这两个问题是怎么查的（2026-10-09）

用户在 Windows 上报了两件事：**「打开方式」图标加载不出来**，以及偶尔
`tab_create FAILED: pi command 'get_state' timed out`。查完的结论是：**两件都不是"pi 卡住了"**。

**① 图标**：不是"加载不出来"，是**从来没实现在 Windows 上**。`icons.rs` 的
`IconSource::Executable` 直接返回 `None`（当时的理由写在模块头注释里："这条在 macOS 上无法验证"），
前端于是按设计退化成通用圆角方块 —— 也就是截图里那排空方块。已按 DSH 那条路补齐（见 §4 那一行）。

**② 超时**：三个原因叠在一起，没有一个需要"pi 卡住"。

| 原因 | 证据（都在本机量的） | 已做的处理 |
|---|---|---|
| **10 秒预算本身太紧** | `pi --mode rpc` + 第一条 `get_state`：**冷启动 2.2 s / 2.2 s / 2.2 s**（三次）、热态 0.26 s。这是空载机器上的基线，只有 4 倍余量；而放大器全是常见情形 —— 长会话要读大 JSONL、多开 tab 抢磁盘、Defender 实时扫描 | `HANDSHAKE_TIMEOUT = 40s`；报错文案带上"真实等了多久"（`pi command 'get_state' timed out（等了 40s 没回）`），以后能一眼分清"慢"与"卡" |
| **孤儿 worker 抢同一份会话文件** | 进程树上直接看到：`cmd.exe`(pi.cmd 垫片) + `node.exe`(真 pi)，**4 个孤儿**的父进程已经不在了（`<已死>`），其中 **2 个孤儿与 2 个在跑的 tab 各占同一份 `.jsonl`** —— 同一份会话被四个进程写 | `shutdown()` 里对整棵树 `taskkill /PID <pid> /T /F` + `wait()` 收尸 |
| **握手失败会把失败传下去** | `create_tab` 里 `get_state().await?` 是**先 spawn 再握手**：超时那一刻 worker 已经在跑，但它不在 `self.tabs` 里（没人会再关它），进程活着、会话文件继续被它握着 —— 用户再点一次同一个会话，就有了两个写者，下一次更慢 | spawn 之后的失败一律 `worker.shutdown()`（`create_tab` / `bind_new_tab`） |

**孤儿是怎么来的**（这是本轮最值钱的一条）：Windows 上 pi 是从 pnpm 垫片启动的，
链是 `piggy → cmd.exe → node.exe`，而 `tokio` 的 `Child::kill()` / `kill_on_drop(true)`
**只杀直接子进程**。本机实测：杀掉直接子进程之后孙进程仍在；`taskkill /T /F` 才连根拔掉。
顺带试过更"正统"的 Job Object（kill-on-close）：本机 `AssignProcessToJobObject(cmd.exe)` 返回 1，
但它 fork 出来的 node **`IsProcessInJob` = 0**，关掉 job 句柄杀不掉它 —— 所以没走那条路。

**还剩的缺口**：整棵树清理要 piggy 活着才能执行。**piggy 被强杀/崩溃**时孤儿仍会留下
（`kill_on_drop` 在那种路径上同样只杀直接子进程）。补法是在启动时枚举"父进程已死 +
命令行含 `pi-coding-agent` 且 `--mode rpc`"的进程收掉 —— 本轮没做（要引 `tasklist` 输出解析），
先记在这里。手工清一次的形状：

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*pi-coding-agent*' -and $_.CommandLine -like '*--mode rpc*' } |
  ForEach-Object { taskkill /PID $_.ProcessId /T /F }
```

**⚠️ Windows 上 `cargo test --lib` 是红的（19/348，与上面两件事无关）**：这些用例把 POSIX 路径
写死在断言里，在 Windows 上必然不等。查过一条的字节级现场（把 `resolver.rs` 临时回到 HEAD 复现）：
`left: "open -a /Users/x/Applications\\Zed.app"` vs `right: "open -a /Users/x/Applications/Zed.app"`
—— 是 `PathBuf::join` 用 `\` 拼、断言写的是 `/`，**不是本轮改动引入的**。清单：
`open_in_app::host::tests` 7 条（`/bin/echo`、`/bin/sleep`、`/bin/sh`、`/bin/ls`、`/usr/bin/false`）、
`open_in_app::resolver::tests` 2 条（夹具有反斜杠）、`open_in_app::paths` / `open_in_app::icons` /
`open_in_app::tests` 各若干（`/tmp`、`/bin/ls`）、`config::paths` / `config::pi_files` /
`fs_guard` / `plugin::inventory` 各 1-2 条（路径分隔符与 `HOME` 口径）。
本机实测：**331 passed / 19 failed / 9 ignored**，其中本轮新增的
`icons::tests::real_windows_executable_icon_is_a_png`（真跑 PowerShell 抠图）、
`windows_icon_script_stays_pure_ascii`、`windows_executable_icon_runs_the_script_and_reads_the_png`
（假宿主验证接线）与 `pi::client::tests::kill_process_tree_takes_the_grandchildren_too`
（真进程树；红检过：把 `taskkill` 关掉它就点名"子孙进程 N 活下来了"）**都是绿的**。
要给这些用例补 `cfg(unix)` 闸门或平台化断言，是另一件事，本轮没顺手动它们。

### 4.2 前端那 5 条失败：全是"模块求值的账"，不是逻辑错（2026-10-09）

同一轮里 `pnpm test` 在 Windows 上红 5 条。查完的结论：**没有一条是被测逻辑错**，
3 条是平台/环境限制（`permission-guard.test.ts`，已加可见闸门，见下），
2 条是**用例把"整棵应用树的模块求值"算进了自己的 5 秒预算**。

| 用例 | 计时证据 | 处置 |
|---|---|---|
| `session-name-sync` 的「生成完把名字推给标签」 | `import('@/lib/appCommands') = 9308ms，调用 = 2ms` | 把这句 import **提到文件顶部**（它不依赖 `vi.doMock`）：求值挪进收集期、不计入用例预算。用例体 **9.6s → 0.3s**，8/8 连跑 3 次全绿 |
| `feedback` 的「真实 `<App />` 树里桥位正确」 | 卡在 `await import('@/App')`；这棵树在 jsdom 里求值就要 4-5 s（`collect` 期被它撑起来） | 这条**必须**保留动态 import（要在 `vi.doMock('@tauri-apps/api/core'…)` **之后**才加载，否则真模块被绑进去，用例立意就没了）→ 只把它自己的预算放宽到 30 s，并把 `antd` 提到顶部 |

传递依赖是 `appCommands → EditorArea →（dockview / SessionWorkspace / FilePreview / DiffView /
SettingsTab）` —— **整棵编辑器 UI 树**。所以这不是产品缺陷（真机上这棵树只在启动时求值一次），
而是**测试写法**的坑：**别把重模块的 `await import()` 放在用例体里**。
`about-dialog.test.tsx` 一直是静态引入 `appCommands`，所以它从没撞过。

`permission-guard.test.ts` 那 3 条的两种原因（已加 `describe.skipIf(platform === 'win32')`，
Windows 上显示为 **7 skipped** 而不是红）：
① `isInside` 组喂 POSIX 字面量（`/work`…），而守卫按 `path.sep` 比较 —— **守卫是对的，
用例不可移植**（它只在 pi 进程里跑，那个进程的 `node:path` 就是 POSIX）；
② 符号链接那两条要 `symlinkSync`，Windows 普通进程报 `EPERM`。
顺带修掉一个**更隐蔽**的问题：那条"拦截经符号链接逃逸"原先**依赖上一个 describe 建的链接**，
闸门一加它就会因为"链接不存在"而通过 —— 一条永远绿、什么都没验的用例。链接改由本组
`beforeAll` 自己建。

### 4.3 `pnpm test` 全绿也可能非零退出（已知 flake，不是本轮引入）

本机实测：**66 文件全过（633 passed / 7 skipped）**，但 **exit code = 1** ——
vitest 报 1 条 unhandled error：

```
ReferenceError: window is not defined
 ❯ performWorkOnRootViaSchedulerTask  react-dom-client.development.js
This error originated in "src/test/settings-delegation.test.tsx" …caught after test environment was torn down
```

根因 [`src/test/dom-render.tsx`](../apps/desktop/src/test/dom-render.tsx) 的注释里早就写清了：
React 19 的 scheduler 在 Node 下走 **`setImmediate`**（不是 jsdom 的定时器，拆环境时不会取消），
于是同步 `unmount()` 之后排队的回调会在 `window` 消失后才跑。**单独跑那个文件是 exit 0**，
只在并发全量时偶发 —— 与 `dom-render.tsx` 记的"8 次中 2 次"是同一类。
**判据：`pnpm test` 偶发非零退出 ≠ 有回归，先单跑那个文件确认。** 本轮没动它（drain 试过，修不掉）。

### 4.4 `pi worker exited`：Tauri 给的路径带 `\\?\`，pi(node) 不认（2026-10-13）

用户在另一台机器上更新代码并拉取到最新之后，本机建会话**每次都失败**，日志形状是
`[piggy] spawn pi [...]` 打出完整命令行，紧接着 `[piggy] tab_create FAILED: pi worker exited`。
注意它**不是** §4.1 那个 `get_state timed out` —— 超时是"pi 不理我们"，这个是"pi 自己退了"。

**查法（一趟就够，值得抄）**：把那条命令行**原样**手工跑一遍，看 pi 自己的 stderr。
`Start-Process -RedirectStandardError` 拿到的第一手现场：

```
Error: Failed to load extension "...\resources\pi-plugins\pi-ask":
       Failed to load extension: EISDIR: illegal operation on a directory, lstat 'C:'
Error: Failed to load extension "...\resources\pi-plugins\pi-todo": Cannot find module '\\?\C:\...'
Hint: Start without extensions using "pi -ne".
```

**根因**：Tauri 的 `path().resource_dir()` 在 Windows 上返回 **verbatim 路径**（`\\?\C:\...`）。
Rust 侧用它读文件一切正常，我们也就一直原样往下传 —— 但这些路径**不是给自己用的，是给
node 当命令行参数的**。node 的 fs 层认 `\\?\`（本机探针验证：`statSync` / `pathToFileURL` /
`import.meta.resolve` 三种都对），**模块加载器不认**：pi 加载目录形式的 `--extension` 时报
`EISDIR ... lstat 'C:'`（把 `\\?\C:` 当成了模块标识符），三条插件扩展全部失败 → `exit(1)`。

**A/B 对照**（只改"前缀"这一个变量，同一台机器同一份资源）：

| argv 里的 `--extension` | pi 退出码 | 说明 |
|---|---|---|
| 普通路径 `C:\…\resources\…` | **0** | 守卫 + 桥接 + 三个插件目录全部加载成功 |
| `\\?\C:\…\resources\…` | **1** | 与用户日志逐字一致 |

**为什么以前没暴露**（这条比根因更值钱）：**单文件**扩展带前缀照样能加载，
**只有目录形式**的插件会炸。`piggy-guard.js` / `piggy-bridge.js` 一直是文件，
而 `pi-plugins/` 是后来才以**目录**形式注入的（`pi-guardrails` 更是这一轮才收录）——
所以这个坑在"插件还是文件"的那些版本里根本不存在，**只在 Windows 上出现**，
而且表现为"pi 起不来"而不是"路径写错了"。

**处置**：`lib.rs::plain_path`（摘 `\\?\` 与 `\\?\UNC\`，不做别的规范化）+
`resources.rs::plain_resource_dir` 在定位处各摘一次 + `process.rs::cli_args` 推
`--extension` 时兜底再摘一次（`bundled_extensions` 是上层传下来的，谁传都可能带前缀）。
启动日志把**原始值与摘后的值**都打出来，以后再撞见这个坑第一眼就能认。
四条用例钉住：`plain_path` 的盘符/UNC/无前缀/POSIX 四种形状、带前缀的 resource_dir
仍能定位且结果不带前缀、以及**argv 里不许出现 `\\?\` 前缀**（`OsString` 侧直接比字节前缀 ——
argv 不是 `String`，任何 `String::replace` 都碰不到它）。真机验收：把三个插件目录按
普通路径交给 pi，`exit=0`。

**回归对比**（本机实测，改动前后都跑全量 `cargo test --lib`）：`HEAD` = **354 passed / 19 failed / 9 ignored**，
改动后 = **357 passed / 19 failed / 9 ignored** —— 差额正好是新增的 3 条，**19 条红全是 §4.1 记的那批
POSIX 路径断言**（本轮一条没碰，名单逐条核对过）。另外 `pi::resources` 原有的四条用例在 HEAD 上
**本来就是绿的**：Windows 上 Rust 的 `is_file()`/`is_dir()` 认 `\\?\`，问题只出在**把路径交给 node 之后** ——
所以这个 bug 不可能被"路径存在性"那类断言抓到，只能靠断言"argv 里不许出现前缀"。

**最强的那步验收**（比手工复现更硬）：让**生产代码自己**组装命令行（`cli_args` + `worker_command` +
`resources` 的真实定位逻辑，只把 pi 换成发现链给的那个），并**故意喂 verbatim 的 resource_dir**，
然后真起一次 pi 并做 `get_state` 握手。结果：五条 `--extension` 全部无前缀、pi 零 stderr、
`get_state` 回 `success:true`。顺带又验了 §4.1 那条改动 —— worker 起的是真 `node.exe` + `cli.js`，
**不再经 `cmd.exe` 垫片**（`worker_command` 剥掉了它）。
⚠️ 这个探针是临时 `examples/` 程序，**没有提交**（跑完即删）；要复现就照上面这段描述重写一个。

## 5. 验收方式

**已完成。** `pnpm tauri dev` 起窗、人工确认渲染正常（2026-09-23）；
打包版 `Piggy.app` 启动 0 条 webview 错误，日志确认以 `workspace` 档拉起 pi 并加载包内守卫脚本。

agent 侧没有窗口截图能力（本机缺"屏幕录制"权限，见第 4 节），因此这一步必须人工做。
后续若再遇到界面异常，终端会直接打出 `[piggy][webview][ERROR] ...`（`ErrorBoundary`
与全局 handler 经 `webview_log` 转发），把那段贴出来即可定位，不必靠猜。
