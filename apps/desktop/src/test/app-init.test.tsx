// @vitest-environment jsdom
/**
 * App 初始化路径集成测试：mock Tauri IPC，验证 tab_create → **转录尾页**全链路。
 *
 * 装载路径自 2026-09-23 起是分页的（docs/03 §2.19）：先读会话文件尾部一页，
 * 只有**没有会话文件**或**文件读不出来**时才退回 `pi_get_messages`。
 * 三条分支都在这里锁住——退回路径如果没人测，真机上文件一坏就是一片空白。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';

// ---- mock @tauri-apps/api（必须在 import App 之前；vi.hoisted 避免工厂引用 TDZ 变量）----
const { invokeMock, listenMock } = vi.hoisted(() => {
  const invokeMock = vi.fn();
  const listenMock = vi.fn();
  listenMock.mockResolvedValue(() => {});
  return { invokeMock, listenMock };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listenMock(...a) }));

import App from '@/App';
import { resetBootForTest } from '@/features/workspace/AppFrame';
import { useTabs } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';

/** `tab_create` 的返回（`sessionFile` 决定后面走哪条装载路径）。 */
const tabCreate = (sessionFile: string | null) => ({
  tab_id: 't-1',
  cwd: '/tmp',
  session_id: 's1',
  session_file: sessionFile,
  session_name: 'Piggy M0',
  worker_state: 'ready',
  state: { model: { id: 'm1', name: 'm1', provider: 'p1' }, isStreaming: false },
});

async function mountApp() {
  const div = document.createElement('div');
  document.body.appendChild(div);
  await act(async () => {
    createRoot(div).render(<App />);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
  return div;
}

describe('App 初始化（mock IPC）', () => {
  beforeEach(() => {
    resetBootForTest();
    invokeMock.mockReset();
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
    useTabs.setState({ tabs: {}, order: [], activeTabId: null, unread: {}, banner: null });
    useMessages.setState({ tabs: {} });
  });

  it('有会话文件：走分页尾页（不去要整段历史）', async () => {
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'tab_create') return tabCreate('/tmp/s.jsonl');
      if (name === 'session_page') {
        return {
          rows: [
            { role: 'user', message: { role: 'user', content: 'hi', timestamp: 1 } },
            { role: 'assistant', message: { role: 'assistant', content: 'yo', timestamp: 2 } },
          ],
          startOffset: 128,
          hasMore: true,
          branchy: false,
        };
      }
      if (name === 'pi_get_session_stats') return { tokens: { total: 1 }, cost: 0 };
      return {};
    });

    await mountApp();

    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain('tab_create');
    expect(calls).toContain('session_page');
    expect(calls, '有文件时不该再去要整段历史').not.toContain('pi_get_messages');
    expect(useTabs.getState().activeTabId).toBe('t-1');
    const tab = useMessages.getState().tabs['t-1']!;
    expect(tab.ids.length).toBe(2);
    // 游标与 hasMore 来自后端那一页：界面据此决定要不要画「加载更早」
    expect(tab.pageCursor).toBe(128);
    expect(tab.hasMore).toBe(true);
  });

  it('没有会话文件（尚未落盘）：退回 get_messages，且不显示「加载更早」', async () => {
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'tab_create') return tabCreate(null);
      if (name === 'pi_get_messages') return { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] };
      if (name === 'pi_get_session_stats') return { tokens: { total: 1 }, cost: 0 };
      return {};
    });

    await mountApp();

    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain('pi_get_messages');
    const tab = useMessages.getState().tabs['t-1']!;
    expect(tab.ids.length).toBe(1);
    expect(tab.hasMore).toBe(false);
    expect(tab.pageCursor).toBeNull();
  });

  it('分页读失败：退回 get_messages（绝不静默留白）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'tab_create') return tabCreate('/tmp/gone.jsonl');
      if (name === 'session_page') throw new Error('文件不存在');
      if (name === 'pi_get_messages') return { messages: [{ role: 'user', content: '兜底', timestamp: 9 }] };
      if (name === 'pi_get_session_stats') return { tokens: { total: 1 }, cost: 0 };
      return {};
    });

    await mountApp();

    const tab = useMessages.getState().tabs['t-1']!;
    expect(tab.ids.length, '退回路径要把消息灌进来').toBe(1);
    expect(tab.hasMore).toBe(false);
    expect(warn, '退回时要在控制台留证据').toHaveBeenCalled();
    warn.mockRestore();
  });

  it('tab_create 失败时展示 banner（不崩）', async () => {
    invokeMock.mockRejectedValue(new Error('spawn pi failed'));
    await mountApp();
    expect(useTabs.getState().banner).toContain('启动失败');
  });
});
