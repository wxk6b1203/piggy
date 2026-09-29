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

/**
 * 读者接管之后"读到哪了"的锚点。
 *
 * 口径照抄 DSH 的 `ChatScrollPosition`（`use-chat-viewport.ts` 的 `capturePosition`）：
 * **锚在行上**（行键 + 行顶到视口顶的距离），裸像素只作兜底。
 *
 * ## 为什么非锚行不可
 *
 * dockview 把非活动面板的内容**摘出 DOM**，而浏览器不保留被摘出元素的滚动位置
 * —— 实测（Chrome，`removeChild` → `appendChild`）：`scrollTop` 从 300 掉到 **0**；
 * 换成 `display:none` 才是保留的（dockview 的注释只对后者成立）。
 * 于是"切到别的标签再切回来"这件事本身就会把读者的位置清零，用户看到的是
 * "回到那一页的高位"。
 *
 * 位置必须由我们自己记回来。记**行**而不是记像素，是因为隐藏期间上面的行完全可能
 * 变高（工具结果到了、代码块展开了）：像素会把读者带到别的行上去。
 */
export interface ReaderAnchor {
  /** 视口顶端那一行的键（虚拟化器的 `getItemKey`）。 */
  key: string;
  /** 那一行的顶部到视口顶部的像素距离（= `scrollTop - 行起始`）。 */
  delta: number;
  /** 裸位置兜底：锚点行已经不在了（换窗把窗口换掉）时用它。 */
  top: number;
}

/** 锚点计算要用到的那几个字段（虚拟化器的 `VirtualItem` 是它的超集：`key` 还可能是 bigint）。 */
export interface AnchorRow {
  key: unknown;
  start: number;
  size: number;
}

/**
 * 从"当前渲染出来的行 + 位置"取出锚点。
 *
 * @param items - 虚拟化器当前渲染的行（有序）
 * @param scrollTop - 当前位置
 * @returns 锚点；一行都没有（还没有布局）时 `null`
 */
export function readerAnchorOf(items: readonly AnchorRow[], scrollTop: number): ReaderAnchor | null {
  // 顶端那一行 = 第一个**底边越过视口顶**的行；都在视口下方时退回第一行
  const first = items.find((vi) => vi.start + vi.size > scrollTop) ?? items[0];
  if (!first) return null;
  return { key: String(first.key), delta: scrollTop - first.start, top: scrollTop };
}

/**
 * 锚点 → 应该设置的 `scrollTop`。
 *
 * @param anchor - {@link readerAnchorOf} 存下来的锚点
 * @param resolvedStart - 锚点行现在的起始像素（找不到那一行时传 `null`）
 * @param maxTop - 可滚范围（`scrollHeight - clientHeight`）
 * @returns 钳进 `[0, maxTop]` 的位置
 */
export function readerTopFrom(
  anchor: ReaderAnchor,
  resolvedStart: number | null,
  maxTop: number,
): number {
  const raw = resolvedStart === null ? anchor.top : resolvedStart + anchor.delta;
  return Math.max(0, Math.min(raw, Math.max(0, maxTop)));
}
