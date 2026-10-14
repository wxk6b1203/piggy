// @vitest-environment jsdom
/**
 * 右栏可折叠（docs/04 §1.2「右视图轨常驻」、docs/07 §2.1 `rightpanel.toggle` / `Cmd+\`）。
 *
 * 与左栏（`sidebar-rail.test.tsx`）同一条教训：**折叠绝不能把唯一的出口一起删掉**。
 * 左栏当年是 `{sidebarOpen && <Panel…>}`，折叠 = 连同"展开"入口一起从 DOM 里消失，
 * 用户拿到一屏黑且无处可点。右栏因此保留那条 40px 图标轨：折叠卸载的是**内容**，
 * 轨道与轨道上的开合开关一直在。
 *
 * ⚠️ 覆盖范围（说清楚，不含糊）：这里断言的是**结构与状态**——
 * 折叠后内容卸载、轨道按钮仍在且有可访问名、三条入口（按钮 / 命令 / 视图图标）
 * 写的是同一个 store、折来折去不丢当前视图。
 * **几何量不到**：折叠后 Panel 是不是真的 40px、轨宽与 collapsedSize 对不对得上，
 * 只有真浏览器量得出来（jsdom 没有排版，react-resizable-panels 用 ResizeObserver
 * 量 group、量到 0 就整段 return），所以那部分在 `scripts/ui-startup-check.mjs`
 * 的「右栏折叠」段里量真实像素。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

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
import { getCommand } from '@/lib/commands';
import { keysFor } from '@/lib/keymap';
import { useTabs } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';
import { useUi } from '@/stores/ui';
import { mountDom, unmountDom, domContainer } from './dom-render';

const RAIL = '.pg-rightrail';
const BODY = '.pg-rightbar-body';
const railBtn = (label: string) =>
  domContainer().querySelector<HTMLButtonElement>(`${RAIL} button[aria-label="${label}"]`);
const railLabels = () =>
  [...domContainer().querySelectorAll(`${RAIL} button`)].map((b) => b.getAttribute('aria-label'));

const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await new Promise((r) => setTimeout(r, 20));
  });
};

/** 挂载整棵 App 并等启动流程跑完（同 app-init.test.tsx 的 harness）。 */
async function mountApp() {
  mountDom(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

describe('右栏折叠：折叠态留下图标轨，三条入口写同一个 store', () => {
  let seq = 0;
  beforeEach(() => {
    seq = 0;
    resetBootForTest();
    invokeMock.mockReset();
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
    useTabs.setState({ tabs: {}, order: [], activeTabId: null, unread: {}, banner: null });
    useMessages.setState({ tabs: {} });
    useUi.setState({ rightpanelOpen: true });
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'tab_create') {
        seq += 1; // 每次给新 tab_id：否则第二个面板撞 dockview 的 id 唯一性（噪音，不是被测行为）
        return {
          tab_id: `t-${seq}`, cwd: '/tmp', session_id: `s${seq}`, session_file: null,
          session_name: 'Piggy M0', worker_state: 'ready',
          state: { model: { id: 'm1', name: 'm1', provider: 'p1' }, isStreaming: false },
        };
      }
      if (name === 'session_page') return { rows: [], startOffset: 0, hasMore: false, branchy: false };
      if (name === 'pi_get_messages') return { messages: [] };
      if (name === 'fs_list_dir') return { entries: [] };
      if (name === 'pi_get_session_stats') {
        return { tokens: { input: 1, output: 1, total: 2, cacheRead: 0 }, cost: 0, contextUsage: { tokens: 1, contextWindow: 100, percent: 1 } };
      }
      return {};
    });
  });

  afterEach(async () => {
    await unmountDom();
  });

  it('展开态：内容与图标轨都在，轨上第一颗是「收起右栏」', async () => {
    await mountApp();
    expect(domContainer().querySelector(BODY)).not.toBeNull();
    const rail = domContainer().querySelector(RAIL);
    expect(rail).not.toBeNull();
    expect(rail!.getAttribute('aria-label')).toBe('右侧栏视图');
    // 图标按钮没有可访问名 = 读屏与 Playwright 都点不到
    expect(railLabels()).toEqual(['收起右栏', '文件', '统计']);
    expect(railBtn('收起右栏')!.getAttribute('aria-expanded')).toBe('true');
  });

  it('点「收起右栏」→ 内容卸载、图标轨留下（折叠后仍有可点的东西）', async () => {
    await mountApp();
    await click(railBtn('收起右栏')!);

    expect(useUi.getState().rightpanelOpen).toBe(false);
    expect(domContainer().querySelector(BODY)).toBeNull();
    const rail = domContainer().querySelector(RAIL);
    expect(rail).not.toBeNull();
    expect(rail!.getAttribute('aria-label')).toBe('折叠的右栏');
    expect(railLabels()).toEqual(['展开右栏', '文件', '统计']);
    expect(railBtn('展开右栏')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('折叠态点视图图标：既切视图又展开（点了没反应 = 按钮坏了）', async () => {
    await mountApp();
    await click(railBtn('收起右栏')!);
    await click(railBtn('统计')!);

    expect(useUi.getState().rightpanelOpen).toBe(true);
    expect(domContainer().querySelector(BODY)).not.toBeNull();
    expect(domContainer().querySelector('.pg-stats')).not.toBeNull();
  });

  it('⌘\\（rightpanel.toggle 命令）折叠后同样有图标轨 —— 键盘路径不能进死胡同', async () => {
    await mountApp();
    const toggle = getCommand('rightpanel.toggle');
    expect(toggle).toBeTruthy();
    await act(async () => {
      await toggle!.run({ activeTabId: null });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(useUi.getState().rightpanelOpen).toBe(false);
    expect(railBtn('展开右栏')).not.toBeNull();
  });

  it('⌘\\ 这个组合真的按得动（转义写错就是一个永远打不出来的键）', async () => {
    await mountApp();
    expect(keysFor('rightpanel.toggle')).toBe('cmd+\\');
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '\\', metaKey: true, bubbles: true, cancelable: true }),
      );
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(useUi.getState().rightpanelOpen).toBe(false);
  });

  it('折来折去不丢当前视图（折叠卸载的只是内容，面板与视图状态没被重建）', async () => {
    await mountApp();
    await click(railBtn('统计')!);
    expect(domContainer().querySelector('.pg-stats')).not.toBeNull();

    await click(railBtn('收起右栏')!);
    await click(railBtn('展开右栏')!);
    expect(domContainer().querySelector('.pg-stats')).not.toBeNull();
  });

  it('外部命令切视图时顺手展开（`/session` → 统计，折叠态下切了得看得见）', async () => {
    await mountApp();
    await click(railBtn('收起右栏')!);
    await act(async () => {
      const { windowEvents } = await import('@/lib/windowEvents');
      windowEvents.emit('rightbar-view', 'stats');
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(useUi.getState().rightpanelOpen).toBe(true);
    expect(domContainer().querySelector('.pg-stats')).not.toBeNull();
  });
});
