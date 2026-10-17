// @vitest-environment jsdom
/**
 * 输入卡那粒圆形主键的**三态**（DSH `InputBar` 的 `primary`，`InputBar.tsx:303/476`）：
 *
 *   · **停止** —— 这一轮还在跑（`agent_start` → `agent_settled`）**且草稿为空**；
 *   · **入队** —— 还在跑但有草稿（点它是"排队发送"，`streamingBehavior:'followUp'`）；
 *   · **发送** —— 空闲。
 *
 * 起因（2026-10-16 用户实报）："发送出去之后，不是停止键而是置灰的发送键"。
 * 上一版删「转向 / 追加」两粒按钮时，把**中断那粒圆钮一起删了**（只剩 Esc）。
 * 于是流式中草稿一空，主键落进 `disabled={draftEmpty}` 那一支：`data-send-mode`
 * 明明写着 `'stop'`，按下去却什么都不发生 —— 一个**假停止键**。
 *
 * 这份用例钉住的正是"属性写着 stop ≠ 真的能停"：
 *   ① 停止态**必须可用**、必须有 `aria-label="停止"`、点下去真的下发 `pi_abort`；
 *   ② 停止**不动队列**（队列留在 dock 里，一条不少、不调 `pi_clear_queue`）——
 *      这是它与老实现"中断 + 把队列拼回草稿"的分界；
 *   ③ 有草稿时**不许**变成停止键（否则用户打的字会被吞掉，按下去反而把回合停了）；
 *   ④ 工具执行期间（还没有 `message_start`、一个字都没流出来）同样是停止键：
 *      `streaming` 是"这一轮在跑"，不是"正在出字"——长命令跑到一半正是最想停的时候；
 *   ⑤ 停完（`agent_settled`）主键回到灰色发送键，不会停在停止态。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/lib/feedback', () => {
  const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn() };
  return { toast, FeedbackBridge: () => null, confirm: vi.fn() };
});

import { SessionWorkspaceComposer } from '@/features/chat/Composer';
import { useMessages } from '@/stores/messages';
import { useQueue } from '@/stores/queue';
import { domContainer, mountDom, unmountDom } from './dom-render';

const TAB = 't-primary';

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[] = [];
/** mock 的 pi 是否正在跑这一轮（决定 `pi_prompt` 要不要 `streamingBehavior`）。 */
let busy = false;

function installBackend(): void {
  calls = [];
  busy = false;
  invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    calls.push({ cmd: name, args: a });
    if (name === 'pi_prompt') {
      /* 与真机同一句原文（`agent-session.ts:2099`）：流式中不带 streamingBehavior 直接拒。
         不照抄这条的话，"有草稿时点主键"那个用例会绿得毫无意义。 */
      if (busy && a.streamingBehavior !== 'steer' && a.streamingBehavior !== 'followUp') {
        throw new Error(
          "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
        );
      }
      return true;
    }
    if (name === 'pi_get_commands') return { commands: [] };
    return {};
  });
}

const count = (cmd: string): number => calls.filter((c) => c.cmd === cmd).length;
const lastPrompt = (): Call | undefined => [...calls].reverse().find((c) => c.cmd === 'pi_prompt');

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** 直接把 pi 的事件喂进 store（这条路与 `lib/tabEvents` 的接线是同一个入口）。 */
async function commit(ev: { type: string } & Record<string, unknown>): Promise<void> {
  await act(async () => {
    useMessages.getState().applyCommit(TAB, ev);
    await new Promise((r) => setTimeout(r, 0));
  });
}

function textarea(): HTMLTextAreaElement {
  const el = domContainer().querySelector('.pg-composer-input');
  if (!el) throw new Error('找不到输入框');
  return el as HTMLTextAreaElement;
}

async function type(value: string): Promise<void> {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function click(sel: string): Promise<HTMLButtonElement> {
  const el = domContainer().querySelector(sel) as HTMLButtonElement | null;
  if (!el) throw new Error(`找不到 ${sel}`);
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await flush();
  return el;
}

function sendBtn(): HTMLButtonElement {
  const el = domContainer().querySelector('.pg-send-btn');
  if (!el) throw new Error('找不到主键');
  return el as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  installBackend();
  useQueue.setState({ tabs: {} });
  useMessages.setState({ tabs: {} });
  useMessages.getState().ensure(TAB);
  mountDom(<SessionWorkspaceComposer tabId={TAB} />);
});

afterEach(async () => {
  await unmountDom();
});

describe('主键三态（DSH primaryStops）', () => {
  it('运行中 + 草稿空 → 是**可用的**停止键，点下去真的下发 pi_abort', async () => {
    busy = true;
    await commit({ type: 'agent_start' });

    const btn = sendBtn();
    expect(btn.getAttribute('data-send-mode')).toBe('stop');
    expect(btn.disabled, '停止键必须是可点的 —— 正在跑就一定有东西可停').toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('停止');
    // 停止字形是实心圆角方块（不是发送键的箭头）
    expect(btn.querySelector('svg rect'), '停止态该画方块而不是箭头').not.toBeNull();
    expect(btn.querySelector('.codicon-arrow-up')).toBeNull();

    await click('.pg-send-btn');

    expect(count('pi_abort'), '点了停止却什么都没发出去').toBe(1);
    expect(count('pi_prompt'), '停止键不该顺手发消息').toBe(0);
  });

  it('停止**不动队列**：排着的消息一条不少，也不调 pi_clear_queue', async () => {
    busy = true;
    await commit({ type: 'agent_start' });
    await type('先记一下这个想法');
    // 运行中 ↵ = 入队（`followUp`），草稿随之清空 → 主键变回停止键
    await act(async () => {
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    await flush();
    expect(lastPrompt()?.args.streamingBehavior).toBe('followUp');
    expect(useQueue.getState().tabs[TAB]?.rows.map((r) => r.text)).toEqual(['先记一下这个想法']);

    await click('.pg-send-btn');

    expect(count('pi_abort')).toBe(1);
    expect(count('pi_clear_queue'), '停止只中断这一轮，不许把队列一起清掉').toBe(0);
    expect(useQueue.getState().tabs[TAB]?.rows.map((r) => r.text)).toEqual(['先记一下这个想法']);
    expect(domContainer().textContent, '队列那一行该还在 dock 里').toContain('先记一下这个想法');
  });

  it('运行中 + 有草稿 → 仍是发送键（入队），不许吞掉用户打的字', async () => {
    busy = true;
    await commit({ type: 'agent_start' });
    await type('插一句');

    const btn = sendBtn();
    expect(btn.getAttribute('data-send-mode')).toBe('queue');
    expect(btn.disabled).toBe(false);
    expect(btn.getAttribute('aria-label'), '读屏听到的必须是"排队"，不是"发送"').toBe('排队发送');
    expect(btn.querySelector('svg rect'), '有草稿时不该画停止方块').toBeNull();

    await click('.pg-send-btn');

    expect(count('pi_abort'), '有草稿时点主键不该中断回合').toBe(0);
    expect(lastPrompt()?.args.streamingBehavior).toBe('followUp');
    expect(textarea().value, '发出去之后草稿要清空').toBe('');
  });

  it('工具执行期间（还没出字）同样是停止键：长命令跑到一半也能停', async () => {
    busy = true;
    await commit({ type: 'agent_start' });
    await commit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'bash' });
    expect(useMessages.getState().tabs[TAB]?.streaming, '前置条件：这一轮还在跑').toBe(true);

    const btn = sendBtn();
    expect(btn.getAttribute('data-send-mode')).toBe('stop');
    expect(btn.disabled).toBe(false);
  });

  it('空闲 + 草稿空 → 灰色发送键（点不动、也不发任何命令）', async () => {
    const btn = sendBtn();
    expect(btn.getAttribute('data-send-mode')).toBe('send');
    expect(btn.disabled).toBe(true);
    /* 挂载时组件自己会拉几条查询（commands/state 之类），所以比的是"点之前 → 点之后"，
       不是绝对条数 —— 否则这条用例测的是"挂载有没有发命令"。 */
    const before = calls.length;
    await click('.pg-send-btn');
    expect(calls.slice(before), '灰键不该发出任何命令').toHaveLength(0);
  });

  it('停完落定 → 主键回到灰色发送键，不会停在停止态', async () => {
    busy = true;
    await commit({ type: 'agent_start' });
    await click('.pg-send-btn');
    expect(count('pi_abort')).toBe(1);

    busy = false;
    await commit({ type: 'agent_settled', aborted: true });

    const btn = sendBtn();
    expect(btn.getAttribute('data-send-mode')).toBe('send');
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('发送');
  });
});
