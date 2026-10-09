/**
 * 护栏三：bash 结果证据化 + read 观察记录
 *
 * 两部分：
 *
 * A. **bash 证据化** —— 把「命令为什么没成功」变成一行**结构化事实**，
 *    且**只追加、不改写原有输出**。
 *
 *    ⚠️ **交付后才发现的事实：pi 0.87.0 的 bash 工具根本不在 `details` 里给退出码。**
 *
 *    - `BashToolDetails` 只有 `{ truncation?, fullOutputPath? }`（`bash.d.ts:15-18`）；
 *    - 非零退出走的是 `throw new Error("<输出>\n\nCommand exited with code N")`
 *      （`bash.js:270`）→ 被 agent-loop 转成 `isError: true` 的结果；
 *    - 超时 / 中止同理，都是**抛错**（`bash.js:256-260`）。
 *
 *    本模块早先假设 `details.exitCode` / `details.signal` / `details.timedOut` 存在
 *    （那是一个更早版本的形状），并且只在 `isError === false` 时追加证据 —— 于是
 *    在真实 pi 上**从来没有生效过**；单元测试却全绿，因为 fixture 手写了
 *    `isError: false` + `details: { exitCode: 1 }`，**mock 与真实不一致**。
 *    详细复盘见 README「一次静默失效」。
 *
 *    现在的做法：从 pi 的**错误文案**里提取事实。文案格式是稳定的（源码可见），
 *    提取失败就原样透传，绝不编造。
 *
 * B. **read 观察记录** —— 这是写前校验的数据来源。
 *    必须在 `tool_result` 里记，而不是在 `tool_call` 里：
 *    `tool_call` 失败或被 block 时不会产生有效观察，提前记录会污染观察表。
 *
 *    ⚠️ **失败的 read 也要记**，但只限「确实不存在」（ENOENT/ENOTDIR）。
 *    pi 对「读不存在的文件」返回 `isError: true`；若因此跳过记录，
 *    创建新文件的正常路径就被永久堵死（详见 handleToolResult 内的注释）。
 */

import { constants as osConstants } from "node:os";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { GuardrailConfig } from "./config.js";
import { isAllowed } from "./config.js";
import type { ObservationStore } from "./observation.js";
import { canonicalKey, stampOf } from "./observation.js";

/** 从扩展上下文里取权威 cwd（会话所在目录），取不到时回落 */
function ctxCwd(ctx: unknown): string | undefined {
	const c = (ctx as { cwd?: unknown } | undefined)?.cwd;
	return typeof c === "string" && c.length > 0 ? c : undefined;
}

/** 编号 → 信号名（如 15 → SIGTERM）。用于识别「被信号杀死」。 */
const SIGNAL_BY_NUMBER: Record<number, string> = (() => {
	const out: Record<number, string> = {};
	for (const [name, num] of Object.entries(osConstants.signals)) {
		if (typeof num === "number") out[num] = name;
	}
	return out;
})();

/** pi 的 bash 失败事实（从抛错文案里解析出来的） */
export interface BashFailure {
	kind: "exit" | "signal" | "timeout" | "aborted";
	/** 退出码；signal/timeout/aborted 时可能缺席 */
	exitCode?: number;
	/** 信号名（仅 kind === "signal"） */
	signal?: string;
}

/** 取结果里的纯文本（工具结果可能是多个块，且可能含图片） */
function resultText(event: ToolResultEvent): string {
	const blocks = Array.isArray(event.content) ? event.content : [];
	return blocks.map((c) => (c as { type?: string; text?: string }).text ?? "").join("\n");
}

/**
 * 从 pi 的 bash 错误文案里解析失败事实。
 *
 * pi 抛出的文案（`bash.js:256-270`，全部经 `appendStatus` 把输出原文前置）：
 *
 * ```
 * <output>\n\nCommand exited with code 7
 * <output>\n\nCommand timed out after 30 seconds
 * <output>\n\nCommand aborted
 * ```
 *
 * ⚠️ 信号杀死**没有独立文案**：pi 在 exec 层把它折成 shell 约定
 * `128 + signalNumber`（`bash.js:97-100`），所以 SIGTERM 会以「exit code 143」
 * 的面目出现。信息在这一步已经损失了 —— 这里用 `128+N` 的映射把它**还原**成
 * 信号名，还原不了就如实当退出码报，不猜。
 */
export function parseBashFailure(event: ToolResultEvent): BashFailure | undefined {
	if (event.isError !== true) return undefined;
	const text = resultText(event);

	if (/Command timed out after \d+ seconds/.test(text)) return { kind: "timeout" };
	if (/Command aborted/.test(text)) return { kind: "aborted" };

	const m = /Command exited with code (-?\d+)/.exec(text);
	if (m === null) return undefined;
	const code = Number(m[1]);

	// 128+N 是 shell 对「被信号杀死」的约定编码，不是真实退出码。
	// 注意范围上界：真跑 `exit 143` 也会落进来 —— 无法区分，只能说明是"疑似信号"。
	const signal = code > 128 && code <= 128 + 64 ? SIGNAL_BY_NUMBER[code - 128] : undefined;
	return signal === undefined ? { kind: "exit", exitCode: code } : { kind: "signal", exitCode: code, signal };
}

/** 渲染成追加在输出末尾的证据行 */
export function evidenceLine(failure: BashFailure): string {
	switch (failure.kind) {
		case "timeout":
			return "[timed out] — the command did not finish; the process group was killed";
		case "aborted":
			return "[aborted] — the user interrupted this command; it did not run to completion";
		case "signal":
			return (
				`[killed by signal: ${failure.signal}] — the command was terminated by a signal, not a normal exit` +
				` (pi reports it as exit code ${failure.exitCode})`
			);
		case "exit":
			return `[exit code: ${failure.exitCode}] — command failed`;
	}
}

/** 兼容旧签名（测试与诊断使用） */
function exitEvidence(
	exitCode: number | undefined,
	signal: string | undefined,
	timedOut: boolean | undefined,
): string | undefined {
	if (timedOut) return evidenceLine({ kind: "timeout" });
	if (signal !== undefined) return evidenceLine({ kind: "signal", signal });
	if (typeof exitCode === "number" && exitCode !== 0) return evidenceLine({ kind: "exit", exitCode });
	return undefined;
}

/**
 * 这次失败的 read 是不是「文件不存在」？
 *
 * pi 把工具抛出的异常转成**只有文本**的 error result（`createErrorToolResult`，
 * agent-loop.ts:804-808），错误码只活在消息字符串里，拿不到 `err.code`。
 * 所以只能匹配文案 —— 保守匹配：只有 ENOENT/ENOTDIR 才算，
 * EACCES/EISDIR/偏移越界都不算（那些记成「不存在」会让后续写入被误当创建放行）。
 */
function isNotFoundFailure(event: ToolResultEvent): boolean {
	const blocks = Array.isArray(event.content) ? event.content : [];
	const text = blocks
		.map((c) => (c as { type?: string; text?: string }).text ?? "")
		.join("\n");
	return /\bENOENT\b/.test(text) || /\bENOTDIR\b/.test(text);
}

export interface EvidenceDeps {	store: ObservationStore;
	config: GuardrailConfig;
	/** getter，因为会话切换可能改变 cwd */
	cwd: () => string;
	/** 惰性解析的白名单（已 realpath 规范化） */
	allowResolver: () => Promise<string[]>;
	debug: (...args: unknown[]) => void;
}

export function registerEvidence(pi: ExtensionAPI, deps: EvidenceDeps): void {
	const { store, config, cwd, allowResolver, debug } = deps;

	// ⚠️ 整个 handler 包在 try/catch 里。
	// pi 的 emitToolResult 会 catch handler 异常并只发一个 error 事件 —— 工具照常返回，
	// 但**护栏静默失灵**。这种"以为有保护其实没有"的状态比崩溃更危险，
	// 所以这里自己兜住并显式 debug 出来，而不是让 pi 吞掉。
	pi.on("tool_result", async (event, ctx) => {
		try {
			return await handleToolResult(event, ctx);
		} catch (err) {
			debug("evidence: handler failed (non-fatal, tool result unchanged):", err);
			return undefined;
		}
	});

	async function handleToolResult(event: ToolResultEvent, ctx: unknown) {
		// ── B. read → 记录观察 ──
		if (event.toolName === "read") {
			const rawPath = (event.input as { path?: unknown }).path;
			if (typeof rawPath === "string" && rawPath.length > 0) {
				try {
					// ctx.cwd 是权威来源：扩展可能在别的目录被加载，
					// 用 process.cwd() 会把观察记到错误的路径上（护栏静默失效）。
					const key = await canonicalKey(rawPath, ctxCwd(ctx) ?? cwd());
					const allowed = config.allow.length > 0 && isAllowed(key, await allowResolver());
					if (!allowed) {
						const stamp = await stampOf(key);
						// ⚠️ 失败的 read 也要记「不存在」。
						//
						// 读一个不存在的文件时 pi 返回 isError: true，如果这里直接跳过，
						// 观察表永远不会有这个路径的记录 —— 于是：
						//   1. write 被 hook 拦下，文案却承诺 "reading it will record its
						//      absence and unblock the write"，而实际重读多少次都没用；
						//   2. 模型只能绕道 bash 去创建文件，**护栏把工具调用推向了它最
						//      监控不到的那条路**。
						//
						// 只对「确实不存在」的失败记 absent。其他失败（权限、EISDIR…）
						// 不记：把 EACCES 记成「不存在」会让后续写入被错误地当成创建放行。
						const absentByError = event.isError === true && isNotFoundFailure(event);
						if (!event.isError || absentByError) {
							// offset 未指定视为全文观察；全文与否当前不影响判定，仅记录
							const full = (event.input as { offset?: unknown }).offset === undefined;
							store.observe(key, stamp, full);
							debug(
								`evidence: observed ${key} exists=${stamp.exists} full=${full}` +
									(absentByError ? " (recorded from failed read)" : ""),
							);
						} else {
							debug(`evidence: read failed for a non-ENOENT reason, observation not recorded ${key}`);
						}
					}
				} catch (err) {
					debug("evidence: failed to record read observation", err);
				}
			}
			return undefined;
		}

		// ── A. bash 证据化 ──
		if (event.toolName !== "bash") return undefined;

		// 事实来源是 pi 的**错误文案**，不是 details —— 见文件头注释。
		// 注意 pi 的失败已经是 isError: true，本层不改这个标志（那是 pi 的决定），
		// 只负责把「为什么失败」讲清楚，让模型不必去正则匹配人话。
		const failure = parseBashFailure(event);
		if (failure === undefined) return undefined;

		const evidence = evidenceLine(failure);
		const originalText = resultText(event);

		// 幂等：本扩展被加载两次（例如全局自动发现 + -e）时，第二个实例看到的是
		// 已经带证据行的文本。不检查就会叠加两行。
		if (originalText.includes(evidence)) {
			debug("evidence: bash evidence already present, skipping");
			return undefined;
		}

		// ⚠️ 「有没有输出」必须在**追加证据行之前**判断，而且必须**排除 pi 的状态文案本身**。
		//
		// pi 的失败文案形如 `<输出>\n\nCommand exited with code N`
		// （`appendStatus`，bash.js:240/270）。若直接看整段文本，那条状态文案
		// 自己就算"有内容"，于是「空输出失败」永远判不出来 —— 这个顺序/口径错误
		// 被测试直接抓到。
		const outputOnly = originalText
			.replace(/Command (?:exited with code -?\d+|timed out after \d+ seconds|aborted)[^\n]*/g, "")
			.trim();
		const hasMeaningfulOutput = outputOnly.length > 0;

		// 原有输出 → 追加证据行，保留全部原内容
		const content = Array.isArray(event.content) ? [...event.content] : [];
		const textIndex = content.findIndex((c) => (c as { type?: string }).type === "text");
		if (textIndex === -1) {
			content.push({ type: "text", text: evidence } as (typeof content)[number]);
		} else {
			const block = content[textIndex] as { type: "text"; text: string };
			content[textIndex] = { ...block, text: `${block.text}\n${evidence}` };
		}

		// 失败但**没有任何输出**：模型手里只有裸退出码，最容易把它读成"跑过了"。
		// pi 已经置了 isError，这里只是把事实再钉一遍（不改变 isError）。
		// 旧配置项 markEmptyFailureAsError 的语义随契约修正一并重定义：
		// 它过去试图替 pi「补上」isError（而 pi 本来就置），现在是「加一句明确不许忽略」。
		const isEmptyFailure = !hasMeaningfulOutput && failure.kind !== "aborted";

		if (config.markEmptyFailureAsError && isEmptyFailure) {
			debug(`evidence: empty failure (${failure.kind}), adding explicit notice`);
			content.push({
				type: "text",
				text:
					"[no output] — the command produced no output and did not succeed;" +
					" do not treat this as a completed step.",
			} as (typeof content)[number]);
		}

		return { content };
	}
}

/** 供测试使用 */
export const __test = { exitEvidence, isNotFoundFailure, parseBashFailure, evidenceLine };
