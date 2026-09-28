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
import { loadOlder } from '@/lib/transcriptPage';
import { useAppConfig } from '@/stores/appConfig';
import { useMessages, useTabMsg, type MessageView as MessageViewT } from '@/stores/messages';
import { Icon } from '@/features/common/Icon';
import { MessageView } from './MessageView';
import { activeTurnOf, buildRailItems } from './turnRailItems';
import { TurnRail } from './TurnRail';
import { isAtTail, nextFollowing, scrollTopAfterPrepend } from './transcriptScroll';

const LIVE_ID = '__live__';

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
  const hydrated = useTabMsg(tabId, (t) => t.hydrated);
  const rowIds = streaming ? [...ids, LIVE_ID] : ids;
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

  /** 贴底。**不**改跟随意图——调用方决定（打开会话 / 用户点按钮 / 内容增长）。 */
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // 换标签 = 换会话：跟随意图回到初始值（DSH 打开会话没有"上次读到哪"时直接贴底）
  useEffect(() => {
    followingRef.current = true;
    setFollowingState(true);
  }, [tabId]);

  // 第一页灌进来（hydrated 由 false 变 true）→ 贴底
  useEffect(() => {
    if (!hydrated) return;
    if (!followingRef.current) return;
    requestAnimationFrame(pinToBottom);
  }, [hydrated, pinToBottom]);

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
    const ro = new ResizeObserver(() => {
      if (followingRef.current) el.scrollTop = el.scrollHeight;
    });
    if (inner) ro.observe(inner);
    if (liveRef.current) ro.observe(liveRef.current);
    return () => ro.disconnect();
  }, [tabId, hydrated, streaming]);

  // ── 预览滚动条：刻度来自 store 里**已载入**的消息 ──
  const railItems = useMemo(
    () =>
      buildRailItems(
        ids.map((id) => {
          const row = byId[id];
          return { role: row?.role ?? '', content: (row?.message as { content?: unknown })?.content };
        }),
      ),
    [ids, byId],
  );

  /** 阅读线所在行 → 当前轮次。滚动/新增消息时重算。 */
  const [activeTurn, setActiveTurn] = useState<number | null>(null);
  const recomputeActive = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 读者自己滚动过 → 重新判定跟随意图（DSH `ScrollFollow.sample`）
    const metrics = { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
    setFollowing(nextFollowing(followingRef.current, metrics, true));
    const items = virtualizer.getVirtualItems();
    if (items.length === 0) return;
    // 阅读线：视口顶部往下 1/4（贴顶太灵敏，正中又会在一轮很长时乱跳）
    const line = el.scrollTop + Math.min(120, el.clientHeight / 4);
    let readingRow = items[0]!.index;
    for (const vi of items) {
      if (vi.start <= line) readingRow = vi.index;
      else break;
    }
    setActiveTurn(activeTurnOf(railItems, readingRow, isAtTail(metrics)));
  }, [setFollowing, virtualizer, railItems]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    recomputeActive();
    el.addEventListener('scroll', recomputeActive, { passive: true });
    return () => el.removeEventListener('scroll', recomputeActive);
  }, [recomputeActive]);

  /** 点刻度：把那一轮滚到视口顶部（跳转的语义是"带我去那儿"）。 */
  const jumpToRow = useCallback(
    (rowIndex: number) => {
      followingRef.current = false;
      setFollowingState(false);
      virtualizer.scrollToIndex(rowIndex, { align: 'start' });
    },
    [virtualizer],
  );

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
      {!following && ids.length > 0 && (
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
      )}
      {railPlacement !== 'off' && (
        <TurnRail
          items={railItems}
          activeTurn={activeTurn}
          placement={railPlacement}
          onJump={jumpToRow}
          hasMore={hasMore}
          onLoadOlder={() => void loadEarlier()}
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
