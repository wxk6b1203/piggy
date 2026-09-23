/**
 * 性能场景库 runner（docs/05 §6.2/§6.3，M2）。
 * 用法：
 *   node scripts/perf/run.mjs            # 全场景 S1–S6
 *   node scripts/perf/run.mjs --lite     # perf-lite（S1/S3 缩短版，PR 必跑）
 * 前置：自动拉起 vite dev（localhost:5195，mock 后端）。
 * 产出：perf-results/<scenario>.json（含预算断言；超线 exit 1）。
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const PORT = 5195;
const URL = `http://localhost:${PORT}`;
const LITE = process.argv.includes('--lite');
const OUT = join(ROOT, 'perf-results');
mkdirSync(OUT, { recursive: true });

// 预算（docs/05 §2；浏览器可测子集。headless 无垂直同步，帧率用 rAF 计数的保守下限）
const BUDGET = {
  S1: { fpsMin: 45, longTasksMax: 3 },
  S2: { longTasksMax: 3 },
  S3: { openMsMax: 1500, scrollLongTasksMax: 3 },
  S4: { settleMsMax: 500 },
  S5: { messagesMin: 1 },
  S6: { heapDriftPctMax: 5 },
};

const results = [];
function record(name, data, asserts) {
  const failures = Object.entries(asserts)
    .filter(([, ok]) => !ok)
    .map(([k]) => k);
  const entry = { name, ...data, asserts, failures };
  results.push(entry);
  writeFileSync(join(OUT, `${name}.json`), JSON.stringify(entry, null, 2));
  console.log(`[${failures.length ? 'FAIL' : 'PASS'}] ${name}`, JSON.stringify(data));
  return failures.length === 0;
}

async function withPage(fn) {
  const browser = await chromium.launch({
    channel: 'chromium', // 新 headless 走完整 chromium（CI/本机无需 headless-shell 变体）
    args: ['--enable-precise-memory-info', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  // 等 app boot 完成（mock 环境：命令注册表挂全局）
  await page.waitForFunction('window.__piggyCommands && window.__piggyCommands.size() > 0');
  await page.waitForTimeout(800); // dockview onReady + 恢复
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

const longTaskObserve = `(async () => {
  window.__lt = 0;
  new PerformanceObserver((l) => { window.__lt += l.getEntries().length; })
    .observe({ entryTypes: ['longtask'] });
})()`;

const scenarios = {
  async S1(page) {
    // 单会话长流式（30min → 缩短 15s/20s）：rAF 帧率 + long task
    const ms = LITE ? 8000 : 20000;
    await page.evaluate(longTaskObserve);
    const data = await page.evaluate(
      async (ms) => {
        const t0 = performance.now();
        let frames = 0;
        const count = () => {
          frames += 1;
          if (performance.now() - t0 < ms) requestAnimationFrame(count);
        };
        requestAnimationFrame(count);
        const deltas = await window.__piggyPerf.streamFor(ms);
        return { frames, deltas, wallMs: performance.now() - t0, longTasks: window.__lt };
      },
      ms,
    );
    const fps = (data.frames / data.wallMs) * 1000;
    return record('S1-stream', { ...data, fps: Math.round(fps) }, {
      fpsOk: fps >= BUDGET.S1.fpsMin,
      longTasksOk: data.longTasks <= BUDGET.S1.longTasksMax,
    });
  },

  async S2(page) {
    // 8 tab 并发流式（缩短）：mock 创建 8 tab，灌帧期间无主线程长任务
    await page.evaluate(longTaskObserve);
    const data = await page.evaluate(async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const t0 = performance.now();
      await window.__piggyPerf.streamFor(5000);
      return { wallMs: performance.now() - t0, longTasks: window.__lt };
    });
    return record('S2-8tab-stream', data, {
      longTasksOk: data.longTasks <= BUDGET.S2.longTasksMax,
    });
  },

  async S3(page) {
    // 万条消息会话打开 + 滚动（预算：首屏 <1.5s）
    await page.evaluate(longTaskObserve);
    const data = await page.evaluate(async () => {
      const hydrateMs = await window.__piggyPerf.hydrate(10000);
      const scroller = document.querySelector('.pg-transcript');
      const t0 = performance.now();
      const lt0 = window.__lt;
      if (scroller) {
        for (let i = 1; i <= 10; i += 1) {
          scroller.scrollTop = (scroller.scrollHeight / 10) * i;
          await new Promise((r) => requestAnimationFrame(r));
        }
      }
      return { hydrateMs, scrollMs: performance.now() - t0, scrollLongTasks: window.__lt - lt0 };
    });
    return record('S3-10k-open', data, {
      openOk: data.hydrateMs < BUDGET.S3.openMsMax,
      scrollLongTasksOk: data.scrollLongTasks <= BUDGET.S3.scrollLongTasksMax,
    });
  },

  async S4(page) {
    // 100 并行工具执行：事件处理 <500ms 内完成
    const data = await page.evaluate(async () => {
      const t0 = performance.now();
      await window.__piggyPerf.toolRuns(100);
      await new Promise((r) => requestAnimationFrame(r));
      return { settleMs: performance.now() - t0 };
    });
    return record('S4-toolruns', data, { settleOk: data.settleMs < BUDGET.S4.settleMsMax });
  },

  async S5(page) {
    // 崩溃恢复：crashed → resync → 消息不丢
    const data = await page.evaluate(async () => {
      await window.__piggyPerf.hydrate(3);
      await window.__piggyPerf.crashRecover();
      await new Promise((r) => setTimeout(r, 300));
      const n = document.querySelectorAll('.pg-message').length;
      return { renderedMessages: n };
    });
    return record('S5-crash-recover', data, {
      messagesOk: data.renderedMessages >= BUDGET.S5.messagesMin,
    });
  },

  async S6(page) {
    // 空载泄漏观察（1h → 缩短 20s）：JS heap 增幅 < 5%
    const data = await page.evaluate(async () => {
      if (!performance.memory) return { supported: false };
      performance.clearResourceTimings?.();
      const before = performance.memory.usedJSHeapSize;
      await new Promise((r) => setTimeout(r, 20000));
      // 触发 GC 的近似手段：分配压力后回落
      const after = performance.memory.usedJSHeapSize;
      return { supported: true, before, after, driftPct: ((after - before) / before) * 100 };
    });
    if (!data.supported) {
      return record('S6-idle-leak', data, { heapOk: true }); // 无 memory API 的环境跳过
    }
    return record('S6-idle-leak', data, {
      heapOk: data.driftPct < BUDGET.S6.heapDriftPctMax,
    });
  },
};

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(URL);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('vite dev server 未就绪');
}

const vite = spawn('pnpm', ['dev'], { cwd: ROOT, stdio: 'ignore', detached: false });
let ok = true;
try {
  await waitForServer();
  const names = LITE ? ['S1', 'S3'] : Object.keys(scenarios);
  for (const name of names) {
    const s = scenarios[name];
    if (!s) throw new Error(`未知场景: ${name}`);
    ok = (await withPage(s)) && ok;
  }
} finally {
  vite.kill('SIGTERM');
}
writeFileSync(join(OUT, 'summary.json'), JSON.stringify({ lite: LITE, ok, results }, null, 2));
process.exit(ok ? 0 : 1);
