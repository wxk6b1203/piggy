// @vitest-environment node
/**
 * Monaco 实例池的**策略**（`monaco-pool.ts`）。
 *
 * 这一层是纯函数式的（没有 Monaco、没有 React），所以策略本身可以在 node 里逐条验证 ——
 * 真实行为（可见才创建、切回来重建、界面上不再有"已达上限"）由 `ui:startup` 第 10 段
 * 在真浏览器里量（jsdom 里没有 Monaco 的布局与 worker，断言只能是假的）。
 *
 * 起因（用户）："monaco editor 很吃资源吗？能放开限制 editor 个数吗？"
 * 实测：首个实例 ~9MB（含核心），之后每个 ~0.5–1.5MB / ~70ms —— 所以这里的目标不是
 * "省内存"而是**别让标签数量撞墙**，同时给内存一个上限。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  MAX_LIVE_EDITORS,
  acquireEditor,
  liveEditors,
  liveEditorIds,
  releaseEditor,
  resetPoolForTest,
  setEditorVisible,
} from '@/features/common/monaco-pool';

beforeEach(() => resetPoolForTest());

describe('Monaco 实例池', () => {
  it('未超水位时谁都不回收', () => {
    const evicted: string[] = [];
    for (let i = 0; i < MAX_LIVE_EDITORS; i += 1) {
      acquireEditor(`e${i}`, () => evicted.push(`e${i}`));
      setEditorVisible(`e${i}`, false); // 都藏起来（最坏情况）
    }
    expect(liveEditors()).toBe(MAX_LIVE_EDITORS);
    expect(evicted).toEqual([]);
  });

  it('超水位时回收**最久没显示过**的隐藏实例，而不是拒绝新实例', () => {
    const evicted: string[] = [];
    for (let i = 0; i < MAX_LIVE_EDITORS; i += 1) {
      acquireEditor(`e${i}`, () => evicted.push(`e${i}`));
      setEditorVisible(`e${i}`, false);
    }
    // e0 又显示了一次 → 它变成"最近用过"，被回收的应该是 e1
    setEditorVisible('e0', true);
    setEditorVisible('e0', false);
    acquireEditor('new', () => evicted.push('new'));
    expect(evicted).toEqual(['e1']);
    expect(liveEditors()).toBe(MAX_LIVE_EDITORS);
    expect(liveEditorIds()).toContain('new');
    expect(liveEditorIds()).not.toContain('e1');
  });

  it('正在显示（可见）的实例永远不被回收', () => {
    const evicted: string[] = [];
    for (let i = 0; i < MAX_LIVE_EDITORS; i += 1) {
      acquireEditor(`e${i}`, () => evicted.push(`e${i}`)); // 全部保持可见
    }
    acquireEditor('new', () => evicted.push('new'));
    // 没有可回收的 → 允许超出水位（宁可多占几 MB，也不给点了没反应的界面）
    expect(evicted).toEqual([]);
    expect(liveEditors()).toBe(MAX_LIVE_EDITORS + 1);
  });

  it('被回收的实例不会在回调里被重复回收', () => {
    const evicted: string[] = [];
    for (let i = 0; i < MAX_LIVE_EDITORS; i += 1) {
      acquireEditor(`e${i}`, () => evicted.push(`e${i}`));
      setEditorVisible(`e${i}`, false);
    }
    acquireEditor('a', () => evicted.push('a'));
    acquireEditor('b', () => evicted.push('b'));
    expect(evicted).toEqual(['e0', 'e1']);
    expect(new Set(evicted).size).toBe(evicted.length);
  });

  it('卸载（releaseEditor）立刻减员，后续申请不再回收别人', () => {
    const evicted: string[] = [];
    for (let i = 0; i < MAX_LIVE_EDITORS; i += 1) {
      acquireEditor(`e${i}`, () => evicted.push(`e${i}`));
      setEditorVisible(`e${i}`, false);
    }
    releaseEditor('e0');
    acquireEditor('new', () => evicted.push('new'));
    // e0 已摘牌 → 水位内，不该回收任何东西
    expect(evicted).toEqual([]);
    expect(liveEditors()).toBe(MAX_LIVE_EDITORS);
  });

  it('水位是个正数常量（0 会让每个预览都重建，等于没有保留策略）', () => {
    expect(MAX_LIVE_EDITORS).toBeGreaterThanOrEqual(2);
  });
});
