# pi-guardrails

把 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) 的「失败可观测 + 写前校验」机制移植到 [pi coding agent](https://github.com/earendil-works/pi)。

**纯扩展实现，不修改 pi 源码。**

## 解决什么问题

pi 的失败大多**不是崩溃，而是静默**：模型基于陈旧内容写入却当轮收到成功、回合莫名其妙结束却没有输出、非零退出被忽略。这些错误的共同点是**没有留下可辨认的痕迹**，于是你只能看到「agent 今天不太聪明」。

本扩展补四个护栏：

| 护栏 | 作用 | 对应 DSH 机制 |
|---|---|---|
| **写前观察校验** | `edit`/`write` 改「已存在但未读过」的文件 → 拦截并给出修复动作；**创建不存在的文件不拦** | `fs-observation-policy`（`FS_NOT_OBSERVED` / `FS_STALE_VERSION`） |
| **原子 CAS**（v2） | 判定与落盘在同一个 `withFileMutationQueue` 临界区内完成，消除 TOCTOU 窗口 | `replaceIfVersion` / `editIntent` |
| **原子发布**（v3） | 暂存 + fsync + rename：崩溃不会留下半个文件 | `writeText` 的 staging 发布 |
| **空响应兜底** | `stop` 但无正文无工具调用 → 注入提醒并续跑 | — |
| **bash 证据化** | 非零退出/超时/被杀/被中止 → 追加结构化事实行（**pi 不提供这些字段**，从错误文案还原） | `renderResult` 的 marker 约定 |
| **重复调用探测** | `[3,5,8]` 连击 → 分级提醒（只提醒，不拦截） | `repeat-tool-reminder` |

## 安装

需要 pi >= 0.87.1（实测版本；0.87.0 的类型也通过检查）。

**方式一：全局自动发现（支持 `/reload` 热更新）**

```bash
ln -s /path/to/pi-guardrails ~/.pi/agent/extensions/pi-guardrails
```

**方式二：单次加载**

```bash
pi -e /path/to/pi-guardrails/index.ts
```

**方式三：项目本地**（需项目被信任）

```bash
ln -s /path/to/pi-guardrails <project>/.pi/extensions/pi-guardrails
```

### 装上了吗？怎么确认

启动 pi 时看横幅的 `[Extensions]` 段应该出现 `pi-guardrails`。想确认**行为**（而不只是加载）：

```bash
printf 'important\n' > /tmp/g.txt
# 让模型跳过读取直接写 —— 应被拦，文件不变
pi -p "Call the write tool on /tmp/g.txt with content 'x'. Do NOT read it first."
cat /tmp/g.txt      # 仍是 important
```

反向确认（创建新文件不该被收费）：

```bash
pi -p "Create /tmp/new.txt containing hello"   # 一次 write 成功，无拦截
```

### 卸载

```bash
rm ~/.pi/agent/extensions/pi-guardrails
```

注意 `npm run link` **不是**安装扩展 —— 它只链开发依赖（类型检查和测试用）。
两者互不相关，见下面「开发与测试」。

## 开发与测试

### 开发依赖

```bash
npm install && npm run link
```

- `npm install` 装 `typescript` / `@types/node` / `jiti`（小体积、无原生依赖）。
- `npm run link` 把 `@earendil-works/pi-coding-agent` 软链到**本机正在运行的那个 pi**。

**为什么 pi 不写进依赖清单**：它带进整棵依赖树（AWS SDK、Google、OpenAI……
实测装完 `node_modules` 是几百 MB 量级，本仓只用到它的类型和几十个导出）。代价是
`npm install` 会清掉不在清单里的条目 —— 所以**每次 `npm install` 之后都要跑一次
`npm run link`**（幂等、自愈断链）。

脚本不靠猜目录：读 `which pi` 指向的 shim → 取其中的 `cmd-shim-target` → 逐级上溯按
`package.json` 的 `name` 确认命中。它**只走 shim 这条路**，不查 `node_modules`，
所以不会被那里的副本带偏；解析出的版本会与 `pi --version` 核对，不一致直接报错退出。

> ⚠️ **踩过的坑（会静默错位）**：`peerDependencies` 里声明了
> `@earendil-works/pi-coding-agent`，于是**跑 `pnpm install` 会让 pnpm 按 `>=0.87.0`
> 自动装一份**（实测装到 0.87.0）到 `node_modules/@earendil-works/` —— 也就是说，
> `node_modules` 里完全可能出现**第二份、版本更旧**的 pi。
>
> 实测后果：脚本打印了 ✓，但 `node_modules` 里躺着的是 0.87.0 而运行时是 0.87.1，
> **类型面与运行面错位**，`npm run check` 的结论对运行时未必成立。
> （我没能确定性重建当时解析走的那条路 —— 涉及的副本已删；所以下面两道防线是**按机制**
> 加的，并用变异测试验过。）
>
> 现在有两道防线：解析**只认 shim 指向的那一份**，以及链后**再读一次 `node_modules`
> 的实际版本**核对。若发现该位置是**实体目录**（不是软链，即真被装了一份），脚本会拒绝
> 并给出 `rm -rf` 的确切命令 —— 它不擅自删别人的依赖。

### 检查与测试

```bash
npm run check     # tsc --noEmit（类型检查）
npm test          # 90 个用例
npm run verify    # 上面两个一起跑
```

`npm run check` 在首次接入时抓到 **9 个真实类型错误**（jiti 只转译不做类型检查，
所以测试全绿也发现不了）—— 包括 `pi.on` 联合类型挑不到重载、`ToolDefinition<T>` 参数
不变性、`noUncheckedIndexedAccess` 下的可能 undefined。都已修。

测试用 mock ExtensionAPI 驱动真实事件序列，并在临时目录里做真实文件操作，
不需要 pi、模型或网络。

### 为什么 DSH 排障比 pi 强（源码级对比）

`docs/why-dsh-is-better-at-debugging.md` —— 基于 **DSH v0.1.7-alpha.2 源码**逐条核对，
不是文档转述。要点：

- DSH 把 bash 非零退出/超时/信号做成**正常结果里的正交事实**，pi 是抛错（`isError: true`）
- 拦截时只给模型**一句可执行的补救**，code/栈留在宿主（`fs/tool-fs/src/error.ts` 全文 14 行）
- log 是真相、消息是投影 ⇒ 压缩与裁剪**可逆**，模型可 `session_event_read` 读回原文
- 不变量 **Model-visible ⟺ logged** 由运行期断言强制
- ⚠️ 也写了 DSH **没有**的东西（无编辑后自动诊断、guard 不拦截、子代理只回结论）

### 系统提示词：pi 本来就是分节的（可像 DSH 那样精细注入）

常见误解是"想在 pi 里改系统提示词，只能整条替换"。实际不是：

```ts
// pi 的 before_agent_start 事件（extensions/types.d.ts:555-565）
readonly systemPrompt: string;                          // 渲染结果，只读
systemPromptOptions: NormalizedBuildSystemPromptOptions; // ← 可变的分节对象
```

`systemPromptOptions.sections` 是一个「段名 → 内容」的可变表，pi 会经
`buildSystemPromptSections` 重新渲染（每段包成 `<段名>…</段名>`），并只在内容变化时
用 `diffSystemPromptSections` 产生一条增量 system 补丁。所以**结构性注入是原生支持的**，
不需要替换提示词。

本扩展据此把「护栏存在」这件事注入为 `<guardrails>` 段（`src/prompt.ts`），
两条设计红线：

1. **绝不返回 `systemPrompt`**。那是 `forceSystemPrompt` 整条替换，会让 pi 自己的
   工具清单、项目上下文、skills 段落全部失效 —— 这是"改提示词"里最容易犯的错。实测确认：
   注入后 pi 的 `project_context` 段原样保留。
2. **只为当前配置下为真的护栏生成引导**。关掉 `enforceObservation`，"读前校验"那句就不会
   出现。理由：一个静态的"我会拦截未读就改"在护栏关闭时就是**在骗模型** —— 模型会因此
   放弃自己的判断，而护栏并不存在，这比没有护栏更糟。这一条直接学自 DSH：
   *提示词承诺的事实，代码必须兑现*。

当前注入的引导（各自绑一个开关）：

| 引导 | 对应的机制 | 关闭它的开关 |
|---|---|---|
| 改文件前先读；读一个不存在的文件也算（会记录缺席） | `guard-write` + `evidence` 的缺席记录 | `enforceObservation` |
| 被 "file changed since it was read" 拒绝时重读再改，别重复同一调用 | `guard-atomic` 锁内 CAS | `detectStale` |
| 写入是原子发布的，报成功即已完整落盘 | `publish` 的 staging+fsync+rename | `atomicPublish` |
| 每条 bash 结果都要看 `[exit code: N]` 等事实行 | `evidence` 的证据行 | 恒为真（证据行总在） |

**已知限制**：只在每轮开始（`before_agent_start`）重新生成，会话中途改配置不会立刻反映。
`promptGuidance: false` 可完全关掉注入。

### 哪些经过真实 pi 验证，哪些没有

**已端到端验证**（真实 pi 0.87.0 + 真实模型）：

- 扩展加载无错误
- 写前观察校验拦截生效：`isError: true` + 护栏文案，文件未被改动
- 模型主动引用了护栏（「the tool enforces read-before-write」）
- **原子覆盖注册后正常创建文件**：读一次不存在的文件 → 记录缺席 → `write` 直接创建成功（`Successfully wrote to ...`），全程不需要绕道 `bash`
- **覆盖后工具元数据与内置一致**：`description` / `promptSnippet` / `promptGuidelines` / `constrainedSampling` / `parameters` / `renderCall` 逐项比对相同（TUI 渲染不退化）

**只有单元测试覆盖，未经端到端验证**：

- **原子 CAS 的拦截路径**。`hook 预检通过 → 外部改写 → 锁内判定拦截` 这个序列在测试里是确定性构造的（真的在两步之间写文件），但没有在真实会话里等一次真实并发写。
- **空响应兜底的续跑**。源码已确认机制（`_runBeforeSettleBoundary` flush → `canContinue` 检查 → `agent.continue()`），单元测试也覆盖了判定与防自激，但**没有真实触发过一整轮空响应 → 注入 → 续跑**。要验证它需要构造一次真实的 `stopReason: "stop"` + 空内容响应，比较难稳定复现。
- **连击提醒到达模型**。`deliverAs: "steer"` 的时序是用独立的探针实验验证的（`deliver-as-probe.ts`），但没有在真实护栏流程里跑过 3 连击。

**mock 与真实的已知差异**：我的测试脚手架里 `emit()` 在第一个返回非 undefined 的 handler 处停止，模拟 `tool_call` 的短路语义。真实的 `tool_result` 是累积式的（见下），而我只注册了一个 `tool_result` handler，所以这个差异不影响结论。

### ⚠️ 一次静默失效：护栏 3 在真实 pi 上从未生效（交付后才发现）

**这是本仓最值得记住的一条**，因为它同时暴露了三个问题。

**症状**：护栏 3（bash 证据化）在真实 pi 里**一行证据都没追加过**。

**根因**：它假设 pi 在 `details` 里给 `exitCode` / `signal` / `timedOut`，并且只在
`isError === false` 时追加。两个假设都错：

```js
// pi 0.87.0 的真实形状
interface BashToolDetails { truncation?: ...; fullOutputPath?: string }   // bash.d.ts:15-18
// ← 没有 exitCode / signal / timedOut

throw new Error(appendStatus(outputText, `Command exited with code ${exitCode}`))  // bash.js:270
// ← 非零退出是"抛错"，结果是 isError: true
```

**为什么 68 个用例全绿**：测试 fixture 手写了 `isError: false` + `details: { exitCode: 1 }`
—— 那是**更早版本 pi 的形状**。测试忠实地验证了一个真实世界不存在的输入。

**修复**：改从 pi 的错误文案里提取事实（文案格式源码可见、稳定），并且
**把信号杀死还原回信号名**——pi 在 exec 层把 `signalCode` 折成 shell 约定的 `128 + N`
（`bash.js:97-100`），信息在那一步就损失了，SIGTERM 会以「exit code 143」的面目出现。

**端到端验证**（修复后，真实 pi 0.87.0）：

```
$ pi -p -e ./index.ts "run: exit 7"
工具结果: "(no output)\n\nCommand exited with code 7\n[exit code: 7] — command failed"

$ pi -p -e ./index.ts "run sleep 30 with 2s timeout"
工具结果: "Command timed out after 2 seconds\n[timed out] — the command did not finish; ..."
```

**三条教训**（都写进 DESIGN.md §0 的自我更正表）：

1. **mock 的形状必须以真实代码为准，且要有机制保证它不漂移**。我在同一次交付里
   已经因为「mock 与真实不一致」栽过一次（见下面的误判），却又在护栏 3 上栽了第二次。
   现在每节测试的 fixture 都注明它照抄的 `文件:行号`。
2. **"全绿"只能证明代码符合测试的假设，不能证明假设成立**。凡是对接外部契约的断言，
   都要能回答"这个形状我是从哪读来的"。
3. **交付后要做一次真实端到端冒烟**——这次就是它抓到的。单元测试永远抓不到这类问题。

### 开发过程中抓到的真 bug，以及一次误判

**真 bug：失败的 read 没有记录缺席。** pi 对「读不存在的文件」返回 `isError: true`，
早先的实现因此跳过观察记录。后果不是"少记一条"，而是：

- 护栏自己的文案承诺 `reading it will record its absence and unblock the write`，
  实际重读多少次都没用 —— **护栏在骗模型**；
  （该文案已随契约变更移除：创建不存在的文件现在直接放行，不再需要先读一次来"解锁"）；
- 模型撞两次墙后绕道 `bash` 创建文件，于是护栏把工具调用**推向了它最监控不到的那条路**。
- 单元测试当时还把错误行为写成了断言（"失败的 read 不构成观察"），并附了一条听起来
  很合理、但事实上错误的注释。**端到端一跑就露馅了。**

这个 bug 端到端复现过：模型 `read` 两次 → 两次都被拦 → 改用 `bash` 建文件。修复后同一
场景下 `write` 直接成功。

**误判（留着当反面教材）：我一度以为 `createWriteToolDefinition` 没有锁。**

真实情况：`createWriteToolDefinition` 自己就把 `execute` 包在 `withFileMutationQueue` 里
（`write.ts:67`），`createWriteTool` 只是再套一层 `wrapToolDefinition` 补 ctx 工厂。
两者在锁这件事上**没有区别**。

我当时的"证据链"是这样的：并发测试失败 → 我推断是缺锁 → 改成 `createWriteTool` → 测试过了
→ 于是断定找到了 bug，还写进了代码注释和这里。实际上：
- 那次测试失败的真正原因是**我自己的用例写错了路径**（`join(cwd, 已经是绝对路径)` 拼成了
  `cwd + cwd + name`），跟锁毫无关系；
- 换 `createWriteTool` 之后"变绿"纯属巧合（两个实现都被 `ctx.cwd` 覆盖，行为本就相同）。

教训：**测试失败不等于产品有缺陷**。在把失败归因给被测代码之前，先确认测试真的在测那件事 ——
尤其是时序类断言。这个仓里现在那个"锁参与"用例是唯一一个**对缺锁真正敏感**的：它在外层持有
同一路径的 `withFileMutationQueue` 时发起写入，断言 150ms 内没有完成。缺锁会立刻完成 → 失败。

## 配置

扩展的第二个参数接受配置对象。当前 pi 的扩展加载器不会传入它，所以要用默认值以外的配置，请编辑 `index.ts` 末尾的 `DEFAULT_CONFIG` 调用处，或包一层：

```ts
// my-guardrails.ts
import guardrails from "pi-guardrails";

export default (pi) =>
	guardrails(pi, {
		allow: ["/Users/me/project/vendor"],   // 跳过护栏的路径前缀
		repeatThresholds: [3, 6],              // 覆盖默认的 [3, 5, 8]
		atomicWrite: "write+edit",             // edit 也走锁内判定
		debug: true,                           // 打印判定过程到 stderr
	});
```

| 选项 | 默认 | 说明 |
|---|---|---|
| `promptGuidance` | `true` | 把护栏的存在**分节注入**系统提示词（只为当前为真的护栏生成） |
| `enforceObservation` | `true` | 写前观察校验总开关 |
| `detectStale` | `true` | 陈旧写入检测（读后文件被外部改动） |
| `atomicWrite` | `"write"` | 原子 CAS 覆盖范围：`"off"` / `"write"` / `"write+edit"` |
| `atomicPublish` | `"rename"` | 原子发布：`"off"`（直接 writeFile）/ `"rename"`（暂存+fsync+rename） |
| `allow` | `[]` | 路径前缀白名单，命中的路径跳过文件护栏 |
| `guardEmptyResponse` | `true` | 空响应兜底 |
| `maxEmptyContinuations` | `2` | 同一 run 内最多兜几次（防自激） |
| `repeatThresholds` | `[3, 5, 8]` | 连击提醒阈值 |
| `repeatInclude` / `repeatExclude` | `[]` / `["job_output","job_list"]` | 连击探测的工具过滤 |
| `markEmptyFailureAsError` | `false` | 「失败且**命令本身毫无输出**」时追加一句明确提示。（**不改变** pi 的 `isError`——pi 本来就置 true；名称是 v1 遗留，语义已随契约修正重定义） |
| `deliverAs` | `"steer"` | 提醒投递方式。**不要改**，见下文 |
| `debug` | `false` | 调试输出 |

`enforceObservation: false` 会强制把 `atomicWrite` 降为 `"off"`（没有观察表就没有可判定的东西）。

### `deliverAs` 必须是 `steer`

pi 的 `sendCustomMessage` 有四种投递模式，只有 `steer` 能在**当前回合内**送达：

| 模式 | 拉取时机 | 同回合可用 |
|---|---|---|
| `steer` | 每个 turn 末尾，下一次 assistant 响应之前 | ✅ |
| `followUp` | 工具批次耗尽、agent 本要停止时 | ✅ 但更晚 |
| `nextTurn` | **用户下次发 prompt 时**（`agent-session.ts:1731`） | ❌ |

`nextTurn` 的实际含义是「等用户下次说话时附在他的消息旁边」。实测（三个探针在同一次 `tool_call` 中发出）：`steer` 与 `followUp` 均交付，**`nextTurn` 在整份会话记录中不存在**。用它等于没有护栏。

## 已知限制

**请务必读完，这些不是免责声明，是会咬人的东西。**

### 护栏自身的故障会 fail-closed

`checkObservation` **不抛异常**。任何内部故障（权限、路径异常等）都会被兜住并转成一条 block，文案是护栏自己的：

```
cannot modify "x": the write guard could not verify this file (EACCES...).
Retry once; if it keeps failing, the guard is faulty — disable it with
enforceObservation: false rather than working around it.
```

**为什么必须这样**：pi 的 `beforeToolCall` 抛出的异常会被 agent-loop 直接转成给模型的错误结果（`agent-loop.ts:763-767`），模型会看到 `EACCES: permission denied` 这类内部细节，**把护栏故障误读成工具故障**，然后开始瞎试。

### `tool_result` 的异常是静默的（pi 的行为）

pi 的 `emitToolResult` 会 catch handler 异常、只发一个 error 事件，**工具照常返回**。也就是说：如果 `evidence.ts` 里的 handler 抛异常，bash 证据化会**静默失灵**，回合不受影响。

这种「以为有保护其实没有」的状态比崩溃更危险，所以该 handler 内部自己包了 try/catch 并显式 `debug()` 出来，不让 pi 吞掉。

### 写前校验的分层：hook 层非原子，原子层负责 CAS

**两层，各管一件事，不要混淆：**

| 层 | 位置 | 职责 | 原子性 |
|---|---|---|---|
| hook 层 | `tool_call` 钩子（`guard-write.ts`） | 对**未被原子层覆盖**的工具（`atomicWrite: "off"`，或 `edit` 在 `"write"` 模式下）做「未读就改」拦截 | ❌ 检查与写入之间有 TOCTOU 窗口 |
| 原子层 | 内置 execute 的 `withFileMutationQueue` 临界区内（`guard-atomic.ts`） | 版本比对（CAS）**与落盘在同一个锁里** | ✅ 消除窗口 |

覆盖范围由 `atomicWrite` 决定（默认 `"write"`；`"write+edit"` 把 `edit` 也纳入）。

**被原子层覆盖的工具，hook 层不再重复做陈旧比对**：两层做的是同一套判定，但 hook 在锁外、
结论可能在下一次 `await` 时就过期，原子层在锁内、结论才权威。省掉的不是"少检查一次"，
而是"不在错误的地方检查"——顺带每写一次少一次多余的 `stat`。
被覆盖的工具（默认 `write`）**连「未读就改」也交给原子层**：判断"这文件是否已存在、
模型是否看过"需要 stat，而只有原子层能在持有该文件锁时做。代价是拦截文案晚一步到模型，
收益是**创建新文件不再被收费** —— 见下面「创建新文件的判定」。
未被覆盖的工具仍由 hook 层拦，保证常见错误在工具执行之前就被拦下。

**仍然存在的窗口**：`detectStale: false` 时原子层不做版本比对（那是配置选择，不是缺陷）；
`atomicWrite: "off"` 时退回 v1 行为（hook 恢复自己做陈旧比对）。两条都会在 `debug` 输出里体现。

### 创建新文件的判定：不对无害操作收费

**契约**：`write`/`edit` 拦截的是「**文件已存在，而模型没读过它**」。文件不存在时直接放行 ——
创建没有东西可破坏，真正的风险是并发创建，而那由原子层在同一临界区内兜底。

判定在**原子层的锁内**做（`guard-atomic.ts`，`prior === undefined` 时 stat 一次），
判据是"文件现在存不存在"，而不是"观察表里有没有记录"。hook 层对已覆盖的工具**不下判断**。

**为什么这么改**（实测对照，每格 3 轮平均，真实 pi + 真模型）：

| 场景 | 改前 | 改后 |
|---|---|---|
| 创建新文件 | 2.3 次调用 / **1.3 次拦截** | **1.0 次调用 / 0 次拦截** |
| 改写已有文件 | 2.7 / 0.3 | 3.0 / 1.0（同契约，差异为噪声） |

旧实现在"创建"这个最常用的路径上，**每次都要模型先撞一次墙**才被允许写入。
而且根因不在提示词：裸 pi（无扩展、无引导）3/3 也是 `write→read→write` ——
模型天生先写，护栏是唯一引入这个约束的东西。

**这道新关卡是必需的**，不是可选优化：hook 放行之后，原子层成了"已存在但未读过"的
**唯一**防线。若原子层也不 stat，"未读就覆盖"会两层都放行 → 静默覆盖。
变异测试确认：去掉那个 stat，6 个用例立刻变红。

### 原子 CAS 依然拦不住「bash 改文件」

原子层保证的是**经过 `withFileMutationQueue` 的写入之间**互斥。`sed -i`、`>` 重定向走的是
`bash`，不经过这个队列 —— 它改完文件后，观察表里的戳就过期了，**下一次写入会被 CAS 拦下**
（这是正确行为：拦下来要求重读），但**在这次 bash 与下一次写入之间**模型如果直接读文件，
读到的是新内容，没有问题。

真正的盲区是：`bash` 改文件后**同一个回合并发**发起的 `write`。那时锁内 CAS 是在 bash 之后跑的，
所以它能捕获 —— 除非 bash 的改动恰好与观察戳同纳秒同大小（见下）。

### 版本戳的固有弱点

`dev:ino:size:mtimeNs:ctimeNs` 检测不到「同一纳秒内、大小不变」的两次改写。
DSH 用同样的组合，接受同样的弱点。要更强的保证只能用内容哈希，代价是大文件全量读。

### 路径规范化的两个盲区

- **符号链接**：已尽力用 `realpath` 解析（含父目录规范化），但文件不存在时只能回落到路径拼接
- **macOS 大小写不敏感**：不做大小写折叠，`README.md` 与 `readme.md` 视为不同文件

命中盲区时表现为**误报**（要求重读）。误报的代价是模型多读一次，可以接受；漏报的代价是静默写错，不可接受 —— 所以一律偏严格。

### bash 副作用不失效观察状态

`sed -i`、`>` 重定向等经过 `bash` 的改动**不会**被记录。之后的 `edit` 可能因此漏判。三个选项与取舍见设计文档 §4.4；当前实现选择「不处理」，因为另外两个方案要么拖垮体验（每次 bash 后清空全部观察），要么只对 git 仓库有效。

### `edit` 唯一性检查不在本扩展范围

pi 已经做了，而且比 DSH 更细：`edit-diff.js:236` 检查重复匹配，`:250` 还检查重叠编辑。**不要在这里重复实现。**

### 会话恢复后观察状态为空

换会话/换分支会清空观察表。DSH 有同样的限制（*"Observed state does not survive a session resume"*）。

### 拦截是二值的，没有「警告式放行」

pi 的 `ToolCallEventResult` 只有 `block?: boolean`。想在 `tool_result` 里追加警告？那时候**写入已经发生了**。所以 `enforceObservation` 要么拦要么不管 —— **不要期待「警告模式」**，那会给出虚假的安全感。

## pi API 的三条硬约束

改代码前必读。都是读 pi 0.87.0 源码确认的。

### 1. 第一个 `block` 生效，后续 handler 不执行

`runner.js:855-865` 命中 `result.block` 立即 `return`。所以**同一 handler 内必须合并所有问题**成一条 `reason`，否则模型一次只能修一个问题。

**但 `tool_result` 不是这个语义**：`emitToolResult`（`:1082-1130`）是**累积式**的 —— 它维护一个 `currentEvent`，把每个 handler 返回的 `content`/`details`/`isError`/`usage` 依次合并进去，不短路。所以多个扩展可以同时改写同一个结果。

### 2. `withFileMutationQueue` 不可重入

同一路径嵌套调用**必然死锁**：内层 `await currentQueue` 等的是外层的 `chainedQueue`，而外层要等 `fn()` 返回。

后果：**不要在自己的工具实现里调用内置的 `execute`**。官方 `tool-override.ts` 也是完全重实现 `read`，而不是包裹。

### 3. `agent_before_settle` 的 `continue: true` 会被静默拒绝

`canContinue` 要求最后一条 LLM 消息**不是 assistant**（`agent-session.ts:798-800`），而空响应之后它必然是 assistant。直接返回 `continue: true` 会被 `_reportInvalidBoundaryContinuation` 降级为 `false`，且**只在扩展错误通道留一行**。

唯一出路：先 `pi.sendMessage(...)` 让它进 `_pendingCustomMessages`，撑起 `canContinue` 的 `pendingCustomContext` 分支。且**必须在 `agent_before_settle` 而非 `turn_end`** —— 只有前者的 flush 在检查之前（`:1541` flush，`:1545` 检查）。

### 4. 异常处理在两个事件上不对称

| 事件 | handler 抛异常时 |
|---|---|
| `tool_call` | 异常**向上传播** → agent-loop 转成给模型的错误结果 → **工具不执行**，但模型看到的是原始异常消息 |
| `tool_result` | pi **catch 掉**并只发一个 error 事件 → 工具照常返回 → **护栏静默失灵** |

这个不对称是上面两条防御措施（fail-closed 包装 + handler 内自兜）的由来。

## 后续工作

### ✅ `write` 的真原子 CAS（v2）—— 已完成

**做法**（比原计划更省）：pi 的 `createWriteTool` / `createEditToolDefinition` 都接受公开的
`operations` 接缝，而内置 `execute` **本来就把整段操作包在 `withFileMutationQueue` 里**。
所以不需要重实现工具，只要把判定塞进 `ops.writeFile`：

```
withFileMutationQueue(path, async () => {   ← 内置 execute 持有
    mkdir
    ops.writeFile()  ← CAS 判定 + 落盘，同一临界区
})
```

几个实现要点（踩过的坑）：

- **关键机制是 `operations` 接缝，不是工具选择的差异**：`createWriteToolDefinition`
  与 `createEditToolDefinition` **都自己带锁**（`write.ts:67`、`edit.ts:163`），
  `createWriteTool` 只是多一层 `wrapToolDefinition` 补 ctx 工厂。所以两个工具都用
  `...Definition` 形态即可，不需要手工合并 AgentTool —— 我一度以为必须用
  `createWriteTool`（见上面「误判」）。
- 元数据（`description` / `promptSnippet` / `promptGuidelines` / `constrainedSampling` /
  `parameters`）直接来自内置定义，天然一致；渲染器由 pi 的 `withBuiltInRenderers`
  **按工具名补回**（`renderers/index.ts:51-63`）—— 实测覆盖后
  `renderCall`/`renderResult` 与内置完全相同，UI 不退化。
- 判定**不能**放在 execute 外层：那会与外层锁撞上「`withFileMutationQueue` 不可重入 → 死锁」
  （硬约束 2）。
- 写成功后要在**锁内**取一次戳回写观察表（DSH 的 `fs/observed` 语义）。否则「读 → 写 → 再写」
  的第二次会被自己写的文件误判为陈旧。
- **hook 层绝不能写观察表**（只读）。早期版本在 hook 里顺手记「确认不存在」，结果两个并发写
  创建同一文件时，第二个会被第一条自己伪造的记录挡下 —— 护栏自伤，且理由与模型认知不符。
  现在观察表的唯一权威是原子层。

### ✅ 原子发布（v3）—— 已完成

pi 的内置 `write` 是直接 `writeFile`，**没有 rename/fsync**。崩溃、断电或被 SIGKILL
可能留下**半个文件**。这与 CAS 是两回事：

| | 管什么 | 不管什么 |
|---|---|---|
| `atomicWrite`（CAS） | 我读到的东西**还有效吗** | 写到一半崩了会怎样 |
| `atomicPublish`（rename） | 写到一半崩了文件**会不会烂** | 我的认知是否过期 |

**做法**（`src/publish.ts`，DSH `writeFileAtomic` 同款）：

```
mkdir .<name>.<pid>.<uuid>.tmpdir   (0700)
  写 <name>.tmp                     崩在这里 → 目标文件完全没动
  fsync(文件)                        内容真的落盘，不是只进页缓存
  rename(tmp, target)                原子：这一刻起读者才看到新内容
  fsync(目录)                        让 rename 这个目录项变更也持久
  rm -rf 暂存目录
```

写完后在**同一个临界区内**取戳回写观察表，所以 CAS 与发布是串在一起的。

#### 实现中被测试抓到的三个坑

1. **成功路径忘了清理暂存目录**。只在 `catch` 里清理，于是每写一次就在用户目录里留一个
   `.xxx.tmpdir`。测试直接列目录抓到了。
2. **新建文件被强制成 0600**。`rename` 会把暂存文件的 mode 带过去，而我给暂存文件传了
   `mode: 0o600`。新建文件应遵循 umask（通常 0644），与内置 `writeFile` 一致。
   修法是**不传 mode**，让内核套 umask；只有"替换已有文件"时才显式 chmod 成目标原 mode。
   顺带发现：如果只测 0644，这个 bug 测不出来（umask 022 下两条路径都得 0644）——
   所以用例改用一个 umask 不会产生的 mode（0640），变异测试确认它会红。
3. **符号链接会被替换掉**。`rename` 是替换目录项，**不跟随链接**；而内置 `writeFile` 跟随。
   不先 `realpath` 的话，`write("./link")` 会把链接本身变成一个普通文件。已改为
   「目标存在→realpath；不存在→解析父目录」。对应地，测试断言必须用 `lstat`
   （用 `stat` 会跟随链接，永远看不到这种破坏 —— 我第一版就写错了）。

#### 关于降级

部分文件系统（网络挂载、某些 FUSE）不允许在目录里建新条目，但允许原地改文件。
此时退回直接写，并**在 `debug` 输出里明确说明**——"假装原子"比"明确降级"危险得多。
`atomicPublish: "off"` 可以显式关掉（退回 v2 行为）。

#### 权限位、悬空链接与被顶替自检（交付后审查发现并修复）

交付后对照 pi 0.87.1 源码的复审 + 实测探针抓到三个缺陷，已修复；每个都有回归用例，
并用变异测试验过红绿：

1. **原子发布绕过写权限位**。rename 只要求**目录**可写；内置 `writeFile`（打开
   O_WRONLY）对只读文件 EACCES。不补检查的话，`chmod 444` 保护的文件会被本扩展
   **静默覆盖** —— 写入语义比内置更弱。现在目标存在时先 `access(W_OK)`，拒绝时原样
   抛出（与内置的拒绝方式一致）。
2. **悬空符号链接被 rename 整体替换**。realpath 对悬空链接失败，旧实现回落到
   "父目录+文件名" = 链接自己，rename 会把链接换成普通文件；而内置是穿过去的
   （在链接目标处创建）。现在逐级 `lstat`+`readlink` 跟随（上限 40，链接环报
   ELOOP），写穿透到目标、链接保留 —— 与内置一致。
3. **write 被其他扩展顶替 / 注册失败时零保护**。pi 对同名扩展工具是「后注册者
   静默胜出」（`agent-session.js` 的 `_refreshToolRegistry`，无冲突检测）；被顶替后
   CAS 消失，而 hook 层仍按 config 全权委托 → write 零保护，提示词却还在宣称护栏
   存在。现在注册失败或首个回合自检发现注册来源不是本扩展/兄弟实例时，自动把
   `atomicWrite` 降为 `"off"`（hook 层恢复 v1 检查），提示词随之只描述仍然为真的护栏。

修复后 e2e 复验（真实 pi）：新建文件一步成功（自检未误触发）；强迫模型盲写已有
文件 → 被 `FS_NOT_OBSERVED` 拦截，模型重读后写入成功，全程无降级告警。

### `edit` 纳入原子覆盖（已实现，默认关闭）

`atomicWrite: "write+edit"` 已可用并测过。默认不开的原因：`edit` 自己会先读文件再改，
窗口比 `write` 小得多；而 `edit` 是高频工具，覆盖它意味着多担一份「内置实现变化」的风险。

原子发布对 `edit` 同样生效（两者共用 `guardedWrite`）。

### `bash` 副作用的结构性盲区

护栏监控不到 `bash` 对文件的改动（见「已知限制」）。彻底的解法只有两条：解析 bash 命令
（脆弱、易绕过），或者让所有文件改动都必须经过工具（需要 pi 侧支持）。当前选择是**不假装
能覆盖**：CAS 会在下一次写入时把过期观察拦下来，代价是模型多读一次。

### `stop=error` 的自动恢复

真实会话里观察到 `stop=error` 连续 4 次、靠用户手打 `continue` 恢复的模式。原则上可自动恢复（`turn_end` 带 `outcome: "error"`），但**暂不纳入**：

pi 自身已有 `retry.enabled`（默认 true，maxRetries 3，2s/4s/8s 退避）。能穿过 3 次重试还到达 `stop=error` 的，多半是重试解决不了的 —— 在弄清它为什么能穿透之前加自动恢复，可能只是把 4 次无效请求变成 40 次。

建议先只做观测：把 `errorMessage` 记成 custom entry，积累样本再定策略。

## 设计文档

完整的推理过程、源码行号引用、逐条实验记录与自我更正：`DESIGN.md`（同目录，与 `../tmp_docs/pi-guardrails-design.md` 同步）。

## 许可

MIT
