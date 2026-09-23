/**
 * 捆绑 pi standalone（docs/08 §7.1，M2 独立发布）。
 *
 * 从 pi GitHub Releases 下载对应 target triple 的 standalone 资产，
 * SHA256 校验后解包到 src-tauri/resources/pi/，供 tauri.full.conf.json 的
 * bundle.resources 随 full SKU 分发（lite SKU 不执行本脚本即可）。
 *
 * 用法：
 *   node scripts/fetch-pi-standalone.mjs [--version 0.87.0]
 * 环境变量：
 *   PI_STANDALONE_URL   资产直链模板（{VERSION}/{TRIPLE}/{EXT} 占位）
 *   PI_STANDALONE_FILE  本地已下载资产（跳过下载，仅校验+安装）
 *   PI_SHA256           资产 sha256 十六进制（必填；正式发布强制校验，08 §7.1）
 *
 * 退出码：0 成功；非 0 失败。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const OUT_DIR = join(DESKTOP, 'src-tauri', 'resources', 'pi');

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const VERSION = arg('--version', '0.87.0');
const TRIPLE = `${process.platform}-${process.arch}`; // darwin-arm64 / linux-arm64 / linux-x64 / windows-x64
const EXT = process.platform === 'win32' ? 'zip' : 'tar.gz';
const URL_TEMPLATE =
  process.env.PI_STANDALONE_URL ??
  `https://github.com/earendil-works/pi/releases/download/v{VERSION}/pi-standalone-{TRIPLE}.{EXT}`;

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (u, redirects) => {
      if (redirects > 5) return reject(new Error('重定向过多'));
      get(u, (res) => {
        if (res.statusCode >= 300 && res.headers.location) {
          res.resume();
          return follow(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}: ${u}`));
        }
        const file = createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url, 0);
  });
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function findFile(dir, name) {
  for (const entry of readdirSyncSafe(dir)) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry.name === name) {
      return p;
    }
  }
  return null;
}

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const localFile = process.env.PI_STANDALONE_FILE;
  const url = URL_TEMPLATE.replace('{VERSION}', VERSION)
    .replace('{TRIPLE}', TRIPLE)
    .replace('{EXT}', EXT);
  const archive = localFile ?? join(OUT_DIR, `pi-standalone.${EXT}`);

  if (localFile) {
    if (!existsSync(localFile)) throw new Error(`本地资产不存在: ${localFile}`);
  } else {
    console.log(`[fetch-pi] 下载 ${url}`);
    await download(url, archive);
  }
  if (!statSync(archive).size) throw new Error('资产为空');

  // SHA256 校验（08 §7.1：校验不过直接失败）
  const expected = process.env.PI_SHA256;
  if (expected) {
    const actual = sha256File(archive);
    if (actual !== expected.toLowerCase().trim()) {
      throw new Error(`SHA256 不匹配：期望 ${expected}，实际 ${actual}`);
    }
    console.log(`[fetch-pi] SHA256 校验通过 ${actual.slice(0, 12)}…`);
  } else {
    console.warn('[fetch-pi] 警告：未设置 PI_SHA256，跳过校验（正式发布必须开启，08 §7.1）');
  }

  // 解包（macOS/linux tar 原生；windows 10+ 自带 bsdtar 可解 zip）
  const binName = process.platform === 'win32' ? 'pi.exe' : 'pi';
  const tmp = join(OUT_DIR, '.unpack');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const flag = EXT === 'zip' ? '-xf' : '-xzf';
  const tar = spawnSync('tar', [flag, archive, '-C', tmp], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('解包失败');
  const unpackedBin = findFile(tmp, binName);
  if (!unpackedBin) throw new Error(`解包产物中未找到 ${binName}`);
  const finalBin = join(OUT_DIR, binName);
  renameSync(unpackedBin, finalBin);
  if (process.platform !== 'win32') chmodSync(finalBin, 0o755);
  rmSync(tmp, { recursive: true, force: true });
  if (!localFile) rmSync(archive, { force: true });
  console.log(`[fetch-pi] 已安装 ${finalBin}（pi v${VERSION}，full SKU 打包用）`);
}

main().catch((e) => {
  console.error('[fetch-pi] 失败:', e.message);
  process.exit(1);
});
