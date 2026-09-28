// @vitest-environment jsdom
/**
 * 上下文占用百分比的显示口径（用户 2026-09-23 报的
 * `上下文占用 20.316000000000003%`）。
 *
 * 这个数来自 pi 的 `contextUsage.percent`，是 `tokens / contextWindow × 100` 的 f64 ——
 * 值本身没错，错的是**直接拼进模板串**。同一个数在三处露面（环的短标签、环的 title、
 * 右栏「上下文」），三处都必须过 `formatPercent`；任何一处漏掉，尾巴又回到界面上。
 * 单测里用 mock 那组真数字（15400 / 75800），与门禁 `numbers` 段用的是同一个夹具。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

import { SessionWorkspaceComposer } from '@/features/chat/Composer';
import { RightBar } from '@/features/workspace/RightBar';
import { useTabs } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';
import { domContainer, mountDom, unmountDom } from './dom-render';

/** 与 mock/门禁同一组数字：15400 / 75800 × 100 = 20.316622691292878 */
const RAW_PERCENT = (15_400 / 75_800) * 100;

const TAB = {
  tabId: 't-1',
  cwd: '/proj',
  sessionFile: null,
  sessionId: null,
  sessionName: '会话',
  workerState: 'ready',
  thinkingLevel: null,
  state: { model: { id: 'glm-5.3-flash', name: 'glm-5.3-flash', provider: 'p' } },
};

/** 让 `pi_get_session_stats` 返回带 f64 尾巴的占用率（真机形状） */
function statsWithRawPercent(): void {
  invokeMock.mockImplementation(async (name: string) => {
    if (name === 'pi_get_session_stats') {
      return {
        tokens: { input: 12_000, output: 3_400, total: 15_400, cacheRead: 9_000 },
        contextUsage: { tokens: 15_400, contextWindow: 75_800, percent: RAW_PERCENT },
      };
    }
    if (name === 'pi_get_commands') return { commands: [] };
    if (name === 'permission_modes') return { modes: [], current: 'workspace' };
    if (name === 'pi_get_available_models') return { models: [], current: null };
    return {};
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  useTabs.setState({
    tabs: { 't-1': TAB } as never,
    order: ['t-1'],
    activeTabId: 't-1',
    unread: {},
    banner: null,
  });
  useMessages.setState({ tabs: {} });
  invokeMock.mockReset();
  statsWithRawPercent();
});

afterEach(async () => {
  await unmountDom();
});

describe('上下文占用百分比', () => {
  it('夹具本身带浮点尾巴（否则这两条断言是空转）', () => {
    expect(String(RAW_PERCENT)).toMatch(/^\d+\.\d{4,}$/);
  });

  it('环：短标签是整数（DSH 口径），title 是 3 位小数', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await settle();

    const meter = domContainer().querySelector('.pg-ctx-meter');
    expect(meter).not.toBeNull();
    expect(meter!.querySelector('span')!.textContent).toBe('20%');
    expect(meter!.getAttribute('title')).toBe('上下文占用 20.317%（15.400K / 75.800K）');
    // 尾巴不许在任何地方出现
    expect(meter!.outerHTML).not.toContain('20.316622691292878');
  });

  it('右栏统计：「上下文」一行 3 位小数，且与用量条宽度用同一个夹过的数', async () => {
    mountDom(<RightBar tabId="t-1" />);
    await settle();
    const btn = [...domContainer().querySelectorAll<HTMLButtonElement>('.pg-rail-btn')].find(
      (b) => b.getAttribute('title') === '统计',
    );
    expect(btn).toBeDefined();
    await act(async () => {
      btn!.click();
      await new Promise((r) => setTimeout(r, 0));
    });

    const row = domContainer().querySelector('[data-ctx-percent]');
    expect(row).not.toBeNull();
    expect(row!.textContent).toBe('20.317%');
    expect(row!.getAttribute('data-ctx-percent')).toBe('20.317');
    // 用量条宽度：夹过的百分比（20.317% → 20.3166…%），不是 NaN、也不是 2031%
    const fill = domContainer().querySelector<HTMLElement>('.pg-usage-fill');
    expect(Number.parseFloat(fill!.style.width)).toBeCloseTo(RAW_PERCENT, 6);
    expect(fill?.getAttribute('data-level')).toBe('low');
  });
});
