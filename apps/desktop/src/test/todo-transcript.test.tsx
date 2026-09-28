// @vitest-environment jsdom
/**
 * 任务清单在**转录里的接线**（不只是组件本身）。
 *
 * 为什么单独一条：`TodoRow` 的差异对比要拿到"**这一行之前**的那份清单"
 * （DSH 的 `todoHistory`），而这份基线的键是**工具调用 id**（`callId`），
 * 不是 store 的行 id。查错了不会报错 —— 每一行都会安静地显示成「首次记录」，
 * 属于最难发现的那类错。所以这里端到端跑一遍：两行 `todo_write`，第二行必须比出变化。
 *
 * 顺带钉住"没探测到插件时不出现 todo 界面"这条能力闸门在**转录层**也成立。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  FeedbackBridge: () => null,
  confirm: vi.fn(),
}));
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
    measureElement: () => {},
    scrollToIndex: vi.fn(),
  }),
}));

import { Transcript } from '@/features/chat/Transcript';
import { useAppConfig } from '@/stores/appConfig';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { useTodo } from '@/stores/todo';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const qa = <T extends Element>(sel: string) => [...domContainer().querySelectorAll<T>(sel)];
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

const TAB = 'tab-todo';
const FILE = '/tmp/todo-session.jsonl';

type Item = { content: string; status: 'pending' | 'in_progress' | 'completed' };

/** 一条助手消息，带一次 `todo_write` 调用。 */
const writeCall = (ts: number, callId: string, todos: Item[]) => ({
  role: 'assistant' as const,
  timestamp: ts,
  content: [{ type: 'toolCall', id: callId, name: 'todo_write', arguments: { todos } }],
});

/** 相应的工具结果行。 */
const writeResult = (ts: number, callId: string, text: string) => ({
  role: 'toolResult' as const,
  timestamp: ts,
  toolName: 'todo_write',
  toolCallId: callId,
  content: [{ type: 'text', text }],
  isError: false,
});

/** 两次写入：第二份把第一条标完成、第三条换成新的。 */
function seedTwoWrites() {
  useMessages.getState().hydratePage(
    TAB,
    [
      { role: 'user', message: { role: 'user', timestamp: 1, content: [{ type: 'text', text: '做三件事' }] } },
      { role: 'assistant', message: writeCall(2, 'c1', [
        { content: '一', status: 'pending' },
        { content: '二', status: 'pending' },
        { content: '三', status: 'pending' },
      ]) },
      { role: 'toolResult', message: writeResult(3, 'c1', 'Updated todo list: 2 pending, 1 in progress, 0 completed.') },
      { role: 'assistant', message: writeCall(4, 'c2', [
        { content: '一', status: 'completed' },
        { content: '二', status: 'in_progress' },
        { content: '四', status: 'pending' },
      ]) },
      { role: 'toolResult', message: writeResult(5, 'c2', 'Updated todo list: 1 pending, 1 in progress, 1 completed.') },
    ] as never[],
    { cursor: null, hasMore: false },
  );
}

function setCapability(supported: boolean) {
  useTodo.setState({
    capability: supported
      ? {
          capability: 'todo',
          label: '任务清单',
          markers: ['todo_write'],
          detected: true,
          supported: true,
          plugin: null,
          disabled: [],
          considered: 1,
          problems: [],
        }
      : null,
    tabs: {},
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => ({}));
  useMessages.setState({ tabs: {} });
  useTabs.setState({
    tabs: { [TAB]: { tabId: TAB, sessionFile: FILE, cwd: '/tmp', workerState: 'ready' } } as never,
    order: [TAB],
    activeTabId: TAB,
    unread: {},
    banner: null,
  });
  useAppConfig.setState({ railPlacement: 'off', loaded: true });
  setCapability(true);
});

afterEach(async () => {
  await unmountDom();
});

describe('转录里的清单行', () => {
  it('两次写入：第一行「首次记录」，第二行比出真实变化（基线按 callId 配对）', async () => {
    seedTwoWrites();
    mountDom(<Transcript tabId={TAB} />);
    await flush();

    const rows = qa('[data-todo-row]');
    expect(rows.length).toBe(2);

    // 第一行：没有可比对象 → 没有差异徽标
    expect(rows[0]!.querySelector('[data-todo-diff]')).toBeNull();

    // 第二行：一（pending→completed）与二（pending→in_progress）都算更新，四新增、三移除
    const diff = rows[1]!.querySelector('[data-todo-diff]');
    expect(diff, '第二行没有差异摘要 —— 基线多半查错了键').not.toBeNull();
    expect(diff!.textContent).toBe('新增 1 · 更新 2 · 移除 1');

    // 展开第二行：变化标记逐条对得上
    await click(rows[1]!.querySelector('[data-disclosure-row]')!);
    await flush();
    // 三条当前条目 + 一条被移除的（整表替换下"消失"也要看得见）
    const items = [...rows[1]!.querySelectorAll('.pg-todo-item')];
    expect(items.map((i) => i.getAttribute('data-change'))).toEqual(['updated', 'updated', 'added', 'removed']);
    expect(rows[1]!.querySelector('[data-todo-caption]')!.textContent).toContain('与上次清单相比');
  });

  it('没探测到插件 → 转录里没有清单行（退回通用工具行）', async () => {
    setCapability(false);
    seedTwoWrites();
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    expect(qa('[data-todo-row]').length).toBe(0);
    const generic = qa('[data-tool-row]').filter((r) => r.getAttribute('data-tool') === 'todo_write');
    expect(generic.length).toBe(2);
  });
});
