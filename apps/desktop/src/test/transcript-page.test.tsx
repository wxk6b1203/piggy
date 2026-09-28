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

const { invokeMock, scrollToIndex } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  scrollToIndex: vi.fn(),
}));
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
    scrollToIndex,
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
  endOffset: to,
  hasMore,
  hasNewer,
  branchy: false,
});

/**
 * 给滚动容器装上假几何：内容 2000 / 视口 400。
 *
 * ⚠️ `scrollTop` 必须**像真浏览器那样钳制**到 `scrollHeight - clientHeight`：
 * 不钳制的话"贴底之后内容又长高、而这次 scroll 事件用的是旧位置"这一幕根本造不出来
 * （`scrollTop = scrollHeight` 会得到一个越界值，距离反而永远是 0）——
 * 第一版就是这样，红检时两条用例在"退回只看几何"的实现下**照样绿**，
 * 等于没测到用户报的那个闪动。
 */
function fakeGeometry(el: HTMLElement, scrollHeight = 2000, clientHeight = 400) {
  let top = 0;
  let sets = 0;
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    // 钳制要读**当前**的 scrollHeight/clientHeight：写死闭包里的初始值，
    // 后面再改几何（模拟"流式长高"）就会按旧高度钳制，测试于是假绿。
    set: (v: number) => {
      sets += 1;
      const h = (el as unknown as { scrollHeight: number }).scrollHeight;
      const c = (el as unknown as { clientHeight: number }).clientHeight;
      top = Math.max(0, Math.min(v, h - c));
    },
  });
  // 记录"我们程序化改了几次 scrollTop"：贴底是否幂等就看它
  (el as unknown as { __sets: () => number }).__sets = () => sets;
  (el as unknown as { __resetSets: () => void }).__resetSets = () => {
    sets = 0;
  };
}

/** 攒下 ResizeObserver 的回调，测试里手动触发（jsdom 不会自己触发）。 */
function captureResizeObservers(): { callbacks: Array<() => void>; restore: () => void } {
  const callbacks: Array<() => void> = [];
  const Real = globalThis.ResizeObserver;
  class Spy {
    constructor(cb: ResizeObserverCallback) {
      callbacks.push(() => cb([], this as unknown as ResizeObserver));
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  (globalThis as Record<string, unknown>).ResizeObserver = Spy as never;
  return {
    callbacks,
    restore: () => {
      (globalThis as Record<string, unknown>).ResizeObserver = Real;
    },
  };
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
function seedOffsets(
  rows: number,
  from: number,
  meta: { cursor: number | null; hasMore: boolean; hasNewer?: boolean; end?: number | null },
) {
  useMessages.getState().hydratePage(
    TAB,
    Array.from({ length: rows }, (_, k) => ({ ...row(from + k), offset: from + k })) as never[],
    meta,
  );
}

beforeEach(() => {
  invokeMock.mockReset();
  scrollToIndex.mockReset();
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
    // 真浏览器会把 scrollTop 钳到可滚高度（= scrollHeight - clientHeight）
    expect(el.scrollTop).toBe(1600);
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
    expect(el.scrollTop).toBe(1600); // 贴到可滚高度的底（真浏览器同样钳制）
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

describe('流式时"跟随"不许被自己贴的底弄丢（DSH movedByReader）', () => {
  /** 灌 n 个回合，并让梯子可用（刻度要看当前轮次）。 */
  function seedTurns(n: number) {
    const rows = Array.from({ length: n * 2 }, (_, i) => ({
      ...row(i, i % 2 === 0 ? 'user' : 'assistant'),
      offset: i,
    }));
    useMessages.getState().hydratePage(TAB, rows as never[], {
      cursor: 0,
      hasMore: false,
    });
    useMessages.getState().setOutline(
      TAB,
      Array.from({ length: n }, (_, k) => ({
        turn: k + 1,
        start: k * 2,
        end: k * 2 + 1,
        prompt: `第 ${k + 1} 轮的问题`,
        response: `第 ${k + 1} 轮的回答`,
      })),
    );
    useAppConfig.setState({ railPlacement: 'right', loaded: true });
  }

  it('内容在贴底之后长高：这次 scroll 事件不算"读者滚的"，跟随与当前轮次都不许变', async () => {
    // 40 轮：屏幕上的阅读线只覆盖到第 10 轮附近 —— 这样"最新那轮"与"阅读线那轮"
    // 是两个不同的答案，才能区分"用跟随意图判定"和"用瞬时几何判定"
    seedTurns(40);
    mountDom(<Transcript tabId={TAB} />);
    const el = scroller();
    fakeGeometry(el, 2000, 400); // 几何要在"贴底那一帧"之前装好
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '组件应当已经贴到底').toBe(1600);
    // 还在跟随时，当前轮次是最后那一轮
    expect(q('[data-rail-mark].is-active')?.getAttribute('data-rail-mark')).toBe('40');

    // 模拟流式：内容先长高 400px，随后那次 scroll 事件才被处理（位置仍是我们设的 1600）
    fakeGeometry(el, 2400, 400);
    await scrollTo(el, 1600);

    // 此刻距底 400px —— 只看几何会判成"读者滚上去了"（修复前就是这样：实测当前刻度 60 → 58，
    // 而且这一帧的判断会随着内容长高反复翻转，梯子上的亮条就逐帧闪）
    expect(q('[data-to-bottom]'), '跟随被自己贴的底弄丢了').toBeNull();
    expect(q('[data-rail-mark].is-active')?.getAttribute('data-rail-mark')).toBe('40');
  });

  it('读者真的往上滚：跟随交还，当前轮次跟着阅读线走', async () => {
    seedTurns(4);
    mountDom(<Transcript tabId={TAB} />);
    const el = scroller();
    fakeGeometry(el, 2000, 400);
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop).toBe(1600);

    await scrollTo(el, 100); // 位置变了 = 读者滚的
    expect(q('[data-to-bottom]')).toBeTruthy();
  });
});

describe('贴底是幂等的（否则会与测量互相触发）', () => {
  it('已经贴着底时不再写 scrollTop；内容真的长高了才贴', async () => {
    seed(12);
    mountDom(<Transcript tabId={TAB} />);
    const el = scroller();
    fakeGeometry(el, 2000, 400); // 几何要在"贴底那一帧"之前装好
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '组件应当已经贴到底').toBe(1600);

    const sets = (el as unknown as { __sets: () => number }).__sets;
    const reset = (el as unknown as { __resetSets: () => void }).__resetSets;
    const append = async (text: string, ts: number) => {
      await act(async () => {
        useMessages.getState().applyCommit(TAB, {
          type: 'message_end',
          message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: ts },
        } as never);
        await new Promise((r) => setTimeout(r, 20));
      });
    };

    // 重渲染（新消息到达）但内容没长高：已经在底部 → 一次都不该写 scrollTop
    reset();
    await append('又一句', 9001);
    expect(sets(), '已经贴底还去写 scrollTop —— 会与虚拟化器的测量互相触发').toBe(0);

    // 真的长高了（流式）：这次必须贴
    reset();
    Object.defineProperty(el, 'scrollHeight', { value: 2400, configurable: true });
    await append('再一句', 9002);
    expect(sets(), '内容长高后没贴住').toBeGreaterThan(0);
    expect(el.scrollTop).toBe(2000);
  });
});

describe('向下续页（换窗之后往下滚不再撞墙）', () => {
  const OUTLINE = [
    { turn: 1, start: 10, end: 30, prompt: '第一轮', response: '' },
    { turn: 2, start: 30, end: 50, prompt: '第二轮', response: '' },
    { turn: 3, start: 50, end: 70, prompt: '第三轮', response: '' },
    { turn: 4, start: 70, end: 90, prompt: '第四轮', response: '' },
  ];

  it('滚到窗口底部附近：用 endOffset 取下一页并**接在后面**（不换窗）', async () => {
    // 窗口 = 前两轮，下面还有更新的（hasNewer）
    seedOffsets(2, 10, { cursor: 10, hasMore: true, hasNewer: true, end: 30 });
    useMessages.getState().setOutline(TAB, OUTLINE);
    invokeMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'session_page') {
        expect(args.after).toBe(30); // 向下续页的游标
        expect(args.before).toBeUndefined();
        return { ...page(30, 50, true, false), endOffset: 90 };
      }
      if (name === 'session_outline') return { turns: OUTLINE, totalBytes: 100 };
      return {};
    });
    mountDom(<Transcript tabId={TAB} />);
    await flush();

    // 换窗状态下同时给「继续往下」与「回到最新」
    const newer = q<HTMLButtonElement>('[data-load-newer]')!;
    expect(newer).toBeTruthy();
    expect(q('[data-to-latest]')).toBeTruthy();

    await act(async () => {
      newer.click();
      await new Promise((r) => setTimeout(r, 60));
    });

    // ⚠️ 光追加是不够的：视口不动的话用户看到的是"点了没反应"（真机反馈）。
    // 新内容的第一行必须是**原来的行数**（= 追加的第一行），并且要滚过去。
    expect(scrollToIndex).toHaveBeenCalled();
    expect(scrollToIndex.mock.calls.at(-1)![0]).toBe(2);

    const tab = useMessages.getState().tabs[TAB]!;
    // 原来 2 行 + 这一页 20 行 = 22 行（**接在后面**，不是换窗）
    expect(tab.ids).toHaveLength(22);
    expect(tab.hasNewer, '续到尾部之后 hasNewer 要转 false').toBe(false);
    expect(tab.windowEnd).toBe(90);
  });

  it('滚轮往下推：窗口底部附近自动续页；离得远时不动', async () => {
    seedOffsets(2, 10, { cursor: 10, hasMore: true, hasNewer: true, end: 30 });
    useMessages.getState().setOutline(TAB, OUTLINE);
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'session_page') return { ...page(30, 50, true, false), endOffset: 90 };
      if (name === 'session_outline') return { turns: OUTLINE, totalBytes: 100 };
      return {};
    });
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    const el = scroller();
    fakeGeometry(el, 1200, 400); // 内容 1200，视口 400

    /** 滚轮手势（组件只认 wheel：程序化滚动不许触发续页，否则会级联读完整段）。 */
    const wheel = async () => {
      await act(async () => {
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: 300, bubbles: true }));
        await new Promise((r) => setTimeout(r, 40));
      });
    };

    // 距底 100px（< 240 的触发线）→ 一次滚轮续一页
    await scrollTo(el, 700);
    await wheel();
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'session_page')).toHaveLength(1);
    expect(useMessages.getState().tabs[TAB]!.ids).toHaveLength(22);

    // 距底很远（> 240）→ 滚轮也不续（用户还没滚到底）
    useMessages.getState().hydratePage(TAB, [{ ...row(10), offset: 10 }] as never[], {
      cursor: 10,
      hasMore: true,
      hasNewer: true,
      end: 30,
    });
    await scrollTo(el, 100);
    await wheel();
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'session_page')).toHaveLength(1);
  });

  it('程序化滚动**不许**触发续页（否则会级联把整段读进来）', async () => {
    seedOffsets(2, 10, { cursor: 10, hasMore: true, hasNewer: true, end: 30 });
    useMessages.getState().setOutline(TAB, OUTLINE);
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'session_page') return { ...page(30, 50, true, false), endOffset: 90 };
      if (name === 'session_outline') return { turns: OUTLINE, totalBytes: 100 };
      return {};
    });
    mountDom(<Transcript tabId={TAB} />);
    await flush();
    const el = scroller();
    fakeGeometry(el, 1200, 400);
    // 反复"贴到底部"（程序化）：一次都不该续页
    for (let i = 0; i < 5; i += 1) await scrollTo(el, 800);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === 'session_page'),
      '程序化滚动触发了续页 —— 会自我级联',
    ).toHaveLength(0);
  });
});
