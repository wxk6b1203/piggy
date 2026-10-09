/**
 * 护栏三：重复调用探测
 *
 * 对应 DSH 的 `dsh-repeat-tool-reminder`（默认加载，thresholds [3, 5, 8]）。
 *
 * 语义要点：
 * - 链的 key 是 `[工具名, 规范化参数]`，计数**连续**相同调用
 * - 参数必须深排序后比较，否则 `{a:1,b:2}` 与 `{b:2,a:1}` 会被当成不同调用
 * - **真实用户输入重置链，我们自己注入的提醒不重置**（否则提醒会自己把链清掉）
 * - 只提醒，**从不拦截** —— 降低死循环概率，不保证终止
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuardrailConfig } from "./config.js";

/** 温和版：只在第一个阈值触发，指向"上一条结果" */
const GENTLE_REMINDER =
	"You are repeating the exact same tool call with identical arguments. " +
	"Carefully analyze the previous result before calling again: if the task is not complete, " +
	"try a different approach or different arguments instead of repeating the call.";

/** 详细版：第 2、3 个阈值触发，附工具名、连击数与规范化参数 */
function detailedReminder(toolName: string, count: number, argsPreview: string, nextThreshold?: number): string {
	return [
		"Repeated tool call detected:",
		`- tool: ${toolName}`,
		`- consecutive_calls: ${count}`,
		`- arguments: ${argsPreview}`,
		"The repeated calls are not making progress. Do not call this tool with these exact arguments again.",
		nextThreshold === undefined
			? "Change your approach or arguments."
			: `If you repeat this call ${nextThreshold - count} more time(s), it will be flagged again.`,
	].join("\n");
}

/** 深排序，保证对象键序不影响比较 */
function sortDeep(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortDeep);
	if (value && typeof value === "object") {
		const o = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const k of Object.keys(o).sort()) out[k] = sortDeep(o[k]);
		return out;
	}
	return value;
}

/** 规范化调用签名。用 \0 分隔，避免工具名与参数拼接产生歧义。 */
export function canonicalCall(toolName: string, input: unknown): string {
	let serialized: string;
	try {
		serialized = JSON.stringify(sortDeep(input)) ?? "undefined";
	} catch {
		// 循环引用等极端情况：退化为不可比较，让每次调用都视为不同
		serialized = `<<unserializable:${String(input)}>>`;
	}
	return `${toolName}\u0000${serialized}`;
}

function preview(input: unknown, max = 500): string {
	let s: string;
	try {
		s = JSON.stringify(sortDeep(input)) ?? "";
	} catch {
		s = String(input);
	}
	return s.length > max ? `${s.slice(0, max)}… (${s.length} chars total)` : s;
}

export interface RepeatGuardDeps {
	config: GuardrailConfig;
	debug: (...args: unknown[]) => void;
}

export function registerRepeatGuard(pi: ExtensionAPI, deps: RepeatGuardDeps): void {
	const { config, debug } = deps;

	let lastKey: string | undefined;
	let count = 0;
	/** 已经提醒过的阈值，避免同一连击在阈值上反复触发 */
	const fired = new Set<number>();

	const thresholds = config.repeatThresholds;
	// `noUncheckedIndexedAccess` 下 `thresholds[0]` 是 `number | undefined`。
	// 显式收窄，而不是 `!` 断言 —— 配置层保证非空，但类型层不该依赖那个假设。
	const firstThreshold = thresholds[0];
	if (firstThreshold === undefined) return; // 空阈值表 = 不提醒

	// 真实用户输入重置链。注入的 custom_message 的 role 是 "custom"，不会走到这里。
	pi.on("message_start", async (event) => {
		const role = (event.message as { role?: string } | undefined)?.role;
		if (role === "user") {
			if (count > 1) debug(`repeat-guard: chain reset by user input (was ${count})`);
			lastKey = undefined;
			count = 0;
			fired.clear();
		}
		return undefined;
	});

	// 会话切换/分支/压缩后，历史的连续性不再成立。
	// ⚠️ 不能写成 `for (const evt of [...] as const) pi.on(evt, ...)` ——
	// `pi.on` 的重载绑死单个事件字面量，联合类型挑不到重载（见 index.ts 同处注释）。
	const resetChain = () => {
		lastKey = undefined;
		count = 0;
		fired.clear();
		return undefined;
	};
	pi.on("session_before_switch", async () => resetChain());
	pi.on("session_before_fork", async () => resetChain());
	pi.on("session_before_tree", async () => resetChain());
	pi.on("session_before_compact", async () => resetChain());

	pi.on("tool_call", async (event) => {
		const name = event.toolName;
		if (config.repeatExclude.includes(name)) return undefined;
		if (config.repeatInclude.length > 0 && !config.repeatInclude.includes(name)) return undefined;

		const key = canonicalCall(name, event.input);
		if (key === lastKey) {
			count += 1;
		} else {
			lastKey = key;
			count = 1;
			fired.clear();
		}

		if (count < firstThreshold) return undefined;

		// 找本 count 跨过的阈值（若 thresholds 为 [3,5,8]，count=5 时命中 5）
		const hit = thresholds.find((t) => t === count);
		if (hit === undefined || fired.has(hit)) return undefined;
		fired.add(hit);

		const isGentle = hit === firstThreshold;
		const next = thresholds.find((t) => t > hit);
		const text = isGentle
			? GENTLE_REMINDER
			: detailedReminder(name, count, preview(event.input), next);

		debug(`repeat-guard: ${name} repeated ${count}x, injecting ${isGentle ? "gentle" : "detailed"} reminder`);

		pi.sendMessage(
			{
				customType: "pi-guardrails/repeat",
				content: text,
				display: false,
			},
			{ deliverAs: config.deliverAs },
		);

		// 只提醒，不拦截 —— DSH 也是 advisory-only
		return undefined;
	});
}

/** 供测试使用 */
export const __test = { sortDeep, preview, GENTLE_REMINDER, detailedReminder };
