# 04 · 前端架构与渲染分帧设计

> 上游：[01-architecture.md](01-architecture.md)、[03-module-design.md](03-module-design.md) · 下游：[05-performance.md](05-performance.md)、[07-keybindings-and-commands.md](07-keybindings-and-commands.md)

"分帧"在前端有两层含义，本文统一定义并给出机制：

1. **协议分帧**：Rust 合帧器把 token 级 delta 合并为 ≤60Hz 的帧（02 §5、05 §3.2）——控制事件到达率；
2. **渲染分帧**：前端把每帧的呈现工作组织成"瞬态直写 + 边界提交"两通道，任何一帧的工作量都有上界，与会话长度、输出速率解耦。

## 1. 工作区（Workspace）与布局设计

布局采用 VS Code 验证过的"双视图轨 + 主编辑区 + 底部面板"心智模型（概念复用见 10 §3.1），但内容换血：编辑区放的是**会话**而不是文件。

### 1.1 布局骨架

```
┌─┬────────────┬─────────────────────────────────┬─┬────────────┐
│L│ 左侧栏(可折叠) │ 主工作区 Editor Area              │R│ 右侧栏(可折叠) │
│轨│ 视图:       │ ┌Tab─────────────────────────┐  │轨│ 视图:       │
│ │ ·会话 ◀默认  │ │ 会话A ●│会话B│设置│预览✦   │  │ │ ·文件       │
│ │ ·Fleet     │ ├─────────────────────────┤  │ │ ·变更       │
│ │ ·搜索       │ │                           │  │ │ ·子代理     │
│ │ ·资源(M4)   │ │   每个 viewType 一个工作面   │  │ │ ·会话树     │
│ │            │ │                           │  │ │ ·统计       │
│ │            │ │                           │  │ │ ·Widgets    │
│ │            ├─────────────────────────┤  │ │  (extension) │
│ │            │ 底部面板：终端 · 输出         │  │ │            │
└─┴────────────┴─────────────────────────────┴─┴────────────┘
│ 状态栏：worker · 模型 · thinking · 上下水位 · 成本 · setStatus · 布局开关 │
└─────────────────────────────────────────────────────────────────────┘
```

### 1.2 区域定义

| 区域 | 默认 | 内容 | 折叠语义 |
|---|---|---|---|
| 左视图轨（L） | **只在折叠态出现** | 侧栏折叠后留下的 **56px 图标轨**：品牌标（点击=展开，hover 换成面板图标）+ 新建会话 + 设置。**它是折叠态唯一的出口**，绝不能省 | 取值抄 docs/12 §1.5 的 `SIDEBAR_COLLAPSED = 56`（24px 图标列 + 左右各 16px）。**没有"常驻左轨"这回事**（2026-09-24 决定）：本行原先计划过一条 44px 常驻图标轨（VS Code 活动栏语义），但 DSH `ui-layout/src/client/AppFrame.tsx:183-186` 写明 *neither platform keeps an icon rail* —— 折叠后的重开控件走标题栏（macOS 的 `shell.leading` 座位 / Windows 的 caption 行）。而且左栏只有一个视图（会话列表），轨道上没有可切的东西。**已从计划里删除**，见 docs/15 §4 |
| 左侧栏 | 展开·会话视图 | 见 §1.5 | `Cmd+B` 切换 |
| 主工作区 | — | tab 组（M1 单组；M3 split groups，§1.8）；**一个面板都没有时显示空态占位**（<EmptyEditor/>：水印 + 基础快捷键 + 中央入口，仿 VS Code 的空编辑组） | 不可折叠（专注模式除外） |
| 底部面板 | 收起 | 终端（xterm.js）/ 输出（日志·扩展通知历史） | `Cmd+J` 切换；终端 `Ctrl+\`` 直达 |
| 右视图轨（R） | 图标轨常驻 | 右侧栏视图切换 | 同左轨 |
| 右侧栏 | 收起（首次会话打开后自动展开一次） | 见 §1.6 | `Cmd+\` 切换 |
| 状态栏 | 常驻 | 见上图 | 不可折叠 |

深浅色主题跟随系统；主题变量经 CSS custom properties 下发（antd v6 默认 CSS 变量模式 + 自研渲染器共用一套 token，§6）。

### 1.3 Tab 模型（主工作区的组织单元）

**tab 类型**：

| 类型 | 标记 | 生命周期 | 示例 |
|---|---|---|---|
| 会话 tab | — | 显式关闭；关闭 = worker 立即优雅回收（不同于空闲回收） | 对话 |
| 预览 tab | ✦（斜体） | **单实例可替换**：下一次同类预览覆盖它；编辑/双击→固定为普通 tab（VS Code preview 语义，10 §3.4） | 文件预览、diff 预览、会话考古 |
| 工具 tab | — | 显式关闭；无 worker | 设置、快捷键、Fleet 总览、登录终端（M4） |

**徽标**：`●` 流式中（呼吸动画）；`未读` 后台 tab 收到 `agent_settled` 时标记；`⌁` worker 已回收（点按复活，02 §7.5）。

**tab 操作**：右键菜单 = 重命名 / fork 此处 / clone / 在终端打开会话目录 / 休眠（丢 store 留游标，05 §4.3）/ 固定 / 关闭；溢出滚动 + `Cmd+1..9`。

### 1.4 上下文跟随规则（工作区的核心语义）

1. **上下文跟随活动 tab**：右栏/底栏/状态栏展示的都是活动 tab 的项目与会话（文件树=活动 tab 的项目 cwd；变更/统计/会话树=活动会话）；
2. 会话 tab 被工具 tab/预览 tab 覆盖时：**保留上一个会话 tab 的只读上下文**（与 VS Code 编辑器失焦行为一致）；
3. 后台 tab 的事件只进 store 与徽标，绝不触碰当前上下文的 UI（05 §3 前提）；
4. 左侧栏的"会话视图"不随 tab 切换重置（它是导航面，不是上下文面）。

### 1.5 左侧栏视图

| 视图 | 内容 | 阶段 |
|---|---|---|
| 会话（默认） | 多项目常驻分组（multi-root）；每组按最近活动排序；搜索（名称/路径）；组操作：新建会话（选模型/模板）、打开其他项目目录 | M1 |
| Fleet | 宿主编排 runs 列表（06 A 层）+ 会话内子代理快捷入口（06 B 层） | M3 |
| 搜索 | 跨会话内容搜索（M1：名称/拉取式；M2：本地索引） | M1/M2 |
| 资源 | pi 包/skills/extensions/主题浏览器（读 `~/.pi/agent/` 清单） | M4 |

**已删除项目的会话汇总成一个收起的组**（2026-09-28 真机回归）。起因是"读会话根"改成
两种布局都认之后（03 §2.8）：自定义 `sessionDir` 下 pi 会把每次 `pi -p` 的会话**平铺**
写进同一个目录，其中大量是它自己在 `/private/tmp/...`、`/var/folders/...` 里跑出来的，
于是侧栏一次多出 76 个"每个只挂 1 个会话"的分组；它们比真项目**新**，纯按时间排序就把
`/Users/wxk`、`1m-go-websockets` 挤到第 16、27 位 —— 用户看到的就是"原来的会话没有了，
多了一堆新的会话"。

规则（`buildSidebar`，纯函数可测）：

- 分组里**只要还有**会话的目录存在，就仍按普通项目排（按最新会话降序）；
- 所有会话的目录都不存在的分组 → 合并成一个「已删除的项目目录」汇总组，
  **沉到最后、默认收起**，组头显示条数，展开后才列出来；
- **不过滤**：这些会话文件都还在（pi 的 `--resume` 也能看到它们），过滤掉等于替用户删；
- 汇总组里**不提供「新建会话」**（cwd 已不存在，`tab_create` 必然返回 `SESSION_CWD_MISSING`），
  展开时给一句"目录已不存在，打开可能失败"。

判据直接用后端已有的 `SessionMeta.cwd_missing`（逐会话），前端不额外查文件系统。

展开后提供**「全部移到回收站（N 个）」**（用户要求）：走的是和单条删除**完全同一条**
`session_delete` → 系统回收站的路，不是一个"直接 `rm`"的快捷方式——那样就绕过了回收站，
用户后悔时找不回来。逐条发、逐条从 store 移除，中途失败也保住已删部分的状态，
最后把成功/失败条数一起报出来（不吞错）。

### 1.6 右侧栏视图（辅助）

| 视图 | 内容 | 备注 |
|---|---|---|
| 文件 | 活动 tab 项目的**只读**目录树（懒加载展开）+ 文件类型图标（Seti 子集，10 §4）；点击开预览 tab；M4 可选"快捷编辑"（00 NG4 边界内） | fs scope 需用户授权项目目录（08 §6） |
| 变更 | 活动会话的 `edit`/`write` 工具调用聚合为会话级 changeset：文件分组 + diff 列表 + 复制 patch；点击开 diff 预览 tab（Monaco DiffEditor，10 §2.1） | 数据源=转录流内已有 diff，零额外进程 |
| 子代理 | 06 §5 统一 Fleet 视图（B 层快照 + A 层 lane 摘要）；可展开为工具 tab 大图 | M3 |
| 会话树 | `get_tree` 分支图（自绘 SVG 缩略 + antd Tree 详情）+ fork/clone 入口 | 原 §4.5 的分支树移入 |
| 统计 | `get_session_stats`：tokens/cost 图表、上下水位条、压缩历史 | |
| Widgets | extension `setWidget` 面板（02 §8；aboveEditor/belowEditor 语义降级为 Composer 上/下常驻插槽） | |

### 1.7 底部面板

- **终端**：M1 = RPC `bash` 模式（xterm.js 渲染，明示"输出将随下一条消息注入上下文"，02 §3.3）；M4 = PTY 模式（跑 `pi /login` 等）；
- **输出**：通道级日志（`pi:frame`/`pi:commit` 采样）、`app:stats` 资源仪表（05 §6.1）、扩展 `notify` 历史归档。

### 1.8 布局引擎与持久化

- 分工：外框（左右栏/底面板的框线伸缩）= `react-resizable-panels`（轻量）；编辑区（tab 组/split/拖拽）= **dockview，M1 即引入**（10 §决策表）；业务组件只面向 **LayoutManager 抽象**（viewType 注册制），换引擎不动业务；
- 持久化：每个项目（workspace）记忆两侧栏开合/尺寸/活动视图、面板高度、tab 顺序与固定态（写入 `config/app.rs`，项目路径哈希作键）；
- 专注模式：`Cmd+K Z`（chord）隐藏两侧+面板；再次执行或 `Esc` 退出；
- 弹性下限：**未实现**。docs/12 §1.5 定了 `SIDEBAR_AUTO_COLLAPSE = 1024`（视口 < 1024px 自动折叠）与"主工作区永不低于 560px"，Piggy 目前是纯百分比（侧栏 13–38% / 主区 ≥40% / 右栏 13–34%），窄窗口下侧栏被压到 13%（620px 窗口 = 122px）也不会自动折叠。要接的话现在**安全**了（折叠后有图标轨可点回来，见 §1.2），但仍是有意为之的产品决策；另注意 `SIDEBAR_MIN/MAX/DEFAULT = 264/420/280`（px）也还没接。

### 1.9 多项目（multi-root）语义

- 单窗口多项目：左侧栏"会话视图"的项目分组即工作区根集合；每个 tab 绑定唯一项目（pi worker 的 cwd，01 §2.2）；
- 新建会话必须先有项目上下文（从分组内 + 或"打开项目"选择目录）；
- 项目移除只移出侧栏，不删任何会话文件（会话文件仍由 pi 目录规则管理，02 §6.1）。

### 1.10 轨迹视图（Trajectory，M1 v1 / M2 时间线）

参考 DSH 轨迹页（docs/11，dsh_3.png）：对话之外提供"全过程回放"视角。Piggy 的数据源天然齐全——`get_entries`（append-only 树，含工具调用/压缩/label）+ 实时事件流，无需 pi 侧任何改动。

- **入口**：主工作区会话 tab 内二级页签 `对话 | 轨迹`（同 DSH；与右栏"会话树"互补：树看分支结构，轨迹看时间顺序）；后台 tab 的事件同时写入轨迹缓冲；
- **事件流列表（M1）**：按轮次分组的全事件行——角色芯片（系统/用户/上下文/助手/工具/压缩/label）、工具行 `toolName args → result`（单行截断 + 点击展开全文）、每行可折叠；过滤：时长/轮次/调用类型；搜索框（前端过滤 M1，本地索引 M2）；
- **压缩行必须可展开**（2026-09-23 用户："上下文压缩的轨迹是无法看到细节的？"）：DSH 的轨迹在选中
  `compacted` 记录时给「概述 / 原始输出」两页，概述里有状态、时长与**摘要全文**
  （`TrajectoryTable.tsx:3255-3296`；cell 形状见 `ui-trajectory/src/client/layout.ts:333-362`）。
  Piggy 没有详情面板，就把同样的东西放在**行内展开**里（`row.detail` + `expandable`）：
  触发原因 / 压缩前后 token / 保留边界 / 涉及文件 / 摘要调用用量 / 摘要全文（03 §3.0f）。
  这一行的折叠分支过去永远不成立（`detail`/`expandable` 都没设），于是"点不开＝看不到细节"；
- **三轨时间线（✅ 已落地 M1）**：输入/模型/工具三条水平泳道的甘特式全景（会话起点→末尾）。
  > **2026-09-23 更正**：此处原写"需要 Rust 侧为事件信封补充单调时间戳（`pi:frame`/`pi:commit` 加 `t` 字段）"，
  > 该前提**只对实时帧通道成立**。时间线的主数据源是 `get_entries`（append-only 账本），
  > 每条记录本来就带 `timestamp`，`stores/trajectory.ts` 早已解析为 `ts`——
  > 因此账本时间线**无需任何 Rust 改动**即可落地，已按 docs/12 §4.7 的几何实现
  > （`TrajectoryTimeline.tsx`，44px 标签栏 + 三轨 7/21/35px + span 8px 高）。
  > 纯函数 `laneFor` / `buildSpans` 有单测（`src/test/timeline.test.ts`）。
  > 缺时间戳时自动退化为等宽 sequence 模式。实时帧补 `t` 字段仍是 M2 的独立事项（用于边收边画）；
- **渲染纪律**：轨迹列表同样虚拟化 + 纯文本渲染（复用 §5.1 转正阶段管线），事件行组件 antd-free。

## 2. 组件树与渲染责任

```
<App>
 ├─ <AppFrame/>                      布局骨架（LayoutManager，§1.8）
 │   ├─ <TitleBar/>                  （antd-free，含窗口控制）
 │   ├─ <SideBarHost/>               左侧栏视图宿主：会话/Fleet/搜索/资源（§1.5）
 │   ├─ <EditorArea>                 dockview：tab 组/split/拖拽（10 §）
 │   │   ├─ <TabStrip/>              自研：预览语义/徽标/溢出（§1.3）
 │   │   ├─ <EmptyEditor/>           **一个面板都没有时**盖在编辑区上的占位：
 │   │   │                           水印 🐷 + 基础快捷键表 + 中央入口（点一下就执行）
 │   │   └─ tab 内容路由（viewType → 组件）：
 │   │       ├─ <SessionWorkspace/>  会话 tab：SessionHead + Transcript + Composer（§2.1）
 │   │       ├─ <FilePreview/>       预览 tab（MonacoHost · Monaco 只读，10 §2）
 │   │       │   └─ <OpenPathAction/>  头部最后一格：「用外部应用打开**这个文件**」
 │   │       │                        （系统文件关联；与目录那档共用 <OpenTargetButton>）
 │   │       ├─ <DiffPreview/>       预览 tab（Monaco DiffEditor）
 │   │       ├─ <SettingsTab/>       设置工具 tab：**左侧竖排导航 + 右侧内容**（DSH 设置弹窗
 │   │       │                       的版式），三节：模型 / 通用设置 / 高级（§2.2）
 │   │       ├─ <KeymapTab/> <FleetTab/> <LoginTerminalTab/>（M4）
 │   ├─ <ViewRail side="right"/> + <RightBarHost/>   右侧栏视图宿主（§1.6）
 │   ├─ <PanelHost/>                 底部面板：终端（xterm）/输出（§1.7）
 │   └─ <StatusBar/>                 状态栏（antd-free）
 ├─ <DialogRouter/>                  Extension UI 弹窗（antd，02 §8）
 └─ <CommandPalette/>                自研
```

### 2.2 设置页（SettingsTab）

版式抄 DSH 的设置弹窗：**左侧竖排导航 + 右侧内容列**（DSH `ui-settings` 的 shell）。
横向胶囊在条目变多以后会挤成一团，而这一页的条目只会继续长（插件、Agent 预设…）。

四节，对应"配置 pi 的几层需要"：

| 节 | 内容 | 组件 |
|---|---|---|
| **模型**（默认） | 提供商列表（名字 + 状态点 + 编辑/删除）→ 一比一对应的编辑卡片 → 添加流程。卡片内：API 密钥（主字段）+「检测」+ 折叠的「自定义设置」（API 地址 / API 协议 / 模型目录 / 获取可用模型） | `ProvidersSection` + `ProviderEditor` + `ModelRows` + `FetchModelsDialog` |
| **插件** | pi 的扩展：按加载优先级分组列出四个来源 + pi 内置，逐行启停/升级/删除，安装对话框与任务输出 | `PluginsSection` + `InstallPluginDialog` |
| **通用设置** | 会话目录、pi 可执行文件、新会话默认权限、并发上限、子代理委派 | `GeneralSection` |
| **高级** | `models.json` / `settings.json` 的原始 JSON 编辑器（表单覆盖不到的字段的逃生口） | `AdvancedSection` |

「模型」一节对齐 DSH `ui-settings-models`（`ModelsSection` / `ProviderEditor` / `ModelListEditor`），
并针对 pi 的实际情况做了三处**有意的差异**：

1. **密钥来源写在脸上**。pi 的密钥有三级来源且只有一级生效
   （`provider-composer.ts:347-375`：auth.json 凭据 > models.json 的 `apiKey` > 环境变量）。
   本机真实形态就同时存在（cc-switch 那类工具把密钥写进 models.json，auth.json 是空的），
   所以列表行与编辑卡片都显示"当前生效的密钥来自：X"，且当两处都有时给出黄色警告 +
   一键"从 models.json 删掉它"。只写"已配置"= 用户改了没生效也查不出来。
2. **状态点只有两种**（有密钥 / 没密钥），与 DSH 的 credential dot 同义；DSH 的"首跑姿态"
   （一个提供商都没配时把添加卡直接展开）照搬。
3. **检测/获取可用模型优先读 pi 的本地模型目录**（`models-store.json`，`pi update` 维护），
   目录里没有才真发一次 HTTP。这与 DSH `discovery.ts` 的规则一致（"目录里有的就不上网问"），
   但数据源搬到了 pi 的缓存上。结果里带 `source`/`url`，界面写清楚"这条是目录里的还是问出来的"。

数据只有一个来源：`provider_overview`（03 §2.12）。任何写操作之后**重新拉取**，
前端不做本地合并——否则界面显示的和 pi 真正读到的会分叉。

### 2.1.4 任务清单（TodoRow / TodoPanel）

todo 是**插件提供**的能力（docs/03 §2.20）：没探测到已启用的插件时，这一节的两个组件
都返回 `null`，界面与从前一模一样。用户的要求就是这条分界线。

#### 转录里的清单行（`TodoRow`，DSH `ui-tool/.../todo-row.tsx`）

```text
▸ 更新任务清单 · 1/3 已完成 · 跑回归测试          +1   新增 1 · 更新 2 · 移除 1
  展开 ↓ 与上次清单相比 · 1 项未变化
         ✓ 写迁移脚本            已完成
         ◐ 跑回归测试            进行中
         ◐ 补一条端到端验证      进行中
         ・更新文档（删除线）    已移除
```

* 行的几何与工具窄行**同一套**（`DisclosureRow`：24px / 16px 前导框 / 13px 标题），
  因为它本质上就是一行工具调用（docs/12 §3.3）；
* 摘要两半**故意分开**：`n/m 已完成 · <第一件进行中的事>` 会被省略号截断，
  而"还有几条在跑"（`+N`）与差异摘要放在**不可省略**的一侧（DSH 的 `summarySuffix`）；
* 差异按**这一行之前**的那份清单比（`todoBaselines`，键是**调用 id** ——
  查错了不报错，只会让每一行都显示成「首次记录」，所以有端到端用例钉着）；
* 被拒的调用（本仓的复杂度闸门就会拒）走 `isError` 分支：**显示拒绝原因，不显示清单** ——
  DSH 的 `todoDiffModel` 对 `isError` 直接返回 null，同一个立场；
* 文案与 DSH 的中文原文一致：`任务` / `更新任务清单` / `已完成` / `进行中` / `待处理` /
  `首次记录` / `与上次清单相比` / `旧清单不可用` / `清单没有变化`（`locales.ts:77-107`）。

#### 输入卡正上方的计划面板（`TodoPanel`，DSH `skeleton/TodoPanel.tsx`）

位置也是照抄：DSH 把面板挂在 `conversation.input.dock` 槽上，而它渲染那个槽的地方
正是**输入卡正上方**（`ConversationContent.tsx:155-161`：先 dock，再 `inputBar`）。
Piggy 放在 `.pg-composer-card` 之前——真浏览器门禁按几何断言"面板底 ≤ 卡顶"，
把它挪到下面就会红（实测过）。

几何逐条对齐 DSH 的 `TodoPanel.module.css`：圆角 12px、`padding 6px 12px`、
头部 `gap 10px`、标题 13px/24px + 500、进度 `flex:1` 省略号 13px/20px、
列表 `gap 8px` + `max-height 180px` 可滚、项内 `gap 10px` + 字形 16×16、
内容 13px/20px 单行省略号。两层"默认折起来"：面板默认只露头部一行（进度看得见），
点开才展开列表。

三处与 DSH 不同的地方（都是有意的）：

| 项 | DSH | Piggy | 为什么 |
|---|---|---|---|
| 状态标记 | `StateDot`（done/ongoing/idle 三态圆点） | codicon 字形（✓/◐/○）+ `title` 状态名 | 本仓图标体系就是 codicon（docs/13），不引 DSH 的图标包 |
| 清空后 | 面板消失 | 留一行"上一轮的任务清单已归档（新一轮开始）" | 用户看到计划"突然没了"会以为丢了；DSH 的 `turn/start` 清空是设计而不是故障 |
| 来源标注 | 无 | 头部右侧一个小徽标（`条目`/`调用`/`实时`，链条走断时带 `?`） | 排障时"这份清单是从哪读出来的"必须一眼看得出（docs/15 规矩 30 的同一条纪律） |

守卫：`src/test/todo-row.test.tsx`（8 条）、`todo-panel.test.tsx`（9 条）、
`todo-transcript.test.tsx`（2 条，端到端跑两行写入，钉住基线的配对键）、
`todo-model.test.ts`（21 条，含与 Rust 状态白名单的跨语言一致性）；
真几何由浏览器门禁量（12 项断言 + 能力闸门的 4 项）。

### 2.3 插件页（PluginsSection）

版式对齐 DSH 的插件页（`client/ui-plugin-manager`）：**分组 → 卡片行 → 行内开关**，
点名字展开详情。DSH 那一页在侧边栏（不在设置里），本仓放在设置左导航——放哪儿是次要的，
重要的是**同一套卡片行语言**。

三处与 DSH 的**有意差异**：

1. **按作用域分组**（本项目 / 全局 / pi 内置），不是 DSH 的"官方 / 已安装"。
   pi 的插件没有"官方"这一层，真正决定行为的是**哪份 settings.json**；
   而 pi 的加载优先级恰好就是按这个排的（03 §2.15），分组顺序 = 加载顺序。
2. **每一行都显示"状态是谁定的"**（展开后的第一项）。pi 的启用/停用是
   `settings.json` 里的 `-`/`+`/`!` 通配符（或包的 `autoload`），**不是布尔开关**。
   只给一个开关、不说依据，用户会以为开关说了算——于是"我明明开着，pi 却没加载"
   永远查不出来（docs/15 规矩 30）。
3. **不提供"打开 pi config TUI"**。DSH 有 HMR 可以热应用；pi 只有交互式 TUI 的 `/reload`，
   RPC 没有对应命令。所以页头明说：改动对**新开的会话**生效。

其余照搬 DSH 的做法：卡片的 48px 类型徽标框、一行省略的描述、尾部开关、
危险操作用红色文字按钮、删除走确认弹窗、空态/加载态/错误态。

**四类徽标**（颜色区分"我装的包"与"谁扔在发现目录里的文件"——这两者的删除方式、
升级方式、以及 pi 会不会加载它都不一样）：

| 徽标 | kind | 能否启停 | 能否升级 | 怎么删 |
|---|---|---|---|---|
| 插件包 | `package` | 是（写 `autoload`） | npm/git 可以 | `pi remove` |
| 发现目录 | `discovered` | 是（写 `-路径`） | 否 | 移到回收站 |
| 登记路径 | `path` | 是（写 `-路径`） | 否 | 取消登记（不删文件） |
| pi 内置 | `builtin` | **否**（开关禁用） | 否 | 不能删 |

**安装对话框**比 DSH 多一件事：**输入即校验**（`plugin_check_source`）。
pi 的 `isLocalPath` 只看前缀，所以 `@scope/pkg` 这种裸包名会被当**本地路径**，
实测报 `Path does not exist: …/@scope/pkg`——完全看不出要加 `npm:`。
与其让用户在几分钟的 npm 失败之后才发现，不如打字时就指出并给出正确写法。

**长任务**（安装/升级是分钟级的 npm/git 操作）走流式：命令立刻返回 `jobId`，
输出按行推 `plugin:log:<jobId>`，界面在任务面板里显示原始输出。
这么做的理由是**失败原因只在原始输出里**——网络、权限、依赖冲突只看退出码查不出来。

### 2.4 会话标题生成与右键菜单

**三个入口，一个动作**（都走 `session_title_generate`）：

| 入口 | 位置 | 说明 |
|---|---|---|
| 会话行右键菜单 | 侧栏任意会话行 | 新建的一套菜单（见下） |
| 行上 ✎ 图标 | 与改名/导出/删除同排 | 最常用的那一下 |
| 命令面板 | `生成会话标题` / `重新生成会话标题` | 作用于**当前会话** |

菜单文案随状态变：会话有名字时是「重新生成标题」，没有时是「生成标题」。
生成中图标转圈并禁用（生成是一次模型调用，不该并发点两次）。

**右键菜单（`ContextMenu`）**是 Piggy 的第一套：之前会话行只有三个悬停图标，
再加一个就挤成一片。三条实现要点都是"坏过一次才知道"的：

1. **portal 到 `document.body`**——会话行在可滚动的侧栏里，留在原地会被 `overflow` 裁掉；
2. **贴边内收**：菜单宽度取决于最长那条文案，所以先按原坐标渲染再量尺寸再挪
   （右下角右键时必须往左上翻，而不是被视口切掉一半）；
3. **焦点要等测尺寸那一帧之后**：第一帧是 `visibility: hidden` 的，而
   **隐藏元素 `focus()` 会静默失败**——菜单看着正常、键盘却完全用不了。
   jsdom 里 focus 不做可见性判断，所以这条只有浏览器门禁能量得到。

键盘：打开即聚焦、↑↓ 移动（跳过禁用项）、Enter 选中、Home/End 到两端、Escape 关。
鼠标能做的事键盘也要能做。

**「标题素材预览」**（菜单里的「看看会拿什么去生成」）不调用模型，只列出取材方式、
会用哪个模型、**思考强度**、以及会送出去的那几条消息。它是排查入口：标题不满意时第一个
要问的就是"它到底看到了什么"，没有这个界面就只能去翻会话 JSONL 再猜。
"会用哪个模型"显示的是**真正会被调用的那个**（设置覆盖优先），并注上是"设置里指定的"
还是"会话自己最后一次用过的"——两者改法完全不同。
会话里一条用户文字消息都没有时，明说"生成出来会是瞎编的"。

**设置**（「通用设置」> 会话标题）：字数上限（默认 20）、取材方式（第一条 + 最近几条）、
**标题模型**（下拉，数据来自 `title_model_options`）、**思考强度**（下拉）。
两处细节都是"看起来能用、实际没用"那一类，所以各有明确的界面行为：

- 模型下拉按 provider 分组，第一项是「跟会话自己的模型」（= 清掉覆盖）。
  选了不支持推理的模型时，思考强度**禁用并写明原因**——pi 会把不支持的档位静默降级成
  `off`，界面不禁用就等于骗人。选了档位时另有一行说明"pi 还会按模型声明的能力再收敛一次"
  （实测没声明的模型里「极高/最大」都发成 `high`，见 03 §2.16）。
- 列表**拉不到时退回手动输入**（`provider/modelId`），并把原因与原话显示出来：
  pi 没配密钥、或它换了表格格式，界面上看到的必须分别是这两件事，而不是一个空下拉。
  以前这里就是自由输入框，改下拉之后这条路不能断——否则"pi 没列出来的模型"再也填不进去。

**这一行的宽度是弹性的**（`.pg-title-model` / `.pg-title-thinking` / `.pg-title-manual`）：
最初写的是固定 320 + 168，加上标签与「手动输入」共约 647px，而 **1180 宽的窗口里
设置页内容区只有 531px** —— 第二个下拉被挤到下一行，第一行右边留一大片空白
（用户截图里的形状）。现在按 `flex-basis` + `min/max` 给：宽窗口长到上限、
窄窗口一路缩到 min，缩到 min 还放不下才整体换行。真机量出来的结果：

| 窗口宽 | 内容区 | 模型 | 思考 | 行数 |
|---|---|---|---|---|
| 1440 | 692 | 260 | 140 | 1 |
| 1280 | 593 | 260 | 140 | 1 |
| **1180** | 531 | 243 | 140 | **1** |
| 1100 | 481 | 193 | 140 | 1 |
| 1024 | 434 | 224 | 140 | 2（「手动输入」单独一行） |
| 900 | 357 | 260 | 140 | 2（思考 + 按钮） |

换行本身交给 `flex-wrap`（用户接受"屏幕小就换行"），但要求**任何宽度都不横向溢出、不压扁**：
标签 `flex: none` 且不折行、链接按钮 `flex: none`。这三条几何都有门禁核对
（1280 / 1180 / 900 三个宽度各量一次）——jsdom 里 `getBoundingClientRect` 全是 0，
只有真浏览器量得出来（docs/15 规矩 32）。

### 2.5 「关于 Piggy 与许可」（`AboutDialog`）

**三个入口，一个动作**（都只把 `uiStore.aboutOpen` 置真）：

| 入口 | 位置 | 说明 |
|---|---|---|
| 系统菜单 | macOS：App 菜单「关于」正下方；其它平台：Help | Rust 发 `app:open-about`，先把窗口亮出来 |
| 命令面板 | `关于 Piggy 与许可`（分类「应用」） | 键盘用户 |
| 侧栏版本号 | 品牌行那颗 `v0.1.0` 徽标（改成了按钮） | 鼠标用户最自然的入口 |

内容对着 GPL 要求逐条来：版权行、无担保声明（用警告色，它不是装饰）、许可名与
`GPL-3.0-or-later`、指向 gnu.org 的链接、第三方组件表（组件/许可/版权人/用在哪）、
以及 **GPLv3 全文**。底部「复制全部」把这一整套（含全文）写进剪贴板——
复制失败会明确报错，不假装成功。

两条几何约束（都是"撑爆了就等于没有"）：

* 全文区**自己不限高**，滚动交给对话框正文（`Modal.styles.body.maxHeight = 60vh`）——
  两层滚动条会让人滚到一半不知道在滚哪个；而全文直接铺开又会让模态高过窗口
  （实测 1280×860 下 879px），底部按钮被推到视口外；
* `destroyOnHidden`：antd 默认把关闭的 Modal 留在 DOM 里。插件页的安装对话框是按
  `[role="dialog"]` 找元素的，留着的这个会**先被选中**——门禁当场红在插件页那一段
  （拿到的是空字符串）。顺带也不再让 35KB 全文一直挂在 DOM 上。

### 2.6 会话预览滚动条（`TurnRail`）

主会话区一侧的**固定间距刻度梯**：一条刻度 = 一轮对话（用户提问 + 它的回答），
**覆盖整段会话**——没载入的那些画成虚线并可点击（换窗过去，§2.1.1）。
梯子比可视带宽时在内部滚动，跟随当前刻度只做**最小幅度**修正（不居中，见 §2.1.1）。
参数与状态全部照抄 DSH `ui-chat/src/client/chat/TurnNavigator`（docs/12 §3）：

| 状态 | 形状 | 颜色 |
|---|---|---|
| 静息 | 20×2px，`scaleX(0.6)` | `--pg-border-l4` |
| 悬停 / 聚焦 | `scaleX(0.9)` | `--pg-fg-caption` |
| **当前读到的这一轮** | `scaleX(1)`（满宽） | `--pg-fg`（最亮） |
| 键盘焦点 | `scaleX(1)` + 品牌色 + 细环 | `--pg-brand` |

刻度间距 **10px 固定**（不按文档长度比例）：按比例画的话，一轮很长的回答会把后面
所有刻度挤成一堆。梯子比可视带高时**在梯子内部滚动**（最大 420px），两端用 24px 渐隐
提示还能滚。悬停弹出预览框（标题=用户消息、正文=回答摘要，300×100），排版与行数上限**照抄 DSH 的
两个 font 令牌**：标题 `--dsw-font-xs-strong-13` = **500 13px/20px**、正文
`--dsw-font-xxs-12` = **12px/18px**（Piggy 侧是 `--pg-fs-13/--pg-lh-13` 与
`--pg-fs-12/--pg-lh-12`）；标题 clamp 1 行、正文 clamp 3 行（超出显示省略号）。
⚠️ 这四个数是**自洽**的：`10 + 20 + 4 + 3×18 + 10 = 98 ≤ 100`（容器 max-height）。
只写 `font-size` 而漏掉行高，行高会继承正文的 24px → 内容 120px > 100px，
**第三行连同省略号被父容器切掉**，看起来就像"overflow: hidden 硬切"
（用户报的正是这个）。这条算式在 `turn-rail.test.tsx` 里从真 CSS 读数核对，
渲染结果由门禁在真布局里量（正文恰好 3 行、容器不裁内容）。

**指针离开整条梯子时预览框要消失**（刻度只有 10px 高，指针从一条移到另一条会重设预览，
所以"移出整块"是唯一的清空路径——漏了它预览会一直挂着，docs/15 规矩 47）；
点击跳到那一轮；当前刻度**跟着滚动走**并在梯子内居中（指针停在梯子上时不抢）。

**左右两档只差一个属性**：`.pg-rail-left` 把刻度改成左对齐、预览框翻到右侧
（否则预览会盖住正文）。CSS 里两组规则各自镜像，组件只有一份。

**布局**（用户明确的约束）：开启时**两侧同时**加 44px 留白
（`--pg-rail-clearance`），刻度梯（28px 宽、贴边 12px）落在这段留白里——
正文列因此**仍然居中**于转录容器。门禁在真布局里量这件事：
右置与左置下 `|正文列中心 − 转录中心| ≤ 12px`（实测 0px），且刻度梯与正文列不重叠。

**数据来自整段历史**：Piggy 打开会话时一次性 `hydrate` 全部消息（没有分页），
所以刻度天然覆盖从头到尾每一轮——不需要 DSH 那套"宿主侧 outline 投影 + 未加载锚点"
（它们是为历史分页服务的：点未加载的刻度要先翻页）。等哪天做了"加载更早"，
`turnRailItems.ts` 要跟着加 anchor 概念。

**当前轮次怎么算**：取**阅读线**（视口顶部往下 1/4，最多 120px）所在的那一轮；
滚到底部直接取最后一轮。用视口正中会在长回答上乱跳；贴顶太灵敏。

### 2.1 SessionWorkspace（会话 tab 内部）


```
<SessionWorkspace>                   每 tab 一个，非活动 tab 卸载 DOM、保留 store
 ├─ <SessionHead/>               标题 + 右侧操作（仿 DSH §4 B1）
 │   └─ <OpenInApp/>             「打开方式」分裂胶囊（DSH ui-open-in-app）：
 │                               数据 = 宿主白名单目录；渲染 = <OpenTargetButton kind="directory">：
 │                               主按钮 = 上次用过的应用（图标 + 名字）→ 直接打开当前 cwd；
 │                               箭头 = 本机全部可用应用（真实图标，宿主抠出来的）。
 │                               宿主没解析出任何应用 / 会话没有 cwd → 渲染 null（不留死按钮）。
 │                               可用列表每页只读一次，上次选择跨重启记住（03 §2.11）
 ├─ <Transcript/>                自研：虚拟化容器 + 分页 + 贴底跟随（§2.1.1）
 │   ├─ 「加载更早」/「载入历史…」  分页按钮（hasMore 时才有，贴在内容流顶端）
 │   ├─ <TurnGroup/>             回合分组（虚拟行）
 │   │   └─ <MessageView/>       自研：按消息类型分发
 │   │       ├─ <TextBlock/>     <ThinkingBlock/> <ToolCard/> <ImageBlock/>…
 │   │       ├─ 压缩行            文件里的 `compaction` 条目（DSH 的「上下文已压缩」）
 │   │       └─ <LiveBlock/>     仅活动消息拥有（瞬态通道挂载点）
 │   ├─ 「回到底部」              离开底部才出现的 34px 圆形按钮（DSH `chat.toBottom`）
 │   └─ <CompactorBanner/> <RetryToast/> …（生命周期横幅）
 └─ <Composer/>                  自研 + antd Upload 粘贴/拖拽
```

**语言判定只有一处**：预览的语法高亮走 `features/common/monaco-langs.ts::langForPath`
（按扩展名 + 整文件名 → Monaco 语言 id，逐门懒加载）。`FilePreview` 里曾经还有一张 16 项的本地表，
于是 `.rs`/`.java`/`.toml`/`Dockerfile` 这类**语言表里明明有**的文件在界面上是"语言条写着 plaintext、
正文一行不上色"（docs/15 规矩 25 那类静默降级）。加语言 = 改 `monaco-langs.ts` 一处。

**antd 边界铁律**（01 §3.4）：`Transcript` 子树（除横幅类一次性组件）、`TabStrip`、`ViewRail`、`StatusBar`、`CommandPalette` 禁止引入 antd 组件；代码评审以 lint 规则固化（`no-restricted-imports` 按目录白名单，08 §4）。
### 2.1.1 转录的分页与滚动（2026-09-23 用户反馈）

三条反馈对应三处改动（实现细节见 03 §2.19 / §3.0d）：

1. **"长上下文的时候，打开会话，都是在开头，有没有办法在结尾"** →
   默认**跟随尾部**（DSH `ScrollFollow` 的初始 `followingTail`，容差 25px）：
   第一页灌进来贴底，之后新内容继续贴底，直到**读者自己往上滚**才交还控制权。
   程序化滚动不许把跟随关掉（`nextFollowing(prev, metrics, movedByReader)`）。
   实测踩到的坑：贴底不能只做一次——虚拟化器**量出行高**会把底部顶走，
   所以还要盯内容层（`ResizeObserver`）。⚠️ 当时盯的是 `el.firstElementChild`，
   而分页后第一个子元素是「加载更早」那颗按钮（高度永远不变），于是"行高量完再贴一次底"
   永不触发 —— 浏览器门禁量到 **198px 的缝**，改用 `innerRef` 指向内容层才归零。
2. **"如果在结尾并且部份加载，支持向上滚动点加载更多，能否节省计算/存储"** →
   **省客户端计算，不省存储**：会话文件是 pi 的 append-only JSONL，Piggy 只读不写，
   磁盘占用一字节不变；省下的是打开时的 IPC 载荷（11.7 MB 的会话只传 269 KB）、
   JSON 解析、store 内存与刻度梯重建。打开一页 = `session_page` 尾页（真机 50 行 5.1ms），
   往上的历史由「加载更早」（DSH `chat.loadOlder`）按需再读，加载中显示「载入历史…」。
   翻页**不许跳**：先量旧 `scrollTop`/`scrollHeight`，DOM 更新后按高度差补回去
   （`scrollTopAfterPrepend`，纯函数有单测）。
3. **换窗之后要能继续往下读**（用户 2026-09-23 第四轮："点了很高的位置再往下滚，
   滚到某个位置就卡住了，只能点按钮到最低位"）。两个出口，都不是"自动无限续页"：
   · **滚轮到底自动续一页**：判定挂在 `wheel` 上而不是 `scroll` 上。挂在 scroll 上会
     自我级联（续页 → 内容变 → 再触发 → 再续页），实测一跳就把 200/200 行全读进来 ——
     正好是用户担心的"其实已经加载了整个文本"；隐藏面板 `clientHeight=0` 时距离恒为 0，同样级联。
     滚轮是"我要往下看"最干净的信号：一次手势最多续一页，程序化滚动不会触发；
   · **右下角「继续往下」按钮**：拖滚动条/键盘翻页的用户走它；`hasNewer` 为真时与
     「回到最新」并排（一个逐页读完、一个直达尾部）。点它必须**把新内容带进视野**
     （先量下当前行数 → `loadNewer` → 把"新进来的第一行"滚到视口顶部）：
     只在下方追加而不滚，用户的观感是**"点了没反应"**（真机反馈）。
     滚轮触发的自动续页**不滚**（用户自己在滚，替他滚会打架）。两颗**带文字**的按钮必须各有自己的
     盒子（`width: auto` + `30px` 高 + `nowrap`）：第一版只给「回到最新」加了宽度，
     「继续往下」就变成"34px 圆钮里塞四个字"，文字溢出圆外 —— 用户的观感是
     **"这个按钮没有显示"**（真机反馈）。门禁按几何断言：盒宽必须 ≥ 文字所需宽度
     （中文 12px × 字数），高度落在 24~40。
   续到尾部后 `hasNewer` 转 false，实时消息恢复追加（换窗期间不追加，见 03 §3.2）。
4. **刻度梯覆盖整段会话**（用户 2026-09-23 第二轮反馈"预览滚动条好像不是全部的预览"）：
   梯子画**全部已知轮次**（会话文件的轮次轮廓 `session_outline`），轮次号是**全会话的绝对编号**，
   不随分页窗口漂。预览框对未载入的轮次也照常显示（轮廓里带了提示语与回答摘要）。
   未载入的刻度**不用虚线**（第三轮反馈"大部分都是虚线，不是实线"）：用户那场会话 30 轮 /
   1028 步，一页只覆盖一两轮，整条梯子大半是虚线，看起来像"坏了/缺一半"。
   现在形状与普通刻度同族，只靠**更短更暗**（`scaleX(0.45)` + `border-l3`，普通是 `0.6` +
   `border-l4`）加悬停提示表达"还没载入"——一眼仍是整段会话的地图。
   配套地，页的粒度也改成"50 行 **且** 5 轮"（03 §2.19），打开就能看到最近几轮。
   点未载入的刻度 → **换窗**过去（只读那一页），随后出现「回到最新」回到会话尾部。
   两条实测纪律：
   · 梯子内部的自动跟随改成**最小幅度**（只在当前刻度跑出可视带时把它拉回来），
     不再像 DSH 那样"居中"——Piggy 的刻度是固定 10px 间距（有意的差异，§2.6），
     100 轮的梯子有 1000px、装进 420px 的带子里，居中意味着每十几轮整体跳 ~200px
     （用户报的"预览滚动条在疯狂跳动"；实测梯子滚动 592 → 311 → 521）；
   · "到底了"取的是**已载入窗口**的最后一条**已载入**刻度，不是整个列表的最后一条：
     换窗到中间时下面还有未载入的更新轮次，取错了高亮会丢到没载入的地方。
5. **流式时不许闪**（用户第二轮反馈"还是疯狂闪动"，真凶在这里）：贴底跟随时内容每帧都在长高，
   而"这一帧离底多远"是拿**旧 scrollTop** 与**新 scrollHeight** 比的 —— 只看几何会把
   "我们自己贴的底"读成"读者滚上去了"。两个后果都实测到了：
   ① 跟随意图当场丢掉、视图停在半空（实测当前刻度 60 → 58 且不再跟随）；
   ② "当前是哪一轮"逐帧在"最新那轮"与"阅读线那轮"之间翻（实测 58 ↔ 61），
      梯子上的亮条就以帧率来回闪。
   修法：跟随意图改成问**"这段距离是谁造成的"**（`nextFollowingFromSample`）——
   内容比"贴底那一刻"更高 → 是内容把底推走的，继续跟随；位置没往上走 → 不是离开底部；
   只有"位置变小且内容没长"才算读者滚了。只看"位置是否等于我们钉的值"还不够：
   内容整段换掉时浏览器会做**滚动锚定**，位置会被挪到我们没设过的值（门禁实测：
   刚 `loadTail` 换完页就流式，视图停在离底 163px、当前刻度倒退一次）。
   而"当前轮次"用**跟随意图**而不是瞬时几何。
   守卫：jsdom 两条（钳制 scrollTop 才能造出那一幕——第一版假几何不钳制，红检时
   在错实现下照样绿）+ 浏览器门禁按帧采样断言（当前刻度倒退 0 次、跟随丢 0 次、
   梯子自己滚 ≤1 次、离底 ≤25px、实时文本长度单调不减）。
6. **转录区里不再有 ResizeObserver**（用户第五轮还在偶发那条循环报错）。
   实时块的成长**引擎自己就贴底**（`lib/live.ts` 的 `follow()`：离底 <120px 就 rAF 贴），
   再叠一个 60Hz 的观察者纯属重复，而且正是"回调 → 布局变 → 回调"的级联燃料。
   现在贴底改由**布局阶段**驱动：`useLayoutEffect` 盯 `virtualizer.getTotalSize()`
   （行被测量、消息到达、实时块长高都会让它变），并且 `pinToBottom` 自己幂等
   （已贴底差 ≤1px 就只刷新记录、不写 `scrollTop`）。
7. **全应用只剩一个 ResizeObserver，且它不许"量自己"**（用户第三轮截图：多次截图里梯子位置
   都不一样，但他没滚；控制台连着三条 `ResizeObserver loop completed with undelivered notifications`，
   第五轮又贴了三条同款）。根因是"观察者的回调会改变被观察元素的大小"：
   · **梯子量的是自己**：`railRef.current.parentElement` 就是 `.pg-rail`，而它的高度正是
     由量出来的 `bandH` 算的 —— bandH 420 → 高 356 → bandH 356 → 高 292 → … → 0 → 420，
     一个极限环。副作用是**梯子高度与可滚范围每帧都在变**，于是"没人滚它自己在动"。
     改成量转录带（`.pg-transcript-wrap`，`position: relative` 的容器），
     并在回调里只在与当前值不同时 setState；
   · **贴底不幂等**：贴底会改变滚动位置 → 虚拟化器渲染新行 → 行高被测量 → 内容高度又变 →
     观察者再触发 → 再贴底。改成"已经贴着底（差 ≤1px）就什么都不做"+ 每帧最多一次（rAF 合并），
     循环自然终止；
   · **每个代码块各建 1~2 个观察者**（一次会话几百个）：收进 `lib/resizeWatch.ts` 的
     **单一共享实例**（`watchSize`，见 03 §3.0e）。观察者数量本身就是级联机会的数量。
   剩下这条警告在真机（WKWebView）上仍可能偶发，而门禁（Chromium）里复现不出来：
   按规范逻辑实现会发出远多于 Chrome 的循环错误通知（csswg-drafts #6610，03 §2.18b），
   它只说明**这一帧**没收敛完，不等于死循环。判据是**有没有可见副作用**：
   有抖动/跳动/位置乱走 → 按本节的纪律改；只是控制台多一行 → 由
   `lib/resizeProbe.ts` 点名来源 + 错误日志折叠成一条留档（03 §2.18b）。
   守卫：三条 jsdom 用例（断言被 observe 的是转录带而不是 `.pg-rail`；用可计数的 `scrollTop`
   setter 断言"已贴底时再收到通知一次都不写"；断言"三张代码卡片只创建一个观察者、卸载后
   一个元素都不留"），外加门禁里对 `ResizeObserver loop` 这条错误单独点名。

## 3. 状态管理细则

### 3.1 结构态：messagesStore（normalized）

```ts
interface MessagesState {
  byId: Record<MessageId, AgentMessageView>;
  ids: MessageId[];                 // 稳定顺序（虚拟化的行源）
  turns: TurnGroupId[];             // 回合分组索引
  byTurn: Record<TurnGroupId, MessageId[]>;
  // 合并写：commit 批量应用，immer 生成结构共享的下一态
}
```

- 分页字段（03 §2.19）：`pageCursor`（已载入第一行的字节偏移）、`hasMore`、`loadingOlder`；
  `hydratePage` 换整页（打开、换窗）、`prependPage` 接到最前面并返回**新增行数**（调用方据此修正滚动位置）；
  `hasNewer` = 窗口下面还有更新的内容（换窗后为 true，界面给「回到最新」；此时实时消息不追加进窗口）；
- 更新**只**来自 `pi:commit`（message_end / tool_execution_end / turn_end…）——低频、权威；
- `AgentMessageView` = pi 权威消息 + UI 派生字段（折叠态、高亮标记等）分离存储，避免污染协议对象。

### 3.2 瞬态：liveStore（无文本本体）

liveStore 只登记"哪个 tab 的哪个 contentIndex 挂在哪个 DOM 句柄"，**不保存流式文本**。文本帧直接写 DOM（§4.3），彻底绕过 React 渲染与 GC 压力。这是流式 60fps 的结构性保证，而非微优化。

### 3.3 store 之外的规则

- 一切"当前输入框草稿"等 UI 态放组件局部 state / uiStore，不进 messagesStore；
- React Compiler 负责组件级 memoization；**禁止**手写 `useMemo` 包 store 派生（除非 profiling 证明必要），保持代码可被编译器分析；
- **外部可变状态红线（M1 实测）**：render 中读取模块级可变状态（registry/Map/数组缓存）会被编译器当纯函数缓存首帧结果——此类读取必须走 store 订阅，或文件顶部声明 `"use no memo"`（案例：CommandRegistry 面板空列表，09 §3.2）。

## 4. 流式渲染管线（渲染分帧核心）

### 4.1 帧的旅程

```
pi:frame:{tabId}（≤60Hz）
  → lib/ipc 帧解码（zod 轻校验：只校验 envelope，不校验文本内容）
  → liveStore.writeQueue.enqueue(frame)        // 纯入队，无渲染
  → rAF 调度器 flush：
      for item of queue:
        TextDelta      → liveTextNode.appendData(item.s)      // 文本节点追加，O(1)
        ThinkingDelta  → thinking 块同上（折叠态下只更新计数徽标）
        ToolArgsDelta  → 累积到缓冲（不渲染；toolcall_end 才展示）
        Usage          → 状态栏轻量更新（限 1Hz 节流）
```

### 4.2 帧内工作量上界

单帧工作 = N 个 `appendData`（N ≤ 该 16ms 内到达的帧合并后的项数，由 Rust 合帧器保证 ≤60 帧/秒）+ 一次 rAF。**与历史消息数无关**（实时块独立于虚拟化窗口）、**与输出 token 速率近似无关**（合帧器削峰）。这就是"任何一帧的工作量有上界"的准确含义。

### 4.3 实时块转正（commit）

`message_end` 到达（`pi:commit` 通道）：

1. `LiveBlock.unmount()`：断开直写句柄；
2. messagesStore 批量提交权威消息（immer patch）；
3. 虚拟化行立即包含新 `MessageView`（DOM 结构等价替换，视觉无跳变：实时块与新行使用同一 CSS 类，高度差异由虚拟器 measure 修正）；
4. 焦点滚动策略：用户在底部 1 屏内 → 自动跟随；用户上滚 → 暂停跟随并显示"回到底部"浮标。

### 4.4 工具执行增量

`tool_execution_update.partialResult` 是**累积量**（协议语义，02 §4.1）：ToolCard 内维护一个小的"输出区"组件，同样走瞬态直写（整段替换文本节点内容，内容 ≤ 上限 200 行/8KB，超出折叠 + "查看完整输出"走 `fullOutputPath` 经 asset 协议打开）。

### 4.5 长会话与考古

- 转录**已经按页装载**（§2.1.1、03 §2.19）：打开只读会话文件的尾部一页，
  往上的历史点「加载更早」再读；压缩在历史里是一行可见的"上下文已压缩"，并且**带全细节**
  （此前 token、保留边界 `firstKeptEntryId`、涉及文件、摘要调用用量、可展开的摘要全文，
  见 03 §2.19/§3.0f）。数字口径：这一行是账本行（精确到个位），轨迹表格那行才用 K 缩写；
  **`systemMessage` 永不进转录**（压缩后的整份系统提示词）；
- 尚未做：**读到哪记到哪**（DSH 会把阅读位置存下来，重开会话回到原位；Piggy 目前一律贴底）、
  以及"跳到很久以前的某一轮"（现在只能一页页往上翻）；
- "考古模式"（右栏或抽屉）：`get_entries` 游标分页（每次 200 条，向上滚动加载），只读渲染；
- 分支树（`get_tree`）用自绘 SVG 缩略图 + antd Tree 详情，点击分支节点提示"将切换活动分支（branch 导航）"——走 `switch_session`/fork 语义【契约验证 C11：RPC 的分支切换入口。rpc.md 只提供 fork/clone/switch；就地 branch 导航（TUI 的 `/tree`）若 RPC 未暴露，则用 fork 等价实现并在 UI 措辞区分】。

## 5. Markdown 与富内容渲染

### 5.1 双阶段策略

- **流式阶段（LiveBlock）**：纯文本直写。**不做 Markdown 解析**——流式中间态的 Markdown 是
  非法文法（半截的 `**`、没闭合的围栏），每个 delta 跑一遍 parser 必然抖动且浪费 CPU；
- **转正阶段（`features/chat/markdown.tsx`）**：`marked.lexer()` → **token 树 → React 元素**。
  按块拆成独立元素，`memo` 住（文本不变就不重解析；虚拟化下只有可见行会 parse）。

**为什么是 marked，且只当 parser 用**（2026-09-23 用户："直接用 marked，micromark 太小众了"）：

| | 做法 | 代价 |
|---|---|---|
| ❌ 常见写法 | `marked.parse()` 出 HTML 串 → `dangerouslySetInnerHTML` | marked 自己 README 第一条警告就是"**不 sanitize 输出 HTML**，请配 DOMPurify"（`marked/README.md:54`）→ 多一个 sanitizer 依赖 + 一条 `innerHTML` 信任边界；而且**挂不上我们的东西**：围栏没法直接换成 `CodeBlock`、链接只能事件委托 |
| ✅ 本仓 | `marked.lexer()` → 走 token 树，逐节点出 React | 自己写 ~150 行映射（本文件下面的规则），换来：**全仓无 `dangerouslySetInnerHTML`**、原始 HTML 只当文本、围栏直接进代码卡片、外链走宿主命令 |

语法覆盖 = marked 的 **GFM**（表格 / 任务列表 / 删除线 / autolink 全开）。四条硬规则：

1. **原始 HTML 不进 DOM**：`html` token 按纯文本渲染（`<script>`、`<img onerror>` 都只是字面量）；
2. **URL 白名单**：链接只认 `http:` / `https:` / `mailto:`，图片只认 `http:` / `https:`；
   其余（`javascript:` / `data:` / `file:` / 锚点 / 相对路径）**降级成纯文本并显示原地址**；
3. **链接点击不导航 webview**：`e.preventDefault()` → 宿主命令 `open_external_url`
   （Rust 侧 `validate_external_url` 再校验一次 scheme，前端被绕过也没用）；
4. 围栏 → 我们自己那块代码卡片（§5.2：shiki 按需高亮 / 折叠 / 复制 / 行数）。

数字（本机实测，同一样本 7 KB 的长回答）：marked 解析 **0.43 ms**，
micromark+mdast 是 **5.19 ms**（12×）；打包后 parser 栈 min+gzip
**12.9 KB vs 23.1 KB**。这也解释了为什么最终换成 marked。

> ⚠️ 加了新依赖之后，**正在跑的 Vite dev server 必须重启**（并清 `node_modules/.vite`）：
> 预打包缓存会拿着旧版本树继续服务，运行期报出 `this.getData is not a function`
> 这种版本错配，而 vitest（走 SSR transform）全绿 —— 又是一次"单测绿、真机红"。
> 2026-09-23 换 parser 时踩过（缓存比依赖修复早 19 秒生成）。

### 5.2 代码块

**高亮（`highlight.ts` + `CodeBlock.tsx`）**
- Shiki **按需**：core + oniguruma 引擎 + 语言包全部动态 import，初始包不含任何语法；
- 语言表是**静态字面量** `import('shiki/langs/x.mjs')` × 86（`highlight.ts` 的 `LOADERS`）。
  **不许写回** `` import(`shiki/langs/${id}.mjs`) ``：裸说明符 + 变量，Vite 的
  dynamic-import-vars 不分析裸说明符，产物原样保留 → 浏览器抛
  `Failed to resolve module specifier` → 被 catch 吞成纯文本。这就是 2026-09-23 那次
  「高亮从来没生效过、且控制台零错误」的根因，见 docs/15 规矩 22；
- 别名归一（`bash→shellscript`、`ts→typescript`、`c++→cpp`、`text→不高亮`…）；
  不认识的语言**界面明说"未收录此语言"**，加载失败**明说"未能高亮"** + `console.warn`，
  绝不静默降级；
- 全局 LRU 上限 16 语言（shiki 不能卸载语言，超限整体重建）；
- 进入视口才高亮（IntersectionObserver；无 IO 的环境直接高亮，不少一层功能）。

**diff 的"部分高亮"**
- `diffLineKind()` 逐行判 `add / del / hunk / meta / ctx`，经 shiki `transformers[].line`
  打在 `<span class="line">` 上（**不是**拿字符串切 HTML）；
- 判定顺序关键：`+++`/`---` 是**文件头**，必须先于 `+`/`-` 判掉，
  否则 `+++ b/x.go` 会被当成"新增了一行"；
- 底色取 VS Code Dark+/Light+ 的 `insertedLineBackground` / `removedLineBackground`，
  透明度压到 0.15 上下（`--pg-diff-*-bg`），左侧加 3px 色条。

**折叠（长内容必须够得到，规矩 21）**
- 标题栏常驻折叠开关（≥6 行才出现，避免碎块噪音）；
- `> AUTO_COLLAPSE_LINES (40)` 行**默认折叠，但内容全部在 DOM 里**（可 Ctrl+F / 可选中 / 可复制）；
- 正文 `max-height: 420px`，实际超高时压底给"显示更多"。**量的是 `<pre>` 不是外层 body**：
  限高长在 `pre` 上，量外层恒得到"没超高"，按钮永远不出现（第一版就这么写错了）；
- 病态超长（`> MAX_RENDER_LINES (4000)`）**显式截断并说清截了多少** + "仍要全部显示"。

**工具结果是"窄行 + 展开"**（2026-09-23 用户："多消息以及多工具消息的情况下，主工作区
空间利用率非常低，能不能跟 dsh 一样，用窄窄的可展开的折叠？"）：

```text
▸ 读取     · src/module1.ts                    ← 折叠：24px 一行
▸ 运行命令 · pnpm test -- --grep boundary-1
▸ 搜索     · boundary1\(
   展开 ↓ 上面那条的完整结果（还是这块代码卡片：高亮 / 行数 / 复制 / 超高展开）
```

- 几何逐条照抄 DSH：`ui-primitives/src/DisclosureRow.module.css` 的 **24px 行高 /
  16px 前导框（字形 14）/ 标题 13px/24px `flex:none`**，`ui-tool/.../ToolRow.module.css`
  的 **2×2 圆点 `margin: 0 8px` + 摘要 `flex:1` 单行省略号**；折叠时前导框显示**图标**、
  hover/聚焦换成**下箭头**（`DisclosureRow` 的 `.iconIdle` / `.chevronHover`）；
- 标题与摘要的表在 `features/chat/toolRowModel.ts`，逐条对应 DSH
  `ui-tool/.../models/tool-call-model.ts` 的 `TOOL_VARIANTS` / `VARIANT_TITLE_KEYS` /
  `SUMMARY_KEYS`（中文标题取自 `ui-conversation/.../locales.ts:290-296`）；
  参数键按 **pi 的 schema** 写（`bash.command` / `read.path` / `grep.pattern`…）；
- **摘要要的是调用参数，而参数在上一条助手消息里**（toolResult 只有
  `toolCallId/toolName/content/isError`）→ `stores/messages.ts` 的 `register()` 顺手建
  `toolCalls` 索引（`toolCallId → {name, args}`，三条路径都会经过它：hydrate / 分页 / 实时）。
  索引断掉时**退到结果首行**并标 `data-summary-source="result"`——绝不编一个命令出来；
- 失败行取**结果首行**并标红（DSH 的 `errorSummary`）；
- **折叠 ≠ 不渲染**：正文用 `hidden="until-found"` + `beforematch` 留在 DOM 里，
  Ctrl+F 能搜到、读屏与复制拿得到（本仓纪律，规矩 21）。DSH 是在**分组**层做这件事
  （`useSearchableHidden`），Piggy 没有分组层，就把它下沉到行——这是**有意差异**，
  也意味着折叠时 shiki 不会白跑（`IntersectionObserver` 见不到隐藏元素）。

实测（真浏览器，同一段 3 轮 / 9 个工具的会话）：单行 **24px**、连续三行 **72px**；
改之前一个 6 行 `read` 结果占 **258px**、3 行 `bash` 占 **201px**（每块还带 16px 上下外边距）。
门禁 `ui:startup` 的 `compact` 段把这些数字钉住（行高 ≤26、三行 ≤76、折叠时正文仍在 DOM
里且 `display:none`、点开出现代码卡片、再点收起）。

**什么**是这块卡片：`inferToolLang()` 按内容认 diff、按 toolName 认 shell，其余纯文本 ——
三者都拿到折叠 / 行数 / 复制 / 超高展开。已知缺口：pi 的 toolResult **不含路径**
（真机取样只有 `toolCallId/toolName/content/details/isError`），所以 `read`/`write` 的结果
没法按文件扩展名选语言，只能保持纯文本（不瞎猜颜色）。

**标题栏**：左侧语言（或 toolName）+ 行数 + 高亮状态，右侧折叠 + 复制（各 24×24）。

### 5.3 特化内容

| 内容 | 渲染 |
|---|---|
| edit 工具 `details.diff` | 卡片内自绘轻量行级 diff（不实例化 Monaco）；点击展开 Monaco DiffEditor 预览 tab（10 §2.1） |
| 图片（ImageContent/附件） | asset 协议 URL（非 data URI，05 §5）；点击灯箱 |
| 文件路径（工具输出中的路径模式） | 可点击 → 只读预览（调 Rust 读文件，限定 tab 项目 cwd 内） |
| bash 输出 | 等宽 + ANSI 基础色（轻量转换，非完整终端仿真） |

## 6. antd 使用规范与主题（v6）

- **版本**：antd **6.x（≥6.6）** + `@ant-design/icons` **v6 配套**（icons@6 与 antd@6 必须成对升级）；**不再需要** `@ant-design/v5-patch-for-react-19`（v6 原生支持 React 19）；
- **主题机制**：v6 **默认纯 CSS 变量模式**（无需显式 `cssVar:true`）；单主题应用设 `hashed:false` 关闭样式散列；深浅切换 = 换 token 集，无组件重挂载；**M0 已实现暗/亮双主题切换**（`data-theme` + antd algorithm + `--pg-*` 变量集，uiStore 持久化）；VS Code 主题文件派生的完整管线 = M1（10 §2.4 一份四吃）；
- **VS Code 形态覆写（冲突时以此为准）**：antd 全部 design token 由 VS Code 主题 JSON 派生（10 §2.4）——密度（紧凑 size）、圆角（borderRadius 2–4px）、去投影、字体（13px system-ui / mono）、focus ring（VS Code 风格 outline）；**token 调不平的场景改自研件**（已有：TabStrip/ViewRail/StatusBar/CommandPalette/Transcript 均为 antd-free）；
- **GPU 纪律**：Modal/Drawer 的 mask blur 保持关闭（v6.3+ 默认已关，禁止显式开启；05 §5）；不用 antd `Splitter`（布局统一 dockview + react-resizable-panels，避免第二套分割系统）；
- **允许 antd 的区域**：SideBarHost/RightBarHost 信息视图（Tree/Table 等）、Dialogs（Extension UI 弹窗）、Settings/Keymap/Fleet 工具 tab、通知；**禁止区域**：Transcript 消息子树、TabStrip、ViewRail、StatusBar、CommandPalette（§2 铁律）；
- 按需引入：v6 ESM tree-shaking 自然覆盖；不引 pro-components；实现注意：v6 部分组件 `size="middle"` 改名 `"medium"`、List 已弃用（新 Listy）。

## 7. 输入区（Composer）

- 多行自动增高（上限 12 行）；`Enter` 发送 / `Shift+Enter` 换行 / `Cmd+Enter` 流式中强制 steer（07 §3 冲突策略）；
- 斜杠命令：`/` 触发自动补全（`get_commands` 数据 + 内建 GUI 命令混排，标注来源 extension/prompt/skill/内建）。
  **内建命令表在 Piggy 侧**（`lib/slashCommands.ts`，03 §3.0c）：pi 的 `get_commands` **只返回扩展/prompt/skill**，
  它自己那 24 条内建命令不在协议里，所以 `/compact` 这类必须由界面补上——
  选中「内建」且不需要参数的命令**立即执行**（走 `pi_compact` 等已有路径），需要参数的插入 `/name ` 等用户补；
  扩展/prompt/skill 命令仍然插入名字后**发给 pi 解析**（Piggy 不重复实现）。
  提交（Enter / 发送按钮）时先按指令拦一道（`isKnownSlashCommand` → `dispatchSlashInput`），
  **只有认得的才拦**——否则用户发一条以 `/` 开头的路径会被误吞；
  流式中 Enter 依旧不发送普通消息，但**内建指令仍可用**（它是客户端调用，不是插进回合的消息）。
  **列表行为**（2026-09-23 按用户反馈修正）：匹配项**全部渲染进 DOM**，容器固定可见高度
  （`max-height: 260px`）并 `overflow-y: auto` —— 「看得见的条数」是 CSS 的事，**不能**在数据层
  用 `slice` 硬截断。旧实现 `.slice(0, 8)` + `overflow: hidden` + ↑↓ 被 `preventDefault` 掉却不做事，
  装 pi-subagents 后命令涨到 50+ 条，第 9 条以后既看不到也够不着（用户截图反馈"无法滚动"）。
  键盘：`↑`/`↓` 环绕移动选中项并自动滚进视野、`Enter`/`Tab` 应用选中项、`Esc` 关闭、悬停即选中；
  `pi_get_commands` 是异步的，到达后要按当前输入重算一次，否则第一轮 `/` 永远显示空列表；
  真滚动由 `ui:startup` 在浏览器里断言（行数 / `scrollHeight>clientHeight` / `scrollTop` 真的变了 /
  滚到底最后一条落在可视区内）—— jsdom 测不了滚动（`scrollHeight` 恒为 0）；
- 图片：粘贴/拖拽/选择，缩略图 chips，经 Rust 读文件 → base64 → `prompt.images`（尺寸与 mime 校验，超过 provider 限制前置拦截）；
- 流式中输入：输入区常开，发送按钮变为"Steer / Follow-up"二选一（协议语义可视化，02 §7.2）；
- 队列 chips：`queue_update` 呈现，单条撤回 = `clear_queue` 后重排剩余。

## 8. 可访问性与国际化

- 全部交互可达键盘（07）；焦点环可见；`aria-live=polite` 用于流式状态摘要（非逐 token）；
- 文案 i18n：`zh-CN` 为源语言，`en-US` 次之；语言包懒加载（非阻塞首屏）。

## 9. 前端性能红线（评审清单）

1. 消息子树无 antd、无未虚拟化的长列表；
2. 任何 `pi:frame` 处理路径无 React setState；
3. 动画只允许 `transform`/`opacity`；禁止 layout 属性动画与大面积 `backdrop-filter`；
4. Markdown 只在转正时解析一次；禁止对流式文本跑完整 parser；
5. 图片一律 asset 协议；禁止 base64 data URI 进 DOM；
6. 新全局监听必须有卸载清理（lint 强制）；
违反任一条 = PR 阻断（08 §4 质量门）。
