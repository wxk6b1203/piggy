/** 三轨时间线（docs/12 §4.7）：轨道归属与 span 布局的纯函数测试 */
import { describe, expect, it } from 'vitest';
import { buildSpans, laneFor } from '@/features/chat/TrajectoryTimeline';
import type { TrajKind, TrajRow } from '@/stores/trajectory';

const row = (kind: TrajKind, ts?: number, text = ''): TrajRow => ({
  id: `${kind}-${ts ?? 'x'}`,
  kind,
  text,
  ts,
});

describe('laneFor（DSH `laneFor` 逐条对齐）', () => {
  it('工具 → lane 2', () => {
    expect(laneFor('tool')).toBe(2);
  });

  it('助手与压缩 → lane 1', () => {
    expect(laneFor('assistant')).toBe(1);
    expect(laneFor('compaction')).toBe(1);
  });

  it('系统 / 用户 / 上下文 → lane 0', () => {
    expect(laneFor('system')).toBe(0);
    expect(laneFor('user')).toBe(0);
    expect(laneFor('context_edit')).toBe(0);
  });

  it('标记与其他（Piggy 扩展）归 lane 0，不会落空', () => {
    expect(laneFor('label')).toBe(0);
    expect(laneFor('other')).toBe(0);
  });
});

describe('buildSpans', () => {
  it('空输入返回空', () => {
    expect(buildSpans([]).spans).toEqual([]);
  });

  it('无时间戳 → sequence 等宽槽，且标记为未计时', () => {
    const rows = [row('user'), row('assistant'), row('tool'), row('tool')];
    const { spans, timed } = buildSpans(rows);
    expect(timed).toBe(false);
    expect(spans).toHaveLength(4);
    // 每槽 25%，首尾相接
    expect(spans[0]!.left).toBeCloseTo(0);
    expect(spans[0]!.width).toBeCloseTo(0.25);
    expect(spans[3]!.left).toBeCloseTo(0.75);
    for (const s of spans) expect(s.startMs).toBeNull();
  });

  it('有时间戳 → 按时间差布宽，最左为 0、最长为 1', () => {
    const rows = [row('user', 1000), row('assistant', 1000), row('tool', 3000), row('tool', 4000)];
    const { spans, timed } = buildSpans(rows);
    expect(timed).toBe(true);
    // 域 = 1000..4000 → 3000ms
    expect(spans[0]!.left).toBeCloseTo(0);
    expect(spans[1]!.left).toBeCloseTo(0); // 同一时刻
    expect(spans[2]!.left).toBeCloseTo(2000 / 3000);
    expect(spans[3]!.left).toBeCloseTo(1);
    expect(spans[3]!.endMs! - spans[3]!.startMs!).toBe(0);
  });

  it('零宽 span 有保底宽度，不会消失', () => {
    const rows = [row('user', 1000), row('tool', 1000)];
    const { spans } = buildSpans(rows);
    for (const s of spans) expect(s.width).toBeGreaterThan(0);
  });

  it('全部同一时刻不产生 NaN（域宽兜底）', () => {
    const rows = [row('user', 5000), row('tool', 5000)];
    const { spans } = buildSpans(rows);
    for (const s of spans) {
      expect(Number.isFinite(s.left)).toBe(true);
      expect(Number.isFinite(s.width)).toBe(true);
    }
  });

  it('lane 归属进入 span；user 行标记为轮次起点', () => {
    const rows = [row('user', 0), row('assistant', 10), row('tool', 20)];
    const { spans } = buildSpans(rows);
    expect(spans.map((s) => s.lane)).toEqual([0, 1, 2]);
    expect(spans.map((s) => s.turnStart)).toEqual([true, false, false]);
  });

  it('span 的 left + width 不越出右边界', () => {
    const rows = [row('user', 0), row('tool', 100), row('tool', 200)];
    const { spans } = buildSpans(rows);
    for (const s of spans) {
      expect(s.left + s.width).toBeLessThanOrEqual(1 + 1e-9);
      expect(s.left).toBeGreaterThanOrEqual(0);
    }
  });
});
