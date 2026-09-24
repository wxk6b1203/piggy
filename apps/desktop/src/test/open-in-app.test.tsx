// @vitest-environment jsdom
/**
 * 「打开方式」分裂胶囊（DSH `ui-open-in-app` 的 Piggy 版）。
 *
 * 锁四件事 —— 每一条都对应一个"界面上看不出来"的失败模式：
 *   ① **宿主说装了哪些，菜单里就只有哪些**：宿主多报的 id（词典里没有）必须被丢掉，
 *      否则菜单里会出现一个裸 id；宿主报空 → 组件不渲染（而不是渲染一个坏按钮）。
 *   ② **点下去真的带着"哪个应用 + 哪个目录"走 IPC**：只断言"按钮在"是测不出接线错的。
 *   ③ **上次选择被记住**：换一个应用后再挂载，主按钮显示的是新选择（不是永远第一个）。
 *   ④ **失败有反馈**：open 抛错 → `data-phase=error`（两秒后自己复位），不是静默无反应。
 *
 * 图标的两条渲染路径都走到：宿主给 data URL → `<img>`；给 null → 通用圆角方块。
 * 真机上"图标是 128px PNG"由 Rust 侧测试量（`icons.rs`：plutil + sips 真跑一遍）。
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
import { OpenInApp, labelFor } from '@/features/chat/OpenInApp';
import { getCommand } from '@/lib/commands';
import { resetBootForTest } from '@/features/workspace/AppFrame';
import { resetOpenInAppCache } from '@/lib/openInApp';
import { useTabs } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';
import { useUi } from '@/stores/ui';
import { mountDom, unmountDom, domContainer, drainReact } from './dom-render';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const split = () => domContainer().querySelector<HTMLElement>('.pg-openin-split');
const main = () => domContainer().querySelector<HTMLButtonElement>('.pg-openin-main');
const chevron = () => domContainer().querySelector<HTMLButtonElement>('.pg-openin-chevron');
// 菜单是 createPortal 到 document.body 的（Picker 的既有做法）：不在 domContainer 里
const menuItems = () => [...document.body.querySelectorAll<HTMLButtonElement>('.pg-picker-item')];
const openCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'open_in_app_open');

/** 挂载并等"可用列表"那一跳落地。 */
async function mount(node: React.ReactNode, ms = 40) {
  mountDom(node);
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

function mockHost(apps: string[], icon: string | null = null, openFails = false) {
  invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    if (name === 'open_in_app_list') return apps;
    if (name === 'open_in_app_icon') return icon;
    if (name === 'open_in_app_open') {
      if (openFails) throw new Error('应用不可用');
      return null;
    }
    if (name === 'tab_create') {
      return {
        tab_id: 't-1', cwd: '/Users/mock/proj', session_id: 's1', session_file: null,
        session_name: 'Piggy', worker_state: 'ready',
        state: { model: { id: 'm1', name: 'm1', provider: 'p1' }, isStreaming: false },
      };
    }
    if (name === 'pi_get_messages') return { messages: [] };
    void args;
    return {};
  });
}

describe('OpenInApp：可用列表 → 菜单', () => {
  beforeEach(() => {
    resetOpenInAppCache();
    localStorage.removeItem('piggy.open-in-app.choice');
    invokeMock.mockReset();
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
  });
  afterEach(async () => {
    await unmountDom();
  });

  it('主按钮显示上次应用的图标 + 名字，箭头展开本机全部应用', async () => {
    mockHost(['finder', 'vscode', 'goland', 'iterm', 'terminal'], PNG);
    await mount(<OpenInApp cwd="/Users/mock/proj" />);
    expect(split()).not.toBeNull();
    expect(main()!.textContent).toBe('访达'); // 词典里的中文名，不是裸 id
    expect(main()!.querySelector('img')).not.toBeNull(); // 有图标就走 <img>

    await act(async () => {
      chevron()!.click();
    });
    await drainReact();
    const labels = menuItems().map((i) => i.querySelector('.pg-picker-label')?.textContent);
    expect(labels).toEqual(['访达', 'VS Code', 'GoLand', 'iTerm2', '终端']);
  });

  it('宿主多报的 id 被丢掉（词典里没有就不显示），空列表则不渲染按钮', async () => {
    mockHost(['vscode', 'some-future-editor'], PNG);
    await mount(<OpenInApp cwd="/tmp" />);
    await act(async () => {
      chevron()!.click();
    });
    await drainReact();
    expect(menuItems().map((i) => i.querySelector('.pg-picker-label')?.textContent)).toEqual(['VS Code']);

    await unmountDom();
    resetOpenInAppCache();
    mockHost([]);
    await mount(<OpenInApp cwd="/tmp" />);
    expect(split()).toBeNull();
  });

  it('没有 cwd 就不渲染（没有目录就没有"打开什么"）', async () => {
    mockHost(['vscode'], PNG);
    await mount(<OpenInApp cwd={undefined} />);
    expect(split()).toBeNull();
    // 可用列表是**页面级**读取（DSH 的 controller 在插件 apply 时就 load 一次），
    // 与"这个会话有没有 cwd"无关；关键是别每次都去读一遍宿主。
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'open_in_app_list')).toHaveLength(1);
    await unmountDom();
    resetOpenInAppCache();
    await mount(<OpenInApp cwd="" />);
    expect(split()).toBeNull();
  });

  it('可用列表每页只读一次（两次挂载共享同一次读取）', async () => {
    mockHost(['vscode'], PNG);
    await mount(<OpenInApp cwd="/tmp" />);
    await unmountDom();
    await mount(<OpenInApp cwd="/tmp" />);
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'open_in_app_list')).toHaveLength(1);
  });

  it('图标拿不到 → 画通用方块（而不是空白或破图）', async () => {
    mockHost(['vscode'], null);
    await mount(<OpenInApp cwd="/tmp" />);
    expect(main()!.querySelector('img')).toBeNull();
    expect(main()!.querySelector('svg[data-icon-kind="generic"]')).not.toBeNull();
  });
});

describe('OpenInApp：点下去真的走 IPC', () => {
  beforeEach(() => {
    resetOpenInAppCache();
    localStorage.removeItem('piggy.open-in-app.choice');
    invokeMock.mockReset();
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
  });
  afterEach(async () => {
    await unmountDom();
  });

  it('主按钮 = 直接用当前应用打开当前目录', async () => {
    mockHost(['vscode', 'goland'], PNG);
    await mount(<OpenInApp cwd="/Users/mock/proj" />);
    await act(async () => {
      main()!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(openCalls()).toHaveLength(1);
    expect(openCalls()[0]?.[1]).toEqual({ id: 'vscode', path: '/Users/mock/proj' });
  });

  it('菜单里选另一个应用：立刻打开它，并记住选择', async () => {
    mockHost(['vscode', 'goland'], PNG);
    await mount(<OpenInApp cwd="/proj" />);
    await act(async () => {
      chevron()!.click();
    });
    await drainReact();
    const goland = menuItems().find((i) => i.textContent?.includes('GoLand'))!;
    await act(async () => {
      goland.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(openCalls().at(-1)?.[1]).toEqual({ id: 'goland', path: '/proj' });
    expect(localStorage.getItem('piggy.open-in-app.choice')).toBe('goland');

    // 重新挂载（模拟下次进应用）：主按钮显示的是记住的那个，而不是第一个
    await unmountDom();
    await mount(<OpenInApp cwd="/proj" />);
    expect(main()!.textContent).toBe('GoLand');
    expect(main()!.getAttribute('data-app')).toBe('goland');
  });

  it('记住的应用这台机器上没了 → 退回第一个可用项（不是空白按钮）', async () => {
    localStorage.setItem('piggy.open-in-app.choice', 'rustrover');
    mockHost(['vscode', 'goland'], PNG);
    await mount(<OpenInApp cwd="/proj" />);
    expect(main()!.getAttribute('data-app')).toBe('vscode');
  });

  it('打开失败 → error 态（可被看见），不是静默无反应', async () => {
    mockHost(['vscode'], PNG, true);
    await mount(<OpenInApp cwd="/proj" />);
    await act(async () => {
      main()!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(split()!.getAttribute('data-phase')).toBe('error');
    expect(main()!.getAttribute('aria-label')).toContain('打开失败');
  });

  it('连点两次只发一次（在途去重，避免开出两个窗口）', async () => {
    mockHost(['vscode'], PNG);
    await mount(<OpenInApp cwd="/proj" />);
    await act(async () => {
      main()!.click();
      main()!.click();
      main()!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(openCalls()).toHaveLength(1);
  });
});

describe('OpenInApp：接进会话头部', () => {
  beforeEach(() => {
    resetOpenInAppCache();
    localStorage.removeItem('piggy.open-in-app.choice');
    resetBootForTest();
    invokeMock.mockReset();
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
    useTabs.setState({ tabs: {}, order: [], activeTabId: null, unread: {}, banner: null });
    useMessages.setState({ tabs: {} });
    useUi.setState({ sidebarOpen: true, paletteOpen: false });
    mockHost(['finder', 'vscode'], PNG);
  });
  afterEach(async () => {
    await unmountDom();
  });

  it('会话落位后，头部操作区里就有它，且用的是这个会话的 cwd', async () => {
    await mount(<App />, 80);
    const head = domContainer().querySelector('.pg-session-head-ops');
    expect(head).not.toBeNull();
    expect(head!.querySelector('.pg-openin-split')).not.toBeNull();
    // 头部原来的两个占位按钮里，「打开方式」那个必须已经被真按钮取代
    expect(head!.querySelector('button[title*="排期 M2"] i.codicon-link-external')).toBeNull();

    await act(async () => {
      head!.querySelector<HTMLButtonElement>('.pg-openin-main')!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(openCalls().at(-1)?.[1]).toEqual({ id: 'finder', path: '/Users/mock/proj' });
  });
});

describe('OpenInApp：跨头部的共享状态与可见的失败原因', () => {
  beforeEach(() => {
    resetOpenInAppCache();
    localStorage.removeItem('piggy.open-in-app.choice');
    invokeMock.mockReset();
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
  });
  afterEach(async () => {
    await unmountDom();
  });

  it('在 A 会话改了应用，B 会话头部跟着变（DSH 的 choice 是一份共享 store）', async () => {
    mockHost(['vscode', 'goland'], PNG);
    // 两个会话头部同时挂载（分屏时就是这个形态）
    await mount(
      <>
        <OpenInApp cwd="/proj-a" />
        <OpenInApp cwd="/proj-b" />
      </>,
    );
    const mains = () => [...domContainer().querySelectorAll<HTMLButtonElement>('.pg-openin-main')];
    expect(mains().map((b) => b.getAttribute('data-app'))).toEqual(['vscode', 'vscode']);

    // 在第一个上开菜单并选 GoLand
    await act(async () => {
      domContainer().querySelectorAll<HTMLButtonElement>('.pg-openin-chevron')[0]!.click();
    });
    await drainReact();
    const goland = menuItems().find((i) => i.textContent?.includes('GoLand'))!;
    await act(async () => {
      goland.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    // 不广播的话第二个头部会一直显示 VS Code，而且点下去启动的还是 VS Code
    expect(mains().map((b) => b.getAttribute('data-app'))).toEqual(['goland', 'goland']);
  });

  it('失败原因挂到 title 上，并转一道到宿主终端（打包版没有 DevTools）', async () => {
    const hostLog = vi.fn(async (..._args: unknown[]) => undefined);
    (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke: hostLog };
    mockHost(['vscode'], PNG, true);
    await mount(<OpenInApp cwd="/proj" />);
    await act(async () => {
      main()!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    // 只闪一个红框等于没说为什么
    expect(main()!.getAttribute('aria-label')).toContain('应用不可用');
    expect(main()!.getAttribute('title')).toContain('应用不可用');
    expect(hostLog.mock.calls.some((c) => String(c[0]) === 'webview_log')).toBe(true);
    delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });
});

describe('OpenInApp：命令面板入口', () => {
  beforeEach(() => {
    resetOpenInAppCache();
    localStorage.removeItem('piggy.open-in-app.choice');
    resetBootForTest();
    invokeMock.mockReset();
    listenMock.mockClear();
    listenMock.mockResolvedValue(() => {});
    useTabs.setState({ tabs: {}, order: [], activeTabId: null, unread: {}, banner: null });
    useMessages.setState({ tabs: {} });
    useUi.setState({ sidebarOpen: true, paletteOpen: false });
    mockHost(['finder', 'vscode'], PNG);
  });
  afterEach(async () => {
    await unmountDom();
  });

  it('跑命令真的会展开菜单（不是发一个没人听的 emit）', async () => {
    await mount(<App />, 80);
    expect(document.body.querySelector('.pg-picker-menu')).toBeNull();
    const cmd = getCommand('openin.pick');
    expect(cmd, 'openin.pick 必须注册（否则命令面板里没有入口）').toBeTruthy();

    await act(async () => {
      await cmd!.run({ activeTabId: useTabs.getState().activeTabId });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(document.body.querySelector('.pg-picker-menu')).not.toBeNull();
    expect(menuItems().map((i) => i.querySelector('.pg-picker-label')?.textContent)).toEqual([
      '访达',
      'VS Code',
    ]);
  });
});

describe('labelFor：词典边界', () => {
  it('产品名逐字一致，未知 id 返回 null（宿主与词典的契约）', () => {
    expect(labelFor('vscode')).toBe('VS Code');
    expect(labelFor('iterm')).toBe('iTerm2');
    expect(labelFor('finder')).toBe('访达');
    expect(labelFor('terminal')).toBe('终端');
    expect(labelFor('nope')).toBeNull();
  });
});
