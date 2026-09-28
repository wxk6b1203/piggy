/**
 * 全应用**共用同一个 `ResizeObserver`** 的尺寸订阅（2026-09-23）。
 *
 * ## 为什么要收成一个
 *
 * 转录区里曾经每个代码块各建 1~2 个观察者（一次会话几百个），梯子再建 1 个。
 * 观察者多不只是开销：每个观察者都是"回调 → setState → 布局变 → 再通知"这条链上
 * 独立的一环，浏览器判定"循环没收敛"（`ResizeObserver loop completed with
 * undelivered notifications`）的机会随之变多 —— 用户日志里那三条就是这个警告。
 * 收成一个之后，一次投递把所有回调跑完、React 合成一次渲染，链只有一圈。
 *
 * ## 纪律（写在这里，省得每个调用点各想一遍）
 *
 * 1. **回调里只准读布局 + setState**，不准直接写几何（写 `style` / `scrollTop`
 *    会把"投递 → 改布局 → 再投递"接回自己身上）。要写就在 `useLayoutEffect` 里写。
 * 2. **观察的对象不能由这次回调的输出决定大小**：`TurnRail` 量的是转录带
 *    （`.pg-transcript-wrap`，`position: relative` 的容器），**不是** `.pg-rail`
 *    自己（`.pg-rail` 的高度正是它算出来的 → 那就是自触发）。
 * 3. 不用了就退订：返回的函数会 `unobserve`，最后一个回调退掉时连元素一起放开。
 *
 * 环境没有 `ResizeObserver`（jsdom、老 WebKit）时退化成"什么都不观察"，
 * 调用点不需要自己判 —— 初次测量仍由各处的 `useLayoutEffect` 负责。
 */

/** 注册回调时的调用点（仅 DEV 记录，用于把循环警告点名到组件）。 */
type Watcher = { cb: () => void; site: string };

const byElement = new WeakMap<Element, Set<Watcher>>();
const instanceCount = { created: 0 };
let observer: ResizeObserver | null = null;
let observed = 0;
/** 最近一次真的被调用的回调注册点（DEV；`resizeProbe` 把它写进错误日志）。 */
let lastFired: string | null = null;

/** 取 3 层调用栈当"注册点"：跳掉 `site()` 自己和 `watchSize` 自己。 */
/** 取"注册点"：跳过本函数与 `watchSize` 两帧，路径压短、逐帧截断。 */
function site(): string {
  const stack = new Error().stack ?? '';
  const frames = stack
    .split('\n')
    .slice(2, 5)
    .map((l) => l.trim().replace(/^at\s+/, ''));
  if (frames.length === 0) return '(调用栈不可用)';
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  return [clip(shortenPath(frames[0] ?? ''), 110), frames[1] ? clip(shortenPath(frames[1]), 80) : '']
    .filter(Boolean)
    .join(' ← ');
}

/**
 * 把绝对路径压成"从工作区/依赖根开始"的样子（仅用于日志）。
 *
 * 真机上的调用栈是 `/Users/x/Documents/Project/piggy/apps/desktop/src/lib/…`，
 * 一行里塞三段就没人看得下去了；压短之后 `src/lib/resizeWatch.ts:70:10` 一眼能读，
 * 而 `node_modules/@tanstack/virtual-core/…` 也还能认出是谁。
 */
export function shortenPath(frame: string): string {
  return frame
    .replace(/[^\s()]*\/apps\/desktop\//g, '')
    .replace(/[^\s()]*\/node_modules\//g, 'node_modules/');
}

function ensure(): ResizeObserver | null {
  if (observer) return observer;
  if (typeof ResizeObserver === 'undefined') return null;
  instanceCount.created += 1;
  observer = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const set = byElement.get(entry.target);
      if (!set) continue;
      // 拷一份再跑：回调里退订是允许的（`Set` 边遍历边删会漏掉后面的回调）
      for (const w of [...set]) {
        if (import.meta.env.DEV) lastFired = w.site;
        w.cb();
      }
    }
  });
  return observer;
}

/**
 * 观察 `el` 的尺寸变化，回调 `cb`。
 *
 * @param el - 被观察元素（见文件头的纪律 2）
 * @param cb - 回调；只读布局 + setState
 * @returns 退订函数（幂等）
 */
export function watchSize(el: Element, cb: () => void): () => void {
  const ro = ensure();
  if (!ro) return () => {};
  let set = byElement.get(el);
  if (!set) {
    set = new Set();
    byElement.set(el, set);
    ro.observe(el);
    observed += 1;
  }
  const watcher: Watcher = { cb, site: import.meta.env.DEV ? site() : '' };
  set.add(watcher);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const cur = byElement.get(el);
    if (!cur) return;
    cur.delete(watcher);
    if (cur.size === 0) {
      byElement.delete(el);
      observed -= 1;
      observer?.unobserve(el);
    }
  };
}

/**
 * 当前观察规模：`instances` = 创建过的 `ResizeObserver` 实例数（**必须是 1**，
 * 0 表示环境不支持），`elements` = 正在观察的元素数。
 *
 * 给单测、门禁与错误日志用：`instances > 1` 就说明有人绕开这里自己 `new` 了。
 */
export function resizeWatchStats(): { instances: number; elements: number } {
  return { instances: instanceCount.created, elements: observed };
}

/** 最近一次被调用的回调来自哪个调用点（DEV；生产构建恒为 `null`）。 */
export function resizeWatchLastFired(): string | null {
  return import.meta.env.DEV ? lastFired : null;
}
