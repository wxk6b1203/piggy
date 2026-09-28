/**
 * 任务清单的前端模型（纯函数，无 React、无 IPC）。
 *
 * 逐条对齐 DSH：
 *
 * | 本文件 | DSH |
 * |---|---|
 * | `planSummary` | `ui-tool/src/client/tool/toolviews/plan-summary.ts` |
 * | `rowSummary` | `ui-tool/.../todo-row.tsx` 的 `summarize()` |
 * | `progressLabel` | `ui-conversation/src/client/skeleton/TodoPanel.tsx` 的 `progressLabel()` |
 * | `todoDiff` | `ui-tool/.../models/todo-diff-model.ts` |
 * | 文案常量 | `ui-conversation/src/client/locales.ts:77-107,271`（中文原文） |
 *
 * 为什么值得单独一层：这些规则（"摘要只报数字与第一个进行中"、"空清单不显示"、
 * "变化要按内容配对"）在 DSH 里是**有测试的**行为，抄错一处界面就会开始说谎
 * —— 例如把并行进行中的其余任务从摘要里吞掉。所以它们必须是纯函数，能被逐个断言。
 */
import type { AgentMessage } from '@piggy/pi-protocol';

/** 三态（与 pi-todo / DSH 的 `TodoItem['status']` 同形）。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** 清单里的一项。 */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** 状态中文名（DSH `locales.ts:81-83` 逐字）。 */
export const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
  completed: '已完成',
  in_progress: '进行中',
  pending: '待处理',
};

/** 计划面板标题（DSH `locales.ts:77`）。 */
export const TODO_PANEL_TITLE = '任务';
/** 转录里那一行的标题（DSH `locales.ts:84` 的 `todo.rowTitle`）。 */
export const TODO_ROW_TITLE = '更新任务清单';

/** 面板里进度的分隔符：en space + `·` + en space（DSH 的注释说明了为什么不用 ASCII 空格）。 */
const PROGRESS_SEP = '\u2002·\u2002';

/** 状态是不是三态之一。 */
export function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

/**
 * 从任意 JSON 里读清单（形状不对 → `null`，绝不猜）。
 *
 * 与 Rust 侧 `read_todo_items` **同一条规则**：state 非法或字段缺失就整份丢掉。
 * 两边都实现是因为两条来路不同（Rust 读文件、前端读实时消息），
 * 而"半个清单"比"没有清单"更糟 —— 界面会显示一份模型从来没写过的计划。
 */
export function parseTodoList(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value)) return null;
  const out: TodoItem[] = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) return null;
    const item = raw as { content?: unknown; status?: unknown };
    if (typeof item.content !== 'string') return null;
    if (!isTodoStatus(item.status)) return null;
    out.push({ content: item.content, status: item.status });
  }
  return out;
}

/** 计划摘要（DSH `plan-summary.ts` 的 `PlanSummary`）。 */
export interface PlanSummary {
  done: number;
  total: number;
  /** 第一个"进行中"的内容；没有进行中、或第一条内容不可用时为 `null` */
  activeContent: string | null;
  /** 除第一条外还有几条在进行中；`activeContent` 为 `null` 时恒为 0 */
  activeExtra: number;
}

/**
 * 数出 done/total 与"正在进行的那件事"。
 *
 * **为什么不是"取唯一一条 in_progress"**：并行工作时可以有多条 —— 只报一条会把其余
 * 正在跑的任务从摘要里悄悄吞掉（DSH 的原注释就是这么写的）。所以这里返回
 * `activeExtra`，由行自己放在**不可省略**的那一侧。
 */
export function planSummary(items: readonly TodoItem[]): PlanSummary {
  const active = items.filter((t) => t.status === 'in_progress');
  const first = active[0]?.content;
  const named = typeof first === 'string' && first.trim() !== '';
  return {
    done: items.filter((t) => t.status === 'completed').length,
    total: items.length,
    activeContent: named ? (first as string) : null,
    activeExtra: named ? active.length - 1 : 0,
  };
}

/**
 * 转录里那一行的摘要：`3/5 已完成 · 写文档`（DSH `todo-row.tsx` 的 `summarize()`）。
 *
 * 两半**故意不拼在一起**：`text` 会被省略号截断，而"还有几条在跑"必须在截断之外
 * （这就是 `extra` 存在的原因）。清单形状不合法时返回 `null`，调用方退回通用摘要。
 */
export function rowSummary(value: unknown): { text: string; extra: number } | null {
  const items = parseTodoList(value);
  if (items === null) return null;
  const { done, total, activeContent, activeExtra } = planSummary(items);
  const head = `${done}/${total} 已完成`;
  return {
    text: activeContent === null ? head : `${head} · ${activeContent}`,
    extra: activeExtra,
  };
}

/**
 * 面板头部那行进度（DSH `TodoPanel.progressLabel`）：`2 已完成 · 1 进行中 · 1 待处理`。
 *
 * 计数为 0 的那段**略去**（噪音）；分隔符用 en space —— HTML 会把连续的 ASCII 空格
 * 折成一个，想要"呼吸感"只能上宽空格（DSH 的原注释）。
 */
export function progressLabel(items: readonly TodoItem[]): string {
  const done = items.filter((t) => t.status === 'completed').length;
  const active = items.filter((t) => t.status === 'in_progress').length;
  const pending = items.length - done - active;
  return [
    ...(done > 0 ? [`${done} 已完成`] : []),
    ...(active > 0 ? [`${active} 进行中`] : []),
    ...(pending > 0 ? [`${pending} 待处理`] : []),
  ].join(PROGRESS_SEP);
}

/** 一项相对上一份清单的变化（DSH `detail.todo.*` / `todo.diff.*Item` 的取值域）。 */
export type TodoChange = 'added' | 'updated' | 'moved' | 'removed' | 'same';

/** 一次写入相对上一份清单的差异。 */
export interface TodoDiff {
  /** 新增条数 */
  added: number;
  /** 状态变化 + 顺序调整的条数（DSH 把 moved 也算进 updated） */
  updated: number;
  /** 移除条数 */
  removed: number;
  /** 完全没动的条数 */
  unchanged: number;
  /** 一句话摘要（`新增 2 · 移除 1`），没有变化时是「清单没有变化」 */
  summary: string;
  /** 本次清单里每一条的变化（按内容索引；被移除的那些不在表里） */
  changes: Map<string, TodoChange>;
  /** 上一份清单里被移除的内容（正文里要单独列出来） */
  removedItems: TodoItem[];
  /** 有没有可比的上一次（`false` = 首次记录，或旧清单不可用） */
  comparable: boolean;
  /** 标题（DSH `todo.diff.initial` / `todo.diff.compare` / `todo.diff.unavailable`） */
  caption: string;
}

/**
 * 与上一份清单逐条对比（DSH `todo-diff-model.ts` 的算法）。
 *
 * 三条规则照抄：
 *   1. **按 `content` 配对**（整表替换下条目没有 id，内容就是身份）；
 *   2. 状态变了 → `updated`；顺序动了 → `moved`（两者都计入 `updated` 计数）；
 *   3. 上一份里有、这一份没有 → `removed`。
 *
 * `previous === null` 有两种含义，必须分开：
 *   - `hasMore = false` → 这是**首次记录**（前面真的没有清单了）；
 *   - `hasMore = true`  → 旧清单在**没载入的历史**里 → 摘要不可信，标成「旧清单不可用」。
 *
 * @param current - 本次清单
 * @param previous - 上一份清单（`null` = 没有可比对象）
 * @param hasMore - 前面是否还有未载入的历史
 * @returns 差异
 */
export function todoDiff(
  current: readonly TodoItem[],
  previous: readonly TodoItem[] | null,
  hasMore = false,
): TodoDiff {
  const changes = new Map<string, TodoChange>();
  if (previous === null) {
    return {
      added: 0,
      updated: 0,
      removed: 0,
      unchanged: 0,
      summary: '',
      changes,
      removedItems: [],
      comparable: false,
      caption: hasMore ? '旧清单不可用' : '首次记录',
    };
  }

  const previousByContent = new Map<string, TodoItem>();
  const previousOrder = new Map<string, number>();
  previous.forEach((item, index) => {
    previousByContent.set(item.content, item);
    previousOrder.set(item.content, index);
  });
  const currentContents = new Set(current.map((t) => t.content));

  let added = 0;
  let updated = 0;
  let unchanged = 0;
  let retainedIndex = 0;
  for (const item of current) {
    const before = previousByContent.get(item.content);
    if (before === undefined) {
      added += 1;
      changes.set(item.content, 'added');
      continue;
    }
    const moved = previousOrder.get(item.content) !== retainedIndex;
    retainedIndex += 1;
    if (before.status !== item.status) {
      updated += 1;
      changes.set(item.content, 'updated');
    } else if (moved) {
      updated += 1;
      changes.set(item.content, 'moved');
    } else {
      unchanged += 1;
      changes.set(item.content, 'same');
    }
  }
  const removedItems = previous.filter((t) => !currentContents.has(t.content));
  for (const item of removedItems) changes.set(item.content, 'removed');

  const parts = [
    ...(added > 0 ? [`新增 ${added}`] : []),
    ...(updated > 0 ? [`更新 ${updated}`] : []),
    ...(removedItems.length > 0 ? [`移除 ${removedItems.length}`] : []),
  ];
  return {
    added,
    updated,
    removed: removedItems.length,
    unchanged,
    summary: parts.length > 0 ? parts.join(' · ') : '清单没有变化',
    changes,
    removedItems,
    comparable: true,
    caption: '与上次清单相比',
  };
}

/** 一行（`MessageView`）在转录里的最小形状：只用到 role 与 message。 */
export interface TodoRowLike {
  id: string;
  role: string;
  message: AgentMessage;
}

/** 从助手消息里取出 `todo_write` 的清单（取同一条消息里的**最后一次**调用）。 */
export function todosFromMessage(message: AgentMessage | undefined | null): TodoItem[] | null {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return null;
  let found: TodoItem[] | null = null;
  for (const block of content) {
    const b = block as { type?: string; name?: string; arguments?: unknown };
    if (b?.type !== 'toolCall' || b.name !== 'todo_write') continue;
    const args = b.arguments as { todos?: unknown } | undefined;
    const list = parseTodoList(args?.todos);
    if (list !== null) found = list;
  }
  return found;
}

/** 一条消息是不是"新一轮的开始"（用户发言 → DSH 的 `turn/start`，投影清空）。 */
export function isTurnStart(message: AgentMessage | undefined | null): boolean {
  return (message as { role?: string } | null | undefined)?.role === 'user';
}

/**
 * 为转录里每一行 `todo_write` 算出它的**上一份清单**（DSH 的 `todoHistory`）。
 *
 * 为什么要按行配对而不是用"当前清单"：历史那一行的差异必须跟**它当时**的上一次比，
 * 否则往上翻历史时每一行都会显示"与现在这份清单相比"，那是假的。
 *
 * @param rows - 按时间正序的转录行
 * @returns `callId → 上一份清单`（没有上一次时该键不存在）
 */
export function todoBaselines(rows: readonly TodoRowLike[]): Map<string, TodoItem[]> {
  const out = new Map<string, TodoItem[]>();
  let previous: TodoItem[] | null = null;
  for (const row of rows) {
    const list = row.role === 'assistant' ? todosFromMessage(row.message) : null;
    if (list === null) continue;
    const callId = todoCallId(row.message);
    if (callId !== null && previous !== null) out.set(callId, previous);
    previous = list;
  }
  return out;
}

/** 取助手消息里**最后**一次 `todo_write` 调用的 `callId`（与结果行配对用）。 */
export function todoCallId(message: AgentMessage | undefined | null): string | null {
  const content = (message as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return null;
  let id: string | null = null;
  for (const block of content) {
    const b = block as { type?: string; name?: string; id?: string };
    if (b?.type !== 'toolCall' || b.name !== 'todo_write') continue;
    if (typeof b.id === 'string') id = b.id;
  }
  return id;
}
