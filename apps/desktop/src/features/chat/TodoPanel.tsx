/**
 * 计划面板（DSH `ui-conversation/src/client/skeleton/TodoPanel.tsx` 的移植）。
 *
 * 位置也对齐 DSH：它挂在 `conversation.input.dock` 这个槽上，而 DSH 渲染那个槽的地方
 * 正是**输入卡的正上方**（`ConversationContent.tsx:155-161`：先 dock，再 `inputBar`）。
 *
 * 几何逐条照抄 DSH 的 `TodoPanel.module.css`：
 *
 * ```text
 * 圆角 12px · padding 6px 12px · 头部 gap 10px [16px 清单图标][任务 13px/24px 500]
 * [进度 flex:1 省略号 13px/20px 三级色][chevron] · 列表 gap 8px · max-height 180px 可滚
 * 每一项 gap 10px [16×16 状态字形][内容 13px/20px 二级色 单行省略号]
 * ```
 *
 * 两层"默认折起来"（与 DSH 一致）：面板默认只露头部一行（进度看得到，清单看不见），
 * 点开才展开列表；列表内部超 180px 自己滚，不会把输入框顶出屏幕。
 *
 * 三处与本仓有关的判断：
 *   1. **没有能力就不渲染任何东西**（`supported`）—— 没装 todo 插件时界面与从前一模一样；
 *   2. 清空之后（`clearedByTurn`）不显示旧计划，但头部说清"上一轮有过清单"，而不是假装没有；
 *   3. 空清单（0 条）等价于没有计划 —— DSH 也是 `todos.length === 0 → null`。
 */
import { useState } from 'react';
import { Icon } from '@/features/common/Icon';
import { TODO_PANEL_TITLE, TODO_STATUS_LABEL, progressLabel } from '@/lib/todoModel';
import { useTabTodo, useTodoSupported } from '@/stores/todo';

/** 状态 → 图标（与转录行同一套：勾/转/空）。 */
const STATUS_ICON = { completed: 'check', in_progress: 'loading', pending: 'circle-outline' } as const;

export function TodoPanel({ tabId }: { tabId: string }) {
  const supported = useTodoSupported();
  const todos = useTabTodo(tabId, (t) => t.todos);
  const clearedByTurn = useTabTodo(tabId, (t) => t.clearedByTurn);
  const writes = useTabTodo(tabId, (t) => t.writes);
  const source = useTabTodo(tabId, (t) => t.source);
  const chainBroken = useTabTodo(tabId, (t) => t.chainBroken);
  const [open, setOpen] = useState(false);

  if (!supported) return null;
  const items = todos ?? [];
  if (items.length === 0) {
    // 清空过就说清楚（DSH 的 turn/start 清空是**设计**，不是丢失）
    if (clearedByTurn && writes > 0) {
      return (
        <section className="pg-todo-panel pg-todo-panel-quiet" data-todo-panel data-todo-state="cleared">
          <span className="pg-todo-panel-lead" aria-hidden="true">
            <Icon name="checklist" size={14} />
          </span>
          <span className="pg-todo-panel-title">{TODO_PANEL_TITLE}</span>
          <span className="pg-todo-panel-progress" data-todo-cleared>
            上一轮的任务清单已归档（新一轮开始）
          </span>
        </section>
      );
    }
    return null;
  }

  const progress = progressLabel(items);

  return (
    <section className="pg-todo-panel" data-todo-panel data-todo-state="active" aria-label={TODO_PANEL_TITLE}>
      <div className="pg-todo-panel-body">
        <button
          type="button"
          className="pg-todo-panel-head"
          data-todo-panel-head
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <span className="pg-todo-panel-lead" aria-hidden="true">
            <Icon name="checklist" size={14} />
          </span>
          <span className="pg-todo-panel-title">{TODO_PANEL_TITLE}</span>
          <span className="pg-todo-panel-progress" data-todo-progress title={progress}>
            {progress}
          </span>
          {/* 数据来源：条目（插件写的会话事件）还是工具调用参数 —— 排障时一眼看得出 */}
          <span
            className="pg-todo-panel-source"
            data-todo-source={source ?? 'none'}
            data-todo-chain={chainBroken ? 'broken' : undefined}
            title={
              chainBroken
                ? '分支链条走断：这份计划是按文件顺序折出来的（可能是最新一次写入，但不保证在活动分支上）'
                : source === 'event'
                  ? '来自插件写入的 todo/write 会话条目'
                  : source === 'call'
                    ? '来自 todo_write 的调用参数（没有对应的会话条目）'
                    : '来自本会话的实时事件'
            }
          >
            {source === 'event' ? '条目' : source === 'call' ? '调用' : '实时'}
            {chainBroken ? '?' : ''}
          </span>
          <span className="pg-todo-panel-chevron" aria-hidden="true">
            <Icon name={open ? 'chevron-up' : 'chevron-down'} size={14} />
          </span>
        </button>
        {open ? (
          <ul className="pg-todo-panel-list" data-todo-panel-list>
            {items.map((item) => (
              <li key={item.content} className="pg-todo-panel-item" data-status={item.status}>
                <span className="pg-todo-panel-glyph" title={TODO_STATUS_LABEL[item.status]}>
                  <Icon name={STATUS_ICON[item.status]} size={12} />
                </span>
                <span className="pg-todo-panel-content">{item.content}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
