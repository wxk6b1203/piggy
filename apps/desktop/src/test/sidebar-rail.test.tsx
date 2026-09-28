// @vitest-environment jsdom
/**
 * 折叠侧栏之后**必须留下可点的东西**（用户截图：窗口里没有标签 + 侧栏不见了
 * = 一屏黑，无处可点，再也展开不回来）。
 *
 * 病根是一行 JSX：`{sidebarOpen && <Panel…>}` —— 折叠等于把整个侧栏连同它的
 * "展开"入口一起从 DOM 里删掉。DSH 的折叠态是保留一条 56px 图标轨
 * （`SIDEBAR_COLLAPSED = 56`，docs/12 §1.5），这里锁住那条轨存在、按钮有可访问名、
 * 而且点下去真的会把 store 翻回来。
 *
 * ⚠️ **"点展开 → 侧栏回来"这条回路只能在真浏览器里测**（ui:startup 第 6 段）：
 * 折叠态重新插入 Panel 会让 react-resizable-panels 去查一个它还没建立起来的
 * 相邻面板索引，jsdom 下必抛 `Panel constraints not found for index 3`。
 * 原因是环境而不是产品：库用 ResizeObserver 的 `borderBoxSize` 量 group 尺寸，
 * 量到 0 就整段 `return`（dist 里那句 `if (m === 0) return`），于是
 * `separatorToPanels` 一直没被刷新 —— jsdom 没有排版，尺寸恒为 0。
 * 真浏览器里连折带展来回 3 轮都干净（已验证：rail 恒 56px、侧栏 194.6px、
 * tab 数不变、零 pageerror），所以这里用**隔离渲染 SidebarRail** 的办法把
 * "按钮 → store"这一跳测掉，剩下的"store → 面板重建"交给浏览器门禁。
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
import { SidebarRail } from '@/features/workspace/SidebarRail';
import { resetBootForTest } from '@/features/workspace/AppFrame';
import { getCommand } from '@/lib/commands';
import { useTabs } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';
import { useUi } from '@/stores/ui';
import { mountDom, unmountDom, domContainer, drainReact } from './dom-render';

const RAIL = '.pg-rail-left';
const railBtn = (label: string) =>
  domContainer().querySelector<HTMLButtonElement>(`${RAIL} button[aria-label="${label}"]`);

/** 挂载整棵 App 并等启动流程跑完（同 app-init.test.tsx 的 harness）。 */
async function mountApp() {
  mountDom(<App />);
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });
}

describe('侧栏折叠：折叠态必须留一条可点的图标轨', () => {
  let seq = 0;
  beforeEach(() => {
    seq = 0;
    resetBootForTest();
    invokeMock.mockReset();
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
    useTabs.setState({ tabs: {}, order: [], activeTabId: null, unread: {}, banner: null });
    useMessages.setState({ tabs: {} });
    useUi.setState({ sidebarOpen: true });
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
      return {};
    });
  });

  afterEach(async () => {
    await unmountDom();
  });

  it('展开态：侧栏在、图标轨不在', async () => {
    await mountApp();
    expect(domContainer().querySelector('.pg-sidebar')).not.toBeNull();
    expect(domContainer().querySelector(RAIL)).toBeNull();
  });

  it('点「收起侧栏」→ 图标轨出现，三个按钮都有可访问名', async () => {
    await mountApp();
    const collapse = domContainer().querySelector<HTMLButtonElement>('.pg-brand-row button[title^="收起侧栏"]');
    expect(collapse).not.toBeNull();
    await act(async () => {
      collapse!.click();
      await new Promise((r) => setTimeout(r, 20));
    });

    expect(domContainer().querySelector('.pg-sidebar')).toBeNull();
    const rail = domContainer().querySelector(RAIL);
    expect(rail).not.toBeNull();
    expect(rail!.getAttribute('aria-label')).toBe('折叠的侧栏');
    // 图标按钮没有可访问名 = 读屏与 Playwright 都点不到
    expect([...rail!.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      '展开侧栏',
      '新建会话',
      '设置',
    ]);
    expect(railBtn('展开侧栏')!.getAttribute('aria-expanded')).toBe('false');
  });

  it('⌘B（sidebar.toggle 命令）折叠后同样有图标轨 —— 键盘路径不能进死胡同', async () => {
    await mountApp();
    const toggle = getCommand('sidebar.toggle');
    expect(toggle).toBeTruthy();
    await act(async () => {
      await toggle!.run({ activeTabId: null });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(useUi.getState().sidebarOpen).toBe(false);
    expect(railBtn('展开侧栏')).not.toBeNull();
  });

  it('图标轨的「新建会话」走的是与 ⌘N 同一条路（两条入口不许各写一份）', async () => {
    await mountApp();
    useUi.getState().setSidebarOpen(false);
    await drainReact();
    const before = invokeMock.mock.calls.filter((c) => c[0] === 'tab_create').length;

    await act(async () => {
      railBtn('新建会话')!.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    const after = invokeMock.mock.calls.filter((c) => c[0] === 'tab_create').length;
    expect(after).toBe(before + 1);
  });
});

/** 隔离渲染（不带 react-resizable-panels 的 Panel 组）：补上"点按钮 → store"这一跳。 */
describe('SidebarRail：展开按钮真的会翻 store', () => {
  beforeEach(() => {
    useUi.setState({ sidebarOpen: false });
  });
  afterEach(async () => {
    await unmountDom();
  });

  it('点品牌标 → sidebarOpen 置 true', async () => {
    mountDom(<SidebarRail />);
    expect(railBtn('展开侧栏')).not.toBeNull();
    await act(async () => {
      railBtn('展开侧栏')!.click();
    });
    expect(useUi.getState().sidebarOpen).toBe(true);
  });
});
