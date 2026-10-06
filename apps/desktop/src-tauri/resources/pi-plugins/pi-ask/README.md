# pi-ask —— Piggy 捆绑的结构化提问插件

给模型一个工具，让它用**一张卡**问你 1–6 个问题（选项 / 多选 / 自由文本），
并附带 `/plan` 计划模式（只读 + 先出方案 + 同一张卡审批）。

- 入口：`index.js`（plain ESM，**不需要构建**，没有 npm 依赖）
- 纯逻辑：`lib.js`（无 pi 依赖，可直接单测）
- 清单：`piggy-plugin.json`（Piggy 读它决定"这个插件提供哪些工具/命令"，见 `pi/plugins.rs`）

## 为什么不是 npm 包

目标机器上很可能没有 node/npm，而 pi 的包管理器是 spawn 系统 `npm` 来装的。
Piggy 把插件目录随包分发，用 `pi --extension <dir>` 注入（`pi/process.rs::cli_args`）。

## 与宿主的关系

| 宿主 | 行为 |
|---|---|
| Piggy（`PIGGY_HOST=piggy`） | 提问走"信封 select"（`piggy:ask:v1:<toolCallId>`），宿主在转录里画提问卡 |
| 其它宿主（pi TUI 等） | 降级：逐个问题弹原生 `select`/`input`，任何宿主都能用 |

信封协议见 `lib.js` 顶部与 `apps/desktop/src/lib/questionChannel.ts`（两边有契约测试钉住）。
