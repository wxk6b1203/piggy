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

| 档位 | `--tools` | 守卫扩展 | 实际能做什么 |
|------|-----------|----------|--------------|
| **仅可查看** | `read,grep,find,ls` | 不注入 | 只有只读工具，没有写、没有 shell |
| **工作区内修改**（默认） | `read,grep,find,ls,write,edit` | 注入 | 可读写文件，写入被守卫限制在会话 cwd 内；**无 shell** |
| **完全权限** | **不传** | 不注入 | 不限制：含 `bash`/`powershell` 与扩展/自定义工具 |

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
（`sessions/registry.rs::set_permission` → `revive_tab`）：停旧进程 → 按新档 spawn →
必要时 `switch_session` → `get_entries(since=cursor)` 游标补齐 → 发 `resync`。
会话文件与游标不变，所以对话内容不丢。

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

### 2.2 打包期：把你自己的 pi 放进安装包

| 方式 | 怎么做 | 适用 |
|------|--------|------|
| **`PI_STANDALONE_FILE`** | `PI_STANDALONE_FILE=~/my/pi-darwin-arm64.tar.gz node scripts/fetch-pi-standalone.mjs` | **推荐**：走完整打包链路，只换产物 |
| `PI_STANDALONE_URL` | 换成自己的 URL 模板（占位符 `{VERSION}` `{OS}` `{ARCH}` `{ASSET}`） | 有自建发布时 |

产物落位 `resources/pi/`，再由 `tauri.full.conf.json` 的 `resources/pi/**/*` 打进包。
内置路径由 `resource_dir()` 决定，布局见 `src-tauri/TAURI_FULL_SKU.md`。
打完包后在设置页选「捆绑 pi」即可启用。

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
2. **`PI_BIN` 在 macOS GUI 启动时拿不到**：`.app` 的环境来自 launchd 而非 shell。
   要固定用自带/自定义二进制，走 §2.1 的打包路径，别依赖环境变量。

### 2.5 插件（pi 里叫 **extension**）

- 加载**与运行模式无关**：RPC 模式下扩展照常加载
  （`main.ts:930` 才进 `runRpcMode`，扩展在此之前已 `resourceLoader.reload()`）。
- 发现顺序：CLI `-e` 路径 → 项目 `.pi/extensions/` → 全局 `<agent-dir>/extensions/` → `settings.packages` 声明的包。
  目录扫描只认一层 `*.ts` / `*.js` / `index.ts` / `index.js`。
- 包通过 `package.json` 的 `pi` 字段声明资源：`{ "pi": { "extensions": [...], "skills": [...], "prompts": [...], "themes": [...] } }`。
- 扩展入口：`export default function (pi: ExtensionAPI) {}`，可 `on(<36 种事件>)`、`registerTool`、
  `registerCommand`、`registerFlag`、`registerProvider`。
- **MCP 不支持**：pi 里没有 MCP 客户端或配置项。要用 MCP 得通过扩展（如第三方 `pi-mcp-adapter`）。
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
