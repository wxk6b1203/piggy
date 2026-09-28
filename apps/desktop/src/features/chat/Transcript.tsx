/**
 * 会话转录（docs/04 §2.1）：虚拟化 + per-tab 实时块挂载点 + 预览滚动条（§2.6）。
 *
 * 预览滚动条挂在**这里**而不是会话工作区：它要的东西全在这个组件手里——
 * 滚动容器、虚拟化器（"第几行在阅读线上"与"跳到第几行"都靠它）。
 * 放到上层就得把这些再往外提一层，多一份需要同步的状态。
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { liveFor } from '@/lib/live';
import { useAppConfig } from '@/stores/appConfig';
import { useMessages, useTabMsg, type MessageView as MessageViewT } from '@/stores/messages';
import { MessageView } from './MessageView';
import { activeTurnOf, buildRailItems } from './turnRailItems';
import { TurnRail } from './TurnRail';

const LIVE_ID = '__live__';

export function Transcript({ tabId }: { tabId: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const ids = useTabMsg(tabId, (t) => t.ids);
  const streaming = useTabMsg(tabId, (t) => t.streaming);
  const byId = useTabMsg(tabId, (t) => t.byId);
  const rowIds = streaming ? [...ids, LIVE_ID] : ids;
  const railPlacement = useAppConfig((s) => s.railPlacement);

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

  // ── 预览滚动条：刻度来自 store 的**全部**消息（Piggy 一次性 hydrate 整段历史，
  //    所以梯子天然覆盖从头到尾每一轮，见 turnRail.ts 的说明）──
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
    const items = virtualizer.getVirtualItems();
    if (items.length === 0) return;
    // 阅读线：视口顶部往下 1/4（贴顶太灵敏，正中又会在一轮很长时乱跳）
    const line = el.scrollTop + Math.min(120, el.clientHeight / 4);
    let readingRow = items[0]!.index;
    for (const vi of items) {
      if (vi.start <= line) readingRow = vi.index;
      else break;
    }
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
    setActiveTurn(activeTurnOf(railItems, readingRow, atBottom));
  }, [virtualizer, railItems]);

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
      virtualizer.scrollToIndex(rowIndex, { align: 'start' });
    },
    [virtualizer],
  );

  const lastId = ids.at(-1);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !lastId) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (nearBottom) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }, [lastId]);

  return (
    <div className="pg-transcript-wrap" data-rail-side={railPlacement}>
      <div ref={scrollRef} className="pg-transcript">
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
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
      {railPlacement !== 'off' && (
        <TurnRail
          items={railItems}
          activeTurn={activeTurn}
          placement={railPlacement}
          onJump={jumpToRow}
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
