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
 * ## 跟随策略照抄 DSH（2026-09-24 改回）
 *
 * DSH `TurnNavigator.tsx` 的 `scrollToIndex(index, reveal, behavior)`：
 * 目标位置 = **把这一格居中**（`center = item.start + item.size/2`，`top = center - height/2`），
 * 但 `reveal === 'if-needed'` 时先看它有没有跑出**渐隐带**（`scrollPadding = FADE_PX`，
 * 上下各 24px）—— 在带子里就一动不动。跟随用平滑滚动（尊重 `prefers-reduced-motion`）；
 * 首次拿到非零高度时是 `'always'`（开局就把当前刻度居中）。
 *
 * 本仓早先自己发明过"最小幅度跟随"（跑出带子时只把它拉回带内，不居中），
 * 现在**删掉**、按 DSH 来（用户 2026-09-24："有意偏离 DSH 的行为，都对标 DSH"）。
 * 刻度间距固定 10px、梯子最大 420px、两端渐隐 24px 这些数值本来就和 DSH 一致。
 *
 * ## 唯一保留的差异：左/右/关三态
 *
 * DSH 只放在右侧。这个开关是本仓自己的产品功能（docs/03 §2.2），**默认值就是 DSH 的右侧**；
 * 左置时刻度左对齐、预览框翻到另一侧（否则预览会盖住正文）。
 *
 * ## 为什么要虚拟化
 *
 * 一场长会话可以有几千轮。刻度固定 10px，几千条就是几万个像素——全量渲染会
 * 在每次滚动时都重排。用与转录同一个库（`@tanstack/react-virtual`）只渲染可视段。
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { watchSize } from '@/lib/resizeWatch';
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
  /** 跳到某一轮：已载入的滚过去，未载入的先把历史翻页进来（docs/04 §2.6） */
  onJump: (item: RailItem) => void;
  /** 正在为哪一轮翻页（忙碌标记） */
  pendingTurn?: number | null;
}

export function TurnRail({ items, activeTurn, placement, onJump, pendingTurn }: TurnRailProps) {
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

  /**
   * 梯子的高度跟着**转录可视带**的高度走（带高 - 64，并封顶 420）。
   *
   * ⚠️ 必须量转录带（`.pg-transcript-wrap`），**不能量 `.pg-rail` 自己**：
   * `.pg-rail` 的高度正是由这里的 `bandH` 算出来的，量自己 = 自触发循环 ——
   * bandH 420 → 高度 356 → bandH 356 → 高度 292 → … → 0 → 420 → …
   * 浏览器会直接报 `ResizeObserver loop completed with undelivered notifications`
   * （用户 2026-09-23 贴的日志里连着三条），而副作用是**梯子高度与可滚范围不停变**，
   * 于是"没人滚，梯子自己在动"（用户多次截图的刻度位置都不一样）。
   *
   * 另外只在新值真的不同时 setState：观察者回调里做无谓的 set 会白跑一轮渲染。
   *
   * 观察者走 `lib/resizeWatch` 的**共享实例**（全应用一个）：梯子只是众多订阅者之一，
   * 一次投递把所有订阅者的回调跑完、React 合成一次渲染，链只有一圈。
   */
  useEffect(() => {
    const el = railRef.current?.closest('.pg-transcript-wrap');
    if (!el) return;
    const apply = () => {
      const h = el.clientHeight;
      setBandH((prev) => (prev === h ? prev : h));
    };
    apply();
    return watchSize(el, apply);
  }, []);

  const total = virtualizer.getTotalSize() + RAIL_INSET_PX * 2;
  const height = bandH > 0 ? Math.min(Math.max(0, bandH - 64), RAIL_MAX_PX) : RAIL_MAX_PX;
  const maxScroll = Math.max(0, total - height);

  const activeIndex = useMemo(
    () => items.findIndex((it) => it.turn === activeTurn),
    [items, activeTurn],
  );

  /**
   * 把某一格滚到梯子中间（DSH `scrollToIndex` 的同义实现）。
   *
   * @param reveal - `'if-needed'`：已经在**渐隐带**里就一动不动（跟随用）；
   *                 `'always'`：无条件居中（开局定位用）
   */
  const scrollToMark = useCallback((index: number, reveal: 'if-needed' | 'always') => {
    const el = railRef.current;
    const height = el?.clientHeight ?? 0;
    if (!el || index < 0 || height <= 0) return;
    const center = RAIL_INSET_PX + index * TURN_SPACING_PX + TURN_SPACING_PX / 2;
    const current = el.scrollTop;
    if (reveal === 'if-needed' && center >= current + FADE_PX && center <= current + height - FADE_PX) {
      return;
    }
    const max = Math.max(0, el.scrollHeight - height);
    const target = Math.max(0, Math.min(max, center - height / 2));
    if (Math.abs(target - current) < 1) return;
    // 动效偏好：能平滑就平滑（DSH `preferredScrollBehavior`），否则直接跳
    const smooth =
      typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ top: target, behavior: smooth ? 'smooth' : 'auto' });
    setScrollTop(target);
  }, []);

  /** 开局：第一次拿到真实高度时把当前刻度**居中**（DSH 的 `'always'` 那一次）。 */
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (placed.current || bandH <= 0 || activeIndex < 0) return;
    placed.current = true;
    scrollToMark(activeIndex, 'always');
  }, [bandH, activeIndex, scrollToMark]);

  /** 跟随：只在当前刻度跑出渐隐带时把它拉回中间（DSH 的 `'if-needed'`）。 */
  useLayoutEffect(() => {
    if (!placed.current || activeIndex < 0 || pointerInside.current) return;
    scrollToMark(activeIndex, 'if-needed');
  }, [activeIndex, scrollToMark]);

  const onRailScroll = useCallback(() => {
    const el = railRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  // 刻度不足 2 条时梯子没有形状
  if (items.length < 2) return null;
  const unloadedCount = items.filter((i) => !i.loaded).length;

  const preview = previewTurn === null ? undefined : items.find((it) => it.turn === previewTurn);
  const previewIndex = preview ? items.indexOf(preview) : -1;
  const fadeTop = scrollTop > 1;
  const fadeBottom = scrollTop < maxScroll - 1;

  return (
    <nav
      className={`pg-rail pg-rail-at-${placement}`}
      aria-label="会话轮次导航"
      data-turn-rail
      data-rail-placement={placement}
      data-rail-count={items.length}
      data-rail-unloaded-count={unloadedCount}
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
          {virtualizer.getVirtualItems().map((vi) => {
            const item = items[vi.index];
            if (!item) return null;
            const active = item.turn === activeTurn;
            const hovered = item.turn === previewTurn;
            const cls = [
              'pg-rail-mark',
              // 未载入的刻度画成虚线（DSH 的 `markUnloaded`）：点它先把历史翻页进来
              item.loaded ? '' : 'pg-rail-unloaded',
              pendingTurn === item.turn ? 'is-busy' : '',
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
                data-rail-unloaded={item.loaded ? undefined : true}
                data-rail-busy={pendingTurn === item.turn ? true : undefined}
                className={cls}
                aria-label={
                  item.loaded
                    ? `跳到第 ${item.turn} 轮`
                    : `第 ${item.turn} 轮还没载入，点击加载并跳过去`
                }
                title={item.loaded ? undefined : '还没载入（点击加载并跳过去）'}
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
                onClick={() => onJump(item)}
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
    </nav>
  );
}
