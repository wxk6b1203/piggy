# 18 · 上游问题：pi-subagents 的 async runner 与 pnpm 软链布局不兼容

> 上游：[15-handoff.md](15-handoff.md) 规矩 20 · [06-subagents.md](06-subagents.md) §4 · [09-roadmap.md](09-roadmap.md) §5.2
> **状态（2026-09-23 结案）**：上游已独立发现并修复 —— 报告
> [#2409](https://github.com/nicobailon/pi-subagents/pull/2409)、修复
> [#2413](https://github.com/nicobailon/pi-subagents/pull/2413)（标题 `fix: resolve host peer aliases through symlinks`），
> **且该修复已随 pi-subagents 0.71.0 发布**。本机现在是 0.71.0，**不需要任何本地补丁**。
> 本文保留完整根因与复现（§1–§3、§5），§4 记录当时的临时补丁与其结局。
>
> ⚠️ 一处曾经的误判，写下来免得再踩：我一度以为"0.71.0 仍含旧代码"，依据是
> `findPeerPackageDir` 末尾那行 `return candidates.find(...)` 没变——
> **但官方修复本来就不改那一行**，它改的是 `resolveHostPeerAliases` 里的赋值。
> 判断某个已装版本有没有这个修复，只看一个地方：
> ```bash
> grep -n "realpathSync(target)" ~/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/runner-aliases.js
> ```

## 1. 现象（用户视角）

Fleet 面板里 `/piggy:spawn <agent> <task>` 派发子代理：

- `spawn` 回执**正常**（`ok:true` + `details.asyncId`）；
- 状态行短暂显示 `running`（1–3 秒），随后变成 **`failed`**；
- 结果文件缺失，`status.json` 里写着：
  `Async runner process <pid> exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.`

也就是说：**通道是通的，子进程起不来**。这与 Piggy、piggy-bridge 无关——
同一个失败在纯 pi（不带 Piggy）里也能复现。

## 2. 根因

pi-subagents 起 async runner 时，把「宿主 peer 包」的绝对路径通过 `JITI_ALIAS` 交给
`runner-peer-preload.mjs`，后者用 `registerHooks` 把这些 specifier **short-circuit 到那些路径**：

```
src/runs/background/runner-aliases.js::findPeerPackageDir()
  → candidates.find(candidate => readManifest(candidate)?.name === pkg)
src/runs/background/async-execution.js
  → runnerEnv[JITI_ALIAS] = JSON.stringify(hostPeerAliases.aliases)
runner-peer-preload.mjs
  → return { url: pathToFileURL(alias).href, shortCircuit: true }
```

在 pnpm 布局下，`<dependent>/node_modules/<pkg>` 是**软链**，真实目录在
`<links>/@scope/<pkg>/<ver>/<hash>/node_modules/<pkg>`。别名给出的是软链路径，
于是 Node 把这个 URL 当作被别名模块的 `parentURL`，**从软链路径**去解析该包自己的依赖：

- `<dependent>/node_modules/<pkg>/node_modules/` —— 空的
- `<dependent>/node_modules/` —— 只有 dependent 的直接依赖

而被别名包的依赖（pnpm 放在**真实路径的兄弟位**）一个都不在这条链上，于是：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'marked'
  imported from .../links/@earendil-works/pi-coding-agent/0.87.1/<hash>/node_modules/@earendil-works/pi-tui/dist/index.js
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-telemetry'
  imported from .../links/@earendil-works/pi-coding-agent/0.87.1/<hash>/node_modules/@earendil-works/pi-agent-core/dist/index.js
```

**注意是"从软链路径解析不到"，不是"没装"**：`marked` 就在真实树的兄弟位
（`<links>/@earendil-works/pi-tui/0.87.1/<hash>/node_modules/marked`）。
早期结论写成"缺 marked"是不准确的，据此重装 pi 也不会修好——**实测重装后错误一模一样**。

`HOST_PEER_ALIASES` 里的 specifier 本身不带子依赖问题，坏的是**每个被别名包自己的依赖**，
所以这是一个"修一个冒一个"的链条（补 `marked` → 冒 `pi-telemetry` → …）。

## 3. 复现（无需 Piggy）

```bash
# 0. 环境：pnpm 全局装的 pi（软链布局）
pi --version            # 0.87.1
node --version          # v24.14.0

# 1. 计算宿主 peer 别名（这是 runner 实际用的那份）
node --input-type=module -e "
const { resolveHostPeerAliases } = await import(process.env.HOME +
  '/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/runner-aliases.js');
const { aliases, missing } = resolveHostPeerAliases('<piPackageRoot>');
console.log(missing, aliases['@earendil-works/pi-tui']);
"
# 软链布局下会打印 <dependent>/node_modules/@earendil-works/pi-tui/dist/index.js（软链路径）

# 2. A/B：用同一份 preload hook，只改别名是软链还是 realpath
cat > /tmp/t.mjs <<'EOF'
for (const s of ['@earendil-works/pi-coding-agent','@earendil-works/pi-agent-core','@earendil-works/pi-tui']) {
  try { await import(s); console.log('OK  ', s); }
  catch (e) { console.log('FAIL', s, e.code); }
}
EOF
PRELOAD=~/.pi/agent/npm/node_modules/pi-subagents/runner-peer-preload.mjs
PI_ASYNC_NATIVE_RUNNER=1 JITI_ALIAS='{"@earendil-works/pi-tui":"<软链路径>/dist/index.js"}' \
  node --import $PRELOAD /tmp/t.mjs      # → FAIL ERR_MODULE_NOT_FOUND
PI_ASYNC_NATIVE_RUNNER=1 JITI_ALIAS='{"@earendil-works/pi-tui":"<realpath>/dist/index.js"}' \
  node --import $PRELOAD /tmp/t.mjs      # → OK

# 3. 端到端：任何模型派发的异步子代理都会在 2 秒内 failed，
#    排查入口 $TMPDIR/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/runner.stderr.log
```

实测结果（2026-09-23，本机）：

| 别名形态 | `pi-coding-agent` | `pi-agent-core` | `pi-tui` |
|---|---|---|---|
| 软链路径（现状） | ❌ `pi-telemetry` 找不到 | ❌ `pi-telemetry` 找不到 | ✅（当时已手工补了软链） |
| realpath | ✅ | ✅ | ✅ |

## 4. 临时补丁（已被官方修复取代，勿再手工打）

> **结论先说**：官方修复已在 **0.71.0 发布**，与下面的临时补丁**语义等价**。
> 本机在 0.70.1 上打过这个补丁，随后 pi 把 pi-subagents 升到 0.71.0 时**覆盖**了它——
> 这是好事，不用修（0.71.0 自带官方修复）。**若你的版本 ≥0.71.0，请忽略本节。**

当时的补丁（打在 `~/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/runner-aliases.js`）：

```diff
-    return candidates.find((candidate) => readManifest(candidate)?.name === pkg);
+    const found = candidates.find((candidate) => readManifest(candidate)?.name === pkg);
+    if (!found)
+        return undefined;
+    try {
+        return fs.realpathSync(found);
+    }
+    catch {
+        return found;
+    }
 }
```

**官方修复（#2413）打的是同一问题的另一处**，取的是「别名最终目标文件」的 realpath：

```diff
 	for (const { specifier, pkg, subpath } of required) {
 		const packageDir = findPeerPackageDir(piPackageRoot, pkg, hostManifest?.name);
 		const target = packageDir ? resolvePackageSubpath(packageDir, subpath) : undefined;
-		if (target && fs.existsSync(target)) aliases[specifier] = target;
+		// Native loaders short-circuit resolution, so aliases must retain the real package's dependency scope.
+		if (target && fs.existsSync(target)) aliases[specifier] = fs.realpathSync(target);
 		else missing.push(specifier);
 	}
```

两者对 runner 等价（runner 只用 `resolveHostPeerAliases`；`findHostPeerPackageDir` 在 src 里没有任何调用点）。
官方版额外更新了两条既有单测，并新增 `test/unit/runner-peer-symlinks.test.ts` ——
那是本文 §3 的 A/B 实验的通用化版本（造一个软链宿主 + store 里的 `marked`，
断言子进程能解析并且**模块身份一致**）。

**当时的验证（0.70.1 + 临时补丁，已撤掉一切手工软链）**：

1. `/piggy:spawn scout 只回复两个字：收到` → `running` → **`complete`**（约 24s）；
2. spawn → steer 回执 `deliveryStatus:"queued"`，运行记录 `steering:{requested:1,delivered:1,failed:0}`；
3. 子代理产出真实结果文件。

**0.71.0（官方修复，无任何本地补丁）复验（2026-09-23）**：

| 项 | 结果 |
|---|---|
| `/piggy:spawn scout …` | `running`（tokens 2696→12592 实时增长）→ **`complete`**（47.8s） |
| `/piggy:steer <runId> …` | 回执 `{"ok":true,"deliveryStatus":"queued"}`；运行记录 `requested:1, delivered:1, failed:0`（含 `routedAt`/`deliveredAt`） |
| `/piggy:cost` | **首次真机可用**（0.71 才声明该能力位）：返回 `{version:1,parent,children,childTotal,total,unresolvedAsyncChildren}` |

## 5. 上游 issue 正文（英文，**已无需提交**，保留作为问题记录）

> 上游已独立报告（#2409）并修复（#2413）；下面是当时准备好的复现材料，留档用。

```markdown
### Summary

The detached async runner cannot start on a pnpm-installed pi: `JITI_ALIAS` is built from
**symlinked** package paths, so every peer package aliased by `runner-peer-preload.mjs`
fails to resolve its own dependencies and the runner dies with `ERR_MODULE_NOT_FOUND`.

Effect: `subagent` async spawns (and anything using the RPC `spawn` method) report success,
then the run is marked `failed` within ~2s:
`Async runner process <pid> exited or disappeared before writing a result.`
`runner.stderr.log` shows the module error.

### Environment

- pi `0.87.1`, installed globally with **pnpm** (default `node-linker=isolated` → symlinked `node_modules`)
- pi-subagents `0.70.1` (same alias code in `0.71.0`: `runner-aliases.js`, `return candidates.find(...)`)
- Node `v24.14.0`, pnpm `11.24.0`, macOS (darwin)

### Root cause

`src/runs/background/runner-aliases.js::findPeerPackageDir()` returns
`<piPackageRoot>/node_modules/@earendil-works/pi-tui`, which under pnpm is a **symlink** to
`links/@earendil-works/pi-tui/<ver>/<hash>/node_modules/@earendil-works/pi-tui`.
`async-execution.js` puts that path in `JITI_ALIAS`; `runner-peer-preload.mjs` then returns
`{ url: pathToFileURL(alias).href, shortCircuit: true }`. Node uses that URL as the parent URL
for the aliased package's own imports, so resolution walks up the **link** tree:

- `<dependent>/node_modules/@earendil-works/pi-tui/node_modules/` → empty
- `<dependent>/node_modules/` → only the dependent's direct deps

The aliased package's dependencies live next to its **real** path
(`links/@earendil-works/pi-tui/<ver>/<hash>/node_modules/{marked,get-east-asian-width}`), so they
are invisible. Errors observed:

```
ERR_MODULE_NOT_FOUND: Cannot find package 'marked'
  imported from .../pi-coding-agent/0.87.1/<hash>/node_modules/@earendil-works/pi-tui/dist/index.js
ERR_MODULE_NOT_FOUND: Cannot find package '@earendil-works/pi-telemetry'
  imported from .../pi-coding-agent/0.87.1/<hash>/node_modules/@earendil-works/pi-agent-core/dist/index.js
```

Note these packages are **installed**; they are simply not resolvable from the path handed to Node.
Patching one missing package only surfaces the next one.

### Reproduction

```bash
# A/B with the real preload hook and a hand-built alias map
cat > /tmp/t.mjs <<'EOF'
for (const s of ['@earendil-works/pi-coding-agent','@earendil-works/pi-agent-core','@earendil-works/pi-tui']) {
  try { await import(s); console.log('OK  ', s); }
  catch (e) { console.log('FAIL', s, e.code); }
}
EOF
PRELOAD=~/.pi/agent/npm/node_modules/pi-subagents/runner-peer-preload.mjs

# symlinked alias (what findPeerPackageDir returns today) → FAIL ERR_MODULE_NOT_FOUND
PI_ASYNC_NATIVE_RUNNER=1 JITI_ALIAS='{"@earendil-works/pi-tui":"'"$LINK"'/dist/index.js"}' \
  node --import $PRELOAD /tmp/t.mjs

# realpath alias → OK for all three
PI_ASYNC_NATIVE_RUNNER=1 JITI_ALIAS='{"@earendil-works/pi-tui":"'"$REAL"'/dist/index.js"}' \
  node --import $PRELOAD /tmp/t.mjs
```

End-to-end: ask the model to call the `subagent` tool with `async: true` (or RPC `spawn`) — the run
goes `running` → `failed` in ~2s; `$TMPDIR/pi-subagents-uid-<uid>/async-subagent-runs/<runId>/runner.stderr.log`
contains the module error.

### Suggested fix

Realpath the alias targets (keeps the same package, just the real directory; a no-op for
npm/hoisted layouts):

```diff
-    return candidates.find((candidate) => readManifest(candidate)?.name === pkg);
+    const found = candidates.find((candidate) => readManifest(candidate)?.name === pkg);
+    if (!found)
+        return undefined;
+    try {
+        return fs.realpathSync(found);
+    }
+    catch {
+        return found;
+    }
```

Alternatively, resolve the peer's dependencies explicitly instead of relying on directory walk-up
from the alias URL. `findHostPeerPackageDir()` is exported, so consumers may hit the same issue.

### Verified after patching

- Real async child runs to `complete` (~24s) instead of failing in ~2s.
- `steer` on a live async run: receipt `deliveryStatus: "queued"`, run status records
  `steering: { requested: 1, delivered: 1, failed: 0 }`, events
  `subagent.steer.requested → queued → routed → delivered`.
- Child produced a real result artifact.
```
