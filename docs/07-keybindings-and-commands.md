# 07 · 快捷键体系与命令面板

> 上游：[04-frontend-design.md](04-frontend-design.md) · 关联：[03-module-design.md](03-module-design.md) §3.8

设计目标（00 G6）：**任何 GUI 操作都有键盘等价物**；键位可自定义、可冲突检测；与 pi TUI 的肌肉记忆尽量兼容。

## 1. 架构：命令注册表为中心

```mermaid
flowchart LR
    REG[CommandRegistry<br/>id → {title, run, when, defaultKeys[], category}]
    PAL[CommandPalette<br/>Cmd+K · 模糊搜索]
    KEY[KeymapService<br/>chord → commandId · 用户覆盖]
    GS[tauri-plugin-global-shortcut<br/>OS 全局（唤起等）]
    KEY -->|keydown 匹配| REG
    PAL --> REG
    CFG[settings/app.rs<br/>键位持久化] --> KEY
    REG -->|执行| ACT[UI 动作]
```

- **单一事实源**：所有可执行动作先注册为命令（id 如 `chat.send`、`session.fork`），快捷键与面板都只是命令的入口；
- **作用域（when 子句）**：命令声明可用上下文（`chat:streaming` / `palette:open` / `settings:visible`…），键位分发按当前活动作用域路由，天然消解大部分冲突；
- **Chord 支持**：单键组合（`Cmd+K`）与序列键（`g g` 类 vim 风格，预留）；
- 键位持久化在 Piggy 自有配置（03 §2.10 `app.rs`），导出/导入 JSON。

## 2. 默认键位表（v1）

### 2.1 全局（应用内任意处）

| 键 | 命令 | 说明 |
|---|---|---|
| `Cmd/Ctrl+K` | `palette.open` | 命令面板（万能入口） |
| `Cmd/Ctrl+,` | `settings.open` | 设置 |
| `Cmd/Ctrl+N` | `session.new` | 新会话 |
| `Cmd/Ctrl+W` | `tab.close` | 关闭标签（worker 优雅退出） |
| `Cmd/Ctrl+1..9` | `tab.switch(n)` | 切换标签 |
| `Cmd/Ctrl+Shift+F` | `session.search` | 会话/项目搜索 |
| `Cmd/Ctrl+B` / `Cmd/Ctrl+\` | `sidebar.toggle` / `rightpanel.toggle` | 侧栏 / 右栏 |
| `Cmd/Ctrl+J` | `panel.toggle` | 底部面板（终端/输出，VS Code 习惯） |
| ``Ctrl+` `` | `panel.terminal` | 直达终端面板 |
| `Cmd/Ctrl+Shift+E` | `view.files` | 右栏·文件视图（VS Code 习惯） |
| `Cmd/Ctrl+Shift+A` | `view.subagents` | 右栏·子代理视图 |
| `Cmd/Ctrl+K Z` | `layout.zen` | 专注模式（chord，04 §1.8） |
| `Cmd/Ctrl+?` 或 `Cmd/Ctrl+/` | `help.shortcuts` | 快捷键速查（可交互改键） |
| `Cmd/Ctrl+Shift+P`（OS 全局） | `app.summon` | 系统级唤起窗口（global-shortcut，可在设置关） |

### 2.2 会话视图

| 键 | 命令 | 说明 |
|---|---|---|
| `Enter` | `chat.send` | 发送（多行时仅最终行？否——Enter 恒发送，见 §3） |
| `Shift+Enter` | `composer.newline` | 换行 |
| `Cmd/Ctrl+Enter` | `chat.queueAsSteer` | 流式中：作为 steer 排队；非流式等同发送 |
| `Cmd/Ctrl+Shift+Enter` | `chat.queueAsFollowUp` | 作为 follow-up 排队 |
| `Esc` | `chat.abortAndRestore` | `clear_queue`→回填文本→`abort`（02 §7.3） |
| `Cmd/Ctrl+.` | `chat.abort` | 直接中断 |
| `Cmd/Ctrl+L` | `model.pick` | 模型选择器（对齐 pi TUI Ctrl+L 习惯） |
| `Cmd/Ctrl+P` | `model.cycle` | 循环切换（对齐 pi） |
| `Cmd/Ctrl+E` | `thinking.cycle` | 循环 thinking 级别（pi 习惯为 Ctrl+E 展开/折叠工具，GUI 中改为 thinking；可在设置换绑回 `tools.toggleExpand`） |
| `Cmd/Ctrl+R` | `session.rename` | 重命名 |
| `Cmd/Ctrl+Shift+K` | `session.compact` | 手动压缩 |
| `Cmd/Ctrl+G` | `session.tree` | 打开会话树（右栏聚焦） |
| `Cmd/Ctrl+Shift+B` | `session.branch-here` | 从选中消息 fork |
| `Cmd/Ctrl+J` | `terminal.toggle` | bash 直执行面板 |

### 2.3 转录导航

| 键 | 命令 |
|---|---|
| `g g` / `G` | `transcript.top` / `transcript.bottom` |
| `j/k`（转录聚焦时） | 行移动 |
| `Cmd/Ctrl+↑/↓` | 回合级跳转 |
| `Space`（选中工具卡片） | 展开/折叠 |
| `Cmd/Ctrl+F` | 转录内搜索（虚拟化兼容实现：命中行强制纳入窗口） |

### 2.4 与 pi TUI 的兼容策略

pi TUI 的 Ctrl+X 系（复制）、Ctrl+D（删会话）等因终端环境差异不搬移；Ctrl+L/Ctrl+P 保持语义对应（模型）。差异在 `help.shortcuts` 页并排展示。

## 3. 键位冲突与裁决规则

1. **作用域优先**：`palette:open` 时几乎所有键被面板劫持（仅 Esc/Enter/Arrow 放行）；
2. **流式状态独占**：`chat:streaming` 时 Enter 提示改用 `Cmd+Enter`（协议要求 streamingBehavior，02 §7.2）——UI 常驻微型提示，不弹窗打扰；
3. **自定义冲突检测**：改键界面实时显示目标 chord 的占用（命令名 + 作用域），允许"抢占"并给被抢命令标黄（无键提示）；
4. **保留字**：`Cmd+K`（面板）、`Cmd+W`（系统）、输入法键一律不可绑定；
5. **平台差异**：macOS `Cmd` / Win&Linux `Ctrl` 基准；`Alt` 修饰保留给用户自定义。

## 4. 命令面板（palette）

- 数据源 = CommandRegistry 全集 + 动态项（会话列表、模型列表、`get_commands` 的 `/xxx` 命令、Fleet 模板）；
- 分组：最近使用（持久化 20 条）· 当前上下文 · 会话 · 导航 · 设置 · 扩展命令；
- 搜索：子序列模糊匹配 + 拼音首字母（zh 场景）+ 命令别名（`model` ↔ `模型`）；
- 面板本身 antd-free（高频组件，自研轻量列表 + 虚拟化，遵循 04 §2 边界精神）；
- `>` 前缀进入"原始命令模式"：直接把输入作为 `/extension-command` 经 `prompt` 发送（对应 `get_commands` 的扩展/技能/模板命令，02 §3.2 表末行）。

## 5. 可达性要求

- 每个面板/弹窗打开即自动聚焦首交互元素；Esc 关闭顺序 = 弹窗 → 面板 → 面板入口；
- 焦点环永远可见（主题变量控制），Tab 顺序符合 DOM 顺序；
- 所有快捷键动作可从面板按名称执行（即"无键也可用"原则，保证可发现性）。
