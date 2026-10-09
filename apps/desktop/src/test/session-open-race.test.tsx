// @vitest-environment jsdom
/**
 * 重复打开同一会话文件的回归测试。
 *
 * 起因（2026-09-23 用户终端日志，"非常偶尔会报错"）：
 *
 *   [piggy] spawn pi [3a8c24e9-…] --session …/12-10-31-790Z_2c118184-….jsonl
 *   [piggy] tab_create ok: 3a8c24e9-…
 *   [piggy] spawn pi [c3d9ea15-…] --session …/12-10-31-790Z_2c118184-….jsonl   ← 同一个文件
 *   [piggy] tab_create FAILED: 会话文件已被标签页 3a8c24e9-… 打开: …/12-10-31-790Z_2c118184-….jsonl
 *
 * Rust 侧的互斥锁是对的（并发调用被同一个 registry 锁串起来，第二个必然看见第一个），
 * 而且它在返回错误前 `worker.shutdown()` 了 —— 没有进程泄漏。**问题在前端**：
 * `openSession` 的"已经打开了就聚焦"查的是 zustand store，而 store 要等
 * `createTabGuarded` 走完 IPC 才更新。两次点击落在同一个 await 窗口里，
 * 两次都查到"没打开"，于是都去建 worker，第二次被 Rust 挡下来变成一条红色 toast。
 *
 * 双击、或者第一次打开比较慢时手快点两下，就是这个现象 —— 所以"非常偶尔"。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock, toastError } = vi.hoisted(() => ({ invokeMock: vi.fn(), toastError: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
/* 报错通道也 mock 掉：用户看到的那条红色 toast 就是这条断言要拦的东西
   （`openSession` 的 catch 会把 dockview 的 "already exists" 变成 toast）。 */
vi.mock('@/lib/feedback', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn() },
  FeedbackBridge: () => null,
  confirm: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));

import { SessionsSidebar } from '@/features/workspace/SessionsSidebar';
import { useSessions } from '@/stores/sessions';
import { useTabs } from '@/stores/tabs';
import { __resetCreateTabCache } from '@/lib/tabCreate';
import { mountDom, unmountDom, domContainer } from './dom-render';

const SESSION = {
  path: '/Users/mock/proj/sess-A.jsonl',
  file_name: 'sess-A.jsonl',
  session_id: 'sess-A',
  cwd: '/Users/mock/proj',
  name: null,
  first_message: '会话 A',
  mtime_ms: 1_700_000_000_000,
  size: 100,
};

/**
 * 一次 tab_create 的响应；带一点延迟，模拟真机 IPC。
 *
 * ⚠️ `state` / `worker_state` 不能省：`stores/tabs.addTab` 会读 `snap.state.model`，
 * 少了它 `ensureTab` 直接抛异常，标签进不了 store —— 那样第二个点击"重建 worker"
 * 是因为**第一个调用自己炸了**，不是因为竞态。这条测试第一版就是这么假红的。
 */
function tabCreateResponse(tabId: string) {
  return {
    tab_id: tabId,
    session_file: SESSION.path,
    session_id: 'sess-A',
    session_name: null,
    cwd: SESSION.cwd,
    permission: 'full',
    worker_state: 'ready',
    state: {},
  };
}

/**
 * `focusSessionTab` 找的是 **dockview 面板**，不是 store（EditorArea.tsx:326）。
 * jsdom 里没有 dockview，所以要么给个最小假的，要么这条用例会因为"环境里没有面板"
 * 而假红 —— 假红比不写更坏。这里给最小面：面板列表里放一个 params.tabId 匹配的。
 */
function stubDockWithPanel(tabId: string) {
  (globalThis as Record<string, unknown>).__piggyDock = {
    panels: [{ params: { kind: 'session', tabId }, focus: () => {} }],
  };
}

/**
 * 更完整的 dockview 假面：**重复 id 就抛**，与真 dockview 同款
 * （`_doAddPanel`：`dockview-core:17360` 的 `panel with id … already exists`）。
 *
 * 为什么必须有这一层：只给一个 `panels` 数组的话，`api()?.addPanel(...)` 是
 * **可选链上空**、根本不执行 —— "连点两次会不会加两个面板"这条在 jsdom 里
 * 永远假绿。用户报的那条报错就是从这里来的。
 */
function stubDock() {
  const panels: {
    id: string;
    params: Record<string, unknown>;
    focus: () => void;
    focused: () => boolean;
    /** dockview 的 `panel.api.close()`（乐观 UI 关占位用） */
    api: { close: () => void };
  }[] = [];
  const adds: string[] = [];
  const closes: string[] = [];
  let focusedId: string | null = null;
  const api = {
    panels,
    addPanel(opts: { id: string; params?: Record<string, unknown> }) {
      if (panels.some((p) => p.id === opts.id)) {
        throw new Error(`dockview: panel with id ${opts.id} already exists`);
      }
      adds.push(opts.id);
      const panel = {
        id: opts.id,
        params: opts.params ?? {},
        focus: () => {
          focusedId = opts.id;
        },
        focused: () => focusedId === opts.id,
        api: {
          close: () => {
            closes.push(opts.id);
            const i = panels.findIndex((x) => x.id === opts.id);
            if (i >= 0) panels.splice(i, 1);
          },
        },
      };
      panels.push(panel);
      return panel;
    },
    getPanel: (id: string) => panels.find((p) => p.id === id),
  };
  (globalThis as Record<string, unknown>).__piggyDock = api;
  return { api, adds, closes, panels, focused: () => focusedId };
}

let seq = 0;
beforeEach(() => {
  seq = 0;
  __resetCreateTabCache(); // 模块级缓存跨用例残留会互相干扰
  (globalThis as Record<string, unknown>).__piggyDock = undefined;
  invokeMock.mockReset();
  toastError.mockReset();
  useTabs.setState({ tabs: {}, activeTabId: null });
  useSessions.setState({ groups: [], loaded: true });
  invokeMock.mockImplementation(async (cmdName: string) => {
    if (cmdName === 'tab_create') {
      seq += 1;
      await new Promise((r) => setTimeout(r, 30)); // IPC 往返窗口
      return tabCreateResponse(`tab-${seq}`);
    }
    if (cmdName === 'session_page') return { rows: [], startOffset: 0, hasMore: false, branchy: false };
    if (cmdName === 'pi_get_messages') return { messages: [] };
    return null;
  });
});

afterEach(async () => {
  await unmountDom();
});

const rowOf = () => domContainer().querySelector<HTMLElement>('.pg-session-row')!;
const tabCreateCalls = () => invokeMock.mock.calls.filter((c) => c[0] === 'tab_create').length;

async function clickTwice(el: HTMLElement) {
  await act(async () => {
    el.click();
    el.click(); // 同一 tick 内的第二次点击（双击 / 手快）
    await new Promise((r) => setTimeout(r, 200));
  });
}

describe('侧栏：同一会话文件不许并发建两个 worker', () => {
  it('连点两次只发一次 tab_create（第二次应当复用第一次的结果）', async () => {
    useSessions.setState({ groups: [{ cwd: SESSION.cwd, label: 'proj', sessions: [SESSION] }] });
    mountDom(<SessionsSidebar />);

    await clickTwice(rowOf());

    expect(tabCreateCalls()).toBe(1);
  });

  it('关掉之后重新打开同一会话：必须重建 worker，不能复用死掉的缓存', async () => {
    useSessions.setState({ groups: [{ cwd: SESSION.cwd, label: 'proj', sessions: [SESSION] }] });
    mountDom(<SessionsSidebar />);

    await clickTwice(rowOf());
    expect(tabCreateCalls()).toBe(1);

    // 关掉这个标签（store 里没了）—— 去重缓存不随 settle 逐出，这里正是它的风险点
    const tabId = Object.keys(useTabs.getState().tabs)[0]!;
    await act(async () => {
      useTabs.getState().removeTab(tabId);
      await new Promise((r) => setTimeout(r, 20));
    });

    await act(async () => {
      rowOf().click();
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(tabCreateCalls()).toBe(2);
  });

  it('会话已经开着时点行 → 只聚焦，不再建 worker', async () => {
    useSessions.setState({ groups: [{ cwd: SESSION.cwd, label: 'proj', sessions: [SESSION] }] });
    useTabs.setState({
      tabs: {
        'tab-existing': {
          tabId: 'tab-existing',
          sessionFile: SESSION.path,
          sessionId: 'sess-A',
          sessionName: null,
          cwd: SESSION.cwd,
          permission: 'full',
          workerState: 'ready',
          model: null,
          thinkingLevel: null,
        },
      },
      activeTabId: 'tab-existing',
    } as never);
    stubDockWithPanel('tab-existing');
    mountDom(<SessionsSidebar />);

    await act(async () => {
      rowOf().click();
      await new Promise((r) => setTimeout(r, 120));
    });

    expect(tabCreateCalls()).toBe(0);
  });

  it('导出一个**已打开**的会话：复用现有 tab，不新建、也不把它关掉', async () => {
    useSessions.setState({ groups: [{ cwd: SESSION.cwd, label: 'proj', sessions: [SESSION] }] });
    useTabs.setState({
      tabs: {
        'tab-existing': {
          tabId: 'tab-existing',
          sessionFile: SESSION.path,
          sessionId: 'sess-A',
          sessionName: null,
          cwd: SESSION.cwd,
          permission: 'full',
          workerState: 'ready',
          model: null,
          thinkingLevel: null,
        },
      },
      activeTabId: 'tab-existing',
    } as never);
    invokeMock.mockImplementation(async (cmdName: string) => {
      if (cmdName === 'tab_create') {
        seq += 1;
        return tabCreateResponse(`tab-${seq}`);
      }
      if (cmdName === 'pi_export_html') return { path: '/tmp/export.html' };
      if (cmdName === 'session_page') return { rows: [], startOffset: 0, hasMore: false, branchy: false };
    if (cmdName === 'pi_get_messages') return { messages: [] };
      return null;
    });
    mountDom(<SessionsSidebar />);

    const exportBtn = domContainer().querySelector<HTMLElement>('button[title="导出 HTML"]')!;
    await act(async () => {
      exportBtn.click();
      await new Promise((r) => setTimeout(r, 150));
    });

    expect(tabCreateCalls()).toBe(0);
    const exported = invokeMock.mock.calls.find((c) => c[0] === 'pi_export_html');
    expect(exported?.[1]).toMatchObject({ tabId: 'tab-existing' });
    // 不能把用户正在用的标签关掉
    const closed = invokeMock.mock.calls.filter((c) => c[0] === 'tab_close');
    expect(closed).toEqual([]);
  });
});

/**
 * 乐观 UI（2026-10-09）：点击后**立刻**画占位标签，`tab_create` 回来换成真面板。
 *
 * 起因（用户）："每个新的会话打开都要等时间"。真机上 `tab_create` 要 spawn 一个 pi
 * 进程并握手（macOS 实测 ~0.5s，Windows 更久），而在这之前界面上什么都没有 ——
 * 用户只能再点一次。这里钉两件事：占位**不依赖 IPC 回来**、占位**不进布局持久化**。
 */
describe('乐观 UI：占位标签', () => {
  it('占位在 tab_create 落地**之前**就加上了（先反馈再等待）', async () => {
    const { openSessionTabOptimistic } = await import('@/features/workspace/EditorArea');
    const dock = stubDock();

    let settled = false;
    const p = openSessionTabOptimistic({ cwd: SESSION.cwd, name: '新会话' }, '新会话').then((v) => {
      settled = true;
      return v;
    });
    // 同一个 tick 里：IPC 还没回（mock 里 tab_create 有 30ms 延迟）
    expect(settled, '前置条件：tab_create 还没回来').toBe(false);
    expect(
      dock.adds.filter((id) => id.startsWith('session:pending:')).length,
      '点击后没有立刻出现占位标签 —— 用户看到的就是"点了没反应"',
    ).toBe(1);

    await act(async () => { await p; });
    expect(dock.adds).toContain('session:tab-1');
    // 真面板就位后占位必须消失
    expect(dock.panels.filter((x) => x.id.startsWith('session:pending:'))).toEqual([]);
  });

  it('占位不进布局持久化（否则重启后会多一个「会话文件不存在」的僵尸标签）', async () => {
    const { stripPendingPanels } = await import('@/features/workspace/EditorArea');
    const json = {
      panels: {
        'session:pending:3': { id: 'session:pending:3', contentComponent: 'session' },
        'session:tab-1': { id: 'session:tab-1', contentComponent: 'session' },
        settings: { id: 'settings', contentComponent: 'settings' },
      },
      grid: { root: {} },
    };
    const out = stripPendingPanels(json) as { panels: Record<string, unknown> };
    expect(Object.keys(out.panels).sort()).toEqual(['session:tab-1', 'settings']);
    // 原地改（`toJSON()` 的返回值是新鲜对象，没必要再复制一份）
    expect((json as { grid: unknown }).grid).toBeTruthy();
  });
});

/**
 * 同一会话连点两次：**只许有一个面板**（用户 2026-09-23 报：
 * `Error: dockview: panel with id session:<uuid> already exists`）。
 *
 * 去重（`createTabGuarded`）让两次点击拿到同一个快照，于是两次都会去 `addPanel` ——
 * 上面那条用例只断言了"只发一次 tab_create"，**漏掉的正是这一步**：面板加两次。
 */
describe('连点两次：只许有一个面板', () => {
  it('双击一行：addPanel 只调一次，第二次是聚焦', async () => {
    useSessions.setState({ groups: [{ cwd: SESSION.cwd, label: 'proj', sessions: [SESSION] }] });
    const dock = stubDock();
    mountDom(<SessionsSidebar />);

    await clickTwice(rowOf());

    expect(tabCreateCalls()).toBe(1);
    /* 乐观 UI 之后 `adds` 里会先有一个**占位**面板（`session:pending:*`），
       真面板随后加上、占位被关掉。要守的不变量没变：**同一个会话的 tabId 只许加一次**
       （加两次真 dockview 会抛 `already exists`）。 */
    expect(
      dock.adds.filter((id) => id === 'session:tab-1'),
      '同一个 tabId 加了两次面板 —— 真 dockview 会抛 already exists',
    ).toEqual(['session:tab-1']);
    // 占位必须被收掉：留着的话转录里永远挂着一个「正在启动 pi…」的骨架标签
    expect(dock.closes.filter((id) => id.startsWith('session:pending:')).length, '占位面板没关').toBeGreaterThan(0);
    expect(
      dock.panels.filter((p) => p.id.startsWith('session:pending:')),
      '还留着占位面板',
    ).toEqual([]);
    expect(toastError, `用户不该看到报错（收到：${String(toastError.mock.calls[0]?.[0] ?? '')}）`).not.toHaveBeenCalled();
    // 第二次点击必须**把已经开着的那个标签聚焦**，而不是静默什么都不做
    expect(dock.focused()).toBe('session:tab-1');
  });

  it('同一快照连开两次（面板已存在）→ 只聚焦，不再 addPanel', async () => {
    const { openSessionTab } = await import('@/features/workspace/EditorArea');
    const dock = stubDock();
    const snap = {
      tab_id: 'tab-x',
      session_file: SESSION.path,
      session_id: 'sess-A',
      session_name: null,
      cwd: SESSION.cwd,
      permission: 'full',
      worker_state: 'ready',
      state: {},
    } as never;

    await act(async () => {
      await openSessionTab(snap, '会话 A');
      await openSessionTab(snap, '会话 A');
      await new Promise((r) => setTimeout(r, 60));
    });

    expect(dock.adds).toEqual(['session:tab-x']);
  });

  it('双击只读**一次**尾页（第二次不许把转录洗一遍）', async () => {
    useSessions.setState({ groups: [{ cwd: SESSION.cwd, label: 'proj', sessions: [SESSION] }] });
    stubDock();
    mountDom(<SessionsSidebar />);

    await clickTwice(rowOf());

    const pages = invokeMock.mock.calls.filter((c) => c[0] === 'session_page').length;
    expect(pages, '同一个标签被装了两遍（hydratePage 会重置消息）').toBe(1);
  });
});
