/** 会话转录（docs/04 §2.1 Transcript v1）：虚拟化 + 实时块挂载点 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import { live } from '@/lib/live';
import { useMessages, type MessageView as MessageViewT } from '@/stores/messages';
import { MessageView } from './MessageView';

const LIVE_ID = '__live__';

export function Transcript() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const liveRef = useRef<HTMLDivElement>(null);
  const ids = useMessages((s) => s.ids);
  const streaming = useMessages((s) => s.streaming);
  const rowIds = streaming ? [...ids, LIVE_ID] : ids;

  const virtualizer = useVirtualizer({
    count: rowIds.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 88,
    overscan: 6,
    getItemKey: (i) => rowIds[i] ?? `row-${i}`,
  });

  // 实时块挂载/卸载（瞬态通道，不触发 React 渲染）
  useEffect(() => {
    const container = liveRef.current;
    const scroller = scrollRef.current;
    if (container && scroller) live.mount(container, scroller);
    return () => live.unmount();
  }, [streaming]);

  // 新消息到达：贴底跟随
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
                <Row id={id} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row({ id }: { id: string }) {
  const view = useStore(useMessages, (s) => s.byId[id] as MessageViewT | undefined);
  if (!view) return null;
  return <MessageView view={view} />;
}
