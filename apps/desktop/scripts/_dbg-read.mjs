import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on('pageerror', (e) => console.log('PAGEERR', String(e)));
await page.addInitScript(() => { localStorage.clear(); sessionStorage.clear(); });
await page.goto('http://localhost:5195', { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dv-tab', { timeout: 15000 });
await page.waitForTimeout(900);
const out = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stores = globalThis.__piggyStores;
  const mock = globalThis.__piggyMock;
  mock.mockSetTranscriptRows(mock.mockBuildTranscript(100));
  globalThis.__piggyEditor.closeAllTabs();
  await sleep(700);
  document.querySelector('.pg-session-row')?.click();
  let tabId = '';
  for (let i = 0; i < 40; i += 1) {
    await sleep(150);
    tabId = stores.useTabs.getState().activeTabId;
    const t = stores.useMessages.getState().tabs[tabId];
    if (document.querySelector(`[data-tab-id="${tabId}"] .pg-transcript`) && t?.hydrated && (t?.ids ?? []).length > 10) break;
  }
  const tr = document.querySelector(`[data-tab-id="${tabId}"] .pg-transcript`);
  const file = stores.useTabs.getState().tabs[tabId]?.sessionFile;
  const cmd = (m) => ({ m, gap: Math.round(tr.scrollHeight - tr.clientHeight - tr.scrollTop), top: Math.round(tr.scrollTop), floor: Math.round(tr.scrollHeight - tr.clientHeight), btn: !!document.querySelector('[data-to-bottom]') });
  const trace = [cmd('open')];
  tr.scrollTop = Math.round((tr.scrollHeight - tr.clientHeight) / 3);
  await sleep(60); trace.push(cmd('after +60ms'));
  await sleep(200); trace.push(cmd('after +260ms'));
  await sleep(400); trace.push(cmd('after +660ms'));
  await sleep(600); trace.push(cmd('after +1.2s'));
  const saved = JSON.parse(localStorage.getItem('piggy:reading-position') ?? '{}');
  return { trace, savedEntry: file ? saved[file] : null, savedKeys: Object.keys(saved), rows: stores.useMessages.getState().tabs[tabId]?.ids.length };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
