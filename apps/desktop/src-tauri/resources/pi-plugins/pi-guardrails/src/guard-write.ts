/**
 * 护栏一：写前观察校验
 *
 * 对应 DSH 的 `dsh-fs-observation-policy`：
 * - `FS_NOT_OBSERVED`  未读就改   → "file has not been read — read the file, then retry"
 * - `FS_STALE_VERSION` 读过但被外部改 → "file changed since it was read — re-read the file, then retry"
 *
 * ⚠️ 本模块走的是 `tool_call` 钩子，因此**自身是非原子**的：
 *    检查与写入之间存在 TOCTOU 窗口。这里只负责两件事：
 *      - 「未读就改」是纯状态判断，100% 可靠；
 *      - 在工具执行**之前**拦住，让模型拿到可执行的修复动作（去读文件）。
 *
 *    版本比对（CAS）的原子性由 `guard-atomic.ts` 负责 —— 它覆盖内置 write/edit，
 *    把判定放进同一个 `withFileMutationQueue` 临界区。两层各管一件事，
 *    本模块**不重复**做陈旧判定，避免两套语义漂移。
 */

import type { ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { GuardrailConfig } from "./config.js";
import { isAllowed } from "./config.js";
import type { ObservationStore } from "./observation.js";
import { canonicalKey, stampOf } from "./observation.js";

/** 需要写前校验的工具 */
const MUTATING_TOOLS = new Set(["edit", "write"]);

/**
 * 该工具是否已被原子层覆盖（`guard-atomic.ts`）。
 *
 * 覆盖意味着**锁内会做同一套判定，而且结论更权威**。于是本层可以省掉
 * 需要 stat 的那部分（陈旧比对），只保留纯状态判断。
 */
function isAtomicallyCovered(toolName: string, config: GuardrailConfig): boolean {
	if (config.atomicWrite === "off") return false;
	if (config.atomicWrite === "write+edit") return true;
	return toolName === "write";
}

export interface ObservationCheckDeps {
	store: ObservationStore;
	config: GuardrailConfig;
	cwd: string;
	/** 惰性解析的白名单（已 realpath 规范化），见 config.makeAllowResolver */
	allowResolver: () => Promise<string[]>;
	debug: (...args: unknown[]) => void;
}

/**
 * 判定一次写操作是否放行。
 *
 * 返回 `undefined` 表示放行；返回 `{ block: true, reason }` 表示拦截。
 *
 * 注意 pi 的语义：`runner.js` 命中第一个 `block` 就 return，
 * 所以本函数必须在**单次调用内**把所有问题合并成一条 reason（见 §4.6）。
 *
 * ⚠️ 本函数**不会抛异常**。护栏自身的故障不能伪装成工具故障 ——
 * `beforeToolCall` 抛出的异常会被 agent-loop 直接转成给模型的错误结果，
 * 模型会看到 `EACCES: permission denied` 这类内部细节而不是护栏说明。
 * 所以这里统一 fail-closed 并给出自己的文案。
 */
export async function checkObservation(
	toolName: string,
	input: Record<string, unknown>,
	deps: ObservationCheckDeps,
): Promise<ToolCallEventResult | undefined> {
	try {
		return await checkObservationInner(toolName, input, deps);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		deps.debug("observation: guard internal error, fail-closed:", err);
		const rawPath = typeof input.path === "string" ? input.path : "(unknown path)";
		return {
			block: true,
			reason:
				`cannot modify "${rawPath}": the write guard could not verify this file ` +
				`(${detail}). Retry once; if it keeps failing, the guard is faulty — ` +
				`disable it with enforceObservation: false rather than working around it.`,
		};
	}
}

/** 实际判定逻辑；异常由 checkObservation 统一兜住。 */
async function checkObservationInner(
	toolName: string,
	input: Record<string, unknown>,
	deps: ObservationCheckDeps,
): Promise<ToolCallEventResult | undefined> {
	const { store, config, cwd, allowResolver, debug } = deps;
	if (!config.enforceObservation) return undefined;
	if (!MUTATING_TOOLS.has(toolName)) return undefined;

	const rawPath = input.path;
	if (typeof rawPath !== "string" || rawPath.length === 0) {
		// 参数非法交给 pi 自己的 schema 校验处理，护栏不越权
		return undefined;
	}

	const key = await canonicalKey(rawPath, cwd);
	if (config.allow.length > 0 && isAllowed(key, await allowResolver())) {
		debug("observation: allow-listed, skip", key);
		return undefined;
	}

	const prior = store.get(key);
	const display = rawPath;
	const resolvedNote = key === rawPath ? "" : ` (resolved: ${key})`;

	// 原子层覆盖了这个工具 → **全部判定交给它**（锁内、更权威）。
	//
	// 为什么连"未读就改"也交出去：判断"这个文件是不是已经存在、模型有没有看过它"
	// 需要 stat 文件系统，而只有原子层能在**持有该文件锁**的情况下做这件事 ——
	// 本层在锁外，结论可能在下一次 await 时就过期。省掉的 stat 不是"少检查一次"，
	// 而是"不在错误的地方检查"。
	//
	// 代价：拦截文案晚一步到模型（工具已经进到 execute 里）。但**创建新文件因此不再
	// 被收费** —— 过去模型写一个新文件要先撞一次墙才被允许，而创建不存在的文件
	// 没有任何东西可破坏，真正的风险（并发创建）本来就由原子层兜底。
	//
	// ⚠️ 与之配套的**必要**改动在原子层：`prior === undefined` 时它必须在锁内 stat 一次，
	// 否则"已存在但从未读过"会两层都放行 → 静默覆盖。见 guard-atomic.ts 的对应注释。
	if (isAtomicallyCovered(toolName, config)) {
		debug(`observation: deferring to atomic layer (${toolName})`, key);
		return undefined;
	}

	// ── 无观察记录：未读就改 ──
	//
	// 走到这里说明本工具**未被原子层覆盖**（`atomicWrite: "off"`，或 `edit` 在
	// `"write"` 模式下），所以本层是唯一防线，必须自己 stat 一次来判断文件是否存在。
	//
	// ⚠️ 文案不再承诺"读一次可以解锁创建"。那是旧契约的说法，而旧契约有两个问题：
	//   1. 创建不存在的文件**没有东西可破坏**，为它收费纯属摩擦；
	//   2. 它要求模型先做一次失败/空的读取来"解锁"，是让模型去猜护栏的内部状态。
	// 新契约（原子层）：文件不存在 → 直接放行创建；已存在且未读 → 拦。
	// 本层在未被覆盖时保持保守（一律要求先读），因为这里**无法在锁内可靠判断**。
	if (prior === undefined) {
		debug("observation: reject (never read)", key);
		return {
			block: true,
			reason:
				`cannot modify "${display}"${resolvedNote}: file has not been read` +
				` — read the file, then retry.` +
				`\n(Guardrail: read-before-write. If the file does not exist, read it anyway:` +
				` the failed read records its absence, which is what unblocks creating it.)`,
		};
	}

	// ── 上次观察为"不存在" ──
	if (!prior.exists) {
		const now = await safeStamp(key);
		if (now.exists) {
			// 读时不存在、现在存在了 —— 可能是并发的创建者，仍要求重读
			debug("observation: reject (observed absent, now present)", key);
			return {
				block: true,
				reason:
					`cannot modify "${display}"${resolvedNote}: it did not exist when last observed` +
					` but exists now — re-read the file, then retry.`,
			};
		}
		// 确实还是不存在，放行（这是创建新文件的正常路径）。
		//
		// ⚠️ **这里绝不能记录观察**。
		//
		// 曾经这里（以及"读时不存在"分支）会 store.observe(key, {exists:false})，
		// 理由是"顺手把缺席记下来"。那是错的，而且会自伤：
		//   1. 本层是**预检**，它的"不存在"只是检查那一刻的事实，不是模型的观察。
		//      记下来等于**替模型伪造了一条观察**。
		//   2. 两个并发的 write 创建同一文件时：A 的预检记 absent → A 落盘成功 →
		//      B 的原子层读到 A 伪造的那条 absent，而文件已存在 → 判定为
		//      "并发创建，要求重读"，**B 被自己伪造的记录挡下**。
		//   3. 更糟的是，如果 B 的 write 本来是对的（模型确实先读过、确认过不存在），
		//      它也会被拒 —— 拦截理由与模型的实际认知不符，模型只能反复重读。
		//
		// 结论：**观察表的唯一权威是原子层**（guard-atomic.ts）。本层只读不写。
		return undefined;
	}

	if (!config.detectStale) return undefined;

	// ── 有观察且曾存在：比对版本戳 ──
	let now;
	try {
		now = await stampOf(key);
	} catch (err) {
		// stampOf 只对 ENOENT/ENOTDIR 返回，其他错误（权限等）会抛到这里。
		// 此时无法判定新鲜度 —— fail-closed。
		debug("observation: stamp error, fail-closed", key, err);
		return {
			block: true,
			reason:
				`cannot modify "${display}"${resolvedNote}: could not verify whether the file changed` +
				` (${err instanceof Error ? err.message : String(err)}) — re-read the file, then retry.`,
		};
	}

	if (!now.exists) {
		debug("observation: reject (vanished)", key);
		return {
			block: true,
			reason:
				`cannot modify "${display}"${resolvedNote}: the file was deleted after it was read` +
				` — re-read (or re-create) it, then retry.`,
		};
	}

	if (now.stamp !== prior.stamp) {
		debug("observation: reject (stale)", key, prior.stamp, "->", now.stamp);
		return {
			block: true,
			reason:
				`cannot edit "${display}"${resolvedNote}: file changed since it was read` +
				` — re-read the file, then retry.`,
		};
	}

	return undefined;
}

async function safeStamp(key: string) {
	try {
		return await stampOf(key);
	} catch {
		// 调用方已处理错误路径；这里只用于"上次观察为 absent"的分支
		return { exists: false, stamp: "absent" };
	}
}
