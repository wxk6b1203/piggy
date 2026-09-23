# 18 · 上游问题：pi-subagents 的 async runner 与 pnpm 软链布局不兼容

> 上游：[15-handoff.md](15-handoff.md) 规矩 20 · [06-subagents.md](06-subagents.md) §4 · [09-roadmap.md](09-roadmap.md) §5.2
> 状态：**已在用户机器上打补丁并验证**（2026-09-23）；issue 正文见 §4，可直接提交给 pi-subagents。

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

## 4. 补丁（已应用并验证）

文件：`~/.pi/agent/npm/node_modules/pi-subagents/src/runs/background/runner-aliases.js`
（0.71.0 的同一函数未变，仍可复现）

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

- 改前 sha256 `8a646137d21f50a5b68b2f6b38b722ffd3780f24cc83f45bda7c0f54d208bf30`
- 改后 sha256 `0028f45410a7ea49f93139797fb0e573d075eee47d097cb4ae6699f5c9f1a319`
- 语义不变：还是同一个包，只是给出真实目录；npm/hoisted 布局下 realpath 等于原路径，故对它们无影响。

**验证（真实 pi 0.87.1 + pi-subagents 0.70.1，补丁后且已撤掉一切临时软链）**：

1. `/piggy:spawn scout 只回复两个字：收到` → 状态 `running` → **`complete`**（约 24s）；
2. 完整往返：spawn → `/piggy:steer <runId> …` 回执 `deliveryStatus:"queued"`，
   pi-subagents 自己的运行记录显示 `steering: {requested:1, delivered:1, failed:0}`，
   事件流 `subagent.steer.requested → queued → routed → delivered`；
3. 子代理产出真实结果文件（`artifacts/<runId>_scout_output.md`，中文逐条总结）。

**维护提醒**：`pi update --extensions` / 重装 pi-subagents 会覆盖这个文件。
覆盖后症状会原样回来（表现为"子代理派发成功但秒 failed"）。

## 5. 给上游的 issue 正文（英文，可直接粘贴）

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
