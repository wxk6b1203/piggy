// @vitest-environment jsdom
/**
 * 会话等待队列（`stores/queue.ts` + `features/chat/QueueDock.tsx`，docs/04 §7.3）。
 *
 * 起因（2026-10-15 用户截图）：流式中按回车**什么也不发生**，队列只有一行灰字，
 * 既不能编也不能删，Esc 还会把"中断"和"取回"绑在一起。
 *
 * ## 这个文件里的 mock 后端**真的维护 pi 那份队列**
 *
 * `pi_prompt` 带 `streamingBehavior` → 推进 mock 的队列并推 `queue_update`；
 * `pi_clear_queue` → 清空并**返回被清掉的那批**（真机 `agent-session.ts:2427` 就是这个语义）。
 * 为什么不图省事直接"返回影子里的东西"：那样测试就在**自己验证自己** ——
 * `clear_queue` 返回什么由影子决定，于是"对不上账的行不许重建"这类用例会永远绿。
 * 这里的 mock 队列只由**真的发出去的 `pi_prompt`** 驱动，与影子是两个独立的东西。
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
import { toast } from '@/lib/feedback';
import { useMessages } from '@/stores/messages';
import { useQueue, reconcileRows, type QueueRow } from '@/stores/queue';
import { applyCommitEvent } from '@/lib/tabEvents';
import { domContainer, mountDom, unmountDom } from './dom-render';

const TAB = 't-queue';

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[] = [];
/** **mock 的 pi 队列**：只由真的发出去的 `pi_prompt` 驱动（不含影子里的任何东西）。 */
let piQueue: { steering: string[]; followUp: string[] };
/** 哪些 tab 正在"流式"（决定 pi_prompt 是入队还是起一轮）。 */
let streamingTabs: Set<string>;

/** 把一条 `pi:commit` 事件喂进**生产接线**（`lib/tabEvents.applyCommitEvent`）。 */
function emit(tabId: string, payload: Record<string, unknown>): void {
  act(() => {
    /* ⚠️ 必须走生产那个函数，不要在这里再抄一遍"applyCommit → 取文本 → reconcile"。
       抄一遍的话，生产哪天换了 `delivered` 的口径，这 31 条仍然会绿（测试在验证自己）。 */
    applyCommitEvent(tabId, payload as { type: string });
  });
  // `queue_update` 的对账发生在 `applyCommitEvent` 里；`piQueue` 只是**构造事件**用的，
  // 不再是"影子从哪读快照"的第二个来源。
}

function installBackend(): void {
  calls = [];
  piQueue = { steering: [], followUp: [] };
  streamingTabs = new Set();
  invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    calls.push({ cmd: name, args: a });
    if (name === 'pi_prompt') {
      const text = String(a.message ?? '');
      /* 会话"忙"的判据与真机一致：`isStreaming`。测试里只要有一条还没被消费的队列行，
         这一轮就还没结束 —— 否则"入队 → 立刻算落定"会把刚排的队自己吃掉。 */
      const busy = streamingTabs.has(TAB) || piQueue.steering.length > 0 || piQueue.followUp.length > 0;
      if (busy) {
        // 真机：流式中不带 streamingBehavior 直接报错（`agent-session.ts:2099` 的原文）
        const behavior = a.streamingBehavior;
        if (behavior !== 'steer' && behavior !== 'followUp') {
          throw new Error(
            "Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
          );
        }
        const target = behavior === 'steer' ? 'steering' : 'followUp';
        /* 真机顺序：先把消息塞进 agent 队列，等步进边界真的**消费**它时才进转录、
           `queue_update` 才去掉它。测试里把"消费"压缩到入队那一刻会很别扭，
           所以这里只推队列快照（消费由 `settle()`/`deliverUser()` 显式驱动）。 */
        piQueue[target].push(text);
        emit(TAB, {
          type: 'queue_update',
          steering: [...piQueue.steering],
          followUp: [...piQueue.followUp],
        });
        return true;
      }
      /* 空闲直发：真机**直接起一轮**（`disposition:'started'`），队列里什么都不加。
         这里只推到"用户消息已进转录"，助手那半边与本文件无关。 */
      streamingTabs.add(TAB);
      emit(TAB, { type: 'agent_start' });
      emit(TAB, { type: 'message_start', message: { role: 'user', content: text } });
      emit(TAB, { type: 'message_end', message: { role: 'user', content: text } });
      return true;
    }
    if (name === 'pi_clear_queue') {
      /* ⚠️ **就地清空**，不要重新赋值 `piQueue` —— 外面那些 `piQueue.followUp` 断言
         拿的是同一个对象的引用；整对象换掉之后它们读到的还是旧数组（实测表现：
         "取回之后 pi 队列看着还有东西"，把人往错的方向带）。 */
      const cleared = { steering: [...piQueue.steering], followUp: [...piQueue.followUp] };
      piQueue.steering.length = 0;
      piQueue.followUp.length = 0;
      emit(TAB, { type: 'queue_update', steering: [], followUp: [] });
      return cleared;
    }
    if (name === 'pi_abort') {
      streamingTabs.delete(TAB);
      return null;
    }
    if (name === 'pi_get_commands') return { commands: [] };
    return {};
  });
}

function prompts(): Call[] {
  return calls.filter((c) => c.cmd === 'pi_prompt');
}

/** 最后一次下发（"刚才那个手势到底发了什么"要看它，不是看队列里第一条）。 */
function lastPrompt(): Call {
  const all = prompts();
  const last = all[all.length - 1];
  if (!last) throw new Error('一个 pi_prompt 都没发出去');
  return last;
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function setStreaming(on: boolean): void {
  if (on) streamingTabs.add(TAB);
  else streamingTabs.delete(TAB);
  emit(TAB, { type: on ? 'agent_start' : 'agent_settled', aborted: false });
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

async function press(key: string, mods: { meta?: boolean; shift?: boolean } = {}): Promise<void> {
  await act(async () => {
    textarea().dispatchEvent(
      new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        metaKey: mods.meta ?? false,
        shiftKey: mods.shift ?? false,
      }),
    );
    await Promise.resolve();
  });
  await flush();
}

/** 往"编辑排队消息"那个 textarea 里打字。 */
async function typeEdit(value: string): Promise<void> {
  const el = domContainer().querySelector('.pg-queue-edit') as HTMLTextAreaElement | null;
  if (!el) throw new Error('找不到编辑框');
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

async function click(sel: string, index = 0): Promise<void> {
  const el = domContainer().querySelectorAll(sel)[index] as HTMLElement | undefined;
  if (!el) throw new Error(`找不到 ${sel}[${index}]`);
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  await flush();
}

const byData = (sel: string): Element[] => [...domContainer().querySelectorAll(sel)];
const rowTexts = (): string[] => (useQueue.getState().tabs[TAB]?.rows ?? []).map((r) => r.text);
const pausedTexts = (): string[] => (useQueue.getState().tabs[TAB]?.paused ?? []).map((r) => r.text);
const paused = (): QueueRow[] => useQueue.getState().tabs[TAB]?.paused ?? [];

/** 这一轮跑完（`agent_settled`）：`settled()` 会摘掉 steering 行、清掉 stream 标志。 */
function settle(): void {
  setStreaming(false);
}

/** 走真实入口排队（`⌘↵` 是插话，所以追加要用 `↵` / `⌘⇧↵`）。 */
async function enqueueVia(text: string, mods: { meta?: boolean; shift?: boolean } = {}): Promise<void> {
  await type(text);
  await press('Enter', mods);
}

beforeEach(() => {
  /* ⚠️ 顺序要紧：`vi.clearAllMocks()` **会连 mock 的实现一起清掉**，
     放在 `installBackend()` 之后 = 每个用例的第二条命令开始就是"没有实现的 mock"
     （实测表现：手势发出去了但 `calls` 里一条都没有，看起来像"没发"）。
     清账放在装实现之前。 */
  vi.clearAllMocks();
  installBackend();
  useQueue.setState({ tabs: {} });
  useMessages.setState({ tabs: {} });
  useMessages.getState().ensure(TAB);
});

afterEach(async () => {
  await unmountDom();
});

/* ────────────────── 纯函数：对账 ────────────────── */

describe('对账（reconcileRows）', () => {
  const row = (over: Partial<QueueRow>): QueueRow => ({
    id: 'x',
    text: 'hi',
    images: [],
    target: 'followUp',
    ownership: 'local',
    sending: false,
    ...over,
  });

  it('同文本同目标 → 认出原行，id 与图片都保住（queue_update 里没有图片）', () => {
    const img = { data: 'AAA', mimeType: 'image/png', name: 'a.png' };
    const out = reconcileRows([row({ id: 'keep', text: '看这张图', images: [img] })], {
      steering: [],
      followUp: ['看这张图'],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe('keep');
    expect(out[0]!.images).toEqual([img]);
    expect(out[0]!.ownership).toBe('local');
  });

  it('两条一模一样的消息：按先到先得各认一条（pi 自己也是 indexOf）', () => {
    const out = reconcileRows([row({ id: 'a', text: 'same' }), row({ id: 'b', text: 'same' })], {
      steering: [],
      followUp: ['same', 'same'],
    });
    expect(out.map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('对不上账的行 = 外来行（插件注入的），如实标出来而不是丢掉', () => {
    const out = reconcileRows([], { steering: [], followUp: ['插件塞进来的'] });
    expect(out).toHaveLength(1);
    expect(out[0]!.ownership).toBe('foreign');
    expect(out[0]!.text).toBe('插件塞进来的');
  });

  it('顺序按 pi 的快照走：steering 在前，followUp 在后', () => {
    const out = reconcileRows([], { steering: ['s1'], followUp: ['f1', 'f2'] });
    expect(out.map((r) => `${r.target}:${r.text}`)).toEqual(['steering:s1', 'followUp:f1', 'followUp:f2']);
  });
});

/* ────────────────── 手势 ────────────────── */

describe('手势（DSH submission-policy）', () => {
  it('流式中 ↵ 入队：带 streamingBehavior=followUp，草稿清空，行出现在 dock 里', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('先记一下这个想法');

    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]!.args.streamingBehavior).toBe('followUp');
    expect(textarea().value).toBe('');
    expect(byData('[data-queue-dock]')).toHaveLength(1);
    expect(rowTexts()).toEqual(['先记一下这个想法']);
    expect(domContainer().textContent).toContain('先记一下这个想法');
  });

  it('空闲时 ↵ 直发：不带 streamingBehavior（真机空闲时忽略它，但语义必须干净）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    await type('你好');
    await press('Enter');
    expect(prompts()).toHaveLength(1);
    expect(prompts()[0]!.args.streamingBehavior).toBeUndefined();
    // 空闲直发的东西**不进队列**（它就是这一轮的用户消息）
    expect(rowTexts()).toEqual([]);
    expect(domContainer().querySelector('[data-queue-dock]')).toBeNull();
  });

  it('流式中 ⌘↵ 插话：带 streamingBehavior=steer，进 steering 队列', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await type('等等，先看这个');
    await press('Enter', { meta: true });
    // ⚠️ 看**最后一条**：队列里那条（followUp）还在队列里，不能拿它冒充这次插话
    expect(lastPrompt().args.streamingBehavior).toBe('steer');
    expect(lastPrompt().args.message).toBe('等等，先看这个');
    expect(piQueue.steering).toEqual(['等等，先看这个']);
    expect(useQueue.getState().tabs[TAB]!.rows.map((r) => r.target)).toContain('steering');
  });

  it('流式中 ⌘⇧↵ 显式追加：带 streamingBehavior=followUp', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await type('补充一句');
    await press('Enter', { meta: true, shift: true });
    expect(lastPrompt().args.streamingBehavior).toBe('followUp');
    expect(lastPrompt().args.message).toBe('补充一句');
    expect(piQueue.followUp).toEqual(['补充一句']);
  });

  it('空草稿 ⌘↵ = 全部插话（按 FIFO 逐条发，不是并发）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('第一条');
    await enqueueVia('第二条');
    calls = [];
    await press('Enter', { meta: true });

    expect(prompts().map((c) => c.args.message)).toEqual(['第一条', '第二条']);
    expect(prompts().every((c) => c.args.streamingBehavior === 'steer')).toBe(true);
  });

  it('占位文案：空草稿且有队列时宣传"全部插话"，有草稿时说明 ↵ 是入队', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('一条');
    expect(textarea().placeholder).toContain('插话发送');
    await type('写字');
    expect(textarea().placeholder).toContain('入队');
  });

  it('Esc 只中断，不动队列（老实现会把队列清掉并塞回草稿）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('留着');
    calls = [];
    await press('Escape');

    expect(calls.some((c) => c.cmd === 'pi_abort')).toBe(true);
    expect(calls.some((c) => c.cmd === 'pi_clear_queue')).toBe(false);
    expect(rowTexts()).toEqual(['留着']);
    expect(textarea().value).toBe('');
  });
});

/* ────────────────── 取回 / 放回 / 删除 / 清空 ────────────────── */

describe('取回与放回', () => {
  /** 排三条进队列（走真实入口，所以 mock 的 pi 队列与影子都是真的）。 */
  async function seedThree(): Promise<void> {
    for (const t of ['A', 'B', 'C']) await enqueueVia(t);
  }

  it('取回中间那条：连同尾巴一起取回并暂停，顺序不变', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await seedThree();
    const b = useQueue.getState().tabs[TAB]!.rows.find((r) => r.text === 'B')!;
    calls = []; // 只看取回期间发生了什么（入队 A/B/C 的那三次不算）

    await act(async () => {
      await useQueue.getState().take(TAB, b.id);
    });

    expect(pausedTexts()).toEqual(['B', 'C']);
    expect(rowTexts()).toEqual(['A']);
    expect(calls.some((c) => c.cmd === 'pi_clear_queue')).toBe(true);
    // `clear_queue` 是整清：**保留的前缀也要按原序重新下发**，否则"界面上还排着"
    // 与"pi 里其实没了"会越差越远（用户实报的"另一条也没了"就是这个根因）
    expect(piQueue.followUp).toEqual(['A']);
    expect(prompts().map((c) => c.args.message)).toEqual(['A']);
  });

  it('取回时对不上账的那条**不重建**（它已经被 pi 吃进回合了）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('A');
    await enqueueVia('B');
    const a = useQueue.getState().tabs[TAB]!.rows.find((r) => r.text === 'A')!;
    // pi 把 A 吃进回合了（真机：`turn_end` 后 drain，队列里只剩 B）
    act(() => {
      piQueue.followUp = ['B'];
      useMessages.getState().applyCommit(TAB, { type: 'queue_update', steering: [], followUp: ['B'] });
    });
    calls = [];

    let delivered = -1;
    await act(async () => {
      const r = await useQueue.getState().take(TAB, a.id);
      if (r.ok) delivered = r.delivered;
    });

    expect(delivered).toBe(1);
    expect(pausedTexts()).toEqual(['B']);
    // **一条都不能重发**：整个取回过程没有 pi_prompt
    expect(prompts()).toHaveLength(0);
  });

  it('继续发送：按原序放回（"放回原位"就是回到队尾，pi 只有 FIFO）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await seedThree();
    const b = useQueue.getState().tabs[TAB]!.rows.find((r) => r.text === 'B')!;
    await act(async () => {
      await useQueue.getState().take(TAB, b.id);
    });
    calls = []; // take 阶段重发前缀的调用不算在"放回"头上
    await act(async () => {
      await useQueue.getState().putBack(TAB);
    });

    // A 在 take 阶段已经作为"前缀"重新下发过了，这里只发暂停的 B、C（**不重发 A**）
    expect(prompts().map((c) => c.args.message)).toEqual(['B', 'C']);
    expect(prompts().every((c) => c.args.streamingBehavior === 'followUp')).toBe(true);
    expect(pausedTexts()).toEqual([]);
    expect(rowTexts()).toEqual(['A', 'B', 'C']);
    expect(piQueue.followUp).toEqual(['A', 'B', 'C']);
  });

  it('删除暂停行：只从暂存里去掉，放回时不再下发', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await seedThree();
    const b = useQueue.getState().tabs[TAB]!.rows.find((r) => r.text === 'B')!;
    await act(async () => {
      await useQueue.getState().take(TAB, b.id);
    });
    const c = paused().find((r) => r.text === 'C')!;
    act(() => {
      useQueue.getState().dropPaused(TAB, c.id);
    });
    calls = [];
    await act(async () => {
      await useQueue.getState().putBack(TAB);
    });

    expect(prompts().map((c2) => c2.args.message)).toEqual(['B']);
    expect(rowTexts()).toEqual(['A', 'B']);
  });

  it('编辑暂停行：改的就是那一行的文本（其余顺序不动）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('原文');
    const id = useQueue.getState().tabs[TAB]!.rows[0]!.id;
    await act(async () => {
      await useQueue.getState().take(TAB, id);
    });
    const pid = paused()[0]!.id;
    act(() => {
      useQueue.getState().editPaused(TAB, pid, '改过的文本');
    });
    expect(pausedTexts()).toEqual(['改过的文本']);

    // 放回之后下发的必须是**改过的那份**，而且只发这一条
    calls = [];
    await act(async () => {
      await useQueue.getState().putBack(TAB);
    });
    expect(prompts().map((c) => c.args.message)).toEqual(['改过的文本']);
  });

  it('清空：pi 队列与暂存一起清掉，dock 整个消失', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await seedThree();
    const a = useQueue.getState().tabs[TAB]!.rows[0]!;
    await act(async () => {
      await useQueue.getState().take(TAB, a.id);
    });
    await act(async () => {
      await useQueue.getState().clearAll(TAB);
    });

    expect(rowTexts()).toEqual([]);
    expect(pausedTexts()).toEqual([]);
    expect(piQueue.followUp).toEqual([]);
    expect(domContainer().querySelector('[data-queue-dock]')).toBeNull();
  });
});

/* ────────────────── dock 交互 ────────────────── */

describe('dock 交互', () => {
  it('取回要走行内二次确认（不可撤销的动作不能点错就没）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('A');
    await enqueueVia('B');
    /* 两条以上默认**收起**（DSH 同款：`rowCount > 1 && collapsed` 时列表整个不渲染），
       所以要点一下折叠头才能拿到行内按钮。 */
    await click('.pg-queue-head-toggle');
    calls = [];
    await click('[data-take]');

    // 第一次点：出确认条，pi 一个字节都没动
    expect(byData('[data-queue-confirm]')).toHaveLength(1);
    expect(calls.some((c) => c.cmd === 'pi_clear_queue')).toBe(false);
    expect(pausedTexts()).toEqual([]);

    await click('[data-confirm-ok]');
    expect(calls.some((c) => c.cmd === 'pi_clear_queue')).toBe(true);
    expect(pausedTexts()).toEqual(['A', 'B']);
  });

  it('取消确认：什么都不发生', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('A');
    await enqueueVia('B');
    await click('.pg-queue-head-toggle');
    await click('[data-take]');
    await click('[data-confirm-cancel]');

    expect(byData('[data-queue-confirm]')).toHaveLength(0);
    expect(rowTexts()).toEqual(['A', 'B']);
    expect(pausedTexts()).toEqual([]);
  });

  it('单条队列没有折叠头；两条以上有，且默认折叠', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('只有一条');
    expect(domContainer().querySelector('.pg-queue-head')).toBeNull();
    expect(domContainer().querySelector('[data-queue-list]')).not.toBeNull();

    await enqueueVia('第二条');
    const head = domContainer().querySelector('.pg-queue-head-toggle')!;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(domContainer().textContent).toContain('2 条排队消息');
  });

  it('清空也要确认，并写明条数', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('A');
    await enqueueVia('B');
    await click('[data-clear]');
    expect(domContainer().querySelector('[data-queue-confirm]')!.textContent).toContain('2 条');
    await click('[data-confirm-ok]');
    expect(rowTexts()).toEqual([]);
  });

  it('外来行标注"插件"，它的插话按钮是禁用的', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    // 影子是空的，pi 说队列里有一条 → 这条不是 Piggy 排的
    act(() => {
      piQueue.followUp = ['插件塞的'];
      useMessages.getState().applyCommit(TAB, {
        type: 'queue_update',
        steering: [],
        followUp: ['插件塞的'],
      });
      useQueue.getState().reconcile(TAB, { steering: [], followUp: ['插件塞的'] });
    });

    expect(domContainer().textContent).toContain('插件');
    expect(domContainer().querySelector('[data-foreign-note]')).not.toBeNull();
    expect((domContainer().querySelector('[data-steer]') as HTMLButtonElement).disabled).toBe(true);
  });

  it('暂停行：显示"已暂停"徽标，操作变成删除，并给出"继续发送"', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('A');
    await enqueueVia('B');
    await act(async () => {
      await useQueue.getState().take(TAB, useQueue.getState().tabs[TAB]!.rows[0]!.id);
    });

    expect(domContainer().textContent).toContain('已暂停');
    expect(byData('[data-drop]')).toHaveLength(2);
    expect(byData('[data-take]')).toHaveLength(0);
    expect(domContainer().querySelector('[data-continue]')).not.toBeNull();

    await click('[data-continue]');
    expect(pausedTexts()).toEqual([]);
    expect(toast.success).toHaveBeenCalled();
  });

  it('一个动作在飞时所有行都禁用（同一时刻只许一件事发生）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('A');
    await enqueueVia('B');
    act(() => {
      useQueue.getState().touch(TAB, { taking: true });
    });
    expect((domContainer().querySelector('[data-take]') as HTMLButtonElement).disabled).toBe(true);
    expect((domContainer().querySelector('[data-steer]') as HTMLButtonElement).disabled).toBe(true);
    expect((domContainer().querySelector('[data-clear]') as HTMLButtonElement).disabled).toBe(true);
  });
});


/* ────────────────── 用户实报：编辑打勾之后 ────────────────── */

describe('编辑暂停行（用户截图报的那条路）', () => {
  it('运行中：打勾保存后行回到队列、暂存清空，不弹"转向/追加"', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('A');
    await enqueueVia('B');
    await click('.pg-queue-head-toggle');
    // 编辑第二条（最后一条 → 不确认直接取回）
    await click('[data-edit]', 1);
    await typeEdit('B 改过');
    await click('[aria-label="保存排队消息"]');

    expect(pausedTexts()).toEqual([]);
    expect(rowTexts()).toEqual(['A', 'B 改过']);
    expect(prompts().map((c) => c.args.message)).toContain('B 改过');
  });

  it('**一轮已经结束**时编辑暂停行：不许冒第二条、不许把行丢掉', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('A');
    await enqueueVia('B');
    await click('.pg-queue-head-toggle');
    await click('[data-edit]', 1);
    // 用户还在编辑框里打字时，这一轮结束了（真实时序：编辑不是瞬时的）
    settle();
    await typeEdit('B 改过');
    await click('[aria-label="保存排队消息"]');

    // 关键断言：编辑的那条**只出现一次**（既不是"外来行"多冒一条，也不是消失）
    const rows = rowTexts();
    expect(rows.filter((t) => t === 'B 改过')).toHaveLength(1);
    expect(pausedTexts()).toEqual([]);
  });
});


/* ────────────────── 工具行没有"转向/追加"按钮 ────────────────── */

describe('输入卡工具行', () => {
  it('流式中**不再**出现「转向 / 追加」按钮（用户实报：编辑完突然冒出两个按钮）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    await enqueueVia('A');
    await enqueueVia('B');
    await click('.pg-queue-head-toggle');
    await click('[data-edit]', 1);
    await typeEdit('B 改过');
    await click('[aria-label="保存排队消息"]');

    const tools = domContainer().querySelector('.pg-composer-tools-right')!;
    expect(tools.textContent).not.toContain('转向');
    expect(tools.textContent).not.toContain('追加');
    // 投递语义只由手势表决定；发送键仍在（标签随状态说明按下去会发生什么）
    expect(tools.querySelector('.pg-send-btn')).not.toBeNull();
  });

  it('空闲时也没有这两粒（它们从来只该是手势，不是按钮）', () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    const tools = domContainer().querySelector('.pg-composer-tools-right')!;
    expect(tools.textContent).not.toContain('转向');
    expect(tools.textContent).not.toContain('追加');
  });
});

/* ────────────────── 落定与投递 ────────────────── */

describe('一轮落定', () => {
  it('settle 之后 followUp 行留着（它们还要发），steering 行清掉', () => {
    act(() => {
      useQueue.getState().reconcile(TAB, { steering: ['转向'], followUp: ['追加'] });
      useQueue.getState().settled(TAB);
    });
    expect(rowTexts()).toEqual(['追加']);
  });

  it('暂停行里的 steering 在落定后降级成 followUp（回合结束了，插话已无意义）', async () => {
    mountDom(<SessionWorkspaceComposer tabId={TAB} />);
    setStreaming(true);
    // 走真实入口进 steering 队列（⌘↵ = 插话）
    await type('插话');
    await press('Enter', { meta: true });
    expect(useQueue.getState().tabs[TAB]!.rows[0]!.target).toBe('steering');
    await act(async () => {
      await useQueue.getState().take(TAB, useQueue.getState().tabs[TAB]!.rows[0]!.id);
    });
    act(() => {
      useQueue.getState().settled(TAB);
    });
    expect(paused()[0]!.target).toBe('followUp');
  });

  it('用户消息在转录里落地 → 影子摘掉对应的那一条（同文本只摘一条）', () => {
    act(() => {
      useQueue.getState().reconcile(TAB, { steering: [], followUp: ['重复', '重复'] });
      useQueue.getState().delivered(TAB, '重复');
    });
    expect(rowTexts()).toEqual(['重复']);
  });
});
