// @vitest-environment jsdom
/**
 * 流式那一行 = 转录里的那一行（2026-09-24 重整）。
 *
 * ## 这份用例盯的是三个**实测复现过**的结构性错误
 *
 * 用户报的原话："工具之类的会被逐步输出，最后打印，这就非常诡异了"、
 * "中途输出出现了错乱"。现场（同一轮两次助手消息 + 一次工具执行，全部走真实帧通道）：
 *
 * ```
 * 转正行 0  思考 · 先看看目录里有什么          ← 第一条助手消息的思考（React 渲染）
 * 转正行 1  运行命令 · ls -la                  ← 工具结果（React 渲染）
 * 实时行    思考 · 先看看目录里有什么现在读源码  ← ① 与行 0 重复；② 两条消息的思考**连成一句**
 * 实时行    运行命令 · ls -la                  ← ③ read 的调用被并进 bash 那一行，**整行消失**
 * ```
 *
 * 三个根因都在旧实现（`lib/live` 的 DOM 引擎）里：
 *   ① 提交只往 store 里加行，DOM 引擎那份不会自己消失 → 同一内容出现两遍；
 *   ② 块按 `contentIndex` 编号，而它在 pi 里**每条助手消息从 0 重新开始**
 *      → 第二条消息的思考追加进第一条的思考行、工具调用追加进第一条的工具行；
 *   ③ 工具行由 `toolResult` 消息渲染，而 `toolCall` 块 `return null`
 *      → 工具要等执行完才出现，且换一条消息就换一行。
 *
 * 现在：行源是 store 的 `ids`（`message_start` 就建行、`message_end` 就地转正），
 * 块的槽位是**消息内**的 `contentIndex`，工具行由助手消息里的 `toolCall` 块渲染、
 * 结果按 `callId` 并进同一行。
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
/* 虚拟化器：全渲染 + 固定行高（本文件量的是"行与块"，不是几何；几何由
   `transcript-page.test.tsx` 与真浏览器门禁量）。 */
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
import { useAppConfig } from '@/stores/appConfig';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { mountDom, unmountDom, domContainer } from './dom-render';

const TAB = 'tab-live';
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const all = (sel: string) => Array.from(domContainer().querySelectorAll(sel));
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** 从 `pi:commit` 通道推一条事件（走 `tabEvents` 的真实接线）。 */
async function commit(ev: Record<string, unknown>) {
  await act(async () => {
    busListen.get(`pi:commit:${TAB}`)?.({ payload: ev });
    await new Promise((r) => setTimeout(r, 5));
  });
}

/** 从 `pi:frame` 通道推一帧（同样走真实接线，不直接调 store）。 */
async function frame(payload: Record<string, unknown>) {
  await act(async () => {
    busListen.get(`pi:frame:${TAB}`)?.({ payload });
    await new Promise((r) => setTimeout(r, 5));
  });
}

const assistant = (content: unknown[], timestamp: number) => ({
  type: 'message_end',
  message: { role: 'assistant', content, timestamp },
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => ({}));
  useMessages.setState({ tabs: {} });
  useTabs.setState({
    tabs: { [TAB]: { tabId: TAB, sessionFile: '/tmp/live.jsonl', cwd: '/tmp', workerState: 'ready' } } as never,
    order: [TAB],
    activeTabId: TAB,
    unread: {},
    banner: null,
  });
  useAppConfig.setState({ railPlacement: 'off', loaded: true });
});
afterEach(async () => {
  await unmountDom();
});

/** 挂上转录 + 真实事件接线（帧与 commit 都从通道走）。 */
async function mount(seed: unknown[] = []) {
  useMessages.getState().hydrate(TAB, seed as never[]);
  mountDom(<Transcript tabId={TAB} />);
  await flush();
  await ensureTabListeners(TAB);
}

describe('一轮里两条助手消息：块按**消息内**的 contentIndex 编号', () => {
  it('第二条消息的思考不会追加进第一条，工具行也不会被吞掉', async () => {
    await mount();
    await commit({ type: 'agent_start' });

    // ── 第 1 条助手消息：思考 + 工具调用（bash）
    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await frame({ signals: [{ type: 'thinking_start', contentIndex: 0 }] });
    await frame({ thinking: [{ contentIndex: 0, delta: '先看看目录里有什么' }] });
    await frame({ signals: [{ type: 'toolcall_start', contentIndex: 1, id: 'call-1', toolName: 'bash' }] });
    await frame({ toolArgs: [{ contentIndex: 1, delta: '{"command":"ls -la"}' }] });

    expect(all('[data-thinking-row]'), '流式中的思考行没建出来').toHaveLength(1);
    /* 流式摘要 = **最后一个已完成段落的首行**（DSH `latestCompletedParagraphFirstLine`）：
       第一行还没写完（没有换行）时**没有摘要**，写完才出现 —— 这一条是照抄 DSH 的口径，
       不是"首行一动就写上去"。 */
    const thinkSummary = () => text(all('[data-thinking-row]')[0]?.querySelector('.pg-trow-summary'));
    expect(thinkSummary(), '第一行还没写完就写了摘要').toBe('');
    await frame({ thinking: [{ contentIndex: 0, delta: '\n第二行' }] });
    expect(thinkSummary(), '第一行写完之后摘要没出现').toBe('先看看目录里有什么');
    await frame({ thinking: [{ contentIndex: 0, delta: '\n\n第三段开头' }] });
    expect(thinkSummary(), '新段落的第一行还没写完，摘要不该跳过去').toBe('先看看目录里有什么');
    await frame({ thinking: [{ contentIndex: 0, delta: '，写完了这行\n继续写' }] });
    expect(thinkSummary(), '新段落第一行写完之后摘要没跟过去').toBe('第三段开头，写完了这行');
    expect(all('[data-tool-row]'), '流式中的工具行没建出来').toHaveLength(1);
    expect(text(all('[data-tool-row]')[0]?.querySelector('.pg-trow-summary'))).toBe('ls -la');

    // 转正：权威消息落进**同一行**
    await commit(assistant([
      { type: 'thinking', thinking: '先看看目录里有什么' },
      { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls -la' } },
    ], 1));
    expect(all('[data-thinking-row]'), '转正后又多出一个思考行（同一内容出现两遍）').toHaveLength(1);
    expect(all('[data-tool-row]'), '转正后工具行数量不对').toHaveLength(1);
    expect(all('[data-tool-row]')[0]?.getAttribute('data-state'), '结果没到，应当是运行中').toBe('running');

    // 工具结果：**并进那一行**，不新增行
    await commit({
      type: 'message_end',
      message: {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'total 0' }],
        timestamp: 2,
      },
    });
    expect(all('[data-tool-row]'), '工具结果另起了一行').toHaveLength(1);
    const tool = all('[data-tool-row]')[0]!;
    expect(tool.getAttribute('data-state')).toBe('ok');
    // 折叠 = 正文不挂载（DSH 同款）：点开才看得到结果，点开之后必须在
    expect(text(tool), '折叠时结果就已经在 DOM 里了').not.toContain('total 0');
    await act(async () => {
      (tool.querySelector('[data-disclosure-row]') as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(text(all('[data-tool-row]')[0]), '结果没并进工具行').toContain('total 0');

    // ── 第 2 条助手消息：**contentIndex 又从 0 开始**（真实协议语义）
    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await frame({ signals: [{ type: 'thinking_start', contentIndex: 0 }] });
    await frame({ thinking: [{ contentIndex: 0, delta: '现在读源码\n看到入口了' }] });
    await frame({ signals: [{ type: 'toolcall_start', contentIndex: 1, id: 'call-2', toolName: 'read' }] });
    await frame({ toolArgs: [{ contentIndex: 1, delta: '{"path":"server.go"}' }] });
    await frame({ text: [{ contentIndex: 2, delta: '这个目录是最终版。' }] });

    const thinkRows = all('[data-thinking-row]');
    expect(thinkRows, '思考行数量不对（应当是两条消息各一行）').toHaveLength(2);
    /* 两条消息各占一行、互不污染：第一条已经转正（摘要是权威内容的首行），
       第二条还在流（摘要是它最后一个已完成段落的首行）。 */
    expect(text(thinkRows[0]?.querySelector('.pg-trow-summary')), '第一条消息的思考被第二条污染了').toBe(
      '先看看目录里有什么',
    );
    expect(text(thinkRows[1]?.querySelector('.pg-trow-summary'))).toBe('现在读源码');

    const toolRows = all('[data-tool-row]');
    expect(toolRows.map((r) => r.getAttribute('data-tool')), '工具行的顺序/身份不对').toEqual(['bash', 'read']);
    expect(text(toolRows[1]?.querySelector('.pg-trow-summary')), 'read 的摘要丢了（被并进 bash 行）').toBe(
      'server.go',
    );
    // 流式正文按纯文本画（双阶段策略：转正才 parse markdown）
    expect(text(all('.pg-md-streaming')[0])).toBe('这个目录是最终版。');
  });

  it('打开会话的行数与「加载更早」不受流式行影响（工具结果不再占一行）', async () => {
    await mount([
      { role: 'user', content: [{ type: 'text', text: '问' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } }],
        timestamp: 2,
      },
    ]);
    // 调用在窗口里 → 结果并进那一行，**不新增行**
    await act(async () => {
      useMessages.getState().applyCommit(TAB, {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'bash',
          content: [{ type: 'text', text: 'ok' }],
          timestamp: 3,
        },
      } as never);
    });
    const tab = useMessages.getState().tabs[TAB]!;
    expect(tab.ids, '工具结果占据了独立的一行').toHaveLength(2);
    expect(tab.ids.map((id) => tab.byId[id]?.role)).toEqual(['user', 'assistant']);
    expect(all('[data-tool-row]')).toHaveLength(1);
  });
});

describe('流式行的生死由事件层认', () => {
  it('message_start 建行、message_end 就地转正：行 id 与下标都不变', async () => {
    await mount();
    await commit({ type: 'agent_start' });
    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await frame({ text: [{ contentIndex: 0, delta: '前半段' }] });

    const before = useMessages.getState().tabs[TAB]!;
    expect(before.ids, '流式那一行没有立即进 ids').toHaveLength(1);
    const rowId = before.ids[0]!;
    expect(before.byId[rowId]?.live?.[0]?.text).toBe('前半段');

    await commit(assistant([{ type: 'text', text: '前半段后半段' }], 1));
    const after = useMessages.getState().tabs[TAB]!;
    expect(after.ids, '转正时行的下标变了').toEqual([rowId]);
    expect(after.byId[rowId]?.live, '转正后还留着流式槽位').toBeUndefined();
    expect(after.pendingId).toBeNull();
    // 转正后是 markdown（不再是纯文本 `<p>`）
    expect(all('.pg-md-streaming'), '转正后还在按流式文本画').toHaveLength(0);
    expect(text(domContainer().querySelector('.pg-message'))).toContain('前半段后半段');
  });

  it('新一轮 agent_start 之后：掉队的流式行就地落定，不会与新一轮叠加', async () => {
    await mount();
    await commit({ type: 'agent_start' });
    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await frame({ text: [{ contentIndex: 0, delta: '上一轮' }] });
    // 没有 message_end（异常路径）就开始了新一轮
    await commit({ type: 'agent_start' });
    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await frame({ text: [{ contentIndex: 0, delta: '这一轮' }] });

    const tab = useMessages.getState().tabs[TAB]!;
    expect(tab.ids, '流式行叠加了').toHaveLength(2);
    const [first, second] = tab.ids;
    expect(tab.byId[first!]?.live, '上一轮的行没有落定').toBeUndefined();
    expect(tab.byId[second!]?.live?.[0]?.text).toBe('这一轮');
    expect(text(domContainer()), '上一轮的字被吃掉了').toContain('上一轮');
  });

  it('换窗期间（hasNewer）不建流式行、也不追加消息', async () => {
    await mount([
      { role: 'user', content: [{ type: 'text', text: '旧的一轮' }], timestamp: 1 },
    ]);
    await act(async () => {
      useMessages.getState().hydratePage(
        TAB,
        [{ role: 'user', message: { role: 'user', content: [{ type: 'text', text: '旧的一轮' }], timestamp: 1 }, offset: 0 }] as never[],
        { cursor: 0, hasMore: true, hasNewer: true, end: 10 },
      );
    });
    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await frame({ text: [{ contentIndex: 0, delta: '不该出现' }] });
    await commit(assistant([{ type: 'text', text: '也不该出现' }], 9));

    const tab = useMessages.getState().tabs[TAB]!;
    expect(tab.ids, '换窗期间把新消息塞进了旧窗口').toHaveLength(1);
    expect(text(domContainer()), '换窗期间流式的字漏到了界面上').not.toContain('不该出现');
  });
});
