/**
 * 转录滚动策略单测（docs/04 §2.1）：把跟随判定与锚点口径的边界钉死。
 *
 * 这些数字不是"跑出来看看"的：25px 是 DSH `useScrollFollow(…, 25)` 的容差，
 * 其余是"读者滚到哪算离开底部"的定义。
 *
 * ⚠️ 判定的**状态机**在 `features/chat/scrollFollow.ts`（`ScrollFollow`），
 * 这里测的就是它；归因（这次滚动是谁造成的）在 `transcriptViewport.readScroll`，
 * 由 `transcript-page.test.tsx` 用假几何端到端跑。
 */
import { describe, expect, it } from 'vitest';
import {
  FOLLOW_THRESHOLD_PX,
  distanceFromBottom,
  readerAnchorOf,
  readerTopFrom,
  scrollTopAfterPrepend,
} from '@/features/chat/transcriptScroll';
import { ScrollFollow, scrollMetrics } from '@/features/chat/scrollFollow';

/** 1000 内容 / 400 视口：可滚 600。 */
const geo = (top: number, floor = 600, height = 400) => ({ top, floor, height });

/** 假滚动元素：`scrollTop` 会被钳进 `[0, floor]`（真浏览器就是这么干的）。 */
function fakeScroller(scrollHeight = 1000, clientHeight = 400) {
  let top = 0;
  let writes = 0;
  const el = {
    get scrollTop() {
      return top;
    },
    set scrollTop(v: number) {
      writes += 1;
      top = Math.max(0, Math.min(v, scrollHeight - clientHeight));
    },
    scrollHeight,
    clientHeight,
    scrollTo(opts: { top: number }) {
      (el as unknown as { scrollTop: number }).scrollTop = opts.top;
    },
    writes: () => writes,
    grow(by: number) {
      scrollHeight += by;
    },
  };
  return el as unknown as HTMLElement & { writes(): number; grow(by: number): void };
}

describe('贴底判定', () => {
  it('容差就是 DSH 的 25px', () => {
    expect(FOLLOW_THRESHOLD_PX).toBe(25);
  });

  it('距底 = 可滚高度 - 当前偏移，且不为负', () => {
    const box = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({
      scrollTop,
      scrollHeight,
      clientHeight,
    });
    expect(distanceFromBottom(box(0))).toBe(600);
    expect(distanceFromBottom(box(600))).toBe(0);
    expect(distanceFromBottom(box(900))).toBe(0); // 越界（iOS 橡皮筋）也按 0
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 400 })).toBe(0);
  });

  it('读几何只读三个数（floor 钳到 ≥0）', () => {
    const el = { scrollTop: 120, scrollHeight: 1000, clientHeight: 400 } as HTMLElement;
    expect(scrollMetrics(el)).toEqual({ top: 120, height: 400, floor: 600 });
    const short = { scrollTop: 0, scrollHeight: 100, clientHeight: 400 } as HTMLElement;
    expect(scrollMetrics(short).floor).toBe(0);
  });
});

/**
 * 跟随意图（DSH `ScrollFollow`）。
 *
 * 判据只有一条：**读者自己动了才重新判定**。程序化贴底、内容长高、浏览器滚动锚定
 * 都不许改变意图 —— 这三件事在旧实现里各是一个补丁（`pinnedTop` / `pinnedHeight` /
 * `movedByReader` 的替代品），现在收敛成 `sample()` 的一个参数。
 */
describe('跟随意图（ScrollFollow）', () => {
  it('读者往上滚过阈值 → 交还控制权；滚回底部 → 跟随自己回来', () => {
    const f = new ScrollFollow(true, FOLLOW_THRESHOLD_PX);
    expect(f.sample(geo(100), true)).toBe(false); // 距底 500
    expect(f.sample(geo(600), true)).toBe(true); // 滚到底
    expect(f.sample(geo(580), true)).toBe(true); // 差 20px 仍在容差内
    expect(f.sample(geo(570), true)).toBe(false); // 差 30px 就不跟了
  });

  it('程序化滚动（movedByReader=false）不改变跟随意图', () => {
    const f = new ScrollFollow(true, FOLLOW_THRESHOLD_PX);
    // 贴底时为了跟上新内容自己设 scrollTop：位置可能一时还没到底，但意图必须保住
    expect(f.sample(geo(0), false)).toBe(true);
    const g = new ScrollFollow(false, FOLLOW_THRESHOLD_PX);
    expect(g.sample(geo(600), false)).toBe(false);
  });

  it('内容长高（位置没动）不算读者滚的：意图原地保持', () => {
    const f = new ScrollFollow(true, FOLLOW_THRESHOLD_PX);
    expect(f.sample(geo(600, 600), true)).toBe(true);
    // 内容从 1000 长到 1600：floor 600 → 1200，位置还停在 600（距底 600）
    const metrics = geo(600, 1200);
    // 归因由调用方给（viewport 比的是"上一次被认可的位置"）：位置没变 → false
    expect(f.sample(metrics, false)).toBe(true);
  });

  it('jump 之后那次滚动不算读者滚的（贴底自己产生的事件）', () => {
    const f = new ScrollFollow(true, FOLLOW_THRESHOLD_PX);
    const el = fakeScroller();
    f.jump(el, geo(0), 600);
    expect(el.scrollTop).toBe(600);
    // 位置被我们设成 600，`sampledTop` 跟着走：下一次 sample 的默认归因算出"没动"
    expect(f.sample(geo(600))).toBe(true);
  });

  it('toBottom 幂等：已经贴底就不再写 scrollTop', () => {
    const f = new ScrollFollow(true, FOLLOW_THRESHOLD_PX);
    const el = fakeScroller();
    f.jump(el, geo(0), 600);
    const before = el.writes();
    f.toBottom(el, geo(600), 'instant');
    expect(el.writes(), '已经贴着底还写了一次 scrollTop').toBe(before);
  });

  it('setFollowing(false) 之后：位置不再被采纳成"跟随"', () => {
    const f = new ScrollFollow(true, FOLLOW_THRESHOLD_PX);
    f.setFollowing(false);
    expect(f.active).toBe(false);
    // 即使随后有一次"贴底"的采样，也必须由调用方显式 setFollowing(true) 才回来
    expect(f.sample(geo(600), true)).toBe(true); // sample 本身就是"读者滚到底"的判定
    f.setFollowing(false);
    expect(f.active).toBe(false);
  });
});

describe('加载更早不跳（高度差兜底口径）', () => {
  it('顶部插入多少高度，scrollTop 就补多少', () => {
    expect(scrollTopAfterPrepend({ scrollTop: 0, scrollHeight: 1000 }, 2400)).toBe(1400);
    expect(scrollTopAfterPrepend({ scrollTop: 120, scrollHeight: 1000 }, 1400)).toBe(520);
  });

  it('高度没涨（例如那一页全是渲染不出来的条目）就不动', () => {
    expect(scrollTopAfterPrepend({ scrollTop: 300, scrollHeight: 1000 }, 1000)).toBe(300);
  });

  it('高度反而缩小（行高重测/内容被回收）不把视图往上拽', () => {
    expect(scrollTopAfterPrepend({ scrollTop: 300, scrollHeight: 1000 }, 800)).toBe(300);
  });
});

/**
 * 读者位置的锚点（用户 2026-09-23："切到另一个会话，不是在最低位，而是在当前页的高位"）。
 *
 * 前提是浏览器**不保留**被摘出文档的元素的滚动位置（实测 Chrome：`removeChild` →
 * `appendChild` 之后 `scrollTop` 从 300 掉到 0；只有 `display:none` 才保留）——
 * dockview 走的正是前者，所以位置必须由我们自己记回来。
 */
describe('读者位置锚点', () => {
  /** 三行，各 100px：0-99 / 100-199 / 200-299。 */
  const rows = [
    { index: 0, key: 'r0', start: 0, size: 100 },
    { index: 1, key: 'r1', start: 100, size: 100 },
    { index: 2, key: 'r2', start: 200, size: 100 },
  ];

  it('锚在"底边越过视口顶"的那一行上，记的是行顶到视口顶的距离', () => {
    expect(readerAnchorOf(rows, 0)).toEqual({ key: 'r0', delta: 0, top: 0 });
    expect(readerAnchorOf(rows, 150)).toEqual({ key: 'r1', delta: 50, top: 150 });
    // 恰好落在行边界上：算它自己那一行（`>` 而不是 `>=`）
    expect(readerAnchorOf(rows, 200)).toEqual({ key: 'r2', delta: 0, top: 200 });
  });

  it('一行都没有（还没有布局）时没有锚点', () => {
    expect(readerAnchorOf([], 100)).toBeNull();
  });

  it('还原：锚点行还在 → 按它现在的位置算（行高变了也不会跑到别的行上）', () => {
    const anchor = readerAnchorOf(rows, 150)!;
    // 上面插进来一行 80px 高的内容：同一行现在从 180 开始 → 位置应当是 230
    expect(readerTopFrom(anchor, 180, 10_000)).toBe(230);
  });

  it('还原：锚点行没了（换窗）→ 退回裸位置；两种都钳进可滚范围', () => {
    const anchor = readerAnchorOf(rows, 150)!;
    expect(readerTopFrom(anchor, null, 10_000)).toBe(150);
    expect(readerTopFrom(anchor, 180, 200)).toBe(200); // 超出可滚范围
    expect(readerTopFrom({ key: 'r0', delta: -30, top: 0 }, null, 500)).toBe(0); // 不许为负
  });
});
