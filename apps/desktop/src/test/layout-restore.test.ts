// @vitest-environment jsdom
/**
 * 布局恢复的**时序**回归测试（确定性，不靠碰运气）。
 *
 * 被锁住的事实（2026-09-23 真机症状：刚打开时标签都在，但模型列表空白、发消息报
 * 「tab 不存在: <uuid>」）：
 *
 *   `restore()` 是异步的（`layout_load` + 每个面板一次 `createTab`），而 StrictMode / HMR
 *   会在它跑的中途把 DockviewReact 卸载再挂载 —— 实例从 A 换成 B。
 *   旧写法在落地时读**当下的**实例：`api()?.fromJSON(...)`，于是较早那轮醒来时会
 *   把布局套到 B 上；两轮都套同一个实例，而 `fromJSON()` 是**先清空再重建**，
 *   第二次清空触发的 `onDidRemovePanel` 被当成"用户关标签"→ 刚恢复的 tab 全被关掉：
 *   面板还显示着、`useTabs` 空了、Rust registry 也空了。
 *
 * 浏览器里复现这条要卡时序（mock 快一点就复现、慢一点就没了），所以在这里用
 * 受控 promise 精确制造"恢复途中换实例"，直接断言**布局只套一次、且套在活着的实例上**。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const { ipcMocks } = vi.hoisted(() => ({
  ipcMocks: { cmd: vi.fn(), on: vi.fn() },
}));
vi.mock('@/lib/ipc', () => ({ cmd: ipcMocks.cmd, on: ipcMocks.on }));

import { restore } from '@/features/workspace/EditorArea';
import { useTabs } from '@/stores/tabs';
import { resetBootGateForTest } from '@/lib/boot';

interface FakeApi {
  name: string;
  panels: Array<{ id: string; params?: Record<string, unknown> }>;
  fromJSONCalls: number;
  appliedTo: string[];
}

/** 够用的 dockview api 替身：只实现 restore() 用到的那几处。 */
function fakeApi(name: string, initial: Array<{ id: string; params?: Record<string, unknown> }> = []): FakeApi {
  const api: FakeApi = {
    name,
    panels: [...initial],
    fromJSONCalls: 0,
    appliedTo: [],
    // restore() 用到的
    fromJSON(json: { panels?: Record<string, { id: string; params?: Record<string, unknown> }> }) {
      api.fromJSONCalls += 1;
      api.appliedTo.push(name);
      api.panels = Object.values(json.panels ?? {}).map((p) => ({ id: p.id, params: p.params }));
    },
    getPanel: () => undefined,
    addPanel: () => undefined,
  } as unknown as FakeApi;
  return api;
}

const globals = globalThis as unknown as { __piggyDock?: unknown };
const LAYOUT = {
  panels: {
    'session:old-1': {
      id: 'session:old-1',
      params: { kind: 'session', tabId: 'stale-1', sessionFile: '/tmp/a.jsonl', cwd: '/tmp', title: 'A' },
    },
    'session:old-2': {
      id: 'session:old-2',
      params: { kind: 'session', tabId: 'stale-2', sessionFile: '/tmp/b.jsonl', cwd: '/tmp', title: 'B' },
    },
  },
};

/** 受控 promise：测试自己决定每一步什么时候完成。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let seq = 0;
beforeEach(() => {
  resetBootGateForTest();
  ipcMocks.cmd.mockReset();
  ipcMocks.on.mockReset();
  ipcMocks.on.mockResolvedValue(() => {});
  useTabs.setState({ tabs: {}, order: [], activeTabId: null, unread: {}, banner: null });
});
afterEach(() => {
  globals.__piggyDock = undefined;
});

describe('restore()：布局只能套一次，且必须套在活着的实例上', () => {
  it('恢复途中实例被换掉（StrictMode 卸载重挂）→ 旧的一轮不套用', async () => {
    const apiA = fakeApi('A');
    const apiB = fakeApi('B');
    globals.__piggyDock = apiA;

    const layoutLoad = deferred<{ dockview: typeof LAYOUT }>();
    const tabCreate = deferred<Record<string, unknown>>();
    ipcMocks.cmd.mockImplementation((name: string, args?: Record<string, unknown>) => {
      if (name === 'boot_reset') return Promise.resolve(null);
      if (name === 'layout_load') return layoutLoad.promise;
      if (name === 'tab_create')
        return tabCreate.promise.then(() => {
          // 真机（pi --session <path>）会把**请求的那个文件**原样回报，
          // 所以这里也必须回显请求路径：restore() 会用回报值改写 params.sessionFile，
          // 而第二轮恢复的缓存键就是它。回报成别的路径会让缓存永远不命中（测试假红）。
          const path = String(
            (args as Record<string, unknown> | undefined)?.sessionPath ?? '/tmp/x.jsonl',
          );
          return {
            tab_id: `new-${++seq}`,
            cwd: '/tmp',
            session_id: null,
            session_file: path,
            session_name: null,
            worker_state: 'ready',
            state: {},
          };
        });
      if (name === 'pi_get_messages') return Promise.resolve({ messages: [] });
      return Promise.resolve(null);
    });

    const running = restore();
    await Promise.resolve();
    layoutLoad.resolve({ dockview: LAYOUT });
    await Promise.resolve();
    await Promise.resolve();

    // 关键一刻：恢复还在等 tab_create，实例已经从 A 换成 B
    globals.__piggyDock = apiB;
    tabCreate.resolve({});

    await running;

    // 第 1 轮（target = A）既不能往死实例上套，也不能越权套到新实例上——
    // 后者正是病根：两轮都套 B，第二次清空被当成"用户关标签"。
    expect(apiA.fromJSONCalls).toBe(0);
    expect(apiB.fromJSONCalls).toBe(0);
    expect(useTabs.getState().order.length).toBe(2); // tab 已登记（由第 1 轮建的 worker）

    // 第 2 轮（target = B）：这一轮才该套用，且恰好一次
    await restore();
    expect(apiB.fromJSONCalls).toBe(1);
    expect(apiA.fromJSONCalls).toBe(0);
    expect(useTabs.getState().order.length).toBe(2); // 没有被"自己"关掉
  });

  it('实例没换 → 正常套用一次，且 tab 全部登记', async () => {
    const apiA = fakeApi('A');
    globals.__piggyDock = apiA;

    ipcMocks.cmd.mockImplementation((name: string, args?: Record<string, unknown>) => {
      if (name === 'layout_load') return Promise.resolve({ dockview: LAYOUT });
      if (name === 'tab_create')
        return Promise.resolve({
          tab_id: `solo-${++seq}`,
          cwd: '/tmp',
          session_id: null,
          session_file: String(args?.sessionPath ?? '/tmp/x.jsonl'),
          session_name: null,
          worker_state: 'ready',
          state: {},
        });
      if (name === 'pi_get_messages') return Promise.resolve({ messages: [] });
      return Promise.resolve(null);
    });

    await restore();

    expect(apiA.fromJSONCalls).toBe(1);
    expect(useTabs.getState().order.length).toBe(2);
    // 重映射后的 tabId 与面板 params 一致，且不再是布局里那个 stale 值
    const params = apiA.panels.map((p) => p.params?.tabId as string);
    expect(params.every((t) => t.startsWith('solo-'))).toBe(true);
    expect(params.sort()).toEqual([...useTabs.getState().order].sort());
  });
});
