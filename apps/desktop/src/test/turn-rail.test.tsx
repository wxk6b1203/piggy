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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  activeTurnOf,
  buildRailItems,
  findRowIndexByOffset,
  mergeRailItems,
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

/**
 * 预览框的**排版自洽性**（docs/04 §2.6）。
 *
 * 这条是补票：第一版只写了 `font-size`（行高继承正文的 24px），于是
 * 1 行标题 + 3 行正文 = 10 + 24 + 4 + 3×24 + 10 = **120px** > 容器的 `max-height: 100px`
 * ——第三行连同省略号被父容器切掉，看起来就是"overflow: hidden 硬切"。
 * 行高换成 DSH 的令牌（`--dsw-font-xs-strong-13` = 13px/20px、`--dsw-font-xxs-12` = 12px/18px）
 * 之后是 98px，与 100px 自洽。
 *
 * jsdom 量不出布局，所以这里核对的是**那个算式本身**：从真的 CSS 里读出这四个数，
 * 谁改了行高/内边距/容器高度而没重算，这条就红。真正的渲染由浏览器门禁量。
 */
describe('预览框排版与容器高度自洽（CSS 数值）', () => {
  /** 去掉注释再解析：注释里也会出现 "max-height:100px" 这类字样（我自己写的说明）。 */
  const bare = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '');
  const css = bare(readFileSync(resolve(__dirname, '..', 'styles.css'), 'utf8'));
  const tokens = bare(readFileSync(resolve(__dirname, '..', 'styles', 'tokens.css'), 'utf8'));

  /** 取某个选择器的声明块——**同一个选择器会出现两次**（共享块 + 它自己那块），
      所以按"包含某个属性"来挑，而不是取第一个匹配。 */
  const ruleOf = (selector: string, prop: string): string => {
    const hit = css.split('}').find((r) => r.includes(selector) && r.includes(prop));
    if (!hit) throw new Error(`styles.css 里找不到含 ${prop} 的 ${selector} 规则`);
    return `${hit}}`;
  };
  const px = (src: string, re: RegExp, what: string): number => {
    const m = re.exec(src);
    if (!m?.[1]) throw new Error(`没能读出${what}：${re}`);
    return parseFloat(m[1]);
  };
  const token = (name: string) => px(tokens, new RegExp(`(?:${name}:\\s*)(\\d+)px`), name);

  it('排版取 DSH 的两个 font 令牌（只写 font-size 就是那次 bug）', () => {
    // DSH：--dsw-font-xs-strong-13 = 500 13px/20px、--dsw-font-xxs-12 = 12px/18px
    expect(token('--pg-lh-13')).toBe(20);
    expect(token('--pg-lh-12')).toBe(18);
    const prompt = ruleOf('.pg-rail-preview-prompt', 'line-height');
    const response = ruleOf('.pg-rail-preview-response', 'line-height');
    expect(prompt, '标题没写 line-height').toMatch(/line-height:\s*var\(--pg-lh-13\)/);
    expect(response, '正文没写 line-height').toMatch(/line-height:\s*var\(--pg-lh-12\)/);
    expect(prompt).toMatch(/-webkit-line-clamp:\s*1/);
    expect(response).toMatch(/-webkit-line-clamp:\s*3/);
    // 三行封顶靠的是 clamp，而 clamp 要求 display:-webkit-box + overflow:hidden——
    // 那两条写在**两个类共享**的那条规则里，所以这里查共享块（不是各自那块）
    const shared = css
      .split('}')
      .find((r) => r.includes('.pg-rail-preview-prompt,') && r.includes('display: -webkit-box'));
    expect(shared, '标题/正文没有共享的 -webkit-box 规则，clamp 不生效').toBeTruthy();
    expect(shared, '共享规则里没隐藏溢出，省略号不会出现').toContain('overflow: hidden');
    expect(shared, '共享规则没有覆盖到正文').toContain('.pg-rail-preview-response');
    expect(shared).toContain('-webkit-box-orient: vertical');
  });

  it('算式 1×20 + 4 + 3×18 + 上下内边距 ≤ 容器 max-height（否则第 3 行连同省略号被切）', () => {
    const box = ruleOf('.pg-rail-preview', 'max-height');
    const response = ruleOf('.pg-rail-preview-response', 'margin-top');
    const pad = px(box, /padding:\s*(\d+)px/, '预览框上下内边距');
    const maxH = px(box, /max-height:\s*(\d+)px/, '预览框 max-height');
    const margin = px(response, /margin-top:\s*(\d+)px/, '正文上边距');
    const content = token('--pg-lh-13') + margin + 3 * token('--pg-lh-12') + pad * 2;
    expect(pad).toBe(10);
    expect(content, `内容 ${content}px 超过容器 ${maxH}px——第三行与省略号会被切掉`).toBeLessThanOrEqual(maxH);
    expect(maxH - content).toBeLessThanOrEqual(4); // 也别留太多空白（DSH 的 100 是照这套令牌算的）
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

  it('**指针离开刻度梯**时预览框要消失（鼠标移开还挂着就是 bug）', async () => {
    mountDom(<TurnRail {...props} />);
    await flush();
    const rail = q<HTMLElement>('[data-turn-rail]')!;
    const mark = q<HTMLElement>('[data-rail-mark="2"]')!;
    await act(async () => {
      mark.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('[data-rail-preview]'), '悬停没出预览，后面的核对就没意义').toBeTruthy();
    // 指针离开整条刻度梯（React 的 onPointerLeave 由 pointerout + relatedTarget 判定）
    await act(async () => {
      rail.dispatchEvent(
        new PointerEvent('pointerout', { bubbles: true, relatedTarget: document.body }),
      );
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('[data-rail-preview]'), '指针离开刻度梯后预览框没有消失').toBeNull();
    // 移开之后再移回来仍然能出（不是"一次性"的）
    await act(async () => {
      mark.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('[data-rail-preview]')).toBeTruthy();
  });

  it('点击跳到那一轮（回调拿到整条刻度：已载入的带行下标、未载入的带锚点）', async () => {
    mountDom(<TurnRail {...props} />);
    await flush();
    await act(async () => {
      q<HTMLElement>('[data-rail-mark="3"]')!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    // 已载入的刻度：行下标是"用户消息那一行"（第 3 轮 → 第 5 行，0 起 = 4）
    expect(props.onJump).toHaveBeenCalledWith(expect.objectContaining({ turn: 3, rowIndex: 4, loaded: true }));
  });

  it('未载入的刻度画成虚线，点击把锚点交给上层去翻页', async () => {
    const items = [
      ...buildRailItems(rows(turn(1), turn(2))),
      {
        turn: 3,
        rowIndex: null,
        anchorStart: 4096,
        anchorEnd: 4200,
        prompt: '还没载入的那一轮',
        response: '',
        loaded: false,
      },
    ];
    mountDom(<TurnRail {...props} items={items} />);
    await flush();
    const unloaded = q<HTMLElement>('[data-rail-unloaded]')!;
    expect(unloaded).toBeTruthy();
    expect(unloaded.getAttribute('data-rail-mark')).toBe('3');
    expect(unloaded.getAttribute('aria-label')).toContain('还没载入');
    await act(async () => {
      unloaded.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(props.onJump).toHaveBeenCalledWith(
      expect.objectContaining({ turn: 3, rowIndex: null, anchorStart: 4096, loaded: false }),
    );
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

describe('轮廓 + 已载入的行 → 刻度（"预览全部、展示部分"）', () => {
  /** 轮廓：4 轮，锚点是文件偏移 */
  const OUTLINE = [
    { turn: 1, start: 100, end: 200, prompt: '第一轮的问题', response: '第一轮的回答' },
    { turn: 2, start: 200, end: 300, prompt: '第二轮的问题', response: '第二轮的回答' },
    { turn: 3, start: 300, end: 400, prompt: '第三轮的问题', response: '第三轮的回答' },
    { turn: 4, start: 400, end: 500, prompt: '第四轮的问题', response: '第四轮的回答' },
  ];
  /** 转录里只载入了最后两行（第 4 轮），带文件偏移 */
  const rowsTail = [
    { role: 'user', content: '第四轮的问题', offset: 400 },
    { role: 'assistant', content: '第四轮的回答', offset: null },
  ];

  it('轮廓给全部轮次，已载入的那些带上行下标（其余是未载入锚点）', () => {
    const items = mergeRailItems(OUTLINE, rowsTail);
    expect(items.map((i) => i.turn)).toEqual([1, 2, 3, 4]);
    expect(items.map((i) => i.loaded)).toEqual([false, false, false, true]);
    // 未载入的三条带锚点（跳转要 `before = anchorEnd`），已载入的那条带行下标
    expect(items[0]).toMatchObject({ rowIndex: null, anchorStart: 100, anchorEnd: 200 });
    expect(items[3]).toMatchObject({ rowIndex: 0, anchorStart: null, anchorEnd: null });
    // 预览文字来自轮廓，所以没载入的轮次也能预览
    expect(items[0]!.prompt).toBe('第一轮的问题');
    expect(items[0]!.response).toBe('第一轮的回答');
  });

  it('实时新增的轮次接在最后，编号从轮廓末尾继续', () => {
    const rows = [
      { role: 'user', content: '第四轮的问题', offset: 400 },
      { role: 'assistant', content: '第四轮的回答', offset: null },
      { role: 'user', content: '刚问的第五轮', offset: null },
      { role: 'assistant', content: '刚答的第五轮', offset: null },
    ];
    const items = mergeRailItems(OUTLINE, rows);
    expect(items.map((i) => i.turn)).toEqual([1, 2, 3, 4, 5]);
    expect(items[4]).toMatchObject({ turn: 5, loaded: true, rowIndex: 2 });
    expect(items[4]!.prompt).toBe('刚问的第五轮');
  });

  it('没有轮廓 / 行不带偏移（退回 get_messages）→ 老实只画已载入的', () => {
    expect(mergeRailItems(null, rowsTail).map((i) => i.loaded)).toEqual([true]);
    // 兜底路径的行没有偏移，轮廓对不上任何一行：不能把整条梯子画成虚线
    const noOffsets = [
      { role: 'user', content: '第四轮的问题' },
      { role: 'assistant', content: '第四轮的回答' },
    ];
    const items = mergeRailItems(OUTLINE, noOffsets);
    expect(items.map((i) => i.loaded)).toEqual([true]);
    expect(items[0]!.turn).toBe(1);
  });

  it('未载入的刻度不参与"当前轮次"判定（阅读线只看已载入的行）', () => {
    const items = mergeRailItems(OUTLINE, rowsTail);
    expect(activeTurnOf(items, 0, false)).toBe(4);
    expect(activeTurnOf(items, 0, true)).toBe(4);
    // 换窗到中间（窗口下面还有未载入的更新轮次）时，"到底了"指的是**窗口**的底，
    // 不能取整个列表的最后一条刻度（那是没载入的第 6 轮）
    const windowed = mergeRailItems(
      [...OUTLINE, { turn: 5, start: 500, end: 600, prompt: '五', response: '' }, { turn: 6, start: 600, end: 700, prompt: '六', response: '' }],
      [
        { role: 'user', content: '第二轮的问题', offset: 200 },
        { role: 'assistant', content: '第二轮的回答', offset: null },
      ],
    );
    expect(activeTurnOf(windowed, 0, true)).toBe(2);
    // 没有任何已载入的行时退回第一条刻度（不至于没有高亮）
    const allUnloaded = mergeRailItems(OUTLINE, []);
    expect(activeTurnOf(allUnloaded, 0, false)).toBe(1);
  });

  it('findRowIndexByOffset：换窗之后按锚点找到目标行', () => {
    expect(findRowIndexByOffset(rowsTail, 400)).toBe(0);
    expect(findRowIndexByOffset(rowsTail, 999)).toBeNull();
  });
});
