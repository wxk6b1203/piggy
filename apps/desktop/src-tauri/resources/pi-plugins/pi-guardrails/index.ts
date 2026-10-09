/**
 * pi-guardrails —— 把 DSH 的"失败可观测 + 写前校验"机制移植到 pi coding agent
 *
 * 四个护栏，全部走扩展事件钩子，**不修改 pi 源码**：
 *
 *   1. 写前观察校验   edit/write 未读或陈旧 → block（对应 DSH fs-observation-policy）
 *   2. 空响应兜底     stop 但无正文无工具调用 → 注入提醒并续跑
 *   3. bash 证据化    非零退出/超时/被信号杀死 → 追加结构化事实行
 *   4. 重复调用探测   [3,5,8] 连击 → 注入分级提醒（advisory-only，从不拦截）
 *
 * ⚠️ 遵守 pi 的三条硬约束（都是读源码确认的，改代码前请先读 README）：
 *
 *   a. `runner.js` 命中第一个 `block` 就 return —— 同一 handler 内必须合并所有问题
 *   b. `withFileMutationQueue` 不可重入 —— 不要嵌套调用，会死锁
 *   c. 提醒必须用 `deliverAs: "steer"` —— `nextTurn` 要等用户下次发言才送达
 *
 * 用法：
 *   pi -e /path/to/pi-guardrails/index.ts
 * 或放进自动发现目录（支持 /reload 热更新）：
 *   ~/.pi/agent/extensions/pi-guardrails/index.ts
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, makeAllowResolver, resolveConfig, type GuardrailConfig } from "./src/config.js";
import { registerAtomicGuard } from "./src/guard-atomic.js";
import { registerEmptyGuard } from "./src/guard-empty.js";
import { registerPromptContribution } from "./src/prompt.js";
import { registerRepeatGuard } from "./src/guard-repeat.js";
import { checkObservation } from "./src/guard-write.js";
import { registerEvidence } from "./src/evidence.js";
import { ObservationStore } from "./src/observation.js";

export default function piGuardrails(pi: ExtensionAPI, rawConfig?: unknown) {
	const config: GuardrailConfig = resolveConfig(rawConfig ?? DEFAULT_CONFIG);
	const store = new ObservationStore();

	const debug = (...args: unknown[]): void => {
		if (config.debug) console.error("[pi-guardrails]", ...args);
	};

	/** 扩展加载时的 cwd。会话切换后 pi 内部的 cwd 语义由此事件体现。 */
	let cwd = process.cwd();

	// ── 会话生命周期 ──
	// 换会话/换分支后，旧的观察记录不再可信（DSH 也有同样的限制：
	// "Observed state does not survive a session resume"）。
	//
	// ⚠️ 写成 `for (const evt of [...] as const) pi.on(evt, ...)` 过不了类型检查：
	// `pi.on` 的每个重载都绑死**单个**事件字面量，传进来一个联合类型会挑不到重载
	// （`noImplicitAny` 下还连带把回调参数变成隐式 any）。
	// 拆成逐条注册，让每条都落进自己的重载。
	const clearObservations = (label: string) => {
		if (store.size > 0) {
			debug(`lifecycle(${label}): clearing ${store.size} observation(s), cwd=${cwd}`);
			store.clear();
		}
		return undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		if (typeof ctx?.cwd === "string" && ctx.cwd.length > 0) cwd = ctx.cwd;
		return clearObservations("session_start");
	});
	pi.on("session_before_switch", async (_event, ctx) => {
		if (typeof ctx?.cwd === "string" && ctx.cwd.length > 0) cwd = ctx.cwd;
		return clearObservations("session_before_switch");
	});
	pi.on("session_before_fork", async (_event, ctx) => {
		if (typeof ctx?.cwd === "string" && ctx.cwd.length > 0) cwd = ctx.cwd;
		return clearObservations("session_before_fork");
	});
	pi.on("session_before_tree", async (_event, ctx) => {
		if (typeof ctx?.cwd === "string" && ctx.cwd.length > 0) cwd = ctx.cwd;
		return clearObservations("session_before_tree");
	});

	pi.on("session_shutdown", async () => {
		store.clear();
		return undefined;
	});

	// ── 白名单规范化器（惰性 + 记忆化）──
	// 必须在加载时就构造：macOS 上 realpath 会把 /var → /private/var，
	// 白名单若停留在旧形态会静默失效。
	const allowResolver = makeAllowResolver(config, cwd);

	// ── 护栏 1：写前观察校验 ──
	// 这一层是**非原子**的：它在 tool_call 钩子里跑，检查与写入之间有窗口。
	// 它的价值是「在工具执行前就拦住」，文案能直接告诉模型去读文件。
	// 原子性由下面的 registerAtomicGuard 负责 —— 两层各管一件事，不重复。
	pi.on("tool_call", async (event, ctx) => {
		if (typeof ctx?.cwd === "string" && ctx.cwd.length > 0) cwd = ctx.cwd;
		return checkObservation(event.toolName, event.input as Record<string, unknown>, {
			store,
			config,
			cwd,
			allowResolver,
			debug,
		});
	});

	// ── 护栏 1（v2）：真原子 CAS ──
	// 覆盖内置 write/edit，把判定塞进 withFileMutationQueue 临界区，
	// 消除上面那层的 TOCTOU 窗口（v1 的已知限制，见 README）。
	registerAtomicGuard(pi, { store, config, cwd: () => cwd, allowResolver, debug });

	// ── 护栏 3 + read 观察记录 ──
	registerEvidence(pi, { store, config, cwd: () => cwd, allowResolver, debug });

	// ── 护栏 4：重复调用探测 ──
	registerRepeatGuard(pi, { config, debug });

	// ── 护栏 2：空响应兜底 ──
	registerEmptyGuard(pi, { config, debug });

	// ── 把护栏的存在写进系统提示词（只在为真时）──
	registerPromptContribution(pi, { config, debug });

	debug(
		`loaded. enforceObservation=${config.enforceObservation} detectStale=${config.detectStale} ` +
			`atomicWrite=${config.atomicWrite} ` +
			`guardEmptyResponse=${config.guardEmptyResponse} thresholds=[${config.repeatThresholds.join(",")}] ` +
			`deliverAs=${config.deliverAs}`,
	);

	// 暴露给 /stats 类命令或测试
	return {
		config,
		observations: () => store.snapshot(),
	};
}

export { DEFAULT_CONFIG, resolveConfig } from "./src/config.js";
export { __test as evidenceTest, GuardError, registerAtomicGuard } from "./src/guard-atomic.js";
export { __test } from "./src/evidence.js";
export { canonicalCall } from "./src/guard-repeat.js";
export { checkObservation } from "./src/guard-write.js";
export { ObservationStore } from "./src/observation.js";
