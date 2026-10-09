// @vitest-environment jsdom
/**
 * **一轮的落地信号**（docs/15 §4 那条缺口，2026-09-25 修）。
 *
 * 现场（探针实测，写在缺口里很久了）：`streamFor(...)` 跑到一半 → `pi:state` 报 `crashed`
 * —— 崩了之后 `streaming` **仍是 true**、实时行还挂着、"停止"按钮仍然可用。
 * 界面假装还在跑，而那个能把这一轮落地的 `message_end` 永远不会来。
 *
 * 这份用例钉四条：
 *   ① 崩 / 休眠 → 这一轮落地成一条**「已中止」**的消息，已流出的字一个不丢；
 *   ② `streaming` 归假（"停止"按钮、状态行、实时闪烁都靠它）；
 *   ③ 一个字都没流出来时**不留空行**（空白助手消息只会让人以为界面坏了）；
 *   ④ `piggy:resync` 先丢掉这些"中断行"再灌权威条目 —— 它们不在会话文件里
 *      （pi 只在 `message_end` 落盘），留着就会与文件里那一轮的真身**重复成两行**。
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
import { useQuestions } from '@/stores/questions';
import { useTabs } from '@/stores/tabs';
import { mountDom, unmountDom, domContainer } from './dom-render';

const TAB = 'tab-interrupt';
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const rows = (sel: string) => Array.from(domContainer().querySelectorAll(sel));
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

async function channel(name: string, payload: unknown) {
  await act(async () => {
    busListen.get(name)?.({ payload });
    await new Promise((r) => setTimeout(r, 5));
  });
}
const commit = (ev: Record<string, unknown>) => channel(`pi:commit:${TAB}`, ev);
const frame = (f: Record<string, unknown>) => channel(`pi:frame:${TAB}`, f);
const state = (st: Record<string, unknown>) => channel(`pi:state:${TAB}`, st);

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => ({}));
  useMessages.setState({ tabs: {} });
  useTabs.setState({
    tabs: { [TAB]: { tabId: TAB, sessionFile: '/tmp/interrupt.jsonl', cwd: '/tmp', workerState: 'ready' } } as never,
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

async function mount() {
  useMessages.getState().hydrate(TAB, []);
  mountDom(<Transcript tabId={TAB} />);
  await flush();
  await ensureTabListeners(TAB);
}

const tab = () => useMessages.getState().tabs[TAB]!;
const assistantRows = () => tab().ids.filter((id) => tab().byId[id]?.role === 'assistant');

/** 造一轮"正在流"：message_start + 若干帧（正文与工具参数各一）。 */
async function startStreamingTurn() {
  await commit({ type: 'agent_start' });
  await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
  await frame({ text: [{ contentIndex: 0, delta: '已经流出来的半截正文' }] });
  await frame({ signals: [{ type: 'toolcall_start', contentIndex: 1, id: 'call-1', toolName: 'bash' }] });
  await frame({ toolArgs: [{ contentIndex: 1, delta: '{"command":"pnpm test"}' }] });
}

describe('worker 崩/休眠：这一轮当场落地', () => {
  it('崩溃 → streaming 归假 + 一条「已中止」的行，已流出的内容不丢', async () => {
    await mount();
    await startStreamingTurn();
    expect(tab().streaming, '前置条件：这时应当在流式').toBe(true);
    expect(rows('[data-streaming]'), '前置条件：应当有流式标记').toHaveLength(1);

    await state({ state: 'crashed' });

    expect(tab().streaming, '崩溃后 streaming 仍是 true（界面假装还在跑）').toBe(false);
    expect(rows('[data-streaming]'), '崩溃后流式标记还挂着').toHaveLength(0);
    const ids = assistantRows();
    expect(ids, '崩溃后没有落地成一行助手消息').toHaveLength(1);
    const row = tab().byId[ids[0]!]!;
    expect(row.interrupted, '落地行没打 interrupted 标记（resync 就没法去重）').toBe(true);
    expect((row.message as { stopReason?: string }).stopReason).toBe('aborted');
    // 内容一个字都不丢：正文与工具调用都在那条消息里
    const content = (row.message as { content?: Array<{ type?: string; text?: string; name?: string }> }).content!;
    expect(content.some((b) => b.type === 'text' && b.text === '已经流出来的半截正文')).toBe(true);
    expect(content.some((b) => b.type === 'toolCall' && b.name === 'bash')).toBe(true);
    // 界面：失败回合卡片（已中止）+ 内容都在
    const wrap = domContainer();
    expect(text(wrap.querySelector('.pg-turn-failure[data-kind="aborted"]')), '没画出「已中止」').toContain('已中止');
    expect(text(wrap), '已流出的正文丢了').toContain('已经流出来的半截正文');
  });

  it('休眠（空闲回收）走同一条路', async () => {
    await mount();
    await startStreamingTurn();
    await state({ state: 'sleeping' });
    expect(tab().streaming).toBe(false);
    expect(assistantRows(), '休眠没有落地这一轮').toHaveLength(1);
    expect(tab().byId[assistantRows()[0]!]!.interrupted).toBe(true);
  });

  /* 2026-10-09 补：崩/睡时**待答提问也要清掉**（与 `agent_settled` 那支对称）。
     留着卡片的后果不是"多一个控件"：点提交时 Rust 侧的 `ui_reply` 会按需复活一个
     新 worker，而新进程从来没发过那个 `extension_ui_request` id ——
     回答被静默吞掉，用户看到的是"点了没反应"。 */
  it('崩溃时把待答提问一起清掉（否则回答会被新进程静默吞掉）', async () => {
    await mount();
    await commit({ type: 'agent_start' });
    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    // 一条挂着信封的 select：pi-ask 的提问卡
    await channel(`pi:ui-req:${TAB}`, {
      id: 'req-1',
      method: 'select',
      title: 'piggy:ask:v1:call-1',
      options: ['提交'],
    });
    expect(useQuestions.getState().get('call-1'), '前置条件：提问卡应当挂上了').toBeTruthy();

    await channel(`pi:state:${TAB}`, { state: 'crashed' });
    expect(useQuestions.getState().get('call-1'), '崩溃后提问卡还挂着 —— 点提交只会得到沉默').toBeFalsy();

    // 休眠同理
    await channel(`pi:ui-req:${TAB}`, {
      id: 'req-2',
      method: 'select',
      title: 'piggy:ask:v1:call-2',
      options: ['提交'],
    });
    await channel(`pi:state:${TAB}`, { state: 'sleeping' });
    expect(useQuestions.getState().get('call-2'), '休眠后提问卡还挂着').toBeFalsy();
  });

  it('一个字都没流出来 → 不留空行', async () => {
    await mount();
    await commit({ type: 'agent_start' });
    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await state({ state: 'crashed' });
    expect(tab().streaming).toBe(false);
    expect(assistantRows(), '空白的一轮留下了空行（用户只会以为界面坏了）').toHaveLength(0);
    expect(rows('.pg-message.pg-assistant')).toHaveLength(0);
  });

  it('一轮落定却没有 message_end → 同样落地（不转圈）', async () => {
    await mount();
    await startStreamingTurn();
    await commit({ type: 'agent_settled' });
    expect(tab().streaming).toBe(false);
    expect(assistantRows()).toHaveLength(1);
    expect(tab().byId[assistantRows()[0]!]!.interrupted).toBe(true);
  });
});

describe('pi 启动就失败：stderr 里那句真话要看得见', () => {
  it('crashed + stderrTail → 转录里有一行（此前前端一个字段都不读）', async () => {
    await mount();
    await state({
      state: 'crashed',
      exitCode: 1,
      stderrTail: 'Error: Failed to load extension "/tmp/piask-copy": Tool "ask_user_question" conflicts with …',
    });
    const row = rows('[data-notice="extension"]');
    expect(row, '启动失败的原因没有出现在转录里').toHaveLength(1);
    expect(text(row[0])).toContain('pi 启动/运行失败');
    expect(text(row[0]), '没有把 pi 说的那句真话带出来').toContain('conflicts with');
  });
});

describe('resync：中断行先丢再灌（不与文件里的真身重复）', () => {
  it('权威条目回来时，中断行被丢掉', async () => {
    await mount();
    await startStreamingTurn();
    await state({ state: 'crashed' });
    expect(assistantRows(), '前置条件：崩溃后应当有一行中断行').toHaveLength(1);

    // worker 醒来：resync 按会话文件补齐（这里模拟文件里那一轮**不存在**——
    // 因为它没落盘；所以只有 user 行回来）
    await commit({
      type: 'piggy:resync',
      entries: [{ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '你好' }], timestamp: 1 } }],
      leafId: 'e1',
    });
    expect(assistantRows(), 'resync 之后中断行还在（会与文件里的真身重复）').toHaveLength(0);
    expect(tab().ids.filter((id) => tab().byId[id]?.role === 'user')).toHaveLength(1);

    // 文件里确实有那一轮：只留权威那一行
    await startStreamingTurn();
    await state({ state: 'crashed' });
    await commit({
      type: 'piggy:resync',
      entries: [
        {
          type: 'message',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: '已经流出来的半截正文' }],
            timestamp: 2,
          },
        },
      ],
      leafId: 'e2',
    });
    expect(assistantRows(), '文件里的权威行与中断行同时存在').toHaveLength(1);
    expect(tab().byId[assistantRows()[0]!]!.interrupted, '留下的是中断行而不是权威行').toBeUndefined();
  });
});
