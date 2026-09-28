// @vitest-environment jsdom
/**
 * 空编辑区占位（用户："空编辑区背景，描述一些基础的快捷键，有点像 vscode，然后加一些中央入口"）。
 *
 * 锁三件事：
 *   ① 关光标签 → 占位出现；有标签 → 不出现（它不该盖在会话上）；
 *   ② 快捷键与标题**来自命令注册表**，不是写死的字符串 —— 这条用"改绑后重新挂载"来证明：
 *      写死的话改绑后界面照样显示旧键位，测试会红；
 *   ③ 中央入口**真的执行命令**（不是装饰）。
 *
 * 几何（水印大小/位置）与"按钮点得到"由 `ui:startup` 第 7 段在真浏览器里量
 * —— jsdom 没有排版，而且第一版正是被真浏览器的 hit-test 抓出来的：
 * dockview 自己的 `.dv-watermark-container` 压在按钮上（z-index 1），点不动。
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
import { closeAllTabs } from '@/features/workspace/EditorArea';
import { getCommand } from '@/lib/commands';
import { displayChord, keysFor, saveOverride } from '@/lib/keymap';
import { useTabs } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';
import { useUi } from '@/stores/ui';
import { mountDom, unmountDom, domContainer, drainReact } from './dom-render';

const EMPTY = '.pg-empty';
const rows = () =>
  [...domContainer().querySelectorAll(`${EMPTY} .pg-empty-key-row`)].map((r) => ({
    title: r.querySelector('.pg-empty-key-title')?.textContent ?? '',
    keys: r.querySelector('.pg-empty-kbd')?.textContent ?? '',
  }));
const entries = () => [...domContainer().querySelectorAll<HTMLButtonElement>(`${EMPTY} .pg-empty-entry`)];
const dockPanel = (id: string) =>
  (globalThis as unknown as { __piggyDock?: { getPanel(i: string): unknown } }).__piggyDock?.getPanel(id);

let seq = 0;
async function mountApp() {
  mountDom(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

describe('空编辑区占位', () => {
  beforeEach(() => {
    seq = 0;
    localStorage.removeItem('pg.keymap'); // 改绑测试会写它
    resetBootForTest();
    invokeMock.mockReset();
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
    useTabs.setState({ tabs: {}, order: [], activeTabId: null, unread: {}, banner: null });
    useMessages.setState({ tabs: {} });
    useUi.setState({ sidebarOpen: true, paletteOpen: false });
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'tab_create') {
        seq += 1;
        return {
          tab_id: `t-${seq}`, cwd: '/tmp', session_id: `s${seq}`, session_file: null,
          session_name: 'Piggy M0', worker_state: 'ready',
          state: { model: { id: 'm1', name: 'm1', provider: 'p1' }, isStreaming: false },
        };
      }
      if (name === 'session_page') return { rows: [], startOffset: 0, hasMore: false, branchy: false };
      if (name === 'pi_get_messages') return { messages: [] };
      return {};
    });
  });

  afterEach(async () => {
    await unmountDom();
  });

  it('有标签时不出现；关光标签后出现（水印 + 快捷键表 + 入口）', async () => {
    await mountApp();
    expect(domContainer().querySelector(EMPTY)).toBeNull(); // 启动会建一个会话标签

    await act(async () => {
      closeAllTabs();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(domContainer().querySelector(EMPTY)).not.toBeNull();
    expect(domContainer().querySelector(`${EMPTY} .pg-empty-logo`)?.textContent).toBe('🐷');
    expect(rows().length).toBeGreaterThanOrEqual(5);
    expect(entries().length).toBeGreaterThanOrEqual(3);
  });

  it('快捷键与标题来自命令注册表（不是写死的字符串）', async () => {
    await mountApp();
    await act(async () => {
      closeAllTabs();
      await new Promise((r) => setTimeout(r, 40));
    });
    const shown = rows();
    const want = ['session.new', 'palette.open', 'session.search', 'sidebar.toggle', 'model.pick', 'help.shortcuts'];
    for (const id of want) {
      const cmd = getCommand(id);
      const chord = keysFor(id);
      expect(cmd).toBeTruthy();
      expect(chord).toBeTruthy();
      expect(shown).toContainEqual({ title: cmd!.title, keys: displayChord(chord!) });
    }
  });

  it('改绑之后显示的是新键位（写死就红）', async () => {
    saveOverride('session.new', 'cmd+alt+n');
    await mountApp();
    await act(async () => {
      closeAllTabs();
      await new Promise((r) => setTimeout(r, 40));
    });
    const row = rows().find((r) => r.title === getCommand('session.new')!.title);
    expect(row?.keys).toBe(displayChord('cmd+alt+n'));
  });

  it('中央入口真的执行命令（新建会话 / 命令面板 / 打开设置）', async () => {
    await mountApp();
    await act(async () => {
      closeAllTabs();
      await new Promise((r) => setTimeout(r, 40));
    });
    const btn = (title: string) => entries().find((b) => b.textContent?.includes(title));
    const creates = () => invokeMock.mock.calls.filter((c) => c[0] === 'tab_create').length;

    // ① 命令面板：只翻 store，不建标签
    const before = creates();
    await act(async () => {
      btn('命令面板')!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(useUi.getState().paletteOpen).toBe(true);
    expect(creates()).toBe(before);

    // ② 新建会话：真的建了一个
    await act(async () => {
      btn('新建会话')!.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(creates()).toBe(before + 1);
    await drainReact();

    // ③ 打开设置：dockview 里多出 settings 面板
    await act(async () => {
      closeAllTabs();
      await new Promise((r) => setTimeout(r, 40));
    });
    await act(async () => {
      btn('打开设置')!.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(dockPanel('settings')).toBeTruthy();
  });
});
