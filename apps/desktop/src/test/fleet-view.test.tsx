// @vitest-environment jsdom
/**
 * FleetView 测试（docs/06 §5，M3）：A 层 lane 控制（steer / 提升为标签页）+ B 层刷新与降级。
 *
 * 为什么要单独测这层：docs/09 §5.1 曾把 steer/提升/刷新记为"✅ 已实现"，
 * 而视图在事故重建后**只有启动和中止两个按钮**——文档与代码脱节时，
 * 唯一能说话的是断言。这里把每个按钮真的点一遍，并检查它发出的 IPC 参数名。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/features/workspace/EditorArea', () => ({ openSessionTab: vi.fn() }));

import { FleetView } from '@/features/workspace/FleetView';
import { openSessionTab } from '@/features/workspace/EditorArea';
import { useFleet } from '@/stores/fleet';
import { useTabs } from '@/stores/tabs';
import { mountDom, unmountDom, domContainer } from './dom-render';

const RUN = {
  id: 'run-1',
  templateId: 'parallel-review',
  task: '评审这次改动',
  cwd: '/proj',
  status: 'running' as const,
  lanes: [
    { key: 'r-correctness', role: '评审·正确性', status: 'running' as const, tabId: 'tab-lane-1' },
    { key: 'r-tests', role: '评审·测试', status: 'settled' as const, tabId: 'tab-lane-2', resultPreview: '结论' },
  ],
};

function setup() {
  useFleet.setState({
    runs: { [RUN.id]: RUN },
    order: [RUN.id],
    bridge: { installed: null, byTab: {} },
  });
  useTabs.setState({
    tabs: {
      'tab-1': {
        tabId: 'tab-1',
        cwd: '/proj',
        sessionFile: null,
        sessionId: null,
        sessionName: '会话',
        workerState: 'ready',
      },
    } as never,
    order: ['tab-1'],
    activeTabId: 'tab-1',
    unread: {},
    banner: null,
  });
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (name: string) => {
    if (name === 'fleet_templates') {
      return { 'parallel-review': { label: '并行评审' }, 'scout-review-build': { label: '侦察' } };
    }
    if (name === 'fleet_steer') return true;
    if (name === 'fleet_open_lane') {
      return {
        tab_id: 'tab-lane-1',
        cwd: '/proj',
        session_id: null,
        session_file: null,
        session_name: null,
        worker_state: 'ready',
        state: {},
      };
    }
    if (name === 'pi_prompt') return true;
    if (name === 'fleet_start') return 'run-new';
    return {};
  });
}

function calls(name: string): Array<Record<string, unknown>> {
  return invokeMock.mock.calls.filter((c) => c[0] === name).map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

/** 找到含指定文本的按钮（jsdom 里没有 testing-library，手写一个够用的）。 */
function buttonByText(text: string): HTMLButtonElement {
  const btn = [...domContainer().querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text));
  if (!btn) throw new Error(`找不到按钮: ${text}`);
  return btn as HTMLButtonElement;
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

/** React 受控 input 需要走原生 setter 才能触发 onChange */
async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function pressEnter(input: HTMLInputElement) {
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe('FleetView', () => {
  beforeEach(setup);
  afterEach(async () => {
    await unmountDom();
    useFleet.setState({ runs: {}, order: [], bridge: { installed: null, byTab: {} } });
  });

  it('只给运行中的 lane 显示 steer 输入框（已完成的 lane 不该还能追加指令）', async () => {
    mountDom(<FleetView tabId="tab-1" />);
    await act(async () => {});
    const inputs = [...domContainer().querySelectorAll('.pg-fleet-steer input')];
    expect(inputs).toHaveLength(1);
    expect(domContainer().querySelectorAll('.pg-fleet-lane-block')).toHaveLength(2);
  });

  it('steer：回车发出 fleet_steer(runId, laneKey, message) 并清空输入', async () => {
    mountDom(<FleetView tabId="tab-1" />);
    await act(async () => {});
    const input = domContainer().querySelector('.pg-fleet-steer input') as HTMLInputElement;
    await type(input, '只看边界条件');
    await pressEnter(input);
    expect(calls('fleet_steer')).toEqual([
      { runId: 'run-1', laneKey: 'r-correctness', message: '只看边界条件' },
    ]);
    expect((domContainer().querySelector('.pg-fleet-steer input') as HTMLInputElement).value).toBe('');
  });

  it('steer：空消息不发请求（按钮禁用）', async () => {
    mountDom(<FleetView tabId="tab-1" />);
    await act(async () => {});
    const btn = buttonByText('发送');
    expect(btn.disabled).toBe(true);
    await click(btn);
    expect(calls('fleet_steer')).toHaveLength(0);
  });

  it('提升为标签页：fleet_open_lane → openSessionTab(snapshot, 标题)', async () => {
    mountDom(<FleetView tabId="tab-1" />);
    await act(async () => {});
    const open = domContainer().querySelector('.pg-fleet-lane-open')!;
    await click(open);
    expect(calls('fleet_open_lane')).toEqual([{ runId: 'run-1', laneKey: 'r-correctness' }]);
    expect(vi.mocked(openSessionTab)).toHaveBeenCalledTimes(1);
    const [snap, title] = vi.mocked(openSessionTab).mock.calls[0]!;
    expect((snap as { tab_id: string }).tab_id).toBe('tab-lane-1');
    expect(String(title)).toContain('评审·正确性');
  });

  it('B 层刷新：向活动会话发 /piggy:status（扩展命令，不经模型）', async () => {
    mountDom(<FleetView tabId="tab-1" />);
    await act(async () => {});
    await click(domContainer().querySelector('.pg-fleet-refresh')!);
    expect(calls('pi_prompt')).toEqual([{ tabId: 'tab-1', message: '/piggy:status' }]);
  });

  it('B 层没有活动会话时刷新禁用', async () => {
    mountDom(<FleetView tabId={null} />);
    await act(async () => {});
    expect((domContainer().querySelector('.pg-fleet-refresh') as HTMLButtonElement).disabled).toBe(true);
  });

  it('B 层未安装：显示降级提示，而不是"无活动"', async () => {
    useFleet.setState({ bridge: { installed: false, byTab: {} } });
    mountDom(<FleetView tabId="tab-1" />);
    await act(async () => {});
    const text = domContainer().textContent ?? '';
    expect(text).toContain('未安装');
    expect(text).not.toContain('当前会话无子代理活动');
  });

  it('B 层有快照：渲染 lane 行（agent/状态/耗时/token）', async () => {
    useFleet.setState({
      bridge: {
        installed: true,
        byTab: {
          'tab-1': {
            fetchedAt: Date.now() - 3_000,
            lanes: [{ agent: 'reviewer · correctness', status: 'running', elapsed: 4_200, tokens: 1_280 }],
            raw: {},
          },
        },
      },
    });
    mountDom(<FleetView tabId="tab-1" />);
    await act(async () => {});
    const text = domContainer().textContent ?? '';
    expect(text).toContain('reviewer · correctness');
    expect(text).toContain('4.2s');
    expect(text).toContain('1280 tok');
  });

  it('启动编排：fleet_start 收到 camelCase 参数（与 Tauri 命令签名一致）', async () => {
    mountDom(<FleetView tabId="tab-1" />);
    await act(async () => {});
    const textarea = domContainer().querySelector('.pg-fleet-task') as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, '检查依赖');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(buttonByText('启动 Fleet'));
    expect(calls('fleet_start')).toEqual([
      { templateId: 'parallel-review', task: '检查依赖', cwd: '/proj' },
    ]);
  });
});
