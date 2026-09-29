/**
 * 任务清单那一行（DSH `ui-tool/src/client/tool/toolviews/todo-row.tsx` 的移植）。
 *
 * 几何与文案逐条对齐 DSH：
 *
 * ```text
 * ▸ 更新任务清单 · 2/3 已完成 · 写文档        ← 24px 窄行（DisclosureRow）
 *   展开 ↓ 清单 + 与上次相比的变化
 * ```
 *
 * 三处 DSH 的细节，一条都没省：
 *
 * 1. **摘要分两半**：`2/3 已完成 · <第一件进行中的事>` 会被省略号截断，
 *    而"另外还有几条在跑"（`+N`）放在**不可省略**的右侧（DSH 的 `summarySuffix`）；
 * 2. **失败行不假装完成**：工具被拒（本仓的复杂度闸门就会拒）时显示错误文案，
 *    而不是把被拒的清单当成"写成功"（DSH：`todoDiffModel` 对 `isError` 直接返回 null）；
 * 3. **差异按行配对**：与**这一行之前**的那份清单比（`todoBaselines`），
 *    不是与"当前清单"比 —— 否则往上翻历史时每一行都在说谎。
 */
import { slotKey, useRowFlag, type RowMemory } from '@/lib/rowMemory';
import { DisclosureRow } from '@/features/common/DisclosureRow';
import { Icon, type IconName } from '@/features/common/Icon';
import { Markdown } from './markdown';
import {
  TODO_ROW_TITLE,
  TODO_STATUS_LABEL,
  planSummary,
  rowSummary,
  todoDiff,
  type TodoItem,
} from '@/lib/todoModel';

/** 前导图标：DSH 用 `IconChecklistOutlineRegular`；本仓图标体系里最接近的是清单。 */
const TODO_ICON: IconName = 'checklist';

/** 状态 → 图标（三态在视觉上必须**一眼可分**：勾/转/空）。 */
const STATUS_ICON: Record<TodoItem['status'], IconName> = {
  completed: 'check',
  in_progress: 'loading',
  pending: 'circle-outline',
};

export interface TodoRowProps {
  /** 调用参数（`toolCalls[toolCallId]`） */
  args?: Record<string, unknown> | undefined;
  /** 工具结果正文（失败时是拒绝原因） */
  text: string;
  isError: boolean;
  /** 这一行之前的那份清单（`todoBaselines`；没有 = 首次记录） */
  baseline?: TodoItem[] | undefined;
  /** 前面还有未载入的历史（旧清单不可用时要说明） */
  hasMore?: boolean;
  /** 工具调用 id（门禁与测试用） */
  toolCallId?: string | undefined;
  /** 这一行的身份：展开态记忆（见 lib/rowMemory；缺省 = 不记忆） */
  memory?: RowMemory | undefined;
}

export function TodoRow({ args, text, isError, baseline, hasMore = false, toolCallId, memory }: TodoRowProps) {
  /* 展开态记忆在行外（同 ToolRow）：清单行也要熬过虚拟化的卸载/重挂。 */
  const [open, setOpen] = useRowFlag(slotKey(memory, 'todo'), 'open');
  const summary = rowSummary(args?.todos);
  const items = summary === null ? null : (args?.todos as TodoItem[]);
  const diff = items === null ? null : todoDiff(items, baseline ?? null, hasMore);
  const plan = items === null ? null : planSummary(items);

  // 摘要：清单读不出来时退回工具结果首行（被拒的调用就属于这一类）
  const headText = summary?.text ?? firstLine(text) ?? '清单不可读';

  return (
    <div
      className="pg-trow pg-todorow"
      data-todo-row
      data-state={isError ? 'error' : 'ok'}
      data-items={plan?.total ?? 0}
      data-tool-call-id={toolCallId || undefined}
      data-open={open || undefined}
    >
      <DisclosureRow
        icon={<Icon name={TODO_ICON} size={14} />}
        title={TODO_ROW_TITLE}
        open={open}
        expandable
        onToggle={() => setOpen((v) => !v)}
        keepContentWhenOpen
        rowClassName="pg-trow-head"
        bodyProps={{ 'data-todo-body': '1' }}
        collapsedContent={
          <>
            <span className="pg-trow-sep" aria-hidden="true" />
            <span
              className={`pg-trow-summary${isError ? ' pg-trow-summary-error' : ''}`}
              data-todo-summary
              title={headText}
            >
              {headText}
            </span>
            {/* `+N` 与差异摘要放在不可省略的一侧（DSH `summarySuffix`） */}
            {!isError && summary && summary.extra > 0 ? (
              <span className="pg-todo-extra" data-todo-extra>
                +{summary.extra}
              </span>
            ) : null}
            {!isError && diff?.comparable && diff.summary ? (
              <span className="pg-todo-diff-summary" data-todo-diff>
                {diff.summary}
              </span>
            ) : null}
          </>
        }
      >
        {isError ? (
          // 失败：把模型的拒绝原因原样摊开（这是"约束看得见"的地方）
          <div className="pg-todo-error" data-todo-error>
            <Markdown text={text} compact />
          </div>
        ) : items === null ? (
          <div className="pg-todo-error" data-todo-error>
            这次调用的参数读不出清单（可能是被拒或中途截断的调用）。
          </div>
        ) : (
          <div className="pg-todo-body">
            {diff ? (
              <div className="pg-todo-caption" data-todo-caption>
                {diff.caption}
                {diff.unchanged > 0 ? ` · ${diff.unchanged} 项未变化` : ''}
              </div>
            ) : null}
            <ul className="pg-todo-list" data-todo-list>
              {items.map((item) => {
                const change = diff?.changes.get(item.content);
                return (
                  <li
                    key={item.content}
                    className="pg-todo-item"
                    data-status={item.status}
                    data-change={change && change !== 'same' ? change : undefined}
                  >
                    <span className="pg-todo-glyph" title={TODO_STATUS_LABEL[item.status]}>
                      <Icon name={STATUS_ICON[item.status]} size={12} />
                    </span>
                    <span className="pg-todo-content">{item.content}</span>
                    <span className="pg-todo-status">{TODO_STATUS_LABEL[item.status]}</span>
                  </li>
                );
              })}
            </ul>
            {/* 被移除的条目：整表替换下"消失了"也是一次要看得见的变化 */}
            {diff && diff.removedItems.length > 0
              ? diff.removedItems.map((item) => (
                  <div key={`gone-${item.content}`} className="pg-todo-item pg-todo-removed" data-change="removed">
                    <span className="pg-todo-glyph">
                      <Icon name="close" size={12} />
                    </span>
                    <span className="pg-todo-content">{item.content}</span>
                    <span className="pg-todo-status">已移除</span>
                  </div>
                ))
              : null}
            {text ? (
              <pre className="pg-todo-result" data-todo-result>
                {text}
              </pre>
            ) : null}
          </div>
        )}
      </DisclosureRow>
    </div>
  );
}

/** 取文本首行（摘要兜底）。 */
function firstLine(text: string): string | null {
  const line = text.split('\n').find((l) => l.trim() !== '');
  return line ? line.trim() : null;
}
