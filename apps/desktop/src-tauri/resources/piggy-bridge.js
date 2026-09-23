/**
 * piggy-bridge —— 由 packages/piggy-bridge/src/index.ts 打包生成，请勿直接编辑。
 * 重新生成：pnpm build:bridge     校验是否最新：pnpm --filter piggy-bridge test
 */

// src/index.ts
var PREFIX = "PIGGY:1:";
var RPC_VERSION = 1;
var READY_EVENT = "subagents:rpc:v1:ready";
var REQUEST_EVENT = "subagents:rpc:v1:request";
var REPLY_PREFIX = "subagents:rpc:v1:reply:";
var ASYNC_COMPLETE_EVENT = "subagent:async-complete";
var WIDGET_KEY = "piggy-fleet";
var DEFAULT_TIMEOUT_MS = 15e3;
function encodePayload(payload) {
  return PREFIX + JSON.stringify(payload);
}
function splitArgs(args) {
  const out = [];
  let cur = "";
  let quote = null;
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
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) out.push(cur);
  return out;
}
function parseSteerArgs(args) {
  const parts = splitArgs(args);
  const runId = parts[0];
  if (!runId) return { message: "", error: "\u7528\u6CD5\uFF1A/piggy:steer <runId> [index] <\u6D88\u606F>" };
  const rest = parts.slice(1);
  let index;
  if (rest.length > 1 && /^\d+$/.test(rest[0] ?? "")) {
    index = Number(rest[0]);
    rest.shift();
  }
  const message = rest.join(" ").trim();
  if (!message) return { runId, message: "", error: "steer \u9700\u8981\u975E\u7A7A\u6D88\u606F" };
  return index === void 0 ? { runId, message } : { runId, index, message };
}
function parseSpawnArgs(args) {
  const parts = splitArgs(args);
  const agent = parts[0];
  if (!agent) return { task: "", error: "\u7528\u6CD5\uFF1A/piggy:spawn <agent> <\u4EFB\u52A1>" };
  const task = parts.slice(1).join(" ").trim();
  if (!task) return { agent, task: "", error: "spawn \u9700\u8981\u975E\u7A7A\u4EFB\u52A1\u63CF\u8FF0" };
  return { agent, task };
}
function asRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null;
}
function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : void 0;
}
function str(v) {
  return typeof v === "string" && v ? v : void 0;
}
function receiptText(receipt) {
  const content = asRecord(receipt)?.content;
  if (!Array.isArray(content)) return void 0;
  const text = content.map((b) => str(asRecord(b)?.text)).filter((t) => Boolean(t)).join("\n").trim();
  return text ? text.slice(0, 500) : void 0;
}
function receiptRunId(receipt) {
  const details = asRecord(asRecord(receipt)?.details);
  return str(details?.asyncId) ?? str(details?.runId);
}
function receiptDelivery(receipt) {
  const details = asRecord(asRecord(receipt)?.details);
  const steering = asRecord(details?.steering);
  return str(steering?.deliveryStatus) ?? str(details?.deliveryStatus);
}
function statusToLanes(status, now = Date.now()) {
  const data = asRecord(status);
  if (!data) return [];
  const lanes = [];
  const entries = asRecord(data.fleet)?.entries;
  if (Array.isArray(entries)) {
    for (const raw of entries) {
      const e = asRecord(raw);
      if (!e) continue;
      const agent = str(e.agent) ?? "subagent";
      const role = str(e.role);
      const startedAt = num(e.startedAt);
      const tokens = asRecord(e.tokens);
      const total = num(tokens?.total);
      lanes.push({
        agent: role ? `${agent} \xB7 ${role}` : agent,
        status: "running",
        ...startedAt !== void 0 ? { elapsed: Math.max(0, now - startedAt) } : {},
        ...total !== void 0 ? { tokens: total } : {}
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
        agent: str(r.agent) ?? str(r.label) ?? str(r.kind) ?? "subagent",
        status: str(r.state) ?? str(r.status) ?? "unknown",
        ...startedAt !== void 0 ? { elapsed: Math.max(0, (endedAt ?? now) - startedAt) } : {},
        ...tokens !== void 0 ? { tokens } : {},
        ...cost !== void 0 ? { cost } : {}
      });
    }
  }
  return lanes;
}
function widgetLines(status, now = Date.now()) {
  const data = asRecord(status);
  if (!data) return ["fleet: \u65E0\u6570\u636E"];
  const totalActive = num(asRecord(data.fleet)?.totalActive) ?? 0;
  const lanes = statusToLanes(status, now);
  return [
    `fleet: ${totalActive} \u4E2A\u5B50\u4EE3\u7406\u6D3B\u52A8\u4E2D \xB7 ${lanes.length} \u6761\u53EF\u89C1`,
    ...lanes.slice(0, 6).map((l) => `fleet\xB7lane: ${l.agent ?? "?"} \xB7 ${l.status ?? "?"}`)
  ];
}
var SubagentRpc = class {
  constructor(bus, options = {}) {
    this.bus = bus;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.makeId = options.makeId ?? (() => globalThis.crypto.randomUUID());
  }
  ready = false;
  ping = null;
  pending = /* @__PURE__ */ new Map();
  timeoutMs;
  makeId;
  get capabilities() {
    return asRecord(this.ping?.capabilities) ?? {};
  }
  /** 能力位查询（如 `cost` 只有 pi-subagents ≥0.71 才声明）。 */
  hasCapability(name) {
    return this.capabilities[name] !== void 0;
  }
  get methods() {
    const m = this.ping?.methods;
    return Array.isArray(m) ? m.filter((x) => typeof x === "string") : [];
  }
  /** 订阅 ready（能力协商）与子代理完成事件；返回退订函数。 */
  attach(onAsyncComplete) {
    const offReady = this.bus.on(READY_EVENT, (data) => {
      this.ping = asRecord(data) ?? {};
      this.ready = true;
    });
    const offComplete = onAsyncComplete ? this.bus.on(ASYNC_COMPLETE_EVENT, onAsyncComplete) : void 0;
    return () => {
      if (typeof offReady === "function") offReady();
      if (typeof offComplete === "function") offComplete();
    };
  }
  request(method, params = {}, timeoutMs = this.timeoutMs) {
    const requestId = this.makeId();
    return new Promise((resolve, reject) => {
      const finish = (fn) => {
        const p = this.pending.get(requestId);
        if (!p) return;
        clearTimeout(p.timer);
        if (typeof p.off === "function") p.off();
        this.pending.delete(requestId);
        fn();
      };
      const timer = setTimeout(() => {
        finish(() => reject(new Error(`RPC ${method} \u8D85\u65F6\uFF08${timeoutMs}ms \u65E0\u56DE\u6267\uFF09`)));
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
          reject(new Error(`${str(err?.code) ?? "rpc_error"}: ${str(err?.message) ?? "\u672A\u77E5\u9519\u8BEF"}`));
        });
      });
      this.pending.set(requestId, { reject, timer, off });
      this.bus.emit(REQUEST_EVENT, {
        version: RPC_VERSION,
        requestId,
        method,
        params,
        source: { extension: "piggy-bridge" }
      });
    });
  }
  dispose() {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      if (typeof p.off === "function") p.off();
      p.reject(new Error("piggy-bridge \u5DF2\u5378\u8F7D"));
    }
    this.pending.clear();
  }
};
var COMMAND_TABLE = [
  { name: "piggy:status", verb: "status", description: "\u628A\u4F1A\u8BDD\u5185\u5B50\u4EE3\u7406\u8230\u961F\u5FEB\u7167\u540C\u6B65\u5230 Fleet \u9762\u677F" },
  { name: "piggy:spawn", verb: "spawn", description: "\u6D3E\u53D1\u4E00\u4E2A\u4F1A\u8BDD\u5185\u5B50\u4EE3\u7406\uFF1A/piggy:spawn <agent> <\u4EFB\u52A1>" },
  { name: "piggy:steer", verb: "steer", description: "\u7ED9\u8FD0\u884C\u4E2D\u7684\u5B50\u4EE3\u7406\u8FFD\u52A0\u6307\u4EE4\uFF1A/piggy:steer <runId> [index] <\u6D88\u606F>" },
  { name: "piggy:interrupt", verb: "interrupt", description: "\u4E2D\u65AD\u5B50\u4EE3\u7406\u5F53\u524D\u56DE\u5408\uFF1A/piggy:interrupt <runId>" },
  { name: "piggy:stop", verb: "stop", description: "\u505C\u6B62\u540E\u53F0\u5B50\u4EE3\u7406\u8FD0\u884C\uFF1A/piggy:stop <runId>" },
  { name: "piggy:resume", verb: "resume", description: "\u7EED\u8DD1\u5DF2\u505C\u6B62\u7684\u5B50\u4EE3\u7406\uFF1A/piggy:resume <runId> <\u6D88\u606F>" },
  { name: "piggy:cost", verb: "cost", description: "\u5B50\u4EE3\u7406\u6210\u672C/\u7528\u91CF\u62A5\u544A\uFF08\u9700 pi-subagents \u22650.71\uFF09" },
  { name: "piggy:fleet-refresh", verb: "fleet-refresh", description: "\u5237\u65B0\u8230\u961F\u5FEB\u7167\uFF08status \u7684\u522B\u540D\uFF0C\u4F9B\u9762\u677F\u5237\u65B0\u6309\u94AE\u7528\uFF09" }
];
function emit(ui, payload, humanSummary) {
  ui.setEditorText(encodePayload(payload));
  if (humanSummary) ui.notify(humanSummary, "info");
}
function setWidget(ui, lines) {
  ui.setWidget?.(WIDGET_KEY, lines);
}
var DEGRADED_ERROR = "pi-subagents \u672A\u5B89\u88C5";
function degraded(ui, verb, kind) {
  emit(
    ui,
    { kind, ok: false, verb, error: DEGRADED_ERROR },
    "\u672A\u68C0\u6D4B\u5230 pi-subagents\uFF08\u5B89\u88C5\u540E\u91CD\u542F pi\uFF1Api install npm:pi-subagents\uFF09"
  );
  setWidget(ui, ["fleet: pi-subagents \u672A\u5B89\u88C5", "fleet: \u5B89\u88C5\u540E\u672C\u884C\u663E\u793A\u8230\u961F\u72B6\u6001"]);
}
async function runVerb(verb, args, ui, rpc) {
  const kind = verb === "fleet-refresh" ? "status" : verb;
  if (!rpc.ready) return degraded(ui, verb, kind);
  switch (verb) {
    case "status":
    case "fleet-refresh": {
      try {
        const status = await rpc.request("status", {});
        setWidget(ui, widgetLines(status));
        const lanes = statusToLanes(status);
        emit(ui, { kind: "status", ok: true, status, lanes }, `\u8230\u961F\u5DF2\u540C\u6B65\uFF08${lanes.length} \u6761\u53EF\u89C1\uFF09`);
      } catch (e) {
        emit(ui, { kind: "status", ok: false, verb, error: String(e) }, `status \u5931\u8D25\uFF1A${String(e)}`);
      }
      return;
    }
    case "spawn": {
      const parsed = parseSpawnArgs(args);
      if (parsed.error) {
        emit(ui, { kind: "spawn", ok: false, verb, error: parsed.error }, parsed.error);
        return;
      }
      try {
        const receipt = await rpc.request("spawn", { agent: parsed.agent, task: parsed.task, async: true });
        const runId = receiptRunId(receipt);
        emit(
          ui,
          {
            kind: "spawn",
            ok: true,
            agent: parsed.agent,
            ...runId ? { runId } : {},
            receiptText: receiptText(receipt),
            receipt
          },
          `\u5DF2\u6D3E\u53D1\u5B50\u4EE3\u7406 ${parsed.agent}${runId ? `\uFF08run ${runId}\uFF09` : ""}`
        );
      } catch (e) {
        emit(ui, { kind: "spawn", ok: false, verb, error: String(e) }, `\u6D3E\u53D1\u5931\u8D25\uFF1A${String(e)}`);
      }
      return;
    }
    case "steer": {
      const parsed = parseSteerArgs(args);
      if (parsed.error) {
        emit(ui, { kind: "steer", ok: false, verb, error: parsed.error, runId: parsed.runId }, parsed.error);
        return;
      }
      const params = { runId: parsed.runId, message: parsed.message };
      if (parsed.index !== void 0) params.index = parsed.index;
      try {
        const receipt = await rpc.request("steer", params);
        const delivery = receiptDelivery(receipt) ?? "unknown";
        emit(
          ui,
          {
            kind: "steer",
            ok: true,
            runId: parsed.runId,
            deliveryStatus: delivery,
            receiptText: receiptText(receipt),
            receipt
          },
          `steer \u5DF2\u9001\u8FBE\uFF08${delivery}\uFF09`
        );
      } catch (e) {
        emit(ui, { kind: "steer", ok: false, verb, runId: parsed.runId, error: String(e) }, `steer \u5931\u8D25\uFF1A${String(e)}`);
      }
      return;
    }
    case "interrupt":
    case "stop": {
      const runId = splitArgs(args)[0];
      if (!runId) {
        const usage = `\u7528\u6CD5\uFF1A/piggy:${verb} <runId>`;
        emit(ui, { kind: verb, ok: false, verb, error: usage }, usage);
        return;
      }
      try {
        const receipt = await rpc.request(verb, { runId });
        emit(
          ui,
          { kind: verb, ok: true, runId, receiptText: receiptText(receipt), receipt },
          verb === "stop" ? "\u5DF2\u505C\u6B62" : "\u5DF2\u4E2D\u65AD"
        );
      } catch (e) {
        emit(ui, { kind: verb, ok: false, verb, runId, error: String(e) }, `${verb} \u5931\u8D25\uFF1A${String(e)}`);
      }
      return;
    }
    case "resume": {
      const parts = splitArgs(args);
      const runId = parts[0];
      const message = parts.slice(1).join(" ").trim();
      if (!runId || !message) {
        const usage = "\u7528\u6CD5\uFF1A/piggy:resume <runId> <\u6D88\u606F>";
        emit(ui, { kind: "resume", ok: false, verb, error: usage, runId }, usage);
        return;
      }
      try {
        const receipt = await rpc.request("resume", { runId, message });
        const newRunId = receiptRunId(receipt);
        emit(
          ui,
          { kind: "resume", ok: true, runId, ...newRunId ? { newRunId } : {}, receiptText: receiptText(receipt), receipt },
          "\u5DF2\u7EED\u8DD1"
        );
      } catch (e) {
        emit(ui, { kind: "resume", ok: false, verb, runId, error: String(e) }, `resume \u5931\u8D25\uFF1A${String(e)}`);
      }
      return;
    }
    case "cost": {
      if (!rpc.hasCapability("cost")) {
        const error = "\u5F53\u524D pi-subagents \u4E0D\u58F0\u660E cost \u80FD\u529B\uFF08\u9700 \u22650.71\uFF09";
        emit(ui, { kind: "cost", ok: false, verb, error }, error);
        return;
      }
      try {
        const cost = await rpc.request("cost", {});
        emit(ui, { kind: "cost", ok: true, cost }, "\u6210\u672C\u62A5\u544A\u5DF2\u56DE\u4F20");
      } catch (e) {
        emit(ui, { kind: "cost", ok: false, verb, error: String(e) }, `cost \u5931\u8D25\uFF1A${String(e)}`);
      }
      return;
    }
  }
}
var DELEGATION_ENV = "PIGGY_SUBAGENT_DELEGATION";
function planSubagentActivation(opts) {
  if (!opts.enabled) return { activate: false, tools: [], reason: "disabled" };
  if (!opts.available.includes("subagent")) return { activate: false, tools: [], reason: "unavailable" };
  if (opts.active.includes("subagent")) return { activate: false, tools: [], reason: "already" };
  return {
    activate: true,
    tools: [.../* @__PURE__ */ new Set([...opts.active, "subagent"])],
    reason: "ok"
  };
}
function createBridge(api) {
  const rpc = new SubagentRpc(api.events);
  let lastUi = null;
  const detach = rpc.attach(() => {
    const ui = lastUi;
    if (!ui) return;
    void rpc.request("status", {}).then((status) => {
      if (lastUi !== ui) return;
      setWidget(ui, widgetLines(status));
      emit(ui, { kind: "status", ok: true, status, lanes: statusToLanes(status), trigger: "async-complete" });
    }).catch(() => void 0);
  });
  for (const cmd of COMMAND_TABLE) {
    api.registerCommand(cmd.name, {
      description: cmd.description,
      handler: (args, ctx) => {
        lastUi = ctx.ui;
        return runVerb(cmd.verb, args, ctx.ui, rpc);
      }
    });
  }
  return {
    rpc,
    dispose: () => {
      lastUi = null;
      detach();
      rpc.dispose();
    }
  };
}
function piggyBridge(pi) {
  createBridge({
    events: pi.events,
    registerCommand: (name, options) => pi.registerCommand(name, {
      description: options.description,
      // pi 要求 handler 返回 Promise<void>（真实类型 ExtensionAPI.registerCommand）
      handler: async (args, ctx) => {
        await options.handler(args, ctx);
      }
    })
  });
  let warnedUnavailable = false;
  const onAgentStart = () => {
    const plan = planSubagentActivation({
      enabled: process.env[DELEGATION_ENV] === "1",
      available: (pi.getAllTools?.() ?? []).map((t) => t.name),
      active: pi.getActiveTools?.() ?? []
    });
    if (plan.activate) {
      try {
        pi.setActiveTools(plan.tools);
      } catch {
      }
      return;
    }
    if (plan.reason === "unavailable" && !warnedUnavailable) {
      warnedUnavailable = true;
      console.warn(
        "[piggy] \u5B50\u4EE3\u7406\u59D4\u6D3E\u5DF2\u5F00\u542F\uFF0C\u4F46\u672C\u4F1A\u8BDD\u7684\u5DE5\u5177\u8868\u91CC\u6CA1\u6709 subagent \uFF08\u9650\u5236\u6863\u4F4D\u7684 --tools \u767D\u540D\u5355\u4F1A\u8FC7\u6EE4\u6389\u6269\u5C55\u5DE5\u5177\uFF09\u3002\u7B56\u7565\u5DF2\u6CE8\u5165\u4F46\u5DE5\u5177\u4E0D\u5B58\u5728\u3002"
      );
    }
  };
  pi.on("before_agent_start", onAgentStart);
}
export {
  ASYNC_COMPLETE_EVENT,
  COMMAND_TABLE,
  DEGRADED_ERROR,
  DELEGATION_ENV,
  PREFIX,
  READY_EVENT,
  REPLY_PREFIX,
  REQUEST_EVENT,
  RPC_VERSION,
  SubagentRpc,
  WIDGET_KEY,
  createBridge,
  piggyBridge as default,
  encodePayload,
  parseSpawnArgs,
  parseSteerArgs,
  planSubagentActivation,
  receiptDelivery,
  receiptRunId,
  receiptText,
  runVerb,
  splitArgs,
  statusToLanes,
  widgetLines
};
