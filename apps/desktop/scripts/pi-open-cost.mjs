/**
 * 「点开会话为什么这么慢」的分段计时（**诊断工具，不是门禁**）。
 *
 * 起因（2026-09-23 用户问）："点击打开会话要大概 1s 才能加载出来，长会话就更长，
 * 是 pi 必须存在的加载时间，还是说我们的 UI 有什么问题？"
 *
 * 这个脚本把那段等待拆开量，**每一段都单独可复现**：
 *
 * ```text
 * ① pi 裸启动（-ne，零扩展）             ≈ 210 ms   ← node + pi 核心，地板
 * ② ① + 用户已装扩展（发现并加载）        ≈ 740 ms   ← 用户装的扩展，逐个大头在下面
 *    · pi-subagents（14 MB）              +420 ms
 *    · pi-web-access（8.5 MB）            +33 ms
 *    · pi-todo / pi-guardrails（TS 插件）  +50 / +55 ms
 * ③ ② + 我们注入的 piggy-bridge + 守卫    +12 ms    ← 我们的扩展几乎不花钱
 * ④ ③ + 会话文件本身（11.13 MB vs 0.14 MB）≈ +50 ms  ← pi 解析会话
 * ⑤ 我们的游标初始化 get_entries(None)    ≈ +73 ms   ← **随会话线性**，2026-09-23 已挪到后台
 * ⑥ 我们的尾页 + 轮廓（Rust 直读文件）     ≈ +25 ms   ← 11 MB 会话实测 15.5 + 8.8 ms
 * ⑦ 前端（store + 面板 + 首屏渲染）        ≈ +50~100 ms
 * ```
 *
 * 用法：`node apps/desktop/scripts/pi-open-cost.mjs [会话文件]`
 * 前置：本机装了 pi（脚本用 `pi list` 的发现规则去找扩展，和 Piggy 走同一条）。
 */
import { spawn, execFileSync } from 'node:child_process';
import { statSync, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOME = homedir();
const PI = process.env.PIGGY_PI_BIN ?? join(HOME, 'Library/pnpm/bin/pi');
const REPO = join(import.meta.dirname, '..', '..', '..');
const BRIDGE = join(import.meta.dirname, '..', 'src-tauri', 'resources', 'piggy-bridge.js');
const GUARD = join(import.meta.dirname, '..', 'src-tauri', 'resources', 'piggy-guard.js');

/** 默认拿本机**最大**的那个会话文件（"长会话更慢"要有最大的那个才算数）。 */
function biggestSession() {
  const root = join(HOME, '.pi/agent/sessions');
  if (!existsSync(root)) return null;
  let best = null;
  for (const dir of readdirSync(root)) {
    const full = join(root, dir);
    let files = [];
    try {
      files = readdirSync(full).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = join(full, f);
      const size = statSync(p).size;
      if (!best || size > best.size) best = { path: p, size };
    }
  }
  return best;
}

function open(args, cwd) {
  const child = spawn(PI, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
  const pending = new Map();
  createInterface({ input: child.stdout }).on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const cb = pending.get(String(msg.id));
    if (cb) {
      pending.delete(String(msg.id));
      cb(msg, line.length);
    }
  });
  let id = 0;
  const call = (type, payload = {}) =>
    new Promise((resolve, reject) => {
      id += 1;
      const myId = String(id);
      const t0 = performance.now();
      pending.set(myId, (msg, bytes) => resolve({ msg, bytes, ms: performance.now() - t0 }));
      child.stdin.write(`${JSON.stringify({ type, id: myId, ...payload })}\n`);
      setTimeout(() => reject(new Error(`${type} timeout`)), 60_000);
    });
  return { child, call };
}

/** 起进程 + `get_state`（与 Piggy `create_tab` 的第一步完全一致），返回耗时。 */
async function startupMs(extraArgs, repeat = 3) {
  const times = [];
  for (let i = 0; i < repeat; i += 1) {
    const t0 = performance.now();
    const { child, call } = open(['--mode', 'rpc', '--no-session', ...extraArgs], HOME);
    await call('get_state');
    times.push(performance.now() - t0);
    child.kill();
  }
  return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
}

/** 已装的扩展（`pi list` 的发现规则；数不出来就跳过逐项那一段）。 */
function installedExtensions() {
  try {
    const out = execFileSync(PI, ['list'], { encoding: 'utf8' });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('/'))
      .filter((p) => existsSync(p));
  } catch {
    return [];
  }
}

const session = process.argv[2] ? { path: process.argv[2], size: statSync(process.argv[2]).size } : biggestSession();
console.log(`pi            = ${PI}`);
console.log(`最大会话       = ${session ? `${session.path}（${(session.size / 1048576).toFixed(2)} MB）` : '没找到'}`);
console.log('');

const bare = await startupMs(['-ne']);
console.log(`① pi 裸启动（-ne，零扩展）              ${bare} ms`);
const withExt = await startupMs([]);
console.log(`② ① + 用户已装扩展（发现并加载）         ${withExt} ms   （扩展贡献 ${withExt - bare} ms）`);
for (const ext of installedExtensions()) {
  const only = await startupMs(['-ne', '-e', ext], 2);
  const name = ext.replace(HOME, '~').split('/node_modules/').pop() ?? ext;
  console.log(`    · ${name.padEnd(34)} ${only} ms   （+${only - bare}）`);
}
const withBridge = await startupMs(['-e', BRIDGE], 2);
console.log(`③ + 我们的 piggy-bridge                 ${withBridge} ms   （+${withBridge - bare}）`);
const withGuard = await startupMs(['-e', BRIDGE, '-e', GUARD], 2);
console.log(`④ + 守卫 piggy-guard                    ${withGuard} ms   （+${withGuard - bare}）`);
console.log('');

if (session) {
  const t0 = performance.now();
  const { child, call } = open(
    ['--mode', 'rpc', '--session', session.path, '--tools', 'read,grep,find,ls'],
    REPO,
  );
  await call('get_state');
  console.log(`⑤ 起进程 + get_state（含会话文件）       ${Math.round(performance.now() - t0)} ms`);
  const entries = await call('get_entries');
  console.log(
    `⑥ 我们的游标初始化 get_entries(None)     ${Math.round(entries.ms)} ms   ` +
      `（回包 ${(entries.bytes / 1048576).toFixed(2)} MB / ${entries.msg?.data?.entries?.length ?? '?'} 条` +
      ` —— 只要里面的 leafId；2026-09-23 已挪到后台）`,
  );
  child.kill();
}

console.log('');
console.log('没量到的两段（要真机/真浏览器，见 docs/05 §「打开会话的 1 秒花在哪」）：');
console.log('  · 我们的尾页 session_page + 轮廓 session_outline：11 MB 会话实测 15.5 + 8.8 ms');
console.log('  · 前端 store/面板/首屏渲染：重的尾页实测 ≈ 50~100 ms（Playwright + mock）');
