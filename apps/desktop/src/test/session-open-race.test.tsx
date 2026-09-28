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

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
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

let seq = 0;
beforeEach(() => {
  seq = 0;
  __resetCreateTabCache(); // 模块级缓存跨用例残留会互相干扰
  (globalThis as Record<string, unknown>).__piggyDock = undefined;
  invokeMock.mockReset();
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
