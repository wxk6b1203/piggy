/**
 * 护栏二：空响应兜底
 *
 * 目标场景：`stopReason === "stop"` 正常结束，但 assistant 消息里
 * **既没有 tool call，也没有任何可见文本**（模型只输出了一个 thinking 块）。
 * 因为 `hideThinkingBlock: true`，用户在界面上什么都看不到，回合就结束了。
 *
 * pi 0.87.0 对 StopReason 的七个取值里，六个都有分支处理，
 * 唯独 `"stop"` 走默认路径、不做内容检查。这是本护栏要补的洞。
 *
 * ⚠️ 两个必须遵守的约束（都已在源码中确认，见 README）：
 *
 * 1. **不能直接 `return { continue: true }`。**
 *    `canContinue` 要求最后一条 LLM 消息不是 assistant
 *    （agent-session.ts:798-800），而空响应之后它必然是 assistant。
 *    直接返回会被 `_reportInvalidBoundaryContinuation` 静默降级为 false。
 *    唯一出路是先 `pi.sendMessage(...)` 让它进 `_pendingCustomMessages`，
 *    从而撑起 `canContinue` 的 `pendingCustomContext` 分支。
 *
 * 2. **必须在 `agent_before_settle` 而非 `turn_end` 里做。**
 *    只有前者的 `_flushPendingCustomMessages()` 在 `canContinue` 检查**之前**
 *    （agent-session.ts:1541 flush，:1545 检查）；`turn_end` 路径不 flush。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuardrailConfig } from "./config.js";

/** 注入的提醒文本。措辞原则：给具体下一步，不要元话语（"你好像卡住了"） */
const REMINDER =
	"Your previous response contained no visible output and no tool calls. " +
	"State what you found and what you will do next, or ask the user a question.";

export interface EmptyGuardDeps {
	config: GuardrailConfig;
	debug: (...args: unknown[]) => void;
}

/** 判断一条 assistant 消息是否"看起来完成了，但什么都没做" */
function isEmptyAssistantMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: string; content?: unknown; stopReason?: string };
	if (m.role !== "assistant") return false;
	// 只处理"正常完成"这一种；aborted 是用户主动中断，error 已经可见
	if (m.stopReason !== "stop") return false;
	if (!Array.isArray(m.content)) return true;

	const hasToolCall = m.content.some((c) => (c as { type?: string })?.type === "toolCall");
	if (hasToolCall) return false;
	const hasText = m.content.some(
		(c) => (c as { type?: string; text?: string })?.type === "text" && ((c as { text?: string }).text ?? "").trim().length > 0,
	);
	return !hasText;
}

export function registerEmptyGuard(pi: ExtensionAPI, deps: EmptyGuardDeps): void {
	const { config, debug } = deps;

	/** 同一次 agent run 内已兜次数。真实用户输入会重置。 */
	let continuations = 0;

	// 真实用户输入重置计数器。
	// 注意：我们自己注入的是 custom_message（role "custom"），不是 "user"，
	// 所以不会被这里误判为"用户介入" —— 否则防自激会失效。
	pi.on("message_start", async (event) => {
		const role = (event.message as { role?: string } | undefined)?.role;
		if (role === "user") {
			if (continuations > 0) debug("empty-guard: reset by user input");
			continuations = 0;
		}
		return undefined;
	});

	pi.on("agent_before_settle", async (event) => {
		if (!config.guardEmptyResponse) return undefined;

		const msgs = event.context?.contextMessages ?? [];
		const last = msgs[msgs.length - 1];
		if (!isEmptyAssistantMessage(last)) return undefined;

		if (continuations >= config.maxEmptyContinuations) {
			// 防自激：已经兜过上限，不再继续，避免无限续跑
			debug(`empty-guard: suppressed (already continued ${continuations}x)`);
			pi.sendMessage(
				{
					customType: "pi-guardrails/empty-suppressed",
					content:
						`The assistant produced ${continuations + 1} consecutive empty responses. ` +
						`Automatic recovery has stopped to avoid a loop. The user should be informed.`,
					display: true,
				},
				{ deliverAs: "steer" },
			);
			return undefined;
		}

		continuations += 1;
		debug(`empty-guard: injecting reminder (attempt ${continuations}/${config.maxEmptyContinuations})`);

		// 顺序很重要：先入 _pendingCustomMessages，再返回 continue。
		// _runBeforeSettleBoundary 会先 flush 再检查 canContinue。
		pi.sendMessage(
			{
				customType: "pi-guardrails/empty-response",
				content: REMINDER,
				display: false,
			},
			{ deliverAs: config.deliverAs },
		);

		return { continue: true };
	});
}

/** 供测试使用 */
export const __test = { isEmptyAssistantMessage };
