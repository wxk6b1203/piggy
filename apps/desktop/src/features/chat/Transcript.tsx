/** 会话转录（docs/04 §2.1）：虚拟化 + per-tab 实时块挂载点 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { liveFor } from '@/lib/live';
import { useMessages, useTabMsg, type MessageView as MessageViewT } from '@/stores/messages';
import { MessageView } from './MessageView';

const LIVE_ID = '__live__';

export function Transcript({ tabId }: { tabId: string }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const ids = useTabMsg(tabId, (t) => t.ids);
  const streaming = useTabMsg(tabId, (t) => t.streaming);
  const rowIds = streaming ? [...ids, LIVE_ID] : ids;

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
