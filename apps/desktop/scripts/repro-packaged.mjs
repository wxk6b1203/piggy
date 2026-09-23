/**
 * 复现"打包版黑屏"：用**生产 dist/ + 真实 CSP 响应头**起一个静态服务，
 * 再用 Playwright 打开，从而在能看到 console 的环境里还原打包版的加载条件。
 *
 * 为什么需要它：`ui-debug` 走的是 Vite dev + 无 CSP，抓不到只在
 * 「生产 bundle + CSP + 自定义协议」下才出现的问题——黑屏正是这一类。
 *
 * 用法：node scripts/repro-packaged.mjs [--port 5199]
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, '..', 'dist');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 5199;

if (!existsSync(join(distDir, 'index.html'))) {
  console.error('dist/index.html 不存在，先跑 `npx vite build`');
  process.exit(2);
}

// 与 tauri.conf.json app.security.csp 保持一致（'self' 在本机 = http://localhost:<port>）
const CSP =
  "default-src 'self'; " +
  "script-src 'self' 'wasm-unsafe-eval'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' asset: http://asset.localhost data: blob:; " +
  "font-src 'self' data:; " +
  "worker-src 'self' blob:; " +
  "connect-src 'self' ipc: http://ipc.localhost";

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
};

const server = createServer(async (req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const rel = normalize(urlPath === '/' ? '/index.html' : urlPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(distDir, rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'content-security-policy': CSP,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-security-policy': CSP });
    res.end('not found');
  }
});

await new Promise((r) => server.listen(port, r));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
const blocked = [];
page.on('pageerror', (e) => problems.push(`PAGEERROR ${e.message}`));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') problems.push(`CONSOLE ${t}`);
  // CSP 违规在 Chromium 里以 console error 形式出现，文案含 "Content Security Policy"
  if (/Content Security Policy|Refused to/i.test(t)) blocked.push(t);
});
page.on('requestfailed', (r) => problems.push(`REQFAIL ${r.url()} ${r.failure()?.errorText}`));

await page.goto(`http://localhost:${port}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(4000);

const state = await page.evaluate(() => ({
  rootChildren: document.getElementById('root')?.children.length ?? -1,
  panels: document.querySelectorAll('.dv-tab').length,
  bodyLen: (document.body.innerText ?? '').length,
  bg: getComputedStyle(document.body).backgroundColor,
}));

await page.screenshot({ path: '/tmp/piggy-packaged-repro.png' });
await browser.close();
server.close();

console.log('渲染状态:', JSON.stringify(state));
console.log(`\nCSP 拦截（${blocked.length}）:`);
console.log(blocked.length ? blocked.join('\n') : '(none)');
console.log(`\n其他问题（${problems.length}）:`);
console.log(problems.length ? problems.join('\n') : '(none)');
console.log('\n截图: /tmp/piggy-packaged-repro.png');
