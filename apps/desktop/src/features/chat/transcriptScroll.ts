/**
 * 转录滚动的**纯几何**（docs/04 §2.1.1）。
 *
 * 这里只留两类东西，都是"给个数字、还个数字"的纯函数：
 *
 *   · **跟随的容差口径**（DSH 的 25px）；
 *   · **读者锚点**：读者接管滚动之后"读到哪了"。口径照抄 DSH 的 `ChatScrollPosition`
 *     （行键 + 行顶到视口顶的距离），裸像素只作兜底。
 *
 * 为什么必须锚**行**而不是锚像素：dockview 把非活动面板的内容摘出 DOM，
 * 而浏览器不保留被摘出元素的滚动位置（实测 `removeChild` → `appendChild` 之后
 * `scrollTop` 从 300 掉到 0，只有 `display:none` 才是保留的）。隐藏期间上面的行还完全
 * 可能变高（工具结果到了、代码块展开了），像素会把读者带到别的行上去。
 *
 * 跟随本身的**状态机**不在这里，在 `scrollFollow.ts`（DSH `ScrollFollow` 的移植）；
 * "这段距离是谁造成的"那条归因在 `transcriptViewport.ts` 的 `readScroll`。
 * 早先这里有一个 `nextFollowingFromSample` 把归因摊开成四条规则 —— 它是四轮补丁的
 * 堆积（`pinnedTop` + `pinnedHeight` + 手势时间戳 + 上滚意图各修一个 bug），
 * 现在归因只有一条：**位置相对"上一次被认可的位置"变了没有**。
 */

/** 距底多少像素以内仍算"贴着底"（DSH 传 24，Piggy 取 25 —— 见 docs/04 §2.1.1）。 */
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

/**
 * 在**顶部预置**一页之后的 `scrollTop` 修正值。
 *
 * 顶部插入内容会把已有内容整体往下推 `nextScrollHeight - prevScrollHeight` 像素；
 * 把 `scrollTop` 加上同样的差值，读者眼前那一行就还在原地（这就是"翻页不跳"）。
 *
 * 只增不减（`Math.max(0, …)`）：内容被回收/行高被重测时不该把视图往上拽。
 *
 * ⚠️ 这是**兜底**口径（锚点行找不到时用）。首选是 `TranscriptViewport.preserve()`：
 * 按行锚点还位置，行高在隐藏期间变了也不会把读者带到别的行上。
 */
export function scrollTopAfterPrepend(
  before: Pick<ScrollMetrics, 'scrollTop' | 'scrollHeight'>,
  nextScrollHeight: number,
): number {
  const grew = Math.max(0, nextScrollHeight - before.scrollHeight);
  return before.scrollTop + grew;
}

/**
 * 读者接管之后"读到哪了"的锚点（DSH `ChatScrollPosition` 同构）。
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
  /** 行下标（虚拟化器的 `index`）。 */
  index: number;
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
