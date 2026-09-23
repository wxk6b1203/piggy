/**
 * Piggy UI 调试台（一条命令：截图 + 页面错误 + 布局体检 + JSON 报告）。
 *
 * 背景：Tauri 窗口里 DevTools 不便常开；本脚本用 Playwright + Vite 页面（自动 mock IPC）
 * 把"看到页面"与"看到错误"合成一次可复现的运行，等价于 DSH 的 browser-use 能力但零配置。
 *
 * 引擎选择很关键：Tauri 在 macOS 上用的是 **WKWebView**，与 Chromium 并非同一套 CSS 实现。
 * 只跑 Chrome 会漏掉 WebKit 特有的问题（mask / color-mix / corner-shape / 滚动条等）。
 * 因此 `--browser webkit` 应当作为**发布前必跑**的一档。
 *
 * 用法：
 *   pnpm ui:debug                          # 默认 chrome
 *   pnpm ui:debug -- --browser webkit      # 用 WKWebView 同族引擎复核
 *     ⚠️ 本机实测 Playwright 的 WebKit 启动会挂死（环境问题，非脚本问题），
 *        该档目前不可用；WebKit 侧的实际验证靠真机跑 Tauri。
 *   pnpm ui:debug -- --out /tmp/a.png      # 指定截图路径
 *   pnpm ui:debug -- --click ".pg-ws-tab" --wait 800   # 交互后再截图（可重复 --click）
 *   pnpm ui:debug -- --json /tmp/report.json           # 报告落盘
 *   pnpm ui:debug -- --strict              # 有 error 级问题即非零退出（可进 CI）
 *
 * 前置：`pnpm dev`（Vite :5195）已在跑。
 */
import { chromium, webkit } from 'playwright';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes(`--${name}`);
const clicks = argv.filter((a, i) => argv[i - 1] === '--click');

const URL = flag('url', 'http://localhost:5195');
const out = flag('out', '/tmp/piggy-ui.png');
const jsonOut = flag('json', null);
const waitMs = Number(flag('wait', 2500));
const strict = has('strict');
const browserName = flag('browser', 'chrome');

const browser =
  browserName === 'webkit'
    ? await webkit.launch()
    : await chromium.launch({ channel: browserName === 'chromium' ? undefined : 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const report = {
  url: URL,
  browser: browserName,
  screenshot: out,
  pageErrors: [],
  consoleErrors: [],
  consoleWarnings: [],
  failedRequests: [],
  layoutIssues: [],
  dom: {},
  takenAt: new Date().toISOString(),
};

page.on('console', (m) => {
  const line = `${m.text()} @ ${m.location().url}:${m.location().lineNumber}`;
  if (m.type() === 'error') report.consoleErrors.push(line);
  else if (m.type() === 'warning') report.consoleWarnings.push(line);
});
page.on('pageerror', (e) => report.pageErrors.push(e.stack ?? String(e)));
page.on('requestfailed', (r) =>
  report.failedRequests.push(`${r.method()} ${r.url()} — ${r.failure()?.errorText ?? 'unknown'}`),
);
page.on('response', (r) => {
  // 404/500 的**文档/脚本/样式**才算硬错误；favicon 之类单独标注避免噪音
  if (r.status() < 400) return;
  const u = r.url();
  const kind = /favicon|\.ico(\?|$)/.test(u) ? 'favicon' : 'resource';
  report.failedRequests.push(`HTTP ${r.status()} [${kind}] ${u}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(waitMs);

for (const sel of clicks) {
  try {
    await page.click(sel, { timeout: 4000 });
    await page.waitForTimeout(500);
  } catch (e) {
    report.pageErrors.push(`交互失败 --click "${sel}": ${e.message}`);
  }
}

await page.screenshot({ path: out });

// ---------- 布局体检 ----------
report.layoutIssues = await page.evaluate(() => {
  const issues = [];
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const name = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (cls ? `.${cls}` : '');
  };
  /** 自身或任一祖先是纵向/横向滚动容器 → 其内容越出视口属正常。 */
  const insideScroller = (el) => {
    for (let p = el; p && p !== document.body; p = p.parentElement) {
      const st = getComputedStyle(p);
      const scrollable = (v) => v === 'auto' || v === 'scroll';
      if (scrollable(st.overflowY) || scrollable(st.overflowX) || scrollable(st.overflow)) return true;
    }
    return false;
  };
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    // 落在滚动容器里的元素"超出视口"是正常滚动内容，不算布局事故
    if (insideScroller(el)) continue;
    if (r.right > vw + 1) issues.push(`[溢出] 右侧 ${Math.round(r.right - vw)}px — ${name(el)}`);
    if (r.bottom > vh + 1) issues.push(`[溢出] 底部 ${Math.round(r.bottom - vh)}px — ${name(el)}`);
    if (r.left < -1) issues.push(`[溢出] 左侧 ${Math.round(-r.left)}px — ${name(el)}`);
    // 疑似 flex 拉伸事故：按钮/输入框纵向异常高
    const tag = el.tagName.toLowerCase();
    if ((tag === 'button' || tag === 'input') && r.height > 60) {
      issues.push(`[拉伸] ${tag} 高 ${Math.round(r.height)}px（疑似 flex 纵向拉伸）— ${name(el)}`);
    }
    // 空的大色块（坏占位/坏图）
    if (r.width > 80 && r.height > 80 && !el.children.length && !el.textContent?.trim()) {
      const st = getComputedStyle(el);
      if (st.backgroundColor && st.backgroundColor !== 'rgba(0, 0, 0, 0)') {
        issues.push(`[空色块] ${Math.round(r.width)}x${Math.round(r.height)} bg=${st.backgroundColor} — ${name(el)}`);
      }
    }
  }
  // 水平滚动条出现即布局破了
  if (document.documentElement.scrollWidth > window.innerWidth + 1) {
    issues.push(`[横向滚动] scrollWidth=${document.documentElement.scrollWidth} > ${window.innerWidth}`);
  }
  return [...new Set(issues)].slice(0, 60);
});

// ---------- DOM 骨架（关键区域） ----------
report.dom = await page.evaluate(() => {
  const regions = ['.pg-sidebar', '.pg-rightbar', '.pg-statusbar', '.pg-titlebar', '.pg-composer'];
  const out = {};
  const walk = (el, depth) => {
    if (depth > 4) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
    const own = el.childNodes.length
      ? [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent.trim()).join('').slice(0, 32)
      : '';
    const label = `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} [${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}]${own ? ` "${own}"` : ''}`;
    const kids = [...el.children].map((c) => walk(c, depth + 1)).filter(Boolean);
    return kids.length ? `${label}\n${kids.map((k) => k.split('\n').map((l) => '  ' + l).join('\n')).join('\n')}` : label;
  };
  for (const sel of regions) {
    const el = document.querySelector(sel);
    out[sel] = el ? walk(el, 0) : '(未找到)';
  }
  return out;
});

await browser.close();

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));

const bar = (t) => `\n${'─'.repeat(4)} ${t} ${'─'.repeat(Math.max(0, 56 - t.length))}`;
console.log(bar(`截图（${browserName}）`) + `\n${out}`);
console.log(bar(`页面异常 pageerror（${report.pageErrors.length}）`));
console.log(report.pageErrors.length ? report.pageErrors.join('\n---\n') : '(none)');
console.log(bar(`console.error（${report.consoleErrors.length}）`));
console.log(report.consoleErrors.length ? report.consoleErrors.join('\n') : '(none)');
console.log(bar(`请求失败（${report.failedRequests.length}）`));
console.log(report.failedRequests.length ? [...new Set(report.failedRequests)].join('\n') : '(none)');
console.log(bar(`布局体检（${report.layoutIssues.length}）`));
console.log(report.layoutIssues.length ? report.layoutIssues.join('\n') : '(none)');
if (jsonOut) console.log(bar('报告') + `\n${jsonOut}`);

if (strict && (report.pageErrors.length || report.consoleErrors.length || report.layoutIssues.length)) {
  process.exitCode = 1;
}
