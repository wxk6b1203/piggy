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
