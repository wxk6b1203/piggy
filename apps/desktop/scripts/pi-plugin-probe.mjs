#!/usr/bin/env node
/**
 * **真机插件探针**（docs/06 §7）：用系统上真的 pi 跑一遍，核对三件在 mock 里量不到的事。
 *
 * 门禁（`ui-startup-check.mjs`）跑在浏览器 + mock 上，它能证明"卡片长什么样、回答怎么回去"，
 * 但证明不了"pi 到底认不认这个插件目录"。这个脚本补上那一段：
 *
 *  1. **能加载**：`pi -e <plugin dir>` 起得来，且插件声明的命令/工具真的在
 *     （`get_commands` 里的 `plan`/`plan-off`，`getAllTools()` 里的两个工具）；
 *  2. **白名单的真相**：`--tools read` 之下插件工具**消失**，`--tools read,ask_user_question,…`
 *     之下它们在 —— 这就是 `pi/plugins.rs` 要把清单里的工具名加进白名单的理由；
 *  3. **重复加载会炸**：同一个插件从**两个不同路径**注入时，pi 报
 *     `Tool "x" conflicts with …` 并且进不了会话 —— 这就是 `pi/plugins.rs::resolve`
 *     宁可不注入也要挡住"用户自己装过一份"的理由。
 *
 * 用法：
 *   node scripts/pi-plugin-probe.mjs            # 用 PATH 里的 pi
 *   PI=/path/to/pi node scripts/pi-plugin-probe.mjs
 *
 * 没有 pi 时**跳过并成功退出**（CI 上不一定装了 pi）；有 pi 但哪一条不成立就红。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(HERE, '..', 'src-tauri', 'resources', 'pi-plugins');
const PLUGIN = join(PLUGINS_DIR, 'pi-ask');
/** 随包分发的全部插件（每个都要能在真 pi 上加载起来）。 */
const ALL_PLUGINS = readdirSync(PLUGINS_DIR)
  .filter((n) => existsSync(join(PLUGINS_DIR, n, 'piggy-plugin.json')))
  .sort()
  .map((n) => ({ name: n, dir: join(PLUGINS_DIR, n) }));
const PI = process.env.PI ?? 'pi';

/**
 * 起一次 pi（RPC 模式），发一条请求，收 stderr/stdout。
 *
 * @param {string[]} args - 额外参数（不含 `--mode rpc` 等公共部分）
 * @param {object} req - 要发的 RPC 请求
 * @param {number} waitMs - 最多等多久
 * @returns {Promise<{out: string, err: string, code: number|null, responded: boolean}>}
 */
function runPi(args, req, waitMs = 12_000) {
  return new Promise((resolve) => {
    const child = spawn(PI, ['--mode', 'rpc', '--no-session', '--no-extensions', ...args], {
      cwd: tmpdir(),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    let responded = false;
    child.stdout.on('data', (d) => {
      out += String(d);
      if (out.includes('"type":"response"')) responded = true;
    });
    child.stderr.on('data', (d) => {
      err += String(d);
    });
    const timer = setTimeout(() => child.kill(), waitMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ out, err, code, responded });
    });
    child.stdin.write(`${JSON.stringify(req)}\n`);
    // pi 起完就读 stdin；给一点时间再关，避免请求还没被读到
    setTimeout(() => child.stdin.end(), waitMs - 1_500);
  });
}

/** 打印一条结论。 */
function report(ok, label, detail = '') {
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? `\n     ${detail}` : ''}`);
  return ok;
}

const problems = [];
const tmp = mkdtempSync(join(tmpdir(), 'piggy-plugin-probe-'));
try {
  // ── 0. pi 在不在
  const version = await new Promise((resolve) => {
    const c = spawn(PI, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let s = '';
    c.stdout.on('data', (d) => (s += String(d)));
    c.on('error', () => resolve(null));
    c.on('close', () => resolve(s.trim()));
  });
  if (!version) {
    console.log(`⚠️  没有找到 pi（PI=${PI}）—— 跳过真机探针（这不是失败）`);
    process.exit(0);
  }
  console.log(`pi: ${version}\n插件: ${PLUGIN}\n`);

  // ── 0b. 每个随包插件都要能加载（收录进来的第三方插件同样）
  for (const p of ALL_PLUGINS) {
    const manifest = JSON.parse(readFileSync(join(p.dir, 'piggy-plugin.json'), 'utf8'));
    const probeFile = join(tmp, `probe-${p.name}.js`);
    writeFileSync(
      probeFile,
      [
        'export default function probe(pi) {',
        "  pi.on('session_start', () => {",
        '    process.stderr.write(`PROBE tools=${JSON.stringify((pi.getAllTools?.() ?? []).map((t) => t.name).sort())}\n`);',
        '  });',
        '}',
        '',
      ].join('\n'),
    );
    const res = await runPi(['-e', p.dir, '-e', probeFile], { type: 'get_state', id: 1 });
    const got = /PROBE tools=\[([^\]]*)\]/.exec(res.err)?.[1] ?? '';
    const declared = (manifest.tools ?? []).filter((t) => got.includes(`"${t}"`));
    const ok = res.responded && declared.length === (manifest.tools ?? []).length;
    if (
      !report(
        ok,
        `${p.name} 能被真 pi 加载，申报的工具都在`,
        `responded=${res.responded} declared=${JSON.stringify(declared)} all=${got}`,
      )
    ) {
      problems.push(`${p.name} 加载`);
    }
  }

  // ── 1. 能加载 + 命令/工具都在
  const probe = join(tmp, 'probe.js');
  writeFileSync(
    probe,
    [
      'export default function probe(pi) {',
      "  pi.on('session_start', () => {",
      '    process.stderr.write(`PROBE tools=${JSON.stringify((pi.getAllTools?.() ?? []).map((t) => t.name).sort())}\\n`);',
      '  });',
      '}',
      '',
    ].join('\n'),
  );
  const loaded = await runPi(['-e', PLUGIN, '-e', probe], { type: 'get_commands', id: 1 });
  const commands = /"(plan|plan-off)"/.test(loaded.out) && loaded.out.includes('"plan"');
  const tools = /PROBE tools=\[([^\]]*)\]/.exec(loaded.err)?.[1] ?? '';
  if (!report(loaded.responded && commands, '插件能加载，`/plan` 命令在（pi 认这个目录）', `stderr: ${loaded.err.trim().split('\n').slice(0, 2).join(' | ')}`)) {
    problems.push('插件加载/命令');
  }
  if (!report(tools.includes('ask_user_question') && tools.includes('exit_plan_mode'), '两个工具都注册上了（完全权限档）', `all=${tools}`)) {
    problems.push('工具注册');
  }

  // ── 2. 白名单的真相（D2 的证据）
  const restricted = await runPi(['-e', PLUGIN, '-e', probe, '--tools', 'read'], { type: 'get_state', id: 1 });
  const restrictedTools = /PROBE tools=\[([^\]]*)\]/.exec(restricted.err)?.[1] ?? '';
  if (
    !report(
      restrictedTools === '"read"',
      '`--tools read` 之下插件工具**被过滤掉**（所以清单里的名字必须加进白名单）',
      `all=${restrictedTools}`,
    )
  ) {
    problems.push('白名单过滤');
  }
  const allowed = await runPi(
    ['-e', PLUGIN, '-e', probe, '--tools', 'read,ask_user_question,exit_plan_mode'],
    { type: 'get_state', id: 1 },
  );
  const allowedTools = /PROBE tools=\[([^\]]*)\]/.exec(allowed.err)?.[1] ?? '';
  if (
    !report(
      allowedTools.includes('ask_user_question') && allowedTools.includes('exit_plan_mode') && allowedTools.includes('read'),
      '把工具名加进 `--tools` 之后插件工具回来了（`pi/plugins.rs` 的策略成立）',
      `all=${allowedTools}`,
    )
  ) {
    problems.push('白名单放行');
  }

  /* ── 2b. 覆盖型插件 + 路径守卫：限制档的边界仍然成立（2026-10-09 加）
     这是 docs/17 §2.2b 纪律 5 的真机侧：pi-guardrails 注册的是**内置同名**
     `write`/`edit`（写前校验），而 `piggy-guard.js` 的"工作区内修改"边界挂在
     **`tool_call` 钩子**上 —— pi 的会话层按**工具名**触发它
     （`agent-session.ts::_beforeToolCall`），与"这个工具是谁注册的"无关。
     所以两者同时注入时，限制档必须仍然能把 write/edit 拿到工具表外面。
     断言的是**组合结果**（守卫 + 覆盖型插件 + `--tools`），不是加载成功而已。 */
  const guardrails = ALL_PLUGINS.find((p) => p.name === 'pi-guardrails');
  const guard = join(HERE, '..', 'src-tauri', 'resources', 'piggy-guard.js');
  if (guardrails && existsSync(guard)) {
    const combo = await runPi(
      ['-e', guard, '-e', guardrails.dir, '-e', probe, '--tools', 'read,grep,find,ls'],
      { type: 'get_state', id: 1 },
    );
    const comboTools = /PROBE tools=\[([^\]]*)\]/.exec(combo.err)?.[1] ?? '';
    const noWriters = !/"write"/.test(comboTools) && !/"edit"/.test(comboTools);
    if (
      !report(
        combo.responded && noWriters,
        '覆盖型插件 + 路径守卫下，限制档仍然拿掉了 write/edit（`allowlist:false` 的边界成立）',
        `responded=${combo.responded} all=${comboTools}`,
      )
    ) {
      problems.push('覆盖型插件与权限边界');
    }
    /* 反向：**完全权限档**（不传 `--tools`）下两个工具都要在 —— 否则说明
       pi-guardrails 在组合里根本没注册上，上面那条就成了"永远绿"。 */
    const comboFull = await runPi(['-e', guard, '-e', guardrails.dir, '-e', probe], {
      type: 'get_state',
      id: 1,
    });
    const fullTools = /PROBE tools=\[([^\]]*)\]/.exec(comboFull.err)?.[1] ?? '';
    if (
      !report(
        comboFull.responded && /"write"/.test(fullTools) && /"edit"/.test(fullTools),
        '完全权限档下 `write`/`edit` 都在（上面那条不是"永远绿"）',
        `all=${fullTools}`,
      )
    ) {
      problems.push('覆盖型插件注册');
    }
  }

  // ── 3. 重复加载会炸（D1 的证据）
  const copy = join(tmp, 'pi-ask-copy');
  cpSync(PLUGIN, copy, { recursive: true });
  const dup = await runPi(['-e', PLUGIN, '-e', copy], { type: 'get_state', id: 1 });
  const conflicted = /conflicts with/.test(dup.err) && !dup.responded;
  if (
    !report(
      conflicted,
      '两份同名插件（两个不同路径）→ pi 直接不进会话（所以 Piggy 必须先挡住）',
      `responded=${dup.responded} stderr: ${dup.err.trim().split('\n')[0] ?? ''}`,
    )
  ) {
    problems.push('重复加载');
  }
  const sameTwice = await runPi(['-e', PLUGIN, '-e', PLUGIN], { type: 'get_state', id: 1 });
  report(
    sameTwice.responded,
    '同一个路径传两次 pi 会自己去重（所以 Piggy 只需要挡"另一个路径的同名插件"）',
  );
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(`\n❌ 真机探针失败：${problems.join('、')}`);
  process.exit(1);
}
console.log('\n✅ 真机探针全部通过');
