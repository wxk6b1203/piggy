/**
 * 转录滚动容器的**DOM 属主**（DSH `ui-chat/src/client/chat/use-chat-viewport.ts` 的移植）。
 *
 * 它只做四件事，一件都不多：
 *   1. 持有滚动元素与监听器（scroll / scrollend / 读者意图 / 滚轮方向）；
 *   2. 读几何（`readScroll` / `topRow` / `readingRow`）；
 *   3. 写位置（`scrollToBottom` / `alignToRow` / `restore` / `preserve`），并把落点记成
 *      "这一次是我们自己设的"（`observation`）—— 归因要用的就是这份记忆；
 *   4. 向上翻页时的**位置补偿**（`beginPaging` / `preserve`）。
 *
 * **它不认识 React，也不认识虚拟化器**：行几何通过 {@link RowGeometry} 注入。
 * DSH 那边直接量 `column.children` 的 `getBoundingClientRect`；Piggy 的转录是虚拟化的，
 * 拿不到"所有行"的 DOM，所以口径统一成"**行键 ↔ 内容坐标**"。
 *
 * ## 为什么行几何要走这一层抽象
 *
 * 虚拟化的行会被卸载，任何"记下这个 DOM 节点"的做法都不成立（历史 bug：记了节点，
 * 行滚出窗口再回来已经是**另一个**节点）。能跨卸载活下来的只有**行键**，于是：
 * 锚点记行键（`capturePosition`），还原时按键找下标、再问起始像素（`restore`）。
 */
import { scrollMetrics, type ScrollFollow, type ViewportMetrics, type ViewportScroll } from './scrollFollow';
import { readerAnchorOf, readerTopFrom, type AnchorRow, type ReaderAnchor } from './transcriptScroll';

/** 虚拟化器交出来的只读几何（Transcript 造一个稳定的适配器）。 */
export interface RowGeometry {
  /** 行键 → 下标；不在窗口里 / 还没测量 → `null` */
  indexOf(key: string): number | null;
  /** 下标 → 该行起始像素（**内容坐标**）；拿不到 → `null` */
  startOf(index: number): number | null;
  /** 当前渲染出来的行（有序） */
  items(): readonly AnchorRow[];
  /** 内容层总高（布局变化的信号） */
  totalSize(): number;
  /**
   * 兜底跳转：行还没测量（我们算不出落点）时交给虚拟化器自己滚
   * （它按估计高度滚过去，测量完再修正）。
   */
  scrollTo?(index: number, offset: number): void;
}

/** 一次落位的结果（DSH `ViewportLanding`）。 */
export interface ViewportLanding {
  readonly metrics: ViewportMetrics;
  /** 落点对应的行下标（知道就带上：刻度梯的"当前轮次"要用） */
  readonly rowIndex: number | null;
  /** 落点对应的读者锚点（知道就带上） */
  readonly position: ReaderAnchor | null;
}

/** 业务回调（DSH `ViewportEvents`，多一个滚轮方向 —— 续页与"读者接管"都靠它）。 */
export interface ViewportEvents {
  scroll(scroll: ViewportScroll): void;
  scrollEnd(): void;
  resize(): void;
  /** 读者开始操作（拖动滚动条 / 触摸 / 键盘）：正在补偿的翻页锚点要放掉 */
  interact(): void;
  /** 滚轮（`deltaY < 0` = 往上）。它是"我要看别处"最干净的信号：程序化滚动不产生它 */
  wheel(deltaY: number): void;
}

/** 读者意图事件（DSH 的 `READING_INTENTS`）。 */
const READING_INTENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown', 'beforematch'] as const;
/** 键盘里哪些键算"滚动"（其余按键交给输入框）。 */
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

/** 向上翻页时要保住的那一行：`delta` = 行顶到视口顶的距离。 */
interface PagingAnchor {
  key: string;
  delta: number;
}

export class TranscriptViewport {
  private scroller: HTMLElement | null = null;
  private geometry: RowGeometry | null = null;
  private events: ViewportEvents | null = null;
  /** 上一次**我们认可的**位置：`movedByReader` 的归因基线（DSH `observation`）。 */
  private observation: { top: number; landing: ViewportLanding | null } = { top: 0, landing: null };
  private _paging: PagingAnchor | null = null;

  /** 绑定滚动元素（`Transcript` 在 layout effect 里调）。 */
  attach(scroller: HTMLElement, geometry: RowGeometry): void {
    this.removeListeners();
    this.scroller = scroller;
    this.geometry = geometry;
    scroller.addEventListener('scroll', this.onScroll, { passive: true });
    scroller.addEventListener('scrollend', this.onScrollEnd, { passive: true, capture: true });
    for (const type of READING_INTENTS) {
      scroller.addEventListener(type, this.onIntent, { passive: true, capture: true });
    }
  }

  /**
   * 解绑（卸载 / 换元素）。
   *
   * ⚠️ **只摘监听器，不动业务回调**：`attach`/`detach` 是元素的生命周期（换元素、重挂），
   * `connect` 是业务的生命周期，两者不同频。早期版本在这里把 `events` 一起清了，
   * 结果是"重新挂载之后再也收不到滚动事件"—— DOM 上一切正常，贴底/按钮/续页却全都不工作。
   */
  detach(): void {
    this.removeListeners();
  }

  /**
   * 只摘监听器（换元素时用）。
   *
   * ⚠️ 与 {@link detach} 分开是因为**顺序**：`attach` 换元素时会先摘旧的，
   * 而业务回调（`connect`）是另一条生命周期 —— 一起断掉的话，重新挂载之后就再也收不到
   * 滚动事件（症状是"贴底、按钮、续页全都不工作"，而 DOM 上一切正常）。
   */
  private removeListeners(): void {
    const el = this.scroller;
    if (el) {
      el.removeEventListener('scroll', this.onScroll);
      el.removeEventListener('scrollend', this.onScrollEnd, true);
      for (const type of READING_INTENTS) el.removeEventListener(type, this.onIntent, true);
    }
    this.scroller = null;
    this.geometry = null;
    this.observation = { top: 0, landing: null };
    this._paging = null;
  }

  /** 接上业务回调（与 DOM 监听分开：卸载监听不等于业务也要断）。 */
  connect(events: ViewportEvents): () => void {
    this.events = events;
    return () => {
      if (this.events === events) this.events = null;
    };
  }

  /** 当前滚动元素（`null` = 还没挂上 / 已卸载 —— 此时**一个位置都不写**）。 */
  get element(): HTMLElement | null {
    return this.scroller;
  }

  /** 有没有一个正在等的翻页锚点。 */
  get paging(): boolean {
    return this._paging !== null;
  }

  /**
   * 丢掉"已知落点"的记忆，保留归因基线。
   *
   * 内容整段换了（翻页 / 换窗 / 行高重测）之后，旧的落点已经不代表任何东西；
   * 但"读者上一次被认可的位置"还得留着，不然下一次采样会被误判成读者滚的。
   */
  invalidate(): void {
    this.observation.landing = null;
  }

  /** 采纳一个位置作为下一次归因的基线（读者自己滚到的地方）。 */
  acknowledge(metrics: ViewportMetrics): void {
    this.observation = { top: metrics.top, landing: null };
  }

  /**
   * 读一次滚动，并归因：**位置变了才算读者滚的**。
   *
   * 比较的是"上一次被认可的位置"（`observation.top`）而不是"上一次滚动事件时的位置"：
   * 内容长高会把 `scrollTop` 留在原处而 `floor` 变大，那不是读者在动。
   */
  readScroll(): ViewportScroll | null {
    const metrics = this.readMetrics();
    if (!metrics) return null;
    return {
      metrics,
      movedByReader: Math.abs(metrics.top - Math.min(this.observation.top, metrics.floor)) > 0.5,
    };
  }

  /** 贴到底（跟随 / 「回到底部」）。 */
  scrollToBottom(follow: ScrollFollow): ViewportLanding | null {
    const el = this.scroller;
    const metrics = this.readMetrics();
    if (!el || !metrics) return null;
    const landing: ViewportLanding = {
      metrics: follow.toBottom(el, metrics, 'instant'),
      rowIndex: this.latestRowIndex(),
      position: null,
    };
    this.observation = { top: landing.metrics.top, landing };
    return landing;
  }

  /**
   * 把某一行对齐到视口顶部往下 `offset` 像素处。
   *
   * @returns 落点；行不在窗口里（还没渲染 / 没测量）时 `null` —— 调用方退到
   *          虚拟化器自己的 `scrollToIndex`，下一帧再对齐一次
   */
  alignToRow(index: number, offset = 24): ViewportLanding | null {
    const metrics = this.readMetrics();
    const start = metrics ? (this.geometry?.startOf(index) ?? null) : null;
    if (!metrics || start === null) {
      // 算不出落点（面板没有布局 / 行没测量）：交给虚拟化器自己滚，落点记不下来
      this.geometry?.scrollTo?.(index, offset);
      return null;
    }
    return this.write(metrics, start - offset, index, this.keyAt(index), start);
  }

  /** 落到"读者上次读到的位置"（锚点行 + 行内偏移）；锚点行没了就退回裸位置。 */
  restore(anchor: ReaderAnchor): ViewportLanding | null {
    const metrics = this.readMetrics();
    if (!metrics) return null;
    const index = this.geometry?.indexOf(anchor.key) ?? null;
    const start = index === null ? null : (this.geometry?.startOf(index) ?? null);
    const target = readerTopFrom(anchor, start, metrics.floor);
    // 锚点行不在时只能按裸位置落，落点就没有行锚点可记（`start` 传 null）
    return this.write(metrics, target, index, start === null ? null : anchor.key, start);
  }

  /** 视口顶端的行（锚点与阅读线的共同基础）。 */
  topRow(scrollTop: number): AnchorRow | null {
    const items = this.geometry?.items() ?? [];
    return items.find((vi) => vi.start + vi.size > scrollTop) ?? items[0] ?? null;
  }

  /**
   * 阅读线所在的行下标（视口顶端往下 1/4，最多 120px）。
   *
   * 口径与旧实现一致（贴顶太灵敏、正中在一轮很长时会乱跳）。虚拟化下比较"行的起始像素"
   * 就够了，不需要 `getBoundingClientRect`。
   */
  readingRow(metrics = this.readMetrics()): number | null {
    if (!metrics) return null;
    const items = this.geometry?.items() ?? [];
    if (items.length === 0) return null;
    const line = metrics.top + Math.min(120, metrics.height / 4);
    let row: number | null = items[0]!.index;
    for (const vi of items) {
      if (vi.start <= line) row = vi.index;
      else break;
    }
    return row;
  }

  /** 已载入窗口的最后一行（贴底时的"当前轮次"）。 */
  latestRowIndex(): number | null {
    const items = this.geometry?.items() ?? [];
    return items.at(-1)?.index ?? null;
  }

  /**
   * 记下"往上翻页时不许动"的那一行（DSH `beginPaging`）。
   *
   * 取**当前渲染出来的第一行**：它就在视口顶端，翻页之后必须还在原地。
   * 记的是"行顶到视口顶的距离"而不是像素快照 —— 翻页后按这个差反解新的 `scrollTop`。
   */
  beginPaging(): void {
    this._paging = null;
    const metrics = this.readMetrics();
    const first = metrics ? this.topRow(metrics.top) : null;
    if (!metrics || !first) return;
    this._paging = { key: String(first.key), delta: metrics.top - first.start };
  }

  /** 放掉翻页锚点（读者自己动手了 / 导航开始了）。 */
  stopPaging(): void {
    this._paging = null;
  }

  /**
   * 翻页之后把阅读位置还回去（DSH `preserve`）。
   *
   * 锚点行现在的起始像素是 `start`，要让它与视口顶端的距离仍是 `delta`：
   * `scrollTop = start - delta`。锚点行没了（窗口被整段换掉）→ `null`，
   * 调用方退到"按高度差补"的老口径（`scrollTopAfterPrepend`）。
   */
  preserve(): ViewportLanding | null {
    const anchor = this._paging;
    if (!anchor) return null;
    const metrics = this.readMetrics();
    const index = this.geometry?.indexOf(anchor.key) ?? null;
    const start = index === null ? null : (this.geometry?.startOf(index) ?? null);
    if (!metrics || index === null || start === null) return null;
    return this.write(metrics, start - anchor.delta, index, anchor.key, start);
  }

  /** 捕获当前阅读位置（读者接管之后要还给他）。 */
  capturePosition(): ReaderAnchor | null {
    const metrics = this.readMetrics();
    if (!metrics) return null;
    return readerAnchorOf(this.geometry?.items() ?? [], metrics.top);
  }

  private readMetrics(): ViewportMetrics | null {
    const el = this.scroller;
    if (!el) return null;
    /* **没有布局就没有几何**（docs/15 规矩 101）：dockview 把非活动面板的内容摘出 DOM 时
       `scrollTop / scrollHeight / clientHeight` 三个一起归零，而 `gap = 0 - 0 - 0 = 0`
       会被读成"已经贴着底" —— 那会把跟随意图判死、把基线记成一对 0。宁可返回 `null`
       （所有读写路径都因此变成空操作），也不拿这对 0 当真。 */
    if (el.clientHeight <= 0) return null;
    return scrollMetrics(el);
  }

  /** 行键（落点只记键，不记节点）。 */
  private keyAt(index: number): string | null {
    const row = (this.geometry?.items() ?? []).find((vi) => vi.index === index);
    return row ? String(row.key) : null;
  }

  /**
   * 写位置并把落点记成"我们自己设的"。
   *
   * `observation.landing` 的另一个用处见 `onScroll`：位置没变就直接返回
   * —— 贴底/对齐会产生一次 scroll 事件，它不是读者在滚。
   *
   * @param start - 落点所在行的起始像素（没有行锚点就传 `null`）
   */
  private write(
    metrics: ViewportMetrics,
    target: number,
    rowIndex: number | null,
    anchorKey: string | null,
    start: number | null,
  ): ViewportLanding {
    const el = this.scroller!;
    const top = Math.max(0, Math.min(metrics.floor, target));
    // 幂等：差 ≤0.5px 就不写（写了也不会怎样，但"内容变 → 写位置 → 布局变"是白做功）
    if (Math.abs(top - metrics.top) > 0.5) el.scrollTop = top;
    const actual = el.scrollTop;
    const position: ReaderAnchor | null =
      anchorKey === null || start === null
        ? null
        : { key: anchorKey, delta: actual - start, top: actual };
    const landing: ViewportLanding = { metrics: { ...metrics, top: actual }, rowIndex, position };
    this.observation = { top: actual, landing };
    return landing;
  }

  private readonly onScroll = (): void => {
    const el = this.scroller;
    if (!el) return;
    // 位置没动（就是我们刚才自己写的那一次）→ 什么都不用做
    if (this.observation.landing !== null && el.scrollTop === this.observation.top) return;
    this.invalidate();
    if (this._paging !== null) {
      // 翻页补偿期间：位置由 `preserve` 负责，把布局变化通知出去让它补
      this.events?.resize();
      return;
    }
    const scroll = this.readScroll();
    if (scroll) this.events?.scroll(scroll);
  };

  private readonly onScrollEnd = (): void => {
    this.events?.scrollEnd();
  };

  private readonly onIntent = (event: Event): void => {
    if (event.type === 'wheel') {
      // 滚轮方向报给阅读层（上滚 = 读者接管；下滚 = 可能还要续页）
      this.events?.wheel((event as WheelEvent).deltaY ?? 0);
    }
    if (event.type === 'keydown') {
      if (!(event instanceof KeyboardEvent) || !SCROLL_KEYS.has(event.key)) return;
      if (event.target instanceof Element && event.target.closest('[data-composer-seat]') !== null) return;
    }
    if (this._paging === null) return;
    this.stopPaging();
    this.events?.interact();
  };
}
