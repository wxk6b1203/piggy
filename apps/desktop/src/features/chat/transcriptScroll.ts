/**
 * 转录滚动策略（纯函数，docs/04 §2.1）。
 *
 * ## 为什么要单独抽出来
 *
 * "打开会话停在结尾"、"往上读时不被打断"、"加载更早之后阅读位置不许跳"这三条
 * 都是**几何判断**，而 jsdom 里 `clientHeight` / `scrollHeight` 恒为 0 —— 组件测试
 * 造不出真实布局。所以判断逻辑留在这里（可单测、可穷举边界），
 * 真几何交给浏览器门禁（`scripts/ui-startup-check.mjs`）量。
 *
 * ## 口径照抄 DSH
 *
 * DSH 的 `ScrollFollow`（`useScrollFollow(state.followingTail, 25)`）：
 *   · 距底 25px 以内算"贴着底"（`nearBottom`）；
 *   · **只有读者自己滚动过**才重新判定跟随意图（`sample(metrics, movedByReader)`），
 *     程序化滚动（我们为了贴底自己设的 `scrollTop`）不许把跟随关掉；
 *   · 会话首次打开没有"上次读到哪"的记忆时直接贴底（`saved === null → followTail()`）。
 */

/** 距底多少像素以内仍算"贴着底"（DSH 传的是 25）。 */
export const FOLLOW_THRESHOLD_PX = 25;

/** 滚动几何（够算距离即可）。 */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 距底部还有多少像素；已经贴底/越界时按 0 计（浏览器里不会出现负数）。 */
export function distanceFromBottom(m: ScrollMetrics): number {
  return Math.max(0, m.scrollHeight - m.clientHeight - m.scrollTop);
}

/** 是否贴着底（含 {@link FOLLOW_THRESHOLD_PX} 容差）。 */
export function isAtTail(m: ScrollMetrics, threshold: number = FOLLOW_THRESHOLD_PX): boolean {
  return distanceFromBottom(m) <= threshold;
}

/**
 * 新内容到达后的跟随决策（DSH `ScrollFollow.sample` 同义）。
 *
 * @param previous - 上一次的跟随意图
 * @param m - 当前几何
 * @param movedByReader - 这次滚动是不是读者自己滚的（程序化贴底传 false）
 * @param threshold - 容差
 * @returns 新的跟随意图
 */
export function nextFollowing(
  previous: boolean,
  m: ScrollMetrics,
  movedByReader: boolean,
  threshold: number = FOLLOW_THRESHOLD_PX,
): boolean {
  if (!movedByReader) return previous;
  return isAtTail(m, threshold);
}

/**
 * 在**顶部预置**一页之后的 `scrollTop` 修正值。
 *
 * 顶部插入内容会把已有内容整体往下推 `nextScrollHeight - prevScrollHeight` 像素；
 * 把 `scrollTop` 加上同样的差值，读者眼前那一行就还在原地（这就是"翻页不跳"）。
 *
 * 只增不减（`Math.max(0, …)`）：内容被回收/行高被重测时不该把视图往上拽。
 *
 * @param before - 预置前的几何
 * @param nextScrollHeight - 预置后的 scrollHeight
 * @returns 应该设置的 scrollTop
 */
export function scrollTopAfterPrepend(
  before: Pick<ScrollMetrics, 'scrollTop' | 'scrollHeight'>,
  nextScrollHeight: number,
): number {
  const grew = Math.max(0, nextScrollHeight - before.scrollHeight);
  return before.scrollTop + grew;
}
