/**
 * 数字口径单测（docs/04 §3.9）：**3 位小数**与命中率的诚实规则。
 *
 * 这里的期望值不是"跑一遍看看等于几"填进去的，而是按展示语义写死的：
 * 前两组用真机数字（15400 / 1M 窗口 / 输入 12000 + 缓存读 9000），
 * 第三组专门盯"部分命中不许显示成 100%"。
 */
import { describe, expect, it } from 'vitest';
import {
  DECIMALS,
  formatCacheHitPercent,
  formatExactTokens,
  formatTokens,
} from '@/lib/tokenFormat';

describe('formatTokens：上下文长度保留 3 位小数', () => {
  it('三位小数是常量，改一处就够', () => {
    expect(DECIMALS).toBe(3);
  });

  it('小数字原样，K / M 分档带 3 位小数（末尾 0 不省）', () => {
    expect(formatTokens(517)).toBe('517');
    expect(formatTokens(999)).toBe('999');
    // 真机 mock 的上下文用量：15400 → 15.400K（旧实现是四舍五入的 15K）
    expect(formatTokens(15_400)).toBe('15.400K');
    expect(formatTokens(1_000_000)).toBe('1.000M');
    expect(formatTokens(1_234_567)).toBe('1.235M');
    expect(formatTokens(999_999)).toBe('999.999K');
    expect(formatTokens(0)).toBe('0');
  });

  it('缺失与非法值降级成破折号，不猜', () => {
    expect(formatTokens(null)).toBe('—');
    expect(formatTokens(undefined)).toBe('—');
    expect(formatTokens(Number.NaN)).toBe('—');
    expect(formatTokens(-5)).toBe('0');
  });
});

describe('formatExactTokens：账本行不压缩', () => {
  it('千分位分组，精确到个位', () => {
    expect(formatExactTokens(15_400)).toBe('15,400');
    expect(formatExactTokens(1_234_567)).toBe('1,234,567');
    expect(formatExactTokens(null)).toBe('—');
  });
});

describe('formatCacheHitPercent：3 位小数 + 不把部分命中凑成 100%', () => {
  it('常规命中率', () => {
    // 9000 / (12000 + 9000) = 42.857142…% → 42.857
    expect(formatCacheHitPercent(9_000, 21_000)).toBe('42.857');
    expect(formatCacheHitPercent(0, 1_000)).toBe('0.000');
    expect(formatCacheHitPercent(500, 1_000)).toBe('50.000');
  });

  it('全命中就是 100（不写小数）', () => {
    expect(formatCacheHitPercent(1_000, 1_000)).toBe('100');
  });

  it('没有提示词输入 → null（分母为 0 时命中率无意义）', () => {
    expect(formatCacheHitPercent(0, 0)).toBeNull();
    expect(formatCacheHitPercent(Number.NaN, 100)).toBeNull();
  });

  it('部分命中四舍五入到 100 时，加小数位把它区分出来', () => {
    // 99.9999% 命中：3 位小数会变成 100.000，必须显示成 99.9999
    const s = formatCacheHitPercent(999_999, 1_000_000);
    expect(s).not.toBe('100');
    expect(s).toBe('99.9999');
    expect(Number(s)).toBeLessThan(100);
    // 少 1 个 token 也一样：99.99999% → 至少不显示 100
    const t = formatCacheHitPercent(999_999_9, 10_000_000);
    expect(t).not.toBe('100');
    expect(Number(t)).toBeLessThan(100);
  });

  it('超过分母的缓存读被夹住，不会算出 >100%', () => {
    expect(formatCacheHitPercent(5_000, 1_000)).toBe('100');
  });
});
