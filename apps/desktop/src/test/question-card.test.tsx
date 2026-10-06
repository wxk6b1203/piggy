// @vitest-environment jsdom
/**
 * 提问卡（docs/06 §7，对标 DSH 的 `ask_user_question`）。
 *
 * 这一份用例钉的是**通道与卡片**这两件事：
 *  - 信封：`piggy:ask:v1:<toolCallId>` 的 select 被认领、**不弹**普通选择框；
 *    不带信封的 select 照旧走弹出对话框（不许把别人的请求吞了）；
 *  - 卡片：问题/选项/多选/自由文本都在，提交把回答按契约送回 `ui_reply`；
 *  - 答完只读：工具结果到了之后卡片变成问答记录，不再可点；
 *  - 请求没了（中断/一轮结束）→ 卡片退回只读并说清原因，不留一个点了没反应的提交按钮。
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
    getTotalSize: () => count * 120,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, key: getItemKey(index), start: index * 120, size: 120 })),
    getOffsetForIndex: (index: number) => [index * 120] as const,
    measureElement: () => {},
    measure: () => {},
    scrollRect: { width: 0, height: 400 },
    scrollToIndex: vi.fn(),
  }),
}));

import { Transcript } from '@/features/chat/Transcript';
import { ASK_TITLE_PREFIX, parseAskTitle } from '@/lib/questionChannel';
import { ensureTabListeners } from '@/lib/tabEvents';
import { useAppConfig } from '@/stores/appConfig';
import { useDialogs } from '@/stores/dialogs';
import { useMessages } from '@/stores/messages';
import { useQuestions } from '@/stores/questions';
import { useTabs } from '@/stores/tabs';
import { mountDom, unmountDom, domContainer } from './dom-render';

const TAB = 'tab-ask';
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const q = (sel: string) => domContainer().querySelector(sel);
const qa = (sel: string) => Array.from(domContainer().querySelectorAll(sel));
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** 灌一条"模型调了 ask_user_question"的助手消息 + 工具结果（可选）。 */
function seedAsk(callId: string, withResult = false) {
  const rows: unknown[] = [
    { role: 'user', content: [{ type: 'text', text: '帮我改一下' }], timestamp: 1 },
    {
      role: 'assistant',
      content: [
        {
          type: 'toolCall',
          id: callId,
          name: 'ask_user_question',
          arguments: {
            questions: [
              {
                id: 'db',
                header: '数据来源',
                question: '用哪个库？',
                options: [
                  { label: '生产库', description: '真实数据，只读' },
                  { label: '测试库' },
                ],
              },
              {
                id: 'files',
                question: '还要改哪些文件？',
                multiSelect: true,
                options: [{ label: 'src/a.ts' }, { label: 'src/b.ts' }],
              },
            ],
          },
        },
      ],
      timestamp: 2,
    },
  ];
  if (withResult) {
    rows.push({
      role: 'toolResult',
      toolCallId: callId,
      toolName: 'ask_user_question',
      content: [{ type: 'text', text: '用户回答了：\n- 数据来源：生产库' }],
      timestamp: 3,
    });
  }
  return rows;
}

async function mount(rows: unknown[]) {
  useMessages.getState().hydrate(TAB, rows as never[]);
  mountDom(<Transcript tabId={TAB} />);
  await flush();
  await ensureTabListeners(TAB);
}

const emit = async (channel: string, payload: unknown) => {
  await act(async () => {
    busListen.get(channel)?.({ payload });
    await new Promise((r) => setTimeout(r, 5));
  });
};

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => ({}));
  localStorage.clear();
  useMessages.setState({ tabs: {} });
  useDialogs.setState({ current: null, queue: [] });
  useQuestions.setState({ pending: {} });
  useTabs.setState({
    tabs: { [TAB]: { tabId: TAB, sessionFile: '/tmp/ask.jsonl', cwd: '/tmp', workerState: 'ready' } } as never,
    order: [TAB],
    activeTabId: TAB,
    unread: {},
    banner: null,
  });
  useAppConfig.setState({ railPlacement: 'off', transcriptDetail: 'verbose', loaded: true });
});
afterEach(async () => {
  await unmountDom();
});

describe('信封', () => {
  it('只认带前缀的 select；别的一律照旧弹对话框', async () => {
    expect(parseAskTitle(`${ASK_TITLE_PREFIX}call-1`)).toBe('call-1');
    expect(parseAskTitle('随便一个标题')).toBeNull();
    expect(parseAskTitle(`${ASK_TITLE_PREFIX}  `)).toBeNull();
    expect(parseAskTitle(undefined)).toBeNull();

    await mount(seedAsk('call-1'));
    await emit(`pi:ui-req:${TAB}`, {
      type: 'extension_ui_request',
      id: 'req-ask',
      method: 'select',
      title: `${ASK_TITLE_PREFIX}call-1`,
      options: ['提交'],
    });
    expect(useQuestions.getState().pending['call-1']?.requestId, '带前缀的请求没被登记').toBe('req-ask');
    expect(useDialogs.getState().current, '提问卡不该再弹普通选择框').toBeNull();

    await emit(`pi:ui-req:${TAB}`, {
      type: 'extension_ui_request',
      id: 'req-other',
      method: 'select',
      title: '别的东西',
      options: ['A', 'B'],
    });
    expect(useDialogs.getState().current?.id, '不带前缀的 select 必须照旧弹出').toBe('req-other');
  });
});

describe('卡片', () => {
  it('问题、选项、多选、自由文本都在；提交把回答按契约送回', async () => {
    await mount(seedAsk('call-1'));
    await emit(`pi:ui-req:${TAB}`, {
      type: 'extension_ui_request',
      id: 'req-ask',
      method: 'select',
      title: `${ASK_TITLE_PREFIX}call-1`,
      options: ['提交'],
    });
    const card = q('[data-question-card]');
    expect(card, '卡片没有渲染').toBeTruthy();
    expect(qa('[data-question]')).toHaveLength(2);
    expect(text(q('[data-question="db"] .pg-qcard-header'))).toBe('数据来源');
    expect(text(q('[data-question="db"] .pg-qcard-text'))).toBe('用哪个库？');
    expect(qa('[data-question="db"] [data-option]')).toHaveLength(2);
    expect(text(q('[data-question="files"] .pg-qcard-multi'))).toBe('可多选');

    // 选一个选项 + 勾两个多选 + 写一段自由文本
    await act(async () => {
      (q('[data-question="db"] [data-option="生产库"]') as HTMLElement).click();
      (q('[data-question="files"] [data-option="src/a.ts"]') as HTMLElement).click();
      (q('[data-question="files"] [data-option="src/b.ts"]') as HTMLElement).click();
    });
    /* 受控输入要**走原生 setter**再派发事件：直接改 `el.value` 时 React 的值追踪器
       看不到变化（本仓其它用例同一写法，见 fleet-view.test.tsx）。 */
    const custom = q('[data-question-custom="db"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(custom, '只看不改');
      custom.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await flush();
    await act(async () => {
      (qa('.pg-qcard-actions .pg-btn')[0] as HTMLElement).click();
      await new Promise((r) => setTimeout(r, 30));
    });

    const reply = invokeMock.mock.calls.find((c) => c[0] === 'ui_reply');
    expect(reply, '没有发出 ui_reply').toBeTruthy();
    const payload = (reply![1] as { response: { id: string; value: string } }).response;
    expect(payload.id, '回答必须回到那个待答请求上').toBe('req-ask');
    const parsed = JSON.parse(payload.value) as { answers: Array<{ id: string; selected: string[]; custom: string }> };
    expect(parsed.answers).toEqual([
      { id: 'db', selected: ['生产库'], custom: '只看不改' },
      { id: 'files', selected: ['src/a.ts', 'src/b.ts'], custom: '' },
    ]);
    // 提交之后不再挂着（否则卡片会一直可点）
    expect(useQuestions.getState().pending['call-1']).toBeUndefined();
  });

  it('答完变只读：显示用户回答，不再有提交按钮', async () => {
    await mount(seedAsk('call-1', true));
    const card = q('[data-question-card]');
    expect(card, '答完的卡片应当仍然在转录里（它是问答记录）').toBeTruthy();
    expect(card!.getAttribute('data-answered')).toBe('');
    expect(text(card)).toContain('已回答');
    expect(text(q('.pg-qcard-result'))).toContain('生产库');
    expect(q('.pg-qcard-actions'), '答完还留着提交按钮').toBeNull();
    // 选项变只读
    expect((q('[data-question="db"] [data-option="生产库"]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('请求没了（中断/超时）→ 退回只读并说明原因', async () => {
    await mount(seedAsk('call-1'));
    await emit(`pi:ui-req:${TAB}`, {
      type: 'extension_ui_request',
      id: 'req-ask',
      method: 'select',
      title: `${ASK_TITLE_PREFIX}call-1`,
      options: ['提交'],
    });
    expect(q('.pg-qcard-actions')).toBeTruthy();

    // 一轮落定：待答请求被清掉（`tabEvents` 在 agent_settled 时清）
    await act(async () => {
      useMessages.getState().applyCommit(TAB, { type: 'agent_settled' });
      await new Promise((r) => setTimeout(r, 20));
    });
    await emit(`pi:commit:${TAB}`, { type: 'agent_settled' });
    expect(useQuestions.getState().pending['call-1'], '落定之后不该还挂着待答请求').toBeUndefined();
    expect(q('.pg-qcard-actions'), '请求没了还留着提交按钮（点了没有去处）').toBeNull();
    expect(q('[data-question-stale]'), '没有告诉用户为什么不能答').toBeTruthy();
  });

  it('计划审批：一张卡 + 方案全文（纯文本，不当 markdown 渲）', async () => {
    useMessages.getState().hydrate(TAB, [
      { role: 'user', content: [{ type: 'text', text: '规划一下' }], timestamp: 1 },
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'plan-1',
            name: 'exit_plan_mode',
            arguments: { plan: '# 方案\n\n1. 先做 A\n2. 再做 B' },
          },
        ],
        timestamp: 2,
      },
    ] as never[]);
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    await ensureTabListeners(TAB);
    await emit(`pi:ui-req:${TAB}`, {
      type: 'extension_ui_request',
      id: 'req-plan',
      method: 'select',
      title: `${ASK_TITLE_PREFIX}plan-1`,
      options: ['提交'],
    });
    const card = q('[data-question-card]');
    expect(card!.getAttribute('data-tool')).toBe('exit_plan_mode');
    expect(text(q('[data-question-plan]'))).toContain('# 方案');
    expect(q('[data-question-plan] .pg-qcard-plan-body')?.tagName).toBe('PRE');
    expect(qa('[data-question="review"] [data-option]').map((b) => b.getAttribute('data-option'))).toEqual([
      '批准',
      '继续规划',
    ]);
  });
});
