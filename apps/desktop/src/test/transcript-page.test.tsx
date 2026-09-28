// @vitest-environment jsdom
/**
 * 转录分页 + 打开即贴底（docs/03 §2.19、docs/04 §2.1）。
 *
 * 起因（2026-09-23 用户报）：
 *   ① "长上下文的时候，打开会话，都是在开头，有没有办法在结尾"；
 *   ② "如果在结尾并且部份加载，支持向上滚动点加载更多"。
 *
 * ⚠️ jsdom 没有布局（`clientHeight` / `scrollHeight` 天生为 0），所以这里
 * **显式给滚动容器装上假的几何**再派发 scroll —— 测的是我们自己的判断逻辑
 * （阈值/意图/锚点），不是浏览器的布局。真几何由浏览器门禁
 * （`scripts/ui-startup-check.mjs`）量。
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
    scrollToIndex: vi.fn(),
  }),
}));

import { Transcript } from '@/features/chat/Transcript';
import { useAppConfig } from '@/stores/appConfig';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const q = <T extends Element>(sel: string) => domContainer().querySelector<T>(sel);
const TAB = 'tab-page';
const FILE = '/tmp/s.jsonl';

/** 一行消息（`session_page` 的行形状：`{role, message}`）。 */
const row = (i: number, role = 'user') => ({
  role,
  message: { role, content: [{ type: 'text', text: `第 ${i} 行` }], timestamp: 1000 + i },
});

/** 一页的返回（行带偏移：刻度梯靠它把轮廓与已载入的行对上）。 */
const page = (from: number, to: number, hasMore: boolean, hasNewer = false) => ({
  rows: Array.from({ length: to - from }, (_, k) => ({ ...row(from + k), offset: from + k })),
  startOffset: from,
  hasMore,
  hasNewer,
  branchy: false,
});

/** 给滚动容器装上假几何：内容 2000 / 视口 400。 */
function fakeGeometry(el: HTMLElement, scrollHeight = 2000, clientHeight = 400) {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
}

function scroller(): HTMLDivElement {
  const el = q<HTMLDivElement>('.pg-transcript');
  if (!el) throw new Error('找不到转录滚动容器');
  return el;
}

/** 派发一次滚动（React 的 scroll 监听是非 passive 的普通监听，可直接触发）。 */
async function scrollTo(el: HTMLElement, top: number) {
  await act(async () => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll', { bubbles: false }));
    await new Promise((r) => setTimeout(r, 10));
  });
}

function seed(
  rows: number,
  meta: { cursor: number | null; hasMore: boolean; hasNewer?: boolean } = { cursor: 0, hasMore: false },
) {
  useMessages.getState().hydratePage(
    TAB,
    Array.from({ length: rows }, (_, i) => row(i).message) as never[],
    meta,
  );
}

/** 灌一页带偏移的行（刻度梯要用偏移把轮廓和行对上）。 */
function seedOffsets(rows: number, from: number, meta: { cursor: number | null; hasMore: boolean; hasNewer?: boolean }) {
  useMessages.getState().hydratePage(
    TAB,
    Array.from({ length: rows }, (_, k) => ({ ...row(from + k), offset: from + k })) as never[],
    meta,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (name: string) => {
    if (name === 'session_page') return page(0, 0, false);
    return {};
  });
  useMessages.setState({ tabs: {} });
  useTabs.setState({
    tabs: { [TAB]: { tabId: TAB, sessionFile: FILE, cwd: '/tmp', workerState: 'ready' } } as never,
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

describe('打开会话贴在结尾', () => {
  it('第一页灌进来就贴底（不是停在开头）', async () => {
    seed(12);
    mountDom(<Transcript tabId={TAB} />);
    // 几何要在"贴底那一帧"之前装上：组件在 hydrated 之后用 rAF 贴底，
    // 先 fakeGeometry 再等帧，量到的才是它真的滚到底了。
    const el = scroller();
    fakeGeometry(el);
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop).toBe(el.scrollHeight);
  });
});

describe('加载更早', () => {
  it('hasMore=false 时没有那颗按钮', async () => {
    seed(5, { cursor: 0, hasMore: false });
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    expect(q('[data-load-older]')).toBeNull();
  });

  it('hasMore=true 时出现「加载更早」，点了用游标请求上一页并接到最前面', async () => {
    seed(3, { cursor: 900, hasMore: true });
    invokeMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'session_page') {
        expect(args.path).toBe(FILE);
        expect(args.before).toBe(900); // 游标就是上一页给的 startOffset
        return page(880, 900, true);
      }
      return {};
    });
    mountDom(<Transcript tabId={TAB} />);
    await flush();

    const btn = q<HTMLButtonElement>('[data-load-older]')!;
    expect(btn.textContent).toBe('加载更早');
    await act(async () => {
      btn.click();
      await new Promise((r) => setTimeout(r, 30));
    });

    const tab = useMessages.getState().tabs[TAB]!;
    expect(tab.ids.length, '更早的一页要接在最前面').toBe(23);
    const first = tab.byId[tab.ids[0]!]!;
    expect((first.message as { content: { text: string }[] }).content[0]!.text).toBe('第 880 行');
    expect(tab.pageCursor, '游标要跟着往前挪').toBe(880);
  });

  it('翻页期间显示「载入历史…」并禁用按钮（不给重复请求）', async () => {
    seed(3, { cursor: 900, hasMore: true });
    let release: (() => void) | null = null;
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'session_page') {
        await new Promise<void>((r) => {
          release = r;
        });
        return page(880, 900, false);
      }
      return {};
    });
    mountDom(<Transcript tabId={TAB} />);
    await flush();

    await act(async () => {
      q<HTMLButtonElement>('[data-load-older]')!.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    const btn = q<HTMLButtonElement>('[data-load-older]')!;
    expect(btn.textContent).toBe('载入历史…');
    expect(btn.disabled).toBe(true);

    await act(async () => {
      release?.();
      await new Promise((r) => setTimeout(r, 30));
    });
    // 后端说没有更早的了 → 按钮消失
    expect(q('[data-load-older]')).toBeNull();
  });

  it('还没 hydrate 时给一句「载入历史…」，不留空白', async () => {
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    expect(q('[data-transcript-hint]')!.textContent).toContain('载入历史');
  });
});

describe('回到底部', () => {
  it('往上滚之后出现，点一下贴底并消失', async () => {
    seed(12);
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    const el = scroller();
    fakeGeometry(el);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(q('[data-to-bottom]'), '还贴着底时不该出现').toBeNull();

    await scrollTo(el, 100); // 距底 1500 > 25 → 交还控制权
    const btn = q<HTMLButtonElement>('[data-to-bottom]')!;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('aria-label')).toBe('回到底部');

    await act(async () => {
      btn.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(el.scrollTop).toBe(el.scrollHeight);
    expect(q('[data-to-bottom]')).toBeNull();
  });

  it('停在容差内的位置不算"离开底部"（25px）', async () => {
    seed(12);
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    const el = scroller();
    fakeGeometry(el);
    await scrollTo(el, 1580); // 距底 20px
    expect(q('[data-to-bottom]')).toBeNull();
    await scrollTo(el, 1500); // 距底 100px
    expect(q('[data-to-bottom]')).toBeTruthy();
  });
});

describe('跳到未载入的那一轮：换窗（不把中间那段读进来）', () => {
  const OUTLINE = [
    { turn: 1, start: 10, end: 20, prompt: '第一轮的问题', response: '第一轮的回答' },
    { turn: 2, start: 30, end: 40, prompt: '第二轮的问题', response: '第二轮的回答' },
    { turn: 3, start: 50, end: 60, prompt: '第三轮的问题', response: '第三轮的回答' },
    { turn: 4, start: 70, end: 80, prompt: '第四轮的问题', response: '第四轮的回答' },
  ];

  it('点未载入的刻度：只取目标那一页（用 anchorEnd 当右界），旧窗口被换掉', async () => {
    // 当前窗口 = 最后两行（第 4 轮），轮廓说第 1~3 轮没载入
    seedOffsets(2, 70, { cursor: 70, hasMore: true });
    useMessages.getState().setOutline(TAB, OUTLINE);
    useAppConfig.setState({ railPlacement: 'right', loaded: true });
    invokeMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'session_page') {
        // 换窗：右界必须是第 1 轮的 anchorEnd（20），且**只请求一页**
        expect(args.before).toBe(20);
        return page(18, 20, false, true); // 一页两行（换窗只取这一页）
      }
      if (name === 'session_outline') return { turns: OUTLINE, totalBytes: 100 };
      return {};
    });
    mountDom(<Transcript tabId={TAB} />);
    await flush();

    const first = q<HTMLElement>('[data-rail-mark="1"]')!;
    expect(first.hasAttribute('data-rail-unloaded')).toBe(true);
    await act(async () => {
      first.click();
      await new Promise((r) => setTimeout(r, 60));
    });

    const tab = useMessages.getState().tabs[TAB]!;
    // 只发了**一次** session_page（换窗），行数 = 那一页（2 行），不是"把中间全累加进来"
    const calls = invokeMock.mock.calls.filter((c) => c[0] === 'session_page');
    expect(calls).toHaveLength(1);
    expect(tab.ids).toHaveLength(2);
    expect(tab.hasNewer).toBe(true);
    expect(tab.pageCursor).toBe(18);
  });

  it('换窗状态下给「回到最新」，点了重新装载尾部一页', async () => {
    seedOffsets(2, 70, { cursor: 70, hasMore: true, hasNewer: true });
    useMessages.getState().setOutline(TAB, OUTLINE);
    mountDom(<Transcript tabId={TAB} />);
    await flush();

    const latest = q<HTMLButtonElement>('[data-to-latest]')!;
    expect(latest).toBeTruthy();
    expect(q('[data-to-bottom]'), '换窗时不该同时出现「回到底部」').toBeNull();

    await act(async () => {
      latest.click();
      await new Promise((r) => setTimeout(r, 60));
    });
    const call = invokeMock.mock.calls.filter((c) => c[0] === 'session_page').at(-1);
    expect(call![1]).toMatchObject({ path: FILE }); // 不带 before = 尾部那一页
    expect((call![1] as Record<string, unknown>).before).toBeUndefined();
  });
});
