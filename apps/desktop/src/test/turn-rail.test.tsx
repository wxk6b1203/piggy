// @vitest-environment jsdom
/**
 * 会话预览滚动条（docs/04 §2.6、docs/12 §3）。
 *
 * 对着 DSH `TurnNavigator` 的行为逐条锁。三类失败最值得防：
 *   ① **刻度数不对**——按消息画而不是按回合画，一次工具密集的回答会画出几十条刻度，
 *      梯子立刻失去形状；反过来说，漏掉某轮就是"这段历史在梯子上不存在"；
 *   ② **亮度不跟滚动走**——用户要的核心就是这个（"亮色的条子代表当前位置"）；
 *   ③ **预览框内容错位**——标题必须是**用户的提问**、正文是回答摘要，
 *      写反了等于每次悬停都看错东西。
 *
 * 几何（28px 宽、刻度 20×2、10px 间距、渐隐 24px）在浏览器门禁里量，
 * jsdom 里 getBoundingClientRect 全是 0（docs/15 规矩 32）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

/**
 * jsdom 里 `clientHeight` 永远是 0，虚拟化器据此算出**空的**可视窗口——真实的
 * `TurnRail` 在 jsdom 下一条刻度都不会渲染（这也是本仓库此前没有虚拟列表单测的原因）。
 * 所以这里换一个**朴素的替身**：把所有条目都当成可视。它测的是"我拿到条目后怎么渲染"，
 * 而"滚动窗口算得对不对、渐变/内部滚动/几何长什么样"由浏览器门禁在真布局里量。
 */
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (i: number) => number }) => ({
    getTotalSize: () => count * estimateSize(0),
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * estimateSize(index),
        size: estimateSize(index),
      })),
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  FeedbackBridge: () => null,
  confirm: vi.fn(),
}));

import {
  activeTurnOf,
  buildRailItems,
  condense,
  messageText,
  type RailSourceRow,
} from '@/features/chat/turnRailItems';
import { TurnRail } from '@/features/chat/TurnRail';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const q = <T extends Element>(sel: string) => domContainer().querySelector<T>(sel);
const qa = <T extends Element>(sel: string) => [...domContainer().querySelectorAll<T>(sel)];

/** 造一个回合序列（user + assistant 交替）。 */
const turn = (n: number, answer = `回答 ${n}`): RailSourceRow[] => [
  { role: 'user', content: [{ type: 'text', text: `问题 ${n}` }] },
  { role: 'assistant', content: [{ type: 'text', text: answer }] },
];
const rows = (...blocks: RailSourceRow[][]): RailSourceRow[] => blocks.flat();

afterEach(async () => {
  await unmountDom();
});

describe('回合切分（buildRailItems）', () => {
  it('一轮 = 一个用户提问 + 它后面的回答；turn 从 1 起、带行下标', () => {
    const items = buildRailItems(rows(turn(1), turn(2), turn(3)));
    expect(items.map((i) => i.turn)).toEqual([1, 2, 3]);
    // 行下标指向**用户消息那一行**（跳转要精确落到提问上）
    expect(items.map((i) => i.rowIndex)).toEqual([0, 2, 4]);
    expect(items[0]!.prompt).toBe('问题 1');
    expect(items[0]!.response).toBe('回答 1');
  });

  it('一轮里有多条 assistant 消息（工具调用被拆开）时合并成一条摘要', () => {
    const items = buildRailItems([
      { role: 'user', content: '帮我看看' },
      { role: 'assistant', content: [{ type: 'text', text: '先读文件' }] },
      { role: 'assistant', content: [{ type: 'text', text: '再改一处' }] },
      { role: 'assistant', content: [{ type: 'tool_use', name: 'bash' }] },
      { role: 'assistant', content: [{ type: 'text', text: '好了' }] },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.response).toBe('先读文件 再改一处 好了');
  });

  it('开头不是用户消息的行（恢复出来的半截会话）不造刻度', () => {
    const items = buildRailItems([
      { role: 'assistant', content: '上一轮的尾巴' },
      { role: 'user', content: '新问题' },
      { role: 'assistant', content: '新回答' },
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toBe('新问题');
    expect(items[0]!.rowIndex).toBe(1);
  });

  it('没有回答的轮次也画刻度（用户刚发出去就断了），只是正文为空', () => {
    const items = buildRailItems([{ role: 'user', content: '只有提问' }]);
    expect(items).toHaveLength(1);
    expect(items[0]!.response).toBe('');
  });

  it('压成一行 + 截断：预览框是固定高度的，换行会把它顶开', () => {
    expect(condense('多行\n文本\t带  空白', 80)).toBe('多行 文本 带 空白');
    const long = '啊'.repeat(200);
    const out = condense(long, 80);
    expect(out.length).toBe(81); // 80 + 一个省略号
    expect(out.endsWith('…')).toBe(true);
    // 纯文本提取只认 text 块（工具块、图片块不算）
    expect(messageText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(messageText('直接是字符串')).toBe('直接是字符串');
    expect(messageText(undefined)).toBe('');
  });

  it('**覆盖整段历史**：1000 轮的会话，梯子上就有 1000 条刻度', () => {
    const many: RailSourceRow[] = [];
    for (let i = 1; i <= 1000; i += 1) many.push(...turn(i));
    const items = buildRailItems(many);
    expect(items).toHaveLength(1000);
    expect(items[999]!.turn).toBe(1000);
    expect(items[999]!.rowIndex).toBe(1998);
  });
});

describe('当前轮次（activeTurnOf）', () => {
  const items = buildRailItems(rows(turn(1), turn(2), turn(3)));
  it('取阅读线所在的那一轮；滚到底直接取最后一轮', () => {
    expect(activeTurnOf(items, 0, false)).toBe(1);
    expect(activeTurnOf(items, 1, false)).toBe(1);
    expect(activeTurnOf(items, 2, false)).toBe(2);
    expect(activeTurnOf(items, 4, false)).toBe(3);
    // 在底部：哪怕阅读线还没到最后一轮，也认最后一轮（用户明明在看它）
    expect(activeTurnOf(items, 2, true)).toBe(3);
    // 阅读线在第一条之前 → 第一轮（不能返回 null，否则亮度会闪没）
    expect(activeTurnOf(items, 0, false)).toBe(1);
    expect(activeTurnOf([], 0, false)).toBeNull();
  });
});

describe('刻度梯组件（TurnRail）', () => {
  const items = buildRailItems(rows(turn(1), turn(2), turn(3)));
  const props = { items, activeTurn: 2, placement: 'right' as const, onJump: vi.fn() };

  beforeEach(() => props.onJump.mockReset());

  it('一轮一条刻度；只有当前那条是 is-active（亮色条）', async () => {
    mountDom(<TurnRail {...props} />);
    await flush();
    expect(qa('[data-rail-mark]')).toHaveLength(3);
    const active = qa('[data-rail-mark]').filter((m) => m.classList.contains('is-active'));
    expect(active).toHaveLength(1);
    expect(active[0]!.getAttribute('data-rail-mark')).toBe('2');
  });

  it('少于 2 轮不画（一个刻度不构成"梯子"）', async () => {
    mountDom(<TurnRail {...props} items={buildRailItems(turn(1))} />);
    await flush();
    expect(q('[data-turn-rail]')).toBeNull();
  });

  it('悬停出预览框：标题是用户提问、正文是回答摘要；移开就收', async () => {
    mountDom(<TurnRail {...props} />);
    await flush();
    expect(q('[data-rail-preview]')).toBeNull();
    const mark = q<HTMLElement>('[data-rail-mark="3"]')!;
    await act(async () => {
      // React 的 onPointerEnter 是由 `pointerover` 委托出来的（不是原生 pointerenter），
      // 直接派发 pointerenter 永远进不了处理函数——第一版就是这么假红的
      mark.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    const box = q('[data-rail-preview]')!;
    expect(box).toBeTruthy();
    expect(q('[data-rail-preview-prompt]')!.textContent).toBe('问题 3');
    expect(q('[data-rail-preview-response]')!.textContent).toBe('回答 3');
    // 悬停的那条同时进入 is-preview（比静息亮、比激活暗）
    expect(mark.classList.contains('is-preview')).toBe(true);
    // 预览是无障碍的 tooltip，并被 aria-describedby 关联
    expect(box.getAttribute('role')).toBe('tooltip');
    expect(mark.getAttribute('aria-describedby')).toBe(box.getAttribute('id'));
  });

  it('点击跳到那一轮（给的是转录行下标，不是轮次号）', async () => {
    mountDom(<TurnRail {...props} />);
    await flush();
    await act(async () => {
      q<HTMLElement>('[data-rail-mark="3"]')!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(props.onJump).toHaveBeenCalledWith(4);
  });

  it('左右两档都用同一个组件，差别只在 placement 属性（CSS 负责镜像）', async () => {
    mountDom(<TurnRail {...props} placement="left" />);
    await flush();
    expect(q('[data-turn-rail]')!.getAttribute('data-rail-placement')).toBe('left');
    expect(q('.pg-rail-left')).toBeTruthy();
  });

  it('键盘也能预览：聚焦出预览、失焦收起（鼠标能做的键盘也要能做）', async () => {
    mountDom(<TurnRail {...props} />);
    await flush();
    const mark = q<HTMLElement>('[data-rail-mark="1"]')!;
    await act(async () => {
      // 同理：React 的 onFocus 走 `focusin` 委托，直接派发 focus 不行；`.focus()` 会两个都发
      mark.focus();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('[data-rail-preview-prompt]')!.textContent).toBe('问题 1');
    await act(async () => {
      mark.blur();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('[data-rail-preview]')).toBeNull();
  });
});
