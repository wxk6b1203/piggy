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
