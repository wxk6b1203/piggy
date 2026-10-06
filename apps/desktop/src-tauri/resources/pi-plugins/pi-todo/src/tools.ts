/**
 * 两个工具的定义：加载器 `todo_enable` 与干活的 `todo_write`。
 *
 * ## 模型看到的东西（逐字对照 DSH）
 *
 * `todo_write` 的 description 是 DSH 原文的搬运（`packages/todo/tool-todo/src/index.ts:45-78`
 * 的 `DESCRIPTION_HEAD` / `_PARALLEL` / `_SINGLE` / `_TAIL` 与 `describe()`），
 * 连"并行还是单活跃"决定哪一段的规则都一样。**唯一新增的一段**是最后那句闸门说明
 * —— DSH 没有闸门所以不需要说，我们有，模型必须知道"可能被拒以及为什么"。
 *
 * ## 参数用 TypeBox，不引入新依赖
 *
 * pi 把 `typebox` 作为虚拟模块交给扩展（`core/extensions/virtual-modules.ts:6,14-16`），
 * 所以 `import { Type } from 'typebox'` 在 pi 里一定能解析。pi 自己的例子用
 * `@earendil-works/pi-ai` 的 `StringEnum`，但那个模块对本仓只是"顺带可用"，
 * 用 `Type.Union([Type.Literal(...)])` 能达到同样的 JSON Schema 效果
 * （`anyOf` + `const`），却把依赖面收窄到只剩 `typebox`。
 */

import type { ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type, type Static } from 'typebox';

import { ensureLoaderAdvertised, ENABLE_TOOL, WRITE_TOOL, type SyncOptions } from './activation.js';
import {
	describeSignals,
	evaluateActivation,
	evaluateWrite,
	rejectionMessage,
	type ComplexityEvidence,
} from './complexity.js';
import type { TodoConfig } from './config.js';
import {
	countTodos,
	renderCounts,
	sameTodoList,
	TODO_STATUSES,
	toTodoList,
	type TodoCounts,
	type TodoItem,
	type TodoStatus,
} from './model.js';
import { STATE_ENTRY, WRITE_ENTRY, type ActivationRecord, type TodoState } from './state.js';

/* ────────────────────────── schema ────────────────────────── */

/** 一条 todo 的参数 schema（`additionalProperties: false`：未知字段在 schema 边界就失败）。 */
const TodoItemParams = Type.Object(
	{
		content: Type.String({ description: 'What the task is — a short imperative line.' }),
		status: Type.Union(
			TODO_STATUSES.map((s) => Type.Literal(s)),
			{ description: 'pending (not started) | in_progress (now) | completed (done).' },
		),
	},
	{ additionalProperties: false },
);

/** `todo_write` 的参数：一个必填的整表数组。 */
export const TodoWriteParams = Type.Object(
	{
		todos: Type.Array(TodoItemParams, {
			description: 'The COMPLETE task list, replacing any previous list.',
		}),
	},
	{ additionalProperties: false },
);

export type TodoWriteInput = Static<typeof TodoWriteParams>;

/** `todo_enable` 没有参数（与 `subagents_enable` 同款空对象 schema）。 */
export const TodoEnableParams = Type.Object({}, { additionalProperties: false });

/** `todo_write` 的结果 details（Piggy 与会话回放都用得上的结构化数据）。 */
export interface TodoWriteDetails {
	todos: TodoItem[];
	counts: TodoCounts;
	/** 写入序号（本次会话第几次写） */
	write: number;
}

/** `todo_enable` 的结果 details。 */
export interface TodoEnableDetails {
	enabled: string[];
	evidence: string;
	alreadyEnabled: boolean;
}

/* ────────────────────────── description ────────────────────────── */

const DESCRIPTION_HEAD =
	'Record and update a structured task list for the current work. Send the ENTIRE ' +
	'list every call — it REPLACES the previous list (there are no partial updates, ' +
	'no per-item edits). Use it to plan multi-step work and show progress: add one ' +
	'todo per concrete step before you start. ';

const DESCRIPTION_PARALLEL =
	'Mark every todo being actively worked ' +
	'on `in_progress` — several at once when work genuinely runs in parallel (e.g. ' +
	'concurrent subagents or background commands), one for sequential work; while ' +
	'work remains, at least one task should be `in_progress`. ';

const DESCRIPTION_SINGLE =
	'Keep AT MOST ONE todo `in_progress` at a ' +
	'time; while work remains, exactly one active task should be `in_progress`. ';

const DESCRIPTION_TAIL =
	'Mark a todo ' +
	'`completed` the moment it is done (do not batch completions), and allow no ' +
	'`in_progress` item only once all work is complete. Skip the list for trivial ' +
	'single-step tasks. Statuses: `pending` (not started), `in_progress` (being ' +
	'worked on now), `completed` (finished).';

/**
 * 本仓新增的那一段：把闸门说清楚。
 *
 * @param cfg - 生效配置（阈值会原样念给模型听）
 * @returns description 的最后一段
 */
function descriptionGate(cfg: TodoConfig): string {
	if (!cfg.enforceComplexity) {
		return ' This deployment does not gate the list by task size.';
	}
	return (
		` This deployment enforces a complexity gate: a call is rejected unless the list itself shows a plan ` +
		`(at least ${cfg.minPlanItems} items), or the current request clearly asks for a task list, or the request ` +
		`already looks multi-step (several sentences / steps / workflow connectives), or enough work has already ` +
		`run in this request. Rejections name the missing evidence; do not retry the same call — either do the ` +
		`task without a list or wait until more of the work has happened.`
	);
}

/**
 * 组装 `todo_write` 的 description（DSH `describe()` 的等价物）。
 *
 * @param allowParallel - 是否允许多条 `in_progress`
 * @param cfg - 生效配置
 * @returns 模型看到的完整 description
 */
export function describeTodoWrite(allowParallel: boolean, cfg: TodoConfig): string {
	const gate = descriptionGate(cfg);
	return (
		DESCRIPTION_HEAD + (allowParallel ? DESCRIPTION_PARALLEL : DESCRIPTION_SINGLE) + DESCRIPTION_TAIL + gate
	);
}

/** `todo_enable` 的 description：什么时候该激活、什么时候别碰。 */
const ENABLE_HEAD =
	'Enable the todo list tool (`todo_write`) for this session. Call this when the current request is genuinely ' +
	'multi-step work — several concrete steps that must be tracked — and you want a visible plan that survives ' +
	'across turns. ';

/** 闸门关着时**不能**说"会被拒" —— 那是假话（模型会白犹豫一轮）。 */
const ENABLE_GATED =
	'Todos are NOT for trivial single-step tasks: this call is rejected when the request shows no multi-step ' +
	'evidence and little work has happened yet. ';

const ENABLE_UNGATED =
	'This deployment does not gate the call by task size, but a todo list is still only useful for work with ' +
	'several concrete steps; skip it for trivial single-step tasks. ';

const ENABLE_TAIL =
	'Activating costs one call; `todo_write` becomes available on the next model request and stays available ' +
	'for the rest of the session.';

/**
 * 组装加载器的 description。与 `todo_write` 的 `describeTodoWrite` 同一个道理：
 * **描述里的话必须与当前配置一致**，否则模型会按一句假话做决定。
 *
 * @param enforceComplexity - 闸门是否打开（默认关闭）
 * @returns 模型看到的 description
 */
export function describeTodoEnable(enforceComplexity: boolean): string {
	return ENABLE_HEAD + (enforceComplexity ? ENABLE_GATED : ENABLE_UNGATED) + ENABLE_TAIL;
}

/** 加载器的一句话摘要（`promptSnippet`：没有它，自定义工具不会出现在"可用工具"一节）。 */
export const ENABLE_SNIPPET =
	'pi-todo is installed. For genuinely multi-step work, call todo_enable to activate the todo_write plan tool; ' +
	'skip it for trivial single-step tasks.';

/** 激活后追加的 guideline（`promptGuidelines`：工具在册时进系统提示词的 Guidelines）。 */
export const WRITE_GUIDELINES = [
	'Send the ENTIRE todo list on every todo_write call; it replaces the previous list.',
	'Mark a todo completed the moment it is done — do not batch completions at the end.',
	'While work remains, keep exactly one todo in_progress (or several only when work truly runs in parallel).',
];

/* ────────────────────────── deps ────────────────────────── */

/** 两个工具需要的外部动作（由 `index.ts` 注入，测试里可以换成假的）。 */
export interface ToolDeps {
	config: TodoConfig;
	state: TodoState;
	/** 动态工具激活是否可用 */
	sync: SyncOptions;
	/** 激活成功后的副作用（写会话条目 + 同步工具集），返回是否发生了变化 */
	activate: (by: ActivationRecord['by'], evidence: string) => boolean;
	/** 追加一条会话条目（`pi.appendEntry`） */
	appendEntry: (customType: string, data: unknown) => void;
	/** 调试日志 */
	debug: (...args: unknown[]) => void;
}

/* ────────────────────────── todo_enable ────────────────────────── */

/**
 * 加载器工具。
 *
 * @param deps - 外部动作
 * @returns 工具定义
 */
export function makeEnableTool(deps: ToolDeps): ToolDefinition<typeof TodoEnableParams, TodoEnableDetails> {
	const { config, state, debug } = deps;
	return {
		name: ENABLE_TOOL,
		label: 'Enable todo list',
		description: describeTodoEnable(config.enforceComplexity),
		promptSnippet: ENABLE_SNIPPET,
		parameters: TodoEnableParams,
		async execute(_toolCallId: string, _params, _signal, _onUpdate, _ctx: ExtensionContext) {
			const evidence: ComplexityEvidence = {
				prompt: state.run.prompt,
				turnToolCalls: state.run.toolCalls,
			};
			if (state.activated) {
				debug('todo_enable: already active');
				return {
					content: [{ type: 'text' as const, text: `Already enabled: ${WRITE_TOOL}.` }],
					details: { enabled: [WRITE_TOOL], evidence: state.activationEvidence, alreadyEnabled: true },
				};
			}
			if (config.enforceComplexity) {
				const verdict = evaluateActivation(evidence, config);
				if (!verdict.ok) {
					debug(`todo_enable refused: ${verdict.missing.join('; ')}`);
					// 抛错 = pi 的失败工具结果（agent-loop 的 createErrorToolResult），
					// 模型会看到这句话并据此决定"直接干活"还是"先干点活再来"
					throw new Error(rejectionMessage(ENABLE_TOOL, verdict));
				}
				const why = `${describeSignals(verdict.signals)} · ${verdict.reasons.join(' · ')}`;
				deps.activate('model', why);
				return {
					content: [
						{
							type: 'text' as const,
							text:
								`Enabled: ${WRITE_TOOL}. It is available on the next model request. ` +
								`Send the ENTIRE list on every call. Note: this deployment rejects lists that do not ` +
								`look like a plan (fewer than ${config.minPlanItems} items with no other multi-step evidence).`,
						},
					],
					details: { enabled: [WRITE_TOOL], evidence: why, alreadyEnabled: false },
				};
			}
			const why = 'complexity gate disabled by configuration';
			deps.activate('model', why);
			return {
				content: [{ type: 'text' as const, text: `Enabled: ${WRITE_TOOL}. It is available on the next model request.` }],
				details: { enabled: [WRITE_TOOL], evidence: why, alreadyEnabled: false },
			};
		},
	};
}

/* ────────────────────────── todo_write ────────────────────────── */

/**
 * 干活工具：整表替换写入。
 *
 * 失败顺序是刻意的（**先合规、后复杂度、最后空操作**）：
 *   1. 清单本身不合法（空内容/重复/多条 in_progress）→ 与 DSH 逐字一致的错误；
 *   2. 复杂度不够 → 本仓特有的拒绝，文案里带上"差在哪"；
 *   3. 与上一份一模一样 → 空操作，省一次无意义的 token 往返。
 *
 * @param deps - 外部动作
 * @returns 工具定义
 */
export function makeWriteTool(deps: ToolDeps): ToolDefinition<typeof TodoWriteParams, TodoWriteDetails> {
	const { config, state, debug } = deps;
	let writes = 0;
	return {
		name: WRITE_TOOL,
		label: 'Update todo list',
		description: describeTodoWrite(config.allowParallelInProgress, config),
		promptGuidelines: WRITE_GUIDELINES,
		parameters: TodoWriteParams,
		// 清单是共享状态：并发执行会让"整表替换"的语义失去意义
		executionMode: 'sequential',
		async execute(_toolCallId: string, params: TodoWriteInput, _signal, _onUpdate, _ctx: ExtensionContext) {
			const raw = Array.isArray(params.todos) ? params.todos : [];
			// 1) 值约束（DSH 同款文案）
			const todos = toTodoList(raw, config.allowParallelInProgress, config.maxItems);
			// 2) 复杂度闸门（本仓新增）
			if (config.enforceComplexity) {
				const verdict = evaluateWrite({ prompt: state.run.prompt, turnToolCalls: state.run.toolCalls, items: todos.length }, config);
				if (!verdict.ok) {
					debug(`todo_write refused: ${verdict.missing.join('; ')}`);
					throw new Error(rejectionMessage(WRITE_TOOL, verdict));
				}
			}
			// 3) 空操作
			if (config.rejectNoopWrites && state.todos && sameTodoList(state.todos, todos)) {
				throw new Error(
					`pi-todo: ${WRITE_TOOL} refused — the list is identical to the current one ` +
						`(${todos.length} items, unchanged). Nothing to record; skip the call.`,
				);
			}
			// 写入：先落会话条目（可回放），再更新内存状态
			deps.appendEntry(WRITE_ENTRY, { todos });
			state.todos = todos;
			if (!state.activated) {
				// 只可能出现在"宿主不支持动态激活"的降级路径上（工具常驻）。
				// 记一笔，免得状态与事实不符。
				state.markActivated('model', 'eager tool call (dynamic activation unavailable)');
			}
			writes += 1;
			const counts = countTodos(todos);
			const text = renderCounts(counts);
			debug(`todo_write #${writes}: ${text}`);
			return {
				content: [{ type: 'text' as const, text }],
				details: { todos, counts, write: writes },
			};
		},
	};
}

/** 供 `index.ts` 在 `before_agent_start` 里复用（避免它直接依赖 activation 模块的细节）。 */
export { ensureLoaderAdvertised };
export type { TodoStatus };
