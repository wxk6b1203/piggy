/**
 * 捆绑 pi standalone（docs/08 §7.1，M2 独立发布）。
 *
 * 从 pi GitHub Releases 下载对应平台资产的 **完整分发包**，校验 SHA256 后解包到
 * `src-tauri/resources/pi/`，供 `tauri.full.conf.json` 的 `bundle.resources` 随 full SKU 分发
 * （lite SKU 不执行本脚本）。
 *
 * ## 资产命名（实证，不是猜的）
 * pi 的 release 资产是 `pi-{os}-{arch}.{ext}`，os ∈ darwin|linux|windows：
 *   pi-darwin-arm64.tar.gz / pi-darwin-x64.tar.gz / pi-linux-arm64.tar.gz
 *   pi-linux-x64.tar.gz    / pi-windows-arm64.zip / pi-windows-x64.zip
 * 来源：`.github/workflows/build-binaries.yml` 的 `binary_assets` 数组。已用
 * `GET /repos/earendil-works/pi/releases/latest` 核对过实际资产清单。
 * 本脚本此前拼的是 `pi-standalone-{TRIPLE}.{EXT}`，**这个资产不存在**（永远 404），
 * 且 `process.platform` 在 Windows 上是 `win32` 而资产里写的是 `windows`——两个独立缺陷。
 *
 * ## 为什么不能只留二进制
 * pi 是 Bun 单文件可执行；资源按 `dirname(process.execPath)` 解析
 * （packages/coding-agent/src/config.ts:396-399 `if (isBunBinary) return dirname(process.execPath)`）。
 * 所以 `export-html/`（`pi_export_html` 用，core/export-html/index.ts:143 是无保护的 readFileSync）、
 * `theme/`、`package.json`（版本号）、`photon_rs_bg.wasm` 都必须跟二进制放在一起。
 * 只拷二进制会让"导出 HTML"在 full SKU 里直接抛异常。
 *
 * ## 用法
 *   node scripts/fetch-pi-standalone.mjs [--version 0.87.1] [--os darwin] [--arch arm64]
 * 环境变量：
 *   PI_STANDALONE_URL   资产直链模板（{VERSION}/{OS}/{ARCH}/{ASSET} 占位）
 *   PI_STANDALONE_FILE  本地已下载资产（跳过下载，仅校验+安装）——**自定义 pi 走这条**
 *   PI_SHA256           资产 sha256（不设则尝试从 release 的 SHA256SUMS 自动取）
 *   PI_SKIP_SHA256=1    显式跳过校验（仅本地调试；正式发布不要用）
 *
 * 退出码：0 成功；非 0 失败。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get } from 'node:https';

const HERE = dirname(fileURLToPath(import.meta.url));
const DESKTOP = join(HERE, '..');
const OUT_DIR = join(DESKTOP, 'src-tauri', 'resources', 'pi');

const REPO = 'earendil-works/pi';

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Node 的 platform 名 → pi 资产里的 os 名。`win32` → `windows` 是必须的映射。 */
const OS_NAME = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
if (!OS_NAME) {
  console.error(`[fetch-pi] 不支持的平台: ${process.platform}`);
  process.exit(1);
}

const VERSION = arg('--version', '0.87.1');
const OS = arg('--os', OS_NAME);
const ARCH = arg('--arch', process.arch);
const ASSET = `pi-${OS}-${ARCH}${OS === 'windows' ? '.zip' : '.tar.gz'}`;
const EXT = ASSET.endsWith('.zip') ? 'zip' : 'tar.gz';
const URL_TEMPLATE =
  process.env.PI_STANDALONE_URL ??
  `https://github.com/${REPO}/releases/download/v{VERSION}/{ASSET}`;

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

function fetchText(url) {
  return new Promise((resolve) => {
    const follow = (u, redirects) => {
      if (redirects > 5) return resolve(null);
      get(u, (res) => {
        if (res.statusCode >= 300 && res.headers.location) {
          res.resume();
          return follow(new URL(res.headers.location, u).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return resolve(null);
        }
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
      }).on('error', () => resolve(null));
    };
    follow(url, 0);
  });
}

function sha256File(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** pi 的 SHA256SUMS 是 `sha256  filename` 每行一条（coreutils 格式）。 */
function parseSums(text, asset) {
  if (!text) return null;
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2].trim() === asset) return m[1].toLowerCase();
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

/**
 * 把解包目录里**除二进制之外**的资源搬进 OUT_DIR，保留相对结构。
 *
 * 二进制被 rename 到 OUT_DIR 根（Tauri 的 resource_dir()/resources/pi/pi 是固定约定，
 * 见 lib.rs builtin_pi_path），其余目录/文件按原相对路径铺开，以维持 pi 的
 * `dirname(execPath)` 资源解析。
 */
function installAssets(unpackRoot, binPath, binName, outDir) {
  const binDir = dirname(binPath);
  const moved = [];
  const walk = (dir) => {
    for (const entry of readdirSyncSafe(dir)) {
      const src = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(src);
        continue;
      }
      if (src === binPath) continue;
      const rel = relative(binDir, src);
      const dest = join(outDir, rel);
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest);
      moved.push(rel);
    }
  };
  walk(binDir);
  chmodSync(join(outDir, binName), 0o755);
  return moved;
}

async function main() {
  const localFile = process.env.PI_STANDALONE_FILE;
  const url = URL_TEMPLATE.replace('{VERSION}', VERSION)
    .replace('{OS}', OS)
    .replace('{ARCH}', ARCH)
    .replace('{ASSET}', ASSET);

  // 先解包到临时目录再落位：避免半成品被 tauri build 打进去
  const staging = join(OUT_DIR, '.staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const archive = localFile ?? join(staging, ASSET);

  if (localFile) {
    if (!existsSync(localFile)) throw new Error(`本地资产不存在: ${localFile}`);
    console.log(`[fetch-pi] 使用本地资产 ${localFile}`);
  } else {
    console.log(`[fetch-pi] 下载 ${url}`);
    await download(url, archive);
  }
  if (!statSync(archive).size) throw new Error('资产为空');

  // SHA256：显式传入 > release 的 SHA256SUMS > 警告
  let expected = process.env.PI_SHA256?.toLowerCase().trim();
  let sumSource = expected ? 'PI_SHA256' : null;
  if (!expected && !localFile) {
    expected = parseSums(await fetchText(`https://github.com/${REPO}/releases/download/v${VERSION}/SHA256SUMS`), ASSET);
    sumSource = expected ? 'SHA256SUMS' : null;
  }
  if (process.env.PI_SKIP_SHA256 === '1') {
    console.warn('[fetch-pi] 警告：PI_SKIP_SHA256=1，已跳过校验（仅限本地调试）');
  } else if (expected) {
    const actual = sha256File(archive);
    if (actual !== expected) {
      throw new Error(`SHA256 不匹配：期望 ${expected}，实际 ${actual}`);
    }
    console.log(`[fetch-pi] SHA256 校验通过（来源 ${sumSource}）${actual.slice(0, 12)}…`);
  } else {
    console.warn('[fetch-pi] 警告：拿不到期望的 SHA256（未设 PI_SHA256 且 SHA256SUMS 取不到/无此资产），跳过校验');
  }

  // 解包（macOS/linux 用系统 tar；Windows 10+ 自带 bsdtar 可解 zip）
  const binName = OS === 'windows' ? 'pi.exe' : 'pi';
  const flag = EXT === 'zip' ? '-xf' : '-xzf';
  const tar = spawnSync('tar', [flag, archive, '-C', staging], { stdio: 'inherit' });
  if (tar.status !== 0) throw new Error('解包失败');
  const unpackedBin = findFile(staging, binName);
  if (!unpackedBin) throw new Error(`解包产物中未找到 ${binName}`);

  // 落位：清空旧的 OUT_DIR（保留 .staging），二进制放根、其余资源保结构
  for (const entry of readdirSyncSafe(OUT_DIR)) {
    if (entry.name === '.staging') continue;
    rmSync(join(OUT_DIR, entry.name), { recursive: true, force: true });
  }
  const finalBin = join(OUT_DIR, binName);
  renameSync(unpackedBin, finalBin);
  const assets = installAssets(staging, unpackedBin, binName, OUT_DIR);
  rmSync(staging, { recursive: true, force: true });
  if (!localFile) rmSync(archive, { force: true });

  console.log(`[fetch-pi] 已安装 ${finalBin}（pi v${VERSION} ${OS}-${ARCH}，full SKU 打包用）`);
  if (assets.length) {
    console.log(`[fetch-pi] 附带资源 ${assets.length} 个：${assets.slice(0, 6).join(', ')}${assets.length > 6 ? ' …' : ''}`);
  } else {
    console.warn('[fetch-pi] 警告：资产里没有附带资源（export-html/theme 等）——导出 HTML 可能在 full SKU 里失败');
  }
}

main().catch((e) => {
  console.error('[fetch-pi] 失败:', e.message);
  process.exit(1);
});
