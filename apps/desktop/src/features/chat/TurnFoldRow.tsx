/**
 * 回合折叠行（DSH `TurnProcessNodeView` 的标题行，docs/04 §2.1.6）。
 *
 * ```
 * ▾ 已完成工作 ········································ 12s      ← 33px，下边框 .5px
 *   （展开时下面就是这一轮的过程行）
 * ```
 *
 * 几何照抄 DSH：**33px 高**（`33px + font-delta`）、`0.5px` 下边框、标题 13px/500、
 * 右侧的耗时用**等宽数字**（`tabular-nums`）且字号小一档 —— 时间在变，比例数字会左右抖。
 *
 * 状态与颜色：`已停止` / `处理失败` 用弱色/错误色（它们不是"成功"，别画成绿的）；
 * 只有 `已完成工作` 用普通次要色。**中止与失败的回合不给折叠**（DSH：
 * `Stopped or failed | Keep process content open; whole-Turn collapse is unavailable`）——
 * 过程就是排查现场，折起来等于藏证据；标题仍然画，好让人知道这一轮怎么结束的。
 */
import { Icon } from '@/features/common/Icon';
import type { TurnFold } from '@/lib/turnFold';
import { foldLabel } from '@/lib/turnFold';
import type { TranscriptDetail } from '@/stores/appConfig';

export function TurnFoldRow({
  fold,
  open,
  mode,
  onToggle,
}: {
  fold: TurnFold;
  /** 过程是否展开（`foldable` 为假时忽略：那种回合过程永远展开） */
  open: boolean;
  mode: TranscriptDetail;
  onToggle: () => void;
}) {
  // 简洁档不显示耗时（DSH：Compact 的组头是"只有类别摘要"）
  const { title, trailing } = foldLabel(fold, mode === 'compact');
  const expandable = fold.foldable;
  const expanded = !foldable(fold) || open;
  const state = fold.status === 'failed' ? 'error' : fold.status === 'aborted' ? 'stopped' : 'ok';

  return (
    <div className="pg-turnfold" data-turn-fold data-turn={fold.turn} data-state={state} data-open={expandable && expanded ? '' : undefined}>
      <button
        type="button"
        className="pg-turnfold-head"
        data-expandable={expandable || undefined}
        aria-expanded={expandable ? expanded : undefined}
        aria-label={expandable ? `${title}（这一轮的过程，点击${expanded ? '收起' : '展开'}）` : title}
        disabled={!expandable}
        onClick={expandable ? onToggle : undefined}
      >
        {expandable ? (
          <span className="pg-turnfold-caret" data-turn-fold-caret>
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
          </span>
        ) : (
          <span className="pg-turnfold-caret" aria-hidden="true">
            <Icon name={state === 'ok' ? 'circle-outline' : state === 'error' ? 'error' : 'circle-slash'} size={12} />
          </span>
        )}
        <span className="pg-turnfold-title">{title}</span>
        <span className="pg-turnfold-rule" aria-hidden="true" />
        {trailing ? <span className="pg-turnfold-duration">{trailing}</span> : null}
      </button>
    </div>
  );
}

/** 这一轮的过程此刻是不是摊开的（不可折的回合恒为摊开）。 */
export function foldable(fold: TurnFold): boolean {
  return fold.foldable;
}
