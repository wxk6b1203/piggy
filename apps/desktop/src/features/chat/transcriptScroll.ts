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

/**
 * 一次读者采样 → 跟随意图（比 {@link nextFollowing} 更硬的那条规则）。
 *
 * 为什么不能只看"位置是否等于我们钉的值"：**内容被整段换掉/长高时，浏览器会做
 * 滚动锚定**，把 `scrollTop` 挪到一个我们没设过的值；此时"离底很远"并不是读者滚的，
 * 但按"位置对不上就算读者"的规则会把跟随关掉（门禁实测：刚 `loadTail` 换完页就流式，
 * 视图停在离底 163px 处、当前刻度倒退一次）。
 *
 * 所以判据换成**问"这段距离是谁造成的"**：
 *   1. 就在底部 → 跟随；
 *   2. 内容比上次采样更高（长高/换页）→ 是内容把底推走的，继续跟随；
 *   3. 位置没往上走（`scrollTop >= 钉住的位置`）→ 不是"离开底部"；
 *   4. 以上都不是 → 读者真的往上滚了，交还控制权。
 *
 * @param sample - 本次几何 + 上次钉住的位置 + **贴底那一刻**的 scrollHeight + 当前意图
 * @param threshold - 容差
 * @returns 新的跟随意图
 */
export function nextFollowingFromSample(
  sample: {
    metrics: ScrollMetrics;
    pinnedTop: number | null;
    lastScrollHeight: number | null;
    following: boolean;
  },
  threshold: number = FOLLOW_THRESHOLD_PX,
): boolean {
  if (isAtTail(sample.metrics, threshold)) return true;
  if (!sample.following) return false;
  // 没有**可靠基线**（还没量到过高度：首帧、隐藏面板）时不要瞎归因：
  // 直接按几何判 —— 不在底部就是不跟随。反过来说，绝不能用一条 0 高度的基线
  // 把之后的真实采样都当成"内容长高"（那会让读者往上滚也不交还控制权）。
  const { pinnedTop, lastScrollHeight } = sample;
  if (pinnedTop === null || lastScrollHeight === null || lastScrollHeight <= 0) return false;
  if (sample.metrics.scrollHeight > lastScrollHeight + 1) return true; // 内容长高把底推走
  if (sample.metrics.scrollTop >= pinnedTop - 0.5) return true; // 没往上走
  return false; // 读者真的往上滚了
}
