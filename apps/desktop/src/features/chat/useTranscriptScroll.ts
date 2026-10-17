/**
 * 转录的**阅读策略 + 历史导航**（DSH `use-chat-scroll.ts` + `use-chat-reading.ts` +
 * `use-chat-navigation.ts` 三个文件的合并移植）。
 *
 * 职责边界（与 DSH 逐条对应）：
 *
 * | 这里 | DSH | 管什么 |
 * |---|---|---|
 * | `followTail` / `pauseFollowing` / 采样 | `ChatReading` | 跟不跟尾部、读者读到哪一行 |
 * | `loadEarlier` / `jumpToTurn` / 跳转对账 | `ChatNavigation` | 往上翻页、跳到某一轮 |
 * | `reconcile` | `useChatScroll.processContent` | **每次内容提交后谁说了算** |
 *
 * 位置读写与几何全在 `TranscriptViewport`，跟不跟的判定在 `ScrollFollow`；
 * 这里只做**决策**，所以整份文件里没有一处直接写 `scrollTop`。
 *
 * ## 为什么是一个类
 *
 * 决策要跨调用记四件事：采样定时器、上滚手势、读者锚点、正在等的跳转。它们既不该进
 * React state（滚动采样不该引起渲染），又互相调用（采样落地要决定"要不要再排一次"）。
 * 用 `useCallback` 拼会立刻掉进"互相依赖、声明顺序、依赖数组写不全"的坑里 ——
 * DSH 用类正是为了这个（`ChatReading` / `ChatNavigation` 都是类，只在状态变化时
 * `onChange(state)` 通知 React）。这里照抄那个形状。
 *
 * ## 归因与意图都照 DSH，一处不改
 *
 * 早期版本在这里加过一条 DSH 没有的规则：**滚轮往上就当场交还控制权**，并在 400ms 的
 * 兑现窗口内不许被"贴着底"的容差反悔。那是为一个用户反馈打的补丁
 * （"一直向下滚动，我希望手动向上翻滚时，不会被自动跳到最底下"）—— 但 DSH 的采样本来
 * 就解决它：读者的位移一旦超出容差，`sample()` 就会把意图判成"不跟"；而**手势窗口内**
 * 内容长高也不会贴底（`onResize` 见到 pending 直接返回）。
 * 现在这条补丁删掉了：跟随意图**只**由 `ScrollFollow.sample()` 按几何判，滚轮只用来
 * 放掉翻页锚点（DSH 的 `interact`）与触发 Piggy 自己的向下续页。
 *
 * 唯一保留的 Piggy 专有物是 `maybeLoadNewer`：**向下续页只认滚轮**。
 * DSH 的分页由宿主驱动（`loadOlder`/`loadThrough`），没有"滚到底自动续一页"这个概念，
 * 所以这里没有可对标的对象；而挂在 `scroll` 上会自我级联（续页 → 内容变 → 再续页，
 * 实测一跳就把 200 行全读进来），隐藏面板 `clientHeight === 0` 时距离恒为 0，同样级联。
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { toast } from '@/lib/feedback';
import type { ReadingPosition } from '@/lib/readingPosition';
import { loadNewer, loadOlder, loadTail, loadWindowAt } from '@/lib/transcriptPage';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { findRowIndexByOffset, type RailItem, type RailSourceRow } from './turnRailItems';
import { FOLLOW_THRESHOLD_PX, scrollTopAfterPrepend, type ReaderAnchor } from './transcriptScroll';
import { useScrollFollow, type ScrollFollow, type ViewportScroll } from './scrollFollow';
import type { TranscriptViewport, ViewportLanding, ViewportEvents } from './transcriptViewport';

/**
 * 读者滚动的采样间隔（DSH `SCROLL_SAMPLE_INTERVAL_MS`）。
 *
 * 为什么不当场结算：一次小幅度手势之后，**位置还会被后续的布局变化改写**
 * （内容长高、行被测量、浏览器滚动锚定）。等一个采样窗口（或 `scrollend`）再判，
 * 判据才是"读者停在哪"，而不是"某一帧恰好读到哪"。
 */
const SAMPLE_INTERVAL_MS = 500;

/** 一次"跳到未载入的那一轮"（DSH `TurnJump`）。 */
interface TurnJump {
  turn: number;
  /** 目标轮用户消息在文件里的起始偏移（落位要按它找行下标） */
  anchorStart: number | null;
  phase: 'loading' | 'settled';
}

/** React 可见的那一小部分阅读状态（其余全在类里，滚动不该引起渲染）。 */
export interface ReadingState {
  /** 已经落过位（刻度梯挂载、交互按钮都要等它） */
  initialized: boolean;
  following: boolean;
  /** 阅读线所在的行下标（`null` = 贴底或还没算出来） */
  readingRow: number | null;
}

/** 从 store 的一个 tab 里取出刻度需要的行原料（DSH 的 `RailSourceRow`）。 */
export function railRowsFor(tabId: string): RailSourceRow[] {
  const tab = useMessages.getState().tabs[tabId];
  if (!tab) return [];
  return tab.ids.map((id) => {
    const row = tab.byId[id];
    return {
      role: row?.role ?? '',
      content: (row?.message as { content?: unknown })?.content,
      offset: row?.offset ?? null,
    };
  });
}

/**
 * 跨重启的位置存取（docs/04 §2.1.7）。
 *
 * 由 `Transcript` 提供（它才知道会话文件路径与"偏移 → 行 id"的映射），
 * 阅读层只负责"什么时候存/取"。没给端口时行为与从前一样（不记不还）。
 */
export interface ReadingPositionPort {
  /** 读这个会话上次读到的位置 */
  read(): ReadingPosition | null;
  /** 记下当前位置（`null` = 贴着底） */
  save(anchor: ReaderAnchor | null): void;
  /** 把"存下来的偏移"翻译成当前窗口里的行键；不在窗口里返回 null */
  resolve(saved: ReadingPosition): string | null;
}

/** 会话的当前状态（内容信号 + 分页状态），每次渲染刷新。 */
export interface TranscriptScrollInput {
  tabId: string;
  /** 第一页灌进来了 */
  ready: boolean;
  /** 已载入的行数（内容提交的信号之一） */
  rowCount: number;
  /** 内容层总高（虚拟化器报的；行被测量、消息到达都会变） */
  totalSize: number;
  /** 滚动容器的真实高度（虚拟化器的 `scrollRect.height`；摘出 DOM 时为 0） */
  layoutHeight: number;
  hasMore: boolean;
  loadingOlder: boolean;
  hasNewer: boolean;
  loadingNewer: boolean;
  /** 跨重启的阅读位置（缺省 = 不记不还） */
  positions?: ReadingPositionPort | undefined;
}

export class TranscriptReading {
  private sampleTimer: number | null = null;
  private probeFrame: number | null = null;
  /** 贴底之后的**一帧补偿**（见 `scheduleSettle`） */
  private settleFrame: number | null = null;
  /** 上一轮补偿时的剩余差（防"怎么补都补不上"时每帧空转） */
  private settleGap = Number.POSITIVE_INFINITY;
  /** 读者接管之后"读到哪了"（面板被摘出 DOM 再回来时还给他）。 */
  private anchor: ReaderAnchor | null = null;
  /** 往上翻页时的高度差兜底（锚点行找不到时才用）。 */
  private pagingFallback: { scrollTop: number; scrollHeight: number } | null = null;
  /** 正在等的跳转。 */
  private jump: TurnJump | null = null;
  private state: ReadingState = { initialized: false, following: true, readingRow: null };
  private input: TranscriptScrollInput;
  private readonly onBusyTurn: (turn: number | null) => void;

  constructor(
    private readonly viewport: TranscriptViewport,
    private readonly follow: ScrollFollow,
    input: TranscriptScrollInput,
    private readonly onChange: (state: ReadingState) => void,
    onBusyTurn: (turn: number | null) => void,
  ) {
    this.input = input;
    this.onBusyTurn = onBusyTurn;
  }

  /** 采纳最新的会话状态（不触发任何读写）。 */
  setInput(input: TranscriptScrollInput): void {
    this.input = input;
  }

  dispose(): void {
    this.cancelPending();
    if (this.settleFrame !== null) {
      cancelAnimationFrame(this.settleFrame);
      this.settleFrame = null;
    }
    this.onBusyTurn(null);
  }

  /* ── 阅读策略（DSH `ChatReading`）────────────────────────────────────── */

  /** 贴底：位置是权威的，不需要锚点。 */
  followTail(): void {
    const landing = this.viewport.scrollToBottom(this.follow);
    if (!landing) return; // 没有布局（面板被摘出 DOM）：一个像素都不写
    this.cancelPending();
    this.anchor = null;
    /* 主动回到最新 = 明确的"贴底"意图：跨重启的位置也该是贴底。
       ⚠️ 但**只在我们已经决定过落点之后**才写：打开会话的头几帧里
       `ResizeObserver`（行被测量）会先于落点判定走到这里，此时写 `null` 会把
       "上次读到中间"那条记录**当场抹掉** —— 实测现象是"重载之后永远贴底"。
       `initialized` 正是"落点已定"的标志（`restoreSavedPosition`/`followTail` 都会置它）。 */
    if (this.state.initialized) this.input.positions?.save(null);
    this.publish({ initialized: true, following: true });
    this.scheduleSettle();
  }

  /**
   * 贴底之后**下一帧**再量一次：还差就把最后那点补上。
   *
   * 为什么需要它：`scrollHeight` / `scrollTop` 是**整数**（内容高度可能是 0.5px 的倍数，
   * 比如分隔线 `height: 0.5px`），而不同引擎的钳制/取整不一样（Tauri 在 macOS 上是
   * WebKit）。同一帧里"内容刚长高、位置刚写下去"之后再被人重排一次，也会留 1~2px。
   * 这里只在**跟随态 + 采样窗口之外**补一次，最多补到没有差为止（差 ≤0.5px 就不再写）。
   */
  private scheduleSettle(): void {
    if (this.settleFrame !== null) return;
    this.settleFrame = requestAnimationFrame(() => {
      this.settleFrame = null;
      if (!this.state.following || this.sampleTimer !== null) return;
      const scroll = this.viewport.readScroll();
      if (!scroll) return;
      const gap = scroll.metrics.floor - scroll.metrics.top;
      if (gap <= 0.5) {
        this.settleGap = Number.POSITIVE_INFINITY;
        return;
      }
      /* 上一帧补过、这一帧的差没变小 → 说明"再滚也到不了底"（布局/钳制的问题）。
         这时停手：否则每帧写一次 scrollTop、每帧再来一次，白烧 CPU 还查不出原因。 */
      if (gap >= this.settleGap) {
        this.settleGap = Number.POSITIVE_INFINITY;
        return;
      }
      this.settleGap = gap;
      this.followTail();
    });
  }

  /** 交还控制权（读者上滚 / 导航开始 / 换窗）。 */
  pauseFollowing(): void {
    this.cancelPending();
    this.publish({ initialized: true, following: false });
  }

  /** 回到**最新**（换窗的反向操作）：重载尾页并恢复贴底。 */
  returnToLatest(): void {
    const file = useTabs.getState().tabs[this.input.tabId]?.sessionFile ?? null;
    this.follow.setFollowing(true);
    this.publish({ initialized: true, following: true });
    void loadTail(this.input.tabId, file).then(() => {
      this.viewport.invalidate();
      requestAnimationFrame(() => this.followTail());
    });
  }

  /** 把位置还回读者读到的那一行（面板重新出现时用）。 */
  restoreAnchor(): void {
    if (!this.anchor) return;
    const landing = this.viewport.restore(this.anchor);
    if (!landing) return;
    this.publish({ initialized: true, following: this.follow.nearBottom(landing.metrics) });
  }

  /** 采纳一次落位（导航 / 跳转之后）：跟不跟随由**落点**决定。 */
  acceptNavigation(landing: ViewportLanding): void {
    this.cancelPending();
    const following = this.follow.nearBottom(landing.metrics);
    if (following) this.anchor = null;
    else if (landing.position) this.anchor = landing.position;
    this.publish({ initialized: true, following, readingRow: following ? null : landing.rowIndex });
  }

  /* ── 滚动采样 ────────────────────────────────────────────────────────── */

  /** 一次滚动到达（DSH `ChatReading.onScroll` 的同义实现）。 */
  readonly onScroll = (scroll: ViewportScroll): void => {
    if (!scroll.movedByReader) {
      // 位置不是读者挪的：还在跟就立刻贴回新的底（内容长高把底推走了）；
      // 读者在别处读就只刷新阅读线 —— 两种情况都不改跟随意图。
      if (this.state.following) this.followTail();
      else this.refreshReading();
      return;
    }
    // 读者自己滚回了底部 → 跟随自己回来
    if (scroll.metrics.top >= scroll.metrics.floor) {
      this.followTail();
      return;
    }
    // 其余一律等采样落地（500ms 或 `scrollend`）—— 见 `SAMPLE_INTERVAL_MS` 的说明
    this.armSample();
  };

  /** `scrollend`：把还没落地的采样立刻结算（DSH `onScrollEnd`）。 */
  readonly onScrollEnd = (): void => {
    if (this.sampleTimer === null) return;
    this.flushSample();
  };

  /** 内容 / 布局变了（DSH `onResize`）：读者采样优先。 */
  readonly onResize = (): void => {
    /* 落点还没定（打开会话的头几帧）时一个字都不改：`ResizeObserver` 会在 observe 那一刻
       先报一次初始尺寸，那一路走到 `followTail()` 会把 `initialized` 置真，
       于是"还上次读到的位置"（`restoreSavedPosition`）永远不会被执行 —— 症状是
       "重载之后永远贴底"。落点由 `reconcile()` 负责。 */
    if (!this.state.initialized) return;
    if (this.sampleTimer !== null) return;
    if (this.state.following) this.followTail();
    else this.refreshReading();
  };

  /**
   * 滚轮：跟随意图**不由它决定**（DSH 同款：意图只看采样时的几何）。
   * 这里只用它做 Piggy 自己的向下续页（见文件头）。
   */
  readonly onWheel = (deltaY: number): void => {
    if (deltaY > 0) this.maybeLoadNewer();
  };

  /** 读者动手了（拖动滚动条 / 触摸 / 键盘）：翻页补偿的锚点放掉。 */
  readonly onInteract = (): void => {
    this.viewport.stopPaging();
    this.pagingFallback = null;
  };

  /* ── 历史导航（DSH `ChatNavigation`）────────────────────────────────── */

  /**
   * 加载更早一页，并**保住阅读位置**（docs/04 §2.1.1：翻页不许跳）。
   *
   * 顺序不能反：先记锚点行（无几何）与旧几何（兜底）→ await 取页（store 更新）→
   * 内容提交那一次 layout effect 里 `preserve`。
   */
  loadEarlier(): void {
    if (!this.input.hasMore || this.input.loadingOlder) return;
    this.cancelPending();
    this.viewport.stopPaging();
    this.viewport.beginPaging();
    const el = this.viewport.element;
    this.pagingFallback = el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight } : null;
    this.pauseFollowing();
    void loadOlder(this.input.tabId);
  }

  /**
   * 跳到某一轮：已载入的直接滚过去；**没载入的换窗过去**（只读目标那一页）。
   *
   * 与 DSH `navigateToTurn` 的两个分支同构，区别在"取历史"的口径：这里用**换窗**
   * （丢掉旧窗口）而不是往上累加，否则跳到第 1 轮就等于把整段会话读进内存。
   */
  jumpToTurn(item: RailItem): void {
    this.cancelPending();
    this.viewport.stopPaging();
    this.pauseFollowing();
    if (item.loaded && item.rowIndex !== null) {
      const landing = this.viewport.alignToRow(item.rowIndex, 24);
      if (landing) this.acceptNavigation(landing);
      return;
    }
    if (item.anchorEnd === null) return;
    this.jump = { turn: item.turn, anchorStart: item.anchorStart, phase: 'loading' };
    this.onBusyTurn(item.turn);
    void loadWindowAt(this.input.tabId, item.anchorEnd)
      .then((ok) => {
        if (!ok) {
          this.jump = null;
          return;
        }
        if (this.jump) this.jump.phase = 'settled';
        // 换窗会**立即**提交内容：这里主动对一次账（别等下一次内容变化）
        this.reconcile();
      })
      .finally(() => this.onBusyTurn(null));
  }

  /** 点「继续往下」：追加下一页，并把**新内容的第一行**滚到视口顶部（docs/04 §2.1.1）。 */
  continueDown(): void {
    const firstNew = useMessages.getState().tabs[this.input.tabId]?.ids.length ?? 0;
    void loadNewer(this.input.tabId).then((added) => {
      if (added === 0) return;
      this.viewport.invalidate();
      requestAnimationFrame(() => {
        const landing = this.viewport.alignToRow(firstNew, 24);
        if (landing) this.acceptNavigation(landing);
      });
    });
  }

  /* ── 每次内容提交之后：谁说了算（DSH `processContent`）──────────────── */

  /**
   * @returns 是否已经处理了这次内容变化（调用方据此决定要不要再补一帧）
   */
  reconcile(): void {
    // 没有布局时一个字都不改：0/0/0 的读数会把跟随意图判死（docs/15 规矩 101）
    if (!this.input.ready || this.input.layoutHeight <= 0) return;
    if (!this.state.initialized) {
      /* 打开会话的落点（DSH `restore()`）：**上次读到哪就还到哪**，没有才贴底。
         这是跨重启记阅读位置的唯一入口 —— 位置在 `lib/readingPosition` 里按
         "会话文件 + 行字节偏移"存着，重启后行 id 全变了，偏移还对得上。 */
      if (this.restoreSavedPosition()) return;
      this.followTail();
      return;
    }
    if (this.sampleTimer !== null) return; // 读者采样优先于一切自动贴底
    if (this.jump) {
      this.landJump();
      return;
    }
    if (this.input.hasNewer) return; // 换窗态：窗口不在尾部，位置由换窗/续页负责
    if (this.viewport.paging) {
      this.preservePaging();
      return;
    }
    if (this.state.following) this.followTail();
    else this.refreshReading();
  }

  /**
   * 还上次读到的位置。
   *
   * @returns 真的还上了返回 true；没存过 / 行不在窗口里 / 没有布局 → false（调用方贴底）
   */
  private restoreSavedPosition(): boolean {
    const port = this.input.positions;
    const saved = port?.read() ?? null;
    // 上次就是贴着底的：继续贴底（这也是默认）
    if (!port || !saved || saved.following) return false;
    const key = port.resolve(saved);
    if (key === null) return false; // 那一行不在当前窗口（换过页 / 会话被截断）→ 贴底
    const landing = this.viewport.restore({ key, delta: saved.delta, top: 0 });
    if (landing === null) return false;
    this.acceptNavigation(landing);
    return true;
  }

  /** 面板**重新有真实布局**（摘出 DOM 又挂回来）→ 按意图收尾，并补一帧（行高估计→实测）。 */
  settleAfterLayout(): void {
    if (this.input.layoutHeight <= 0 || this.input.hasNewer) return;
    const settle = (): void => {
      if (this.state.following) this.followTail();
      else this.restoreAnchor();
      this.refreshReading();
    };
    settle();
    requestAnimationFrame(settle);
  }

  /* ── 内部 ────────────────────────────────────────────────────────────── */

  private armSample(): void {
    if (this.sampleTimer !== null) return;
    this.sampleTimer = window.setTimeout(() => {
      this.sampleTimer = null;
      this.flushSample();
    }, SAMPLE_INTERVAL_MS);
  }

  /** 采样落地：这时候才重新判定跟随意图（DSH `flushSample`）。 */
  private flushSample(): void {
    const scroll = this.viewport.readScroll();
    if (!scroll) return;
    this.cancelPending();
    const following = this.follow.sample(scroll.metrics, scroll.movedByReader);
    // 不是读者动的、却还在跟（内容把底推走了）：贴回去
    if (!scroll.movedByReader && following) {
      this.followTail();
      return;
    }
    // 读者动过 → 放掉翻页补偿的锚点（DSH `readerSampled` 的同一件事）
    if (scroll.movedByReader) {
      this.viewport.stopPaging();
      this.pagingFallback = null;
    }
    if (following) this.anchor = null;
    else this.anchor = this.viewport.capturePosition() ?? this.anchor;
    /* 采样落地 = 读者意图结算的时刻，也是**记位置**的时刻（DSH 在 `flushSample` 里
       做同一件事）。贴底存 `null`（重开继续贴底），否则存锚点行的字节偏移 + 行内偏移。 */
    this.input.positions?.save(following ? null : this.anchor);
    this.viewport.acknowledge(scroll.metrics);
    this.publish({
      initialized: true,
      following,
      readingRow: this.viewport.readingRow(scroll.metrics),
    });
  }

  /** 阅读线刷新（贴底时用不着：当前就是最后一行）。合并到一帧。 */
  private refreshReading(): void {
    if (this.sampleTimer !== null) return;
    if (this.state.following) {
      this.publish({ initialized: true, readingRow: null });
      return;
    }
    if (this.probeFrame !== null) return;
    this.probeFrame = requestAnimationFrame(() => {
      this.probeFrame = null;
      const row = this.viewport.readingRow();
      if (row !== null) this.publish({ initialized: true, readingRow: row });
    });
  }

  /** 往上翻页之后把阅读位置按行锚点还回去；锚点行没了退回高度差。 */
  private preservePaging(): void {
    const landing = this.viewport.preserve();
    if (landing) {
      this.publish({ initialized: true, readingRow: landing.rowIndex ?? this.state.readingRow });
      return;
    }
    const el = this.viewport.element;
    const before = this.pagingFallback;
    this.viewport.stopPaging();
    this.pagingFallback = null;
    if (!el || !before) return;
    const top = scrollTopAfterPrepend(before, el.scrollHeight);
    if (Math.abs(el.scrollTop - top) > 0.5) el.scrollTop = top;
  }

  /** 跳转对账：窗口换好之后把目标那一轮滚到视口顶端（DSH `reconcile`）。 */
  private landJump(): void {
    const jump = this.jump;
    if (!jump || jump.phase !== 'settled') return;
    this.jump = null;
    const index = findRowIndexByOffset(railRowsFor(this.input.tabId), jump.anchorStart ?? -1);
    if (index === null) {
      toast.info('这一轮没找到（会话文件可能已改变）');
      this.refreshReading();
      return;
    }
    // 行刚进窗口，虚拟化器这一帧才测量它 —— 落位放到下一帧
    requestAnimationFrame(() => {
      const landing = this.viewport.alignToRow(index, 24);
      if (landing) this.acceptNavigation(landing);
    });
  }

  /**
   * 滚轮到底自动续一页（见文件头 ②）。**只由滚轮触发**，不滚动视口
   * （用户自己在滚，替他滚会打架）。
   */
  private maybeLoadNewer(): void {
    const el = this.viewport.element;
    if (!el || el.clientHeight <= 0) return; // 隐藏/未布局：不可能有真实的滚动意图
    const tab = useMessages.getState().tabs[this.input.tabId];
    if (!tab?.hasNewer || tab.loadingNewer) return;
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
    const canScroll = el.scrollHeight > el.clientHeight + 1;
    // 滚到底了，或者窗口内容还不够滚（滚轮推不动）—— 两种都是"我要更多"
    if (gap <= 240 || !canScroll) void loadNewer(this.input.tabId);
  }

  private cancelPending(): void {
    if (this.sampleTimer !== null) window.clearTimeout(this.sampleTimer);
    if (this.probeFrame !== null) cancelAnimationFrame(this.probeFrame);
    this.sampleTimer = null;
    this.probeFrame = null;
  }

  private publish(next: Partial<ReadingState>): void {
    const merged: ReadingState = {
      initialized: next.initialized ?? this.state.initialized,
      following: next.following ?? this.state.following,
      readingRow: next.readingRow === undefined ? this.state.readingRow : next.readingRow,
    };
    this.follow.setFollowing(merged.following); // 意图变化要同步给控制器（它执行）
    if (
      merged.initialized === this.state.initialized &&
      merged.following === this.state.following &&
      merged.readingRow === this.state.readingRow
    ) {
      return;
    }
    this.state = merged;
    this.onChange(merged);
  }
}

export interface TranscriptScroll extends ReadingState {
  /** 正在为哪一轮翻页（刻度梯上的忙碌标记） */
  jumping: number | null;
  /** 交给 `TranscriptViewport.connect` */
  events: ViewportEvents;
  loadEarlier(): void;
  returnToBottom(): void;
  returnToLatest(): void;
  continueDown(): void;
  jumpToTurn(item: RailItem): void;
}

/**
 * 把阅读策略接到 React 生命周期上。
 *
 * @param viewport - 滚动容器属主（DOM 与几何都在它手里）
 * @param input - 会话的当前状态（内容信号 + 分页状态）
 */
export function useTranscriptScroll(
  viewport: TranscriptViewport,
  input: TranscriptScrollInput,
): TranscriptScroll {
  const follow = useScrollFollow(true, FOLLOW_THRESHOLD_PX);
  const [state, setState] = useState<ReadingState>({ initialized: false, following: true, readingRow: null });
  const [jumping, setJumping] = useState<number | null>(null);
  const inputRef = useRef(input);
  inputRef.current = input;
  /* 阅读策略与它的 DOM 接线：都只建一次（类里的方法本身是稳定的箭头函数属性）。 */
  const [core] = useState(() => {
    const reading = new TranscriptReading(viewport, follow, inputRef.current, setState, setJumping);
    const events: ViewportEvents = {
      scroll: reading.onScroll,
      scrollEnd: reading.onScrollEnd,
      resize: reading.onResize,
      interact: reading.onInteract,
      wheel: reading.onWheel,
    };
    return { reading, events };
  });
  // 每次渲染把最新输入喂给类（它只记下来，不触发任何读写）
  core.reading.setInput(input);

  // 业务回调挂到滚动容器上（`Transcript` 先 `attach` 元素，这里再接线）
  useLayoutEffect(() => viewport.connect(core.events), [viewport, core]);

  /* 内容提交 / 布局恢复 → 对账（DSH 的两个 layout effect）。
     ⚠️ 这里只放**结构性**信号（有没有页、行数、布局）——"内容长高了"不在这张表里：
     它由内容层的 `ResizeObserver` 统一上报（见 `TranscriptViewport.attachContent`）。 */
  useLayoutEffect(() => {
    core.reading.reconcile();
  }, [core, input.ready, input.rowCount, input.totalSize, input.layoutHeight, input.hasNewer]);
  // 只在"重新有布局"那一刻收尾；其余内容变化走上面那条 effect
  useLayoutEffect(() => {
    core.reading.settleAfterLayout();
  }, [core, input.layoutHeight]);
  useLayoutEffect(() => () => core.reading.dispose(), [core]);

  return {
    ...state,
    jumping,
    events: core.events,
    loadEarlier: () => core.reading.loadEarlier(),
    returnToBottom: () => core.reading.followTail(),
    returnToLatest: () => core.reading.returnToLatest(),
    continueDown: () => core.reading.continueDown(),
    jumpToTurn: (item) => core.reading.jumpToTurn(item),
  };
}
