// @vitest-environment jsdom
/**
 * 预览滚动条**接进转录**、以及设置页那三档开关（docs/04 §2.6、docs/03 §2.2）。
 *
 * 单元测试（turn-rail.test.tsx）测的是刻度本身；这里测的是三件只有"接起来"才成立的事：
 *   ① 开关真的决定画不画、画在哪边（`data-rail-side`）；
 *   ② 刻度来自**整段历史**（store 里的全部消息），不是屏幕上那几条；
 *   ③ 设置页改一下，**已经打开的会话**立刻跟着变（这正是"配置要进 store"的理由）。
 *
 * ⚠️ 转录本体是虚拟化的，jsdom 里 `clientHeight` 为 0 → 虚拟窗口为空。
 * 所以这里只断言"外壳 + 滚动条"这一层（`data-rail-side`、刻度数），
 * 行渲染与跳转几何由浏览器门禁在真布局里量。
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
        index, key: index, start: index * estimateSize(index), size: estimateSize(index),
      })),
    measureElement: () => {},
    scrollToIndex: (...args: unknown[]) => {
      (globalThis as Record<string, unknown>).__lastJump = args;
    },
  }),
}));

import { Transcript } from '@/features/chat/Transcript';
import { useAppConfig } from '@/stores/appConfig';
import { useMessages } from '@/stores/messages';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
const q = <T extends Element>(sel: string) => domContainer().querySelector<T>(sel);
const qa = <T extends Element>(sel: string) => [...domContainer().querySelectorAll<T>(sel)];

const TAB = 'tab-rail';

/** 灌入 n 轮（user + assistant）。 */
function seed(turns: number) {
  const messages = [] as { role: string; content: unknown; timestamp: number }[];
  for (let i = 1; i <= turns; i += 1) {
    messages.push({ role: 'user', content: [{ type: 'text', text: `问题 ${i}` }], timestamp: i * 10 });
    messages.push({ role: 'assistant', content: [{ type: 'text', text: `回答 ${i}` }], timestamp: i * 10 + 1 });
  }
  useMessages.getState().hydrate(TAB, messages as never);
}

beforeEach(() => {
  invokeMock.mockReset();
  useMessages.setState({ tabs: {} });
  useAppConfig.setState({ railPlacement: 'right', loaded: false });
});

afterEach(async () => {
  await unmountDom();
});

describe('转录里的预览滚动条', () => {
  it('默认右侧：外壳标出 side，刻度覆盖**整段历史**（20 轮 → 20 条）', async () => {
    seed(20);
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    const wrap = q('[data-rail-side]')!;
    expect(wrap.getAttribute('data-rail-side')).toBe('right');
    expect(q('.pg-rail-right')).toBeTruthy();
    const marks = qa('[data-rail-mark]');
    expect(marks).toHaveLength(20);
    // 最后一条刻度的预览内容是最后一轮（真·整段历史，不只是可视区那几条）
    const last = marks[marks.length - 1]!;
    await act(async () => {
      last.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(q('[data-rail-preview-prompt]')!.textContent).toBe('问题 20');
  });

  it('设成关闭 → 不画；设成左侧 → 画在左边', async () => {
    seed(5);
    useAppConfig.setState({ railPlacement: 'off' });
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    expect(q('[data-turn-rail]')).toBeNull();
    expect(q('[data-rail-side]')!.getAttribute('data-rail-side')).toBe('off');

    // 设置页改了值 → 已打开的会话立刻跟着变（不用重新打开）
    await act(async () => {
      useAppConfig.getState().setRailPlacement('left');
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(q('.pg-rail-left')).toBeTruthy();
    expect(q('[data-rail-side]')!.getAttribute('data-rail-side')).toBe('left');
  });

  it('只有 1 轮时不画（刻度梯没有意义）', async () => {
    seed(1);
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    expect(q('[data-turn-rail]')).toBeNull();
  });

  it('点刻度 → 让转录跳到那一轮（行下标对齐）', async () => {
    seed(3);
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    const marks = qa<HTMLElement>('[data-rail-mark]');
    await act(async () => {
      marks[2]!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const jump = (globalThis as Record<string, unknown>).__lastJump as [number, unknown] | undefined;
    expect(jump, '没有调用 scrollToIndex').toBeTruthy();
    expect(jump![0]).toBe(4); // 第 3 轮的用户消息在第 5 行（0 起）
  });
});

describe('设置页的三档开关', () => {
  it('点「左侧」会写进配置，并把新值推给界面', async () => {
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'perf_config_load') {
        return { max_workers: 8, idle_timeout_min: 10, permission_mode: 'full', transcript_rail: 'right' };
      }
      return null;
    });
    const { GeneralSection } = await import('@/features/settings/GeneralSection');
    mountDom(<GeneralSection />);
    await flush();
    const left = q<HTMLButtonElement>('[data-rail-option="left"]')!;
    expect(left).toBeTruthy();
    await act(async () => {
      left.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    const save = invokeMock.mock.calls.find((c) => c[0] === 'perf_config_save');
    expect(save, '没发出 perf_config_save').toBeTruthy();
    expect((save![1] as Record<string, unknown>).transcriptRail).toBe('left');
    expect(useAppConfig.getState().railPlacement).toBe('left');
  });

  it('mock 真的把 transcriptRail 存下来了（浏览器门禁据此核对"选完生效"）', async () => {
    const actual = await vi.importActual<typeof import('@/lib/mockBackend')>('@/lib/mockBackend');
    await actual.mockInvoke('perf_config_save', { transcriptRail: 'left' });
    const cfg = await actual.mockInvoke<{ transcript_rail?: string }>('perf_config_load', {});
    expect(cfg.transcript_rail).toBe('left');
    await actual.mockInvoke('perf_config_save', { transcriptRail: 'right' }); // 还原
  });

  it('读配置时把认不出的值收回默认（与 Rust 的 #[serde(other)] 同义）', async () => {
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'perf_config_load') return { max_workers: 8, idle_timeout_min: 10, transcript_rail: 'wat' };
      return null;
    });
    await useAppConfig.getState().load();
    expect(useAppConfig.getState().railPlacement).toBe('right');
    // 缺字段也一样（老配置里没有这一项）
    invokeMock.mockImplementation(async () => ({ max_workers: 8, idle_timeout_min: 10 }));
    await useAppConfig.getState().load();
    expect(useAppConfig.getState().railPlacement).toBe('right');
  });
});
