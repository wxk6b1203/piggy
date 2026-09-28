/**
 * UI 截图（README 配图与调试共用）：浏览器 + mock IPC 模式打开 Vite 页面，
 * 按需操作界面后截图，并采集 console 错误。
 *
 * 用法：先 `pnpm dev`（Vite :5195），再
 *
 * ```bash
 * node scripts/shot.mjs [输出路径] [--wait ms] [--click 选择器]... [--eval "js"] [--fresh] [--size WxH]
 * ```
 *
 * 三个开关的用途（README 的配图就是这三条命令生成的，可原样重跑）：
 *   · `--fresh` 先清 localStorage：**截图必须是冷启动的样子**，
 *     否则上一轮跑门禁留下的布局会跟着进来（实测第一版截图里挂着"工作区布局 v1 落地"标签）；
 *   · `--eval` 在截图前跑一段页面 JS（例：把转录滚到某个位置，让代码块入镜）；
 *   · `--size` 改视口（默认 1440x900）。
 */
import { chromium } from 'playwright';

const argv = process.argv;
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const list = (name) => argv.filter((a, i) => argv[i - 1] === `--${name}`);

const out = argv[2] && !argv[2].startsWith('--') ? argv[2] : '/tmp/piggy-mock.png';
const waitMs = Number(flag('wait', 1500));
const clicks = list('click');
const evals = list('eval');
const fresh = argv.includes('--fresh');
const [w, h] = String(flag('size', '1440x900'))
  .split('x')
  .map((n) => Number(n));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: w || 1440, height: h || 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
// `--fresh`：localStorage + sessionStorage 都清（mock 把"上一进程的标签"记在 sessionStorage 里，
// 只清 localStorage 的话重启后仍会恢复出上一轮的标签页——实测第一版截图里挂着三个旧标签）
if (fresh) {
  await page.addInitScript(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
}
await page.goto('http://localhost:5195', { waitUntil: 'networkidle' });
await page.waitForTimeout(waitMs);
for (const sel of clicks) {
  await page.click(sel).catch((e) => errors.push(`click ${sel}: ${e.message}`));
  await page.waitForTimeout(500);
}
for (const js of evals) {
  await page.evaluate((code) => {
    // eslint-disable-next-line no-new-func
    new Function(code)();
  }, js).catch((e) => errors.push(`eval ${js}: ${e.message}`));
  await page.waitForTimeout(400);
}
await page.screenshot({ path: out, fullPage: false });
console.log('shot:', out);
console.log('console errors:', errors.length ? errors : '(none)');
await browser.close();
