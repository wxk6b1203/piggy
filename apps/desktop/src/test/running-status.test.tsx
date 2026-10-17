// @vitest-environment jsdom
/**
 * 运行中指示（DSH `RunningStatus`，docs/04 §2.1.8）：转录末尾那行
 * 「🐋 运行中，用时 N 秒 ···」。
 *
 * 起因（2026-10-16 用户截图 + "之前类似 DSH 一样有个 assistant 指示，后来没有了……
 * 类似 DSH 加个运行时间"）：这一轮跑起来之后转录里什么都不动，工具在跑时更是彻底静止，
 * 看不出"还在干活"还是"卡住了"。DSH 在**内容流末尾**挂一行带实时用时的扫光文字。
 *
 * 这份用例钉五条：
 *   ① 时钟从 `agent_start` 起算（不是从最后一条用户消息倒推 —— 流式中还能继续入队）；
 *   ② 每秒一跳、只在不满 1 秒时按 1 秒显示（不许闪 "0 秒"）；
 *   ③ 没有起点就只写「运行中」，**不编数字**；
 *   ④ 一落定就消失（`agent_settled` / 中断两条路都要清掉时钟起点）；
 *   ⑤ 分隔线只看最后一行"有没有输出"（刚发出的用户气泡不该带线）。
 *
 * 文案是「运行中」而不是 DSH 的「深度求索中」（用户 2026-10-16 明确要求）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
vi.mock('@/lib/feedback', () => {
  const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn() };
  return { toast, FeedbackBridge: () => null, confirm: vi.fn() };
});
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

import { RunningStatus, formatRunDuration } from '@/features/chat/RunningStatus';
import { Transcript } from '@/features/chat/Transcript';
import { useAppConfig } from '@/stores/appConfig';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { domContainer, mountDom, unmountDom } from './dom-render';

const TAB = 'tab-running';

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
};
const label = (): string =>
  (domContainer().querySelector('.pg-running-content')?.textContent ?? '').replace(/\s+/g, ' ').trim();

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async () => ({}));
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-16T00:00:00Z'));
});

afterEach(async () => {
  // 先还真实定时器：`unmountDom` 内部的 drain 靠 setTimeout 轮转，假时钟下会挂住
  vi.useRealTimers();
  await unmountDom();
});

/* ────────────────── 用时格式（纯函数） ────────────────── */

describe('formatRunDuration（DSH message-chrome 的口径）', () => {
  it('不足一分钟只报秒，且不补前导零', () => {
    expect(formatRunDuration(0)).toBe('0秒');
    expect(formatRunDuration(-5000)).toBe('0秒');
    expect(formatRunDuration(1000)).toBe('1秒');
    expect(formatRunDuration(59_999)).toBe('59秒');
  });

  it('满一分钟才出现「分」，小时同理', () => {
    expect(formatRunDuration(60_000)).toBe('1分0秒');
    expect(formatRunDuration(65_000)).toBe('1分5秒');
    expect(formatRunDuration(3_725_000)).toBe('1小时2分5秒');
  });
});

/* ────────────────── 组件本身 ────────────────── */

describe('运行指示（组件）', () => {
  it('带起点：显示「运行中，用时 N秒 ···」，并且每秒自己跳一次', async () => {
    mountDom(<RunningStatus startedAt={Date.now() - 4000} divider />);
    expect(label()).toBe('运行中，用时 4秒 ···');

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    expect(label(), '秒针没跳 —— 那这个"运行时间"就是死的').toBe('运行中，用时 5秒 ···');

    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(label()).toBe('运行中，用时 1分5秒 ···');
  });

  it('刚发出那一瞬间按 1 秒算（不闪 "0 秒"）', () => {
    mountDom(<RunningStatus startedAt={Date.now()} divider />);
    expect(label()).toBe('运行中，用时 1秒 ···');
  });

  it('没有起点：只写「运行中」，不编一个数字出来', () => {
    mountDom(<RunningStatus startedAt={null} />);
    expect(label()).toBe('运行中');
    expect(domContainer().textContent, '不该出现"用时"').not.toContain('用时');
  });

  it('读屏播报的是状态，每秒变的数字不进无障碍树', () => {
    mountDom(<RunningStatus startedAt={Date.now() - 3000} />);
    const live = domContainer().querySelector('[role="status"]');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toBe('运行中');
    expect(domContainer().querySelector('.pg-sr-only')).not.toBeNull();
  });

  it('图标是猪头线稿（一个内联 SVG，颜色随 currentColor）', () => {
    mountDom(<RunningStatus startedAt={Date.now()} />);
    const icon = domContainer().querySelector('.pg-running-icon');
    expect(icon, '图标容器').not.toBeNull();
    const svg = icon?.querySelector('svg');
    expect(svg, '猪头是内联 SVG —— 不依赖任何位图资产').not.toBeNull();
    // 脸 + 左右耳（3 条 path）+ 鼻吻 + 两眼两鼻孔：少一样就读不成"猪"
    expect(svg!.querySelectorAll('path')).toHaveLength(3);
    expect(svg!.querySelectorAll('ellipse')).toHaveLength(1);
    expect(svg!.querySelectorAll('circle')).toHaveLength(4);
    expect(svg!.getAttribute('stroke'), '颜色跟文字走，深浅主题共用一份几何').toBe('currentColor');
    expect(icon?.getAttribute('aria-hidden'), '图标是装饰，读屏不该念它').toBe('true');
  });

  it('分隔线按调用方的判断画（最后一行有没有输出）', () => {
    mountDom(<RunningStatus startedAt={Date.now()} />);
    expect(domContainer().querySelector('.pg-running-divider')).toBeNull();
  });
});

/* ────────────────── 转录末尾的接线 ────────────────── */

async function commit(ev: { type: string } & Record<string, unknown>): Promise<void> {
  await act(async () => {
    useMessages.getState().applyCommit(TAB, ev);
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mountTranscript(): Promise<void> {
  useMessages.getState().hydrate(TAB, []);
  mountDom(<Transcript tabId={TAB} />);
  await flush();
}

describe('转录末尾（只在跑的时候挂）', () => {
  beforeEach(() => {
    /* 这一段用**真实定时器**：转录的挂载/提交都靠 `act` 里的 setTimeout 轮转，
       假时钟下那些 await 永远不落地（实测：三条用例各卡满 5s 超时）。 */
    vi.useRealTimers();
    useMessages.setState({ tabs: {} });
    useTabs.setState({
      tabs: { [TAB]: { tabId: TAB, sessionFile: '/tmp/running.jsonl', cwd: '/tmp', workerState: 'ready' } } as never,
      order: [TAB],
      activeTabId: TAB,
      unread: {},
      banner: null,
    });
    useAppConfig.setState({ railPlacement: 'off', loaded: true });
  });

  it('agent_start 记下时钟起点并挂出指示；agent_settled 之后两样都收掉', async () => {
    await mountTranscript();
    expect(domContainer().querySelector('[data-chat-running]'), '空闲时不该有指示行').toBeNull();

    await commit({ type: 'agent_start' });
    const startedAt = useMessages.getState().tabs[TAB]?.turnStartedAt;
    expect(typeof startedAt, 'agent_start 必须记下这一轮的开始时刻').toBe('number');
    expect(startedAt!).toBeLessThanOrEqual(Date.now());
    expect(domContainer().querySelector('[data-chat-running]')).not.toBeNull();
    expect(label()).toContain('运行中');

    await commit({ type: 'agent_settled', aborted: false });
    expect(useMessages.getState().tabs[TAB]?.turnStartedAt).toBeNull();
    expect(domContainer().querySelector('[data-chat-running]'), '一落定就该收掉').toBeNull();
  });

  it('中断（interruptTurn）也要清掉时钟起点 —— 否则下一轮会从上一轮起算', async () => {
    await mountTranscript();
    await commit({ type: 'agent_start' });
    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(typeof useMessages.getState().tabs[TAB]?.turnStartedAt, '前置条件：时钟在走').toBe('number');

    await act(async () => {
      useMessages.getState().interruptTurn(TAB, '崩溃了', { failed: true });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(useMessages.getState().tabs[TAB]?.turnStartedAt).toBeNull();
  });

  it('最后一行是用户气泡时不画分隔线；助手出了字才画', async () => {
    await mountTranscript();
    await commit({ type: 'agent_start' });
    await commit({ type: 'message_start', message: { role: 'user', content: '写个测试' } });
    await commit({ type: 'message_end', message: { role: 'user', content: '写个测试', timestamp: Date.now() } });
    expect(domContainer().querySelector('.pg-running-divider'), '气泡下面直接贴状态行').toBeNull();

    await commit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    expect(
      domContainer().querySelector('.pg-running-divider'),
      '空的助手行也不算输出（DSH 同一口径）',
    ).toBeNull();

    await act(async () => {
      useMessages.getState().applyFrame(TAB, { text: [{ contentIndex: 0, delta: '先看代码' }] });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(domContainer().querySelector('.pg-running-divider'), '助手有字了才分界').not.toBeNull();
  });
});
