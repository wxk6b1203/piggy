/**
 * 贴底跟随的**控制器**（DSH `ui-chat/src/client/chat/use-scroll-follow.ts` 的移植）。
 *
 * ## 为什么是一个类，而不是一堆 `useRef`
 *
 * 这条策略的状态只有四个：`following`（跟不跟）、`threshold`（多近算贴着底）、
 * `target`（有没有一次自己发起的原生滚动还没落地）、`sampledTop`（上一次"确认过"的位置）。
 * 它每次滚动都要被读一次，但**绝大多数采样不该引起 React 渲染** —— 所以它不能住在
 * state 里；而它又有"上一次"这种跨采样的记忆，所以也不能是纯函数。
 *
 * 早期版本把这些拆成 `pinnedTopRef` / `pinnedHeightRef` / `readerGestureRef` /
 * `readerUpRef` 四个 ref 加一个纯函数 `nextFollowingFromSample`，散在组件里 ——
 * 每个 ref 都是为某一个具体 bug 打的补丁，合起来没人能说清"现在到底跟不跟"。
 * DSH 的口径收敛成一句话：**只有读者真的动了，才重新判定跟随意图**
 * （`sample()` 的 `movedByReader`），其余的滚动（程序化贴底、内容长高、浏览器滚动锚定）
 * 一律不改变意图。
 *
 * ## 与 DSH 逐条一致（没有自定义规则）
 *
 * 曾经在这里加过一条 DSH 没有的规则："滚轮往上就立刻交还控制权"。那是为一个用户反馈
 * 打的补丁，但 DSH 的采样本来就覆盖它 —— 位移一旦超出容差，`sample()` 就判"不跟"；
 * 而且**采样窗口内**内容长高也不会贴底（阅读层的 `onResize` 见到 pending 直接返回）。
 * 现在整条链路上没有自定义规则：归因看 `movedByReader`，意图看 `nearBottom`。
 */
import { useState } from 'react';

/** 滚动几何：只读三个数，绝不量行（DSH `scrollMetrics`）。 */
export interface ViewportMetrics {
  /** 当前 `scrollTop` */
  readonly top: number;
  /** 可滚到的最大值（`scrollHeight - clientHeight`，钳到 ≥0） */
  readonly floor: number;
  /** 视口高度 */
  readonly height: number;
}

/** 读一次滚动容器的几何。 */
export function scrollMetrics(element: HTMLElement): ViewportMetrics {
  const height = element.clientHeight;
  return { top: element.scrollTop, height, floor: Math.max(0, element.scrollHeight - height) };
}

/** 一次滚动采样：几何 + "这段距离是谁造成的"。 */
export interface ViewportScroll {
  readonly metrics: ViewportMetrics;
  /** 是不是读者自己滚的（程序化贴底、内容长高都不算） */
  readonly movedByReader: boolean;
}

export class ScrollFollow {
  private target: number | null = null;
  private sampledTop: number | undefined;

  /**
   * @param following - 初始意图（打开会话 = 跟随尾部）
   * @param threshold - 离底多少像素以内算"贴着底"
   */
  constructor(
    private following: boolean,
    private readonly threshold: number,
  ) {}

  /** 跟随意图（与当前偏移无关）。 */
  get active(): boolean {
    return this.following;
  }

  /** 有没有一次自己发起的原生滚动还没落地。 */
  get animating(): boolean {
    return this.target !== null;
  }

  /** 这个位置算不算贴着底。 */
  nearBottom(metrics: ViewportMetrics): boolean {
    return metrics.floor - metrics.top <= this.threshold;
  }

  /** 外部（导航 / 阅读层）决定意图，**不动位置**。 */
  setFollowing(active: boolean): void {
    this.following = active;
    if (!active) this.target = null;
  }

  /** 把下一次可见布局当成全新的读者位置（换会话 / 换窗）。 */
  reset(): void {
    this.setFollowing(false);
    this.sampledTop = undefined;
  }

  /**
   * 采纳一次滚动。
   *
   * @param metrics - 当前几何
   * @param movedByReader - 调用方的归因；省略时按"位置和上次采样不同"判
   * @returns 更新后的跟随意图
   */
  sample(metrics: ViewportMetrics, movedByReader = this.sampledTop === undefined || Math.abs(metrics.top - this.sampledTop) > 0.5): boolean {
    this.sampledTop = metrics.top;
    if (!this.animating && movedByReader) this.following = this.nearBottom(metrics);
    return this.active;
  }

  /**
   * 原生滚动停下来了（`scrollend`）：没停在自己瞄的那个位置就交还控制权。
   *
   * 这一条管的是"滚到一半被用户打断 / 内容缩水把目标顶掉"两种收尾。
   */
  settle(metrics: ViewportMetrics): boolean {
    const target = this.target;
    this.target = null;
    return this.sample(
      metrics,
      target === null ? undefined : Math.abs(metrics.top - Math.min(target, metrics.floor)) > this.threshold,
    );
  }

  /**
   * 立刻落到某个位置，并采纳落点算出来的意图。
   *
   * `sampledTop` 跟着落点走：这次移动是**我们**做的，不能被算成读者滚的
   * （否则"贴底"这个动作自己就会把跟随关掉）。
   */
  jump(element: HTMLElement, metrics: ViewportMetrics, top: number): ViewportMetrics {
    const animated = this.animating;
    this.target = null;
    const target = Math.max(0, Math.min(metrics.floor, top));
    if (animated) element.scrollTo({ top: target, behavior: 'instant' });
    else if (target !== metrics.top) element.scrollTop = target;
    const landed = { ...metrics, top: element.scrollTop };
    this.sampledTop = landed.top;
    this.following = this.nearBottom(landed);
    return landed;
  }

  /**
   * 贴到底（内容长高 / 点「回到底部」都走它）。
   *
   * 已经在底部附近、又没有未落地的动画时走**立即**写：
   * DSH 那条 `metrics.top >= metrics.floor || nearBottom` 的短路是为了避免
   * "离底 1px 却发起一次平滑滚动，然后每一帧都瞄着新底" —— 流式时底每 16ms 就变一次。
   */
  toBottom(element: HTMLElement, metrics: ViewportMetrics, behavior: 'instant' | 'smooth'): ViewportMetrics {
    this.following = true;
    if (
      behavior === 'instant' ||
      metrics.top >= metrics.floor ||
      (!this.animating && this.nearBottom(metrics))
    ) {
      return this.jump(element, metrics, metrics.floor);
    }
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return this.jump(element, metrics, metrics.floor);
    }
    if (this.target === null) {
      this.target = metrics.floor;
      element.scrollTo({ top: metrics.floor, behavior: 'smooth' });
    }
    return metrics;
  }

  /**
   * 读者手势打断了我们自己的平滑滚动：把它取消掉，并把**当前**位置写成新基准。
   *
   * 少了这一步，取消动画本身产生的那次滚动会被当成"读者滚的"，跟随意图当场判错。
   */
  interrupt(element: HTMLElement, metrics: ViewportMetrics): void {
    if (!this.animating) return;
    this.target = null;
    this.sampledTop = metrics.top;
    element.scrollTo({ top: metrics.top, behavior: 'instant' });
  }
}

/**
 * 一个滚动容器的跟随控制器（在组件生命周期里稳定）。
 *
 * @param initial - 初始意图
 * @param threshold - 容差（Piggy 用 25px，见 `transcriptScroll.FOLLOW_THRESHOLD_PX`）
 */
export function useScrollFollow(initial: boolean, threshold: number): ScrollFollow {
  const [follow] = useState(() => new ScrollFollow(initial, threshold));
  return follow;
}
