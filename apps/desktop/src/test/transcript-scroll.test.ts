/**
 * 转录滚动策略单测（docs/04 §2.1）：把三条几何判断的边界钉死。
 *
 * 这些数字不是"跑出来看看"的：25px 是 DSH `useScrollFollow(…, 25)` 的容差，
 * 其余是"读者滚到哪算离开底部"的定义。
 */
import { describe, expect, it } from 'vitest';
import {
  FOLLOW_THRESHOLD_PX,
  distanceFromBottom,
  isAtTail,
  nextFollowing,
  nextFollowingFromSample,
  readerAnchorOf,
  readerTopFrom,
  scrollTopAfterPrepend,
} from '@/features/chat/transcriptScroll';

/** 1000 内容 / 400 视口：可滚 600。 */
const geo = (scrollTop: number, scrollHeight = 1000, clientHeight = 400) => ({
  scrollTop,
  scrollHeight,
  clientHeight,
});

describe('贴底判定', () => {
  it('容差就是 DSH 的 25px', () => {
    expect(FOLLOW_THRESHOLD_PX).toBe(25);
  });

  it('距底 = 可滚高度 - 当前偏移，且不为负', () => {
    expect(distanceFromBottom(geo(0))).toBe(600);
    expect(distanceFromBottom(geo(600))).toBe(0);
    expect(distanceFromBottom(geo(900))).toBe(0); // 越界（iOS 橡皮筋）也按 0
    expect(distanceFromBottom({ scrollTop: 0, scrollHeight: 100, clientHeight: 400 })).toBe(0);
  });

  it('25px 以内算贴底，25px 以外不算（边界含等于）', () => {
    expect(isAtTail(geo(575))).toBe(true); // 距底 25
    expect(isAtTail(geo(574))).toBe(false); // 距底 26
    expect(isAtTail(geo(600))).toBe(true);
  });
});

describe('跟随意图', () => {
  it('读者自己滚动才重新判定：滚到底恢复跟随，往上滚交还控制权', () => {
    expect(nextFollowing(true, geo(100), true)).toBe(false);
    expect(nextFollowing(false, geo(600), true)).toBe(true);
    expect(nextFollowing(false, geo(580), true)).toBe(true); // 差 20px 仍在容差内
    expect(nextFollowing(false, geo(570), true)).toBe(false); // 差 30px 就不跟了
  });

  it('程序化滚动（movedByReader=false）不改变跟随意图', () => {
    // 贴底时为了跟上新内容自己设 scrollTop：位置可能一时还没到底，但意图必须保住
    expect(nextFollowing(true, geo(0), false)).toBe(true);
    expect(nextFollowing(false, geo(600), false)).toBe(false);
  });
});

describe('加载更早不跳', () => {
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

describe('跟随意图（问"这段距离是谁造成的"）', () => {
  const base = { pinnedTop: 1600, lastScrollHeight: 2000, following: true };

  it('就在底部 → 跟随', () => {
    expect(nextFollowingFromSample({ ...base, metrics: geo(1600) })).toBe(true);
    expect(nextFollowingFromSample({ ...base, metrics: geo(1590) })).toBe(true); // 距底 10
  });

  it('内容长高把底推走 → 继续跟随（不是读者滚的）', () => {
    // 内容从 2000 长到 2400，位置还停在 1600（浏览器滚动锚定也可能这么干）
    expect(
      nextFollowingFromSample({ ...base, metrics: geo(1600, 2400), lastScrollHeight: 2000 }),
    ).toBe(true);
    // 门禁实测的那一幕：刚 loadTail 换完页就流式，位置没动、内容变高 → 不许停止跟随
    expect(
      nextFollowingFromSample({ ...base, metrics: geo(1600, 3400), lastScrollHeight: 2400 }),
    ).toBe(true);
    // 更狠的一种：内容长高的同时浏览器的**滚动锚定**把位置往上挪了（对不上我们钉的值）
    // —— 距离是"内容造成的"，仍然不许停止跟随（只看位置就会在这里丢掉跟随）
    expect(
      nextFollowingFromSample({ ...base, metrics: geo(1200, 3400), lastScrollHeight: 2000 }),
    ).toBe(true);
  });

  it('读者真的往上滚（位置变小、内容没长）→ 交还控制权', () => {
    expect(
      nextFollowingFromSample({ ...base, metrics: geo(900, 2000), lastScrollHeight: 2000 }),
    ).toBe(false);
  });

  it('没在跟随时，只有滚回底部才恢复', () => {
    expect(
      nextFollowingFromSample({
        ...base,
        following: false,
        metrics: geo(900, 2000),
        lastScrollHeight: 2000,
      }),
    ).toBe(false);
    expect(
      nextFollowingFromSample({
        ...base,
        following: false,
        metrics: geo(1600, 2000),
        lastScrollHeight: 2000,
      }),
    ).toBe(true);
  });

  it('位置没往上走（等于或大于钉住的位置）→ 不算离开底部', () => {
    expect(
      nextFollowingFromSample({ ...base, metrics: geo(1700, 2000), lastScrollHeight: 2000 }),
    ).toBe(true);
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
    { key: 'r0', start: 0, size: 100 },
    { key: 'r1', start: 100, size: 100 },
    { key: 'r2', start: 200, size: 100 },
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
