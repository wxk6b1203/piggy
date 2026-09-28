/**
 * 任务清单的前端模型（`lib/todoModel.ts`）。
 *
 * 这一层的每条规则都直接决定界面**说不说谎**，所以逐条钉：
 *   ① 摘要只报数字 + 第一个进行中的事，**其余的用 `+N` 另行报出**（DSH 的 `planSummary`）；
 *   ② 三态计数为 0 的那段不显示，分隔符是 en space（HTML 会折叠 ASCII 空格）；
 *   ③ 差异按 `content` 配对，状态变化与顺序调整都算"更新"，消失的算"移除"；
 *   ④ **旧清单不可用**与**首次记录**必须分开 —— 前者是"没载入到"，后者是"真的没有"；
 *   ⑤ 实时折叠：用户发言 = 新一轮，助手消息里的 `todo_write` 调用 = 一次写入。
 *
 * 另有一条**跨语言一致性**检查：Rust 侧 `read_todo_items` 接受的状态集合必须与这里的
 * 三态一字不差（两边都解析同一份清单，分叉了就会出现"转录里有、面板里没有"这种鬼故事）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TODO_STATUS_LABEL,
  isTodoStatus,
  isTurnStart,
  parseTodoList,
  planSummary,
  progressLabel,
  rowSummary,
  todoBaselines,
  todoCallId,
  todoDiff,
  todosFromMessage,
  type TodoItem,
} from '@/lib/todoModel';

const item = (content: string, status: TodoItem['status']): TodoItem => ({ content, status });

describe('清单解析：形状不对就说不知道', () => {
  it('合法清单原样读出', () => {
    const raw = [item('一', 'pending'), item('二', 'completed')];
    expect(parseTodoList(raw)).toEqual(raw);
  });

  it('状态非法 / 字段缺失 / 不是数组 → null（绝不猜）', () => {
    expect(parseTodoList([{ content: '一', status: 'done' }])).toBeNull();
    expect(parseTodoList([{ content: '一' }])).toBeNull();
    expect(parseTodoList([{ status: 'pending' }])).toBeNull();
    expect(parseTodoList([null])).toBeNull();
    expect(parseTodoList('nope')).toBeNull();
    expect(parseTodoList(undefined)).toBeNull();
  });

  it('空数组是合法清单（模型可以显式清空）', () => {
    expect(parseTodoList([])).toEqual([]);
  });

  it('isTodoStatus 只认三态', () => {
    for (const s of ['pending', 'in_progress', 'completed']) expect(isTodoStatus(s)).toBe(true);
    for (const s of ['done', 'PENDING', '', null, 3]) expect(isTodoStatus(s)).toBe(false);
  });
});

describe('摘要（DSH plan-summary / todo-row 的 summarize）', () => {
  it('数出 done/total 与第一件进行中的事', () => {
    const s = planSummary([item('一', 'completed'), item('二', 'in_progress'), item('三', 'pending')]);
    expect(s).toEqual({ done: 1, total: 3, activeContent: '二', activeExtra: 0 });
  });

  it('并行时多余的在跑任务不丢：报出 +N', () => {
    const s = planSummary([item('一', 'in_progress'), item('二', 'in_progress'), item('三', 'in_progress')]);
    expect(s.activeContent).toBe('一');
    expect(s.activeExtra).toBe(2);
  });

  it('没有进行中 → activeContent 为 null，extra 为 0', () => {
    expect(planSummary([item('一', 'completed')])).toMatchObject({ activeContent: null, activeExtra: 0 });
  });

  it('行摘要：数字在前、进行中的事在后（两半分开给，截断只截后者）', () => {
    expect(rowSummary([item('写文档', 'in_progress'), item('一', 'completed'), item('二', 'pending')])).toEqual({
      text: '1/3 已完成 · 写文档',
      extra: 0,
    });
  });

  it('行摘要：清单不可读 → null（调用方退回通用摘要）', () => {
    expect(rowSummary([{ content: '一', status: 'nope' }])).toBeNull();
    expect(rowSummary(undefined)).toBeNull();
  });

  it('进度标签：0 的那段不显示，分隔符是 en space（不是 ASCII 空格）', () => {
    expect(progressLabel([item('一', 'completed'), item('二', 'pending')])).toBe('1 已完成\u2002·\u20021 待处理');
    expect(progressLabel([item('一', 'completed'), item('二', 'completed')])).toBe('2 已完成');
    expect(progressLabel([item('一', 'in_progress')])).toBe('1 进行中');
    expect(progressLabel([])).toBe('');
  });

  it('状态中文名与 DSH locales 一致', () => {
    expect(TODO_STATUS_LABEL).toEqual({ completed: '已完成', in_progress: '进行中', pending: '待处理' });
  });
});

describe('与上一份清单的差异（DSH todo-diff-model）', () => {
  const base = [item('一', 'pending'), item('二', 'pending'), item('三', 'pending')];

  it('首次记录与"旧清单不可用"必须分开', () => {
    const first = todoDiff(base, null, false);
    expect(first.caption).toBe('首次记录');
    expect(first.comparable).toBe(false);
    const unknown = todoDiff(base, null, true);
    expect(unknown.caption).toBe('旧清单不可用');
    expect(unknown.comparable).toBe(false);
  });

  it('新增 / 状态变化 / 移除都数得出来', () => {
    const next = [item('一', 'completed'), item('二', 'pending'), item('四', 'pending')];
    const d = todoDiff(next, base, false);
    expect(d.added).toBe(1); // 四
    expect(d.updated).toBe(1); // 一：pending → completed
    expect(d.removed).toBe(1); // 三
    expect(d.unchanged).toBe(1); // 二
    expect(d.summary).toBe('新增 1 · 更新 1 · 移除 1');
    expect(d.removedItems.map((t) => t.content)).toEqual(['三']);
    expect(d.changes.get('一')).toBe('updated');
    expect(d.changes.get('四')).toBe('added');
    expect(d.changes.get('三')).toBe('removed');
    expect(d.caption).toBe('与上次清单相比');
  });

  it('顺序调整算「更新」（DSH 把 moved 计入 updated）', () => {
    const d = todoDiff([item('二', 'pending'), item('一', 'pending'), item('三', 'pending')], base, false);
    expect(d.changes.get('二')).toBe('moved');
    expect(d.updated).toBe(2); // 二 与 一 的位置都动了
    expect(d.added).toBe(0);
    expect(d.removed).toBe(0);
  });

  it('一模一样 → 「清单没有变化」', () => {
    const d = todoDiff(base, base, false);
    expect(d.summary).toBe('清单没有变化');
    expect(d.unchanged).toBe(3);
    expect(d.added + d.updated + d.removed).toBe(0);
  });

  it('整表替换成空清单 = 全部移除', () => {
    const d = todoDiff([], base, false);
    expect(d.removed).toBe(3);
    expect(d.summary).toBe('移除 3');
  });
});

describe('实时折叠：从消息里读清单（与 Rust 的投影同规则）', () => {
  const assistantWith = (todos: unknown) => ({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'call-1', name: 'todo_write', arguments: { todos } }],
  });

  it('助手消息里的 todo_write 调用读得出清单，别的工具不算', () => {
    expect(todosFromMessage(assistantWith([item('一', 'pending')]))).toEqual([item('一', 'pending')]);
    expect(todosFromMessage({ role: 'assistant', content: [{ type: 'toolCall', name: 'bash', arguments: {} }] })).toBeNull();
    expect(todosFromMessage({ role: 'assistant', content: [{ type: 'text', text: 'hi' }] })).toBeNull();
  });

  it('同一条消息里多次调用 → 取最后一次', () => {
    const msg = {
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'a', name: 'todo_write', arguments: { todos: [item('旧', 'pending')] } },
        { type: 'toolCall', id: 'b', name: 'todo_write', arguments: { todos: [item('新', 'pending')] } },
      ],
    };
    expect(todosFromMessage(msg)).toEqual([item('新', 'pending')]);
    expect(todoCallId(msg)).toBe('b');
  });

  it('用户消息 = 新一轮开始（DSH 的 turn/start）', () => {
    expect(isTurnStart({ role: 'user', content: [] })).toBe(true);
    expect(isTurnStart({ role: 'assistant', content: [] })).toBe(false);
    expect(isTurnStart(undefined)).toBe(false);
  });

  it('基线按**调用 id** 配对：每一行拿到的是它自己之前的那一份', () => {
    const rows = [
      { id: 'r1', role: 'assistant', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'todo_write', arguments: { todos: [item('一', 'pending'), item('二', 'pending'), item('三', 'pending')] } }] } },
      { id: 'r2', role: 'assistant', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'c2', name: 'todo_write', arguments: { todos: [item('一', 'completed'), item('二', 'pending'), item('三', 'pending')] } }] } },
    ];
    const map = todoBaselines(rows);
    expect(map.has('c1')).toBe(false); // 第一行没有上一次 → 首次记录
    expect(map.get('c2')?.[0]).toEqual(item('一', 'pending')); // 第二行比的是第一份
  });
});

describe('跨语言一致性：Rust 的清单解析与这里同一套三态', () => {
  it('transcript.rs 接受的状态集合与 TS 一致', () => {
    const src = readFileSync(
      join(__dirname, '..', '..', 'src-tauri', 'src', 'sessions', 'transcript.rs'),
      'utf-8',
    );
    const m = /fn read_todo_items[\s\S]*?matches!\(status\.as_str\(\),\s*([^)]*)\)/.exec(src);
    expect(m, 'Rust 侧找不到 read_todo_items 的状态白名单').not.toBeNull();
    const rustStatuses = [...m![1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
    expect(rustStatuses).toEqual(['completed', 'in_progress', 'pending']);
    // 事件名也钉一下：插件写 `todo/write`，Piggy 读 `todo/write`（DSH 同名事件）
    expect(src).toContain('"todo/write"');
    expect(src).toContain('"todo_write"');
  });
});
