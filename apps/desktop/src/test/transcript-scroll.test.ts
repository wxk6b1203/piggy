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
