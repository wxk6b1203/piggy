// @vitest-environment jsdom
/**
 * 「打开方式」：一个共用控件（`OpenTargetButton`）+ 两个数据源（目录白名单 / 文件关联）。
 *
 * 锁的东西 —— 每一条都对应一个"界面上看不出来"的失败模式：
 *   ① **宿主说装了哪些，菜单里就只有哪些**：宿主多报的 id（词典里没有）必须被丢掉；
 *      宿主报空 → 不渲染（而不是渲染一个坏按钮）。
 *   ② **点下去真的带着"哪个应用 + 哪个路径"走 IPC**：只断言"按钮在"测不出接线错。
 *   ③ **文件那一档走的是系统关联**：主按钮 = 系统默认应用；没有默认应用时退成
 *      「显示文件位置」（DSH 的 revealDefault）；菜单里的处理器按 id 精确回传。
 *   ④ **失败可见**：走 toast（DSH `open-failure-toast`），只闪一个红框等于没说为什么。
 *   ⑤ **上次选择跨会话头部共享**（DSH 的 choice 是一份共享 store）。
 *   ⑥ **命令面板的 `openin.pick` 真的展开菜单**（不是发一个没人听的 emit）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock, listenMock, toastError } = vi.hoisted(() => {
  const invokeMock = vi.fn();
  const listenMock = vi.fn();
  listenMock.mockResolvedValue(() => {});
  return { invokeMock, listenMock, toastError: vi.fn() };
});
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listenMock(...a) }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn() },
  // App 会渲染这个桥组件；不导出它整棵树都挂不起来
  FeedbackBridge: () => null,
}));

import App from '@/App';
import { OpenInApp, labelFor } from '@/features/chat/OpenInApp';
import { OpenPathAction } from '@/features/preview/OpenPathAction';
import { resetBootForTest } from '@/features/workspace/AppFrame';
import { getCommand } from '@/lib/commands';
import { resetDesktopCacheForTest, resetOpenInAppCache } from '@/lib/openInApp';
import { useTabs } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';
import { useUi } from '@/stores/ui';
import { mountDom, unmountDom, domContainer, drainReact } from './dom-render';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const split = () => domContainer().querySelector<HTMLElement>('.pg-opentarget-split');
const main = () => domContainer().querySelector<HTMLButtonElement>('.pg-opentarget-main');
const chevron = () => domContainer().querySelector<HTMLButtonElement>('.pg-opentarget-chevron');
// 菜单是 createPortal 到 document.body 的（Picker 的既有做法）：不在 domContainer 里
const menuItems = () => [...document.body.querySelectorAll<HTMLButtonElement>('.pg-picker-item')];
const menuLabels = () => menuItems().map((i) => i.querySelector('.pg-picker-label')?.textContent);
const calls = (name: string) => invokeMock.mock.calls.filter((c) => c[0] === name);
const argsOf = (name: string) => calls(name).map((c) => c[1] as Record<string, unknown>);

async function mount(node: React.ReactNode, ms = 40) {
  mountDom(node);
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/** 宿主 mock：目录白名单 + 文件关联。 */
function mockHost(
  catalog: string[],
  opts: {
    icon?: string | null;
    openFails?: boolean;
    desktop?: boolean;
    pathApps?: { id: string; name: string; default: boolean; icon: string | null }[];
    pathFails?: boolean;
    pathOpenFails?: boolean;
  } = {},
) {
  invokeMock.mockImplementation(async (name: string) => {
    switch (name) {
      case 'open_in_app_list':
        return catalog;
      case 'open_in_app_icon':
        return opts.icon ?? null;
      case 'open_in_app_open':
        if (opts.openFails) throw new Error('应用不可用');
        return null;
      case 'open_path_available':
        return opts.desktop ?? true;
      case 'open_path_applications':
        if (opts.pathFails) throw new Error('gio 挂了');
        return (
          opts.pathApps ?? [
            { id: '/Applications/Typora.app', name: 'Typora.app', default: true, icon: PNG },
            { id: '/Applications/Visual Studio Code.app', name: 'VS Code.app', default: false, icon: null },
          ]
        );
      case 'open_path_open':
        if (opts.pathOpenFails) throw new Error('路径不存在');
        return null;
      case 'tab_create':
        return {
          tab_id: 't-1', cwd: '/Users/mock/proj', session_id: 's1', session_file: null,
          session_name: 'Piggy', worker_state: 'ready',
          state: { model: { id: 'm1', name: 'm1', provider: 'p1' }, isStreaming: false },
        };
      case 'pi_get_messages':
        return { messages: [] };
      default:
        return {};
    }
  });
}

beforeEach(() => {
  resetOpenInAppCache();
  resetDesktopCacheForTest();
  localStorage.removeItem('piggy.open-in-app.choice');
  invokeMock.mockReset();
  listenMock.mockClear();
  listenMock.mockResolvedValue(() => {});
  toastError.mockReset();
});
afterEach(async () => {
  await unmountDom();
});

describe('目录那一档：可用列表 → 菜单', () => {
  it('主按钮显示上次应用的图标 + 名字，箭头展开本机全部应用', async () => {
    mockHost(['finder', 'vscode', 'goland', 'iterm', 'terminal'], { icon: PNG });
    await mount(<OpenInApp cwd="/Users/mock/proj" />);
    expect(split()).not.toBeNull();
    expect(split()!.getAttribute('data-open-target')).toBe('directory');
    expect(split()!.getAttribute('data-size')).toBe('large');
    expect(main()!.textContent).toBe('访达'); // 词典里的中文名，不是裸 id
    expect(main()!.querySelector('img')).not.toBeNull(); // 有图标就走 <img>

    await act(async () => {
      chevron()!.click();
    });
    await drainReact();
    expect(menuLabels()).toEqual(['访达（默认）', 'VS Code', 'GoLand', 'iTerm2', '终端']);
  });

  it('宿主多报的 id 被丢掉（词典里没有就不显示），空列表则不渲染按钮', async () => {
    mockHost(['vscode', 'some-future-editor', 'goland'], { icon: PNG });
    await mount(<OpenInApp cwd="/tmp" />);
    await act(async () => {
      chevron()!.click();
    });
    await drainReact();
    expect(menuLabels()).toEqual(['VS Code（默认）', 'GoLand']);

    await unmountDom();
    resetOpenInAppCache();
    mockHost([]);
    await mount(<OpenInApp cwd="/tmp" />);
    expect(split()).toBeNull();
  });

  it('没有 cwd 就不渲染（没有目录就没有"打开什么"）', async () => {
    mockHost(['vscode'], { icon: PNG });
    await mount(<OpenInApp cwd={undefined} />);
    expect(split()).toBeNull();
    // 可用列表是**页面级**读取，与"这个会话有没有 cwd"无关
    expect(calls('open_in_app_list')).toHaveLength(1);
    await unmountDom();
    resetOpenInAppCache();
    await mount(<OpenInApp cwd="" />);
    expect(split()).toBeNull();
  });

  it('可用列表每页只读一次（两次挂载共享同一次读取）', async () => {
    mockHost(['vscode'], { icon: PNG });
    await mount(<OpenInApp cwd="/tmp" />);
    await unmountDom();
    await mount(<OpenInApp cwd="/tmp" />);
    expect(calls('open_in_app_list')).toHaveLength(1);
  });

  it('图标拿不到 → 画通用方块（而不是空白或破图）', async () => {
    mockHost(['vscode'], { icon: null });
    await mount(<OpenInApp cwd="/tmp" />);
    expect(main()!.querySelector('img')).toBeNull();
    expect(main()!.querySelector('svg[data-icon-kind="generic"]')).not.toBeNull();
  });
});

describe('目录那一档：点下去真的走 IPC', () => {
  it('主按钮 = 直接用当前应用打开当前目录', async () => {
    mockHost(['vscode', 'goland'], { icon: PNG });
    await mount(<OpenInApp cwd="/Users/mock/proj" />);
    await act(async () => {
      main()!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(argsOf('open_in_app_open')).toEqual([{ id: 'vscode', path: '/Users/mock/proj' }]);
  });

  it('菜单里选另一个应用：立刻打开它，并记住选择', async () => {
    mockHost(['vscode', 'goland'], { icon: PNG });
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
    expect(argsOf('open_in_app_open').at(-1)).toEqual({ id: 'goland', path: '/proj' });
    expect(localStorage.getItem('piggy.open-in-app.choice')).toBe('goland');

    await unmountDom();
    await mount(<OpenInApp cwd="/proj" />);
    expect(main()!.textContent).toBe('GoLand');
    expect(main()!.getAttribute('aria-label')).toBe('用 GoLand 打开');
  });

  it('记住的应用这台机器上没了 → 退回第一个可用项（不是空白按钮）', async () => {
    localStorage.setItem('piggy.open-in-app.choice', 'rustrover');
    mockHost(['vscode', 'goland'], { icon: PNG });
    await mount(<OpenInApp cwd="/proj" />);
    expect(main()!.textContent).toBe('VS Code');
  });

  it('打开失败 → toast 报出原因（Rust 那句话）', async () => {
    mockHost(['vscode'], { icon: PNG, openFails: true });
    await mount(<OpenInApp cwd="/proj" />);
    await act(async () => {
      main()!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(String(toastError.mock.calls[0]?.[0])).toContain('应用不可用');
  });

  it('连点两次只发一次（在途去重，避免开出两个窗口）', async () => {
    mockHost(['vscode'], { icon: PNG });
    await mount(<OpenInApp cwd="/proj" />);
    await act(async () => {
      main()!.click();
      main()!.click();
      main()!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(calls('open_in_app_open')).toHaveLength(1);
  });

  it('在 A 会话改了应用，B 会话头部跟着变（DSH 的 choice 是一份共享 store）', async () => {
    mockHost(['vscode', 'goland'], { icon: PNG });
    await mount(
      <>
        <OpenInApp cwd="/proj-a" />
        <OpenInApp cwd="/proj-b" />
      </>,
    );
    const mains = () => [...domContainer().querySelectorAll<HTMLButtonElement>('.pg-opentarget-main')];
    expect(mains().map((b) => b.textContent)).toEqual(['VS Code', 'VS Code']);

    await act(async () => {
      domContainer().querySelectorAll<HTMLButtonElement>('.pg-opentarget-chevron')[0]!.click();
    });
    await drainReact();
    await act(async () => {
      menuItems().find((i) => i.textContent?.includes('GoLand'))!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(mains().map((b) => b.textContent)).toEqual(['GoLand', 'GoLand']);
  });
});

describe('文件那一档：操作系统文件关联', () => {
  const FILE = '/Users/mock/proj/README.md';

  it('主按钮 = 系统默认应用，菜单列出全部已注册处理器 + 显示文件位置', async () => {
    mockHost([], {
      pathApps: [
        { id: '/Applications/Typora.app', name: 'Typora.app', default: true, icon: PNG },
        { id: '/Applications/Visual Studio Code.app', name: 'VS Code.app', default: false, icon: null },
      ],
    });
    await mount(<OpenPathAction path={FILE} />);
    expect(split()!.getAttribute('data-open-target')).toBe('file');
    expect(split()!.getAttribute('data-size')).toBe('compact'); // 预览头部：只有图标
    expect(main()!.getAttribute('aria-label')).toBe('用 Typora.app 打开');
    expect(main()!.querySelector('img')).not.toBeNull();
    expect(argsOf('open_path_applications')).toEqual([{ path: FILE }]);

    await act(async () => {
      chevron()!.click();
    });
    await drainReact();
    expect(menuLabels()).toEqual(['Typora.app（默认）', 'VS Code.app', '显示文件位置']);
  });

  it('点主按钮 = 用系统默认应用打开这个文件', async () => {
    mockHost([]);
    await mount(<OpenPathAction path={FILE} />);
    await act(async () => {
      main()!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(argsOf('open_path_open')).toEqual([
      { path: FILE, action: 'open', application: '/Applications/Typora.app' },
    ]);
  });

  it('菜单里选另一个处理器：按**它的 id** 打开（不是默认那个）', async () => {
    mockHost([]);
    await mount(<OpenPathAction path={FILE} />);
    await act(async () => {
      chevron()!.click();
    });
    await drainReact();
    await act(async () => {
      menuItems().find((i) => i.textContent?.includes('VS Code.app'))!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(argsOf('open_path_open').at(-1)).toEqual({
      path: FILE,
      action: 'open',
      application: '/Applications/Visual Studio Code.app',
    });
  });

  it('选「显示文件位置」→ action=reveal', async () => {
    mockHost([]);
    await mount(<OpenPathAction path={FILE} />);
    await act(async () => {
      chevron()!.click();
    });
    await drainReact();
    await act(async () => {
      menuItems().find((i) => i.textContent?.includes('显示文件位置'))!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(argsOf('open_path_open').at(-1)).toEqual({ path: FILE, action: 'reveal', application: null });
  });

  it('系统没有默认应用 → 主按钮退成「显示文件位置」（DSH revealDefault）', async () => {
    mockHost([], {
      pathApps: [{ id: '/Applications/Foo.app', name: 'Foo.app', default: false, icon: null }],
    });
    await mount(<OpenPathAction path={FILE} />);
    expect(main()!.getAttribute('aria-label')).toBe('显示文件位置');
    await act(async () => {
      main()!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(argsOf('open_path_open').at(-1)).toEqual({ path: FILE, action: 'reveal', application: null });
  });

  it('一个处理器都没有 + 查询失败 → 菜单里说明查不到，主按钮仍是「显示文件位置」', async () => {
    mockHost([], { pathApps: [], pathFails: true });
    await mount(<OpenPathAction path={FILE} />);
    expect(main()!.getAttribute('aria-label')).toBe('显示文件位置');
    await act(async () => {
      chevron()!.click();
    });
    await drainReact();
    expect(menuLabels()).toEqual(['无法获取应用列表', '显示文件位置（默认）']);
  });

  it('桌面能力为 false（无头/SSH）→ 整个控件不渲染', async () => {
    mockHost([], { desktop: false });
    await mount(<OpenPathAction path={FILE} />);
    expect(split()).toBeNull();
    expect(calls('open_path_applications')).toHaveLength(0);
  });

  it('打开失败 → toast（显示位置与打开的失败文案不同）', async () => {
    mockHost([], { pathOpenFails: true });
    await mount(<OpenPathAction path={FILE} />);
    await act(async () => {
      chevron()!.click();
    });
    await drainReact();
    await act(async () => {
      menuItems().find((i) => i.textContent?.includes('显示文件位置'))!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(String(toastError.mock.calls[0]?.[0])).toContain('无法显示文件位置');
  });
});

describe('接进界面：会话头部 + 命令面板', () => {
  beforeEach(() => {
    resetBootForTest();
    useTabs.setState({ tabs: {}, order: [], activeTabId: null, unread: {}, banner: null });
    useMessages.setState({ tabs: {} });
    useUi.setState({ sidebarOpen: true, paletteOpen: false });
    mockHost(['finder', 'vscode'], { icon: PNG });
  });

  it('会话落位后头部操作区里就有它，且用的是这个会话的 cwd', async () => {
    await mount(<App />, 80);
    const head = domContainer().querySelector('.pg-session-head-ops');
    expect(head).not.toBeNull();
    expect(head!.querySelector('.pg-opentarget-split')).not.toBeNull();
    // 头部原来的两个占位按钮里，「打开方式」那个必须已经被真按钮取代
    expect(head!.querySelector('i.codicon-link-external')).toBeNull();

    await act(async () => {
      head!.querySelector<HTMLButtonElement>('.pg-opentarget-main')!.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(argsOf('open_in_app_open').at(-1)).toEqual({ id: 'finder', path: '/Users/mock/proj' });
  });

  it('命令面板入口真的会展开菜单（不是发一个没人听的 emit）', async () => {
    await mount(<App />, 80);
    expect(document.body.querySelector('.pg-picker-menu')).toBeNull();
    const cmd = getCommand('openin.pick');
    expect(cmd, 'openin.pick 必须注册（否则命令面板里没有入口）').toBeTruthy();
    await act(async () => {
      await cmd!.run({ activeTabId: useTabs.getState().activeTabId });
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(document.body.querySelector('.pg-picker-menu')).not.toBeNull();
    expect(menuLabels()).toEqual(['访达（默认）', 'VS Code']);
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
