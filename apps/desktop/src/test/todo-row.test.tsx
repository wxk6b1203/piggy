// @vitest-environment jsdom
/**
 * 任务清单行（`features/chat/TodoRow.tsx`，DSH `ui-tool/.../todo-row.tsx` 的移植）。
 *
 * 钉四件事：
 *   ① 它是一条 **24px 窄行**（和工具行同一套 DisclosureRow 几何），摘要
 *      `2/3 已完成 · 写文档`，`+N` 与差异摘要放在**不可省略**的一侧；
 *   ② 默认折叠，正文留在 DOM 里（`hidden="until-found"`，本仓"折叠 ≠ 不渲染"的纪律）；
 *   ③ 展开后是**清单**（三态 + 状态名 + 变化标记），不是一段 JSON；
 *   ④ **被拒的调用不许假装成功**：走 isError 分支显示拒绝原因，不显示清单。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { TodoRow } from '@/features/chat/TodoRow';
import { MessageView } from '@/features/chat/MessageView';
import { useTodo } from '@/stores/todo';
import { domContainer, mountDom, unmountDom } from './dom-render';
import type { TodoItem } from '@/lib/todoModel';

const t = (content: string, status: TodoItem['status']): TodoItem => ({ content, status });

beforeEach(() => {
  // 单测里直接摆好能力状态（真实路径由 stores/todo 的 loadCapability 走 IPC）
  useTodo.setState({
    capability: {
      capability: 'todo',
      label: '任务清单',
      markers: ['todo_write'],
      detected: true,
      supported: true,
      plugin: null,
      disabled: [],
      considered: 1,
      problems: [],
    },
    capabilityError: null,
    tabs: {},
  });
});

afterEach(async () => {
  await unmountDom();
});

const q = <T extends Element>(sel: string) => domContainer().querySelector<T>(sel);
const qa = <T extends Element>(sel: string) => [...domContainer().querySelectorAll<T>(sel)];
const click = async (el: Element) => {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
};

/** 展开那一行 */
async function expand() {
  await click(q('[data-disclosure-row]')!);
}

describe('TodoRow：一条 24px 的清单行', () => {
  it('摘要 = 数字 + 第一件进行中的事；行是 disclosure 窄行', () => {
    mountDom(
      <TodoRow
        args={{
          todos: [t('一', 'completed'), t('二', 'in_progress'), t('三', 'pending')],
        }}
        text="Updated todo list: 1 pending, 1 in progress, 1 completed."
        isError={false}
      />,
    );
    const row = q('[data-todo-row]')!;
    expect(row).not.toBeNull();
    expect(q('[data-todo-summary]')!.textContent).toBe('1/3 已完成 · 二');
    // React 把 `data-expandable={true}` 渲染成字符串 "true"（不是 "1"）
    expect(q('[data-disclosure-row]')!.getAttribute('data-expandable')).toBe('true');
    // 默认折叠：正文留在 DOM 里但不可见（Ctrl+F 搜得到）
    const body = q('[data-todo-body]')!;
    expect(body.getAttribute('hidden')).toBe('until-found');
  });

  it('并行进行中时 `+N` 报出其余的（不吞）', () => {
    mountDom(
      <TodoRow
        args={{ todos: [t('一', 'in_progress'), t('二', 'in_progress'), t('三', 'in_progress')] }}
        text="ok"
        isError={false}
      />,
    );
    expect(q('[data-todo-extra]')!.textContent).toBe('+2');
  });

  it('展开后是清单：三态 + 状态名 + 变化标记 + 被移除的条目', async () => {
    const baseline = [t('一', 'pending'), t('二', 'pending'), t('三', 'pending')];
    mountDom(
      <TodoRow
        args={{ todos: [t('一', 'completed'), t('二', 'pending'), t('四', 'pending')] }}
        text="Updated todo list: 2 pending, 0 in progress, 1 completed."
        isError={false}
        baseline={baseline}
      />,
    );
    // 折叠时也能看到差异摘要（DSH 的 summarySuffix）
    expect(q('[data-todo-diff]')!.textContent).toBe('新增 1 · 更新 1 · 移除 1');
    await expand();
    const items = qa('[data-todo-list] .pg-todo-item');
    expect(items.length).toBe(3);
    expect(items[0]!.getAttribute('data-status')).toBe('completed');
    expect(items[0]!.getAttribute('data-change')).toBe('updated');
    expect(items[2]!.getAttribute('data-change')).toBe('added');
    expect(q('[data-todo-list]')!.textContent).toContain('已完成');
    // 被移除的条目单独列出来（整表替换下"消失"也是一次变化）
    expect(q('[data-change="removed"]')!.textContent).toContain('三');
    expect(q('[data-todo-caption]')!.textContent).toContain('与上次清单相比');
    // 回执原文也在（这行是给对账用的）
    expect(q('[data-todo-result]')!.textContent).toContain('Updated todo list: 2 pending');
  });

  it('没有基线时说明是「首次记录」，不编造变化', async () => {
    mountDom(<TodoRow args={{ todos: [t('一', 'pending'), t('二', 'pending')] }} text="ok" isError={false} />);
    await expand();
    expect(q('[data-todo-caption]')!.textContent).toContain('首次记录');
    expect(q('[data-todo-diff]')).toBeNull();
  });

  it('前面还有未载入的历史 → 「旧清单不可用」（不能声称是首次）', async () => {
    mountDom(
      <TodoRow
        args={{ todos: [t('一', 'pending'), t('二', 'pending')] }}
        text="ok"
        isError={false}
        baseline={undefined}
        hasMore
      />,
    );
    await expand();
    expect(q('[data-todo-caption]')!.textContent).toContain('旧清单不可用');
  });

  it('被拒的调用：显示拒绝原因，且**不显示清单**', async () => {
    const refusal =
      'pi-todo: todo_write refused — this task does not look multi-step enough yet. Why: prompt score 0/8.';
    mountDom(<TodoRow args={{ todos: [t('只有一件事', 'pending')] }} text={refusal} isError />);
    const row = q('[data-todo-row]')!;
    expect(row.getAttribute('data-state')).toBe('error');
    await expand();
    expect(q('[data-todo-error]')!.textContent).toContain('todo_write refused');
    expect(q('[data-todo-list]')).toBeNull();
    expect(q('[data-todo-list]')).toBeNull();
  });
});

describe('MessageView：只有探测到 todo 能力时才走清单行', () => {
  const toolResultView = {
    id: 'm1',
    role: 'toolResult',
    offset: null,
    message: {
      role: 'toolResult',
      toolName: 'todo_write',
      toolCallId: 'c1',
      content: [{ type: 'text', text: 'Updated todo list: 1 pending, 1 in progress, 1 completed.' }],
      isError: false,
    },
  };
  const call = { name: 'todo_write', args: { todos: [t('一', 'completed'), t('二', 'in_progress'), t('三', 'pending')] } };

  it('能力可用 → 清单行（不再是一坨 JSON 摘要）', () => {
    mountDom(<MessageView view={toolResultView as never} call={call} />);
    expect(q('[data-todo-row]')).not.toBeNull();
    expect(q('[data-tool-row]')).toBeNull();
    expect(q('[data-todo-summary]')!.textContent).toBe('1/3 已完成 · 二');
  });

  it('没探测到插件（supported=false）→ 退回通用工具行，界面与从前一样', () => {
    useTodo.setState({ capability: null });
    mountDom(<MessageView view={toolResultView as never} call={call} />);
    expect(q('[data-todo-row]')).toBeNull();
    const row = q('[data-tool-row]')!;
    expect(row).not.toBeNull();
    expect(row.getAttribute('data-tool')).toBe('todo_write');
  });
});
