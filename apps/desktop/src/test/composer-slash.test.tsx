// @vitest-environment jsdom
/**
 * Composer 斜杠补全测试（docs/04 §7 / docs/12 §3.8）。
 *
 * 起因一（2026-09-23 用户截图："无法滚动"）：列表被 `.slice(0, 8)` 硬截断 —— 第 9 条以后
 * **根本不在 DOM 里**，`overflow: hidden` 又让它不可滚动，↑↓ 还被 `preventDefault` 掉却不做任何事。
 * 装了 pi-subagents 后命令从 8 条涨到 50+ 条，第一屏之后的命令就再也够不着。
 * 现在：全部条目都在 DOM 里、容器可滚动、↑↓/Enter/Tab/悬停都能选。
 *
 * 起因二（2026-09-23 用户报："类似 /compact 这个基础命令好像没有体现"）：
 * pi 的 `get_commands` **只返回扩展/prompt/skill 命令**，pi 自己的内建命令不在协议里。
 * 于是补全列表里没有任何内建命令，而且敲 `/compact` 回车会把字符串发给模型。
 * 现在：内建命令（lib/slashCommands）与 pi 命令拼在一张表里，提交时先按指令拦一道。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  FeedbackBridge: () => null,
  confirm: vi.fn(),
}));

import { SessionWorkspaceComposer } from '@/features/chat/Composer';
import { toast } from '@/lib/feedback';
import { useTabs } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';
import { mountDom, unmountDom, domContainer } from './dom-render';

/** 12 条命令：超过旧的硬上限 8，用来证明"第 9 条以后也在 DOM 里、也够得到" */
const COMMANDS = Array.from({ length: 12 }, (_, i) => ({
  name: `cmd-${String(i).padStart(2, '0')}`,
  description: `第 ${i} 条`,
  source: 'extension',
}));

/** 只看扩展命令（内建命令与它们同表，过滤一下才好数条数） */
const EXT = '/cmd-';

function textarea(): HTMLTextAreaElement {
  const el = domContainer().querySelector('.pg-composer-input');
  if (!el) throw new Error('找不到输入框');
  return el as HTMLTextAreaElement;
}

async function type(value: string) {
  const el = textarea();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0)); // 等 pi_get_commands 的 promise 落地
  });
}

async function press(key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    textarea().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function items(): HTMLButtonElement[] {
  return [...domContainer().querySelectorAll('.pg-slash-item')] as HTMLButtonElement[];
}

function names(): string[] {
  return items().map((b) => b.querySelector('code')?.textContent ?? '');
}

function activeName(): string | null {
  const active = domContainer().querySelector('.pg-slash-item[data-active]');
  const code = active?.querySelector('code')?.textContent ?? null;
  return code ? code.replace(/^\//, '') : null;
}

function called(name: string): unknown[][] {
  return invokeMock.mock.calls.filter((c) => c[0] === name);
}

describe('Composer 斜杠补全', () => {
  beforeEach(() => {
    useTabs.setState({
      tabs: {
        't-1': {
          tabId: 't-1',
          cwd: '/proj',
          sessionFile: null,
          sessionId: null,
          sessionName: '会话',
          workerState: 'ready',
          thinkingLevel: null,
          state: { model: { id: 'glm-5.3-flash', name: 'glm-5.3-flash', provider: 'p' } },
        },
      } as never,
      order: ['t-1'],
      activeTabId: 't-1',
      unread: {},
      banner: null,
    });
    useMessages.setState({ tabs: {} });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'pi_get_commands') return { commands: COMMANDS };
      if (name === 'permission_modes') return { modes: [], current: 'workspace' };
      if (name === 'pi_get_available_models') return { models: [], current: null };
      if (name === 'pi_get_session_stats') return {};
      return {};
    });
  });

  afterEach(async () => {
    await unmountDom();
  });

  it('列出全部匹配项（不再硬截断 8 条）', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type(EXT);
    expect(items()).toHaveLength(COMMANDS.length);
    expect(items()[11]!.textContent).toContain('/cmd-11');
  });

  it('输入过滤后仍然列出全部匹配项', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/cmd-1');
    // cmd-10 / cmd-11 命中（textContent 里 code 与 desc 直接相邻，故按 code 取名字）
    expect(names()).toEqual(['/cmd-10', '/cmd-11']);
  });

  it('默认选中第 1 条，Enter 应用它', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type(EXT);
    expect(activeName()).toBe('cmd-00');
    await press('Enter');
    expect(textarea().value).toBe('/cmd-00 ');
    expect(domContainer().querySelector('.pg-slash')).toBeNull();
  });

  it('↓↓ 移动选中项，Enter 应用的是选中的那条（不是第一条）', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type(EXT);
    await press('ArrowDown');
    await press('ArrowDown');
    expect(activeName()).toBe('cmd-02');
    await press('Enter');
    expect(textarea().value).toBe('/cmd-02 ');
  });

  it('↑ 从第一条环绕到最后一条（第 9 条以后也够得到）', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type(EXT);
    await press('ArrowUp');
    expect(activeName()).toBe('cmd-11');
    await press('Enter');
    expect(textarea().value).toBe('/cmd-11 ');
  });

  it('↓ 到底部环绕回第一条', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type(EXT);
    for (let i = 0; i < COMMANDS.length; i++) await press('ArrowDown');
    expect(activeName()).toBe('cmd-00');
  });

  it('Tab 也能应用选中项（且不把焦点移走）', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type(EXT);
    await press('ArrowDown');
    await press('Tab');
    expect(textarea().value).toBe('/cmd-01 ');
  });

  it('鼠标悬停改变选中项，Enter 应用它', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type(EXT);
    await act(async () => {
      items()[5]!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
    });
    // React 的 onMouseEnter 由 mouseover 合成
    expect(activeName()).toBe('cmd-05');
    await press('Enter');
    expect(textarea().value).toBe('/cmd-05 ');
  });

  it('Esc 关闭补全列表，不发送', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/');
    await press('Escape');
    expect(domContainer().querySelector('.pg-slash')).toBeNull();
    expect(called('pi_prompt')).toHaveLength(0);
  });

  it('点击条目直接补全', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type(EXT);
    await act(async () => {
      items()[3]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(textarea().value).toBe('/cmd-03 ');
  });

  it('命令列表为空时 Enter 不再被吞掉（照常发送）', async () => {
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'pi_get_commands') return { commands: [] };
      return {};
    });
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/nope');
    expect(domContainer().querySelector('.pg-slash')).toBeNull();
    await press('Enter');
    expect(called('pi_prompt')).toHaveLength(1);
  });
});

describe('内建命令（pi 的 get_commands 不返回它们）', () => {
  beforeEach(() => {
    useTabs.setState({
      tabs: {
        't-1': {
          tabId: 't-1',
          cwd: '/proj',
          sessionFile: '/proj/s.jsonl',
          sessionId: 'sid',
          sessionName: '会话',
          workerState: 'ready',
          thinkingLevel: null,
          state: { model: { id: 'glm-5.3-flash', name: 'glm-5.3-flash', provider: 'p' } },
        },
      } as never,
      order: ['t-1'],
      activeTabId: 't-1',
      unread: {},
      banner: null,
    });
    useMessages.setState({ tabs: {} });
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'pi_get_commands') return { commands: COMMANDS };
      if (name === 'permission_modes') return { modes: [], current: 'workspace' };
      if (name === 'pi_get_available_models') return { models: [], current: null };
      if (name === 'pi_get_session_stats') return {};
      return {};
    });
  });

  afterEach(async () => {
    await unmountDom();
  });

  it('补全列表里能看到 /compact，并标出来源是内建', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/compact');
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain('/compact');
    expect(items()[0]!.textContent).toContain('内建');
    expect(items()[0]!.getAttribute('data-source')).toBe('builtin');
  });

  it('pi 内建但 Piggy 暂无入口的命令也列出来（标"暂无入口"，不静默）', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/fork');
    expect(names()).toHaveLength(1);
    expect(names()[0]).toContain('/fork');
    expect(items()[0]!.textContent).toContain('暂无入口');
    expect(items()[0]!.getAttribute('data-source')).toBe('pi-builtin');
  });

  it('选中内建命令**立即执行**：发 pi_compact，且不把字符串发给模型', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/');
    // 第一屏第 1 条就是内建 compact（内建排在最前）
    expect(names()[0]).toContain('/compact');
    await press('Enter');
    expect(called('pi_compact')).toHaveLength(1);
    expect(called('pi_compact')[0]![1]).toMatchObject({ tabId: 't-1' });
    expect(called('pi_prompt')).toHaveLength(0);
    expect(textarea().value).toBe('');
  });

  it('直接敲 /compact 回车也走指令（不是发给模型的一行字）', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/compact');
    await press('Escape'); // 先关掉补全，模拟"我知道它是什么，直接回车"
    await press('Enter');
    expect(called('pi_compact')).toHaveLength(1);
    expect(called('pi_prompt')).toHaveLength(0);
  });

  it('需要参数的内建命令：只插入名字，等用户补参数再执行', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/name');
    expect(names()[0]).toContain('/name');
    // 参数提示单独成 span（`/name <名称>`），补全进去的仍然只有命令名
    expect(items()[0]!.querySelector('.pg-slash-arg')!.textContent).toBe(' <名称>');
    await press('Enter');
    expect(textarea().value).toBe('/name ');
    expect(called('pi_set_session_name')).toHaveLength(0);

    await type('/name 我的会话');
    await press('Enter');
    expect(called('pi_set_session_name')).toHaveLength(1);
    expect(called('pi_set_session_name')[0]![1]).toMatchObject({ tabId: 't-1', name: '我的会话' });
    expect(called('pi_prompt')).toHaveLength(0);
  });

  it('/thinking 走白名单：认不出的级别只报错，不打给 pi', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/thinking crazy');
    await press('Escape');
    await press('Enter');
    expect(called('pi_set_thinking_level')).toHaveLength(0);
    expect(called('pi_prompt')).toHaveLength(0);
    expect(vi.mocked(toast.error)).toHaveBeenCalled();

    await type('/thinking high');
    await press('Escape');
    await press('Enter');
    expect(called('pi_set_thinking_level')).toHaveLength(1);
  });

  it('暂无入口的 pi 内建命令：拦住并解释，绝不发给模型', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/fork');
    await press('Escape');
    await press('Enter');
    expect(called('pi_prompt')).toHaveLength(0);
    expect(vi.mocked(toast.info)).toHaveBeenCalled();
    expect(textarea().value).toBe('');
  });

  it('扩展命令照旧发给 pi（Piggy 不重复实现 pi 的命令解析）', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/cmd-00 参数');
    await press('Escape');
    await press('Enter');
    expect(called('pi_prompt')).toHaveLength(1);
    expect(called('pi_prompt')[0]![1]).toMatchObject({ tabId: 't-1', message: '/cmd-00 参数' });
    expect(called('pi_compact')).toHaveLength(0);
  });

  it('流式中内建命令仍可用（Enter 不发送普通消息，但指令是客户端动作）', async () => {
    useMessages.getState().ensure('t-1');
    useMessages.setState((s) => {
      s.tabs['t-1']!.streaming = true;
    });
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/compact');
    await press('Escape');
    await press('Enter');
    expect(called('pi_compact')).toHaveLength(1);

    await type('普通消息');
    await press('Enter');
    expect(called('pi_prompt')).toHaveLength(0); // 流式中 Enter 依旧不发普通消息
  });
});
