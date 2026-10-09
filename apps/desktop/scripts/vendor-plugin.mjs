#!/usr/bin/env node
/**
 * **把第三方 pi 插件收进随包分发的目录**（docs/17 §2.2b）。
 *
 * 目标机器上很可能没有 node/npm，而 pi 的包管理器要 spawn 系统 `npm` —— 所以 Piggy 的
 * 策略是**把插件源码收进 `resources/pi-plugins/<name>/`，用 `pi --extension <dir>` 注入**。
 * 这个脚本负责"收"这一半，并且把三件容易烂掉的事钉住：
 *
 *  1. **出处**：`vendor.json` 记来源路径、上游 commit/版本、许可证、每个文件的 sha256；
 *  2. **许可证**：上游必须能说清许可证（有 `LICENSE*` 文件，或 `package.json` 里写了 SPDX）。
 *     没有就**拒绝收录** —— 随包分发别人的代码不给许可证是不可接受的；
 *  3. **漂移**：`--check` 重新算哈希，与 `vendor.json` 比对（本地被改过 / 上游又动了都能发现）。
 *
 * 用法：
 *   node scripts/vendor-plugin.mjs --from ~/Project/pi-todo --name pi-todo \
 *        --entry index.ts --tools todo_enable,todo_write --commands todos
 *   node scripts/vendor-plugin.mjs --check        # 核对所有已收录插件（CI 跑这条）
 *
 * 收进来之后还要做的两件事（脚本会提醒）：把名字加进 Rust 的
 * `config/app.rs::default_bundled_plugins()`，以及跑一次 `scripts/pi-plugin-probe.mjs`。
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGINS_DIR = join(HERE, '..', 'src-tauri', 'resources', 'pi-plugins');

/** 不许收进来的东西（构建产物、依赖、版本库、编辑器临时文件）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.turbo', '.cache', 'test', 'tests']);
const SKIP_FILE = /^(\.DS_Store|\.tmp-|.*\.log$|tsconfig\.tsbuildinfo$)/;

/**
 * 解析命令行参数。
 *
 * @param argv - `process.argv.slice(2)`
 * @returns 选项
 */
function parseArgs(argv) {
  const out = {
    check: false,
    from: null,
    name: null,
    entry: null,
    tools: [],
    commands: [],
    title: '',
    // 收录来源的**短标签**（写进清单描述；默认取源目录名）
    sourceLabel: null,
    // 覆盖型插件（顶替 pi 内置工具，如 pi-guardrails）用 --no-allowlist：
    // 它的工具名**不进**限制档位的 --tools 白名单，否则只读档会凭空获得写能力
    allowlist: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--entry') out.entry = argv[++i];
    else if (a === '--tools') out.tools = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--commands') out.commands = String(argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--title') out.title = argv[++i] ?? '';
    else if (a === '--no-allowlist') out.allowlist = false;
    else if (a === '--source-label') out.sourceLabel = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

/** 一个文件的 sha256。 */
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/**
 * 递归列出要收录的文件（相对路径）。
 *
 * @param root - 源目录
 * @param dir - 当前目录（首次调用传 root）
 * @returns 相对路径列表（已排序）
 */
function listFiles(root, dir = root) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = relative(root, full);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name)) continue;
      out.push(...listFiles(root, full));
      continue;
    }
    if (SKIP_FILE.test(name)) continue;
    out.push(rel.split(sep).join('/'));
  }
  return out;
}

/** 上游许可证：优先 LICENSE* 文件，其次 package.json 的 license 字段。 */
function licenseOf(from) {
  const licenseFile = readdirSync(from).find((f) => /^licen[cs]e/i.test(f));
  if (licenseFile) {
    const text = readFileSync(join(from, licenseFile), 'utf8');
    /* 有 LICENSE 文件时**仍然读一次 SPDX**（2026-10-09）：清单里的 `license` 字段
       会显示在设置页，而 `spdx: null` 写出来是"见 LICENSE"—— 用户看到的是
       "不知道什么许可"。文件优先（正文是权威），SPDX 只作为标签；两者不一致时
       以文件为准并在控制台提一句。 */
    const pkgPath = join(from, 'package.json');
    let spdx = null;
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.license === 'string') spdx = pkg.license;
    }
    if (spdx && !new RegExp(spdx, 'i').test(text)) {
      console.warn(`⚠️  ${from}：LICENSE 正文里没有出现 package.json 声明的 "${spdx}"，以文件为准`);
    }
    return { file: licenseFile, spdx, text };
  }
  const pkgPath = join(from, 'package.json');
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const spdx = typeof pkg.license === 'string' ? pkg.license : null;
    if (spdx) return { file: null, spdx, text: MIT_TEXT(spdx) };
  }
  return null;
}

/** 没带 LICENSE 文件时按 SPDX 补一份常见许可证正文（只支持 MIT —— 别的宁可让人工补）。 */
function MIT_TEXT(spdx) {
  if (!/^MIT$/i.test(spdx)) {
    throw new Error(
      `上游只写了 license=${spdx} 而没有 LICENSE 文件：请人工把许可证正文放进插件目录` +
        '（随包分发别人的代码必须带许可证正文）',
    );
  }
  return `MIT License

Copyright (c) 上游作者（见 vendor.json 的 source）

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

/** 读 git 的上游信息（不是 git 仓库就返回 null）。 */
function gitInfo(dir) {
  try {
    return {
      commit: execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      dirty: execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).trim() !== '',
    };
  } catch {
    return null;
  }
}

/** 收录一个插件。 */
function vendor(opts) {
  if (!opts.from || !opts.name) throw new Error('缺少 --from / --name');
  const from = resolve(opts.from);
  opts.sourceLabel ??= basename(from);
  if (!existsSync(from)) throw new Error(`源目录不存在：${from}`);
  const entry = opts.entry ?? (existsSync(join(from, 'index.js')) ? 'index.js' : 'index.ts');
  if (!existsSync(join(from, entry))) throw new Error(`入口文件不存在：${join(from, entry)}`);
  const license = licenseOf(from);
  if (!license) throw new Error('上游没有 LICENSE 文件、package.json 里也没有 license 字段：拒绝收录');
  const clone = opts.tools.length === 0 && opts.commands.length === 0;
  if (clone) {
    throw new Error(
      '必须显式写 --tools / --commands：清单里的工具名会被加进限制档位的 --tools 白名单，' +
        '猜错就等于告诉模型"你有这个工具"而它并不存在。\n' +
        '（如果这个插件是**覆盖型**的 —— 顶替 pi 内置工具，如 pi-guardrails 的 write/edit —— ' +
        '再加 --no-allowlist，让"不进白名单"是一个写下来的决定）',
    );
  }

  const dest = join(PLUGINS_DIR, opts.name);
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  const files = {};
  for (const rel of listFiles(from)) {
    // 只收入口、src/** 与许可证/说明文档：测试、脚本、设计文档不进随包产物
    const top = rel.split('/')[0];
    const keep = rel === entry || top === 'src' || rel === license.file || /^readme/i.test(rel) || top === 'skills' || top === 'prompts' || top === 'agents';
    if (!keep) continue;
    const target = join(dest, rel);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(from, rel), target);
    files[rel] = sha256(target);
  }
  writeFileSync(join(dest, 'LICENSE'), license.text);

  const info = gitInfo(from);
  const manifest = {
    name: opts.name,
    title: opts.title || opts.name,
    // ⚠️ 描述会**显示在设置页**，别把开发机的绝对路径写进去（2026-10-09 修：
    // 原来写的是 `收录自 /Users/…/pi-todo`，用户看到的是维护者的目录结构）
    description: `随 Piggy 分发的第三方 pi 插件（收录自上游 ${opts.sourceLabel ?? opts.name}）`,
    license: license.spdx ?? '见 LICENSE',
    entry,
    tools: opts.tools,
    commands: opts.commands,
    /* `allowlist` 只在**关掉**时写出来：开着是默认行为，写进每一份清单反而像噪声。
       覆盖型插件（顶替 pi 内置 write/edit 的那种）必须显式关掉 —— 否则限制档位会
       凭空获得这些能力（`pi/plugins.rs` 的 `Manifest::allowlist`）。 */
    ...(opts.allowlist ? {} : { allowlist: false }),
  };
  writeFileSync(join(dest, 'piggy-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(dest, 'vendor.json'),
    `${JSON.stringify(
      {
        name: opts.name,
        source: {
          /* `path` 留开发机的绝对路径是**有意的**：它是"从哪儿收录的"的现场记录，
             换机器后它当然不存在 —— 真正的可复现锚点是同一份 `files` 里的 sha256
             （`--check` 只重算哈希，不碰这个路径）。 */
          path: from,
          // 给用户看的短标签（不带绝对路径；描述与界面用这个）
          label: opts.sourceLabel ?? opts.name,
          commit: info?.commit ?? null,
          dirty: info?.dirty ?? null,
          licenseFile: license.file,
          spdx: license.spdx,
        },
        vendoredAt: new Date().toISOString(),
        files,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`✅ 收录 ${opts.name} → ${relative(process.cwd(), dest)}（${Object.keys(files).length} 个文件）`);
  console.log('   还要做：① 把名字加进 config/app.rs::default_bundled_plugins()；② 跑 scripts/pi-plugin-probe.mjs');
  return 0;
}

/** 核对所有已收录插件（漂移检测）。 */
function check() {
  const names = readdirSync(PLUGINS_DIR).filter((n) => existsSync(join(PLUGINS_DIR, n, 'vendor.json')));
  if (names.length === 0) {
    console.log('没有收录任何第三方插件（只有仓库自带的那些）');
    return 0;
  }
  let bad = 0;
  for (const name of names) {
    const dir = join(PLUGINS_DIR, name);
    const v = JSON.parse(readFileSync(join(dir, 'vendor.json'), 'utf8'));
    const problems = [];
    for (const [rel, want] of Object.entries(v.files)) {
      const file = join(dir, rel);
      if (!existsSync(file)) problems.push(`缺文件 ${rel}`);
      else if (sha256(file) !== want) problems.push(`内容被改过 ${rel}`);
    }
    if (!existsSync(join(dir, 'LICENSE'))) problems.push('缺 LICENSE');
    if (!existsSync(join(dir, 'piggy-plugin.json'))) problems.push('缺 piggy-plugin.json');
    if (problems.length > 0) {
      bad += 1;
      console.error(`❌ ${name}：\n     ${problems.join('\n     ')}`);
    } else {
      console.log(`✅ ${name}（${Object.keys(v.files).length} 个文件，来源 ${v.source.path}${v.source.commit ? ` @ ${v.source.commit.slice(0, 8)}` : ''}）`);
    }
  }
  return bad === 0 ? 0 : 1;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.help) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]);
  process.exit(0);
}
try {
  process.exit(opts.check ? check() : vendor(opts));
} catch (e) {
  console.error(`❌ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
