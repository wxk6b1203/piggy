/**
 * 启动核对（真浏览器 + mock IPC）：**恢复持久化布局之后，前端状态与后端 registry 是否一致**。
 *
 * 覆盖范围（说清楚，不含糊）：它断言的是**恢复之后的完整性**——
 *   · useTabs 与 dockview 面板一致（不多不少）
 *   · 每个标签在（mock 的）registry 里都还存在
 *   · 面板 id 与 params.tabId 分叉后 `focusSessionTab` 仍找得到
 *   · 每个标签都有可用的关闭按钮
 *   · 页面零错误
 *
 * ⚠️ 它**不是**「StrictMode 两轮恢复抢时序」那个 bug 的复现器：那条竞态取决于
 * tab_create 与实例切换的相对快慢，mock 快一点慢一点结论就变（实测过），
 * 不适合当回归门禁。那条时序由 `src/test/layout-restore.test.ts` **确定性地**锁住
 * （受控 promise 精确制造"恢复途中换实例"，已验证关掉修复即变红）。
 *
 * 做法（全部走应用自己的代码路径，不 mock 掉被测逻辑）：
 *   1. 干净启动，用应用的 API 开第二个会话标签，请 dockview 自己 `toJSON()` 出布局；
 *   2. 把布局里的面板 id 与 `params.tabId` 改写成"上一进程留下的"值（制造真机上必然
 *      出现的分叉），塞进 localStorage 后重载页面；
 *   3. 断言：useTabs 与面板一致、每个标签在 mock registry 里都存在、
 *      每个标签都有可用的关闭按钮、`focusSessionTab` 在分叉后仍能找到面板。
 *
 * 前置：`pnpm dev`（Vite :5195）已在跑。
 * 用法：`pnpm --filter @piggy/desktop ui:startup`
 */
import { chromium } from 'playwright';

const URL = process.argv[2] ?? 'http://localhost:5195';
const bad = [];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') pageErrors.push(m.text().split('\n')[0]);
});

/* ---------- 1. 干净启动，产出真实布局 ---------- */
await page.addInitScript(() => {
  localStorage.clear();
  sessionStorage.clear();
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dv-tab', { timeout: 15000 });
await page.waitForTimeout(900);
const seed = await page.evaluate(async () => {
  const [{ createTab }, editor] = await Promise.all([
    import('/src/stores/tabs.ts'),
    import('/src/features/workspace/EditorArea.tsx'),
  ]);
  const snap = await createTab({ cwd: '/Users/mock/proj', sessionPath: '/Users/mock/proj/b.jsonl' });
  editor.openSessionTab(snap, '会话 B');
  await new Promise((r) => setTimeout(r, 400));
  return globalThis.__piggyDock.toJSON();
});

/* ---------- 2. 改写成"上一进程遗留"的面板 id / tabId 后重载 ---------- */
for (const p of Object.values(seed.panels)) {
  if (p.params?.kind === 'session') p.params.tabId = `stale-${p.id}`;
}
const sessionPanelCount = Object.values(seed.panels).filter((p) => p.params?.kind === 'session').length;
let json = JSON.stringify(seed);
for (const id of Object.keys(seed.panels).filter((k) => k.startsWith('session:'))) {
  json = json.split(id).join(`${id}-old`);
}
const drifted = JSON.parse(json);

await page.addInitScript((layout) => {
  sessionStorage.clear(); // registry 从零开始：真机冷启动 Rust 进程
  localStorage.setItem('pg.mockLayout', JSON.stringify({ dockview: layout, updated_at: Date.now() }));
}, drifted);
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dv-tab', { timeout: 15000 });
await page.waitForTimeout(1500);

/* ---------- 3. 断言 ---------- */
const probe = await page.evaluate(async () => {
  // ⚠️ 必须用应用自己那份 store 实例：`import('/src/stores/tabs.ts')` 可能拿到另一个
  // 模块实例（URL/HMR 时间戳不同即不同模块），断言读到的会是空 store。
  // 这个 dev-only 钩子在 src/main.tsx 里挂上。
  const { useTabs } = globalThis.__piggyStores;
  const ids = useTabs.getState().order;
  const panels = globalThis.__piggyDock.panels.map((p) => ({ id: p.id, tabId: p.params?.tabId }));
  const sessionPanels = panels.filter((p) => p.tabId);
  // 每个标签问一句"你还在 registry 里吗"：走 mock 的 tab 级命令（真机对应 Rust 的 worker_of）
  const [ipc, editor] = await Promise.all([
    import('/src/lib/ipc.ts'),
    // focusSessionTab 只读 globalThis 上的 dock api，不碰 store，所以这里重复加载无妨
    import('/src/features/workspace/EditorArea.tsx'),
  ]);
  const liveness = [];
  for (const id of ids) {
    try {
      await ipc.cmd('pi_get_available_models', { tabId: id });
      liveness.push({ id, ok: true });
    } catch (e) {
      liveness.push({ id, ok: false, err: String(e) });
    }
  }
  return {
    storeIds: ids,
    panelTabIds: sessionPanels.map((p) => p.tabId),
    driftedPanelIds: sessionPanels.filter((p) => p.id !== `session:${p.tabId}`).length,
    liveness,
    focusFirst: ids.length ? editor.focusSessionTab(ids[0]) : null,
    focusBogus: editor.focusSessionTab('does-not-exist'),
    pill: document.querySelector('.pg-model-select')?.textContent ?? null,
    closeButtons: [...document.querySelectorAll('.dv-tab')].map((t) => ({
      has: !!t.querySelector('.dv-default-tab-action'),
      isButton: t.querySelector('.dv-default-tab-action')?.tagName === 'BUTTON',
      label: t.querySelector('.dv-default-tab-action')?.getAttribute('aria-label') ?? null,
    })),
  };
});

/* ---------- 4. Fleet 面板：A 层启动 + B 层 PIGGY:1 数据面（真浏览器，走应用自己的代码） ---------- */
// 覆盖的是"IPC 参数名 → mock 状态 → 事件 → store → 渲染"这条整链路：
// 2026-09-23 之前 mock 的 fleet 处理器读 snake_case（真机走的是 camelCase），
// 于是浏览器里 templateId 恒为 "undefined"、lane 集合永远走默认分支——测试全绿而真机未知。
await page.addInitScript(() => {
  localStorage.clear();
  sessionStorage.clear();
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dv-tab', { timeout: 15000 });
await page.waitForTimeout(800);
await page.click('.pg-rail-btn[title="Fleet（子代理）"]');
await page.waitForSelector('.pg-fleet', { timeout: 5000 });

const fleet = await page.evaluate(async () => {
  const ipc = await import('/src/lib/ipc.ts');
  const stores = globalThis.__piggyStores;
  const tabId = stores.useTabs.getState().activeTabId;
  // A 层：启动一次编排（scout-review-build = 3 条 lane，mock 400ms 后推 fleet:changed）
  await ipc.cmd('fleet_start', { templateId: 'scout-review-build', task: '核对启动路径', cwd: '/Users/mock/proj' });
  await new Promise((r) => setTimeout(r, 1400));
  const aLaneBlocks = document.querySelectorAll('.pg-fleet-lane-block').length;
  const aRoles = [...document.querySelectorAll('.pg-fleet-lane-role')].map((e) => e.textContent);

  // A 层 steer：输入 + 回车 → fleet_steer（mock 会校验 lane 真的存在，不存在会抛错并弹 toast）
  const steerInput = document.querySelector('.pg-fleet-steer input');
  if (steerInput) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(steerInput, '只看边界条件');
    steerInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 50));
    steerInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
  }
  const steerCleared = document.querySelector('.pg-fleet-steer input')?.value === '';

  // B 层：点刷新 → pi_prompt('/piggy:status') → mock 发 extension_ui_request(set_editor_text)
  //        → DialogRouter 劫持 PIGGY:1 载荷 → fleetStore → 面板出现 lane 行
  document.querySelector('.pg-fleet-refresh').click();
  await new Promise((r) => setTimeout(r, 900));
  const bRoles = [...document.querySelectorAll('.pg-fleet-lane-role')].map((e) => e.textContent);

  // 斜杠补全：列表必须**可滚动**且全部条目都在 DOM 里。
  // jsdom 测不了真实滚动（scrollHeight 恒为 0），所以这一条只能在真浏览器里立。
  const slash = await (async () => {
    const ta = document.querySelector('.pg-composer-input');
    if (!ta) return { error: '找不到输入框' };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '/');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900)); // 等 pi_get_commands
    const box = document.querySelector('.pg-slash');
    const rows = [...document.querySelectorAll('.pg-slash-item')];
    if (!box) return { error: '补全列表没出现', rows: rows.length };
    const cs = getComputedStyle(box);
    const before = box.scrollTop;
    box.scrollTop = box.scrollHeight; // 滚到底
    await new Promise((r) => setTimeout(r, 60));
    const last = rows.at(-1)?.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    return {
      rows: rows.length,
      overflowY: cs.overflowY,
      scrollHeight: box.scrollHeight,
      clientHeight: box.clientHeight,
      scrollable: box.scrollHeight > box.clientHeight,
      scrolledBy: box.scrollTop - before,
      lastRowVisible: !!last && last.bottom <= boxRect.bottom + 1 && last.top >= boxRect.top - 1,
      lastRowName: rows.at(-1)?.querySelector('code')?.textContent ?? null,
    };
  })();

  return {
    tabId,
    aLaneBlocks,
    aRoles,
    steerCleared,
    bRoles,
    slash,
    bridged: stores.useFleet.getState().bridge.installed,
    synced: document.querySelector('.pg-fleet-synced')?.textContent ?? '',
  };
});

await browser.close();
console.log(JSON.stringify({ ...probe, sessionPanelCount, pageErrors, fleet }, null, 1));

if (probe.storeIds.length === 0) bad.push('恢复后 useTabs 为空（布局恢复把标签全关了）★');
if (probe.driftedPanelIds === 0) bad.push('面板 id 与 params.tabId 没有分叉，这条核对失去意义');
if (JSON.stringify(probe.storeIds) !== JSON.stringify(probe.panelTabIds)) {
  bad.push(`useTabs 与面板不一致：store=${JSON.stringify(probe.storeIds)} panels=${JSON.stringify(probe.panelTabIds)} ★`);
}
if (probe.liveness.some((l) => !l.ok)) bad.push(`有标签在 registry 里不存在：${JSON.stringify(probe.liveness.filter((l) => !l.ok))} ★`);
if (probe.focusFirst !== true) bad.push('面板 id 分叉后 focusSessionTab 找不到面板 ★');
if (probe.focusBogus !== false) bad.push('focusSessionTab 对不存在的 tabId 应返回 false');
if (probe.closeButtons.some((b) => !b.has || !b.isButton || !b.label)) bad.push('有标签缺少可用的关闭按钮 ★');
if (probe.pill && probe.pill.includes('选择模型')) bad.push('活动标签没有可用模型（说明 store 里没有这个 tab）★');

/* Fleet：A 层用 scout-review-build 模板 → 必须正好 3 条 lane 块（参数名错了就会退化成默认模板） */
if (fleet.aLaneBlocks !== 3) bad.push(`A 层 lane 数应为 3（scout-review-build），实际 ${fleet.aLaneBlocks} ★`);
if (!fleet.aRoles.includes('scout')) bad.push(`A 层未见 scout lane：${JSON.stringify(fleet.aRoles)} ★`);
if (fleet.steerCleared !== true) bad.push('A 层 steer 回车后输入框未清空（fleet_steer 可能报错了）★');
/* Fleet：B 层点刷新后 PIGGY:1 载荷必须落到面板（mock 的 lane 行里带 " · correctness"） */
if (fleet.bridged !== true) bad.push(`B 层 bridge 未标记为已安装：installed=${String(fleet.bridged)} ★`);
if (!fleet.bRoles.some((r) => String(r).includes('correctness'))) {
  bad.push(`B 层刷新后未出现子代理 lane：${JSON.stringify(fleet.bRoles)} ★`);
}
/* 斜杠补全：全部命令在 DOM 里 + 容器真的能滚 + 滚到底能看到最后一条 */
const sl = fleet.slash ?? {};
if (sl.error) bad.push(`斜杠补全：${sl.error} ★`);
else {
  if (sl.rows <= 8) bad.push(`斜杠补全只渲染了 ${sl.rows} 条（应当列出全部匹配项）★`);
  if (sl.overflowY !== 'auto' && sl.overflowY !== 'scroll') bad.push(`补全容器 overflow-y=${sl.overflowY}，不可滚动 ★`);
  if (!sl.scrollable) bad.push(`补全容器没有溢出（scrollHeight=${sl.scrollHeight} ≤ clientHeight=${sl.clientHeight}），滚动核对失去意义`);
  if (!(sl.scrolledBy > 0)) bad.push(`补全列表 scrollTop 没变化（${sl.scrolledBy}），实际滚不动 ★`);
  if (!sl.lastRowVisible) bad.push(`滚到底后最后一条（${sl.lastRowName}）仍不在可视区内 ★`);
}
if (pageErrors.length) bad.push(`页面错误 ${pageErrors.length} 条：${pageErrors.slice(0, 2).join(' | ')}`);

console.log(bad.length ? `\n❌ ${bad.join('\n❌ ')}` : '\n✅ 全部通过');
process.exit(bad.length ? 1 : 0);
