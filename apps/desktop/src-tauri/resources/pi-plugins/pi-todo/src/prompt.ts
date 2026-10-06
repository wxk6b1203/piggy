/**
 * 系统提示词贡献 + 主动激活的提醒文案。
 *
 * pi 没有 `registerPromptContribution` 这个 API（pi-guardrails 里的同名函数是它自己写的
 * 本地辅助函数）。真正的接口是 `before_agent_start` 事件里那个**可改**的
 * `systemPromptOptions.sections`（`core/system-prompt.ts:9-43`，节名要匹配
 * `/^[a-z][a-z0-9_-]*$/` 且不能叫 `preamble`）。这一节每轮重写：
 *
 * - 没激活 → 告诉模型"有这么个东西、什么条件下该开"；
 * - 已激活 → 换成"清单纪律"；
 * - `promptGuidance: false` → 删掉这一节（不是留一句空话）。
 *
 * 为什么值得单独占一节提示词：加载器工具只有在"模型知道它存在"时才有意义。
 * 工具的 `promptSnippet` 只提供一行；"什么时候该开/不该开"需要几行。
 */

import type { BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent';

import { ENABLE_TOOL, WRITE_TOOL } from './activation.js';
import type { TodoConfig } from './config.js';
import type { TodoState } from './state.js';

/** 提示词节名（`system-prompt.ts` 的命名规则：小写字母开头，`[a-z0-9_-]`）。 */
export const PROMPT_SECTION = 'pi-todo';

/**
 * 组装这一节的正文。
 *
 * @param state - 会话状态（决定说"怎么开"还是"怎么维护"）
 * @param cfg - 生效配置
 * @returns 节正文（Markdown 片段）
 */
export function promptSection(state: TodoState, cfg: TodoConfig): string {
	if (state.activated) {
		const current = state.todos;
		const lines = [
			`The todo list is ACTIVE in this session (activated via \`${ENABLE_TOOL}\`).`,
			`- Keep it current: send the ENTIRE list with \`${WRITE_TOOL}\`; it replaces the previous list.`,
			'- One todo per concrete step; mark a todo `completed` the moment it is done, not in a batch at the end.',
			cfg.allowParallelInProgress
				? '- Mark every task being actively worked on `in_progress`; parallel work may mark several at once.'
				: '- Keep at most ONE todo `in_progress` at a time.',
			`- A call is rejected if the list is identical to the current one${cfg.enforceComplexity ? ', or if the list is too small to be a plan (see the tool description for the exact rule)' : ''}.`,
		];
		if (current && current.length > 0) {
			lines.push(`Current list (${current.length} items): ${current.map((t) => `${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '} ${t.content}`).join(' | ')}`);
		}
		return lines.join('\n');
	}
	return [
		'pi-todo is installed but its list tool is NOT active.',
		`- For genuinely multi-step work (several concrete steps worth tracking), call \`${ENABLE_TOOL}\` first; \`${WRITE_TOOL}\` becomes available on the next request and stays available for the session.`,
		'- Do NOT activate for trivial single-step tasks. Activation is rejected when the request shows no multi-step evidence and little work has happened yet — in that case just do the task.',
		'- The user can always ask for a task list explicitly; that always authorizes activation.',
	].join('\n');
}

/**
 * 把这一节写进（或从）本轮的系统提示词。
 *
 * @param event - `before_agent_start` 事件
 * @param state - 会话状态
 * @param cfg - 生效配置
 * @returns 实际写进去的正文（没写则 `null`，调试与测试用）
 */
export function applyPromptSection(
	event: BeforeAgentStartEvent,
	state: TodoState,
	cfg: TodoConfig,
): string | null {
	const sections = event.systemPromptOptions.sections ?? {};
	if (!cfg.promptGuidance) {
		// 关掉时必须**删掉**：sections 是跨轮累积的，只"不再写"会留下上一轮的旧文本
		if (PROMPT_SECTION in sections) delete sections[PROMPT_SECTION];
		event.systemPromptOptions.sections = sections;
		return null;
	}
	const text = promptSection(state, cfg);
	sections[PROMPT_SECTION] = text;
	event.systemPromptOptions.sections = sections;
	return text;
}

/**
 * 主动激活时发给模型的提醒（`pi.sendMessage` + `deliverAs: "steer"`）。
 *
 * 为什么用 `steer`：`followUp` 要等这一轮跑完、`nextTurn` 要等用户下次发言
 * （pi-guardrails 的 README 把这三个的差别写得很清楚）。我们要的是"当下就提醒"。
 *
 * @param toolCalls - 已经跑完的工具调用数（提醒里报出真实数字）
 * @param cfg - 生效配置
 * @returns 提醒正文
 */
export function nudgeText(toolCalls: number, cfg: TodoConfig): string {
	return (
		`[pi-todo] ${toolCalls} tool calls have run for this request and no todo list exists yet. ` +
		`This looks like multi-step work — the todo list tool has been activated for you: send the ENTIRE list with ` +
		`\`${WRITE_TOOL}\` (one item per remaining concrete step, exactly one ` +
		`\`in_progress\`${cfg.allowParallelInProgress ? ', or several if work truly runs in parallel' : ''}). ` +
		`If the remaining work is genuinely a single step, ignore this and finish directly.`
	);
}
