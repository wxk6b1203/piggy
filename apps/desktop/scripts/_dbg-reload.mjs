import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto('http://localhost:5195', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dv-tab', { timeout: 15000 });
await page.waitForTimeout(900);
const setup = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stores = globalThis.__piggyStores;
  const mock = globalThis.__piggyMock;
  mock.mockSetTranscriptRows(mock.mockBuildTranscript(100));
  globalThis.__piggyEditor.closeAllTabs();
  await sleep(700);
  document.querySelector('.pg-session-row')?.click();
  let tabId = '';
  for (let i = 0; i < 60; i += 1) {
    await sleep(150);
    tabId = stores.useTabs.getState().activeTabId;
    const t = stores.useMessages.getState().tabs[tabId];
    if (document.querySelector(`[data-tab-id="${tabId}"] .pg-transcript`) && t?.hydrated && (t?.ids ?? []).length > 10) break;
  }
  await sleep(500);
  const tr = document.querySelector(`[data-tab-id="${tabId}"] .pg-transcript`);
  const r = tr.getBoundingClientRect();
  return { tabId, file: stores.useTabs.getState().tabs[tabId]?.sessionFile, point: { x: Math.round(r.left + r.width/2), y: Math.round(r.top + 200) } };
});
await page.mouse.move(setup.point.x, setup.point.y);
await page.mouse.wheel(0, -1800);
await page.waitForTimeout(900);
console.log('BEFORE', JSON.stringify(await page.evaluate((f) => {
  const saved = JSON.parse(localStorage.getItem('piggy:reading-position') ?? '{}');
  const tr = document.querySelector('.pg-transcript');
  return { saved: saved[f], gap: Math.round(tr.scrollHeight - tr.clientHeight - tr.scrollTop) };
}, setup.file)));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.pg-transcript', { timeout: 15000 });

await page.waitForTimeout(2000);
console.log('AFTER', JSON.stringify(await page.evaluate((f) => {
  const stores = globalThis.__piggyStores;
  const tabs = stores.useTabs.getState().tabs;
  const panels = [...document.querySelectorAll('[data-tab-id]')].map((el) => {
    const tr = el.querySelector('.pg-transcript');
    return tr ? { tabId: el.getAttribute('data-tab-id'), gap: Math.round(tr.scrollHeight - tr.clientHeight - tr.scrollTop), h: tr.clientHeight } : null;
  }).filter(Boolean);
  return { tabs: Object.entries(tabs).map(([id, t]) => ({ id, file: t.sessionFile, active: id === stores.useTabs.getState().activeTabId })), panels };
}, setup.file)));
await browser.close();
