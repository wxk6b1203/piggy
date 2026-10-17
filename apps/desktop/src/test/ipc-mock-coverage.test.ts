// @vitest-environment node
/**
 * **mock 覆盖对账**：前端调用过的每个命令，要么在 `mockBackend` 里有 handler，
 * 要么落在下面这份**显式白名单**里（白名单本身要写清为什么可以没有）。
 *
 * 为什么需要这条：浏览器门禁（`ui:startup`，26 段真布局核对）跑的是 **mock IPC**。
 * 一个命令没有 mock，`mockInvoke` 会走兜底分支 —— 从前是 `console.debug` 后**静默返回 `{}`**：
 * 界面上"点了没反应"，门禁**全绿**。docs/14 §6 把这一类记作 mock 的结构性风险
 * （"mock 比真机宽松，等于把 bug 藏起来"）。现在兜底会 `console.warn`，
 * 而这条用例把"有没有 handler"在**静态**上钉死，省得漏网的命令只在真机上炸。
 *
 * 与 `ipc-names.test.ts` 的分工：那条管"前端调的名字 Rust 里注册过吗"（跨语言契约），
 * 这条管"mock 能不能真的应答"（门禁可信度）。两条都扫同一份字面量清单。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

/**
 * 可以**没有** mock handler 的命令，逐条给理由。
 *
 * 判据是"调用方不读返回值，且真机上它确实只做一件没有界面表现的事"。
 */
const ALLOWED_WITHOUT_HANDLER = new Map<string, string>([
  // 2026-10-17 起 `pty_*` 四条**都有 mock handler**（内嵌终端接上了，浏览器里也要能敲）——
  // 所以它们从这张白名单里退出；白名单只剩"确实没有界面表现"的命令。
]);

/*
 * `pty_*` 现在有 handler：`pty_open` 回一个 id 并推欢迎行（带 cwd），
 * `pty_write` 回显输入、回车给提示符，`pty_resize` 空转，`pty_close` 删表并推 exited。
 */

/*
 * 另外两条**不在这张表里**，但也不由这条用例覆盖，写在这里免得下一个人以为漏了：
 *   · `webview_log`：ErrorBoundary 走的是 `internals.invoke('webview_log', …)`
 *     而不是 `cmd('…')`（它要绕开 `lib/ipc` 的包装以免出错时再出错），
 *     所以字面量扫描扫不到它 —— 由门禁的"没有实现的 mock"警告那条兜住；
 *   · `pty_out:<id>` 这类**通道**不是命令，不归这条用例管。
 */

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** 前端调用过的命令名（与 `ipc-names.test.ts` 同一套口径：只认字面量、去掉注释与测试目录）。 */
function invokedCommands(): Set<string> {
  const found = new Set<string>();
  for (const file of walk(SRC)) {
    if (file.endsWith(join('lib', 'ipc.ts'))) continue;
    if (file.includes(`${join('src', 'test')}`)) continue;
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const m of text.matchAll(/\bcmd(?:<[^>]*>)?\(\s*'([a-z0-9_]+)'/g)) {
      if (m[1] !== undefined) found.add(m[1]);
    }
  }
  return found;
}

/** `handlers` 表里的键（`const handlers: Record<…> = { name: (a) => …, }`）。 */
function mockHandlers(): Set<string> {
  const text = readFileSync(join(SRC, 'lib', 'mockBackend.ts'), 'utf8');
  const start = text.indexOf('const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {');
  if (start < 0) throw new Error('mockBackend.ts 里找不到 handlers 表');
  // 表以行首 `};` 结束（表内所有条目都是两空格缩进的 `name: …`）
  const end = text.indexOf('\n};', start);
  if (end < 0) throw new Error('handlers 表没有结束标记');
  const body = text.slice(start, end);
  const keys = new Set<string>();
  for (const m of body.matchAll(/^ {2}([a-z0-9_]+):/gm)) {
    if (m[1] !== undefined) keys.add(m[1]);
  }
  return keys;
}

/** `mockInvoke` 在查表**之前**就拦下来的命令（`if (name === 'pi_prompt' || …)`）。 */
function earlyIntercepted(): Set<string> {
  const text = readFileSync(join(SRC, 'lib', 'mockBackend.ts'), 'utf8');
  const out = new Set<string>();
  for (const m of text.matchAll(/name === '([a-z0-9_]+)'/g)) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  // 表里也可以有，两者取并集
  return out;
}

describe('mock 覆盖', () => {
  const invoked = invokedCommands();
  const handled = new Set([...mockHandlers(), ...earlyIntercepted()]);

  it('扫描本身有效（两侧都非空，否则这条门禁是空转）', () => {
    expect(invoked.size, '没有扫到任何 cmd(\'…\') 字面量').toBeGreaterThan(20);
    expect(handled.size, 'handlers 表一个键都没解析出来（正则或格式变了）').toBeGreaterThan(20);
  });

  it('前端调用的每个命令都有 mock handler（或落在显式白名单）', () => {
    const missing = [...invoked]
      .filter((name) => !handled.has(name) && !ALLOWED_WITHOUT_HANDLER.has(name))
      .sort();
    expect(
      missing,
      `这些命令在 mock 里没有实现：${missing.join(', ')}\n` +
        '门禁跑在 mock 上，缺 handler 会让相关界面静默失效（兜底只 warn + 返回 {}）。\n' +
        '要么补 handler，要么在 ALLOWED_WITHOUT_HANDLER 里写清为什么可以没有。',
    ).toEqual([]);
  });

  it('白名单不许过期（写进去的命令必须真的还有人调用）', () => {
    const stale = [...ALLOWED_WITHOUT_HANDLER.keys()].filter((name) => !invoked.has(name));
    expect(stale, `白名单里这些命令已经没人调用了，删掉它们：${stale.join(', ')}`).toEqual([]);
  });

  it('白名单不许和真 handler 重复（重复说明理由写错了）', () => {
    const dup = [...ALLOWED_WITHOUT_HANDLER.keys()].filter((name) => mockHandlers().has(name));
    expect(dup, `这些命令其实有 handler，不该留在白名单：${dup.join(', ')}`).toEqual([]);
  });
});
