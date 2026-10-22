# 权限档位与 pi 打包

本文回答两件事：**权限档位是怎么落地的**（Composer 工具行左侧那个选择器），
以及**用自定义 pi 打包时配置项与插件怎么处理**。
配置来源的源码级细节见 `docs/16-pi-config-and-extensions.md`。

---

## 1. 权限档位

### 1.1 为什么不是"加个字段"那么简单

pi **没有权限模型**。它只有两个原语，而且都只能在**启动时**决定：

| 原语 | 作用 | 依据 |
|------|------|------|
| `--tools <list>` | 内置/扩展/自定义工具的**总白名单** | `cli/args.ts:147`；过滤 `core/sdk.ts:260-266` |
| `-e <path>` 扩展钩子 | 可在工具执行前 `block` | `core/extensions/types.ts:1217`；消费 `core/extensions/runner.ts:1133-1150` |

RPC 里**没有**运行期改工具的接口 —— `modes/rpc/rpc-mode.ts` 的 case 列表里不存在
`set_tools` / `set_config` / `reload` 之类（`grep -rn "set_config\|set_tools" packages/coding-agent/src` 无结果）。
所以：**切换档位 = 带同一会话文件重启 worker**。

另一件必须知道的事：**pi 的 `write`/`edit` 没有工作区边界检查**。
`core/tools/path-utils.ts` 的 `resolveToCwd()` 只做 `~` 展开与相对/绝对路径规整，
`write` 的入参描述就是 "Path to the file to write (relative or absolute)"，绝对路径直接落盘。
因此"工作区内修改"**不能**只靠 `--tools read,grep,find,ls,write,edit` 成立 ——
那只是拿掉了 shell，写文件仍然可以去任何地方。

### 1.2 三个档位的真实定义

| 档位 | `--tools` | 守卫扩展 | MCP | 实际能做什么 |
|------|-----------|----------|-----|--------------|
| **仅可查看** | `read,grep,find,ls` | 不注入 | `--no-mcp` | 只有只读工具，没有写、没有 shell；不拉起 MCP 服务器 |
| **工作区内修改**（默认） | `read,grep,find,ls,write,edit` | 注入 | `--no-mcp` | 可读写文件，写入被守卫限制在会话 cwd 内；**无 shell** |
| **完全权限** | **不传** | 不注入 | 不传（用你自己的配置） | 不限制：含 `bash`/`powershell` 与扩展/自定义工具 |

**为什么限制档要显式 `--no-mcp`**（2026-10-09，pi 1.1.0 实测）：pi 1.1.0 的 MCP 过滤判据是
"白名单里有没有 `mcp__` 前缀的名字"（`core/agent-session.ts` 的 `_allowlistFiltersMcp`），
所以 `--tools read,grep,find,ls` 之下**用户的 MCP 服务器照样被拉起**（stdio stub 实测被 spawn）。
工具本身不会声明给模型（它们要走 `tool_search`/`codemode`，而那两个也被白名单过滤掉了，
pi 自己会回一句 "MCP tools are only reachable from the codemode or tool_search tool"），
但"限制档去启动本地进程 / 打开网络出口"与这一档对用户的承诺不符 ——
**"我不给模型这个工具"和"我不启动这个东西"是两件事**。

「完全权限」刻意**不传** `--tools`：一旦传显式白名单，pi 会把**扩展与自定义工具一并过滤掉**
（`cli/args.ts:307-308` 帮助文本明说 "Applies to built-in, extension, and custom tools"）。
不传 = 不限制，这才是"完全权限"该有的语义，也是自定义 pi 场景下插件工具能用的唯一档位。

实现：`apps/desktop/src-tauri/src/pi/permission.rs`（档位矩阵与单测）、
`resources/piggy-guard.js`（守卫扩展）、`pi/process.rs::spawn_worker`（拼参数）。

### 1.3 守卫扩展（`resources/piggy-guard.js`）

- 挂 `tool_call` 钩子，只拦 `write` / `edit`；越界返回 `{ block: true, reason }`。
- 白名单根从环境变量 `PIGGY_GUARD_ROOTS` 读（Piggy 传会话 cwd），**变量缺失时拒绝一切写入**（fail-closed）。
- 路径比较前先 `realpath`，**穿透符号链接** —— 否则 `workspace/link -> /etc` 能骗过前缀判断。
  目标不存在（新建文件）时向上找第一个存在的祖先再拼回尾段。
- 边界比较按**路径段**而不是字符前缀，`/work-other` 不会被误判进 `/work`。

两个失败模式都指向同一个原则：**宁可挡住，不可静默放开**。

- 脚本找不到时 `spawn_worker` 直接返回 `GUARD_SCRIPT_MISSING` 而**不降级**启动
  （pi 自己加载扩展失败只是打印一行 + 提示 `-ne`，然后**继续跑** —— 已实测确认）。
- 守卫内部处理器抛异常时 pi 也会阻止执行（`agent-session.ts:548` `Extension failed, blocking execution`）。

### 1.4 切档为什么要重启

`--tools`/`-e` 是 CLI 参数。切档走的是**和崩溃复活完全相同**的路径
（`sessions/registry.rs::set_permission_unlocked` → `revive_unlocked`）：停旧进程 →
按新档 spawn → 必要时 `switch_session` → `get_entries(since=cursor)` 游标补齐 → 发 `resync`。
会话文件与游标不变，所以对话内容不丢。

整条路径**不持 registry 锁**：复活要握手（冷启动预算 40s），握着全局锁做这件事会让
所有标签页一起等（2026-10-09 复查修；契约用例 C15 量这条）。

流式中拒绝切档（会打断回合，且用户看不出"前半段一个档、后半段另一个档"）。
换档不占崩溃重启预算（`restarts` 归零）。

### 1.5 默认值与持久化

- 新标签页继承 `~/.piggy/config.json` 的 `permission_mode`，默认 `workspace`。
- 在某个标签页切档，会同时把它记为**新标签页的默认值**并落盘。
- 非法档位值**直接报错**，不静默回落到更宽松的一档。

顺带修掉的：`perf_config_save` 原本从零构造 `PerfConfig` 再整写 `config.json`，
加了 `permission_mode` 之后，"在设置里改并发数"会顺手把权限档位重置。已改成读-改-写。

---

## 2. 用自定义 pi 打包

### 2.1 运行期：三种来源，默认系统 pi

设置页「运行」页签里选（持久化在 `~/.piggy/config.json` 的 `pi_source` / `pi_path`）：

| 来源 | 取值顺序 | 适用 |
|------|----------|------|
| **`system`（默认）** | `PATH`（Windows 上按 `PATHEXT` 试 `pi.exe/pi.cmd/…`，见下）→ 常见安装位置（macOS/Linux：`~/.local/bin`、`/usr/local/bin`、`/opt/homebrew/bin`、`~/Library/pnpm/bin`、`~/.cargo/bin`；Windows：`%LOCALAPPDATA%\pnpm`、`%APPDATA%\npm`、`~/.local/bin`、`~/scoop/shims`）→ **回退到捆绑** | 本机已装 pi，跟着 `pi update` 走 |
| `bundled` | 应用包内 `resources/pi/pi` | 用打包进来的自定义 pi |
| `custom` | 设置里填的绝对路径 | fork 出来的 pi，放在任意位置 |

**默认必须是系统 pi**：安装包虽然捆绑自定义 pi，但不该劫持用户机器上已有的安装。
反过来，`system` 档在系统没装 pi 时会**回退**到捆绑（并如实把来源报成 `bundled`），
免得"装了个包却完全用不了"。

**Windows 上"PATH 里有 pi"不等于"能执行 pi"**：npm/pnpm 会同时放一个无扩展名的 `pi`
（POSIX shell 脚本，给 Git Bash 用）和一个 `pi.cmd`。若把前者交给 `CreateProcess`，
报的是 `os error 193（不是有效的 Win32 应用程序）`——看起来像"pi 没装"，其实是选错了文件。
所以 Windows 上按 `PATHEXT` 生成候选、**无扩展名排最后且必须是真 PE**（详见 docs/03 §2.1）。

`PI_BIN` 环境变量**永远优先于以上三者**（运维/CI 的显式指令不该被界面默认值覆盖）；
生效时设置页会明确提示"被环境变量覆盖，界面选择当前不生效"。
（macOS 上 GUI 启动的 `.app` 拿不到 shell 环境变量，所以这条实际只适合开发/QA。）

三个档位都**不会静默回退到别的二进制**：要 `bundled` 而包内没有 → 报"这个是 lite SKU 未捆绑"，
而不是偷偷换成系统 pi；要 `custom` 而路径不存在 → 报出那个路径。
矩阵与回退行为在 `pi/discovery.rs` 的 `pick_source` 里，有 9 条单测穷举。

设置页同时显示**实际生效的那个二进制**（路径 + 版本 + 来源 + 怎么找到的）——
设置值不等于结果，必须让人看得见。

#### 2.1b 启动时补齐 `PATH`（`config/shell_env.rs`）——**打包产物专有的一课**

**2026-10-14 用户报障**：`pnpm tauri build` 打出来的 `.app` 双击启动，
界面上「系统 pi」起不来，日志是：

```
pi --version 失败: /Users/wxk/Library/pnpm/bin/pi: line 48: exec: node: not found
```

链路：macOS 从 Finder/Dock 启动的进程，环境来自 launchd 而**不是**终端 ——
`PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`。于是

1. pnpm/npm 装的 `pi` 是个 **`#!/bin/sh` + `exec node …` 的垫片**；
2. 发现链的「常见安装位置」兜底**找得到**这个垫片（所以界面上不是"pi 未找到"，
   而是"pi 明明在、就是跑不起来"——这一步最容易被误判成"用户没装 pi"）；
3. 但 nvm/homebrew/pnpm 的 bin 一个都不在 `PATH` 里 → 垫片里的 `exec node` 失败。

**修法**：启动时（`lib.rs::run` 的**第一件事**，早于 `discover()`）跑一次
`$SHELL -ilc '<哨兵>; env'`，把 shell 那套 `PATH` 并回进程环境；之后所有子进程
（pi worker、Fleet 的 `git`、插件 CLI、pty）都自动继承。

为什么要补 `PATH` 而不是"把 node 目录塞进发现链"：后者只让 pi 垫片找得到解释器，
pi 自己 `bash` 工具起的子进程仍然拿不到 `git`/`python`/用户自定义命令 ——
用户看到的是"会话能开，但 agent 的工具全报 command not found"。

护栏（都在 `config/shell_env.rs`，10 条单测）：

| 点 | 做法 | 为什么 |
|---|---|---|
| **必须 `-i`** | `-ilc` 而不是 `-lc` | macOS 上 `zsh -lc` 只读 `.zshenv` + `.zprofile`，而 nvm 之类通常写在 `.zshrc`（**只对交互式 shell 生效**）。少了 `-i` 就变成"补了个 PATH 但 node 还是没有" |
| **只认哨兵之后** | 输出里 `rfind(哨兵)` 之后的 `KEY=VALUE` 才算数 | rc 文件的横幅/警告会混进 stdout；哨兵用 `\x1f`，避免横幅恰好同形 |
| **有超时** | 5 s（`LOGIN_SHELL_TIMEOUT`），超时就杀子进程 | 交互式 rc 可能很慢（本机实测 0.5–0.9 s）或挂住；超时**只意味着没补上**，绝不阻断启动 |
| **stdin = null** | 子进程的标准输入立刻 EOF | rc 里若有 `read`，不给 EOF 就会挂到超时 |
| **只改 `PATH`** | 不 `env_clear`，也不接管其它变量 | 别把 `HOME`、代理变量冲掉；`Windows` 直接跳过（GUI 本就继承完整环境） |
| **不静默** | 启动日志必打一行（成功/跳过/失败都能看见） | 这一层失败的表现是"pi 起不来"，不写日志就只能靠猜 |

复现与排查：`PIGGY_NO_SHELL_ENV=1` 关掉这一层（对照实验），
`PIGGY_SHELL=/path/to/shell` 换一个 shell 来问。
门禁是 `login_shell_path_makes_a_node_shim_runnable`：**造一个真的 `exec node` 垫片**，
先用 Finder 那套 `PATH` 断言它报 `node: not found`（复现），再用补齐后的 `PATH`
断言 `pi --version` 真的跑出 `1.4.0`（修好了）。把 `-ilc` 改回 `-lc` 它必须变红 ——
已验证（红时报的就是用户那句 `exec: node: not found`）。

⚠️ 因此 `PI_BIN` 这条**仍然**只适合开发/QA：GUI 启动时它本来就传不进来
（`.app` 的环境来自 launchd），这一层补的是 `PATH`，不是把整个 shell 环境搬进来。

### 2.2 打包期：把你自己的 pi 放进安装包

| 方式 | 怎么做 | 适用 |
|------|--------|------|
| **`PI_STANDALONE_FILE`** | `PI_STANDALONE_FILE=~/my/pi-darwin-arm64.tar.gz node scripts/fetch-pi-standalone.mjs` | **推荐**：走完整打包链路，只换产物 |
| `PI_STANDALONE_URL` | 换成自己的 URL 模板（占位符 `{VERSION}` `{OS}` `{ARCH}` `{ASSET}`） | 有自建发布时 |

产物落位 `resources/pi/`，再由 `tauri.full.conf.json` 的 `resources/pi/**/*` 打进包。
内置路径由 `resource_dir()` 决定，布局见 `src-tauri/TAURI_FULL_SKU.md`。
打完包后在设置页选「捆绑 pi」即可启用。

### 2.2b 捆绑的 **pi 插件**（功能插件，和 pi 本身分开）

`resources/pi/` 装的是 **pi 自己**；`resources/pi-plugins/<name>/` 装的是**给模型用的功能插件**
（自研 `pi-ask` 结构化提问 + `/plan` 计划模式；收录的第三方 `pi-todo` 任务清单、
`pi-guardrails` 写前校验护栏）。区别与理由：

| | `piggy-guard.js` / `piggy-bridge.js` | `pi-plugins/<name>/` |
|---|---|---|
| 是什么 | Piggy 的基础设施（权限守卫、Fleet 数据面） | 可选功能，用户能关 |
| 形态 | 单文件脚本 | 目录（`piggy-plugin.json` + `index.js` + `lib.js`） |
| 注入 | `--extension <file>` | `--extension <dir>`（pi 的 `-e` 接受目录） |

**为什么捆绑而不是让用户 `pi install`**：目标机器上很可能**没有 node/npm**，而 pi 的包管理器
是 spawn 系统 `npm` 来装的（`package-manager.js`）。捆绑 + `-e` 不需要任何包管理器，
插件目录就是最终产物（plain ESM JS，不需要构建，也没有 npm 依赖）。

六条纪律（都有真机证据，`node apps/desktop/scripts/pi-plugin-probe.mjs` 可复现）：

1. **重复加载会让 pi 直接不进会话**：同名工具从两个不同路径注册时，pi 打印
   `Tool "ask_user_question" conflicts with …` 并**根本不建立会话**（同一个路径传两次
   pi 会自己去重，所以只需要挡"另一个路径的同名插件"）。
   因此 `pi/plugins.rs::resolve` 在注入前扫 pi 的发现目录（`~/.pi/agent/extensions`、
   `<cwd>/.pi/extensions`，含软链的 realpath 比较），发现同名就**不注入**并把原因报给界面
   （设置 › 通用 › 内置插件）。
   ⚠️ 2026-10-09 复查补的两条：① 生产的 spawn 路径以前把 `cwd` 写死成 `None`，
   于是**项目级**那一条一直瞎着（真机复现：`cd <项目> && pi -e <自带 pi-ask>` →
   `Tool "ask_user_question" conflicts with …` + 退出码 1 + stdout 零字节）；
   现在 `enabled_plugin_dirs(candidates, Some(cwd))` 一路带着会话 cwd，
   设置页读列表时也把当前会话的 cwd 传下去（否则界面会承诺一个 spawn 时做不到的事）。
   ② 失败已经发生时（pi 已经退出），`pi:state` 的 `stderrTail` 会被前端翻成一句可操作的
   提示（"两者留一个：删掉你自己装的那份，或到设置 › 通用 › 内置插件关掉 Piggy 这份"）。
2. **`--tools` 会把插件工具一起过滤掉**：pi 的帮助写着 "Applies to built-in, extension, and
   custom tools"，真机实测 `--tools read` 之下 `getAllTools()` 只剩 `["read"]`
   （插件的两个工具都没了）。所以限制档位拼白名单时，要把**这次真的注入了的**插件在
   `piggy-plugin.json` 里申报的工具名加进去（`pi/process.rs::cli_args`）。
3. **清单缺失/入口不存在就不注入**：pi 对"加载失败的扩展"的处理是报诊断并退出 ——
   宁可少一个功能，也不能让用户开不了会话。
4. **目录缺失要留在列表里、并说清是哪一种"没有"**（2026-10-09 补）：`lib.rs` 以前用
   `filter_map` 只传"存在的目录"，于是打包漏登记时插件从设置页**整个消失** ——
   用户只看得到"列表里没有它"。现在候选里保留 `dir: null` 的项，界面显示
   「这一份安装里没有这个目录（随包分发不完整：bundle.resources 没登记 resources/pi-plugins）」，
   与"设置里关掉了"是两句不同的话。同理，候选③（源码树）会在界面与启动日志里
   标成**开发态**：它是编译期烧进二进制的构建机绝对路径，打包产物里出现它就说明清单漏登记了。

5. **覆盖型插件的工具名不进 `--tools` 白名单**（2026-10-09 补）：白名单是权限档位的边界，
   而有一类插件注册的是**顶替 pi 内置工具**的扩展（收录的 `pi-guardrails` 顶替
   `write`/`edit` 加写前校验）。把 `write,edit` 并进「仅可查看」档的白名单 = **凭空把只读档变成可写档**，
   而当时的单测只钉静态常量、抓不到合并结果。规矩：清单里写 `"allowlist": false`
   （`pi/plugins.rs::Manifest::allowlist`，默认 true 保持老行为），
   `vendor-plugin.mjs` 对应 `--no-allowlist` 开关；两条闸门盯着它 ——
   `plugin-contract.test.ts`（申报了内置工具名就必须显式 allowlist:false）与
   `pi/process.rs` 的 argv 级用例（限制档的 `--tools` 里不许出现 write/edit）。

6. **目录必须登记进两个 SKU 的 `bundle.resources`，而且要用 `**/*`**（2026-10-09 补）：
   `pi-plugins/` 是 10-06 进来的，而资源清单里**从来没登记过它** → 打包产物零插件；
   更阴的是**在构建机上直接跑那个 `.app` 会看起来完全正常**（`pi/resources.rs` 的第三候选
   `CARGO_MANIFEST_DIR` 正好命中源码树），换台机器才消失。
   现在由两条闸门守着：`pi/plugins.rs::both_skus_register_the_plugin_directory`（rust 作业）
   与 `src/test/plugin-contract.test.ts`（frontend 作业）。
   `*` 不跨目录分隔符（glob crate），写成 `resources/pi-plugins/*` 会把 `pi-todo/src/*.ts` 全漏掉
   —— 与 `resources/pi/**/*` 是同一个坑（§3 第 6 条）。

### 2.2c 收录第三方插件（`scripts/vendor-plugin.mjs`）

随包的插件有两类：**自研**（`pi-ask`，就在本仓里，GPL-3.0-or-later）与**收录的第三方**
（今天一个：`pi-todo`，MIT，来自 `~/Project/pi-todo`）。收录走脚本，不手工复制：

```bash
node apps/desktop/scripts/vendor-plugin.mjs --from ~/Project/pi-todo --name pi-todo \
     --entry index.ts --tools todo_enable,todo_write --commands todos --title '任务清单（DSH 风格）'
node apps/desktop/scripts/vendor-plugin.mjs --check   # CI 跑这条：文件内容与 vendor.json 对不上就红
```

脚本钉住三件事：

1. **出处**：`vendor.json` 记来源路径、上游 commit、许可证与每个文件的 sha256；
2. **许可证**：上游必须有 `LICENSE*` 文件，或 `package.json` 里写了 SPDX（没有就**拒绝收录**）；
   没有 LICENSE 文件时按 SPDX 补一份正文（目前只支持 MIT —— 别的宁可人工补，不猜）；
3. **漂移**：`--check` 重算哈希。本地被就地改过、或忘了重跑收录，CI 都会红。

`--tools` / `--commands` **必须显式写**（脚本不给默认值）：清单里的工具名会被加进限制档位的
`--tools` 白名单，猜错就等于告诉模型"你有这个工具"而它并不存在。

收录完有两步收尾（脚本会提醒）：把名字加进 `config/app.rs::default_bundled_plugins()`、
跑一次 `node apps/desktop/scripts/pi-plugin-probe.mjs`（真 pi 能不能加载它），
以及确认新目录被两个 SKU 的 `bundle.resources` 的 `resources/pi-plugins/**/*` 覆盖（闸门会自动查）。
还要把许可证登记进 `THIRD_PARTY_NOTICES.md` 与 `legal.rs::THIRD_PARTY`
（两份互为金标，但**两边同缺时测试是绿的** —— pi-todo 就漏了三天，见 docs/15 规矩 134）。

#### pi-guardrails（覆盖型插件）—— **已收录**（2026-10-09）

它顶替 pi 的 `write`/`edit` 加写前校验（另有锁内 CAS、原子发布、空响应兜底、
bash 证据化、重复调用提醒）。作者自研，`Copyright (c) 2026 wxk6b1203`，MIT。

收录时的两步（都是**前置条件**，不是可选项）：

1. 上游先补一个 `LICENSE` 文件（原来只有 `package.json` 的 SPDX）。
   否则 `vendor-plugin.mjs` 只能补一份**版权人是占位符**的 MIT 正文 ——
   署名义务实质上没被履行（这次的 LICENSE 由作者提供，版权人写实）。
   ⚠️ 顺带修了脚本一处：有 LICENSE 文件时以前会把 SPDX 丢掉（清单里显示"见 LICENSE"），
   现在文件优先、SPDX 仍作为标签，两者不一致时以文件为准并打印提醒。
2. 收录必须带 **`--no-allowlist`**：它的工具名是 pi 的内置 `write`/`edit`，
   进了白名单就等于把限制档变成可写档（§2.2b 纪律 5）。

**它与 Piggy 自己的路径守卫不冲突**（这条读源码确认过，另有真机断言）：
`piggy-guard.js` 挂的是 **`tool_call` 钩子**，由 pi 的会话层在 `beforeToolCall` 里
**按工具名**触发（`core/agent-session.ts::_beforeToolCall`），与"这个工具是谁注册的"无关；
而注入顺序保证守卫先注册、先判定（`process.rs::cli_args`：守卫 → 桥接 → 捆绑插件）。
真机探针里有组合断言：守卫 + pi-guardrails + `--tools read,grep,find,ls` →
`getAllTools()` 里**没有** `write`/`edit`；不传 `--tools`（完全权限）→ 两个都在。

**行为层的组合验证**（`pnpm --filter @piggy/desktop pi:guard-combo`，即
`node apps/desktop/scripts/guard-combo-probe.mjs`；三次极小模型调用，所以是诊断脚本、不进 CI）：

| 回合 | 期望 | 断言的是"拦截真的发生了" |
|---|---|---|
| 往工作区**外面**写 | 路径守卫拦 | 事件流里有一条对该路径的拒绝、理由含 `在工作区之外`（终态：文件仍是原内容） |
| 改工作区内**已存在但没读过**的文件 | pi-guardrails 拦 | 事件流里有一条对该文件的拒绝、理由含 `file has not been read`（终态只作辅助） |
| 在工作区内**新建**文件 | 放行 | 调用没被拒 + 文件真建出来了（反向断言 —— 免得上面两条"永远绿"） |

⚠️ **判据必须是"那次调用被拒了、理由是哪个护栏"，不能是"文件最终没变"**。
这条踩过两次（2026-10-09 第一版、2026-10-13 又漏了一处）：被拦之后模型常常自己 `read`
一次再重试（那正是拦截文案建议的修复动作），文件**合法地**变成了新内容 —— 拦也拦了却判红；
反过来模型没调工具时文件也没变 —— 没拦却判绿。两种情况的终态完全同形。
**能区分"机制失效"与"机制生效、后续被合规地完成"的那个量，才配当结论**；
终态一律降级为辅助证据（脚本里仍然打印，并附"拦后才读过=是/否"）。
现在读 `--mode json` 的事件流（`tool_execution_start` 带 `args`、`tool_execution_end` 带 `isError`
与结果文案；两者靠 `toolCallId` 关联），并做了**反向验证**：把两个 `-e` 都摘掉后重跑，
①② 如期变红（`outside/x.txt="HACKED"`）而 ③ 仍绿 —— 这才证明这三条不是"永远绿"。

⚠️ 本机跑这个脚本要带 `-ne`：`~/.pi/agent/extensions/pi-guardrails` 与随包那份同名，
pi 会因工具名冲突**直接退出** —— 而 Piggy 自己会跳过自带那份（`pi/plugins.rs::existing_install`），
所以这不是产品 bug，是脚本要自己处理的现场（`pi --help` 明说 `-ne` 只关发现，显式 `-e` 不受影响）。

契约测试（`src/test/plugin-contract.test.ts`）会对**每一个**随包插件核对：入口存在、
有 LICENSE、`vendor.json` 的哈希对得上、不依赖 npm 包。

设置页那一块（`features/settings/BundledPluginsRow.tsx`）显示每个内置插件的名字、说明、
申报的工具与命令、许可证、目录，以及**这次装不装 / 为什么不装**。它不在 pi 自己的
"插件"页里，因为那一页扫的是 pi 的发现目录，`-e` 注入的东西天然不在其中。

### 2.2d 写边界必须**每次调用现算**（2026-10-10 修）

`piggy-guard.js` 是「工作区内修改」档**唯一**的边界执行点。它的边界原本读
`PIGGY_GUARD_ROOTS` —— 而那是 Piggy 在 **spawn 那一刻**注入的（`pi/process.rs`），
于是踩到一个静默越界：**会话的 cwd 可以在同一个进程里变**（当时的触发场景是预热 worker
被复用去开别的项目的会话；预热池已在 2026-10-13 删除，见 docs/05 §5.7，
但 `switch_session` —— 崩溃复活与切权限档位重启都走它 —— 照样会改会话 cwd），
而 `switch_session` 改的是**会话 cwd**、**不改进程环境** ⇒ 同一个进程里的会话切到项目 B 之后，
写边界仍停在项目 A：**写 B 被拦、写 A 反而放行**（两个方向都错）。

修法与判据：

- 边界 = **会话自己的工作目录**：`ctx.sessionManager.getCwd()`（每次 `tool_call` 现算），
  `PIGGY_GUARD_ROOTS` 降级为**兜底**，两者都没有则 fail-closed（拒绝一切写入）；
- ⚠️ **不能**用 `ctx.cwd`：那在 pi 里是**冻结值**（`runner.js` 构造时赋值一次，
  `createContext()` 只是读出来），`switch_session` 之后不会变 —— 用它等于换了个名字踩同一个坑；
  `sessionManager` 才是活的（pi 自己也用它建会话上下文：`agent-session.js` 的 `getCwd()`）；
- 真机验证：进程在 A 起、会话 cwd 是 B → 守卫算出的边界是 `["…/projB"]`，
  写 A 的**绝对路径**被拒（理由里写明"只允许改动 …/projB"），写 B 正常放行；
- 单测在 `src/test/permission-guard.test.ts`：除纯函数 `boundaryFor` 外，**入口那条必须有**
  —— 反向验证时把守卫改回"加载时算一次"，`boundaryFor` 的用例**照样全绿**，
  只有入口那条变红。**"逻辑对"不等于"接线对"。**

### 2.3 必须保持的契约

自定义 pi 只要满足这些，Piggy 就能驱动它（除此之外**没有任何版本协商**）：

- `pi --version` 退出码 0（只验退出码，不做 semver 比较）
- `--mode rpc` 的 JSONL 分帧：一条命令一行，`{type, id}` 且 `id` 是**字符串**
- `pi/client.rs` 用到的那批 RPC 命令
- 响应信封 `{type:"response", id, command, success, data|error}`
- `get_state.sessionFile` / `get_state.sessionId`、`get_entries.leafId`
- `pi/protocol.rs` 里匹配的那批事件 `type` 字面量

### 2.4 配置项：pi 从哪读

优先级（`docs/16` §7 有完整展开）：

```
CLI 参数  >  环境变量  >  项目 .pi/settings.json  >  全局 ~/.pi/agent/settings.json  >  代码默认值
```

- **全局 agent 目录**：`~/.pi/agent/`，放 `settings.json` / `auth.json` / `models.json` /
  `keybindings.json` / `trust.json` / `SYSTEM.md` / `extensions/` / `skills/` / `prompts/` / `themes/` / `sessions/`。
  可用 `PI_CODING_AGENT_DIR` 整体改道。
- **项目目录**：`<cwd>/.pi/`，同名文件深合并覆盖全局，**但只在项目被信任时加载**
  （`settings-manager.ts:410`；信任状态存 `<agent-dir>/trust.json`）。
- **`AGENTS.md` / `CLAUDE.md` 在 `.pi/` 之外**，且**不受信任门控**。
- **没有 `--config` 参数**，也没有任何 RPC 能改这些路径。`pi config` 是 TUI 子命令。
- RPC 的 `set_model` / `set_thinking_level` 等**只改会话内存，不落盘**
  （`agent-session.ts:2127` 只在 `persist: true` 时写 settings，RPC 不传）。

#### Piggy 侧的两个已知硬编码（自定义 pi 的注意点）

1. **配置目录硬编码在 Rust 里**：`config/pi_files.rs::agent_dir()` 拼的是 `$HOME/.pi/agent`，
   且 spawn 时**不传** `PI_CODING_AGENT_DIR`。若你的 fork 改了
   `package.json` 的 `piConfig.configDir`（比如 `.pi2`），Piggy 的设置/认证/模型面板与侧栏会话列表
   都会指向**另一个目录**。`pi_source=system` 时这通常不是问题（系统装的就是标准 pi），
   但换自定义构建时要注意。目前没有设置项能改配置目录——需要的话得先加 `PI_CODING_AGENT_DIR` 透传。
2. **`PI_BIN` 在 macOS GUI 启动时拿不到**：`.app` 的环境来自 launchd 而非 shell
   （§2.1b 补的是 `PATH`，不是把整个 shell 环境搬进进程）。
   要固定用自带/自定义二进制，走 §2.1 的打包路径，别依赖环境变量。

### 2.5 插件（pi 里叫 **extension**）

- 加载**与运行模式无关**：RPC 模式下扩展照常加载
  （`main.ts:930` 才进 `runRpcMode`，扩展在此之前已 `resourceLoader.reload()`）。
- 发现顺序：CLI `-e` 路径 → 项目 `.pi/extensions/` → 全局 `<agent-dir>/extensions/` → `settings.packages` 声明的包。
  目录扫描只认一层 `*.ts` / `*.js` / `index.ts` / `index.js`。
- 包通过 `package.json` 的 `pi` 字段声明资源：`{ "pi": { "extensions": [...], "skills": [...], "prompts": [...], "themes": [...] } }`。
- 扩展入口：`export default function (pi: ExtensionAPI) {}`，可 `on(<36 种事件>)`、`registerTool`、
  `registerCommand`、`registerFlag`、`registerProvider`。
- **MCP：0.87 时代 pi 没有 MCP；1.1.0 起有了**（内置 `mcp` 扩展 + `--no-mcp` 开关，
  工具以 `mcp__*` 名字出现，且只能经 `tool_search`/`codemode` 触达）。
  Piggy 在**限制档**显式关掉它（见 §1.2），完全权限档留给用户自己的配置。
  用户自己的 MCP 配置读 `<agent-dir>/mcp.json` 与项目 `.pi/mcp.json`。
- `get_commands`（Composer 的 `/` 补全）只有三个来源：extension、prompt 模板、skill。
  **内置 TUI 斜杠命令不在其中。**
- ⚠️ **`--tools` 会连插件工具一起过滤。** 默认档位是「工作区内修改」，
  所以自定义 pi 带的扩展工具默认**不可见**；要用插件工具得把该标签页切到「完全权限」。

### 2.6 打包 standalone 的两个坑（已修）

1. **资产名拼错**：脚本原本请求 `pi-standalone-{TRIPLE}.{EXT}`，这个资产**不存在**（永远 404）。
   真实命名是 `pi-{os}-{arch}.{ext}`，os ∈ `darwin|linux|windows`
   （已用 `GET /repos/earendil-works/pi/releases/latest` 核对实际资产清单）。另外
   `process.platform` 在 Windows 上是 `win32` 而资产里写 `windows`，需要映射。
2. **只留二进制**：pi 是 Bun 单文件可执行，资源按 `dirname(process.execPath)` 解析
   （`config.ts:396-399`）。`export-html/`、`theme/`、`package.json`、`photon_rs_bg.wasm`
   都必须跟二进制放一起，否则 `pi_export_html` 会在 full SKU 里**抛异常**
   （`core/export-html/index.ts:143` 是无保护的 `readFileSync`），版本号也会变成 `0.0.0`。

现在脚本按真实命名下载、校验（显式 `PI_SHA256` → release 的 `SHA256SUMS` → 警告）、
并把**整包**解到 `resources/pi/`；`tauri.full.conf.json` 用 `resources/pi/**/*` 收全部子目录。

### 2.7 许可：full SKU 是在**再分发 pi**

捆绑 pi 不是"用了一个依赖"，而是**把别人的作品放进自己的安装包分发**。pi 是 MIT
（`Copyright (c) 2025 Mario Zechner`），MIT 的义务是"版权声明与许可声明随所有副本一起给"，
所以：

- `src-tauri/resources/pi-LICENSE.txt` 是 pi 许可原文的副本（正文逐字节一致，
  sha256 `0457f5bc…`），登记在**两个** SKU 的 `bundle.resources` 里；
- **不要指望 pi 的 release 资产自带许可**：`installAssets()` 只保证"二进制之外的文件按原
  结构拷过来"，而包里有没有 `LICENSE` 是上游的打包细节、随时会变——义务在分发方这边；
- Piggy 自己是 GPL-3.0-or-later（`LICENSE` + 各 manifest 的 `license` 字段 + README）。
  MIT 与 GPLv3 兼容，但**署名不能省**，且分发安装包时须一并提供 Piggy 的完整源码。

这几条一致性由 `apps/desktop/src/test/license.test.ts` 锁住（漏一个 `license` 字段、
把那张纸从资源清单里删掉、或者"顺手润色" LICENSE 都会被它拦下）。

**界面层**（GPL §5(d) 要求"有交互界面的作品都要显示"）：系统菜单 macOS 上是
App 菜单「关于」正下方一条「许可与第三方声明」，其它平台在 Help；点它打开
应用内的「关于 Piggy 与许可」对话框（另有两个入口：命令面板、侧栏版本号），
里面有版权行、无担保声明、指向 gnu.org 的链接、第三方组件表和 **GPLv3 全文**。
原生「关于」面板显示的是 `bundle.copyright`（两个 SKU 都设了）。
细节见 docs/03 §2.17 与 docs/04 §2.5。

---

## 3. 本轮修掉的缺陷（都带证据）

| # | 缺陷 | 影响 | 证据 |
|---|------|------|------|
| 1 | `auth.json` 写的是 `api_key` 字段，pi 读的是 `key` | **设置里填的 API Key pi 从不使用**，静默失效 | pi `ai/src/auth/types.ts:17-20`、`core/auth-storage.ts:233-266`；已修 + 单测锁死 |
| 2 | `describe_credential` 把裸字符串当合法 `api_key` | pi 的 loader 对非法条目**直接抛错**，整个 auth.json 不可用 | `core/auth-storage.ts:239-247`；已修 + 单测 |
| 3 | `perf_config_save` 从零构造配置整写 | 改并发数会重置权限档位 | 已改成读-改-写 |
| 4 | `tauri.full.conf.json` 的 `$comment` 键 | schema 是 `additionalProperties:false`，**full SKU 从来没构建成功过** | 实测 `tauri build --config` 直接报错；说明移到 `TAURI_FULL_SKU.md` |
| 5 | full SKU 的 `resources` 只列 `resources/pi/*` | 数组是整体替换，会**丢掉守卫脚本** → 默认档位拒绝启动任何会话 | tauri `--config` 语义；已改为显式重复列出 |
| 6 | `resources/pi/*` 不跨目录 | 子目录资源（`export-html/` 等）打不进包 | tauri 用 `glob` crate，`*` 不跨 `/`（`tauri-utils/src/resources.rs:250`）；已实测 `**/*` 生效 |
| 7 | standalone 资产名/平台映射错误 | 下载永远 404 | 已用 GitHub releases API 核对 |
| 8 | `tests/contract.rs` 调用 `discover(None)` | `contract` feature 下无法编译（默认不编译所以没暴露） | 已修，`cargo test --features contract --no-run` 通过 |
| 9 | `tauri::Builder::setup` 写了两次 | 后一次**覆盖**前一次，托盘/内置 pi 接线/watcher 从未运行 | tauri-2.11.6 `src/app.rs:1777` `self.setup = Box::new(setup)`；实测日志从未出现 "sessions watcher 已启动" |
| 10 | 轨迹行固定 `height:30px` 却可展开 | 320px 正文挤在 30px 行里，**溢出 321px 压住后续 3 行** | 实测矩形；且 assistant 行从不设置 `detail`，折叠按钮是死代码，「调用」按钮无物可折 |
| 11 | `perf_config_*` 命令注册了但前端从未调用 | `permission_mode` / `pi_source` / 并发数都没有界面 | 全仓 grep 无调用点；已补「运行」页签 |

另外确认并记录（未改，因为是无害或需产品决策）：

- `NO_COLOR=1` 对 pi **无效**（pi 全仓不读该变量）；stdout 本来就是纯 JSONL，无需抑制横幅。
- `docs/02-pi-rpc-integration.md` 声称会传 `--provider/--model/--session-dir`，实际没有。
- `docs/02` 承诺的 `piPath` 设置项与最低版本门控**不存在**；`discover()` 的显式路径参数所有调用点都传 `None`。
