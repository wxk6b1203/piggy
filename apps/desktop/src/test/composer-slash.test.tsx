// @vitest-environment jsdom
/**
 * Composer 斜杠补全测试（docs/04 §7 / docs/12 §3.8）。
 *
 * 起因（2026-09-23 用户截图："无法滚动"）：列表被 `.slice(0, 8)` 硬截断 —— 第 9 条以后
 * **根本不在 DOM 里**，`overflow: hidden` 又让它不可滚动，↑↓ 还被 `preventDefault` 掉却不做任何事。
 * 装了 pi-subagents 后命令从 8 条涨到 50+ 条，第一屏之后的命令就再也够不着。
 * 现在：全部条目都在 DOM 里、容器可滚动、↑↓/Enter/Tab/悬停都能选。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));

import { SessionWorkspaceComposer } from '@/features/chat/Composer';
import { useTabs } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';
import { mountDom, unmountDom, domContainer } from './dom-render';

/** 12 条命令：超过旧的硬上限 8，用来证明"第 9 条以后也在 DOM 里、也够得到" */
const COMMANDS = Array.from({ length: 12 }, (_, i) => ({
  name: `cmd-${String(i).padStart(2, '0')}`,
  description: `第 ${i} 条`,
  source: 'extension',
}));

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

function activeName(): string | null {
  const active = domContainer().querySelector('.pg-slash-item[data-active]');
  const code = active?.querySelector('code')?.textContent ?? null;
  return code ? code.replace(/^\//, '') : null;
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
    await type('/');
    expect(items()).toHaveLength(COMMANDS.length);
    expect(items()[11]!.textContent).toContain('/cmd-11');
  });

  it('输入过滤后仍然列出全部匹配项', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/cmd-1');
    // cmd-10 / cmd-11 命中（textContent 里 code 与 desc 直接相邻，故按 code 取名字）
    expect(items().map((b) => b.querySelector('code')?.textContent)).toEqual(['/cmd-10', '/cmd-11']);
  });

  it('默认选中第 1 条，Enter 应用它', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/');
    expect(activeName()).toBe('cmd-00');
    await press('Enter');
    expect(textarea().value).toBe('/cmd-00 ');
    expect(domContainer().querySelector('.pg-slash')).toBeNull();
  });

  it('↓↓ 移动选中项，Enter 应用的是选中的那条（不是第一条）', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/');
    await press('ArrowDown');
    await press('ArrowDown');
    expect(activeName()).toBe('cmd-02');
    await press('Enter');
    expect(textarea().value).toBe('/cmd-02 ');
  });

  it('↑ 从第一条环绕到最后一条（第 9 条以后也够得到）', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/');
    await press('ArrowUp');
    expect(activeName()).toBe('cmd-11');
    await press('Enter');
    expect(textarea().value).toBe('/cmd-11 ');
  });

  it('↓ 到底部环绕回第一条', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/');
    for (let i = 0; i < COMMANDS.length; i++) await press('ArrowDown');
    expect(activeName()).toBe('cmd-00');
  });

  it('Tab 也能应用选中项（且不把焦点移走）', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/');
    await press('ArrowDown');
    await press('Tab');
    expect(textarea().value).toBe('/cmd-01 ');
  });

  it('鼠标悬停改变选中项，Enter 应用它', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/');
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
    expect(invokeMock.mock.calls.some((c) => c[0] === 'pi_prompt')).toBe(false);
  });

  it('点击条目直接补全', async () => {
    mountDom(<SessionWorkspaceComposer tabId="t-1" />);
    await type('/');
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
    expect(invokeMock.mock.calls.some((c) => c[0] === 'pi_prompt')).toBe(true);
  });
});
