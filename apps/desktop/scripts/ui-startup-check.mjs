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
 *
 * 除了上面这三段，脚本后半还有两段独立核对（各自带起因注释）：
 *   4. **Fleet 面板**（A 层启动 + B 层 PIGGY:1 数据面）、**斜杠补全真滚动**、**代码块真高亮**；
 *   5. **文件预览真高亮**（markdown / go 的 token 颜色 + 未知扩展名必须老实纯文本）。
 * 这两段的共同点：量的是**真实 DOM 的颜色**，jsdom 里量不到（没有布局/worker），
 * 而它们要拦的 bug 恰恰是"界面上看不出错、但一个字都没上色"。
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

  // 代码块：**这一节是本次 bug 唯一能在构建/运行期拦住它的地方**。
  //
  // 起因：用户截图"代码块没有高亮也没有折叠"。根因是 `import(`shiki/langs/${id}.mjs`)`
  // —— 裸说明符 + 变量，Vite 的 dynamic-import-vars **不分析裸说明符**，构建期
  // 连 warning 都不给，产物里原样保留；浏览器执行时抛
  // `Failed to resolve module specifier`，再被 `.catch(() => setHtml(null))` 吞掉。
  // 净效果：高亮从来没生效过，而**控制台一条错误都没有**。
  //
  // 为什么必须在这里立（不能只靠单测）：vitest 走 Vite 的 SSR transform，模板字符串
  // 那条路径在 Node 里**能解析成功** —— 把代码改回坏写法，单测依然全绿。实测过。
  // 只有真浏览器的 ESM 解析 + 真实产物才认得出。所以断言打在**真实 DOM** 上：
  // 经 `useMessages.hydrate` → Transcript → MessageView → CodeBlock 整条链路。
  const code = await (async () => {
    const diffText = [
      'diff --git a/3_optimize_ws_goroutines/epoll.go b/3_optimize_ws_goroutines/epoll.go',
      'index 2da34df..0902aa3 100644',
      '--- a/3_optimize_ws_goroutines/epoll.go',
      '+++ b/3_optimize_ws_goroutines/epoll.go',
      '@@ -1,9 +1,9 @@',
      ' package main',
      ' ',
      ' import (',
      '-    "github.com/gorilla/websocket"',
      '+    "golang.org/x/sys/unix"',
      ' )',
    ].join('\n');
    const goFence = '```go\npackage main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("hi")\n}\n```';
    const mid = Array.from({ length: 30 }, (_, i) => `mid ${i + 1}`).join('\n');
    const long = Array.from({ length: 60 }, (_, i) => `long ${i + 1}`).join('\n');

    stores.useMessages.getState().hydrate(tabId, [
      { role: 'toolResult', toolCallId: 'probe-diff', toolName: 'bash', content: [{ type: 'text', text: diffText }] },
      { role: 'assistant', content: [{ type: 'text', text: goFence }] },
      { role: 'toolResult', toolCallId: 'probe-mid', toolName: 'read', content: [{ type: 'text', text: mid }] },
      { role: 'toolResult', toolCallId: 'probe-long', toolName: 'read', content: [{ type: 'text', text: long }] },
    ]);
    // 等 shiki wasm + 语言 chunk（首次要下载 oniguruma + 语法）
    await new Promise((r) => setTimeout(r, 3500));

    const cards = [...document.querySelectorAll('.pg-codeblock')];
    const pick = (sel) => cards.map((c) => c.querySelector(sel)).filter(Boolean);
    const diffCard = cards.find((c) => c.getAttribute('data-lang') === 'diff');
    const goCard = cards.find((c) => c.getAttribute('data-lang') === 'go');
    const colorOf = (el) => (el ? getComputedStyle(el).color : null);
    const pre = diffCard?.querySelector('pre');
    const moreCard = cards.find(
      (c) => c.querySelector('.pg-codeblock-more') && !c.querySelector('.pg-codeblock-body[data-collapsed]'),
    );
    const collapsedCard = cards.find((c) => c.querySelector('.pg-codeblock-body[data-collapsed]'));

    // 亮色主题下再量一次：diff 底色是 `!important` 抢回来的，主题一切就可能被
    // `background-color: transparent !important` 那条双主题规则盖掉。
    const prevTheme = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = 'light';
    await new Promise((r) => setTimeout(r, 80));
    const addBgLight = diffCard?.querySelector('.pg-dl-add')
      ? getComputedStyle(diffCard.querySelector('.pg-dl-add')).backgroundColor
      : null;
    const delBgLight = diffCard?.querySelector('.pg-dl-del')
      ? getComputedStyle(diffCard.querySelector('.pg-dl-del')).backgroundColor
      : null;
    document.documentElement.dataset.theme = prevTheme ?? 'dark';

    return {
      cards: cards.length,
      shikiCards: cards.filter((c) => c.querySelector('.shiki')).length,
      addBgLight,
      delBgLight,
      diff: diffCard
        ? {
            spans: diffCard.querySelectorAll('.shiki span').length,
            add: diffCard.querySelectorAll('.pg-dl-add').length,
            del: diffCard.querySelectorAll('.pg-dl-del').length,
            hunk: diffCard.querySelectorAll('.pg-dl-hunk').length,
            addBg: diffCard.querySelector('.pg-dl-add')
              ? getComputedStyle(diffCard.querySelector('.pg-dl-add')).backgroundColor
              : null,
            delBg: diffCard.querySelector('.pg-dl-del')
              ? getComputedStyle(diffCard.querySelector('.pg-dl-del')).backgroundColor
              : null,
            preLines: pre ? pre.textContent.split('\n').length : 0,
            preScrolls: pre ? pre.scrollHeight > pre.clientHeight : false,
          }
        : null,
      // 高亮的"真"证据：同一块的 token 颜色不止一种（全是同一个色 = 高亮没产出任何东西）
      goColors: goCard
        ? [...new Set([...goCard.querySelectorAll('.shiki span')].map(colorOf).filter(Boolean))].length
        : 0,
      // 超高时"显示更多"必须出现 —— 量错元素（量外层 body 而不是 pre）时它会**永远不出现**
      showMore: !!moreCard,
      // 折叠块的内容必须**全在 DOM 里**（折叠 ≠ 不渲染）
      collapsedLines: collapsedCard
        ? collapsedCard.querySelector('pre')?.textContent?.split('\n').length ?? 0
        : 0,
      // "静默失败"计数器：声称有语言、却没产出高亮、也**没说一句话**的卡片数。
      // 旧实现把异常 catch 成纯文本，界面上和控制台里都毫无痕迹 —— 这正是这条 bug
      // 能活很久的原因。这个数必须恒为 0。
      silentFail: cards.filter(
        (c) =>
          c.getAttribute('data-lang') &&
          !c.querySelector('.shiki') &&
          !c.querySelector('.pg-codeblock-hlwarn'),
      ).length,
      hlWarns: cards.map((c) => c.querySelector('.pg-codeblock-hlwarn')?.textContent ?? null).filter(Boolean),
      collapsedHidden: collapsedCard
        ? getComputedStyle(collapsedCard.querySelector('.pg-codeblock-body')).display === 'none'
        : false,
    };
  })();

  return {
    tabId,
    aLaneBlocks,
    aRoles,
    steerCleared,
    bRoles,
    slash,
    code,
    bridged: stores.useFleet.getState().bridge.installed,
    synced: document.querySelector('.pg-fleet-synced')?.textContent ?? '',
  };
});

/* ---------- 5. 文件预览：语法高亮（真浏览器，走应用自己的代码） ---------- */
// 起因（用户截图）：打开 README.md，头部语言条写着 `markdown`，正文**一行都不上色**。
// 根因：Monaco 的 ESM 发行版一门语言都不带，而本项目此前只静态引了 json
// —— 除 .json 外的所有文件都静默降级成 plaintext，不报错、不警告。
//
// 为什么必须在这里立：`monaco.editor.create({language})` 对**未注册**的 id 会
// 静默退回纯文本（LanguageService: "Fall back to plain text if language is unknown"），
// 单测里没有 Monaco 的布局与 worker，断言颜色只会假过。所以断言打在真实 DOM 上：
// 打开的每个文件都要**不止一种 token 类/颜色**，且"语言条声称 X、正文却没有 X 的着色"
// 这种静默失败计数必须为 0 —— 它正是这条 bug 的形态。
await page.addInitScript(() => {
  localStorage.clear();
  sessionStorage.clear();
});
await page.goto(URL, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dv-tab', { timeout: 15000 });
await page.waitForTimeout(800);

/**
 * 顺带核实"按需"这个claim：打开两个文件，**只许**下这两个语言的定义。
 * 拦的是"有人图省事把 84 门一次全注册"（docs/10 §2.2 红线）——
 * 那种改动在界面上完全看不出来，只会让每次开预览都多下几百 KB。
 * 说明：语言名只出现在 dev 的 dep URL 里（`monaco-editor_languages_definitions_go_register.js`），
 * 产物里是 `register-<hash>.js` 认不出语言，所以这条只能在 dev 下量（ui:startup 本来就跑在 dev 上）。
 */
const langDeps = new Set();
const onLangDep = (r) => {
  const m = r.url().match(/languages[\/_]definitions[\/_]([a-z0-9-]+)[\/_]register/);
  if (m) langDeps.add(m[1]);
};
page.on('response', onLangDep);

const preview = await page.evaluate(async () => {
  const editor = await import('/src/features/workspace/EditorArea.tsx');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** 打开一个预览并等它**真的**出现 token（首次要下 monaco core + 语言 chunk，给足 20s）。 */
  async function openAndMeasure(path, title, waitMs) {
    editor.openPreviewTab('probe', path, title); // 同 key = 替换上一个，DOM 里只会有一份
    const t0 = Date.now();
    let root = null;
    while (Date.now() - t0 < waitMs) {
      await sleep(100);
      const panes = [...document.querySelectorAll('.pg-preview')];
      const last = panes.at(-1);
      if (!last || !last.querySelector('.monaco-editor')) continue; // 编辑器还没挂进来
      if (last.querySelectorAll('.view-line span[class^="mtk"]').length > 0) {
        root = last;
        break;
      }
    }
    if (!root) return { path, mounted: false };
    await sleep(250); // tokenization 是异步的，等它落定
    const spans = [...root.querySelectorAll('.view-line span[class^="mtk"]')];
    const colorOf = (el) => getComputedStyle(el).color;
    return {
      path,
      mounted: true,
      lang: root.querySelector('.pg-preview-lang')?.textContent ?? null,
      tokenSpans: spans.length,
      classes: [...new Set(spans.map((s) => s.className))].length,
      colors: [...new Set(spans.map(colorOf).filter(Boolean))].length,
      // 语言条声称有语言，正文却只有一种 token 类 = 静默降级（本次 bug 的形态）。
      // plaintext 只有一种类是应该的，不算。
      silentFallback:
        (root.querySelector('.pg-preview-lang')?.textContent ?? '') !== 'plaintext' &&
        spans.length > 0 &&
        new Set(spans.map((s) => s.className)).size < 2,
      firstLine: root.querySelector('.view-line')?.textContent ?? '',
      sampleColors: [...new Set(spans.map(colorOf).filter(Boolean))].slice(0, 6),
    };
  }

  // ① markdown（用户截图里那个）② go（多 token 类型）③ 认不出的扩展名（必须老老实实纯文本）
  const markdown = await openAndMeasure('/Users/mock/proj/README.md', 'README.md', 20000);
  const go = await openAndMeasure('/Users/mock/proj/main.go', 'main.go', 15000);
  const unknown = await openAndMeasure('/Users/mock/proj/notes.zzz', 'notes.zzz', 8000);
  return { markdown, go, unknown };
});
page.off('response', onLangDep);

/* ---------- 6. 侧栏折叠：折叠态必须留一条能把它叫回来的图标轨 ---------- */
// 起因（用户截图）：窗口里没有打开的标签、侧栏也不见了 —— 一屏黑，**没有任何可点的地方**
// 能把它展开回来（只剩 ⌘B 与命令面板）。根因是 `{sidebarOpen && <Panel…>}`：
// 折叠把侧栏连同它的入口一起从 DOM 里删了。DSH 的折叠态是留一条 56px 图标轨
// （SIDEBAR_COLLAPSED = 56，docs/12 §1.5），这里量真实几何 + 走完整回路。
//
// 为什么必须在这里立：jsdom 没有排版，react-resizable-panels 用 ResizeObserver 量 group
// 尺寸、量到 0 就整段 return，于是折叠态重新插入 Panel 会必抛
// `Panel constraints not found for index 3` —— 环境问题，不是产品问题（真浏览器干净）。
const sidebarRoundTrips = [];
{
  const snapshot = () =>
    page.evaluate(() => {
      const sb = document.querySelector('.pg-sidebar');
      const rail = document.querySelector('.pg-rail-left');
      const btn = rail?.querySelector('button[aria-label="展开侧栏"]');
      const r = rail?.getBoundingClientRect();
      const b = btn?.getBoundingClientRect();
      return {
        sidebarW: sb ? Math.round(sb.getBoundingClientRect().width) : 0,
        railW: r ? Math.round(r.width) : 0,
        expandBtn: b ? `${Math.round(b.width)}x${Math.round(b.height)}` : null,
        railButtons: [...(rail?.querySelectorAll('button') ?? [])].map((x) => x.getAttribute('aria-label')),
        tabs: document.querySelectorAll('.dv-tab').length,
      };
    });

  // 关掉全部标签：复现截图里"编辑区是空的"那半边
  await page.evaluate(async () => {
    const editor = await import('/src/features/workspace/EditorArea.tsx');
    editor.closeAllTabs();
  });
  await page.waitForTimeout(300);

  for (let i = 1; i <= 2; i++) {
    await page.click('.pg-brand-row button[title^="收起侧栏"]');
    await page.waitForTimeout(250);
    const collapsed = await snapshot();
    if (!collapsed.expandBtn) {
      sidebarRoundTrips.push({ round: i, collapsed, error: '折叠后找不到可点的展开入口' });
      break;
    }
    await page.click('.pg-rail-left button[aria-label="展开侧栏"]');
    await page.waitForTimeout(250);
    sidebarRoundTrips.push({ round: i, collapsed, expanded: await snapshot() });
  }
}

/* ---------- 7. 空编辑区占位：水印 + 基础快捷键 + 中央入口 ---------- */
// 起因（用户）："空编辑区背景，描述一些基础的快捷键，有点像 vscode，然后加一些中央入口"。
// 关光标签后编辑区只剩一片黑 —— 这是上一轮就点出来的另一个死胡同。
//
// 两件事只有在真浏览器里才成立：
//   ① **按钮点得到**。第一版就被这条抓了：dockview 自己的 `.dv-watermark-container`
//      （全屏、z-index 1，它拿来做空组拖放目标）压在入口按钮上，Playwright 直接报
//      "dv-watermark intercepts pointer events" —— jsdom 永远看不见这一层。
//      所以这里除了点击，还显式做一次 elementFromPoint 命中判定。
//   ② 快捷键/标题来自**命令注册表**：真浏览器里 import 应用自己那两份模块来对，
//      而不是照着截图认字。
const emptyPane = await page.evaluate(async () => {
  const editor = await import('/src/features/workspace/EditorArea.tsx');
  editor.closeAllTabs();
  await new Promise((r) => setTimeout(r, 400));

  const root = document.querySelector('.pg-empty');
  if (!root) return { present: false };
  const logo = root.querySelector('.pg-empty-logo');
  const rowEls = [...root.querySelectorAll('.pg-empty-key-row')];
  const entryEls = [...root.querySelectorAll('.pg-empty-entry')];

  // ⚠️ 必须用 `globalThis.__piggyCommands`（应用自己那份注册表）：另 import 一份
  // `@/lib/commands` 会拿到**另一个模块实例** = 空表（实测踩过，六行标题集体假红）。
  // 键位那边可以直接 import `@/lib/keymap`：`keysFor` 读的是模块常量 + localStorage，
  // 不依赖注册表，跨实例也一致。
  const [km] = await Promise.all([import('/src/lib/keymap.ts')]);
  const cmds = globalThis.__piggyCommands;
  const mismatched = rowEls
    .map((r) => {
      const id = r.getAttribute('data-cmd');
      const cmd = id ? cmds?.getCommand(id) : undefined;
      const chord = id ? km.keysFor(id) : undefined;
      const want = chord ? km.displayChord(chord) : null;
      const got = r.querySelector('.pg-empty-kbd')?.textContent ?? null;
      const title = r.querySelector('.pg-empty-key-title')?.textContent ?? null;
      return { id, want, got, title, cmdTitle: cmd?.title ?? null };
    })
    .filter((r) => r.got !== r.want || r.cmdTitle !== r.title);

  // 命中判定：按钮中心点上最顶层的可交互元素必须就是它自己（或它的子节点）
  const hits = entryEls.map((b) => {
    const r = b.getBoundingClientRect();
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { cmd: b.getAttribute('data-cmd'), hittable: !!top && (top === b || b.contains(top)) };
  });

  return {
    present: true,
    logo: logo?.textContent ?? null,
    logoOpacity: logo ? Number(getComputedStyle(logo).opacity) : null,
    rows: rowEls.length,
    entries: entryEls.length,
    entryCmds: entryEls.map((b) => b.getAttribute('data-cmd')),
    mismatched,
    hits,
    tabsWhileEmpty: document.querySelectorAll('.dv-tab').length,
  };
});

// 中央入口真的执行命令：点第一个（新建会话）→ 出标签、占位消失。
// ⚠️ 点击本身带 5s 超时并**吞掉异常**：被别的层挡住时 Playwright 会抛
// "intercepts pointer events"，默认 30s 超时会让整个脚本崩掉（看不到后面所有断言），
// 而这里要的是"报一条红"。
let emptyClickError = null;
if (emptyPane.present) {
  await page
    .click('.pg-empty-entry', { timeout: 5000 })
    .catch((e) => (emptyClickError = String(e).split('\n')[0]));
  await page.waitForTimeout(600);
}
const emptyAfterClick = await page.evaluate(() => ({
  tabs: document.querySelectorAll('.dv-tab').length,
  paneGone: !document.querySelector('.pg-empty'),
}));
await page.evaluate(async () => {
  const editor = await import('/src/features/workspace/EditorArea.tsx');
  editor.closeAllTabs();
});
await page.waitForTimeout(400);
const emptyBack = await page.evaluate(() => !!document.querySelector('.pg-empty'));

/* ---------- 8. 「打开方式」分裂胶囊（DSH ui-open-in-app 的 Piggy 版） ---------- */
// 起因（用户）："DSH 有个好用的功能，打开当前的工作项目到某个 IDE/编辑器内……我也想要"，
// 并指着会话头部右侧说"放在这里，稍微显著一点"。
//
// 这一段量三件 jsdom 量不到的事：
//   ① **位置与显著性**：胶囊在 `.pg-session-head-ops` 里、有边框、够大、中心点真的可点
//      （用户嫌原来那个置灰图标太隐形）；
//   ② **菜单向下弹且不出屏**：会话头部在窗口顶部，向上弹会顶飞（Picker 默认是向上）；
//   ③ **点下去送出去的到底是哪个应用、哪个目录** —— 读 mock 后端自己的调用记录
//      （`globalThis.__piggyMock`，又一次"必须拿应用自己那一份模块"）。
const openInCwd = await page.evaluate(async () => {
  const [{ createTab }, editor] = await Promise.all([
    import('/src/stores/tabs.ts'),
    import('/src/features/workspace/EditorArea.tsx'),
  ]);
  const snap = await createTab({ cwd: '/Users/mock/proj', sessionPath: '/Users/mock/proj/open-in.jsonl' });
  editor.openSessionTab(snap, '打开方式');
  await new Promise((r) => setTimeout(r, 600));
  return snap.cwd;
});

const openIn = await page.evaluate(() => {
  const head = document.querySelector('.pg-session-head-ops');
  const split = head?.querySelector('.pg-opentarget-split');
  const main = split?.querySelector('.pg-opentarget-main');
  const chev = split?.querySelector('.pg-opentarget-chevron');
  if (!head || !split || !main || !chev) return { present: false };
  const cs = getComputedStyle(split);
  const r = split.getBoundingClientRect();
  const mr = main.getBoundingClientRect();
  const top = document.elementFromPoint(mr.left + mr.width / 2, mr.top + mr.height / 2);
  return {
    present: true,
    label: main.textContent,
    kind: split.getAttribute('data-open-target'),
    size: split.getAttribute('data-size'),
    app: main.getAttribute('data-open-target-id'),
    width: Math.round(r.width),
    height: Math.round(r.height),
    borderWidth: parseFloat(cs.borderTopWidth),
    radius: cs.borderTopRadius ?? cs.borderRadius,
    hittable: !!top && (top === main || main.contains(top)),
    // 只替掉了「打开方式」那一个占位；「更多」的置灰按钮还在（它仍是 M2 排期）
    linkExternalPlaceholderGone: !head.querySelector('i.codicon-link-external'),
    morePlaceholderStillThere: !!head.querySelector('button[title*="排期 M2"] i.codicon-more'),
    beforeChevron: !!(main.compareDocumentPosition(chev) & Node.DOCUMENT_POSITION_FOLLOWING),
  };
});

let openInMenuError = null;
if (openIn.present) {
  await page
    .click('.pg-opentarget-chevron', { timeout: 5000 })
    .catch((e) => (openInMenuError = String(e).split('\n')[0]));
  await page.waitForTimeout(300);
}
const openInMenu = await page.evaluate(() => {
  const box = document.querySelector('.pg-picker-menu');
  const anchor = document.querySelector('.pg-opentarget-split');
  const items = [...document.querySelectorAll('.pg-picker-menu .pg-picker-item')];
  const br = box?.getBoundingClientRect();
  const ar = anchor?.getBoundingClientRect();
  return {
    open: !!box,
    count: items.length,
    labels: items.map((i) => i.querySelector('.pg-picker-label')?.textContent ?? null),
    withImage: items.filter((i) => i.querySelector('img[data-icon-kind="image"]')).length,
    withGeneric: items.filter((i) => i.querySelector('svg[data-icon-kind="generic"]')).length,
    belowAnchor: br && ar ? br.top >= ar.bottom - 1 : null,
    insideViewport: br ? br.top >= 0 && br.bottom <= window.innerHeight + 1 : null,
  };
});

// 选 GoLand：记住选择 + 立刻启动 + 主按钮换成它
let openInPickError = null;
const openInPick = await page
  .evaluate(async () => {
    const items = [...document.querySelectorAll('.pg-picker-menu .pg-picker-item')];
    const target = items.find((i) => i.querySelector('.pg-picker-label')?.textContent === 'GoLand');
    if (!target) return { clicked: false };
    target.click();
    await new Promise((r) => setTimeout(r, 400));
    const main = document.querySelector('.pg-opentarget-main');
    return {
      clicked: true,
      calls: (globalThis.__piggyMock?.openCalls ?? []).map((c) => ({ ...c })),
      app: main?.getAttribute('data-open-target-id') ?? null,
      label: main?.textContent ?? null,
      stored: localStorage.getItem('piggy.open-in-app.choice'),
      menuClosed: !document.querySelector('.pg-picker-menu'),
    };
  })
  .catch((e) => {
    openInPickError = String(e).split('\n')[0];
    return { clicked: false };
  });

// 重载一次：冷启动必须读回上次选择（DSH 也是持久化 last choice）。
// ⚠️ 第 1 段注册的 addInitScript **每次导航都会清 localStorage**，所以这里把
// "重载前真实读到的那个值"原样放回去：**写**那一半由上面的 `openInPick.stored` 证明，
// 这里证明的是另一半 —— 冷启动读到已存的值就显示它（而不是永远显示列表第一个）。
const storedBeforeReload = await page.evaluate(() =>
  localStorage.getItem('piggy.open-in-app.choice'),
);
await page.addInitScript((v) => {
  if (v) localStorage.setItem('piggy.open-in-app.choice', v);
}, storedBeforeReload);
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('.dv-tab', { timeout: 15000 });
await page.waitForTimeout(900);
const openInAfterReload = await page.evaluate(() => {
  const main = document.querySelector('.pg-opentarget-main');
  return {
    present: !!main,
    app: main?.getAttribute('data-open-target-id') ?? null,
    label: main?.textContent ?? null,
    splits: document.querySelectorAll('.pg-opentarget-split').length,
  };
});

/* ---------- 9. 「打开方式」文件那一档：系统文件关联（预览头部） ---------- */
// 与第 8 段的区别是**数据源**：会话头部那颗走宿主白名单目录，预览头部这颗走
// **操作系统的文件关联**（这个 .md 现在能由哪些应用打开）。这里量的是接线对不对：
// 主按钮 = 系统默认应用、菜单列出全部处理器 + 「显示文件位置」、三条路送出的参数各不相同。
//
// 顺带把**语言判定**也量了：`.rs` 只在新表（`monaco-langs.ts`）里，
// 预览头部原来那张 16 项的本地表认不出它 —— 那正是"语言条写着 plaintext、
// 正文一行都不上色"的静默降级（docs/15 规矩 25）。
// ⚠️ 必须用 page.evaluate 读：Node 侧的 globalThis 上没有 __piggyMock
const pathCalls = () =>
  page.evaluate(() => (globalThis.__piggyMock?.pathCalls ?? []).map((c) => ({ ...c })));

const openInFile = await page.evaluate(async () => {
  const editor = await import('/src/features/workspace/EditorArea.tsx');
  editor.openPreviewTab('probe', '/Users/mock/proj/lib.rs', 'lib.rs');
  const t0 = Date.now();
  while (Date.now() - t0 < 15000) {
    await new Promise((r) => setTimeout(r, 100));
    if (document.querySelector('.pg-preview-head .pg-opentarget-split')) break;
  }
  await new Promise((r) => setTimeout(r, 300));
  const pane = [...document.querySelectorAll('.pg-preview')].at(-1);
  const head = pane?.querySelector('.pg-preview-head');
  const split = head?.querySelector('.pg-opentarget-split');
  const main = split?.querySelector('.pg-opentarget-main');
  const chev = split?.querySelector('.pg-opentarget-chevron');
  if (!head || !split || !main || !chev) return { present: false };
  const cs = getComputedStyle(split);
  const r = split.getBoundingClientRect();
  const mr = main.getBoundingClientRect();
  const top = document.elementFromPoint(mr.left + mr.width / 2, mr.top + mr.height / 2);
  return {
    present: true,
    kind: split.getAttribute('data-open-target'),
    size: split.getAttribute('data-size'),
    title: main.getAttribute('title'),
    hasIcon: !!main.querySelector('img[data-icon-kind="image"]'),
    width: Math.round(r.width),
    height: Math.round(r.height),
    borderWidth: parseFloat(cs.borderTopWidth),
    hittable: !!top && (top === main || main.contains(top)),
    // 它是文档动作位里的**最后一个**（DSH：打开方式在 wrap/reload 之后）
    lastInHead: [...head.querySelectorAll('button')].at(-1) === chev,
    // 顺带：语言条现在认得出 .rs（本地那张 16 项表认不出）
    lang: head.querySelector('.pg-preview-lang')?.textContent ?? null,
    tokens: new Set(
      [...(pane?.querySelectorAll('.view-line span[class^="mtk"]') ?? [])].map((s) => s.className),
    ).size,
  };
});

let openInFileError = null;
if (openInFile.present) {
  await page.click('.pg-preview-head .pg-opentarget-main', { timeout: 5000 })
    .catch((e) => (openInFileError = String(e).split('\n')[0]));
  await page.waitForTimeout(300);
}
const afterPrimary = (await pathCalls()).at(-1) ?? null;

if (openInFile.present) {
  await page.click('.pg-preview-head .pg-opentarget-chevron', { timeout: 5000 })
    .catch((e) => (openInFileError = String(e).split('\n')[0]));
  await page.waitForTimeout(250);
}
const fileMenu = await page.evaluate(() => {
  const items = [...document.querySelectorAll('.pg-picker-menu .pg-picker-item')];
  const box = document.querySelector('.pg-picker-menu')?.getBoundingClientRect();
  const anchor = document.querySelector('.pg-preview-head .pg-opentarget-split')?.getBoundingClientRect();
  return {
    labels: items.map((i) => i.querySelector('.pg-picker-label')?.textContent ?? null),
    withImage: items.filter((i) => i.querySelector('img[data-icon-kind="image"]')).length,
    withGeneric: items.filter((i) => i.querySelector('svg[data-icon-kind="generic"]')).length,
    belowAnchor: box && anchor ? box.top >= anchor.bottom - 1 : null,
  };
});

// 选「显示文件位置」：必须走 reveal（不是 open）
let revealError = null;
await page
  .evaluate(async () => {
    const items = [...document.querySelectorAll('.pg-picker-menu .pg-picker-item')];
    const target = items.find((i) => (i.textContent ?? '').includes('显示文件位置'));
    target?.click();
    await new Promise((r) => setTimeout(r, 400));
  })
  .catch((e) => (revealError = String(e).split('\n')[0]));
const afterReveal = (await pathCalls()).at(-1) ?? null;

/* ---------- 10. Monaco 实例：可见才创建 + 超水位回收（不再有"已达上限"的墙） ---------- */
// 起因（用户）："monaco editor 很吃资源吗？能放开限制 editor 个数吗？"
// 实测（`editor.create` 直接量，见 monaco-pool.ts 注释）：首个 ~9MB（含核心），
// 之后每个 ~0.5–1.5MB / ~70ms。真正的毛病不是开销，而是旧 `MAX_INSTANCES = 6` 那道墙：
// dockview 保留非活动面板的 React 树 → 每开一个预览标签就永久多一个实例 → 第 7 个开始
// 显示"请关闭部分预览标签"，而且关掉也回不来（"已超限"只在首次渲染算一次）。
const monacoBefore = await page.evaluate(() => ({
  live: globalThis.__piggyMonacoPool?.liveEditors() ?? -1,
  heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
}));

// 连开 8 个预览标签（每个不同 key = 不同面板，dockview 会把它们都留着）
await page.evaluate(async () => {
  const editor = globalThis.__piggyEditor;
  for (let i = 1; i <= 8; i += 1) {
    editor.openPreviewTab(`pool-${i}`, `/Users/mock/proj/pool${i}.rs`, `pool${i}.rs`);
    await new Promise((r) => setTimeout(r, 350));
  }
  await new Promise((r) => setTimeout(r, 600));
});
const monacoOpened = await page.evaluate(() => {
  const pool = globalThis.__piggyMonacoPool;
  const pane = [...document.querySelectorAll('.pg-preview')].at(-1);
  return {
    live: pool?.liveEditors() ?? -1,
    ids: pool?.liveEditorIds?.() ?? [],
    watermark: pool?.MAX_LIVE_EDITORS ?? null,
    refused: [...document.querySelectorAll('.pg-missing')].filter((n) =>
      (n.textContent ?? '').includes('上限'),
    ).length,
    tabs: document.querySelectorAll('.dv-tab').length,
    marks: document.querySelectorAll('.pg-monaco').length,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
    lastLang: pane?.querySelector('.pg-preview-lang')?.textContent ?? null,
    lastMounted: !!pane?.querySelector('.monaco-editor'),
  };
});

// 切回第一个标签：被回收的那个必须能**重新建出来**（预览内容要真的回来）
await page.evaluate(async () => {
  globalThis.__piggyDock?.getPanel('preview:pool-1')?.api.setActive();
  await new Promise((r) => setTimeout(r, 800));
});
const monacoSwitchedBack = await page.evaluate(() => {
  const pane = [...document.querySelectorAll('.pg-preview')].at(-1);
  const spans = [...(pane?.querySelectorAll('.view-line span[class^="mtk"]') ?? [])];
  return {
    live: globalThis.__piggyMonacoPool?.liveEditors() ?? -1,
    mounted: !!pane?.querySelector('.monaco-editor'),
    tokens: new Set(spans.map((s) => s.className)).size,
    firstLine: pane?.querySelector('.view-line')?.textContent ?? '',
    refused: [...document.querySelectorAll('.pg-missing')].filter((n) =>
      (n.textContent ?? '').includes('上限'),
    ).length,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  };
});


/* ---------- 11. 提供商配置页（「模型」一节，DSH ui-settings-models 的 Piggy 版） ----------
 * 起因（用户）："很多 GUI coding agent 都有方便的 provider/模型配置页面，帮我优化本项目的配置页"，
 * 并给了 DSH 的设置页与另一个 agent 的提供商管理页两张截图。
 *
 * 这一段要拦的是**jsdom 拦不住**的那几类失败：
 *   ① 列表根本没接上 IPC（长着提供商的样子，其实是写死的空态）；
 *   ② 密钥来源不说清楚 —— 本机真实形态就是"models.json 内联密钥 + auth.json 为空"，
 *      而 pi 的优先级是 auth > models.json > 环境变量，界面不写来源 = 改了没生效也查不出来；
 *   ③ "检测"是个假按钮（不真发请求、或发了不带地址/协议）；
 *   ④ "获取可用模型"拿回来的清单进不了模型表；
 *   ⑤ 保存的载荷形状不对（该空串删键的写成空串、该跟随现状的偷偷换地方）；
 *   ⑥ 列表不会随保存刷新（保存成功但行没变 = 用户以为没保存）。
 */
const providers = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const btn = (root, text) =>
    qa('button', root).find((b) => (b.textContent ?? '').trim() === text) ?? null;
  /** 受控输入必须用原生 setter 绕过 React 的 value tracker，否则事件被判成"值没变"。 */
  const type = async (input, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(30);
  };

  await globalThis.__piggyEditor.openSettingsTab();
  await sleep(700);

  const nav = qa('.pg-settings-navitem').map((b) => (b.textContent ?? '').trim());
  const cardOf = (id) => qa('.pg-provider-card').find((c) => c.dataset.provider === id) ?? null;
  const rowIds = () => qa('.pg-provider-card').map((c) => c.dataset.provider);
  const listMeta = () => {
    const c = cardOf('cc-switch-deep-seek');
    return c ? (c.querySelector('.pg-provider-meta')?.textContent ?? '') : null;
  };
  const list = {
    nav,
    rows: rowIds(),
    dotsOn: qa('.pg-cred-dot.is-on').length,
    dotsOff: qa('.pg-cred-dot.is-off').length,
    meta: listMeta(),
    // 自定义标记与"默认"标记必须看得见
    tags: qa('.pg-provider-card .pg-provider-tag').map((t) => t.textContent),
    addButton: !!btn(document, '+ 添加模型提供商'),
  };

  // 编辑 → 检测：必须真发一次 provider_discover，并把"测了什么"写出来
  const card = cardOf('cc-switch-deep-seek');
  btn(card, '编辑')?.click();
  await sleep(300);
  const editor = cardOf('cc-switch-deep-seek')?.querySelector('.pg-provider-editor') ?? null;
  const edit = {
    present: !!editor,
    keyPlaceholder: editor?.querySelector('[data-testid="pg-key-input"]')?.placeholder ?? null,
    keyMeta: editor?.querySelector('.pg-key-meta')?.textContent ?? null,
    storeValue: editor?.querySelector('.pg-key-meta .ant-select-content')?.textContent ?? null,
    customizedCollapsed: editor ? !editor.querySelector('.pg-customized')?.open : null,
  };
  // 读 mock 后端自己的调用记录（又是"必须拿应用自己那一份模块"）
  const ops = () => (globalThis.__piggyMock?.providerOps ?? []).map((o) => ({ name: o.name, args: { ...o.args } }));
  btn(editor, '检测')?.click();
  await sleep(700);
  const probe = {
    ok: editor?.querySelector('.pg-probe-ok')?.textContent ?? null,
    error: editor?.querySelector('.pg-error')?.textContent ?? null,
    ops: ops(),
  };

  // 获取可用模型 → 勾一个 → 加入模型表
  editor?.querySelector('.pg-customized')?.setAttribute('open', '');
  await sleep(150);
  btn(editor, '获取可用模型')?.click();
  await sleep(700);
  const dialogRows = qa('[data-fetch-id]').map((r) => r.dataset.fetchId);
  const alreadyDisabled = qa('[data-fetch-id="deepseek-flash"] input').every((i) => i.disabled);
  const box = qa('[data-fetch-id="mock-pro"] input')[0] ?? null;
  box?.click();
  await sleep(150);
  const adopt = qa('.ant-modal-footer button').find((b) => (b.textContent ?? '').includes('添加所选')) ?? null;
  adopt?.click();
  await sleep(400);
  const modelRowIds = qa('.pg-modelrows-table tbody tr').map(
    (tr) => tr.querySelector('input')?.value ?? '',
  );
  const fetch = { dialogRows, alreadyDisabled, adoptedVisible: modelRowIds.includes('mock-pro'), modelRowIds };

  // 保存：先写配置、再写密钥；密钥存储位置跟随现状（这一行是 models.json 内联）
  const keyInput = editor?.querySelector('[data-testid="pg-key-input"]') ?? null;
  if (keyInput) await type(keyInput, 'sk-ui-gate-key');
  const before = ops().length;
  btn(editor, '保存')?.click();
  await sleep(1200);
  const save = {
    meta: listMeta(),
    savedNotice: document.querySelector('.pg-providers-saved')?.textContent ?? null,
    rows: rowIds(),
  };

  // 添加流程：目录里挑一个（deepseek 还没配置）→ 地址要带出目录默认值
  btn(document, '+ 添加模型提供商')?.click();
  await sleep(300);
  const selectContent = document.querySelector('[data-testid="pg-catalog-select"] .ant-select-content');
  selectContent?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await sleep(400);
  const options = qa('.ant-select-item-option').map((o) => (o.textContent ?? '').trim());
  const opt = qa('.ant-select-item-option').find((o) => (o.textContent ?? '').includes('deepseek'));
  if (opt) {
    opt.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    opt.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    opt.click();
  }
  await sleep(400);
  const addEditor = document.querySelector('.pg-provider-addcard .pg-provider-editor');
  const add = {
    options,
    editorPresent: !!addEditor,
    // 选目录项后地址应预填成目录里的默认值（而不是空白让人自己猜）
    baseUrl: addEditor?.querySelector('[data-testid="pg-baseurl-input"]')?.value ?? null,
    apiText: addEditor?.querySelector('.pg-customized-body .ant-select-content')?.textContent ?? null,
  };
  btn(addEditor, '保存')?.click();
  await sleep(1200);
  add.rowsAfterSave = rowIds();
  add.noticeAfterSave = document.querySelector('.pg-providers-saved')?.textContent ?? null;

  return { list, edit, probe, fetch, save, add, opsAfterSave: ops().slice(before) };
});

/* ---------- 12. 配置页与预览的两个"只有真跑才会暴露"的坑（2026-09-24 用户实测反馈） ----------
 * ① **「检测」按钮的文字变成竖排单字**：`.pg-key-row` 是 flex 行，按钮 `flex-shrink` 默认 1，
 *    而中文按钮的 min-content 宽度 = **一个字**，于是"检测"两字各占一行（实测 51×44）。
 *    截图里那个按钮看起来就像坏了 —— 这类"几何塌掉"jsdom 量不到。
 * ② **第二次点「高级」JSON 就空了**：Monaco 的初值只在 create() 那一刻取一次，而值是异步读来的。
 *    第一次打开时 Monaco 还要下 chunk，值先到（正常）；第二次 chunk 已在内存里，编辑器在一个
 *    微任务内就建好了，值还没回来 → 停在初始 `{}`，且此后永不更新。
 *    顺带锁住修法的副作用：编程式写入**不许**把编辑器标成"已编辑"（保存按钮得还是灰的）。
 * ③ 顺带量一下**编辑器贡献**在不在（⌘F / 折叠）：只 import `editor.api` 时一个贡献都不在图里。
 *
 * ⚠️ ③ 必须排在 ② 之前：JSON 语言服务自己会把编辑器贡献拽进依赖图（monaco 0.56 的
 * `languages/features/json/workerManager.js` → `internal/common/workers.js`），先开「高级」
 * 的话这条核对永远是绿的 —— 那样"预览里没有折叠"这个真问题会被漏掉（反证时实测过）。
 */

/* ---------- 12a. 编辑器贡献：折叠控件（真浏览器量 DOM 装饰） ---------- */
const contributions = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await globalThis.__piggyEditor.openPreviewTab('contrib-1', '/Users/mock/proj/lib.rs', 'lib.rs');
  await sleep(1600);
  // ⚠️ 不能取 `.at(-1)`：dockview 把非活动面板的 React 树留着（DOM 里在、布局里不在），
  // 而 `MonacoHost` 对不可见面板**根本不创建**编辑器 —— 取末位会量到一个没有编辑器的隐藏面板。
  // 按"真的有尺寸"挑当前可见的那个。
  const pane = [...document.querySelectorAll('.pg-preview')].find((p) => {
    const r = p.getBoundingClientRect();
    return p.querySelector('.monaco-editor') && r.width > 50 && r.height > 50;
  });
  const ed = pane?.querySelector('.monaco-editor');
  // 点击坐标要落在**正文行**上：编辑器左边缘 +40px 是行号/装订线，实测点在那里
  // `document.activeElement` 还是 BODY（编辑器没拿到焦点）→ 后面 ⌘F 自然无效。
  const lineRect = ed?.querySelector('.view-line')?.getBoundingClientRect() ?? null;
  const boxRect = ed?.getBoundingClientRect() ?? null;
  return {
    folding: ed?.querySelectorAll('.codicon-folding-expanded, .codicon-folding-collapsed').length ?? -1,
    lines: ed?.querySelectorAll('.view-line').length ?? -1,
    clickAt: lineRect
      ? { x: Math.round(lineRect.left + 60), y: Math.round(lineRect.top + 6) }
      : boxRect
        ? { x: Math.round(boxRect.left + 150), y: Math.round(boxRect.top + 20) }
        : null,
  };
});

/* ---------- 12b. 编辑器贡献：⌘F 查找框 ----------
 * 用**真按键**：合成 keydown 在 Monaco 0.56（EditContext 输入路径）下不生效，
 * 实测合成事件 false、真按键 true —— 门禁不能因此报假红。 */
if (contributions.clickAt) {
  await page.mouse.click(contributions.clickAt.x, contributions.clickAt.y);
  await page.waitForTimeout(300);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+f' : 'Control+f');
  await page.waitForTimeout(700);
}
contributions.findWidget = await page.evaluate(() => ({
  inDocument: document.querySelectorAll('.find-widget').length,
  inPreview: [...document.querySelectorAll('.pg-preview')].reduce(
    (n, p) => n + p.querySelectorAll('.find-widget').length, 0),
}));

/* ---------- 12c. 配置页：「检测」按钮几何 + 两次进「高级」 ---------- */
const settingsEdge = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const section = async (label) => {
    const b = qa('.pg-settings-navitem').find((x) => (x.textContent ?? '').trim() === label);
    if (!b) throw new Error(`找不到设置节：${label}`);
    b.click();
    await sleep(900);
  };
  const editorText = (file) => {
    const host = document.querySelector(`[data-raw-file="${file}"] .pg-monaco`);
    const lines = [...(host?.querySelectorAll('.view-line') ?? [])].map((l) => l.textContent ?? '');
    return { lines: lines.length, text: lines.join('\n') };
  };
  const saveDisabled = (file) => {
    const box = document.querySelector(`[data-raw-file="${file}"]`);
    // antd 会在两个汉字之间插空格，所以按"去掉空白后相等"来认
    const b = [...(box?.querySelectorAll('button') ?? [])].find(
      (x) => (x.textContent ?? '').replace(/\s/g, '') === '保存',
    );
    return b ? b.disabled : null;
  };

  await globalThis.__piggyEditor.openSettingsTab();
  await sleep(700);

  // ① 「检测」按钮的几何
  await section('模型');
  const card = qa('.pg-provider-card')[0];
  [...(card?.querySelectorAll('button') ?? [])].find((b) => (b.textContent ?? '').trim() === '编辑')?.click();
  await sleep(500);
  const probeBtn = qa('.pg-key-row button').find((b) => (b.textContent ?? '').trim() === '检测') ?? null;
  const rect = probeBtn?.getBoundingClientRect() ?? null;
  const probe = probeBtn
    ? {
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        whiteSpace: getComputedStyle(probeBtn).whiteSpace,
        // 一行放得下：滚动高度与可视高度一致（竖排时 scrollHeight 会远超 clientHeight）
        fitsOneLine: Math.abs(probeBtn.scrollHeight - probeBtn.clientHeight) <= 2,
        rowW: Math.round(document.querySelector('.pg-key-row')?.getBoundingClientRect().width ?? 0),
      }
    : null;

  // ② 两次进「高级」
  await section('高级');
  const first = {
    models: editorText('models_read'),
    settings: editorText('settings_read'),
    saveDisabled: [saveDisabled('models_read'), saveDisabled('settings_read')],
  };
  await section('通用设置');
  await section('高级');
  const second = {
    models: editorText('models_read'),
    settings: editorText('settings_read'),
    saveDisabled: [saveDisabled('models_read'), saveDisabled('settings_read')],
  };
  return { probe, first, second };
});

/* ---------- 14. 会话标题生成 + 右键菜单（docs/03 §2.16、docs/04 §2.4） ----------
 * 三件事只有在真浏览器里才量得到或才成立：
 *   (a) **菜单的贴边内收**——jsdom 的 getBoundingClientRect 全是 0，
 *       被视口切掉一半这种坏法在那里永远量不出来（docs/15 规矩 32）；
 *   (b) 右键是**真按键**（`page.mouse.click(..., {button:'right'})`），
 *       `contextmenu` 事件在真浏览器里走的是另一条路；
 *   (c) 生成完侧栏那一行**真的换了文字**——这条要跨 IPC + 重渲染。 */
const sessionTitle = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const rows = qa('.pg-session-row');
  return {
    rowCount: rows.length,
    firstRect: rows[0]?.getBoundingClientRect().toJSON() ?? null,
    hasIcon: !!rows[0]?.querySelector('.pg-session-titlegen'),
    iconLabel: rows[0]?.querySelector('.pg-session-titlegen')?.getAttribute('aria-label') ?? null,
    titleBefore: (rows[0]?.querySelector('.pg-session-title')?.textContent ?? '').trim(),
  };
});

// 真右键：在会话行上按下右键，菜单应该出现在指针位置附近
if (sessionTitle.firstRect) {
  await page.mouse.click(
    Math.round(sessionTitle.firstRect.x + 60),
    Math.round(sessionTitle.firstRect.y + sessionTitle.firstRect.height / 2),
    { button: 'right' },
  );
  await page.waitForTimeout(400);
}
const menuProbe = await page.evaluate(() => {
  const m = document.querySelector('.pg-menu');
  if (!m) return { present: false };
  const r = m.getBoundingClientRect();
  const items = [...m.querySelectorAll('.pg-menu-label')].map((e) => (e.textContent ?? '').trim());
  return {
    present: true,
    role: m.getAttribute('role'),
    items,
    // 贴边内收：菜单必须整个落在视口里
    insideViewport:
      r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    // 菜单项不能竖排（中文按钮塌成竖排是踩过的坑）
    anyWrapped: [...m.querySelectorAll('.pg-menu-item')].some(
      (i) => i.getBoundingClientRect().height > 40,
    ),
    focused: document.activeElement === m,
    inBody: m.parentElement === document.body || m.closest('body') !== null,
  };
});

// 右下角再开一次：必须往左上翻，而不是被切掉
const cornerProbe = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const row = document.querySelector('.pg-session-row');
  if (!row) return { ok: false };
  window.dispatchEvent(new Event('scroll', { bubbles: true }));
  await sleep(100);
  const r = row.getBoundingClientRect();
  row.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      clientX: window.innerWidth - 2,
      clientY: window.innerHeight - 2,
    }),
  );
  await sleep(250);
  const m = document.querySelector('.pg-menu');
  if (!m) return { ok: false, why: 'menu 没开' };
  const b = m.getBoundingClientRect();
  const out = {
    ok: true,
    insideViewport: b.left >= 0 && b.top >= 0 && b.right <= window.innerWidth && b.bottom <= window.innerHeight,
    // 原点在右下角 → 菜单必须整体在指针左侧/上方
    flipped:
      b.right <= window.innerWidth - 1 && b.bottom <= window.innerHeight - 1,
  };
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(150);
  out.closedByEscape = !document.querySelector('.pg-menu');
  return out;
});

// 点「生成标题」：走完整的 IPC 往返，侧栏那一行必须换文字
let titleRun = { clicked: false };
if (sessionTitle.firstRect) {
  await page.mouse.click(
    Math.round(sessionTitle.firstRect.x + 60),
    Math.round(sessionTitle.firstRect.y + sessionTitle.firstRect.height / 2),
    { button: 'right' },
  );
  await page.waitForTimeout(300);
  const clicked = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.pg-menu-item')];
    const hit = items.find((i) => (i.textContent ?? '').includes('生成标题'));
    if (!hit) return false;
    hit.click();
    return true;
  });
  await page.waitForTimeout(900);
  titleRun = await page.evaluate(
    (before) => {
      const row = document.querySelector('.pg-session-row');
      return {
        clicked: true,
        titleAfter: (row?.querySelector('.pg-session-title')?.textContent ?? '').trim(),
        changed: (row?.querySelector('.pg-session-title')?.textContent ?? '').trim() !== before,
        menuClosed: !document.querySelector('.pg-menu'),
        ops: (globalThis.__piggyMock?.sessionTitleOps ?? []).map((o) => o.name),
      };
    },
    sessionTitle.titleBefore,
  );
  titleRun.clicked = clicked;
}

/* ---------- 13. 插件页：四种来源 + 启停 + 安装任务 ----------
 * 这一页的价值全在"**状态是谁定的**"和"**操作真的落到了 pi 的文件上**"。
 * 所以核对三件事：(a) 四种来源各自的徽标/状态都渲染了；(b) 点开关会发出
 * plugin_set_enabled 且界面跟着变；(c) 点安装会真的产生一个任务并显示输出。 */
const plugins = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const qa = (sel, root = document) => [...root.querySelectorAll(sel)];
  const nav = (label) => {
    const b = qa('.pg-settings-navitem').find((x) => (x.textContent ?? '').trim() === label);
    if (!b) throw new Error(`找不到设置节：${label}`);
    b.click();
  };
  const ops = () =>
    (globalThis.__piggyMock?.pluginOps ?? []).map((o) => ({ name: o.name, args: { ...o.args } }));

  nav('插件');
  await sleep(700);

  const groups = qa('[data-plugin-group]').map((g) => ({
    id: g.getAttribute('data-plugin-group'),
    title: (g.querySelector('.pg-plugin-group-title')?.textContent ?? '').trim(),
    count: Number(g.getAttribute('data-plugin-count') ?? -1),
  }));
  const rows = qa('.pg-plugin-row').map((r) => ({
    key: r.getAttribute('data-plugin-key'),
    name: (r.querySelector('.pg-plugin-name')?.textContent ?? '').trim(),
    kind: (r.querySelector('.pg-plugin-kind')?.textContent ?? '').trim(),
    enabled: r.getAttribute('data-plugin-enabled') === '1',
    missing: r.classList.contains('is-missing'),
    // 行高：塌成竖排时行高会异常变大（"检测按钮竖起来"就是这个形状）
    h: Math.round(r.getBoundingClientRect().height),
  }));
  const switches = qa('.pg-plugin-row .ant-switch');
  const switchBox = switches[0]?.getBoundingClientRect() ?? null;
  const rowBox = qa('.pg-plugin-row')[0]?.getBoundingClientRect() ?? null;

  // 展开一条被 `-` 规则停用的：详情必须说清是哪一层哪条规则
  const off = qa('.pg-plugin-row').find((r) => r.getAttribute('data-plugin-enabled') === '0');
  off?.querySelector('.pg-plugin-name')?.click();
  await sleep(300);
  const enabledBy = (off?.querySelector('[data-plugin-enabled-by]')?.textContent ?? '').trim();
  const detailDl = !!off?.querySelector('.pg-plugin-detail');

  // 点开关：必须发出 plugin_set_enabled，且写完重新拉取后状态真的变了
  const before = ops().length;
  const target = qa('.pg-plugin-row').find((r) => r.getAttribute('data-plugin-key')?.includes('quiet.ts'));
  target?.querySelector('.ant-switch')?.click();
  await sleep(600);
  const sent = ops().slice(before).filter((o) => o.name === 'plugin_set_enabled');
  const afterToggle = qa('.pg-plugin-row')
    .find((r) => r.getAttribute('data-plugin-key')?.includes('quiet.ts'))
    ?.getAttribute('data-plugin-enabled');

  // 内置那条必须没有开关（pi 的内置扩展不可管理）
  const builtinRow = qa('.pg-plugin-row').find((r) => r.getAttribute('data-plugin-key')?.startsWith('builtin:'));
  // pi 内置扩展不可管理：开关要么不渲染，要么必须是 disabled（DSH 的做法是渲染但禁用）
  const builtinSwitchEl = builtinRow?.querySelector('.ant-switch') ?? null;
  const builtinSwitch = builtinSwitchEl ? { disabled: builtinSwitchEl.disabled } : null;

  // 安装流程：裸包名要被拦下并给出 npm: 写法；填入示例后能装。
  //
  // ⚠️ 选择器用 `[role="dialog"]`，**不要**用 `.ant-modal-content`：
  // 那是 antd v5 的类名，6.6.5 换成了 rc-dialog 1.10 的结构
  // （`@rc-component/dialog/es/Dialog/Content/Panel.js:59,101` 只生成
  // `-body` / `-footer`，没有 `-content`）。用它选择会**静默选不到**——
  // 弹窗明明开着，断言却以为没开。
  const addBtn = qa('.pg-plugin-head-actions button')
    .find((b) => (b.textContent ?? '').replace(/\s/g, '') === '添加插件');
  const addBtnFound = !!addBtn;
  addBtn?.click();
  const clickAt = performance.now();
  let dialogMs = -1;
  for (let i = 0; i < 60; i += 1) {
    if (document.querySelector('[role="dialog"]')) {
      dialogMs = Math.round(performance.now() - clickAt);
      break;
    }
    await sleep(100);
  }
  const dlg = document.querySelector('[role="dialog"]');
  const dlgBtn = (label) =>
    [...(dlg?.querySelectorAll('button') ?? [])].find(
      (b) => (b.textContent ?? '').replace(/\s/g, '') === label,
    ) ?? null;
  const input = dlg?.querySelector('input[type="text"]') ?? null;
  let bareProblem = '';
  if (input) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, '@scope/pkg');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(700);
    bareProblem = (dlg.querySelector('.pg-plugin-dialog-error')?.textContent ?? '').trim();
  }
  const installDisabledWhenBad = dlgBtn('安装')?.disabled ?? null;
  dlg?.querySelectorAll('.pg-plugin-guide li button')[0]?.click();
  await sleep(700);
  const filled = input?.value ?? '';
  const installEnabled = dlgBtn('安装') ? !dlgBtn('安装').disabled : null;
  const recognized = (dlg?.querySelector('.pg-plugin-dialog-ok')?.textContent ?? '').trim();
  dlgBtn('安装')?.click();
  await sleep(1500);
  const job = document.querySelector('.pg-plugin-job');
  const jobText = (job?.textContent ?? '').trim();
  const jobLog = (job?.querySelector('.pg-plugin-job-log')?.textContent ?? '').trim();
  const installOps = ops().filter((o) => o.name === 'plugin_run');

  return {
    navLabels: qa('.pg-settings-navitem').map((b) => (b.textContent ?? '').trim()),
    groups,
    rows,
    switchRowAligned:
      switchBox && rowBox ? Math.abs(switchBox.top + switchBox.height / 2 - (rowBox.top + rowBox.height / 2)) < 12 : null,
    switchBox: switchBox ? { w: Math.round(switchBox.width), h: Math.round(switchBox.height) } : null,
    // 行内所有控件的垂直中心是否在同一条线上（塌成两行时会对不齐）
    rowCenters: (() => {
      const r = qa('.pg-plugin-row')[0];
      if (!r) return null;
      const end = r.querySelector('.pg-plugin-end');
      const cs = [...(end?.querySelectorAll('.ant-switch, button') ?? [])].map((e) => {
        const b = e.getBoundingClientRect();
        return Math.round(b.top + b.height / 2);
      });
      return cs.length === 0 ? null : Math.max(...cs) - Math.min(...cs);
    })(),
    enabledBy,
    detailDl,
    sent,
    afterToggle,
    builtinSwitch: builtinSwitch === null ? null : builtinSwitch.disabled,
    addBtnFound,
    dialogMs,
    bareProblem,
    installDisabledWhenBad,
    filled,
    recognized,
    installEnabled,
    jobPresent: !!job,
    jobHasOutput: jobLog.includes('pi install'),
    jobText: jobText.slice(0, 200),
    installOps: installOps.map((o) => o.args),
  };
});


await browser.close();
console.log(
  JSON.stringify(
    {
      ...probe, sessionPanelCount, pageErrors, fleet, preview, sidebarRoundTrips, emptyPane, emptyAfterClick,
      emptyBack, openInCwd, openIn, openInMenu, openInPick, openInAfterReload,
      openInFile, afterPrimary, fileMenu, afterReveal,
      monacoBefore, monacoOpened, monacoSwitchedBack, providers, settingsEdge, contributions, plugins,
      sessionTitle, menuProbe, cornerProbe, titleRun,
    },
    null,
    1,
  ),
);

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
/* 代码块：真浏览器里必须真的高亮、diff 必须有增删行底色、折叠必须成立且不吞内容 */
const cb = fleet.code ?? {};
if (!cb.cards) bad.push('代码块：hydrate 之后一张代码卡片都没渲染出来 ★');
else {
  if (!cb.shikiCards) {
    bad.push('代码块：一张卡都没生成 .shiki —— 语法高亮没生效（语言 chunk 没打进产物？）★');
  }
  if (cb.goColors < 3) {
    bad.push(`代码块：go 的 token 只有 ${cb.goColors} 种颜色，等于没高亮 ★`);
  }
  if (!cb.diff) bad.push('代码块：diff 卡片没出现（inferToolLang 没认出 git diff？）★');
  else {
    if (cb.diff.spans < 10) bad.push(`代码块：diff 只有 ${cb.diff.spans} 个 token span，高亮没产出 ★`);
    if (cb.diff.add !== 1) bad.push(`代码块：diff 里"新增行"应恰好 1 行，实际 ${cb.diff.add} ★`);
    if (cb.diff.del !== 1) bad.push(`代码块：diff 里"删除行"应恰好 1 行，实际 ${cb.diff.del} ★`);
    if (cb.diff.hunk !== 1) bad.push(`代码块：diff 里块头 @@ 应有底色，实际 ${cb.diff.hunk} ★`);
    const transparent = (v) => !v || v === 'rgba(0, 0, 0, 0)' || v === 'transparent';
    if (transparent(cb.diff.addBg)) bad.push(`代码块：新增行没有底色（${cb.diff.addBg}）★`);
    if (transparent(cb.diff.delBg)) bad.push(`代码块：删除行没有底色（${cb.diff.delBg}）★`);
    if (transparent(cb.addBgLight) || transparent(cb.delBgLight)) {
      bad.push(`代码块：亮色主题下 diff 行底色被抹掉了（add=${cb.addBgLight} del=${cb.delBgLight}）★`);
    }
    // 11 行 diff 全在 DOM 里（不是被 max-height 切掉）
    if (cb.diff.preLines < 11) bad.push(`代码块：diff 只渲染了 ${cb.diff.preLines} 行（应 11 行）★`);
  }
  if (!cb.showMore) bad.push('代码块：超高块没有"显示更多"按钮（很可能量错了元素，量的是外层 body）★');
  if (cb.collapsedLines < 60) {
    bad.push(`代码块：折叠块的内容被吞了，DOM 里只有 ${cb.collapsedLines} 行（应 60 行）★`);
  }
  if (!cb.collapsedHidden) bad.push('代码块：60 行的块没有默认折叠 ★');
  if (cb.silentFail) bad.push(`代码块：有 ${cb.silentFail} 张卡"声称有语言、没高亮、也不吭声"（静默失败又回来了）★`);
}
if (!preview.markdown?.mounted) bad.push('预览：markdown 文件连 Monaco 都没挂上（core chunk 没加载？）★');
else {
  if (preview.markdown.lang !== 'markdown') {
    bad.push(`预览：README.md 的语言条是 ${preview.markdown.lang}，应为 markdown ★`);
  }
  if (preview.markdown.colors < 2 || preview.markdown.classes < 2) {
    bad.push(
      `预览：README.md 只有 ${preview.markdown.colors} 种颜色 / ${preview.markdown.classes} 种 token 类，` +
        `等于没高亮（语言定义没注册？）★`,
    );
  }
  if (preview.markdown.silentFallback) {
    bad.push('预览：README.md 语言条写着 markdown，正文却全一个色 —— 静默降级成纯文本了 ★');
  }
}
if (!preview.go?.mounted) bad.push('预览：go 文件连 Monaco 都没挂上 ★');
else {
  if (preview.go.lang !== 'go') bad.push(`预览：main.go 的语言条是 ${preview.go.lang}，应为 go ★`);
  // 字符串/注释/关键字至少三种，一种色 = 没高亮
  if (preview.go.colors < 3) {
    bad.push(`预览：main.go 只有 ${preview.go.colors} 种 token 颜色（${JSON.stringify(preview.go.sampleColors)}），等于没高亮 ★`);
  }
}
if (!preview.unknown?.mounted) bad.push('预览：未知扩展名的文件没渲染出来 ★');
else {
  if (preview.unknown.lang !== 'plaintext') {
    bad.push(`预览：notes.zzz 的语言条是 ${preview.unknown.lang}，应为 plaintext（不许乱猜）★`);
  }
  if (preview.unknown.colors > 1) {
    bad.push(`预览：notes.zzz 出现了 ${preview.unknown.colors} 种颜色，纯文本不该有高亮 ★`);
  }
}
/* 按需：开了 markdown + go 两个文件，就只该下这两门语言的定义 */
const deps = [...langDeps].sort();
if (!deps.includes('markdown') || !deps.includes('go')) {
  bad.push(`预览：语言定义没按需下载（只见到 ${JSON.stringify(deps)}）—— 高亮可能根本没加载 ★`);
}
if (deps.length > 2) {
  bad.push(`预览：开了 2 个文件却下了 ${deps.length} 门语言定义 ${JSON.stringify(deps)}（有人把全语言注册接回来了？）★`);
}
/* 侧栏折叠：折叠后必须留下一条 56px 图标轨 + 可点的展开入口，且能真的来回 */
if (!sidebarRoundTrips.length) bad.push('侧栏折叠：一轮都没跑成 ★');
for (const r of sidebarRoundTrips) {
  const at = `侧栏折叠第 ${r.round} 轮`;
  if (r.error) {
    bad.push(`${at}：${r.error} —— 折叠 = 进死胡同（用户截图那个状态）★`);
    continue;
  }
  if (r.collapsed.sidebarW !== 0) bad.push(`${at}：折叠后侧栏还有 ${r.collapsed.sidebarW}px ★`);
  if (r.collapsed.railW !== 56) {
    bad.push(`${at}：折叠态图标轨宽 ${r.collapsed.railW}px，应为 56px（DSH SIDEBAR_COLLAPSED）★`);
  }
  if (!r.collapsed.expandBtn) bad.push(`${at}：图标轨上没有展开按钮 ★`);
  if (JSON.stringify(r.collapsed.railButtons) !== JSON.stringify(['展开侧栏', '新建会话', '设置'])) {
    bad.push(`${at}：图标轨按钮是 ${JSON.stringify(r.collapsed.railButtons)}（都要有可访问名）★`);
  }
  if (!(r.expanded?.sidebarW > 0)) bad.push(`${at}：点展开后侧栏没回来（宽 ${r.expanded?.sidebarW}）★`);
  if (r.expanded?.railW !== 0) bad.push(`${at}：展开后图标轨还在（宽 ${r.expanded?.railW}）★`);
  if (r.expanded?.tabs !== r.collapsed.tabs) {
    bad.push(`${at}：折来折去把标签数改了（${r.collapsed.tabs} → ${r.expanded?.tabs}）★`);
  }
}
/* 空编辑区占位：水印 + 快捷键（与注册表逐条对齐）+ 中央入口真的能点、真的执行 */
if (!emptyPane.present) bad.push('空编辑区：关光标签后没有出现占位（还是一片黑）★');
else {
  if (emptyPane.logo !== '🐷') bad.push(`空编辑区：水印是 ${emptyPane.logo} ★`);
  if (!(emptyPane.logoOpacity <= 0.15)) bad.push(`空编辑区：水印不淡（opacity ${emptyPane.logoOpacity}）★`);
  if (emptyPane.tabsWhileEmpty !== 0) bad.push(`空编辑区：占位出现时还有 ${emptyPane.tabsWhileEmpty} 个标签 ★`);
  if (emptyPane.rows < 5) bad.push(`空编辑区：只列了 ${emptyPane.rows} 条快捷键（太少，用户要的是"基础快捷键"）★`);
  if (emptyPane.mismatched.length) {
    bad.push(
      `空编辑区：快捷键/标题与命令注册表不一致 ${JSON.stringify(emptyPane.mismatched)}（写死了？）★`,
    );
  }
  if (emptyPane.entries < 3) bad.push(`空编辑区：中央入口只有 ${emptyPane.entries} 个 ★`);
  const dead = emptyPane.hits.filter((h) => !h.hittable);
  if (dead.length) {
    bad.push(`空编辑区：入口 ${JSON.stringify(dead.map((d) => d.cmd))} 点不到（被别的层挡住了？）★`);
  }
  if (!emptyAfterClick.paneGone || emptyAfterClick.tabs !== 1) {
    bad.push(
      `空编辑区：点「新建会话」没有建出标签（tabs=${emptyAfterClick.tabs}、占位消失=${emptyAfterClick.paneGone}` +
        `${emptyClickError ? `、点击异常：${emptyClickError}` : ''}）★`,
    );
  }
  if (!emptyBack) bad.push('空编辑区：再次关光标签后占位没回来 ★');
}
/* 「打开方式」：位置/显著性/菜单方向/送出参数/记忆 */
if (!openIn.present) bad.push('打开方式：会话头部右侧没有那枚分裂胶囊（用户指的就是这个位置）★');
else {
  if (openIn.label !== '访达') bad.push(`打开方式：默认主按钮是 ${openIn.label}（mock 列表第一个是"访达"）★`);
  if (openIn.kind !== 'directory') bad.push(`打开方式：会话头部那颗的 data-open-target 是 ${openIn.kind}，应为 directory ★`);
  if (openIn.size !== 'large') bad.push(`打开方式：会话头部那颗的 data-size 是 ${openIn.size}，应为 large（带应用名）★`);
  if (!openIn.hittable) bad.push('打开方式：主按钮中心点被别的层挡住，点不到 ★');
  if (!(openIn.height >= 24)) bad.push(`打开方式：胶囊只有 ${openIn.height}px 高（太隐形，用户要"显著一点"）★`);
  if (!(openIn.borderWidth > 0)) bad.push('打开方式：胶囊没有边框（跟置灰图标一样隐形）★');
  if (!(openIn.width >= 70)) bad.push(`打开方式：胶囊只有 ${openIn.width}px 宽（只有图标？用户要"显著一点"）★`);
  if (!openIn.beforeChevron) bad.push('打开方式：主按钮与箭头的顺序反了 ★');
  if (!openIn.linkExternalPlaceholderGone) bad.push('打开方式：占位按钮还在（没被真按钮替掉）★');
  if (!openIn.morePlaceholderStillThere) bad.push('打开方式：顺手把「更多」占位也删了？它仍是 M2 排期 ★');
}
if (!openInMenu.open) bad.push(`打开方式：箭头点不开菜单${openInMenuError ? `（${openInMenuError}）` : ''} ★`);
else {
  if (openInMenu.count !== 5) bad.push(`打开方式：菜单里 ${openInMenu.count} 项（mock 给了 5 个）★`);
  if (openInMenu.withImage < 1) bad.push('打开方式：一个真实应用图标都没渲染（全退化成通用方块了？）★');
  if (openInMenu.withGeneric < 1) bad.push('打开方式：图标缺失时没有退化成通用方块（会显示破图）★');
  if (openInMenu.belowAnchor !== true) bad.push('打开方式：菜单没有从胶囊下方弹出（会话头部在窗口顶部）★');
  if (openInMenu.insideViewport !== true) bad.push('打开方式：菜单超出可视区 ★');
}
if (!openInPick.clicked) {
  bad.push(`打开方式：菜单里点不到 GoLand${openInPickError ? `（${openInPickError}）` : ''} ★`);
} else {
  const last = (openInPick.calls ?? []).at(-1);
  if (!last) bad.push('打开方式：点了菜单却没送出启动请求 ★');
  else {
    if (last.id !== 'goland') bad.push(`打开方式：启动的是 ${last.id}（点的是 GoLand）★`);
    if (last.path !== openInCwd) bad.push(`打开方式：打开的目录是 ${last.path}，应为会话 cwd ${openInCwd} ★`);
  }
  if (openInPick.stored !== 'goland') bad.push(`打开方式：没记住选择（localStorage=${openInPick.stored}）★`);
  if (openInPick.app !== 'goland') bad.push(`打开方式：选完主按钮没换成 GoLand（还是 ${openInPick.app}）★`);
  if (!openInPick.menuClosed) bad.push('打开方式：选完菜单没关 ★');
}
if (!openInAfterReload.present) bad.push('打开方式：重载后按钮不见了（布局没恢复？）★');
else if (openInAfterReload.app !== 'goland') {
  bad.push(`打开方式：重载后忘掉了上次选择（变成 ${openInAfterReload.app}）★`);
}
if (openInAfterReload.splits > 1) bad.push(`打开方式：界面上出现了 ${openInAfterReload.splits} 个胶囊（会话头只有一个）★`);

/* 「打开方式」文件那一档 */
if (!openInFile.present) {
  bad.push('打开方式（文件）：预览头部没有那颗按钮（桌面能力为真时必须渲染）★');
} else {
  if (openInFile.kind !== 'file') bad.push(`打开方式（文件）：data-open-target 是 ${openInFile.kind}，应为 file ★`);
  if (openInFile.size !== 'compact') bad.push(`打开方式（文件）：data-size 是 ${openInFile.size}，应为 compact（预览头部只有图标）★`);
  if (!(openInFile.title ?? '').includes('Typora.app')) {
    bad.push(`打开方式（文件）：主按钮没指向系统默认应用（title=${openInFile.title}）★`);
  }
  if (!openInFile.hasIcon) bad.push('打开方式（文件）：默认应用的真图标没渲染出来 ★');
  if (!(openInFile.height >= 22 && openInFile.height <= 28)) bad.push(`打开方式（文件）：胶囊高 ${openInFile.height}px，与 38px 预览头部不搭 ★`);
  if (!(openInFile.borderWidth > 0)) bad.push('打开方式（文件）：胶囊没有边框 ★');
  if (!openInFile.hittable) bad.push('打开方式（文件）：主按钮中心点被别的层挡住 ★');
  if (!openInFile.lastInHead) bad.push('打开方式（文件）：它不在文档动作位的最后（DSH 在 wrap/reload 之后）★');
  if (openInFile.lang !== 'rust') bad.push(`预览：lib.rs 的语言条是 ${openInFile.lang}，应为 rust（本地语言表漏了这一门？）★`);
  if (openInFile.tokens < 2) bad.push(`预览：lib.rs 只有 ${openInFile.tokens} 种 token 类 —— .rs 静默降级成纯文本了 ★`);
}
if (openInFileError) bad.push(`打开方式（文件）：点击异常 ${openInFileError} ★`);
if (!afterPrimary) bad.push('打开方式（文件）：点主按钮没有送出任何请求 ★');
else {
  if (afterPrimary.action !== 'open') bad.push(`打开方式（文件）：主按钮送的是 action=${afterPrimary.action} ★`);
  if (afterPrimary.application !== '/Applications/Typora.app') {
    bad.push(`打开方式（文件）：主按钮没用系统默认应用（application=${afterPrimary.application}）★`);
  }
  if (afterPrimary.path !== '/Users/mock/proj/lib.rs') {
    bad.push(`打开方式（文件）：打开的是 ${afterPrimary.path}，应为预览的文件 /Users/mock/proj/lib.rs ★`);
  }
}
if (fileMenu.labels.length !== 3) bad.push(`打开方式（文件）：菜单 ${fileMenu.labels.length} 项，应为 2 个处理器 + 显示文件位置（${JSON.stringify(fileMenu.labels)}）★`);
if (!fileMenu.labels.some((l) => (l ?? '').includes('显示文件位置'))) bad.push('打开方式（文件）：菜单里没有「显示文件位置」★');
if (fileMenu.withImage < 1) bad.push('打开方式（文件）：处理器没有真图标 ★');
if (fileMenu.withGeneric < 1) bad.push('打开方式（文件）：图标缺失时没退化成通用方块 ★');
if (fileMenu.belowAnchor !== true) bad.push('打开方式（文件）：菜单没有从胶囊下方弹出 ★');
if (revealError) bad.push(`打开方式（文件）：点「显示文件位置」异常 ${revealError} ★`);
if (!afterReveal || afterReveal.action !== 'reveal') {
  bad.push(`打开方式（文件）：「显示文件位置」送出的 action=${afterReveal?.action}（应为 reveal）★`);
}
if (afterReveal && afterReveal.application !== null) {
  bad.push(`打开方式（文件）：reveal 不该带 application（送了 ${afterReveal.application}）★`);
}

/* Monaco 实例池：不许再有"已达上限"的墙，也不许每开一个标签就多留一个实例 */
if (monacoOpened.refused > 0) {
  bad.push(`Monaco：开了 8 个预览后出现 ${monacoOpened.refused} 处"实例已达上限"（旧硬上限那道墙又回来了？）★`);
}
if (monacoSwitchedBack.refused > 0) {
  bad.push('Monaco：切回旧标签后仍有"已达上限"提示（超限状态不可恢复）★');
}
if (!(monacoOpened.watermark >= 1)) {
  bad.push('Monaco：读不到实例池的水位（__piggyMonacoPool 没挂上？这条核对是空转）★');
} else if (monacoOpened.live > monacoOpened.watermark) {
  bad.push(`Monaco：开 8 个预览后活着 ${monacoOpened.live} 个实例，超过水位 ${monacoOpened.watermark}（没回收？）★`);
}
if (monacoOpened.live < 1) bad.push('Monaco：当前可见的预览反而没有实例（可见才创建过头了）★');
if (!monacoOpened.lastMounted) bad.push('Monaco：最后打开的那个预览没挂上编辑器 ★');
if (monacoOpened.lastLang !== 'rust') bad.push(`Monaco：最后那个预览的语言条是 ${monacoOpened.lastLang}，应为 rust ★`);
if (!monacoSwitchedBack.mounted) {
  bad.push('Monaco：切回被回收的标签后编辑器没重建（预览变空白了）★');
} else {
  if (monacoSwitchedBack.tokens < 2) {
    bad.push(`Monaco：切回来只有 ${monacoSwitchedBack.tokens} 种 token 类（重建后没高亮）★`);
  }
  if (!monacoSwitchedBack.firstLine.includes('mock')) {
    bad.push(`Monaco：切回来内容不对（首行 "${monacoSwitchedBack.firstLine}"）★`);
  }
}
if (monacoBefore.heapMB !== null && monacoOpened.heapMB !== null) {
  const grew = monacoOpened.heapMB - monacoBefore.heapMB;
  // 8 个实例全留着的话 ~8-12MB；这里只该多出"可见 + 水位内"的那几个
  if (grew > 40) bad.push(`Monaco：开 8 个预览多占了 ${grew}MB 堆（回收没生效？）★`);
}


/* 提供商配置页：列表 / 来源 / 检测 / 获取模型 / 保存 / 添加 */
if (providers.list.nav.join(',') !== '模型,插件,通用设置,高级') {
  bad.push(`配置页：左导航是 ${JSON.stringify(providers.list.nav)}，应为 模型/插件/通用设置/高级（DSH 版式）★`);
}
if (providers.list.rows.length < 2) {
  bad.push(`配置页：列表只有 ${JSON.stringify(providers.list.rows)} —— 没接上 provider_overview？★`);
}
if (providers.list.dotsOn < 2) bad.push(`配置页：${providers.list.rows.length} 个提供商里只有 ${providers.list.dotsOn} 个亮着"已配置"点 ★`);
if (!(providers.list.meta ?? '').includes('models.json')) {
  bad.push(`配置页：列表没说密钥来源（meta="${providers.list.meta}"）★`);
}
if (!providers.list.tags.includes('自定义') || !providers.list.tags.includes('默认')) {
  bad.push(`配置页：自定义/默认标记没渲染（tags=${JSON.stringify(providers.list.tags)}）★`);
}
if (!providers.list.addButton) bad.push('配置页：没有「+ 添加模型提供商」入口 ★');

if (!providers.edit.present) bad.push('配置页：点「编辑」没有出现编辑卡片 ★');
else {
  if (!(providers.edit.keyPlaceholder ?? '').includes('已配置')) {
    bad.push(`配置页：已配置的提供商密钥框占位是 "${providers.edit.keyPlaceholder}"（应提示已配置）★`);
  }
  if (!(providers.edit.keyMeta ?? '').includes('models.json')) {
    bad.push(`配置页：编辑卡片没写"当前生效的密钥来自哪"（"${providers.edit.keyMeta}"）★`);
  }
  if (!providers.edit.customizedCollapsed) {
    bad.push('配置页：自定义设置默认没折叠（DSH 是折叠的，密钥才是主字段）★');
  }
}
/* 会话标题 + 右键菜单（第 14 段） */
{
  const st = sessionTitle ?? {};
  if (!st.rowCount) bad.push('会话标题：侧栏一行会话都没有，这条核对失去意义 ★');
  if (!st.hasIcon) bad.push('会话标题：会话行上没有「生成标题」图标（第三个入口缺了）★');
  if (!/标题/.test(st.iconLabel ?? '')) {
    bad.push(`会话标题：图标的可访问名是 "${st.iconLabel}"，应当说明它做什么 ★`);
  }
  const mp = menuProbe ?? {};
  if (!mp.present) bad.push('会话标题：在会话行上真右键没有唤出菜单 ★');
  else {
    if (mp.role !== 'menu') bad.push(`会话标题：菜单的 role 是 ${mp.role}，应为 menu ★`);
    if (!mp.insideViewport) bad.push(`会话标题：菜单超出了视口（${JSON.stringify(mp.rect)}）★`);
    if (mp.anyWrapped) bad.push('会话标题：有菜单项被折成两行（中文文案竖排/折行）★');
    if (!mp.focused) bad.push('会话标题：菜单打开后没有拿到焦点（键盘用不了）★');
    if (!(mp.items ?? []).some((i) => String(i).includes('生成标题'))) {
      bad.push(`会话标题：菜单里没有「生成标题」（只有 ${JSON.stringify(mp.items)}）★`);
    }
    if (!(mp.items ?? []).some((i) => String(i).includes('重命名'))) {
      bad.push('会话标题：菜单里没有「重命名」——右键菜单应当是会话操作的完整入口 ★');
    }
  }
  const cp = cornerProbe ?? {};
  if (!cp.ok) bad.push(`会话标题：右下角右键这一路没跑通（${cp.why ?? '菜单没开'}）★`);
  else {
    if (!cp.insideViewport) bad.push('会话标题：在窗口右下角右键时菜单被视口切掉了（没有贴边内收）★');
    if (!cp.flipped) bad.push('会话标题：右下角右键时菜单没有往左上翻 ★');
    if (!cp.closedByEscape) bad.push('会话标题：Escape 关不掉菜单 ★');
  }
  const tr = titleRun ?? {};
  if (!tr.clicked) bad.push('会话标题：菜单里点不到「生成标题」★');
  else {
    if (!(tr.ops ?? []).includes('session_title_generate')) {
      bad.push(`会话标题：点生成没有发出 session_title_generate（发了 ${JSON.stringify(tr.ops)}）★`);
    }
    if (!tr.changed) {
      bad.push(`会话标题：生成完侧栏那一行还是「${tr.titleAfter}」——没有重新拉列表或没写回名字 ★`);
    }
    if (!tr.menuClosed) bad.push('会话标题：点了菜单项之后菜单还开着 ★');
  }
}

/* 插件页（第 13 段）：四种来源、状态归属、启停真的落到 pi 的文件上、安装真的起任务 */
{
  const p = plugins ?? {};
  const labels = p.navLabels ?? [];
  if (labels.join(',') !== '模型,插件,通用设置,高级') {
    bad.push(`插件页：左导航是 ${JSON.stringify(labels)}，应含「插件」★`);
  }
  const groupIds = (p.groups ?? []).map((g) => g.id).join(',');
  if (groupIds !== 'project,global,builtin') {
    bad.push(`插件页：分组是 ${JSON.stringify(p.groups)}，应为 本项目/全局/pi 内置（按 pi 的加载优先级排）★`);
  }
  const rows = p.rows ?? [];
  if (rows.length < 5) bad.push(`插件页：只渲染了 ${rows.length} 行（mock 有 5 条，跨四种来源）★`);
  const kinds = new Set(rows.map((r) => r.kind));
  for (const k of ['插件包', '发现目录', 'pi 内置']) {
    if (!kinds.has(k)) bad.push(`插件页：没有「${k}」类型的行（类型徽标没按来源渲染）★`);
  }
  if (!rows.some((r) => !r.enabled)) bad.push('插件页：没有"已停用"的行，停用态没渲染 ★');
  if (!rows.some((r) => r.missing)) bad.push('插件页：没有"找不到文件"的行（声明了但没装的必须显示出来）★');
  // 几何：行不能塌（按钮/开关竖排时行高会异常；这是用户实测过的坑）
  const tall = rows.filter((r) => r.h > 120);
  if (tall.length) bad.push(`插件页：有 ${tall.length} 行高 ${tall.map((r) => r.h).join('/')}px，行内元素塌成竖排了 ★`);
  if (p.switchRowAligned === false) bad.push('插件页：开关与行内容没有垂直居中（版式塌了）★');
  if (p.switchBox && !(p.switchBox.w >= 20 && p.switchBox.w <= 44 && p.switchBox.h >= 12 && p.switchBox.h <= 24)) {
    bad.push(`插件页：开关尺寸是 ${p.switchBox.w}×${p.switchBox.h}，不像一个正常的 Switch（塌了？）★`);
  }
  if (typeof p.rowCenters === 'number' && p.rowCenters > 6) {
    bad.push(`插件页：同一行里控件的垂直中心相差 ${p.rowCenters}px —— 行内元素折行了 ★`);
  }
  if (typeof p.dialogMs === 'number' && p.dialogMs > 1500) {
    bad.push(`插件页：点「添加插件」到弹窗出现用了 ${p.dialogMs}ms（超过 1.5s，用户会以为没反应）★`);
  }
  // 状态归属：规矩 30 —— 必须说得出是哪一层哪条规则
  if (!p.detailDl) bad.push('插件页：点名字没有展开详情 ★');
  if (!/规则|autoload|默认加载|内置/.test(p.enabledBy ?? '')) {
    bad.push(`插件页：展开后没说清"状态是谁定的"（"${p.enabledBy}"）★`);
  }
  // 启停：必须真的发出命令，并且写完重拉后状态翻转
  if ((p.sent ?? []).length === 0) bad.push('插件页：点开关没有发出 plugin_set_enabled ★');
  else {
    const a = p.sent.at(-1).args;
    if (a.enabled !== true) bad.push(`插件页：把停用的打开时送出的 enabled=${String(a.enabled)} ★`);
    if (!String(a.key ?? '').includes('quiet.ts')) bad.push(`插件页：送出的 key 不对（${String(a.key)}）★`);
  }
  if (p.afterToggle !== '1') {
    bad.push(`插件页：点开关后那一行仍是 data-plugin-enabled=${String(p.afterToggle)}（没重拉或没生效）★`);
  }
  // pi 内置扩展不可管理：不该有开关
  if (p.builtinSwitch === false) {
    bad.push('插件页：pi 内置扩展那行的开关是可点的（pi 里它不可停用，-ne 也关不掉）★');
  }
  // 安装流程
  if (!(p.dialogMs >= 0)) bad.push('插件页：点「添加插件」没打开对话框 ★');
  if (!/裸名字|npm:/.test(p.bareProblem ?? '')) {
    bad.push(`插件页：裸包名没有被拦下并提示 npm: 写法（"${p.bareProblem}"）★`);
  }
  if (p.installDisabledWhenBad !== true) {
    bad.push('插件页：来源非法时「安装」按钮仍可点 ★');
  }
  if (p.filled !== 'npm:pi-guardrails') bad.push(`插件页：「填入示例」没把示例填进输入框（"${p.filled}"）★`);
  if (!/npm/.test(p.recognized ?? '')) bad.push(`插件页：合法来源没显示"识别为什么"（"${p.recognized}"）★`);
  if (p.installEnabled !== true) bad.push('插件页：合法的来源没能让「安装」按钮可点 ★');
  if ((p.installOps ?? []).length === 0) bad.push('插件页：点安装没有发出 plugin_run ★');
  else {
    const a = p.installOps.at(-1);
    if (a.action !== 'install') bad.push(`插件页：plugin_run 的 action=${String(a.action)} ★`);
    if (a.source !== 'npm:pi-guardrails') bad.push(`插件页：plugin_run 的 source=${String(a.source)} ★`);
    if (a.scope !== 'global') bad.push(`插件页：plugin_run 的 scope=${String(a.scope)} ★`);
  }
  if (!p.jobPresent) bad.push('插件页：安装后没有出现任务面板（长任务的输出必须看得见）★');
  else if (!p.jobHasOutput) bad.push(`插件页：任务面板没有显示命令输出（"${p.jobText}"）★`);
}

const probeCall = providers.probe.ops.at(-1) ?? null;
if (!probeCall || probeCall.name !== 'provider_discover') {
  bad.push(`配置页：「检测」没有发出 provider_discover（发的是 ${probeCall?.name ?? '什么都没有'}）★`);
} else {
  const a = probeCall.args;
  if (a.provider !== 'cc-switch-deep-seek') bad.push(`配置页：检测的是 ${String(a.provider)} ★`);
  if (a.baseUrl !== 'https://api.deepseek.com/v1') bad.push(`配置页：检测没带 API 地址（${String(a.baseUrl)}）★`);
  if (a.api !== 'openai-completions') bad.push(`配置页：检测没带 API 协议（${String(a.api)}）★`);
  if (a.apiKey !== null) bad.push('配置页：没重新输密钥却把密钥送出去了（应该用已存的那把）★');
}
if (!(providers.probe.ok ?? '').includes('个模型')) {
  bad.push(`配置页：检测成功但界面没说测到了什么（${providers.probe.ok ?? providers.probe.error}）★`);
}
if (providers.fetch.dialogRows.length < 2) {
  bad.push(`配置页：获取可用模型只拿到 ${JSON.stringify(providers.fetch.dialogRows)} ★`);
}
if (!providers.fetch.alreadyDisabled) bad.push('配置页：已在表里的模型没有禁用勾选（会重复添加）★');
if (!providers.fetch.adoptedVisible) {
  bad.push(`配置页：勾选后"添加所选"没进模型表（表里是 ${JSON.stringify(providers.fetch.modelRowIds)}）★`);
}
if (!(providers.save.meta ?? '').includes('sk-mock')) {
  bad.push(`配置页：保存后列表没刷新（meta="${providers.save.meta}"）★`);
}
if (!(providers.save.savedNotice ?? '').includes('已保存')) {
  bad.push('配置页：保存后没有"已保存 XX"的回执 ★');
}
const saved = providers.opsAfterSave ?? [];
const saveIdx = saved.findIndex((o) => o.name === 'provider_save');
const keyIdx = saved.findIndex((o) => o.name === 'provider_set_key');
if (saveIdx < 0) bad.push('配置页：点保存没有发出 provider_save ★');
if (keyIdx < 0) bad.push('配置页：输入了新密钥却没有 provider_set_key ★');
if (saveIdx >= 0 && keyIdx >= 0 && saveIdx > keyIdx) {
  bad.push('配置页：先写密钥再写配置（配置写失败会留下"密钥已换、地址没换"的半张卡）★');
}
const setKeyOp = keyIdx >= 0 ? saved[keyIdx] : null;
if (setKeyOp) {
  if (setKeyOp.args.provider !== 'cc-switch-deep-seek') bad.push(`配置页：密钥写给 ${String(setKeyOp.args.provider)} ★`);
  if (setKeyOp.args.store !== 'models') {
    bad.push(`配置页：密钥存储位置没跟随现状（这一行的密钥本来在 models.json，却写到了 ${String(setKeyOp.args.store)}）★`);
  }
}
const saveOp = saveIdx >= 0 ? saved[saveIdx] : null;
const patch = (saveOp?.args.patch ?? {}) ;
if (saveOp && !('name' in patch && 'baseUrl' in patch && 'api' in patch && 'models' in patch)) {
  bad.push(`配置页：保存的载荷字段不全（${JSON.stringify(Object.keys(patch))}）★`);
}
if (providers.add.options.length > 0 && !providers.add.options.join('|').includes('deepseek')) {
  bad.push(`配置页：目录下拉里没有可添加的提供商（${JSON.stringify(providers.add.options)}）★`);
}
if (!providers.add.editorPresent) bad.push('配置页：从目录选了一个提供商却没出现编辑卡片 ★');
else if (!(providers.add.baseUrl ?? '').startsWith('https://api.deepseek.com')) {
  bad.push(`配置页：从目录添加时地址没预填目录默认值（"${providers.add.baseUrl}"）★`);
}
if (!(providers.add.rowsAfterSave ?? []).includes('deepseek')) {
  bad.push(`配置页：从目录添加并保存后，列表里没有它（${JSON.stringify(providers.add.rowsAfterSave)}）★`);
}


/* 配置页几何 + Monaco 外部值同步（用户实测反馈的两个坑） */
if (!settingsEdge.probe) bad.push('配置页：编辑卡片里找不到「检测」按钮（这条核对是空转）★');
else {
  const p = settingsEdge.probe;
  if (p.whiteSpace !== 'nowrap') bad.push(`配置页：「检测」按钮的 white-space 是 ${p.whiteSpace}，中文会被折成竖排单字 ★`);
  if (!p.fitsOneLine) bad.push(`配置页：「检测」按钮文字没在一行里放下（${p.w}×${p.h}，scrollHeight≠clientHeight）★`);
  if (!(p.h <= 36)) bad.push(`配置页：「检测」按钮高 ${p.h}px（单行应该 ~27px，44px 就是竖排两行了）★`);
  if (!(p.w >= 44)) bad.push(`配置页：「检测」按钮只有 ${p.w}px 宽（两个字 + 内边距应该 ≥44）★`);
}
const firstModels = settingsEdge.first.models;
const secondModels = settingsEdge.second.models;
if (firstModels.lines < 2 || firstModels.text.trim() === '{}') {
  bad.push(`配置页：第一次进「高级」时 models.json 编辑器是空的（${firstModels.lines} 行）★`);
}
if (secondModels.text !== firstModels.text) {
  bad.push(
    `配置页：切走再回「高级」，JSON 内容变了（第一次 ${firstModels.lines} 行 → 第二次 ${secondModels.lines} 行）` +
      '—— Monaco 的 value 只在创建时取一次，异步值到晚了就永远停在初始值 ★',
  );
}
if (settingsEdge.first.settings.lines < 2 || settingsEdge.second.settings.lines < 2) {
  bad.push('配置页：settings.json 编辑器也是空的（同一个原因）★');
}
for (const [i, d] of [...settingsEdge.first.saveDisabled, ...settingsEdge.second.saveDisabled].entries()) {
  if (d !== true) {
    bad.push(`配置页：第 ${i + 1} 次读到的保存按钮不是 disabled —— 编程式写入被当成了"用户编辑"★`);
  }
}
/* 编辑器贡献：只有 editor.api 时，预览里既没有折叠控件也唤不出 ⌘F 查找框（实测 0 / false） */
const contrib = contributions;
if (!(contrib.lines > 0)) bad.push('预览：编辑器贡献那条核对是空转（连正文行都没渲染）★');
if (!(contrib.folding > 0)) {
  bad.push('预览：没有折叠控件 —— 编辑器贡献（folding 等 59 个）没进依赖图，Monaco 退化成一个只会上色的壳 ★');
}
if (!contrib.clickAt) {
  bad.push('预览：拿不到可点的编辑器坐标，⌘F 那条核对是空转 ★');
} else if (contrib.findWidget.inDocument === 0 || contrib.findWidget.inPreview === 0) {
  bad.push(
    `预览：⌘F 唤不出查找框（全文档 ${contrib.findWidget.inDocument} 个、预览里 ${contrib.findWidget.inPreview} 个）` +
      '—— find 贡献没加载 ★',
  );
}

if (pageErrors.length) bad.push(`页面错误 ${pageErrors.length} 条：${pageErrors.slice(0, 2).join(' | ')}`);

console.log(bad.length ? `\n❌ ${bad.join('\n❌ ')}` : '\n✅ 全部通过');
process.exit(bad.length ? 1 : 0);
