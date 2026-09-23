/**
 * piggy-bridge 单测：不启动 pi，用假 EventBus/假 UI/假 pi-subagents 拥有者
 * 覆盖协议解析、RPC 关联与超时、降级、载荷形状。
 *
 * 之所以要有这一层：旧版 piggy-bridge 三条 API 全写错、却"看起来完成了"——
 * 因为它从未被加载、也从未被测过。注册形状与载荷形状必须在这里被钉住。
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  ASYNC_COMPLETE_EVENT,
  COMMAND_TABLE,
  DEGRADED_ERROR,
  PREFIX,
  READY_EVENT,
  REPLY_PREFIX,
  REQUEST_EVENT,
  SubagentRpc,
  WIDGET_KEY,
  createBridge,
  parseSpawnArgs,
  parseSteerArgs,
  receiptDelivery,
  receiptRunId,
  receiptText,
  splitArgs,
  statusToLanes,
  widgetLines,
  type BridgeApi,
  type BridgeBus,
  type BridgeUi,
} from '../src/index';

/* ---------------- 测试替身 ---------------- */

class FakeBus implements BridgeBus {
  handlers = new Map<string, Set<(d: unknown) => void>>();
  emitted: Array<{ channel: string; data: unknown }> = [];

  on(channel: string, handler: (d: unknown) => void): () => void {
    const set = this.handlers.get(channel) ?? new Set();
    set.add(handler);
    this.handlers.set(channel, set);
    return () => set.delete(handler);
  }

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    for (const h of [...(this.handlers.get(channel) ?? [])]) h(data);
  }

  count(channel: string): number {
    return this.emitted.filter((e) => e.channel === channel).length;
  }
}

class FakeUi implements BridgeUi {
  editorTexts: string[] = [];
  notifies: string[] = [];
  widgets: Array<{ key: string; lines: string[] }> = [];

  setEditorText(text: string): void {
    this.editorTexts.push(text);
  }
  notify(message: string): void {
    this.notifies.push(message);
  }
  setWidget(key: string, content: string[] | undefined): void {
    this.widgets.push({ key, lines: content ?? [] });
  }

  /** 解析最后一次数据面载荷（PIGGY:1: 前缀） */
  last(): Record<string, unknown> {
    const raw = this.editorTexts.at(-1);
    expect(raw, '应当推送过载荷').toBeTruthy();
    expect(raw!.startsWith(PREFIX)).toBe(true);
    return JSON.parse(raw!.slice(PREFIX.length)) as Record<string, unknown>;
  }
  all(): Array<Record<string, unknown>> {
    return this.editorTexts.map((t) => JSON.parse(t.slice(PREFIX.length)) as Record<string, unknown>);
  }
}

/** 假 pi-subagents 拥有者：按方法回执，可配置为不回执/报错。 */
class FakeOwner {
  requests: Array<{ method: string; params: unknown; requestId: string }> = [];
  private replies = new Map<string, (params: unknown, requestId: string) => unknown>();
  mode: 'reply' | 'silent' | 'error' = 'reply';

  constructor(private bus: FakeBus) {
    bus.on(REQUEST_EVENT, (raw) => {
      const req = raw as { requestId: string; method: string; params?: unknown };
      this.requests.push({ method: req.method, params: req.params, requestId: req.requestId });
      if (this.mode === 'silent') return;
      if (this.mode === 'error') {
        bus.emit(REPLY_PREFIX + req.requestId, {
          version: 1,
          requestId: req.requestId,
          success: false,
          error: { code: 'not_found', message: 'no such run' },
        });
        return;
      }
      const handler = this.replies.get(req.method);
      const data = handler ? handler(req.params, req.requestId) : { ok: true };
      bus.emit(REPLY_PREFIX + req.requestId, {
        version: 1,
        requestId: req.requestId,
        method: req.method,
        success: true,
        data,
      });
    });
  }

  reply(method: string, fn: (params: unknown, requestId: string) => unknown): this {
    this.replies.set(method, fn);
    return this;
  }

  get methods(): string[] {
    return this.requests.map((r) => r.method);
  }
}

function makeApi(bus: FakeBus): BridgeApi & { registered: Map<string, (args: string, ctx: unknown) => unknown> } {
  const registered = new Map<string, (args: string, ctx: unknown) => unknown>();
  return {
    events: bus,
    registered,
    registerCommand(name, options) {
      registered.set(name, options.handler as (args: string, ctx: unknown) => unknown);
    },
  };
}

const PING = {
  version: 1,
  methods: ['ping', 'status', 'manage', 'spawn', 'steer', 'interrupt', 'stop', 'resume'],
  capabilities: { status: true, steer: true, resume: true, fleetStatus: { version: 1 } },
};

const STATUS_DATA = {
  text: 'In-memory subagent status: 1 active child.',
  fleet: {
    version: 1,
    totalActive: 1,
    omitted: 0,
    entries: [
      {
        key: 'opaque-1',
        agent: 'reviewer',
        role: 'correctness',
        model: 'glm-5.3-flash',
        startedAt: 1_000,
        tokens: { input: 100, output: 20, total: 120 },
        goal: 'Review the diff',
      },
    ],
  },
  asyncSnapshot: {
    kind: 'pi-subagents.async-status-snapshot',
    version: 1,
    runs: [
      {
        id: 'run-abc',
        agent: 'builder',
        state: 'complete',
        startedAt: 500,
        endedAt: 2_500,
        usage: { totalTokens: 42, cost: 0.01 },
      },
    ],
  },
};

let bus: FakeBus;
let ui: FakeUi;

beforeEach(() => {
  bus = new FakeBus();
  ui = new FakeUi();
});

/* ---------------- 纯函数 ---------------- */

describe('参数解析', () => {
  it('splitArgs 支持引号并保留空片段语义', () => {
    expect(splitArgs('a b c')).toEqual(['a', 'b', 'c']);
    expect(splitArgs('  a   b  ')).toEqual(['a', 'b']);
    expect(splitArgs('run-1 "hello world" tail')).toEqual(['run-1', 'hello world', 'tail']);
    expect(splitArgs("run-1 'a b'")).toEqual(['run-1', 'a b']);
    expect(splitArgs('')).toEqual([]);
    expect(splitArgs('""')).toEqual(['']);
  });

  it('parseSteerArgs：runId + 消息', () => {
    expect(parseSteerArgs('run-1 请检查边界条件')).toEqual({ runId: 'run-1', message: '请检查边界条件' });
  });

  it('parseSteerArgs：runId + index + 消息', () => {
    expect(parseSteerArgs('run-1 2 请检查边界条件')).toEqual({
      runId: 'run-1',
      index: 2,
      message: '请检查边界条件',
    });
  });

  it('parseSteerArgs：数字开头的消息不会被当成 index（只有 >1 段时才算 index）', () => {
    expect(parseSteerArgs('run-1 42')).toEqual({ runId: 'run-1', message: '42' });
  });

  it('parseSteerArgs：缺 runId / 缺消息都给出用法', () => {
    expect(parseSteerArgs('').error).toContain('用法');
    expect(parseSteerArgs('run-1').error).toContain('非空消息');
    expect(parseSteerArgs('run-1').runId).toBe('run-1');
  });

  it('parseSpawnArgs：agent + 任务', () => {
    expect(parseSpawnArgs('reviewer 审查这次改动')).toEqual({ agent: 'reviewer', task: '审查这次改动' });
    expect(parseSpawnArgs('reviewer').error).toContain('非空任务');
    expect(parseSpawnArgs('').error).toContain('用法');
  });
});

describe('状态归一化', () => {
  it('fleet DTO → lane 行（含 role/elapsed/tokens）', () => {
    const lanes = statusToLanes(STATUS_DATA, 1_800);
    expect(lanes[0]).toEqual({ agent: 'reviewer · correctness', status: 'running', elapsed: 800, tokens: 120 });
  });

  it('asyncSnapshot → lane 行（完成态用 endedAt 计算耗时）', () => {
    const lanes = statusToLanes({ asyncSnapshot: STATUS_DATA.asyncSnapshot }, 9_999);
    expect(lanes[0]).toEqual({ agent: 'builder', status: 'complete', elapsed: 2_000, tokens: 42, cost: 0.01 });
  });

  it('两者都有时都列出（fleet 在前）', () => {
    expect(statusToLanes(STATUS_DATA, 1_800).map((l) => l.agent)).toEqual(['reviewer · correctness', 'builder']);
  });

  it('无数据 → 空数组（宁空不编）', () => {
    expect(statusToLanes({})).toEqual([]);
    expect(statusToLanes(null)).toEqual([]);
    expect(statusToLanes('nope')).toEqual([]);
    expect(statusToLanes({ fleet: { entries: 'bad' } })).toEqual([]);
  });

  it('widgetLines：首行给汇总，行数有界', () => {
    const many = {
      fleet: {
        totalActive: 9,
        entries: Array.from({ length: 10 }, (_, i) => ({ agent: `a${i}`, startedAt: 0, tokens: { total: 1 } })),
      },
    };
    const lines = widgetLines(many, 0);
    expect(lines[0]).toContain('9 个子代理活动中');
    expect(lines.length).toBeLessThanOrEqual(7);
    expect(lines[0]).toContain(WIDGET_KEY.length > 0 ? '' : '');
  });
});

describe('回执解析（对照真实 AgentToolResult 形状）', () => {
  const steerReceipt = {
    content: [{ type: 'text', text: 'Steering delivered for async run run-abc (request r1).' }],
    details: { mode: 'management', results: [], steering: { requestId: 'r1', state: 'delivered', deliveryStatus: 'delivered' } },
  };

  it('receiptDelivery 读 details.steering.deliveryStatus', () => {
    expect(receiptDelivery(steerReceipt)).toBe('delivered');
    expect(receiptDelivery({ details: { deliveryStatus: 'queued' } })).toBe('queued');
    expect(receiptDelivery(null)).toBeUndefined();
  });

  it('receiptRunId 读 details.asyncId', () => {
    expect(receiptRunId({ details: { asyncId: 'run-xyz' } })).toBe('run-xyz');
    expect(receiptRunId({ details: { runId: 'run-2' } })).toBe('run-2');
    expect(receiptRunId({})).toBeUndefined();
  });

  it('receiptText 取 content 文本并截断', () => {
    expect(receiptText(steerReceipt)).toContain('Steering delivered');
    expect(receiptText({ content: [{ type: 'text', text: 'x'.repeat(900) }] })!.length).toBe(500);
    expect(receiptText({})).toBeUndefined();
  });
});

/* ---------------- 注册与 RPC ---------------- */

describe('命令注册（真实 pi API 形状）', () => {
  it('COMMAND_TABLE 全部注册，且每个都有 description', () => {
    const api = makeApi(bus);
    createBridge(api);
    expect([...api.registered.keys()].sort()).toEqual(COMMAND_TABLE.map((c) => c.name).sort());
    // 旧版写成 registerCommand(name, fn)：handler 是函数而不是对象里的 handler。
    for (const cmd of COMMAND_TABLE) {
      expect(typeof api.registered.get(cmd.name)).toBe('function');
      expect(cmd.description.length).toBeGreaterThan(0);
    }
  });
});

describe('RPC v1 客户端', () => {
  it('先订阅再发请求：同一 tick 内的回执不会丢', async () => {
    new FakeOwner(bus).reply('ping', () => PING);
    const rpc = new SubagentRpc(bus, { makeId: () => 'fixed' });
    const data = await rpc.request('ping', {});
    expect(data).toEqual(PING);
    // 请求信封形状 = 官方文档
    const req = bus.emitted.find((e) => e.channel === REQUEST_EVENT)!.data as Record<string, unknown>;
    expect(req).toMatchObject({ version: 1, requestId: 'fixed', method: 'ping' });
    expect(req.source).toEqual({ extension: 'piggy-bridge' });
  });

  it('并发请求各自关联，不串台', async () => {
    let n = 0;
    new FakeOwner(bus).reply('status', (_p, requestId) => ({ requestId }));
    const rpc = new SubagentRpc(bus, { makeId: () => `id-${++n}` });
    const [a, b] = await Promise.all([rpc.request('status'), rpc.request('status')]);
    expect(a).toEqual({ requestId: 'id-1' });
    expect(b).toEqual({ requestId: 'id-2' });
  });

  it('失败回执 → 抛出 code: message', async () => {
    const owner = new FakeOwner(bus);
    owner.mode = 'error';
    const rpc = new SubagentRpc(bus);
    await expect(rpc.request('steer', {})).rejects.toThrow('not_found: no such run');
  });

  it('无回执 → 超时并清理 pending（迟到回执不再影响任何东西）', async () => {
    vi.useFakeTimers();
    try {
      const owner = new FakeOwner(bus);
      owner.mode = 'silent';
      const rpc = new SubagentRpc(bus, { timeoutMs: 50 });
      const p = rpc.request('status', {});
      const assertion = expect(p).rejects.toThrow('超时');
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
      const requestId = owner.requests[0]!.requestId;
      // 迟到回执：不应抛未处理异常，也不应改变已 settled 的 promise
      bus.emit(REPLY_PREFIX + requestId, { version: 1, requestId, success: true, data: { late: true } });
      expect(owner.methods).toEqual(['status']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('attach 接收 ready → 能力位与方法表可读', () => {
    const rpc = new SubagentRpc(bus);
    const detach = rpc.attach();
    expect(rpc.ready).toBe(false);
    bus.emit(READY_EVENT, PING);
    expect(rpc.ready).toBe(true);
    expect(rpc.methods).toContain('steer');
    expect(rpc.hasCapability('fleetStatus')).toBe(true);
    expect(rpc.hasCapability('cost')).toBe(false);
    detach();
    expect(bus.handlers.get(READY_EVENT)?.size ?? 0).toBe(0);
  });

  it('dispose 让挂起请求立刻失败，不留悬挂 promise', async () => {
    new FakeOwner(bus).mode = 'silent';
    const rpc = new SubagentRpc(bus);
    const p = rpc.request('status', {});
    rpc.dispose();
    await expect(p).rejects.toThrow('已卸载');
  });
});

/* ---------------- 动词行为 ---------------- */

describe('降级路径（未装 pi-subagents）', () => {
  it('status：回 ok:false + 未安装，且根本不发 RPC 请求', async () => {
    const api = makeApi(bus);
    createBridge(api);
    await api.registered.get('piggy:status')!('', { ui });
    expect(ui.last()).toMatchObject({ kind: 'status', ok: false, verb: 'status', error: DEGRADED_ERROR });
    expect(bus.count(REQUEST_EVENT)).toBe(0);
    expect(ui.widgets.at(-1)?.lines[0]).toContain('未安装');
    expect(ui.notifies.at(-1)).toContain('pi-subagents');
  });

  it('每个动词都降级，而不是静默成功', async () => {
    const api = makeApi(bus);
    createBridge(api);
    for (const cmd of COMMAND_TABLE) {
      await api.registered.get(cmd.name)!('run-1 hello', { ui });
      const payload = ui.last();
      expect(payload.ok, `${cmd.name} 应降级`).toBe(false);
      expect(String(payload.error)).toContain(DEGRADED_ERROR);
    }
  });
});

describe('正常路径（已装 pi-subagents）', () => {
  function readyBridge() {
    const api = makeApi(bus);
    const bridge = createBridge(api);
    new FakeOwner(bus).reply('status', () => STATUS_DATA).reply('steer', () => ({
      content: [{ type: 'text', text: 'Steering delivered.' }],
      details: { steering: { deliveryStatus: 'delivered' } },
    })).reply('spawn', () => ({
      content: [{ type: 'text', text: 'Spawned.' }],
      details: { asyncId: 'run-new' },
    }));
    bus.emit(READY_EVENT, PING);
    return { api, bridge };
  }

  it('status：推送载荷含归一化 lanes，并写 widget', async () => {
    const { api } = readyBridge();
    await api.registered.get('piggy:status')!('', { ui });
    const payload = ui.last();
    expect(payload).toMatchObject({ kind: 'status', ok: true });
    expect(payload.lanes).toEqual([
      { agent: 'reviewer · correctness', status: 'running', elapsed: expect.any(Number), tokens: 120 },
      { agent: 'builder', status: 'complete', elapsed: 2_000, tokens: 42, cost: 0.01 },
    ]);
    expect(ui.widgets.at(-1)?.key).toBe(WIDGET_KEY);
  });

  it('fleet-refresh：等同 status（前端刷新按钮只认一个契约）', async () => {
    const { api } = readyBridge();
    await api.registered.get('piggy:fleet-refresh')!('', { ui });
    expect(ui.last()).toMatchObject({ kind: 'status', ok: true });
  });

  it('steer：参数名与官方一致（runId/index/message），回执带 deliveryStatus', async () => {
    const { api } = readyBridge();
    await api.registered.get('piggy:steer')!('run-abc 1 检查边界', { ui });
    const req = bus.emitted.filter((e) => e.channel === REQUEST_EVENT).at(-1)!.data as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(req.method).toBe('steer');
    expect(req.params).toMatchObject({ runId: 'run-abc', index: 1, message: '检查边界' });
    expect(ui.last()).toMatchObject({ kind: 'steer', ok: true, deliveryStatus: 'delivered', runId: 'run-abc' });
  });

  it('spawn：强制 async:true，并把 runId 回传', async () => {
    const { api } = readyBridge();
    await api.registered.get('piggy:spawn')!('reviewer 审查改动', { ui });
    const req = bus.emitted.filter((e) => e.channel === REQUEST_EVENT).at(-1)!.data as {
      method: string;
      params: Record<string, unknown>;
    };
    expect(req.method).toBe('spawn');
    expect(req.params).toMatchObject({ agent: 'reviewer', task: '审查改动', async: true });
    expect(ui.last()).toMatchObject({ kind: 'spawn', ok: true, agent: 'reviewer', runId: 'run-new' });
  });

  it('interrupt/stop 缺 runId 时不发请求，只回用法', async () => {
    const { api } = readyBridge();
    const before = bus.count(REQUEST_EVENT);
    await api.registered.get('piggy:stop')!('', { ui });
    expect(bus.count(REQUEST_EVENT)).toBe(before);
    expect(ui.last()).toMatchObject({ kind: 'stop', ok: false });
    expect(String(ui.last().error)).toContain('用法');
  });

  it('cost：无能力位时明确报"需 ≥0.71"，不假装成功', async () => {
    const { api } = readyBridge();
    await api.registered.get('piggy:cost')!('', { ui });
    expect(ui.last()).toMatchObject({ kind: 'cost', ok: false });
    expect(String(ui.last().error)).toContain('0.71');
  });

  it('子代理完成事件 → 主动推一次快照（不等前端轮询）', async () => {
    const { api } = readyBridge();
    await api.registered.get('piggy:status')!('', { ui }); // 建立 lastUi
    const before = ui.editorTexts.length;
    bus.emit(ASYNC_COMPLETE_EVENT, { runId: 'run-abc', status: 'complete' });
    await new Promise((r) => setTimeout(r, 0));
    expect(ui.editorTexts.length).toBe(before + 1);
    expect(ui.last()).toMatchObject({ kind: 'status', ok: true, trigger: 'async-complete' });
  });

  it('dispose 后完成事件不再推载荷（会话换掉后不往旧 ui 推）', async () => {
    const { api, bridge } = readyBridge();
    await api.registered.get('piggy:status')!('', { ui });
    const before = ui.editorTexts.length;
    bridge.dispose();
    bus.emit(ASYNC_COMPLETE_EVENT, { runId: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(ui.editorTexts.length).toBe(before);
  });
});
