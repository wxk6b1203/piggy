/** fleetStore 测试（M3）：快照应用、bridge 载荷解析、降级语义 */
import { describe, expect, it, beforeEach } from 'vitest';
import { useFleet, parseBridgePayload, BRIDGE_PREFIX } from '@/stores/fleet';

function reset() {
  useFleet.setState({ runs: {}, order: [], bridge: { installed: null, byTab: {} } });
}

describe('parseBridgePayload（PIGGY:1 协议）', () => {
  it('解析合法载荷', () => {
    const data = { kind: 'status', ok: true, status: { lanes: [{ agent: 'reviewer' }] } };
    const parsed = parseBridgePayload(BRIDGE_PREFIX + JSON.stringify(data));
    expect(parsed).toEqual(data);
  });

  it('非 PIGGY 前缀返回 null（普通 set_editor_text 不受劫持）', () => {
    expect(parseBridgePayload('普通草稿文本')).toBeNull();
    expect(parseBridgePayload('PIGGY:2:{"x":1}')).toBeNull();
    expect(parseBridgePayload(42)).toBeNull();
    expect(parseBridgePayload(undefined)).toBeNull();
  });

  it('坏 JSON 返回 null', () => {
    expect(parseBridgePayload(BRIDGE_PREFIX + '{oops')).toBeNull();
  });
});

describe('fleetStore', () => {
  beforeEach(reset);

  it('applySnapshot：A 层 runs 全量替换', () => {
    useFleet.getState().applySnapshot({
      runs: [
        {
          id: 'r1',
          templateId: 'parallel-review',
          task: '评审',
          cwd: '/tmp',
          status: 'running',
          lanes: [{ key: 'r1', role: '评审', status: 'running', tabId: 't1' }],
        },
      ],
    });
    expect(useFleet.getState().order).toEqual(['r1']);
    expect(useFleet.getState().runs['r1']!.lanes[0]!.status).toBe('running');
  });

  it('applyBridgePayload：status 快照写入 byTab 且标记已安装', () => {
    const ok = useFleet.getState().applyBridgePayload('tab-1', BRIDGE_PREFIX + JSON.stringify({
      kind: 'status',
      ok: true,
      status: { lanes: [{ agent: 'scout', status: 'running', tokens: 12 }] },
    }));
    expect(ok).toBe(true);
    const s = useFleet.getState();
    expect(s.bridge.installed).toBe(true);
    expect(s.bridge.byTab['tab-1']!.lanes[0]!.agent).toBe('scout');
  });

  it('applyBridgePayload：真实载荷（顶层 lanes）——shape 取自真 pi + 真 pi-subagents 的实测回传', () => {
    // 这份 JSON 是 2026-09-23 用 `pi --mode rpc -e resources/piggy-bridge.js` 发
    // `/piggy:spawn scout …` 后抓到的真实 set_editor_text 载荷（只截去了 goal/children 等长字段）。
    // 用它当 fixture 的理由：早期版本只读 `status.lanes`，而 bridge 实际把归一化后的
    // lanes 放在**顶层** → 真机上载荷到了、面板却永远空白。
    const realPayload = {
      kind: 'status',
      ok: true,
      status: {
        text: 'In-memory subagent status: 0 active children.',
        fleet: { version: 1, entries: [], totalActive: 0, omitted: 0 },
        asyncSnapshot: {
          kind: 'pi-subagents.async-status-snapshot',
          version: 1,
          runs: [
            {
              id: '79e82804-25ca-4919-8916-55f367d051a6',
              kind: 'subagent',
              label: 'scout',
              state: 'failed',
              startedAt: 1790162648277,
              endedAt: 1790162653301,
            },
          ],
        },
      },
      lanes: [{ agent: 'scout', status: 'failed', elapsed: 5024 }],
      trigger: 'async-complete',
    };
    expect(useFleet.getState().applyBridgePayload('tab-real', BRIDGE_PREFIX + JSON.stringify(realPayload))).toBe(
      true,
    );
    const snap = useFleet.getState().bridge.byTab['tab-real']!;
    expect(snap.lanes).toEqual([{ agent: 'scout', status: 'failed', elapsed: 5024 }]);
    // raw 保留 RPC 原状态，供后续字段扩展（例如成本、容量）
    expect((snap.raw as { asyncSnapshot?: unknown }).asyncSnapshot).toBeTruthy();
  });

  it('applyBridgePayload：未安装降级', () => {
    const ok = useFleet.getState().applyBridgePayload('tab-2', BRIDGE_PREFIX + JSON.stringify({
      kind: 'status',
      ok: false,
      error: 'pi-subagents 未安装',
    }));
    expect(ok).toBe(true);
    const s = useFleet.getState();
    expect(s.bridge.installed).toBe(false);
    expect(s.bridge.byTab['tab-2']!.lanes).toHaveLength(0);
  });

  it('applyBridgePayload：普通文本不进入协议分支', () => {
    expect(useFleet.getState().applyBridgePayload('tab-3', 'hello')).toBe(false);
    expect(useFleet.getState().bridge.installed).toBeNull();
  });
});
