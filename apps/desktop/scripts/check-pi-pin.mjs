/**
 * pi 版本锚点的一致性检查（CI 门禁 + 本地随手可跑）。
 *
 * ## 为什么需要它
 *
 * "Piggy 与哪个 pi 一起验证过"这件事**散落在六个地方**，而升级时漏改任何一处都
 * **不会报错**，只会静默漂移：
 *
 * ```text
 * ① apps/desktop/scripts/fetch-pi-standalone.mjs   默认 --version（full SKU 下载哪个）
 * ② .github/workflows/ci.yml                       契约作业装哪个版本
 * ③ src-tauri/src/provider/catalog_generated.rs    提供商目录快照（生成物）
 * ④ src-tauri/src/plugin/builtins_generated.rs     内置扩展表快照（生成物）
 * ⑤ packages/piggy-bridge/package.json             bridge 类型校验对着哪一版
 * ⑥ THIRD_PARTY_NOTICES.md                         给用户看的"捆的是哪一版"
 * ```
 *
 * 2026-10-09 实测踩到：pi 已经升到 1.1.0，而 ①②③④⑤⑥ 全都还写着 0.87.x，
 * CI 里也没有任何一条会发现（生成器的 `--check` 需要 pi **源码**，CI 只有 npm 包）。
 * 这个脚本用"锚点之间互相对账"补上那个缺口 —— 它不验证"生成物与 pi 源码一致"
 * （那要靠 `gen-*.mjs --check`，本地有源码时跑），只保证"六处说的是同一版本"。
 *
 * 用法：
 *   node apps/desktop/scripts/check-pi-pin.mjs               # 对账六处锚点
 *   node apps/desktop/scripts/check-pi-pin.mjs --installed   # 再比一次 `pi --version`
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, '..', '..', '..');
const APP = join(ROOT, 'apps', 'desktop');

const read = (p) => readFileSync(p, 'utf8');
const grab = (file, re, what) => {
  const m = re.exec(read(file));
  if (!m) {
    console.error(`❌ ${what}：在 ${file.replace(`${ROOT}/`, '')} 里没找到版本号（正则失配，可能是文件被改写）`);
    process.exit(2);
  }
  return m[1];
};

const fetchScript = join(APP, 'scripts', 'fetch-pi-standalone.mjs');
const pin = grab(fetchScript, /const VERSION = arg\('--version', '([^']+)'\)/, 'full SKU 下载版本');

const anchors = [
  [
    '① full SKU 下载版本',
    pin,
    pin,
  ],
  [
    '② CI 契约作业安装的版本',
    grab(join(ROOT, '.github', 'workflows', 'ci.yml'), /pi-coding-agent@([0-9][^\s"']*)/, 'CI 安装版本'),
    pin,
  ],
  [
    '③ provider 目录快照',
    grab(
      join(APP, 'src-tauri', 'src', 'provider', 'catalog_generated.rs'),
      /数据来源：pi v([0-9][^\s（(]*)/,
      '提供商目录快照版本',
    ),
    pin,
  ],
  [
    '④ 内置扩展表快照',
    grab(
      join(APP, 'src-tauri', 'src', 'plugin', 'builtins_generated.rs'),
      /数据来源：pi v([0-9][^\s（(]*)/,
      '内置扩展表快照版本',
    ),
    pin,
  ],
  [
    '⑤ piggy-bridge 的类型校验版本',
    grab(join(ROOT, 'packages', 'piggy-bridge', 'package.json'), /"@earendil-works\/pi-coding-agent": "([^"]+)"/, 'bridge devDependency'),
    pin,
  ],
  [
    '⑥ THIRD_PARTY_NOTICES 里写给用户的版本',
    grab(join(ROOT, 'THIRD_PARTY_NOTICES.md'), /版本见该脚本的 `--version`，当前 ([0-9][^\s）)]*)/, 'NOTICES 版本'),
    pin,
  ],
];

let bad = 0;
for (const [what, got, want] of anchors) {
  const ok = got === want;
  if (!ok) bad += 1;
  console.log(`${ok ? '✅' : '❌'} ${what}：${got}${ok ? '' : `（应为 ${want}，锚点是 fetch-pi-standalone.mjs）`}`);
}

if (process.argv.includes('--installed')) {
  let installed = '';
  try {
    installed = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim();
  } catch (e) {
    console.error(`❌ 跑不动 \`pi --version\`：${e.message}`);
    process.exit(2);
  }
  const ok = installed === pin;
  if (!ok) bad += 1;
  console.log(`${ok ? '✅' : '❌'} ⑦ 这台机器上装的 pi：${installed}${ok ? '' : `（锚点是 ${pin}）`}`);
}

if (bad > 0) {
  console.error(
    `\n${bad} 处锚点不一致。升级 pi 的正确顺序：\n` +
      '  1. node apps/desktop/scripts/gen-provider-catalog.mjs <pi 源码根>\n' +
      '  2. node apps/desktop/scripts/gen-plugin-builtins.mjs <pi 源码根>\n' +
      '  3. 改 fetch-pi-standalone.mjs 的默认 --version、ci.yml 的 @版本、\n' +
      '     packages/piggy-bridge/package.json 的 devDependency、THIRD_PARTY_NOTICES.md\n' +
      '  4. cargo test --features contract --test contract（真实 pi，C1–C15）\n' +
      '  5. node apps/desktop/scripts/check-pi-pin.mjs --installed',
  );
  process.exit(1);
}
console.log(`\n✅ pi 版本锚点一致：${pin}`);
