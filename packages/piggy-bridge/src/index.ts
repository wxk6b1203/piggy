/**
 * piggy-bridge v1（docs/06 §4，M3 B 层）：pi 扩展，把 pi-subagents 的**会话内**子代理
 * 接入 Piggy Fleet 面板。
 *
 * ## 通道（docs/06 §4.2）
 * - GUI → bridge：`prompt` 发送 `/piggy:<verb> [args]`。pi 保证扩展命令**流式中也立即执行**，
 *   所以「agent 正在跑时查舰队状态」不需要等回合结束。
 * - bridge → GUI：`ctx.ui.setEditorText("PIGGY:1:" + json)` 数据面（前端 DialogRouter 劫持解析，
 *   不落到真实草稿）+ `ctx.ui.setWidget(key, lines)` 舰队状态行 + `ctx.ui.notify` 人读摘要。
 *
 * ## 为什么不用 `pi.sendMessage` 回传数据
 * 那会把桥接数据写进会话、污染上下文、按 token 计费（docs/06 §4.2 已论证）。
 *
 * ## API 依据（均核对自本机实物，不是推测）
 * - pi 0.87.1 `dist/core/extensions/types.d.ts`：
 *   `registerCommand(name, { description?, handler })` 是**对象形参**（不是 `(name, fn)`）；
 *   UI 在 `ctx.ui` 上（`setEditorText` / `setWidget(key, content, options)` / `notify`）；
 *   跨扩展通道是 `pi.events: EventBus { on(channel, handler), emit(channel, data) }`。
 *   —— 2026-09-23 的旧版实现这三处全写错了，且从未被加载过，所以从未暴露。
 * - pi-subagents 0.70.1 `src/extension/rpc.d.ts` + `docs/extension-api.md`：
 *   `subagents:rpc:v1:ready` / `:request` / `:reply:<requestId>`，信封
 *   `{version:1, requestId, method, params}` → `{version, requestId, method?, success, data|error}`。
 *   方法 `ping|status|manage|spawn|steer|interrupt|stop|resume`（`cost` 需 0.71+，
 *   故按能力位 `ping.capabilities.cost` 门控，不硬编码版本号）。
 * - 参数名（`src/extension/rpc.js::steerParams/spawnParams/resumeParams/stopAsyncRun`）：
 *   目标一律接受 `id` 或 `runId`；`steer`/`resume` 必须有非空 `message`；
 *   `spawn` **只支持 async**（`async:false` 会被拒），且不接受 management action。
 * - 回执形状（`executeChecked` → `AgentToolResult`）：数据在 `data.details`
 *   （steer 的投递状态在 `details.steering.deliveryStatus`，async 运行 id 在 `details.asyncId`）。
 *
 * 本文件只依赖上述文档化缝，不 import pi-subagents 任何内部模块（docs/06 §4.5：
 * 官方缝之外的一切视为私有 API；何况两个包各自安装，运行时本来也无法可靠解析）。
 */
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';

/* ---------------- 协议常量（与前端 stores/fleet.ts 的 BRIDGE_PREFIX 对齐） ---------------- */

export const PREFIX = 'PIGGY:1:';
export const RPC_VERSION = 1;
export const READY_EVENT = 'subagents:rpc:v1:ready';
export const REQUEST_EVENT = 'subagents:rpc:v1:request';
export const REPLY_PREFIX = 'subagents:rpc:v1:reply:';
/** pi-subagents 子代理完成事件（`src/shared/types.js::SUBAGENT_ASYNC_COMPLETE_EVENT`） */
export const ASYNC_COMPLETE_EVENT = 'subagent:async-complete';
/** widget 槽位 key（pi 的 setWidget 第一参数是 key，不是内容） */
export const WIDGET_KEY = 'piggy-fleet';

const DEFAULT_TIMEOUT_MS = 15_000;

/* ---------------- 最小 API 形状（便于单测注入假实现；真实类型见文件头依据） ---------------- */

export interface BridgeUi {
  setEditorText(text: string): void;
  notify(message: string, type?: 'info' | 'warning' | 'error' | 'success'): void;
  setWidget?(key: string, content: string[] | undefined, options?: unknown): void;
}

export interface BridgeBus {
  on(channel: string, handler: (data: unknown) => void): (() => void) | void;
  emit(channel: string, data: unknown): void;
}

export interface BridgeContext {
  ui: BridgeUi;
}

export interface BridgeApi {
  events: BridgeBus;
  registerCommand(
    name: string,
    options: { description?: string; handler: (args: string, ctx: BridgeContext) => Promise<void> | void },
  ): void;
}

/* ---------------- 纯函数：载荷与参数解析（可单测） ---------------- */

export function encodePayload(payload: unknown): string {
  return PREFIX + JSON.stringify(payload);
}

/** 空白切分，但支持 "双引号" 与 '单引号' 包住含空格的片段。 */
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of args) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}

export interface SteerArgs {
  runId?: string;
  index?: number;
  message: string;
  error?: string;
}

/** `/piggy:steer <runId> [index] <message...>` */
export function parseSteerArgs(args: string): SteerArgs {
  const parts = splitArgs(args);
  const runId = parts[0];
  if (!runId) return { message: '', error: '用法：/piggy:steer <runId> [index] <消息>' };
  const rest = parts.slice(1);
  let index: number | undefined;
  if (rest.length > 1 && /^\d+$/.test(rest[0] ?? '')) {
    index = Number(rest[0]);
    rest.shift();
  }
  const message = rest.join(' ').trim();
  if (!message) return { runId, message: '', error: 'steer 需要非空消息' };
  return index === undefined ? { runId, message } : { runId, index, message };
}

/** `/piggy:spawn <agent> <task...>` —— 用户直接派发子代理，不必等模型决定调用 subagent 工具。 */
export function parseSpawnArgs(args: string): { agent?: string; task: string; error?: string } {
  const parts = splitArgs(args);
  const agent = parts[0];
  if (!agent) return { task: '', error: '用法：/piggy:spawn <agent> <任务>' };
  const task = parts.slice(1).join(' ').trim();
  if (!task) return { agent, task: '', error: 'spawn 需要非空任务描述' };
  return { agent, task };
}

export interface BridgeLane {
  agent?: string;
  status?: string;
  elapsed?: number;
  tokens?: number;
  cost?: number;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

/** RPC 回执（`AgentToolResult`）→ 可读文本；也是 bridge 摘要的来源。 */
export function receiptText(receipt: unknown): string | undefined {
  const content = asRecord(receipt)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((b) => str(asRecord(b)?.text))
    .filter((t): t is string => Boolean(t))
    .join('\n')
    .trim();
  return text ? text.slice(0, 500) : undefined;
}

/** 异步运行的 id：`details.asyncId`（stop/steer/resume 的合法目标）。 */
export function receiptRunId(receipt: unknown): string | undefined {
  const details = asRecord(asRecord(receipt)?.details);
  return str(details?.asyncId) ?? str(details?.runId);
}

/** steer 投递状态：`details.steering.deliveryStatus`（delivered|queued|scheduled|recovered）。 */
export function receiptDelivery(receipt: unknown): string | undefined {
  const details = asRecord(asRecord(receipt)?.details);
  const steering = asRecord(details?.steering);
  return str(steering?.deliveryStatus) ?? str(details?.deliveryStatus);
}

/**
 * RPC `status` 应答 → Fleet 面板的 lane 行。
 *
 * 优先用文档化的 fleet DTO（`data.fleet.entries`，字段定义明确：opaque `key`、`agent`、
 * 可选 `role`/`model`、`startedAt`、`tokens{input,output,total}`、`goal`）；缺失时退回
 * `data.asyncSnapshot.runs`（状态机名已归一化为 queued|running|complete|failed|partial|paused|
 * stopped|rejected）。两者都没有则返回空数组——前端呈现「当前会话无子代理活动」。
 * **宁可空也不编**：编出来的 lane 行会让用户以为子代理在跑。
 */
export function statusToLanes(status: unknown, now = Date.now()): BridgeLane[] {
  const data = asRecord(status);
  if (!data) return [];
  const lanes: BridgeLane[] = [];
  const entries = asRecord(data.fleet)?.entries;
  if (Array.isArray(entries)) {
    for (const raw of entries) {
      const e = asRecord(raw);
      if (!e) continue;
      const agent = str(e.agent) ?? 'subagent';
      const role = str(e.role);
      const startedAt = num(e.startedAt);
      const tokens = asRecord(e.tokens);
      const total = num(tokens?.total);
      lanes.push({
        agent: role ? `${agent} · ${role}` : agent,
        status: 'running',
        ...(startedAt !== undefined ? { elapsed: Math.max(0, now - startedAt) } : {}),
        ...(total !== undefined ? { tokens: total } : {}),
      });
    }
  }
  const runs = asRecord(data.asyncSnapshot)?.runs;
  if (Array.isArray(runs)) {
    for (const raw of runs) {
      const r = asRecord(raw);
      if (!r) continue;
      const startedAt = num(r.startedAt);
      const endedAt = num(r.endedAt);
      const usage = asRecord(r.usage);
      const tokens = num(usage?.totalTokens) ?? num(usage?.total);
      const cost = num(usage?.cost);
      lanes.push({
        agent: str(r.agent) ?? str(r.label) ?? str(r.kind) ?? 'subagent',
        status: str(r.state) ?? str(r.status) ?? 'unknown',
        ...(startedAt !== undefined ? { elapsed: Math.max(0, (endedAt ?? now) - startedAt) } : {}),
        ...(tokens !== undefined ? { tokens } : {}),
        ...(cost !== undefined ? { cost } : {}),
      });
    }
  }
  return lanes;
}

/** 舰队状态行（人读、有界；widget 区一行一条）。 */
export function widgetLines(status: unknown, now = Date.now()): string[] {
  const data = asRecord(status);
  if (!data) return ['fleet: 无数据'];
  const totalActive = num(asRecord(data.fleet)?.totalActive) ?? 0;
  const lanes = statusToLanes(status, now);
  return [
    `fleet: ${totalActive} 个子代理活动中 · ${lanes.length} 条可见`,
    ...lanes.slice(0, 6).map((l) => `fleet·lane: ${l.agent ?? '?'} · ${l.status ?? '?'}`),
  ];
}

/* ---------------- RPC v1 客户端（依赖注入，可单测） ---------------- */

interface Pending {
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  off: (() => void) | void;
}

export interface RpcOptions {
  timeoutMs?: number;
  makeId?: () => string;
}

/**
 * pi-subagents in-process RPC v1 客户端。
 *
 * 关键点：**先订阅 reply 频道再 emit request**（官方文档示例即此顺序）——反过来会丢回执。
 * 每次请求独立订阅，拿到回执或超时后立刻退订，免得频道在长会话里越积越多。
 */
export class SubagentRpc {
  ready = false;
  ping: Record<string, unknown> | null = null;
  private pending = new Map<string, Pending>();
  private readonly timeoutMs: number;
  private readonly makeId: () => string;

  constructor(
    private readonly bus: BridgeBus,
    options: RpcOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
  }

  get capabilities(): Record<string, unknown> {
    return asRecord(this.ping?.capabilities) ?? {};
  }

  /** 能力位查询（如 `cost` 只有 pi-subagents ≥0.71 才声明）。 */
  hasCapability(name: string): boolean {
    return this.capabilities[name] !== undefined;
  }

  get methods(): string[] {
    const m = this.ping?.methods;
    return Array.isArray(m) ? m.filter((x): x is string => typeof x === 'string') : [];
  }

  /** 订阅 ready（能力协商）与子代理完成事件；返回退订函数。 */
  attach(onAsyncComplete?: (data: unknown) => void): () => void {
    const offReady = this.bus.on(READY_EVENT, (data) => {
      this.ping = asRecord(data) ?? {};
      this.ready = true;
    });
    const offComplete = onAsyncComplete ? this.bus.on(ASYNC_COMPLETE_EVENT, onAsyncComplete) : undefined;
    return () => {
      if (typeof offReady === 'function') offReady();
      if (typeof offComplete === 'function') offComplete();
    };
  }

  request(method: string, params: unknown = {}, timeoutMs = this.timeoutMs): Promise<unknown> {
    const requestId = this.makeId();
    return new Promise<unknown>((resolve, reject) => {
      const finish = (fn: () => void) => {
        const p = this.pending.get(requestId);
        if (!p) return;
        clearTimeout(p.timer);
        if (typeof p.off === 'function') p.off();
        this.pending.delete(requestId);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`RPC ${method} 超时（${timeoutMs}ms 无回执）`)));
      }, timeoutMs);
      const off = this.bus.on(REPLY_PREFIX + requestId, (raw) => {
        const reply = asRecord(raw);
        if (!reply) return;
        finish(() => {
          if (reply.success === true) {
            resolve(reply.data);
            return;
          }
          const err = asRecord(reply.error);
          reject(new Error(`${str(err?.code) ?? 'rpc_error'}: ${str(err?.message) ?? '未知错误'}`));
        });
      });
      this.pending.set(requestId, { reject, timer, off });
      this.bus.emit(REQUEST_EVENT, {
        version: RPC_VERSION,
        requestId,
        method,
        params,
        source: { extension: 'piggy-bridge' },
      });
    });
  }

  dispose(): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (typeof p.off === 'function') p.off();
      p.reject(new Error('piggy-bridge 已卸载'));
    }
    this.pending.clear();
  }
}

/* ---------------- 命令表（单一事实来源：注册与测试都读它） ---------------- */

export const COMMAND_TABLE = [
  { name: 'piggy:status', verb: 'status', description: '把会话内子代理舰队快照同步到 Fleet 面板' },
  { name: 'piggy:spawn', verb: 'spawn', description: '派发一个会话内子代理：/piggy:spawn <agent> <任务>' },
  { name: 'piggy:steer', verb: 'steer', description: '给运行中的子代理追加指令：/piggy:steer <runId> [index] <消息>' },
  { name: 'piggy:interrupt', verb: 'interrupt', description: '中断子代理当前回合：/piggy:interrupt <runId>' },
  { name: 'piggy:stop', verb: 'stop', description: '停止后台子代理运行：/piggy:stop <runId>' },
  { name: 'piggy:resume', verb: 'resume', description: '续跑已停止的子代理：/piggy:resume <runId> <消息>' },
  { name: 'piggy:cost', verb: 'cost', description: '子代理成本/用量报告（需 pi-subagents ≥0.71）' },
  { name: 'piggy:fleet-refresh', verb: 'fleet-refresh', description: '刷新舰队快照（status 的别名，供面板刷新按钮用）' },
] as const;

export type BridgeVerb = (typeof COMMAND_TABLE)[number]['verb'];

/* ---------------- 动词执行体 ---------------- */

function emit(ui: BridgeUi, payload: Record<string, unknown>, humanSummary?: string): void {
  ui.setEditorText(encodePayload(payload));
  if (humanSummary) ui.notify(humanSummary, 'info');
}

function setWidget(ui: BridgeUi, lines: string[]): void {
  ui.setWidget?.(WIDGET_KEY, lines);
}

export const DEGRADED_ERROR = 'pi-subagents 未安装';

/**
 * 未装 pi-subagents（或未收到 ready）时的降级。
 * 必须逐动词回一个 `ok:false` 载荷：前端据此把 Fleet 面板切到「未安装」态，
 * 而不是永远转圈等一个不会来的快照。
 */
function degraded(ui: BridgeUi, verb: BridgeVerb, kind: string): void {
  emit(
    ui,
    { kind, ok: false, verb, error: DEGRADED_ERROR },
    '未检测到 pi-subagents（安装后重启 pi：pi install npm:pi-subagents）',
  );
  setWidget(ui, ['fleet: pi-subagents 未安装', 'fleet: 安装后本行显示舰队状态']);
}

/**
 * 一个动词的执行体：解析参数 → RPC → 回传载荷。
 * 全部经注入的 ui/rpc，故单测可以直接喂假实现（`index.test.ts`）。
 */
export async function runVerb(verb: BridgeVerb, args: string, ui: BridgeUi, rpc: SubagentRpc): Promise<void> {
  const kind = verb === 'fleet-refresh' ? 'status' : verb;
  if (!rpc.ready) return degraded(ui, verb, kind);

  switch (verb) {
    case 'status':
    case 'fleet-refresh': {
      try {
        const status = await rpc.request('status', {});
        setWidget(ui, widgetLines(status));
        const lanes = statusToLanes(status);
        emit(ui, { kind: 'status', ok: true, status, lanes }, `舰队已同步（${lanes.length} 条可见）`);
      } catch (e) {
        emit(ui, { kind: 'status', ok: false, verb, error: String(e) }, `status 失败：${String(e)}`);
      }
      return;
    }
    case 'spawn': {
      const parsed = parseSpawnArgs(args);
      if (parsed.error) {
        emit(ui, { kind: 'spawn', ok: false, verb, error: parsed.error }, parsed.error);
        return;
      }
      try {
        // spawn 只支持 detached async：pi-subagents 明确拒绝 async:false。
        const receipt = await rpc.request('spawn', { agent: parsed.agent, task: parsed.task, async: true });
        const runId = receiptRunId(receipt);
        emit(
          ui,
          {
            kind: 'spawn',
            ok: true,
            agent: parsed.agent,
            ...(runId ? { runId } : {}),
            receiptText: receiptText(receipt),
            receipt,
          },
          `已派发子代理 ${parsed.agent}${runId ? `（run ${runId}）` : ''}`,
        );
      } catch (e) {
        emit(ui, { kind: 'spawn', ok: false, verb, error: String(e) }, `派发失败：${String(e)}`);
      }
      return;
    }
    case 'steer': {
      const parsed = parseSteerArgs(args);
      if (parsed.error) {
        emit(ui, { kind: 'steer', ok: false, verb, error: parsed.error, runId: parsed.runId }, parsed.error);
        return;
      }
      const params: Record<string, unknown> = { runId: parsed.runId, message: parsed.message };
      if (parsed.index !== undefined) params.index = parsed.index;
      try {
        const receipt = await rpc.request('steer', params);
        const delivery = receiptDelivery(receipt) ?? 'unknown';
        emit(
          ui,
          {
            kind: 'steer',
            ok: true,
            runId: parsed.runId,
            deliveryStatus: delivery,
            receiptText: receiptText(receipt),
            receipt,
          },
          `steer 已送达（${delivery}）`,
        );
      } catch (e) {
        emit(ui, { kind: 'steer', ok: false, verb, runId: parsed.runId, error: String(e) }, `steer 失败：${String(e)}`);
      }
      return;
    }
    case 'interrupt':
    case 'stop': {
      const runId = splitArgs(args)[0];
      if (!runId) {
        const usage = `用法：/piggy:${verb} <runId>`;
        emit(ui, { kind: verb, ok: false, verb, error: usage }, usage);
        return;
      }
      try {
        const receipt = await rpc.request(verb, { runId });
        emit(
          ui,
          { kind: verb, ok: true, runId, receiptText: receiptText(receipt), receipt },
          verb === 'stop' ? '已停止' : '已中断',
        );
      } catch (e) {
        emit(ui, { kind: verb, ok: false, verb, runId, error: String(e) }, `${verb} 失败：${String(e)}`);
      }
      return;
    }
    case 'resume': {
      const parts = splitArgs(args);
      const runId = parts[0];
      const message = parts.slice(1).join(' ').trim();
      if (!runId || !message) {
        const usage = '用法：/piggy:resume <runId> <消息>';
        emit(ui, { kind: 'resume', ok: false, verb, error: usage, runId }, usage);
        return;
      }
      try {
        const receipt = await rpc.request('resume', { runId, message });
        const newRunId = receiptRunId(receipt);
        emit(
          ui,
          { kind: 'resume', ok: true, runId, ...(newRunId ? { newRunId } : {}), receiptText: receiptText(receipt), receipt },
          '已续跑',
        );
      } catch (e) {
        emit(ui, { kind: 'resume', ok: false, verb, runId, error: String(e) }, `resume 失败：${String(e)}`);
      }
      return;
    }
    case 'cost': {
      if (!rpc.hasCapability('cost')) {
        const error = '当前 pi-subagents 不声明 cost 能力（需 ≥0.71）';
        emit(ui, { kind: 'cost', ok: false, verb, error }, error);
        return;
      }
      try {
        const cost = await rpc.request('cost', {});
        emit(ui, { kind: 'cost', ok: true, cost }, '成本报告已回传');
      } catch (e) {
        emit(ui, { kind: 'cost', ok: false, verb, error: String(e) }, `cost 失败：${String(e)}`);
      }
      return;
    }
  }
}

/* ---------------- 扩展入口 ---------------- */

/**
 * 注册全部 `/piggy:*` 命令并接上 RPC v1。
 *
 * 事件（`pi.events.on`）回调里拿不到 ctx/ui，所以这里记下最后一次命令调用用的 ui：
 * GUI 至少会调一次 `/piggy:status`，此后子代理完成事件就能**主动推**一次快照，
 * 不必让前端轮询（docs/06 §4.3 的"状态变化时主动 setWidget"）。
 */
export function createBridge(api: BridgeApi): { rpc: SubagentRpc; dispose: () => void } {
  const rpc = new SubagentRpc(api.events);
  let lastUi: BridgeUi | null = null;

  const detach = rpc.attach(() => {
    const ui = lastUi;
    if (!ui) return;
    void rpc
      .request('status', {})
      .then((status) => {
        if (lastUi !== ui) return; // 会话已换/已卸载，别往旧 ui 推
        setWidget(ui, widgetLines(status));
        emit(ui, { kind: 'status', ok: true, status, lanes: statusToLanes(status), trigger: 'async-complete' });
      })
      .catch(() => undefined);
  });

  for (const cmd of COMMAND_TABLE) {
    api.registerCommand(cmd.name, {
      description: cmd.description,
      handler: (args: string, ctx: BridgeContext) => {
        lastUi = ctx.ui;
        return runVerb(cmd.verb, args, ctx.ui, rpc);
      },
    });
  }

  return {
    rpc,
    dispose: () => {
      lastUi = null;
      detach();
      rpc.dispose();
    },
  };
}

export default function piggyBridge(pi: ExtensionAPI): void {
  createBridge({
    events: pi.events,
    registerCommand: (name, options) =>
      pi.registerCommand(name, {
        description: options.description,
        // pi 要求 handler 返回 Promise<void>（真实类型 ExtensionAPI.registerCommand）
        handler: async (args: string, ctx: ExtensionCommandContext) => {
          await options.handler(args, ctx as unknown as BridgeContext);
        },
      }),
  });
}
