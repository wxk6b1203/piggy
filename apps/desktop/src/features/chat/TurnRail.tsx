/**
 * 会话预览滚动条（DSH 叫 TurnNavigator，docs/04 §2.6、docs/12 §3）。
 *
 * ## 它是什么
 *
 * 主会话区一侧的一条**固定间距刻度梯**：一条刻度 = 一轮对话。亮度表达状态：
 *
 * | 状态 | 形状 | 颜色 |
 * |---|---|---|
 * | 静息 | 20×2px，`scaleX(0.6)` | border-l4（暗） |
 * | 悬停/聚焦 | `scaleX(0.9)` | label-tertiary |
 * | **当前阅读到的这一轮** | `scaleX(1)`（满宽） | label-primary（**亮**） |
 * | 键盘焦点 | `scaleX(1)` + 品牌色 + 细环 | business-primary |
 *
 * 悬停某条刻度 → 弹出预览框（标题=用户那条消息，正文=回答摘要）；点击 → 跳到那一轮。
 * 当前刻度会**跟着滚动走**，并在梯子内部把它居中（指针停在梯子上时不抢）。
 *
 * ## 与 DSH 的两处差异（都是有意的）
 *
 * 1. **刻度梯的间距固定 10px，不按文档长度比例**（DSH 同款）。按比例画的话，
 *    一轮很长的回答会把后面所有刻度挤成一堆，梯子就看不出形状了；固定间距下
 *    梯子比可视带高时**在梯子内部滚动**（两端用渐隐提示还能滚）。
 * 2. DSH 只放在右侧，这里支持左/右/关（用户要求的三态开关，docs/03 §2.2）。
 *    左置时刻度改为左对齐、预览框翻到右侧——否则预览会盖住正文。
 *
 * ## 为什么要虚拟化
 *
 * 一场长会话可以有几千轮。刻度固定 10px，几千条就是几万个像素——全量渲染会
 * 在每次滚动时都重排。用与转录同一个库（`@tanstack/react-virtual`）只渲染可视段。
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RailItem } from './turnRailItems';

/** 相邻刻度的固定间距（DSH `TURN_SPACING_PX`）。 */
export const TURN_SPACING_PX = 10;
/** 梯子两端各留的空白（DSH `RAIL_INSET_PX`）。 */
export const RAIL_INSET_PX = 6;
/** 可滚动端的渐隐带宽（DSH `FADE_PX`）。 */
export const FADE_PX = 24;
/** 梯子最大高度（DSH：`min(band - 64, 420)`；这里的带就是转录的可视高度）。 */
const RAIL_MAX_PX = 420;

export interface TurnRailProps {
  items: readonly RailItem[];
  /** 当前阅读到的轮次（null = 还没算出来） */
  activeTurn: number | null;
  placement: 'left' | 'right';
  /** 跳到某一轮（给的是转录里的行下标） */
  onJump: (rowIndex: number) => void;
  /** 上面还有没载入的历史（分页，docs/03 §2.19） */
  hasMore?: boolean;
  /** 点"未载入"那一端 → 加载更早一页（DSH 未加载刻度的同义行为） */
  onLoadOlder?: () => void;
}

export function TurnRail({ items, activeTurn, placement, onJump, hasMore, onLoadOlder }: TurnRailProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const [previewTurn, setPreviewTurn] = useState<number | null>(null);
  /** 指针停在梯子上时，别把它从用户手底下滚走（DSH 同一条纪律）。 */
  const pointerInside = useRef(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [bandH, setBandH] = useState(0);
  const previewId = useId();

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => railRef.current,
    estimateSize: () => TURN_SPACING_PX,
    // 固定间距，不需要 measureElement；留 8 条余量足够
    overscan: 8,
    getItemKey: (i) => items[i]?.turn ?? i,
  });

  // 梯子的高度跟着转录可视高度走（带高 - 64，并封顶 420）
  useEffect(() => {
    const el = railRef.current?.parentElement;
    if (!el) return;
    const apply = () => setBandH(el.clientHeight);
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const total = virtualizer.getTotalSize() + RAIL_INSET_PX * 2;
  const height = bandH > 0 ? Math.min(Math.max(0, bandH - 64), RAIL_MAX_PX) : RAIL_MAX_PX;
  const maxScroll = Math.max(0, total - height);

  const activeIndex = useMemo(
    () => items.findIndex((it) => it.turn === activeTurn),
    [items, activeTurn],
  );

  // 让当前刻度待在梯子中部（指针不在梯子上时才动它）。
  // 用一个 ref 记住"上一次是因为什么滚的"，避免与用户的滚动打架。
  useLayoutEffect(() => {
    const el = railRef.current;
    if (!el || activeIndex < 0 || pointerInside.current || maxScroll <= 0) return;
    const center = RAIL_INSET_PX + activeIndex * TURN_SPACING_PX + TURN_SPACING_PX / 2;
    const target = Math.max(0, Math.min(maxScroll, center - el.clientHeight / 2));
    // 已经落在可视带里就不动——每次滚动都居中会让梯子一直在抖
    if (center - el.scrollTop >= FADE_PX && center - el.scrollTop <= el.clientHeight - FADE_PX) return;
    el.scrollTop = target;
    setScrollTop(target);
  }, [activeIndex, maxScroll]);

  const onRailScroll = useCallback(() => {
    const el = railRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  // 刻度不足 2 条时梯子没有形状——但"上面还有未载入的历史"时仍要露出那一端
  if (items.length < 2 && !hasMore) return null;

  const preview = previewTurn === null ? undefined : items.find((it) => it.turn === previewTurn);
  const previewIndex = preview ? items.indexOf(preview) : -1;
  const fadeTop = scrollTop > 1;
  const fadeBottom = scrollTop < maxScroll - 1;

  return (
    <div
      className={`pg-rail pg-rail-${placement}`}
      data-turn-rail
      data-rail-placement={placement}
      data-rail-count={items.length}
      style={{ height }}
      // 进/出整条梯子（DSH 把这一对挂在 nav 上）。
      // ⚠️ 少了 onPointerLeave，鼠标移开后预览框会**一直挂着**——刻度只有 10px 高，
      //    离开时几乎不会落在另一条刻度上，所以永远不会被覆盖掉。
      onPointerEnter={() => {
        pointerInside.current = true;
      }}
      onPointerLeave={() => {
        pointerInside.current = false;
        setPreviewTurn(null);
      }}
    >
      <div
        ref={railRef}
        className={`pg-rail-scroll${fadeTop ? ' is-fade-top' : ''}${fadeBottom ? ' is-fade-bottom' : ''}`}
        onScroll={onRailScroll}
      >
        <div style={{ height: total, position: 'relative' }}>
          {/* 未载入的历史：梯子最顶端一段虚线刻度（DSH 的 unloaded anchor 同义）。
              点它就再翻一页——比"刻度从有到无"更能说明"上面还有"。 */}
          {hasMore && (
            <button
              type="button"
              className="pg-rail-mark pg-rail-unloaded"
              data-rail-unloaded
              aria-label="上面还有更早的历史，点击加载更早"
              title="上面还有更早的历史（点这里加载更早）"
              style={{ position: 'absolute', top: 0, height: RAIL_INSET_PX, left: 0, right: 0 }}
              onClick={onLoadOlder}
            />
          )}
          {virtualizer.getVirtualItems().map((vi) => {
            const item = items[vi.index];
            if (!item) return null;
            const active = item.turn === activeTurn;
            const hovered = item.turn === previewTurn;
            const cls = [
              'pg-rail-mark',
              active ? 'is-active' : '',
              hovered && !active ? 'is-preview' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <button
                key={vi.key}
                type="button"
                data-index={vi.index}
                data-rail-mark={item.turn}
                className={cls}
                aria-label={`跳到第 ${item.turn} 轮`}
                aria-current={active ? 'true' : undefined}
                aria-describedby={hovered ? previewId : undefined}
                style={{
                  position: 'absolute',
                  top: RAIL_INSET_PX + vi.start,
                  height: TURN_SPACING_PX,
                  left: 0,
                  right: 0,
                }}
                onPointerEnter={() => setPreviewTurn(item.turn)}
                onFocus={() => setPreviewTurn(item.turn)}
                onBlur={() => setPreviewTurn(null)}
                onClick={() => onJump(item.rowIndex)}
              />
            );
          })}
        </div>
      </div>
      {preview && (
        <div
          id={previewId}
          role="tooltip"
          className="pg-rail-preview"
          data-rail-preview
          style={{
            // 跟着被悬停的那条刻度竖直居中，并夹在梯子范围内（DSH 的 clamp 同款）
            top: Math.max(
              0,
              Math.min(
                height - 100,
                RAIL_INSET_PX + previewIndex * TURN_SPACING_PX - scrollTop + TURN_SPACING_PX / 2 - 50,
              ),
            ),
          }}
        >
          <div className="pg-rail-preview-prompt" data-rail-preview-prompt>
            {preview.prompt || `第 ${preview.turn} 轮`}
          </div>
          {preview.response !== '' && (
            <div className="pg-rail-preview-response" data-rail-preview-response>
              {preview.response}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
