/**
 * piggy-bridge 打包：`src/index.ts` → `apps/desktop/src-tauri/resources/piggy-bridge.js`。
 *
 * 为什么要产物而不是直接让 pi 加载 TS 源码：Tauri 的 resource 是随包分发的**单文件**，
 * 而扩展源码在 workspace 包里（要有 pi 的类型才能被 `tsc` 校验）。产物是唯一的跨边界形态。
 *
 * 用法：
 *   node scripts/build.mjs          写入产物
 *   node scripts/build.mjs --check  只校验产物是否最新（不一致则退出码 1）
 *
 * `src/artifact.test.ts` 会在 `pnpm test` 里跑 `--check`：产物过期 = 测试失败，
 * 而不是等到用户机器上加载了旧代码才发现（这个仓库已经被"陈旧副本"坑过一次）。
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const PKG_ROOT = resolve(here, '..');
export const OUT_FILE = resolve(PKG_ROOT, '../../apps/desktop/src-tauri/resources/piggy-bridge.js');

const BANNER = `/**
 * piggy-bridge —— 由 packages/piggy-bridge/src/index.ts 打包生成，请勿直接编辑。
 * 重新生成：pnpm build:bridge     校验是否最新：pnpm --filter piggy-bridge test
 */`;

export async function buildBridge() {
  const result = await build({
    entryPoints: [resolve(PKG_ROOT, 'src/index.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    // pi 的类型导入全在 `import type` 里，esbuild 会整段擦除；这里断言产物确实零依赖。
    external: [],
    banner: { js: BANNER },
    write: false,
    logLevel: 'silent',
  });
  const out = result.outputFiles?.[0];
  if (!out) throw new Error('esbuild 没有产出文件');
  return out.text;
}

/** 产物是否与当前源码一致（供测试与 CI 使用）。 */
export async function isArtifactFresh() {
  const expected = await buildBridge();
  let actual = '';
  try {
    actual = readFileSync(OUT_FILE, 'utf8');
  } catch {
    return { fresh: false, reason: `产物不存在：${OUT_FILE}` };
  }
  return actual === expected
    ? { fresh: true }
    : { fresh: false, reason: '产物与源码不一致（需要 pnpm build:bridge）' };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes('--check');
  if (check) {
    const { fresh, reason } = await isArtifactFresh();
    if (!fresh) {
      console.error(`[piggy-bridge] ✗ ${reason}`);
      process.exit(1);
    }
    console.log('[piggy-bridge] ✓ 产物是最新的');
  } else {
    const text = await buildBridge();
    mkdirSync(dirname(OUT_FILE), { recursive: true });
    writeFileSync(OUT_FILE, text);
    console.log(`[piggy-bridge] 已写入 ${OUT_FILE}（${text.length} 字节）`);
  }
}
