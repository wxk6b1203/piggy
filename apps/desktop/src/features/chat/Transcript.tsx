/**
 * 会话转录（docs/04 §2.1）：虚拟化 + per-tab 实时块挂载点 + 预览滚动条（§2.6）
 * + 分页（§2.1.1，docs/03 §2.19）。
 *
 * 预览滚动条挂在**这里**而不是会话工作区：它要的东西全在这个组件手里——
 * 滚动容器、虚拟化器（"第几行在阅读线上"与"跳到第几行"都靠它）。
 * 放到上层就得把这些再往外提一层，多一份需要同步的状态。
 *
 * ## 打开即贴底（`followingTail`）
 *
 * 长会话打开时如果停在开头，用户每次都得先滚到底——所以**默认跟随尾部**
 * （DSH `ScrollFollow` 的初始 `followingTail`）：第一页灌进来就贴底，
 * 之后新内容继续贴底，直到**读者自己往上滚**才交还控制权，
 * 此时右下角出现「回到底部」（DSH `chat.toBottom`）。
 *
 * ## 分页
 *
 * 打开只载入尾部一页；上面还有历史时，转录顶端出现「加载更早」
 * （DSH `chat.loadOlder`），加载中显示「载入历史…」。翻页**不许跳**：
 * 先把当前的 `scrollTop` / `scrollHeight` 记下来，DOM 更新后按高度差补回去
 * （纯函数 `scrollTopAfterPrepend`，几何口径有单测）。
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { liveFor } from '@/lib/live';
import { loadNewer, loadOlder, loadTail, loadWindowAt } from '@/lib/transcriptPage';
import { toast } from '@/lib/feedback';
import { useAppConfig } from '@/stores/appConfig';
import { useMessages, useTabMsg, type MessageView as MessageViewT } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { Icon } from '@/features/common/Icon';
import { MessageView } from './MessageView';
import {
  activeTurnOf,
  findRowIndexByOffset,
  mergeRailItems,
  type RailItem,
  type RailSourceRow,
} from './turnRailItems';
import { TurnRail } from './TurnRail';
import { isAtTail, nextFollowingFromSample, scrollTopAfterPrepend } from './transcriptScroll';

const LIVE_ID = '__live__';

/** 从 store 的一个 tab 里取出刻度需要的行原料（跳转落位时重新读一次）。 */
function railRowsOf(tab: { ids: string[]; byId: Record<string, { role: string; message: unknown; offset: number | null }> } | undefined): RailSourceRow[] {
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

export function Transcript({ tabId }: { tabId: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  /** 内容层（高度 = 虚拟总高）：测行高会改它，贴底要盯着它。 */
  const innerRef = useRef<HTMLDivElement>(null);
  const ids = useTabMsg(tabId, (t) => t.ids);
  const streaming = useTabMsg(tabId, (t) => t.streaming);
  const byId = useTabMsg(tabId, (t) => t.byId);
  const hasMore = useTabMsg(tabId, (t) => t.hasMore);
  const loadingOlder = useTabMsg(tabId, (t) => t.loadingOlder);
  const outline = useTabMsg(tabId, (t) => t.outline);
  const pageCursor = useTabMsg(tabId, (t) => t.pageCursor);
  const hasNewer = useTabMsg(tabId, (t) => t.hasNewer);
  const loadingNewer = useTabMsg(tabId, (t) => t.loadingNewer);
  const hydrated = useTabMsg(tabId, (t) => t.hydrated);
  // 换窗期间（hasNewer）窗口不在尾部：实时块挂上去会出现在**几轮之前**的位置
  const rowIds = streaming && !hasNewer ? [...ids, LIVE_ID] : ids;
  const railPlacement = useAppConfig((s) => s.railPlacement);

  /**
   * 跟随尾部：`ref` 给滚动/尺寸回调读（它们不该因意图变化而重挂），
   * `state` 只驱动「回到底部」按钮的显隐。
   */
  const followingRef = useRef(true);
  const [following, setFollowingState] = useState(true);
  const setFollowing = useCallback((next: boolean) => {
    if (followingRef.current === next) return;
    followingRef.current = next;
    setFollowingState(next);
  }, []);

  const virtualizer = useVirtualizer({
    count: rowIds.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 88,
    overscan: 6,
    getItemKey: (i) => rowIds[i] ?? `row-${i}`,
  });

  useEffect(() => {
    const container = liveRef.current;
    const scroller = scrollRef.current;
    if (container && scroller) liveFor(tabId).mount(container, scroller);
    return () => liveFor(tabId).unmount();
  }, [tabId, streaming]);

  /**
   * 我们上一次**程序化**设置的 scrollTop（DSH `ScrollFollow.sampledTop` 同义）。
   *
   * 为什么要记：贴底这个动作本身会产生一次 scroll 事件，而它**不是读者在滚**。
   * 只用几何判断"离底多远"会在流式下判错——内容在两帧之间长高，
   * 等 scroll 事件被处理时 `scrollHeight` 已经变了，于是"自己贴的底"被当成
   * "读者滚上去了"，跟随意图当场丢掉、视图停在半空。
   * 实测（真浏览器 + mock 流式）：一开口说话，当前刻度就从第 60 轮掉到 58 轮、
   * 之后再也不跟。所以判定必须带"这个位置是不是我们自己设的"。
   */
  const pinnedTopRef = useRef<number | null>(null);

  /**
   * 上次**贴底那一刻**的 scrollHeight。
   *
   * 判据是"现在比贴底时更高吗"——比"比上次采样更高吗"稳：采样可能发生在
   * 布局还没完成时（首帧 scrollHeight 为 0），那样第一次真实滚动会被误判成"内容长高"，
   * 于是读者往上滚也不交还控制权（测试里当场就红）。
   */
  const pinnedHeightRef = useRef<number | null>(null);

  /** 贴底。**不**改跟随意图——调用方决定（打开会话 / 用户点按钮 / 内容增长）。 */
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    pinnedTopRef.current = el.scrollTop;
    pinnedHeightRef.current = el.scrollHeight;
  }, []);

  /** 读者动作（点刻度跳转 / 换窗）：忘掉"程序化位置"，下一次滚动算读者滚的。 */
  const handOverToReader = useCallback(() => {
    pinnedTopRef.current = null;
    followingRef.current = false;
    setFollowingState(false);
  }, []);

  // 换标签 = 换会话：跟随意图回到初始值（DSH 打开会话没有"上次读到哪"时直接贴底）
  useEffect(() => {
    followingRef.current = true;
    setFollowingState(true);
  }, [tabId]);

  // 换窗（跳到很久以前）：窗口不在尾部，跟随意图必须关掉
  useEffect(() => {
    if (!hasNewer) return;
    followingRef.current = false;
    setFollowingState(false);
  }, [hasNewer]);

  // 第一页灌进来（hydrated 由 false 变 true）→ 贴底
  useEffect(() => {
    if (!hydrated) return;
    if (hasNewer) return; // 换窗状态：窗口不在尾部，贴底是错的
    if (!followingRef.current) return;
    requestAnimationFrame(pinToBottom);
  }, [hydrated, hasNewer, pinToBottom]);

  // 内容增长（新消息 / 流式实时块长高 / 行被测量）→ 只要还在跟随就继续贴底。
  // 光靠 lastId 那个 effect 不够：虚拟化器**量出行高**同样会把底部顶走
  // （行高从估算的 88px 变成实测值，总高变了，读者就被留在半空）。
  // ⚠️ 必须盯**内容层本身**（innerRef），不能盯 `el.firstElementChild`：
  //   分页时第一个子元素是「加载更早」那颗按钮，它的高度永远不变，
  //   于是"行高量完再贴一次底"这条永远不会触发 —— 浏览器门禁实测到 198px 的缝。
  useEffect(() => {
    const el = scrollRef.current;
    const inner = innerRef.current;
    if (!el) return;
    /**
     * 内容变高 → 贴底。两条纪律缺一不可：
     *  ① **幂等**：已经贴着底就什么都不做。否则"贴底 → 虚拟化器渲染新行 → 行高被测量 →
     *     内容高度又变 → 观察者再触发 → 再贴底"会自成一个循环，
     *     浏览器报 `ResizeObserver loop completed with undelivered notifications`；
     *  ② **每帧最多一次**（rAF 合并）：一帧里连来几批通知也只贴一次。
     */
    let scheduled = false;
    const pinIfNeeded = () => {
      scheduled = false;
      if (!followingRef.current || hasNewerRef.current) return;
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (gap <= 1) return; // 已经在底部：不做任何事，循环到此为止
      pinToBottom();
    };
    const ro = new ResizeObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(pinIfNeeded);
    });
    if (inner) ro.observe(inner);
    if (liveRef.current) ro.observe(liveRef.current);
    return () => ro.disconnect();
  }, [tabId, hydrated, streaming, pinToBottom]);

  /** ResizeObserver 回调里要读最新的换窗状态（不重挂观察者）。 */
  const hasNewerRef = useRef(hasNewer);
  hasNewerRef.current = hasNewer;

  // ── 预览滚动条：**整段会话**的轮次（轮廓）+ 已载入的行 ──
  //   轮廓来自会话文件的一次扫描（不需要把内容读进来），已载入的轮次再用真实行覆盖。
  //   于是"预览全部、展示部分"同时成立（用户 2026-09-23 反馈；DSH `mergeTurnRailItems` 同构）。
  const railRows = useMemo<RailSourceRow[]>(
    () => railRowsOf(useMessages.getState().tabs[tabId]),
    // ids/byId 变了就要重算（`railRowsOf` 直接读 store，所以这里显式列依赖）
    [tabId, ids, byId],
  );
  const railItems = useMemo(() => mergeRailItems(outline, railRows), [outline, railRows]);

  /** 正在为"跳到未载入的那一轮"翻页：梯子上那一格显示忙碌。 */
  const [jumping, setJumping] = useState<number | null>(null);

  /**
   * 换窗之后"继续往下读"：**只由滚轮意图触发**。
   *
   * 为什么不用"滚动事件 + 离底距离"自动续页（第一版就是那样，实测两次踩坑）：
   * ① 贴底/换窗/内容长高都会产生 scroll 事件，于是"续页 → 内容变 → 再触发 → 再续页"
   *    会一路把 `hasNewer` 走到 false —— 等于把整段会话读进来（门禁实测：跳一轮之后
   *    自动读到 200/200 行），正好是用户担心的"其实全载入了"；
   * ② 隐藏的面板 `clientHeight` 为 0，距离恒为 0，同样会级联。
   * 滚轮是"我要往下看"最干净的信号：一次手势最多续一页，程序化滚动不会触发它。
   * 滚轮之外还有右下角那颗「继续往下」按钮兜底（拖滚动条、键盘翻页的用户走它）。
   */
  const maybeLoadNewer = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.clientHeight <= 0) return; // 隐藏/未布局：不可能有真实滚动意图
    const tab = useMessages.getState().tabs[tabId];
    if (!tab?.hasNewer || tab.loadingNewer) return;
    const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
    const canScroll = el.scrollHeight > el.clientHeight + 1;
    // 滚到底了，或者窗口内容还不够滚（滚轮推不动）—— 两种都是"我要更多"
    if (gap <= 240 || !canScroll) void loadNewer(tabId);
  }, [tabId]);

  /** 阅读线所在行 → 当前轮次。滚动/新增消息时重算。 */
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const recomputeActive = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 读者自己滚动过 → 重新判定跟随意图（DSH `ScrollFollow.sample`）。
    // "自己滚的"判据 = 位置与我们上次程序化设置的值不同（DSH 的 `sampledTop` 比较同义）。
    const metrics = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    // 跟随意图：判据是"这段距离是谁造成的"（内容长高/换页 ≠ 读者滚动），见
    // `nextFollowingFromSample` 的说明 —— 只看"位置对不对得上"会被滚动锚定骗到。
    setFollowing(
      nextFollowingFromSample({
        metrics,
        pinnedTop: pinnedTopRef.current,
        lastScrollHeight: pinnedHeightRef.current,
        following: followingRef.current,
      }),
    );
    // ⚠️ "当前是哪一轮"用**跟随意图**而不是瞬时几何：流式时内容在两帧之间长高，
    //    等这次 scroll 事件被处理时 `scrollHeight` 已经变了，`isAtTail` 会瞬间为假 ——
    //    于是当前轮次在"最新那轮"与"阅读线那轮"之间逐帧来回翻，梯子上的亮条疯狂闪动
    //    （实测：跟随意图一直是 true，但 active 在 58 ↔ 61 之间跳）。
    //    只要还在跟随尾部，"当前"就是最新那一轮，与几像素的瞬时差无关。
    const atTailForTurn = followingRef.current || isAtTail(metrics);
    const items = virtualizer.getVirtualItems();
    if (items.length === 0) return;
    // 阅读线：视口顶部往下 1/4（贴顶太灵敏，正中又会在一轮很长时乱跳）
    const line = el.scrollTop + Math.min(120, el.clientHeight / 4);
    let readingRow = items[0]!.index;
    for (const vi of items) {
      if (vi.start <= line) readingRow = vi.index;
      else break;
    }
    setActiveTurn(activeTurnOf(railItems, readingRow, atTailForTurn));
  }, [maybeLoadNewer, setFollowing, virtualizer, railItems]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    recomputeActive();
    el.addEventListener('scroll', recomputeActive, { passive: true });
    // 向下续页只认滚轮（见 `maybeLoadNewer` 的说明）
    el.addEventListener('wheel', maybeLoadNewer, { passive: true });
    return () => {
      el.removeEventListener('scroll', recomputeActive);
      el.removeEventListener('wheel', maybeLoadNewer);
    };
  }, [maybeLoadNewer, recomputeActive]);

  /**
   * 跳到某一轮：已载入的直接滚过去；**没载入的换窗过去**（只读目标那一页）。
   *
   * DSH `navigateToTurn` 的两个分支同构（loaded → scrollToTurn；unloaded → 先取历史再落位），
   * 区别在"取历史"的口径：这里用**换窗**（丢掉旧窗口）而不是往上累加，
   * 否则跳到第 1 轮就等于把整段会话读进内存——分页就白做了。
   */
  const jumpToTurn = useCallback(
    async (item: RailItem) => {
      handOverToReader();
      if (item.loaded && item.rowIndex !== null) {
        virtualizer.scrollToIndex(item.rowIndex, { align: 'start' });
        return;
      }
      const anchorEnd = item.anchorEnd;
      if (anchorEnd === null) return;
      setJumping(item.turn);
      try {
        const ok = await loadWindowAt(tabId, anchorEnd);
        if (!ok) return;
        // 换窗后整段内容都换了：直接落到目标行（不做"高度差补偿"——那是给"往上加页"用的）
        const rowIndex = findRowIndexByOffset(
          railRowsOf(useMessages.getState().tabs[tabId]),
          item.anchorStart ?? -1,
        );
        if (rowIndex === null) {
          toast.info('这一轮没找到（会话文件可能已改变）');
          return;
        }
        requestAnimationFrame(() => virtualizer.scrollToIndex(rowIndex, { align: 'start' }));
      } finally {
        setJumping(null);
      }
    },
    [handOverToReader, tabId, virtualizer],
  );

  /** 回到最新：重新装载尾部那一页（换窗的反向操作），并恢复贴底跟随。 */
  const returnToLatest = useCallback(async () => {
    const file = useTabs.getState().tabs[tabId]?.sessionFile ?? null;
    setFollowing(true);
    await loadTail(tabId, file);
    requestAnimationFrame(pinToBottom);
  }, [pinToBottom, setFollowing, tabId]);

  /** 回到底部（DSH `chat.toBottom`）：贴底并重新接管跟随。 */
  const returnToBottom = useCallback(() => {
    setFollowing(true);
    pinToBottom();
  }, [pinToBottom, setFollowing]);

  /**
   * 加载更早一页，并**保住阅读位置**。
   *
   * 顺序不能反：先量旧几何 → await 取页（store 更新）→ 下一帧量新几何并按差值补 scrollTop。
   * 少了最后一步，插入的 50 行会把眼前的内容整体推下去，看起来就是"点了一下跳到别处"。
   */
  const loadEarlier = useCallback(async () => {
    const el = scrollRef.current;
    const before = el ? { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight } : null;
    const added = await loadOlder(tabId);
    if (!el || !before || added === 0) return;
    requestAnimationFrame(() => {
      el.scrollTop = scrollTopAfterPrepend(before, el.scrollHeight);
    });
  }, [tabId]);

  const lastId = ids.at(-1);
  useEffect(() => {
    // 新消息到达：还在跟随就贴底（内容高度变化由上面的 ResizeObserver 兜住）
    if (!followingRef.current || !lastId) return;
    requestAnimationFrame(pinToBottom);
  }, [lastId, pinToBottom]);

  return (
    <div className="pg-transcript-wrap" data-rail-side={railPlacement} data-tab-id={tabId}>
      <div ref={scrollRef} className="pg-transcript">
        {hasMore && (
          <div className="pg-transcript-older">
            <button type="button" disabled={loadingOlder} onClick={() => void loadEarlier()} data-load-older>
              {loadingOlder ? '载入历史…' : '加载更早'}
            </button>
          </div>
        )}
        {!hydrated && (
          <div className="pg-transcript-hint" data-transcript-hint>
            载入历史…
          </div>
        )}
        <div ref={innerRef} style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const id = rowIds[vi.index]!;
            return (
              <div
                key={vi.key}
                ref={virtualizer.measureElement}
                // TanStack Virtual 靠 data-index 把测量结果映射回条目；
                // 缺了它 measureElement 会静默丢弃测量值（只报一条 warning），
                // 于是行高永远停在 estimateSize → 行与行**重叠**。
                data-index={vi.index}
                className="pg-vrow"
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${vi.start}px)`,
                }}
              >
                {id === LIVE_ID ? (
                  <div className="pg-message pg-assistant pg-live" ref={liveRef}>
                    <div className="pg-role">assistant ▌</div>
                  </div>
                ) : (
                  <Row tabId={tabId} id={id} />
                )}
              </div>
            );
          })}
        </div>
      </div>
      {hasNewer ? (
        // 换窗状态（在看几轮之前的历史）：**往下滚能继续读**，这里再给一条直达尾部的路。
        // 两个按钮的分工：`继续往下` = 逐页读完（读到尾部 hasNewer 自动转 false）；
        // `回到最新` = 一跳到尾部。位置与「回到底部」同一处（右下角）。
        <div className="pg-bottom-actions">
          <button
            type="button"
            className="pg-to-bottom pg-to-latest"
            aria-label="回到最新"
            title="回到最新（重新装载会话尾部）"
            data-to-latest
            onClick={() => void returnToLatest()}
          >
            <Icon name="chevron-down" size={16} />
            <span>回到最新</span>
          </button>
          <button
            type="button"
            className="pg-to-bottom pg-to-newer"
            aria-label="继续往下"
            title="继续往下读（也可以直接往下滚）"
            data-load-newer
            disabled={loadingNewer}
            onClick={() => void loadNewer(tabId)}
          >
            <Icon name="arrow-down" size={16} />
            <span>{loadingNewer ? '载入中…' : '继续往下'}</span>
          </button>
        </div>
      ) : !following && ids.length > 0 ? (
        <button
          type="button"
          className="pg-to-bottom"
          aria-label="回到底部"
          title="回到底部"
          data-to-bottom
          onClick={returnToBottom}
        >
          <Icon name="chevron-down" size={16} />
        </button>
      ) : null}
      {railPlacement !== 'off' && (
        <TurnRail
          items={railItems}
          activeTurn={activeTurn}
          placement={railPlacement}
          onJump={(item) => void jumpToTurn(item)}
          pendingTurn={jumping}
        />
      )}
    </div>
  );
}

function Row({ tabId, id }: { tabId: string; id: string }) {
  const view = useStore(
    useMessages,
    (s) => s.tabs[tabId]?.byId[id] as MessageViewT | undefined,
  );
  if (!view) return null;
  return <MessageView view={view} />;
}
