/**
 * 三轨时间线（DSH `TrajectoryTimeline`，docs/12 §4.7）。
 *
 * 三条泳道按事件种类分区（`laneFor`）：
 *   0 = 输入（system / user / context）  1 = 模型（助手 / 已压缩）  2 = 工具（tool / subtool）
 *
 * 几何照抄 DSH：标签栏 44px + 轨道；整块高 50px；lane 顶 = `lane * 14px`（相对 `.lanes` 的 7px 内缩，
 * 于是三轨实际落在 7 / 21 / 35px）；span 高 8px、圆角 1px、最小宽 2px。
 *
 * 数据来源说明：docs/04 §1.10 曾把三轨排在 M2 并注明"需要 Rust 侧补时间戳"——
 * 那是指**实时帧**通道；而本视图的主数据源是 `get_entries`（append-only 账本），
 * 每条记录本来就带 `timestamp`（`stores/trajectory.ts` 已解析为 `ts`），
 * 因此账本时间线**无需 Rust 改动**即可落地。缺时间戳时才退化为等宽 sequence 模式。
 */
import { useMemo, useState } from 'react';
import type { TrajKind, TrajRow } from '@/stores/trajectory';

/** DSH `laneFor`：工具→2，模型→1，其余→0。 */
export function laneFor(kind: TrajKind): 0 | 1 | 2 {
  if (kind === 'tool') return 2;
  if (kind === 'assistant' || kind === 'compaction') return 1;
  return 0;
}

const LANE_LABEL = ['输入', '模型', '工具'] as const;

export interface TimelineSpan {
  index: number;
  kind: TrajKind;
  lane: 0 | 1 | 2;
  /** 0–1 归一化位置与宽度 */
  left: number;
  width: number;
  startMs: number | null;
  endMs: number | null;
  turnStart: boolean;
}

/**
 * 由行序列算出 span 布局。
 * 有时间戳 → 用相邻记录的时间差作区间；无时间戳 → 每条记录一个等宽槽（sequence 模式）。
 */
export function buildSpans(rows: TrajRow[]): { spans: TimelineSpan[]; timed: boolean } {
  if (rows.length === 0) return { spans: [], timed: false };

  const timed = rows.some((r) => typeof r.ts === 'number');
  const spans: TimelineSpan[] = [];

  if (!timed) {
    const slot = 1 / rows.length;
    rows.forEach((r, i) => {
      spans.push({
        index: i,
        kind: r.kind,
        lane: laneFor(r.kind),
        left: i * slot,
        width: slot,
        startMs: null,
        endMs: null,
        turnStart: r.kind === 'user',
      });
    });
    return { spans, timed: false };
  }

  const times = rows.map((r) => (typeof r.ts === 'number' ? r.ts : null));
  const known = times.filter((t): t is number => t !== null);
  const min = Math.min(...known);
  const max = Math.max(...known);
  // 全部同一时刻时给一个名义跨度，避免除以 0
  const domain = max > min ? max - min : 1;

  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i]!;
    // 无时间戳的记录借用前一条的时间点，宽度按后续补足
    const start = times[i] ?? times.slice(0, i).reverse().find((t) => t !== null) ?? min;
    const next = times.slice(i + 1).find((t) => t !== null) ?? start;
    const end = next > start ? next : start;
    const left = (start - min) / domain;
    const width = Math.max((end - start) / domain, 1 / 240); // 保底可见（约 0.4%）
    spans.push({
      index: i,
      kind: r.kind,
      lane: laneFor(r.kind),
      left: Math.max(0, Math.min(1, left)),
      width: Math.min(width, 1 - Math.max(0, Math.min(1, left))),
      startMs: start,
      endMs: end,
      turnStart: r.kind === 'user',
    });
  }
  return { spans, timed: true };
}

export function TrajectoryTimeline({
  rows,
  selectedIndex,
  onSelect,
}: {
  rows: TrajRow[];
  selectedIndex: number | null;
  onSelect: (index: number | null) => void;
}) {
  const { spans, timed } = useMemo(() => buildSpans(rows), [rows]);
  const [hover, setHover] = useState<TimelineSpan | null>(null);

  if (spans.length === 0) return null;

  return (
    <div className="pg-tl" role="group" aria-label="轨迹时间线">
      <div className="pg-tl-plot">
        <div className="pg-tl-labels" aria-hidden="true">
          {LANE_LABEL.map((l) => (
            <span key={l}>{l}</span>
          ))}
        </div>
        <div
          className="pg-tl-track"
          title="时间线概览；点击可定位事件"
          onClick={() => onSelect(null)}
        >
          <div className="pg-tl-lanes">
            {/* 轮次边界：每条 user 记录起点画一条 0.5px 竖线 */}
            {spans
              .filter((s) => s.turnStart)
              .map((s) => (
                <span
                  key={`tb-${s.index}`}
                  className="pg-tl-turnboundary"
                  style={{ left: `${s.left * 100}%` }}
                />
              ))}
            {spans.map((s) => (
              <span
                key={s.index}
                className="pg-tl-span"
                data-kind={s.kind}
                data-selected={selectedIndex === s.index || undefined}
                data-hovered={hover?.index === s.index || undefined}
                style={
                  {
                    '--tl-left': `${s.left * 100}%`,
                    '--tl-width': `${s.width * 100}%`,
                    '--tl-lane': s.lane,
                  } as React.CSSProperties
                }
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(selectedIndex === s.index ? null : s.index);
                }}
                onMouseEnter={() => setHover(s)}
                onMouseLeave={() => setHover((h) => (h?.index === s.index ? null : h))}
              />
            ))}
          </div>
          {hover && (
            <span
              className="pg-tl-hoverline"
              style={{ left: `${(hover.left + hover.width / 2) * 100}%` }}
            />
          )}
        </div>
      </div>
      <div className="pg-tl-caption">
        {hover ? <SpanTip span={hover} row={rows[hover.index]} /> : timed ? '按时间跨度' : '无计时数据（等宽）'}
      </div>
    </div>
  );
}

function SpanTip({ span, row }: { span: TimelineSpan; row?: TrajRow }) {
  const dur = span.startMs != null && span.endMs != null ? span.endMs - span.startMs : null;
  return (
    <>
      <b>{LANE_LABEL[span.lane]}</b>
      {dur != null ? ` · ${formatDuration(dur)}` : ''}
      {row?.text ? ` · ${row.text.slice(0, 48)}` : ''}
    </>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
