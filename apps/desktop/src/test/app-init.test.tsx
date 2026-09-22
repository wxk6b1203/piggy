// @vitest-environment jsdom
/** App 初始化路径集成测试：mock Tauri IPC，验证 tab_create → get_messages 全链路 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createRoot } from 'react-dom/client';
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
import { act } from 'react';

// ---- mock @tauri-apps/api（必须在 import App 之前）----
const invokeMock = vi.fn();
const listenMock = vi.fn().mockResolvedValue(() => {});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listenMock(...a) }));

import App from '@/App';
import { useTabs } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';

describe('App 初始化（mock IPC）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
    useTabs.setState({ tabs: {}, order: [], activeTabId: null, unread: {}, banner: null });
    useMessages.setState({ tabs: {} });
  });

  it('挂载后调用 tab_create 并拉取消息', async () => {
    invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'tab_create') {
        return {
          tab_id: 't-1', cwd: '/tmp', session_id: 's1', session_file: null,
          session_name: 'Piggy M0', worker_state: 'ready',
          state: { model: { id: 'm1', name: 'm1', provider: 'p1' }, isStreaming: false },
        };
      }
      if (name === 'pi_get_messages') return { messages: [{ role: 'user', content: 'hi', timestamp: 1 }] };
      if (name === 'pi_get_session_stats') return { tokens: { total: 1 }, cost: 0 };
      return {};
    });

    const div = document.createElement('div');
    document.body.appendChild(div);
    await act(async () => {
      createRoot(div).render(<App />);
    });
    // 等异步 init 完成
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain('tab_create');
    expect(calls).toContain('pi_get_messages');
    expect(useTabs.getState().activeTabId).toBe('t-1');
    expect(useMessages.getState().tabs['t-1']!.ids.length).toBe(1);
  });

  it('tab_create 失败时展示 banner（不崩）', async () => {
    invokeMock.mockRejectedValue(new Error('spawn pi failed'));
    const div = document.createElement('div');
    document.body.appendChild(div);
    await act(async () => {
      createRoot(div).render(<App />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(useTabs.getState().banner).toContain('启动失败');
  });
});
