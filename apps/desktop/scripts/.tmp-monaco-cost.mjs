import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto('http://localhost:5195', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dv-tab', { timeout: 15000 });
await page.waitForTimeout(2000);

const snap = () =>
  page.evaluate(() => ({
    editors: document.querySelectorAll('.monaco-editor').length,
    refused: [...document.querySelectorAll('.pg-missing')].filter((n) => n.textContent?.includes('上限')).length,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    domNodes: document.getElementsByTagName('*').length,
    previews: document.querySelectorAll('.pg-preview').length,
  }));

const heapAfter = (fn) => fn();
console.log('基线          ', JSON.stringify(await snap()));

// 逐个开预览，每个都等编辑器真的挂上
const perEditor = [];
for (let i = 1; i <= 8; i += 1) {
  const before = await snap();
  const t0 = Date.now();
  await page.evaluate((n) => {
    const editor = globalThis.__piggyEditor;
    editor.openPreviewTab(`cost-${n}`, `/Users/mock/proj/f${n}.rs`, `f${n}.rs`);
  }, i);
  await page.waitForTimeout(600);
  const after = await snap();
  perEditor.push({
    n: i,
    ms: Date.now() - t0,
    editors: after.editors,
    refused: after.refused,
    dHeapMB: after.heapMB !== null && before.heapMB !== null ? after.heapMB - before.heapMB : null,
    heapMB: after.heapMB,
    domNodes: after.domNodes,
  });
}
console.log('逐个开预览（每行 = 开第 n 个之后）:');
for (const r of perEditor) console.log('  ', JSON.stringify(r));
console.log('结束          ', JSON.stringify(await snap()));
await page.screenshot({ path: '/tmp/monaco-cap.png' });
await browser.close();
