/**
 * UI 调试截图：浏览器 + mock IPC 模式打开 Vite 页面，Playwright 截图 + console 采集。
 * 用法：先 `pnpm dev`（Vite :5195），再 `node scripts/shot.mjs [输出路径] [--wait ms] [--click selector]...`
 */
import { chromium } from 'playwright';

const out = process.argv[2] ?? '/tmp/piggy-mock.png';
const waitIdx = process.argv.indexOf('--wait');
const waitMs = waitIdx >= 0 ? Number(process.argv[waitIdx + 1] ?? 1500) : 1500;
const clicks = process.argv.filter((a, i) => process.argv[i - 1] === '--click');

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('http://localhost:5195', { waitUntil: 'networkidle' });
await page.waitForTimeout(waitMs);
for (const sel of clicks) {
  await page.click(sel).catch((e) => errors.push(`click ${sel}: ${e.message}`));
  await page.waitForTimeout(400);
}
await page.screenshot({ path: out, fullPage: false });
console.log('shot:', out);
console.log('console errors:', errors.length ? errors : '(none)');
await browser.close();
