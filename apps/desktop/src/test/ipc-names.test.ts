// @vitest-environment node
/**
 * **命令名对得上吗**：前端 `cmd('x')` 的字面量必须都在 Rust `generate_handler!` 里注册过。
 *
 * 起因（本轮「打开方式」）：新加了三个命令，前端拼错一个字母（或 Rust 侧改了名忘了同步）
 * 在**编译期毫无反应** —— `generate_handler!` 只检查函数存在，不检查字符串；
 * 前端也拿不到任何类型约束（`cmd<T>(name: string)` 的 `name` 就是 string）。
 * 真机上的表现是"点了报 `Command open_in_app_lst not found`"，
 * 而浏览器门禁跑的是 mock，**永远看不见**。
 *
 * 这是"跨进程字符串契约"的通用缺口，所以这条门禁扫的是全部命令，不只新的三个。
 * 反方向（注册了但前端没调用）不算错：有些命令是给脚本/契约测试用的。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SRC = resolve(__dirname, '..');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** `tauri::generate_handler![a::b, c::d]` → `{b, d}`。 */
function registeredCommands(): Set<string> {
  const lib = readFileSync(resolve(SRC, '../src-tauri/src/lib.rs'), 'utf8');
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(lib);
  const body = block?.[1];
  if (body === undefined) throw new Error('lib.rs 里找不到 generate_handler! 块');
  const names = new Set<string>();
  for (const raw of body.split(',')) {
    const token = raw.trim().replace(/\/\/.*$/s, '').trim();
    if (!token) continue;
    const last = token.split('::').pop()?.trim();
    if (last) names.add(last);
  }
  return names;
}

/** 前端调用过的命令名（只认字面量；`cmd<T>('x', …)` 与 `cmd('x', …)` 都算）。 */
function invokedCommands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    if (file.endsWith(join('lib', 'ipc.ts'))) continue; // 包装器自身
    // 测试目录整个跳过：它们**不定义**命令名，而注释里写的示例（`cmd('x')`）
    // 会被正则当成真调用 —— 第一版就是这么把自己扫红的。
    if (file.includes(`${join('src', 'test')}`)) continue;
    // 行注释也去掉：文档里提一个不存在的命令名不该算"前端调用了它"
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const m of text.matchAll(/\bcmd(?:<[^>]*>)?\(\s*'([a-z0-9_]+)'/g)) {
      const name = m[1];
      if (name === undefined) continue;
      const list = found.get(name) ?? [];
      list.push(file.slice(SRC.length + 1));
      found.set(name, list);
    }
  }
  return found;
}

/**
 * Rust 侧 `emit("通道")` 发过的通道。
 *
 * 也收格式串（`emit(&format!("plugin:log:{}", id), …)`）——这类通道前端是按前缀
 * 订阅的（`name.startsWith('plugin:')`），所以返回里同时给"精确集合"与"前缀集合"。
 */
function rustEmittedChannels(): { exact: Set<string>; prefix: string[] } {
  const exact = new Set<string>();
  const prefix: string[] = [];
  for (const file of walkRs(resolve(SRC, '../src-tauri/src'))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bemit(?:_to|_filter)?\(\s*(?:&)?(?:format!\()?"([^"]+)"/g)) {
      const ch = m[1];
      if (ch === undefined) continue;
      // `format!("plugin:log:{}")` 这类：只取 `{` 之前的部分当前缀
      const brace = ch.indexOf('{');
      if (brace >= 0) prefix.push(ch.slice(0, brace));
      else exact.add(ch);
    }
  }
  return { exact, prefix };
}

/** 前端订阅的通道：`on('x')`（真机）与 `mockOn('x')`（mock 侧的同一批通道）。 */
function subscribedChannels(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of walk(SRC)) {
    if (file.endsWith(join('lib', 'ipc.ts'))) continue;
    if (file.includes(`${join('src', 'test')}`)) continue;
    const text = readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const m of text.matchAll(/\b(?:on|mockOn)(?:<[^>]*>)?\(\s*'([^']+)'/g)) {
      const ch = m[1];
      if (ch === undefined) continue;
      const list = found.get(ch) ?? [];
      list.push(file.slice(SRC.length + 1));
      found.set(ch, list);
    }
  }
  return found;
}

/** 前端自己发的通道（`windowEvents.emit` / mock 的 `emit`）——这类不需要 Rust 侧有对应。 */
function frontendEmittedChannels(): Set<string> {
  const out = new Set<string>();
  for (const file of walk(SRC)) {
    if (file.includes(`${join('src', 'test')}`)) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/\bemit\(\s*'([^']+)'/g)) {
      const ch = m[1];
      if (ch !== undefined) out.add(ch);
    }
  }
  return out;
}

function walkRs(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walkRs(p, out);
    else if (p.endsWith('.rs')) out.push(p);
  }
  return out;
}

describe('IPC 命令名契约', () => {
  const registered = registeredCommands();
  const invoked = invokedCommands();

  it('扫描本身有效（两侧都非空，否则这条门禁是空转）', () => {
    expect(registered.size).toBeGreaterThan(30);
    expect(invoked.size).toBeGreaterThan(20);
    // 新功能这三个必须在两边都出现 —— 防止"扫描正则悄悄失效"
    for (const name of ['open_in_app_list', 'open_in_app_icon', 'open_in_app_open']) {
      expect(registered.has(name), `${name} 没注册`).toBe(true);
      expect(invoked.has(name), `${name} 没被前端调用`).toBe(true);
    }
  });

  it('前端调的每一个命令都在 Rust 里注册过', () => {
    const missing = [...invoked.entries()]
      .filter(([name]) => !registered.has(name))
      .map(([name, files]) => `${name}（${[...new Set(files)].join(', ')}）`);
    expect(missing).toEqual([]);
  });
});

/**
 * **事件通道对得上吗**：前端 `on('x')` 订阅的通道，必须在 Rust 里真的存在
 * （`emit("x")`），或者是前端自己发的（`windowEvents.emit` / mock 的 `emit`）。
 *
 * 与命令名同一个缺口：`on('app:open-about')` 与 Rust 的 `emit("app:open-about")`
 * 之间**没有任何类型约束**，一边拼错就是"点了菜单什么都不发生"——
 * 而浏览器门禁跑的是 mock，看不见真机那条路。
 * 加「关于与许可」时新增了 `app:open-about`，所以顺手把这条也纳入扫描。
 */
describe('IPC 事件通道契约', () => {
  const { exact, prefix } = rustEmittedChannels();
  const subscribed = subscribedChannels();
  const feEmitted = frontendEmittedChannels();

  it('扫描本身有效（两侧都非空）', () => {
    // Rust 侧目前只有 3 条精确通道（sessions:changed / fleet:changed / app:open-about）
    // + `pty:out:` 前缀通道；阈值卡在"扫到东西"而不是"扫到很多"
    expect(exact.size).toBeGreaterThanOrEqual(3);
    expect(subscribed.size).toBeGreaterThan(3);
    // 本轮新增的那条必须在两边都扫到
    expect(exact.has('app:open-about'), 'Rust 侧没扫到 app:open-about').toBe(true);
    expect(subscribed.has('app:open-about'), '前端没订阅 app:open-about').toBe(true);
  });

  it('前端订阅的每个通道都有出处', () => {
    const orphans = [...subscribed.entries()]
      .filter(([ch]) => !exact.has(ch) && !feEmitted.has(ch) && !prefix.some((p) => ch.startsWith(p)))
      .map(([ch, files]) => `${ch}（${[...new Set(files)].join(', ')}）`);
    expect(orphans).toEqual([]);
  });
});
