/**
 * 行内展开态的记忆（`lib/rowMemory`）。
 *
 * 为什么要有这一层：转录虚拟化会把滚出窗口的行**卸载**，行里的 `useState` 跟着丢
 * —— 用户 2026-09-23 报的"思考/工具行展开看完、滚上去再滚回底部就看不到过程"
 * 就是它。记忆活在行组件外面，就必须自己有键的口径、上限与清理时机，
 * 这三条都在这里钉住（组件侧的行为见 `row-disclosure.test.tsx`）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ROW_MEMORY_MAX,
  forgetRowTab,
  readRowFlag,
  rememberRowFlag,
  resetRowMemory,
  rowMemorySize,
  slotKey,
} from '@/lib/rowMemory';

beforeEach(() => {
  resetRowMemory();
});

describe('键的口径', () => {
  it('没有行身份（轨迹视图那种孤立渲染）时不记忆', () => {
    expect(slotKey(undefined, 'tool')).toBeNull();
    expect(readRowFlag(null, 'open')).toBeUndefined();
  });

  it('tab / 行 / 插槽三段都参与区分', () => {
    const a = slotKey({ tabId: 't1', rowKey: 'r1' }, 'tool');
    const otherRow = slotKey({ tabId: 't1', rowKey: 'r2' }, 'tool');
    const otherSlot = slotKey({ tabId: 't1', rowKey: 'r1' }, 'todo');
    const otherTab = slotKey({ tabId: 't2', rowKey: 'r1' }, 'tool');
    const keys = new Set([a, otherRow, otherSlot, otherTab]);
    expect(keys.size, '四个键必须两两不同').toBe(4);
  });

  it('行键或插槽名里带分隔符也不会串（分隔符是 NUL）', () => {
    const x = slotKey({ tabId: 't', rowKey: 'a b' }, 'tool');
    const y = slotKey({ tabId: 't', rowKey: 'a' }, 'b tool');
    expect(x).not.toBe(y);
  });

  it('没记过返回 undefined（与"记过 false"区分开）', () => {
    const key = slotKey({ tabId: 't1', rowKey: 'r1' }, 'tool')!;
    expect(readRowFlag(key, 'open')).toBeUndefined();
    rememberRowFlag(key, 'open', false);
    expect(readRowFlag(key, 'open'), '记过的 false 必须读得回来').toBe(false);
  });
});

describe('上限与清理', () => {
  it('超过上限按 LRU 淘汰最老的条目（内存不许无限长）', () => {
    const first = slotKey({ tabId: 't0', rowKey: 'r0' }, 'tool')!;
    rememberRowFlag(first, 'open', true);
    // 灌到刚好超出上限
    for (let i = 1; i <= ROW_MEMORY_MAX; i += 1) {
      rememberRowFlag(slotKey({ tabId: `t${i}`, rowKey: `r${i}` }, 'tool')!, 'open', true);
    }
    expect(rowMemorySize(), '条目数必须停在上限').toBe(ROW_MEMORY_MAX);
    expect(readRowFlag(first, 'open'), '最老的那条该被淘汰').toBeUndefined();
  });

  it('再写一次会把它移到队尾（LRU 而不是 FIFO）', () => {
    const a = slotKey({ tabId: 't', rowKey: 'a' }, 'tool')!;
    const b = slotKey({ tabId: 't', rowKey: 'b' }, 'tool')!;
    rememberRowFlag(a, 'open', true);
    rememberRowFlag(b, 'open', true);
    rememberRowFlag(a, 'open', false); // a 再写一次 → 变成最新
    for (let i = 0; i < ROW_MEMORY_MAX - 2; i += 1) {
      rememberRowFlag(slotKey({ tabId: 't', rowKey: `f${i}` }, 'tool')!, 'open', true);
    }
    expect(rowMemorySize()).toBe(ROW_MEMORY_MAX); // 正好到上限
    rememberRowFlag(slotKey({ tabId: 't', rowKey: 'newest' }, 'tool')!, 'open', true);

    expect(readRowFlag(a, 'open'), 'a 是刚写过的，不该被淘汰（FIFO 会淘汰它）').toBe(false);
    expect(readRowFlag(b, 'open'), 'b 才是最老的，该它走').toBeUndefined();
  });

  it('forgetRowTab 只清那个标签的记忆', () => {
    rememberRowFlag(slotKey({ tabId: 't1', rowKey: 'r1' }, 'tool')!, 'open', true);
    rememberRowFlag(slotKey({ tabId: 't2', rowKey: 'r1' }, 'tool')!, 'open', true);
    forgetRowTab('t1');
    expect(readRowFlag(slotKey({ tabId: 't1', rowKey: 'r1' }, 'tool'), 'open')).toBeUndefined();
    expect(readRowFlag(slotKey({ tabId: 't2', rowKey: 'r1' }, 'tool'), 'open')).toBe(true);
    expect(rowMemorySize()).toBe(1);
  });
});
