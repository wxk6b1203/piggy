// @vitest-environment jsdom
/**
 * 会话内提示行（用户 2026-09-25："本会话内的提示，比如重试中这种，不要展示全局，
 * 展示在会话内即可"）。
 *
 * 这份用例盯三件事：
 *
 * ① **位置**：提示行是转录里的一行，而且必须排在**重试之后新起的那条流式行之前**
 *    （它是"正在进行的状态"，不是会话内容 —— 顺序错了读起来就像"重试发生在回答之后"）；
 * ② **去重**：`auto_retry_start` 每次重试都发一遍，转录尾部**只许有一行**；
 * ③ **撤除**：`auto_retry_end` / `compaction_end` / 一轮落定（`agent_settled`）之后
 *    那一行必须消失 —— 留着就是"重试中"的化石。
 *
 * 另一条同样重要：**应用顶部的全局 banner 不许再显示这两个状态**
 * （`AppFrame` 只留启动失败/worker 崩溃那种应用级的事）。
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
import { useAppConfig } from '@/stores/appConfig';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { mountDom, unmountDom, domContainer } from './dom-render';

const TAB = 'tab-notice';
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const rows = (sel: string) => Array.from(domContainer().querySelectorAll(sel));
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function commit(ev: Record<string, unknown>) {
  await act(async () => {
    busListen.get(`pi:commit:${TAB}`)?.({ payload: ev });
    await new Promise((r) => setTimeout(r, 5));
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => ({}));
  useMessages.setState({ tabs: {} });
  useTabs.setState({
    tabs: { [TAB]: { tabId: TAB, sessionFile: '/tmp/notice.jsonl', cwd: '/tmp', workerState: 'ready' } } as never,
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

async function mount(seed: unknown[] = []) {
  useMessages.getState().hydrate(TAB, seed as never[]);
  mountDom(<Transcript tabId={TAB} />);
  await flush();
  await ensureTabListeners(TAB);
}

describe('正在重试模型请求：会话里的一行，且在流式那一行之前', () => {
  it('auto_retry_start 建行、带上 attempt/上限/倒计时，end 撤掉', async () => {
    await mount([
      { role: 'user', content: [{ type: 'text', text: '跑个长任务' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'provider 500',
        timestamp: 2,
      },
    ]);
    await commit({ type: 'agent_start' });
    expect(rows('[data-notice-row]'), '还没重试就不该有提示行').toHaveLength(0);

    await commit({
      type: 'auto_retry_start',
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4000,
      errorMessage: 'provider 500',
    });
    const retry = rows('[data-notice="retry"]');
    expect(retry, '重试开始了却没有会话内的一行').toHaveLength(1);
    expect(
      useTabs.getState().banner,
      '会话级状态又写进全局 banner 了（就是用户要去掉的那条）',
    ).toBeNull();
    expect(text(retry[0])).toContain('正在重试模型请求（2/3）');
    // 倒计时：DSH 口径是"向上取整、最小 1 秒"
    expect(text(retry[0])).toMatch(/· [1-4]s/);
    // 细节：延迟与失败原因（展开可见，但 DOM 里就在）
    const details = retry[0]!.querySelector('[data-notice-details]');
    expect(text(details), '重试细节里没有延迟').toContain('4000ms');
    expect(text(details), '重试细节里没有失败原因').toContain('provider 500');

    // 再加一次重试：**不许堆行**
    await commit({ type: 'auto_retry_start', attempt: 3, maxAttempts: 3, delayMs: 1000, errorMessage: 'provider 500' });
    expect(rows('[data-notice="retry"]'), '第二次重试又堆了一行').toHaveLength(1);
    expect(text(rows('[data-notice="retry"]')[0])).toContain('正在重试模型请求（3/3）');

    /* 位置：重试之后 pi 会重新起一条助手消息 —— 新行必须落在提示行**后面** */
    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await commit(assistantText('这次好了', 3));
    const order = rows('[data-notice-row], .pg-message.pg-assistant').map((el) =>
      el.hasAttribute('data-notice-row') ? 'notice' : 'assistant',
    );
    expect(order.slice(-2), '提示行没有排在新的助手行之前').toEqual(['notice', 'assistant']);

    await commit({ type: 'auto_retry_end', success: true, attempt: 3 });
    expect(rows('[data-notice="retry"]'), '重试结束后提示行还在（化石行）').toHaveLength(0);
  });

  it('一轮落定（agent_settled）会兜底撤掉所有提示行', async () => {
    await mount();
    await commit({ type: 'agent_start' });
    await commit({ type: 'auto_retry_start', attempt: 1, maxAttempts: 3, delayMs: 2000 });
    await commit({ type: 'compaction_start', reason: 'threshold' });
    expect(rows('[data-notice-row]')).toHaveLength(2);
    await commit({ type: 'agent_settled' });
    expect(rows('[data-notice-row]'), '落定后还挂着提示行 —— worker 崩掉时它们会永远留在转录里').toHaveLength(0);
  });
});

describe('扩展报错：转录里看得见（以前是完全不可见）', () => {
  it('extension_error 建一行、同名扩展累计计数、settled 不撤它', async () => {
    await mount();
    await commit({ type: 'agent_start' });
    await commit({
      type: 'extension_error',
      extensionPath: '/Users/x/.pi/agent/extensions/pi-todo/index.ts',
      event: 'tool_call',
      error: 'TypeError: cannot read properties of undefined',
    });
    const row = rows('[data-notice="extension"]');
    expect(row, '扩展报错没有在转录里出现').toHaveLength(1);
    expect(text(row[0])).toContain('扩展报错');
    // 显示的是**目录名**（扩展入口多是 index.ts，只show文件名等于没说清是谁）
    expect(text(row[0]), '没有显示是哪个扩展').toContain('pi-todo');
    expect(row[0]!.getAttribute('data-notice-source'), 'data-notice-source 不是目录名').toBe('pi-todo');
    expect(text(row[0]), '没有显示错误正文').toContain('TypeError');
    expect(row[0]!.querySelector('[data-notice-details]'), '展开看全文的那块不在').toBeTruthy();

    // 同一个扩展连报两次：只累计，不刷屏
    await commit({ type: 'extension_error', extensionPath: '/Users/x/.pi/agent/extensions/pi-todo/index.ts', error: '第二次' });
    expect(rows('[data-notice="extension"]'), '同一个扩展报了两次却堆了两行').toHaveLength(1);
    expect(text(rows('[data-notice="extension"]')[0])).toContain('×2');

    // 另一个扩展：各占一行
    await commit({ type: 'extension_error', extensionPath: '/Users/x/.pi/agent/extensions/other/index.js', error: 'boom' });
    expect(rows('[data-notice="extension"]'), '两个不同扩展的报错应该各占一行').toHaveLength(2);

    // 一轮落定**不**撤它（它是事故记录，不是"正在…"）
    await commit({ type: 'agent_settled' });
    expect(rows('[data-notice="extension"]'), '扩展报错被 agent_settled 撤掉了').toHaveLength(2);
  });
});

describe('正在压缩上下文：与工具行同一套窄行', () => {
  it('compaction_start 建行、compaction_end 撤掉', async () => {
    await mount();
    await commit({ type: 'agent_start' });
    await commit({ type: 'compaction_start', reason: 'threshold' });
    const row = rows('[data-notice="compaction"]');
    expect(row).toHaveLength(1);
    expect(text(row[0]), '压缩提示行的文案没对齐 DSH').toContain('正在压缩…');
    expect(row[0]!.querySelector('[data-disclosure-row]'), '不是窄行（DSH 的压缩提示就是一行命令卡）').toBeTruthy();
    await commit({ type: 'compaction_end', reason: 'threshold' });
    expect(rows('[data-notice="compaction"]')).toHaveLength(0);
  });
});

function assistantText(text: string, timestamp: number) {
  return {
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }], timestamp },
  };
}
