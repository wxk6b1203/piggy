import { beforeEach } from 'vitest';

/** jsdom 环境补齐（dockview / react-resizable-panels 依赖） */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;
if (typeof globalThis.matchMedia !== 'function') {
  (globalThis as Record<string, unknown>).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

/* ── 每个用例之间清掉 localStorage ────────────────────────────────────────────
   界面状态开始往 localStorage 里放了（跨重启的阅读位置，docs/04 §2.1.7），
   而 jsdom 的 localStorage 在**同一个测试文件内是共享的** —— 不清的话，
   上一个用例存下的"读到第 N 行"会被下一个用例当成自己的状态还回来
   （实测：`transcript-page.test.tsx` 里一条"打开即贴底"的断言读到 1300 而不是 1600，
   表现像滚动逻辑坏了，其实是上一用例的位置泄漏）。 */
/* ⚠️ 必须**从 vitest 显式 import**（本仓没开 `globals`）：写成 `typeof beforeEach === 'function'`
   的守卫会永远为假、静默不生效 —— 这里踩过一次。 */
beforeEach(() => {
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* 非 jsdom 环境（node）：没有这两样，跳过 */
  }
});
