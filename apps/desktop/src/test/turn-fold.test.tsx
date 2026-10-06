// @vitest-environment jsdom
/**
 * 回合级过程折叠 + 四档密度（docs/04 §2.1.6，DSH `TurnProcessNodeView`）。
 *
 * 这份用例分两层：
 *  - **纯函数**（`lib/turnFold.ts`）：一轮的边界怎么切、哪些行算过程、什么情况下不给折、
 *    用时怎么算（算不出来就不编）；
 *  - **渲染**（`Transcript` + `stores/turnFold.ts`）：默认档下历史回合被折成一行、
 *    点一下展开、手动选择不被档位改回去、正在跑的那一轮与中止的回合永远摊开、
 *    `compact` 档落定的思考行不显示摘要。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock, busListen } = vi.hoisted(() => ({
  busListen: new Map<string, (e: { payload: unknown }) => void>(),
  invokeMock: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (channel: string, cb: (e: { payload: unknown }) => void) => {
    busListen.set(channel, cb);
    return () => busListen.delete(channel);
  },
}));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  FeedbackBridge: () => null,
  confirm: vi.fn(),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey: (i: number) => string | number }) => ({
    getTotalSize: () => count * 88,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: getItemKey(index),
        start: index * 88,
        size: 88,
      })),
    getOffsetForIndex: (index: number) => [index * 88] as const,
    measureElement: () => {},
    measure: () => {},
    scrollRect: { width: 0, height: 400 },
    scrollToIndex: vi.fn(),
  }),
}));

import { Transcript } from '@/features/chat/Transcript';
import { ensureTabListeners } from '@/lib/tabEvents';
import { foldRowInput, formatDuration, turnFolds, type FoldRowInput } from '@/lib/turnFold';
import { useAppConfig } from '@/stores/appConfig';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { useTurnFold } from '@/stores/turnFold';
import { mountDom, unmountDom, domContainer } from './dom-render';

const TAB = 'tab-fold';
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const rows = (sel: string) => Array.from(domContainer().querySelectorAll(sel));
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const user = (id: string, ts: number): FoldRowInput => ({
  id, role: 'user', live: false, interrupted: false, failure: null, hasToolCall: false, hasText: true, timestamp: ts,
});
const assistant = (
  id: string,
  ts: number,
  o: { text?: boolean; tool?: boolean; failure?: 'error' | 'aborted' | null; live?: boolean } = {},
): FoldRowInput => ({
  id,
  role: 'assistant',
  live: o.live ?? false,
  interrupted: false,
  failure: o.failure ?? null,
  hasToolCall: o.tool ?? false,
  hasText: o.text ?? true,
  timestamp: ts,
});
const tool = (id: string, ts: number): FoldRowInput => ({
  id, role: 'toolResult', live: false, interrupted: false, failure: null, hasToolCall: false, hasText: true, timestamp: ts,
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => ({}));
  useMessages.setState({ tabs: {} });
  useTurnFold.setState({ open: {} });
  useTabs.setState({
    tabs: { [TAB]: { tabId: TAB, sessionFile: '/tmp/fold.jsonl', cwd: '/tmp', workerState: 'ready' } } as never,
    order: [TAB],
    activeTabId: TAB,
    unread: {},
    banner: null,
  });
  useAppConfig.setState({ railPlacement: 'off', transcriptDetail: 'standard', loaded: true });
});
afterEach(async () => {
  await unmountDom();
});

describe('turnFolds（纯函数）', () => {
  it('一轮 = user 行到下一个 user 行之前；过程折、最终回答留', () => {
    const rowsIn: FoldRowInput[] = [
      user('u1', 1000),
      assistant('a1', 2000, { text: false, tool: true }), // 中间助手消息（带工具调用）→ 过程
      tool('t1', 2500),
      assistant('a2', 3000), // 最终回答（有正文、无工具调用）→ 留
      user('u2', 9000),
      assistant('a3', 9500),
    ];
    const folds = turnFolds(rowsIn);
    expect(folds).toHaveLength(2);
    expect(folds[0]!.processIndexes).toEqual([1, 2]);
    expect(folds[0]!.answerIndex).toBe(3);
    expect(folds[0]!.foldable).toBe(true);
    expect(folds[0]!.durationMs, '用时 = 段内最后一行 − user 行').toBe(2000);
    // 第二段：一问一答 → 没有可折的东西，但标题（含状态）仍然画
    expect(folds[1]!.processIndexes).toEqual([]);
    expect(folds[1]!.foldable).toBe(false);
    expect(folds[1]!.reason).toBe('no-process');
    expect(folds[1]!.showHeader).toBe(true);
  });

  it('正在跑的那一轮不折（最后一段 + streaming）', () => {
    const rowsIn: FoldRowInput[] = [user('u1', 0), assistant('a1', 100, { text: false, tool: true, live: true })];
    expect(turnFolds(rowsIn, true)[0]!.foldable).toBe(false);
    expect(turnFolds(rowsIn, true)[0]!.reason).toBe('running');
    // 没有 live 行但 streaming 为真（刚发出去、第一个字还没到）也算没结束
    const waiting: FoldRowInput[] = [user('u1', 0)];
    expect(turnFolds(waiting, true)[0]!.closed).toBe(false);
    expect(turnFolds(waiting, false)[0]!.closed).toBe(true);
    // 中途那一轮即使有 live 行也不算结束
    const twoTurns: FoldRowInput[] = [user('u1', 0), assistant('a1', 10, { live: true }), user('u2', 20)];
    expect(turnFolds(twoTurns, true)[0]!.closed).toBe(false);
  });

  it('中止 / 失败的回合不折（过程是排查现场）', () => {
    const aborted: FoldRowInput[] = [
      user('u1', 0),
      assistant('a1', 10, { text: false, tool: true }),
      assistant('a2', 20, { text: false, failure: 'aborted' }),
    ];
    const f = turnFolds(aborted)[0]!;
    expect(f.foldable, '中止的回合被折了').toBe(false);
    expect(f.reason).toBe('settled-failure');
    expect(f.status).toBe('aborted');
    expect(f.showHeader, '标题仍要画出来：它说明这一轮怎么结束的').toBe(true);
  });

  it('时间戳缺一端 → 用时为 null（不编数字）', () => {
    const rowsIn: FoldRowInput[] = [
      { ...user('u1', 0), timestamp: null },
      assistant('a1', 10, { text: false, tool: true }),
      assistant('a2', 20),
    ];
    expect(turnFolds(rowsIn)[0]!.durationMs).toBeNull();
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(12_400)).toBe('12s');
    expect(formatDuration(65_000)).toBe('1m 05s');
    expect(formatDuration(3_720_000)).toBe('1h 02m');
  });

  it('分页窗口从半途开始（第一行不是 user）→ 那一段不返回', () => {
    const rowsIn: FoldRowInput[] = [tool('t0', 0), user('u1', 1000), assistant('a1', 2000)];
    const folds = turnFolds(rowsIn);
    expect(folds, '没有 user 的前置段不该被折').toHaveLength(1);
    expect(folds[0]!.start).toBe(1);
  });

  it('foldRowInput：从 store 的行走形状里摘字段', () => {
    const input = foldRowInput({
      id: 'x',
      role: 'assistant',
      live: [undefined],
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '想' },
          { type: 'text', text: '  ' }, // 只有空白 → 不算可见正文
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: {} },
        ],
        timestamp: 42,
      } as never,
    });
    expect(input.live).toBe(true);
    expect(input.hasToolCall).toBe(true);
    expect(input.hasText).toBe(false);
    expect(input.timestamp).toBe(42);
    expect(input.failure).toBeNull();
  });
});

describe('渲染：折成一行、点开、档位与手动选择', () => {
  const seed = (): never[] =>
    [
      { role: 'user', content: [{ type: 'text', text: '第一轮的问题' }], timestamp: 1000 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先看看目录' },
          { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls -la' } },
        ],
        timestamp: 2000,
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'total 0' }],
        timestamp: 2500,
      },
      { role: 'assistant', content: [{ type: 'text', text: '第一轮的最终回答' }], timestamp: 3000 },
      { role: 'user', content: [{ type: 'text', text: '第二轮的问题' }], timestamp: 9000 },
      { role: 'assistant', content: [{ type: 'text', text: '第二轮的最终回答' }], timestamp: 9500 },
    ] as never[];

  async function mount(seedRows: unknown[] = seed()) {
    useMessages.getState().hydrate(TAB, seedRows as never[]);
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    await ensureTabListeners(TAB);
  }

  it('标准档：历史回合折成一行，回答还在；点一下展开过程', async () => {
    await mount();
    const fold = () => rows('[data-turn-fold]');
    expect(fold(), '没有画出折叠行').toHaveLength(2);
    expect(text(fold()[0])).toContain('已完成工作');
    expect(text(fold()[0])).toMatch(/\ds/); // 标准档带耗时
    // 折起来：思考/工具行都不在 DOM 里，回答在
    expect(rows('[data-thinking-row]'), '折起来的思考行还在渲染').toHaveLength(0);
    expect(rows('[data-tool-row]'), '折起来的工具行还在渲染').toHaveLength(0);
    expect(text(domContainer()), '最终回答被折进去了（它必须留在外面）').toContain('第一轮的最终回答');

    // 点开
    await act(async () => {
      (fold()[0]!.querySelector('[data-turn-fold-head], .pg-turnfold-head') as HTMLElement).click();
    });
    await flush();
    expect(rows('[data-thinking-row]'), '展开后思考行没回来').toHaveLength(1);
    expect(rows('[data-tool-row]'), '展开后工具行没回来').toHaveLength(1);
    expect(text(fold()[0]), '展开后标题行应当还在（它兼作这一轮的分隔）').toContain('已完成工作');
  });

  it('简洁档：不带耗时、落定的思考摘要隐藏；完全展开档：连标题行都不画', async () => {
    await mount();
    await act(async () => {
      useAppConfig.setState({ transcriptDetail: 'compact' });
    });
    await flush();
    expect(text(rows('[data-turn-fold]')[0])).toBe('已完成工作');

    // 展开过程看摘要：简洁档下落定的思考行没有摘要
    await act(async () => {
      (rows('[data-turn-fold]')[0]!.querySelector('.pg-turnfold-head') as HTMLElement).click();
    });
    await flush();
    const think = rows('[data-thinking-row]')[0]!;
    expect(text(think.querySelector('.pg-trow-summary')), '简洁档应当隐藏落定的思考摘要').toBe('');

    // 标准档下摘要是有的（对照）
    await act(async () => {
      useAppConfig.setState({ transcriptDetail: 'standard' });
    });
    await flush();
    expect(text(rows('[data-thinking-row]')[0]!.querySelector('.pg-trow-summary'))).toBe('先看看目录');

    // 完全展开：标题行消失、过程全可见
    await act(async () => {
      useAppConfig.setState({ transcriptDetail: 'verbose' });
    });
    await flush();
    expect(rows('[data-turn-fold]'), '完全展开档还画着标题行').toHaveLength(0);
    expect(rows('[data-thinking-row]'), '完全展开档过程应当是可见的').toHaveLength(1);
  });

  it('详细档：默认摊开（过程可见），标题行不可折叠', async () => {
    await mount();
    await act(async () => {
      useAppConfig.setState({ transcriptDetail: 'detailed' });
    });
    await flush();
    expect(rows('[data-thinking-row]'), '详细档默认应当摊开').toHaveLength(1);
    expect(rows('[data-turn-fold]').length).toBeGreaterThan(0);
  });

  it('手动展开的选择不被档位改回去', async () => {
    await mount();
    await act(async () => {
      (rows('[data-turn-fold]')[0]!.querySelector('.pg-turnfold-head') as HTMLElement).click();
    });
    await flush();
    expect(rows('[data-thinking-row]')).toHaveLength(1);
    // 切档（standard → detailed → standard）之后仍然是展开的
    await act(async () => {
      useAppConfig.setState({ transcriptDetail: 'detailed' });
    });
    await flush();
    await act(async () => {
      useAppConfig.setState({ transcriptDetail: 'standard' });
    });
    await flush();
    expect(rows('[data-thinking-row]'), '手动展开的选择被档位切换吃掉了').toHaveLength(1);
    // 折叠记忆用的是会话文件偏移（跨载入稳定）——这里 hydrate 不带 offset，退回行 id
    expect(Object.keys(useTurnFold.getState().open[TAB] ?? {}).length).toBeGreaterThan(0);
  });

  it('正在跑的那一轮不折（过程可见）', async () => {
    await mount([
      ...seed().slice(0, 4),
      { role: 'user', content: [{ type: 'text', text: '第三轮' }], timestamp: 10_000 },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '正在想' }], timestamp: 10_100 },
    ] as never[]);
    useMessages.setState((s) => {
      s.tabs[TAB]!.streaming = true;
      return s;
    });
    await flush();
    // 前两轮折、最后一段（正在跑）摊开
    expect(rows('[data-turn-fold]'), '正在跑的那一轮也画了折叠标题').toHaveLength(1);
    expect(text(domContainer())).toContain('正在想');
  });
});
