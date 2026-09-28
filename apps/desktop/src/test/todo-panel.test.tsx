// @vitest-environment jsdom
/**
 * 计划面板（`features/chat/TodoPanel.tsx`，DSH `TodoPanel.tsx` 的移植）。
 *
 * 这块界面最怕两种失真，各有一条用例钉着：
 *   ① **没插件却显示 todo**（会让用户以为 Piggy 自带任务清单）→ `supported=false` 时
 *      整个组件返回 `null`，DOM 里连容器都不该有；
 *   ② **新一轮开始后还挂着上一轮的计划**（DSH 的 `turn/start` 会清空投影）→
 *      清空后只留一句"上一轮已归档"，不显示旧条目、也不假装从来没有过。
 *
 * 另外把几何（DSH TodoPanel.module.css）里的关键数字也断言下来：面板默认折叠、
 * 列表 `max-height: 180px`、项内 gap 10px —— 这些是"面板不把输入框顶出屏幕"的保证。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { TodoPanel } from '@/features/chat/TodoPanel';
import { useTodo } from '@/stores/todo';
import { domContainer, mountDom, unmountDom } from './dom-render';
import type { TodoItem } from '@/lib/todoModel';

const t = (content: string, status: TodoItem['status']): TodoItem => ({ content, status });

const CAPABILITY = {
  capability: 'todo',
  label: '任务清单',
  markers: ['todo_write'],
  detected: true,
  supported: true,
  plugin: null,
  disabled: [],
  considered: 1,
  problems: [],
};

function setTab(
  tabId: string,
  state: Partial<{
    todos: TodoItem[] | null;
    clearedByTurn: boolean;
    writes: number;
    source: 'event' | 'call' | 'live' | null;
    chainBroken: boolean;
  }>,
) {
  useTodo.setState({
    tabs: {
      [tabId]: {
        todos: state.todos ?? null,
        previous: null,
        source: state.source ?? 'event',
        clearedByTurn: state.clearedByTurn ?? false,
        writes: state.writes ?? 1,
        chainBroken: state.chainBroken ?? false,
      },
    },
  });
}

beforeEach(() => {
  useTodo.setState({ capability: CAPABILITY, capabilityError: null, tabs: {} });
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

describe('TodoPanel：输入卡正上方的计划', () => {
  it('没有能力 → 什么都不渲染（DOM 里连容器都没有）', () => {
    useTodo.setState({ capability: null });
    setTab('t1', { todos: [t('一', 'pending')] });
    mountDom(<TodoPanel tabId="t1" />);
    expect(q('[data-todo-panel]')).toBeNull();
  });

  it('没有清单 → 不渲染面板（空清单等价于没有计划）', () => {
    mountDom(<TodoPanel tabId="t1" />);
    expect(q('[data-todo-panel]')).toBeNull();
  });

  it('有清单 → 头部一行：标题 + 进度 + 图标；默认**折叠**（列表不在 DOM 直到点开）', () => {
    setTab('t1', { todos: [t('一', 'completed'), t('二', 'in_progress'), t('三', 'pending')] });
    mountDom(<TodoPanel tabId="t1" />);
    const panel = q('[data-todo-panel]')!;
    expect(panel.getAttribute('data-todo-state')).toBe('active');
    expect(panel.textContent).toContain('任务');
    expect(q('[data-todo-progress]')!.textContent).toBe('1 已完成\u2002·\u20021 进行中\u2002·\u20021 待处理');
    expect(q('[data-todo-source]')!.textContent).toBe('条目');
    expect(q('[data-todo-panel-list]')).toBeNull();
    expect(q('[data-todo-panel-head]')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('点开 → 列出全部条目（三态顺序与状态标签）', async () => {
    setTab('t1', {
      todos: [t('探测安装目录', 'completed'), t('软链扩展', 'in_progress'), t('跑冒烟测试', 'pending')],
    });
    mountDom(<TodoPanel tabId="t1" />);
    await click(q('[data-todo-panel-head]')!);
    const items = qa('[data-todo-panel-list] .pg-todo-panel-item');
    expect(items.map((i) => i.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending']);
    // 面板里只印**内容**（DSH 同款：状态靠前面的圆点传递，不占文字宽度）；
    // 状态的文字说明挂在字形的 title 上（读屏与悬停都拿得到）
    expect(items.map((i) => i.textContent)).toEqual(['探测安装目录', '软链扩展', '跑冒烟测试']);
    expect(items.map((i) => i.querySelector('.pg-todo-panel-glyph')?.getAttribute('title'))).toEqual([
      '已完成',
      '进行中',
      '待处理',
    ]);
    expect(q('[data-todo-panel-head]')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('数据来源如实标注（条目 / 调用 / 实时）', () => {
    setTab('t1', { todos: [t('一', 'pending')], source: 'call' });
    mountDom(<TodoPanel tabId="t1" />);
    expect(q('[data-todo-source]')!.textContent).toBe('调用');
    useTodo.setState({ tabs: {} });
  });

  it('链条走断时把强度标出来（结论是按文件序得出的，不保证在活动分支上）', () => {
    setTab('t1', { todos: [t('一', 'pending')], chainBroken: true });
    mountDom(<TodoPanel tabId="t1" />);
    const badge = q('[data-todo-source]')!;
    expect(badge.getAttribute('data-todo-chain')).toBe('broken');
    expect(badge.textContent).toBe('条目?');
    expect(badge.getAttribute('title')).toContain('文件顺序');
  });

  it('新一轮开始后：不显示旧条目，但说清"上一轮已归档"', () => {
    setTab('t1', { todos: null, clearedByTurn: true, writes: 2 });
    mountDom(<TodoPanel tabId="t1" />);
    const panel = q('[data-todo-panel]')!;
    expect(panel.getAttribute('data-todo-state')).toBe('cleared');
    expect(q('[data-todo-cleared]')!.textContent).toContain('上一轮');
    expect(q('[data-todo-panel-list]')).toBeNull();
    expect(qa('.pg-todo-panel-item').length).toBe(0);
  });

  it('从来没写过（writes=0）→ 清空态也不显示（没东西可归档）', () => {
    setTab('t1', { todos: null, clearedByTurn: false, writes: 0 });
    mountDom(<TodoPanel tabId="t1" />);
    expect(q('[data-todo-panel]')).toBeNull();
  });

  it('样式表里的几何与 DSH 一致（列表 180px 上限、项内 gap 10px）', async () => {
    // 断言在 CSS 文本上：jsdom 不做布局，读不到计算样式，但"数字对不对"必须有人看着
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, '..', 'styles.css'), 'utf-8');
    const listRule = /\.pg-todo-panel-list\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(listRule).toContain('max-height: 180px');
    const itemRule = /\.pg-todo-panel-item\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(itemRule).toContain('gap: 10px');
    const panelRule = /\.pg-todo-panel\s*\{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(panelRule).toContain('border-radius: 12px');
  });
});
