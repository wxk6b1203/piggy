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

const { invokeMock, scrollToIndex, scrollerSize, vwindow, busListen } = vi.hoisted(() => {
  /** 一个可订阅的小信号（"值变了 → 重渲染"，同真实虚拟化器的 `onChange`）。 */
  const signal = <T,>(initial: T) => {
    const listeners = new Set<() => void>();
    return {
      value: initial,
      subscribe(l: () => void) {
        listeners.add(l);
        return () => {
          listeners.delete(l);
        };
      },
      set(next: T) {
        this.value = next;
        for (const l of [...listeners]) l();
      },
    };
  };
  /* 滚动容器的实测高度（真机由虚拟化器**内部**那个 ResizeObserver 报：
     面板被 dockview 摘出 DOM 时 0，回到前台时 622 —— 门禁实测 622→0→622）。
     这里复刻"RO 报新尺寸 → 虚拟化器重渲染"这一步，测试用 `setScrollerSize` 驱动。 */
  const size = signal({ height: 0 });
  /* 渲染窗口（真机 = 视口 + overscan 算出来的那一截）。
     默认全渲染（老用例不需要窗口）；要造"实时行被滚出窗口"的场景就 `vwindow.set(0, 5)`。 */
  const win = signal({ from: 0, to: Number.POSITIVE_INFINITY });
  /* Tauri `listen` 的回调表：`tabEvents` 的接线要**真的**被走到（实时块的一轮边界
     在事件层判，见 `lib/tabEvents`），所以测试用 `emitBus` 从这条通道推事件。 */
  const bus = new Map<string, (e: { payload: unknown }) => void>();
  return { invokeMock: vi.fn(), scrollToIndex: vi.fn(), scrollerSize: size, vwindow: win, busListen: bus };
});
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
vi.mock('@tanstack/react-virtual', async () => {
  const React = await import('react');
  return {
    useVirtualizer: ({
      count,
      estimateSize,
      getItemKey,
    }: {
      count: number;
      estimateSize: (i: number) => number;
      getItemKey: (i: number) => string | number;
    }) => {
      // 订阅实测高度：变了就重渲染（真虚拟化器走 `onChange` → rerender，同义）
      const height = React.useSyncExternalStore(scrollerSize.subscribe, () => scrollerSize.value.height);
      // 渲染窗口：不给窗口就全渲染（老用例的口径不变）
      const win = React.useSyncExternalStore(vwindow.subscribe, () => vwindow.value);
      const startOf = (index: number) =>
        Array.from({ length: index }, (_, i) => estimateSize(i)).reduce((a, b) => a + b, 0);
      return {
        getTotalSize: () => count * estimateSize(0),
        // `key` 必须是**行键**（组件把 `getItemKey` 传进来了）：读者锚点按行键找回下标，
        // mock 里若拿下标当键，那条路径就永远走不到（假绿）。
        getVirtualItems: () => {
          const from = Math.max(0, win.from);
          const to = Math.min(count - 1, win.to);
          return Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k).map((index) => ({
            index,
            key: getItemKey(index),
            start: startOf(index),
            size: estimateSize(index),
          }));
        },
        getOffsetForIndex: (index: number) => [startOf(index)] as const,
        measureElement: () => {},
        measure: () => {},
        scrollRect: { width: 0, height },
        scrollToIndex,
      };
    },
  };
});

import { Transcript } from '@/features/chat/Transcript';
import { ensureTabListeners } from '@/lib/tabEvents';
import { useAppConfig } from '@/stores/appConfig';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const q = <T extends Element>(sel: string) => domContainer().querySelector<T>(sel);
const TAB = 'tab-page';
const FILE = '/tmp/s.jsonl';

/** 手动设渲染窗口（真机由虚拟化器按视口+overscan 算，见 mock 的说明）。 */
async function setWindow(from: number, to: number) {
  await act(async () => {
    vwindow.set({ from, to });
    await new Promise((r) => setTimeout(r, 10));
  });
}

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


function scroller(): HTMLDivElement {
  const el = q<HTMLDivElement>('.pg-transcript');
  if (!el) throw new Error('找不到转录滚动容器');
  return el;
}

/**
 * 装上假几何，并让**虚拟化器报出同样的可视高度**。
 *
 * 真机上这两个数是同一个元素的（虚拟化器内部那个观察者量的就是它），而"布局回来没回来"
 * 这条信号由虚拟化器提供（见 `useTranscriptScroll` 的收尾 effect）——
 * 所以测试也必须两个一起给，否则量到的是"面板不在前台"那一幕。
 */
async function setGeometry(el: HTMLElement, scrollHeight = 2000, clientHeight = 400) {
  fakeGeometry(el, scrollHeight, clientHeight);
  await setScrollerSize(clientHeight);
}

/** 面板可见性：滚动容器有没有真实布局（见 `scrollerSize` 的说明）。 */
async function setScrollerSize(height: number) {
  await act(async () => {
    scrollerSize.set({ height });
    await new Promise((r) => setTimeout(r, 10));
  });
}

/** 从 `pi:commit:{tab}` 通道推一条事件（走 `tabEvents` 的真实接线）。 */
async function emitCommit(ev: Record<string, unknown>) {
  await act(async () => {
    busListen.get(`pi:commit:${TAB}`)?.({ payload: ev });
    await new Promise((r) => setTimeout(r, 10));
  });
}

/** 从 `pi:frame:{tab}` 通道推一帧（走 `tabEvents` 的真实接线）。 */
async function emitFrame(frame: Record<string, unknown>) {
  await act(async () => {
    busListen.get(`pi:frame:${TAB}`)?.({ payload: frame });
    await new Promise((r) => setTimeout(r, 10));
  });
}

/** 派发一次滚动（React 的 scroll 监听是非 passive 的普通监听，可直接触发）。 */
async function scrollTo(el: HTMLElement, top: number) {
  await act(async () => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll', { bubbles: false }));
    /* 真浏览器在一次滚动停下来之后会发 `scrollend` —— 跟随意图就是在那时结算的
       （DSH 的 `ChatReading.onScrollEnd`）。少了它，测试量到的是"采样窗口还没到"的中间态。 */
    el.dispatchEvent(new Event('scrollend'));
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
  scrollerSize.value = { height: 0 }; // jsdom 没有布局，默认与"面板不在前台"的读数一致
  vwindow.value = { from: 0, to: Number.POSITIVE_INFINITY };
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
    await setGeometry(el);
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
    await setGeometry(el);
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
    await setGeometry(el);
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
    await setGeometry(el, 2000, 400); // 几何要在"贴底那一帧"之前装好
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '组件应当已经贴到底').toBe(1600);
    // 还在跟随时，当前轮次是最后那一轮
    expect(q('[data-rail-mark].is-active')?.getAttribute('data-rail-mark')).toBe('40');

    // 模拟流式：内容先长高 400px，随后那次 scroll 事件才被处理（位置仍是我们设的 1600）
    await setGeometry(el, 2400, 400);
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
    await setGeometry(el, 2000, 400);
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop).toBe(1600);

    await scrollTo(el, 100); // 位置变了 = 读者滚的
    expect(q('[data-to-bottom]')).toBeTruthy();
  });
});

describe('面板不在前台（被 dockview 摘出 DOM）时的几何', () => {
  /**
   * 用户 2026-09-23 报："从一个正在运行的会话切到另一个会话，不是在最低位，
   * 而是在当前页的高位，而且有时候滚动位置怪怪的。"
   *
   * 现场（门禁实测）：dockview 把非活动面板的内容**摘出 DOM**（组件不卸载），
   * 此时 `scrollTop / scrollHeight / clientHeight` 三个读数全是 0。于是
   *   ① 打开会话那一次 rAF 贴底、以及"总高变化"那条布局 effect，都可能落在
   *      "没有布局"的时刻变成空操作（视图就一直停在那一页的高位）；
   *   ② 更坏的是"跟随意图"：`gap = 0 - 0 - 0 = 0` 会被读成"已经贴着底"，
   *      把 `pinnedTop/pinnedHeight` 记成一对 0；等面板回到前台，第一次采样
   *      因为"没有可靠基线"直接把跟随判死（`nextFollowingFromSample` 的口径），
   *      于是它**再也不跟着走了**。
   */
  it('隐藏期间内容长好：不许写 scrollTop、不许丢掉跟随；回到前台必须贴底', async () => {
    seed(30);
    mountDom(<Transcript tabId={TAB} />);
    const el = scroller();
    // 被摘出 DOM：三个读数都是 0（真机实测），先按这个状态挂载
    await setGeometry(el, 0, 0);
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '没有布局还去写 scrollTop').toBe(0);

    // 后台继续长（流式/新消息）——真机上这一步会触发重渲染 → 布局 effect 里的贴底
    await act(async () => {
      useMessages.getState().applyCommit(TAB, {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '后台长出来的' }], timestamp: 99_001 },
      } as never);
      await new Promise((r) => setTimeout(r, 20));
    });
    // 摘出去的那一刻也会来一次滚动事件（位置被浏览器钳成 0）：不许因此交出跟随
    await scrollTo(el, 0);
    expect(q('[data-to-bottom]'), '跟随意图被一对 0 的假基线判死了').toBeNull();

    // 回到前台：元素自己保住了位置（0），但内容已经长高 → 必须贴到**新的**底
    await setGeometry(el, 2640, 400);
    await setScrollerSize(400);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '回到前台没有贴底（用户看到的就是"停在当前页高位"）').toBe(2240);
    expect(q('[data-to-bottom]')).toBeNull();
  });

  it('读者接管过：面板回来必须把位置还给他（浏览器不会还）', async () => {
    seed(30);
    mountDom(<Transcript tabId={TAB} />);
    const el = scroller();
    await setGeometry(el, 2640, 400);
    await flush();
    await setScrollerSize(400);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '打开即贴底').toBe(2240);

    await scrollTo(el, 300); // 读者往上滚（位置 300，锚在"顶端的行"上）
    expect(q('[data-to-bottom]')).toBeTruthy();

    // 面板被摘出去（几何全 0）→ 回来。⚠️ 位置**不会**自己回来：实测 Chrome 把摘出
    // 文档的元素再挂回来时 scrollTop 归 0（只有 display:none 才保留），所以这里
    // 显式把它按浏览器的行为清掉 —— 组件必须靠自己的锚点记回来。
    await setGeometry(el, 0, 0);
    await setScrollerSize(0);
    await setGeometry(el, 2640, 400);
    el.scrollTop = 0;
    await setScrollerSize(400);
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '读者接管了还去贴底 = 把他正在读的地方拽走；不还 = 回到这一页的高位').toBe(300);
    expect(q('[data-to-bottom]'), '回到前台后「回到底部」还得在').toBeTruthy();
  });
});

describe('贴底是幂等的（否则会与测量互相触发）', () => {
  it('已经贴着底时不再写 scrollTop；内容真的长高了才贴', async () => {
    seed(12);
    mountDom(<Transcript tabId={TAB} />);
    const el = scroller();
    await setGeometry(el, 2000, 400); // 几何要在"贴底那一帧"之前装好
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
    await setGeometry(el, 1200, 400); // 内容 1200，视口 400

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
    await setGeometry(el, 1200, 400);
    // 反复"贴到底部"（程序化）：一次都不该续页
    for (let i = 0; i < 5; i += 1) await scrollTo(el, 800);
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === 'session_page'),
      '程序化滚动触发了续页 —— 会自我级联',
    ).toHaveLength(0);
  });
});

/**
 * 流式那一行与虚拟化的交接（2026-09-24 重整之后的等价口径）。
 *
 * 起因（用户 2026-09-23 报「有时候不会滚动输出，会等到完成后再全部输出」）：
 * 实时行是转录的**最后一行**，由虚拟化渲染。读者往上滚出窗口、或它在窗口外时这一轮开始流式，
 * 这个节点就会被卸载。旧实现把文本写进 DOM 节点，节点一换就写到了看不见的地方
 * —— 界面上那一行从那一刻起空着，直到 `message_end` 把整段消息交给 store 才一次性出现。
 *
 * 现在**内容在 store 里**（`stores/messages` 的 `live` 槽位），DOM 只是它的视图：
 * 行被卸载多少次都无所谓，重新渲染时按槽位重建。这里把"渲染窗口"当成虚拟化器
 * （真机 = 视口 + overscan），确定性地造出那次卸载/重挂。
 */
describe('流式那一行被虚拟化卸载再挂回来', () => {
  it('卸载期间的字一个不丢，重新渲染时按槽位重建', async () => {
    seed(30);
    mountDom(<Transcript tabId={TAB} />);
    await setScrollerSize(400);
    await flush();
    await ensureTabListeners(TAB);

    await emitCommit({ type: 'agent_start' });
    await emitCommit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await flush();
    await emitFrame({ text: [{ contentIndex: 0, delta: '前半段' }] });
    expect(q('.pg-md-streaming')?.textContent).toContain('前半段');

    // 读者往上滚：实时那一行离开渲染窗口（真机 = 虚拟化把它卸载）
    await setWindow(0, 5);
    expect(q('.pg-md-streaming')).toBeNull();
    // 不在窗口里的帧照收（内容进 store，不依赖 DOM）
    await emitFrame({ text: [{ contentIndex: 0, delta: '中间段' }] });

    // 回到底部：那一行重新渲染 —— 文本必须原样在这儿（不是从节点里读，是从 store 里读）
    await setWindow(0, Number.POSITIVE_INFINITY);
    expect(q('.pg-md-streaming')?.textContent, '重挂之后流式的字不在了').toContain('前半段中间段');
    await emitFrame({ text: [{ contentIndex: 0, delta: '后半段' }] });
    expect(q('.pg-md-streaming')!.textContent).toContain('前半段中间段后半段');
  });

  it('新一轮开始：上一轮的流式内容不会漏到这一轮（边界在**事件层**）', async () => {
    seed(4);
    mountDom(<Transcript tabId={TAB} />);
    await setScrollerSize(400);
    await flush();
    await ensureTabListeners(TAB);
    await emitCommit({ type: 'agent_start' });
    await emitCommit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await emitFrame({ text: [{ contentIndex: 0, delta: '上一轮' }] });
    expect(q('.pg-md-streaming')?.textContent).toContain('上一轮');

    // 上一轮没有 message_end（异常路径）就开始了新一轮：累积文本属于**新的一行**
    await emitCommit({ type: 'agent_start' });
    await emitCommit({ type: 'message_start', message: { role: 'assistant', content: [] } });
    await flush();
    await emitFrame({ text: [{ contentIndex: 0, delta: '这一轮' }] });
    const texts = Array.from(domContainer().querySelectorAll('.pg-md-streaming')).map((el) => el.textContent);
    expect(texts.join('|')).toContain('这一轮');
    expect(texts.join('|'), '两轮的流式文本串在了一起').not.toMatch(/上一轮.*这一轮/);
  });
});

/**
 * 流式中"手动往上滚"必须真的把控制权拿走（用户 2026-09-23 报：
 * "一直向下滚动，我希望手动向上翻滚时，不会被自动跳到最底下"）。
 *
 * 这条现在**完全按 DSH 的口径**判，没有自定义规则：
 *
 * ```
 * 读者动过（movedByReader）→ 采样（scrollend 或 500ms）→ following = 离底 ≤ 25px ?
 * 采样窗口内（pending）        → 谁都不许贴底（连内容长高也不行）
 * ```
 *
 * 关键在于"离底"用的是**采样那一刻**的几何：流式时内容每 16ms 长高一次，读者的位移
 * 一旦被内容推得超过容差，`nearBottom` 就是假 —— 跟随当场交还。真浏览器实测（旧实现）：
 * 判据是"内容比上次采样更高 → 继续跟随"，于是每次采样都命中那条规则，`gap` 恒为 0、
 * 位置一路被内容推着走，滚轮在手感上完全没反应。
 */
describe('流式中的回滚：DSH 的采样口径', () => {
  function seedRows(n: number) {
    useMessages.getState().hydratePage(
      TAB,
      Array.from({ length: n }, (_, i) => ({ ...row(i, i % 2 === 0 ? 'user' : 'assistant'), offset: i })) as never[],
      { cursor: 0, hasMore: false },
    );
  }

  /** 真滚轮（jsdom 不会自己滚，所以手势与位置分开造：先 wheel，再改位置 + 派发 scroll/scrollend）。 */
  async function wheelUp(el: HTMLElement, deltaY: number) {
    await act(async () => {
      el.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: false }));
      await new Promise((r) => setTimeout(r, 10));
    });
  }

  it('往上滚之后交还控制权，内容继续长高也不许把读者拽回底部', async () => {
    seedRows(40);
    mountDom(<Transcript tabId={TAB} />);
    const el = scroller();
    await setGeometry(el, 2000, 400);
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '组件应当已经贴到底').toBe(1600);

    // 流式中：内容先长高，读者同时往上滚（位移远超容差 → 采样判"不跟"）
    await setGeometry(el, 3400, 400);
    await wheelUp(el, -300);
    await scrollTo(el, 1300);
    expect(q('[data-to-bottom]'), '读者滚上去了，跟随却没交还（下一帧就会被拽回底部）').toBeTruthy();

    // 内容继续长高 + 新消息落地：位置必须留在读者那里
    const keep = el.scrollTop;
    await setGeometry(el, 4200, 400);
    await scrollTo(el, keep);
    await act(async () => {
      useMessages.getState().applyCommit(TAB, {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '新落地的一段' }], timestamp: 4242 },
      } as never);
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '内容一长高/新消息一到就把读者拽回了底部').toBe(keep);
    expect(q('[data-to-bottom]'), '交还之后按钮不许自己消失').toBeTruthy();
  });

  it('容差就是容差：离底 ≤25px 的位移仍算跟随（DSH `nearBottom`），超了就交还', async () => {
    seedRows(40);
    mountDom(<Transcript tabId={TAB} />);
    const el = scroller();
    await setGeometry(el, 2000, 400);
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop).toBe(1600);

    // ① 容差内：离底 20px，采样之后仍算"贴着底"，不出现「回到底部」
    await scrollTo(el, 1580);
    expect(q('[data-to-bottom]'), '距底 20px 应当仍算贴着底').toBeNull();

    // ② 超容差：离底 40px → 采样判定交还
    await scrollTo(el, 1560);
    expect(q('[data-to-bottom]'), '离底 40px 之后跟随没交还').toBeTruthy();

    // ③ 交还之后，内容继续长高也不许把读者拽回底部（用户报的那件事）
    const keep = el.scrollTop;
    await setGeometry(el, 3800, 400);
    await scrollTo(el, keep);
    await act(async () => {
      useMessages.getState().applyCommit(TAB, {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '又一段' }], timestamp: 4444 },
      } as never);
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '交还之后内容一长高又把读者拽回去了').toBe(keep);
  });

  it('滚回底部之后跟随自己回来（下一次长高又贴底）', async () => {
    seedRows(40);
    mountDom(<Transcript tabId={TAB} />);
    const el = scroller();
    await setGeometry(el, 2000, 400);
    await flush();
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    await wheelUp(el, -300);
    await scrollTo(el, 1000);
    expect(q('[data-to-bottom]')).toBeTruthy();

    // 读者滚回底部（还在手势窗口内）：跟随应当自己回来
    await scrollTo(el, 1600);
    expect(q('[data-to-bottom]'), '滚到底了跟随却没回来').toBeNull();

    // 再长高 → 又贴到新的底
    await setGeometry(el, 2400, 400);
    await act(async () => {
      useMessages.getState().applyCommit(TAB, {
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text: '又一段' }], timestamp: 4343 },
      } as never);
      await new Promise((r) => setTimeout(r, 20));
    });
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    });
    expect(el.scrollTop, '跟随回来了却没贴到新的底').toBe(2000);
  });
});
