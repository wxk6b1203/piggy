/**
 * 会话转录（docs/04 §2.1）：虚拟化行 + 分页 + 贴底跟随（§2.1.1）+ 预览滚动条（§2.6）。
 *
 * ## 这个组件现在只做四件事
 *
 * ```
 * 行源（store 的 ids，含流式那一行）→ 虚拟化 → Row/MessageView
 * 滚动策略 → useTranscriptScroll（阅读意图 + 历史导航，决策都在那边）
 * 位置读写 → TranscriptViewport（DOM 与几何的属主）
 * 刻度梯 → TurnRail（数据来自 turnRailItems，当前轮次由阅读线算）
 * ```
 *
 * 它**不再**直接写 `scrollTop`、不再持有跟随意图的 ref、也不再往 DOM 里直写流式文本：
 * 那三件事分别归 `TranscriptViewport`、`useTranscriptScroll` 与 store
 * （见各自的文件头）。历史上这里塞过 `pinnedTopRef` / `pinnedHeightRef` /
 * `readerGestureRef` / `readerUpRef` / `attachLive` 五套机制，每一套都为某一个具体 bug
 * 打补丁，合起来没人能说清"现在到底跟不跟"。
 *
 * ## 流式的行就是转录里的那一行
 *
 * 行源是 store 的 `ids`：`message_start` 时那一行**已经进来了**（`live` 槽位装着流式块），
 * `message_end` 只是把权威内容填进同一行。于是没有"实时块"与"提交行"两套 DOM，
 * 也就没有重复、没有下标漂移、没有"最后又打印一遍"（见 `stores/messages.ts` 文件头）。
 *
 * ## 分页
 *
 * 打开只载入尾部一页；上面还有历史时顶端出现「加载更早」（DSH `chat.loadOlder`），
 * 加载中显示「载入历史…」。翻页**不许跳**：位置补偿在 `TranscriptViewport.preserve`
 * （按行锚点还位置，行高变了也不会把读者带到别的行上）。换窗之后
 * （`hasNewer`）右下角并排「继续往下」与「回到最新」。
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useAppConfig } from '@/stores/appConfig';
import { useMessages, useTabMsg, type MessageView as MessageViewT } from '@/stores/messages';
import { useTodoSupported } from '@/stores/todo';
import { Icon } from '@/features/common/Icon';
import { MessageView } from './MessageView';
import { todoBaselines, type TodoItem } from '@/lib/todoModel';
import { changedStatsOf } from '@/stores/messages';
import { activeTurnOf, mergeRailItems, type RailSourceRow } from './turnRailItems';
import { TurnRail } from './TurnRail';
import { TranscriptViewport, type RowGeometry } from './transcriptViewport';
import { railRowsFor, useTranscriptScroll } from './useTranscriptScroll';

export function Transcript({ tabId }: { tabId: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const ids = useTabMsg(tabId, (t) => t.ids);
  const hydrated = useTabMsg(tabId, (t) => t.hydrated);
  const hasMore = useTabMsg(tabId, (t) => t.hasMore);
  const loadingOlder = useTabMsg(tabId, (t) => t.loadingOlder);
  const hasNewer = useTabMsg(tabId, (t) => t.hasNewer);
  const loadingNewer = useTabMsg(tabId, (t) => t.loadingNewer);
  const outline = useTabMsg(tabId, (t) => t.outline);
  /* 权威内容的版本号（帧不动它）：派生值要"消息变了就重算"，但不能因此每帧重渲染
     —— 订阅 `byId` 就是每帧重渲染（见 stores/messages.ts 的 `commitSeq`）。 */
  const commitSeq = useTabMsg(tabId, (t) => t.commitSeq);
  const todoOn = useTodoSupported();
  const railPlacement = useAppConfig((s) => s.railPlacement);

  /** 滚动容器的属主（DOM + 几何 + 锚点）；生命周期与这个组件一样长。 */
  const [viewport] = useState(() => new TranscriptViewport());

  const virtualizer = useVirtualizer({
    count: ids.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 88,
    overscan: 6,
    getItemKey: (i) => ids[i] ?? `row-${i}`,
  });

  /* 行几何的适配器：**只造一次**，里面读最新的 ids 与虚拟化器。
     不把 `virtualizer` 放进依赖：它的实例在真机上是稳定的，但"依赖一个会换引用的对象"
     会让下面的 attach effect 每次渲染都重跑（重挂监听器、丢掉归因基线），
     而这类"看起来只是多跑一次"的重挂正是最难查的那种间歇性 bug。 */
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const virtRef = useRef(virtualizer);
  virtRef.current = virtualizer;
  const [geometry] = useState<RowGeometry>(() => ({
    indexOf: (key) => {
      const i = idsRef.current.indexOf(key);
      return i < 0 ? null : i;
    },
    startOf: (index) => virtRef.current.getOffsetForIndex(index, 'start')?.[0] ?? null,
    items: () => virtRef.current.getVirtualItems(),
    totalSize: () => virtRef.current.getTotalSize(),
    // 兜底（见 `RowGeometry.scrollTo`）：行还没测量时按虚拟化器的估计滚过去
    scrollTo: (index) => virtRef.current.scrollToIndex(index, { align: 'start' }),
  }));

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    viewport.attach(el, geometry);
    return () => viewport.detach();
  }, [viewport, geometry]);

  const scroll = useTranscriptScroll(viewport, {
    tabId,
    ready: hydrated,
    rowCount: ids.length,
    totalSize: virtualizer.getTotalSize(),
    // 面板被 dockview 摘出 DOM 时虚拟化器报 0（它内部那个观察者量的）：
    // 这个值同时是"内容变了"和"重新有布局了"的信号（见 useTranscriptScroll 的两条 effect）
    layoutHeight: virtualizer.scrollRect?.height ?? 0,
    hasMore,
    loadingOlder,
    hasNewer,
    loadingNewer,
  });

  /* 刻度梯：整段会话的轮次轮廓（文件扫出来的）+ 已载入的行（真实行覆盖轮廓）。
     于是"预览全部、展示部分"同时成立（DSH `mergeTurnRailItems` 同构）。 */
  const railRows = useMemo<RailSourceRow[]>(
    () => railRowsFor(tabId),
    // ids/commitSeq 变了就要重算（`railRowsFor` 直接读 store，所以这里显式列依赖）
    [tabId, ids, commitSeq],
  );
  const railItems = useMemo(() => mergeRailItems(outline, railRows), [outline, railRows]);

  /**
   * 每一条 `todo_write` 的**上一份清单**（差异对比的基线，DSH 的 `todoHistory`）。
   *
   * 按行配对而不是用"当前清单"：历史那一行的差异必须跟**它当时**的上一次比，
   * 否则往上翻历史时每一行都显示"与现在这份清单相比"，那是假的。
   * 没探测到 todo 能力时不算（一个字节都不多花）。
   */
  const baselines = useMemo(
    () =>
      todoOn
        ? todoBaselines(
            ids
              .map((id) => useMessages.getState().tabs[tabId]?.byId[id])
              .filter(Boolean) as MessageViewT[],
          )
        : null,
    [todoOn, tabId, ids, commitSeq],
  );

  /**
   * 每条工具调用的**改动行数**（改动卡片的 `+N -M`）。
   *
   * 与 `baselines` 同一套口径：`commitSeq`（实时结果落地）+ `ids`（分页读进来的结果）
   * 各管一条路 —— **只订阅 `commitSeq` 是不够的**：`hydratePage`/`prependPage` 不涨它，
   * 于是打开会话时算出的那份空表会被一路记住（实测：卡片上的 `+N -M` 永远是空的）。
   * 也不订阅每帧都换引用的 `toolResults`（那会让每个助手行在流式时每帧重渲染）。
   */
  const changeStats = useMemo(() => changedStatsOf(tabId), [tabId, ids, commitSeq]);

  /* 当前轮次 = 阅读线所在那一轮（贴底时 = 已载入窗口的最后一轮）。
     ⚠️ 阅读线**不看瞬时几何**：流式时内容两帧之间长高，几何会把"自己贴的底"读成
     "读者滚上去了"，于是亮条在最新那轮与阅读线那轮之间逐帧来回翻（实测 58 ↔ 61）。 */
  const activeTurn = useMemo(
    () => activeTurnOf(railItems, scroll.readingRow ?? 0, scroll.following),
    [railItems, scroll.readingRow, scroll.following],
  );

  const total = virtualizer.getTotalSize();
  return (
    <div className="pg-transcript-wrap" data-rail-side={railPlacement} data-tab-id={tabId}>
      <div ref={scrollRef} className="pg-transcript" data-transcript-scroll>
        {hasMore && (
          <div className="pg-transcript-older">
            <button type="button" disabled={loadingOlder} onClick={scroll.loadEarlier} data-load-older>
              {loadingOlder ? '载入历史…' : '加载更早'}
            </button>
          </div>
        )}
        {!hydrated && (
          <div className="pg-transcript-hint" data-transcript-hint>
            载入历史…
          </div>
        )}
        <div style={{ height: total, position: 'relative' }}>
          {virtualizer.getVirtualItems().map((vi) => {
            const id = ids[vi.index];
            if (!id) return null;
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
                <Row tabId={tabId} id={id} baselines={baselines} changeStats={changeStats} />
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
            onClick={scroll.returnToLatest}
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
            onClick={scroll.continueDown}
          >
            <Icon name="arrow-down" size={16} />
            <span>{loadingNewer ? '载入中…' : '继续往下'}</span>
          </button>
        </div>
      ) : !scroll.following && ids.length > 0 ? (
        <button
          type="button"
          className="pg-to-bottom"
          aria-label="回到底部"
          title="回到底部"
          data-to-bottom
          onClick={scroll.returnToBottom}
        >
          <Icon name="chevron-down" size={16} />
        </button>
      ) : null}
      {railPlacement !== 'off' && (
        <TurnRail
          items={railItems}
          activeTurn={activeTurn}
          placement={railPlacement}
          onJump={scroll.jumpToTurn}
          pendingTurn={scroll.jumping}
        />
      )}
    </div>
  );
}

/**
 * 一行 = 一个块（`store.ids` 里的一项）。
 *
 * ⚠️ **行切片订阅**：选择器只返回这一行自己的对象 —— 流式时只有那一行重渲染，
 * 其余行（以及整个 Transcript）引用不变（DSH 的 seat 订阅自己的 node，同构）。
 */
function Row({
  tabId,
  id,
  baselines,
  changeStats,
}: {
  tabId: string;
  id: string;
  /** `todo_write` 的调用 id → 它的上一份清单（见 `todoBaselines`） */
  baselines: Map<string, TodoItem[]> | null;
  /** 文件改动的调用 id → 加删行数（见 `stores/messages.ts` 的 `changedStatsOf`） */
  changeStats: Record<string, { added: number; removed: number }>;
}) {
  const view = useStore(useMessages, (s) => s.tabs[tabId]?.byId[id] as MessageViewT | undefined);
  /* 工具行的窄摘要要的是**调用参数**（`运行命令 · pnpm test`），而参数在上一条助手消息里
     —— store 在 `register()` 时做过一次 join（docs/03 §3.1 的 `toolCalls` 索引）。
     这里按 `toolCallId` 取出来交给 `MessageView`；拿不到就是 undefined，行会退到结果首行。
     （只有"调用不在窗口里"的兜底 `toolResult` 行需要它：正常路径上工具行由助手消息里的
     `toolCall` 块渲染，参数就在块里，见 `ToolCallRow`。） */
  const callId = view?.role === 'toolResult' ? (view.message as { toolCallId?: string }).toolCallId : undefined;
  const call = useStore(useMessages, (s) => (callId ? s.tabs[tabId]?.toolCalls[callId] : undefined));
  /* 差异基线按**调用 id** 查（`todoBaselines` 的键就是 callId，不是 store 的行 id）。
     查错了不会报错，只会让每一行都显示成「首次记录」—— 属于最难发现的那类错，
     所以 `todo-transcript.test.tsx` 专门端到端跑了两行写入来钉它。 */
  const baseline = callId ? baselines?.get(callId) : undefined;
  if (!view) return null;
  /* 行身份给"展开态记忆"（`lib/rowMemory`）：行滚出窗口会被卸载，
     行里的 `useState` 会跟着丢 —— 展开过的思考/工具行必须活过这一次卸载。 */
  const memory = { tabId, rowKey: id };
  return (
    <MessageView
      view={view}
      call={call}
      baseline={baseline}
      baselines={baselines}
      tabId={tabId}
      changeStats={changeStats}
      memory={memory}
    />
  );
}
