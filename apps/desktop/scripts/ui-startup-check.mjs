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
  const split = head?.querySelector('.pg-openin-split');
  const main = split?.querySelector('.pg-openin-main');
  const chev = split?.querySelector('.pg-openin-chevron');
  if (!head || !split || !main || !chev) return { present: false };
  const cs = getComputedStyle(split);
  const r = split.getBoundingClientRect();
  const mr = main.getBoundingClientRect();
  const top = document.elementFromPoint(mr.left + mr.width / 2, mr.top + mr.height / 2);
  return {
    present: true,
    label: main.textContent,
    app: main.getAttribute('data-app'),
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
    .click('.pg-openin-chevron', { timeout: 5000 })
    .catch((e) => (openInMenuError = String(e).split('\n')[0]));
  await page.waitForTimeout(300);
}
const openInMenu = await page.evaluate(() => {
  const box = document.querySelector('.pg-picker-menu');
  const anchor = document.querySelector('.pg-openin-split');
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
    const main = document.querySelector('.pg-openin-main');
    return {
      clicked: true,
      calls: (globalThis.__piggyMock?.openCalls ?? []).map((c) => ({ ...c })),
      app: main?.getAttribute('data-app') ?? null,
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
  const main = document.querySelector('.pg-openin-main');
  return {
    present: !!main,
    app: main?.getAttribute('data-app') ?? null,
    label: main?.textContent ?? null,
    splits: document.querySelectorAll('.pg-openin-split').length,
  };
});

await browser.close();
console.log(
  JSON.stringify(
    {
      ...probe, sessionPanelCount, pageErrors, fleet, preview, sidebarRoundTrips, emptyPane, emptyAfterClick,
      emptyBack, openInCwd, openIn, openInMenu, openInPick, openInAfterReload,
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

if (pageErrors.length) bad.push(`页面错误 ${pageErrors.length} 条：${pageErrors.slice(0, 2).join(' | ')}`);

console.log(bad.length ? `\n❌ ${bad.join('\n❌ ')}` : '\n✅ 全部通过');
process.exit(bad.length ? 1 : 0);
