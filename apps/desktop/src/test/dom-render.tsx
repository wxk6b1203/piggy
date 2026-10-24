/**
 * jsdom 下挂载/卸载 React 组件的共用工具。
 *
 * 为什么要有这个文件（而不是每个测试各写一遍 mount/unmount）：
 * React 19 的 scheduler 在 Node/jsdom 下走 **`setImmediate`** 排队
 * （栈里是 `Immediate.performWorkUntilDeadline` ← `scheduler.development.js`），
 * 而 `setImmediate` 是 **Node 的**，不属于 jsdom —— 环境拆除时不会被取消。
 * 于是同步 `unmount()` 之后若还有回调排队，它就会在 `window` 已经消失之后执行：
 *
 *   ReferenceError: window is not defined
 *    ❯ react-dom-client.development.js:19555
 *    ❯ Immediate.performWorkUntilDeadline
 *
 * Vitest 把它记成 **unhandled error**，于是**整套 suite 非零退出**，
 * 即使 89 条用例全绿。实测 8 次里中 2 次（约 25%）——这种"偶发红"最坏的地方
 * 是让人不再相信测试结果：分不清是真回归还是又抖了一次。
 *
 * 解法分两层：① 在 jsdom **还活着**的时候把队列跑空（`drainReact`）；
 * ② `setup.ts` 给 `setImmediate` 套一层 guard，环境拆掉后的残余回调直接丢弃
 * （那时 `window` 已经没了，回调本身也不可能再验证任何东西）。
 *
 * ⚠️ 2026-09-23 复测（做预览高亮时又撞上）：只靠 `drainReact` 加 `setImmediate`
 * （scheduler 排的是 Node 的 check 队列，跟 `setTimeout` 不是同一条）并加到 3 轮，
 * 反而 **4/8 中** —— 单靠"多让几轮"不够。2026-10-24 在 `setup.ts` 加拆环境后的
 * guard，并保留 `drainReact` 的即时清空；全量 `pnpm test` 连跑 5 轮 exit 0。
 * 结论：这条 flake 的**残余窗口**已被 guard 封住，但测试里仍不要留未 await 的异步更新。
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/**
 * 把 React 排在宏任务里的收尾工作跑空。
 * 必须在 jsdom 拆除**之前**调用；跑两轮是因为 work loop 会续排新的回调。
 */
export async function drainReact(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  /* React 19 的 scheduler 在 Node/jsdom 下走 **setImmediate**（check 队列），
     不是 setTimeout（timers 队列）；上面两轮 setTimeout 看不到它。环境拆除后
     它才执行，就是那条 `window is not defined` 的已知 flake。再让出一轮 check 队列，
     趁 jsdom 还在把排队的 render 跑掉。 */
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 挂载到 `document.body` 下的新容器，返回该容器。 */
export function mountDom(node: React.ReactNode): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
  return container;
}

/** 当前挂载容器（未挂载时抛错，避免断言悄悄打在 null 上）。 */
export function domContainer(): HTMLDivElement {
  if (!container) throw new Error('dom-render: 请先调用 mountDom()');
  return container;
}

/**
 * 用新的 props 重渲染同一个根（"流式又长了一帧"这类场景就靠它）。
 *
 * 与 `mountDom` 的区别是**根不变**：`useRef` / `useState` 都活着 ——
 * 这正是流式增量渲染要测的东西（冻结块的元素身份必须跨帧保持）。
 */
export function rerender(node: React.ReactNode): void {
  if (!root) throw new Error('dom-render: 请先调用 mountDom()');
  act(() => {
    root!.render(node);
  });
}

/** 卸载 + 跑空 React 队列 + 摘掉容器。测试的 afterEach 里 `await` 它。 */
export async function unmountDom(): Promise<void> {
  await act(async () => {
    root?.unmount();
  });
  await drainReact();
  container?.remove();
  root = null;
  container = null;
}
