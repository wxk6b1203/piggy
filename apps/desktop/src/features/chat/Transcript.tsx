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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { useAppConfig, type TranscriptDetail } from '@/stores/appConfig';
import { defaultOpen, useTurnFold } from '@/stores/turnFold';
import { useMessages, useTabMsg, type MessageView as MessageViewT } from '@/stores/messages';
import { useQuestions } from '@/stores/questions';
import { useTabs } from '@/stores/tabs';
import { openDiffTab, openPreviewTab } from '@/features/workspace/EditorArea';
import { useTodoSupported } from '@/stores/todo';
import { Icon } from '@/features/common/Icon';
import { MessageView } from './MessageView';
import { todoBaselines, type TodoItem } from '@/lib/todoModel';
import { foldRowInput, turnFolds, type TurnFold } from '@/lib/turnFold';
import { editedCallsOf } from '@/lib/diff';
import { baseName, resolveAgainst } from '@/lib/paths';
import type { ContentBlock } from '@piggy/pi-protocol';
import { changedStatsOf } from '@/stores/messages';
import { activeTurnOf, mergeRailItems, type RailSourceRow } from './turnRailItems';
import { TurnRail } from './TurnRail';
import { ChangedFiles, type ChangedFile } from './ChangedFiles';
import { TurnFoldRow } from './TurnFoldRow';
import { RunningStatus } from './RunningStatus';
import { TranscriptViewport, type RowGeometry } from './transcriptViewport';
import { railRowsFor, useTranscriptScroll, type ReadingPositionPort } from './useTranscriptScroll';
import { loadReadingPosition, saveReadingPosition } from '@/lib/readingPosition';
import { windowEvents } from '@/lib/windowEvents';

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

  /* 跨重启记住阅读位置（docs/04 §2.1.7）：身份是**会话文件 + 行的字节偏移**。
     `Transcript` 才知道会话文件（`useTabs`）与"偏移 → 行 id"的映射，所以端口在这里造。
     ⚠️ 端口对象要稳定（`useMemo` 依赖只放会话文件与 tabId）：它挂在阅读层的输入上，
     每次渲染换引用会让"记位置"这条路径反复重建。 */
  const sessionFile = useTabs((s) => s.tabs[tabId]?.sessionFile ?? null);
  const positions = useMemo<ReadingPositionPort>(
    () => ({
      read: () => loadReadingPosition(sessionFile),
      save: (anchor) => {
        if (anchor === null) {
          saveReadingPosition(sessionFile, { following: true, offset: null, delta: 0 });
          return;
        }
        const row = useMessages.getState().tabs[tabId]?.byId[anchor.key];
        if (!row || row.offset == null) return; // 实时追加的行没有偏移：这一格不记（下次采样再试）
        saveReadingPosition(sessionFile, { following: false, offset: row.offset, delta: anchor.delta });
      },
      resolve: (saved) => {
        if (saved.offset === null) return null;
        const tab = useMessages.getState().tabs[tabId];
        return tab?.ids.find((id) => tab.byId[id]?.offset === saved.offset) ?? null;
      },
    }),
    [sessionFile, tabId],
  );

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
    positions,
  });

  /* 刻度梯：整段会话的轮次轮廓（文件扫出来的）+ 已载入的行（真实行覆盖轮廓）。
     于是"预览全部、展示部分"同时成立（DSH `mergeTurnRailItems` 同构）。 */
  const railRows = useMemo<RailSourceRow[]>(
    () => railRowsFor(tabId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `railRowsFor` 直接读 store（不通过参数），ids/commitSeq 是刻意的重算触发条件
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 同上：`todoBaselines` 读的是传进去的行，ids/commitSeq 决定"什么时候重算"
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
  const changeStats = useMemo(
    () => changedStatsOf(tabId),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `changedStatsOf` 直接读 store（见上一条注释）
    [tabId, ids, commitSeq],
  );

  /* ── 回合级过程折叠（docs/04 §2.1.6）────────────────────────────────────
     行 → 轮 → 每轮"折哪些行"。纯函数在 `lib/turnFold.ts`；这里变成**每行的渲染计划**：

       · `plan.fold`：这一行的上方要画折叠标题（画在"过程第一行"上方，没有过程时画在回答上方）；
       · `plan.folded`：这一行属于被折起来的过程 → 不渲染（虚拟化器量到 0 高）。

     为什么用"查表 + 高度归零"而不是"生成一份新的行数组"：行的**下标**必须与 `ids` 一致 ——
     刻度梯的 `rowIndex`、虚拟化器的测量、阅读锚点全都按下标对齐。折起来的行仍然占一个下标，
     只是高度为 0，这三套机制一个都不用改。 */
  const streaming = useTabMsg(tabId, (t) => t.streaming);
  /** 这一轮的时钟起点（`agent_start` 记下的），给末尾那行「运行中，用时 N 秒」用（04 §2.1.9） */
  const turnStartedAt = useTabMsg(tabId, (t) => t.turnStartedAt);
  /**
   * 最后一行**有没有输出** —— 有才画运行指示上方那条 0.5px 分隔线。
   *
   * DSH 花了一条关系选择器判这件事（`ChatView.module.css` 里 `.runningDivider` 的
   * `:nth-last-child(2 …)`）：用户气泡、隐藏的座位、**空的助手座位**都不算输出。
   * 刚发出去那一瞬间最后一行就是用户气泡，状态行该直接贴在它下面，别再插一根线；
   * lock 到"只看最后一行"，不看整段历史。
   */
  const tailHasOutput = useTabMsg(tabId, (t) => {
    const id = t.ids[t.ids.length - 1];
    const row = id ? t.byId[id] : undefined;
    if (!row) return false;
    if (row.role === 'user') return false;
    if (row.role !== 'assistant') return true;
    if ((row.live?.length ?? 0) > 0) return true;
    const content = (row.message as { content?: unknown }).content;
    return Array.isArray(content) ? content.length > 0 : Boolean(content);
  });
  const detail = useAppConfig((s) => s.transcriptDetail);
  /** 手动开合记忆（键 = 会话文件偏移，见 `stores/turnFold.ts`）；变了要重算计划 */
  const foldMemory = useTurnFold((s) => s.open[tabId]);
  const toggleFold = useTurnFold((s) => s.toggle);

  /* 还没回答的提问（`stores/questions.ts`）：这些轮**不许折** —— 否则用户看不到
     要回答什么（见 `lib/turnFold.ts` 里 `pendingQuestion` 的注释，截图实测抓到的）。 */
  const pendingQuestions = useQuestions((s) => s.pending);
  const folds = useMemo(() => {
    const pendingIds = new Set(Object.keys(pendingQuestions));
    const rows = ids
      .map((id) => useMessages.getState().tabs[tabId]?.byId[id])
      .filter(Boolean)
      .map((row) => foldRowInput(row as MessageViewT, pendingIds));
    return turnFolds(rows, streaming);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 行数据从 store 现读（不通过参数），ids/commitSeq/streaming 是刻意的重算触发条件
  }, [tabId, ids, commitSeq, streaming, pendingQuestions]);

  const plans = useMemo(() => {
    const out = new Map<string, { fold?: TurnFold; folded: boolean; open: boolean; turnKey: string }>();
    if (detail === 'verbose') return out; // 完全展开档：连标题行都不画
    const tab = useMessages.getState().tabs[tabId];
    const keyOf = (index: number): string => {
      const row = tab?.byId[ids[index] ?? ''];
      // 优先会话文件偏移（跨重新载入稳定）；拿不到退回行 id
      return row ? (row.offset != null ? `off:${row.offset}` : `id:${row.id}`) : '';
    };
    for (const fold of folds) {
      if (!fold.showHeader) continue;
      const headId = ids[fold.headIndex];
      if (!headId) continue;
      const turnKey = keyOf(fold.start);
      const open = foldMemory?.[turnKey] ?? defaultOpen(detail);
      // 中止/失败的回合永远摊开（过程就是排查现场）
      const folded = fold.foldable && !open;
      out.set(headId, { fold, folded: folded && fold.processIndexes.includes(fold.headIndex), open, turnKey });
      for (const i of fold.processIndexes) {
        const id = ids[i];
        if (!id || id === headId) continue;
        out.set(id, { folded, open, turnKey });
      }
    }
    return out;
  }, [folds, ids, detail, foldMemory, tabId]);

  /* ── 回合尾的「已编辑 N 个文件」卡片（DSH `ChangedFiles`，docs/12 §3.5）──
     卡片属于**回合**（DSH 挂在 `conversation.chat.turnTail`），不属于某一条助手行：
     放进行里会被"回合折叠"一起藏起来 —— 折起过程之后就看不到这轮改了哪些文件了
     （截图实测抓到）。所以这里按段聚合，挂在这一段**最后一行**的槽位上：
     那段行被折起来时，卡片照样渲染（折叠只藏过程行，不藏卡片）。

     数据：路径来自工具调用参数（`editedCallsOf`），加删行数来自工具结果的 `details.patch`
     （`changeStats`，在结果索引时算过一次）。拿不到行数的文件只显示路径 —— 不臆造数字。 */
  const tailChanged = useMemo(() => {
    const out = new Map<string, ChangedFile[]>();
    const tab = useMessages.getState().tabs[tabId];
    if (!tab) return out;
    /** 把一段（下标区间）里所有助手行的改动并起来（同一路径取第一次出现的调用 id）。 */
    const collect = (from: number, to: number): ChangedFile[] => {
      const seen = new Set<string>();
      const files: ChangedFile[] = [];
      for (let i = from; i <= to; i += 1) {
        const row = tab.byId[ids[i] ?? ''];
        if (!row || row.role !== 'assistant' || row.live) continue;
        const blocks = (Array.isArray((row.message as { content?: unknown }).content)
          ? (row.message as { content: ContentBlock[] }).content
          : []) as ContentBlock[];
        for (const c of editedCallsOf(blocks)) {
          if (seen.has(c.path)) continue;
          seen.add(c.path);
          files.push({
            path: c.path,
            callId: c.callId,
            added: changeStats[c.callId]?.added ?? null,
            removed: changeStats[c.callId]?.removed ?? null,
          });
        }
      }
      return files;
    };
    /* 没有 user 行的前置段（分页窗口从半途开始）也要有卡片：那一段的下标是
       `[0, 第一个 fold 的 start)`（没有任何 fold 时就是整窗）。 */
    const firstStart = folds[0]?.start ?? ids.length;
    if (firstStart > 0) {
      const files = collect(0, firstStart - 1);
      const tail = ids[firstStart - 1];
      if (files.length > 0 && tail) out.set(tail, files);
    }
    for (const fold of folds) {
      const files = collect(fold.start, fold.end);
      const tail = ids[fold.end];
      if (files.length > 0 && tail) out.set(tail, files);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 行数据从 store 现读（与 folds 同一口径）
  }, [tabId, ids, commitSeq, folds, changeStats]);

  /* 当前轮次 = 阅读线所在那一轮  /* 当前轮次 = 阅读线所在那一轮  /* 当前轮次 = 阅读线所在那一轮（贴底时 = 已载入窗口的最后一轮）。
     ⚠️ 阅读线**不看瞬时几何**：流式时内容两帧之间长高，几何会把"自己贴的底"读成
     "读者滚上去了"，于是亮条在最新那轮与阅读线那轮之间逐帧来回翻（实测 58 ↔ 61）。 */
  const activeTurn = useMemo(
    () => activeTurnOf(railItems, scroll.readingRow ?? 0, scroll.following),
    [railItems, scroll.readingRow, scroll.following],
  );

  /**
   * 「发送之后回到最底下」（2026-10-17 用户）：`Composer` 只在"这一条会起一轮"时发这个事件
   * （队列为空 + 空闲）——那时新消息就在转录末尾，读者滚上去看历史也该被带回来。
   * 流式中/还有排队的不发：那条只是入队，转录内容没变，别把读者拽走。
   *
   * 用 ref 拿最新的 `returnToBottom`：`useTranscriptScroll` 每次渲染都返回新对象，
   * 直接进依赖会让订阅每帧重挂。
   */
  const followTailRef = useRef(scroll.returnToBottom);
  followTailRef.current = scroll.returnToBottom;
  useEffect(
    () =>
      windowEvents.on('transcript-follow-tail', (id) => {
        if (id === tabId) followTailRef.current();
      }),
    [tabId],
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
                {(() => {
                  const plan = plans.get(id);
                  return (
                    <>
                      {plan?.fold ? (
                        <TurnFoldRow
                          fold={plan.fold}
                          open={plan.open}
                          mode={detail}
                          onToggle={() => toggleFold(tabId, plan.turnKey, detail)}
                        />
                      ) : null}
                      {plan?.folded ? null : (
                        <Row tabId={tabId} id={id} baselines={baselines} detail={detail} />
                      )}
                      {tailChanged.has(id) ? (
                        <ChangedFiles
                          files={tailChanged.get(id)!}
                          onOpen={(file, kind) => {
                            const cwd = useTabs.getState().tabs[tabId]?.cwd;
                            const full = resolveAgainst(cwd, file.path);
                            const name = baseName(full) || full;
                            /* 头部 = 看**文件**（"现在长什么样"），行 = 看 **diff**（"改了什么"）。
                               行上没有差异信息时（`write` 覆盖写、拿不到 patch）退回文件预览：
                               点下去总有东西出来，不弹一个"没有差异"的空视图。 */
                            if (kind === 'diff' && file.callId && file.added != null) {
                              openDiffTab(tabId, file.callId, name);
                              return;
                            }
                            openPreviewTab(full, full, name, cwd ?? undefined);
                          }}
                        />
                      ) : null}
                    </>
                  );
                })()}
              </div>
            );
          })}
        </div>
        {/* 运行指示（DSH `RunningStatus`，见 features/chat/RunningStatus.tsx）：
            挂在**内容流的最末尾**、在滚动容器里跟着内容走 —— 它说的是"这一轮的进展"，
            不是输入框的状态。滚上去看历史时它跟着沉到底下，与 DSH 一致。 */}
        {streaming ? <RunningStatus startedAt={turnStartedAt} divider={tailHasOutput} /> : null}
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
  detail,
}: {
  tabId: string;
  id: string;
  /** `todo_write` 的调用 id → 它的上一份清单（见 `todoBaselines`） */
  baselines: Map<string, TodoItem[]> | null;
  /** 工作步骤展示档位（只有 `compact` 会改行的呈现：落定的思考摘要隐藏） */
  detail: TranscriptDetail;
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
      detail={detail}
      memory={memory}
    />
  );
}
