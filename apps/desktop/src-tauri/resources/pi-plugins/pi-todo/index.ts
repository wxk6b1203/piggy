/**
 * pi-todo —— 把 DSH 的 `todo_write` 任务清单搬到 pi，并补上 DSH 没有的两件事：
 * **复杂度闸门**与**主动激活**。
 *
 * ## 三条设计来源（都读过源码，改代码前请先读 README / DESIGN）
 *
 * 1. **清单契约**逐字来自 DSH `packages/todo/tool-todo`：
 *    整表替换、`content` + 三态 `status`、成功回执 `Updated todo list: …`。
 * 2. **动态激活**来自 pi 的 `pi-subagents`（`src/extension/tool-activation.js`）：
 *    常驻的加载器工具 + `pi.setActiveTools`。pi ≥ 0.86.1 才有这三个 API。
 * 3. **复杂度闸门**是本仓自己的（DSH 只有描述里一句 "Skip the list for trivial
 *    single-step tasks"，代码里没有任何判定 —— 见 `src/complexity.ts` 顶部的引文）。
 *
 * ## 一句话说清模型看到的行为
 *
 *   默认：只有 `todo_enable` 在工具表里。多步活儿 → 调它 → 下一轮起 `todo_write` 可用
 *   → 每次提交整份清单。清单太短且没有任何"这活儿多步"的证据 → 被拒，且拒得有理有据。
 *
 * ## 用法
 *
 *   pi -e /path/to/pi-todo/index.ts
 * 或放进自动发现目录（支持 /reload 热更新）：
 *   ~/.pi/agent/extensions/pi-todo/index.ts
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

import {
	ENABLE_TOOL,
	WRITE_TOOL,
	ensureLoaderAdvertised,
	restoreActivation,
	supportsDynamicTools,
	syncActivation,
	type SyncOptions,
} from './src/activation.js';
import { DEFAULT_CONFIG, resolveConfig, type TodoConfig } from './src/config.js';
import { evaluateActivation } from './src/complexity.js';
import { applyPromptSection, nudgeText } from './src/prompt.js';
import { STATE_ENTRY, TodoState, type ActivationRecord } from './src/state.js';
import { makeEnableTool, makeWriteTool } from './src/tools.js';

/** 主动激活提醒用的自定义消息类型（`display: true` → 界面上看得见）。 */
const NUDGE_TYPE = 'pi-todo/nudge';

/**
 * 命令行的三个开关。之所以只给三个：其余阈值都能用配置文件/环境变量调，
 * 而"要不要并行、要不要主动激活、要不要执行闸门"才是真正常用的三挡。
 * 注意闸门（`--todo-enforce`）是**显式打开**的一方 —— 它默认关闭（见 src/config.ts）。
 *
 * @param pi - 扩展 API
 * @returns 解析出来的最高优先级配置来源
 */
function resolveFlags(pi: ExtensionAPI): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const parallel = pi.getFlag('todo-parallel');
	if (typeof parallel === 'boolean') out['allowParallelInProgress'] = parallel;
	const noProactive = pi.getFlag('todo-no-proactive');
	if (noProactive === true) out['proactiveActivation'] = false;
	const enforce = pi.getFlag('todo-enforce');
	if (enforce === true) out['enforceComplexity'] = true;
	return out;
}

/**
 * 扩展入口。
 *
 * @param pi - pi 注入的扩展 API
 * @returns 便于 `/todos` 类命令与测试观察的内部句柄
 */
export default function piTodo(pi: ExtensionAPI) {
	// ── flag 先注册，再读值（pi 的取值发生在注册之后）──
	pi.registerFlag('todo-parallel', {
		description: 'pi-todo: allow several todos to be in_progress at once',
		type: 'boolean',
		default: false,
	});
	pi.registerFlag('todo-no-proactive', {
		description: 'pi-todo: never auto-activate the todo list after a long run of tool calls',
		type: 'boolean',
		default: false,
	});
	pi.registerFlag('todo-enforce', {
		description:
			'pi-todo: enforce the complexity gate for THIS run (reject lists that show no multi-step evidence)',
		type: 'boolean',
		default: false,
	});

	const { config, problems, configPath } = resolveConfig(resolveFlags(pi));
	const debug = (...args: unknown[]): void => {
		if (config.debug) console.error('[pi-todo]', ...args);
	};
	// 配置有问题就**吵**，不静默：这些字会跟 pi 的启动日志一起进 stderr
	for (const problem of problems) console.error(`[pi-todo] config: ${problem}`);
	if (problems.length > 0) console.error(`[pi-todo] config file: ${configPath}（该字段已回落到默认值）`);

	if (!config.enabled) {
		debug('disabled by configuration; not registering tools');
		return { config, configPath, problems, enabled: false as const };
	}

	const dynamic = supportsDynamicTools(pi);
	if (!dynamic) {
		// 不静默降级：说清楚"约束还在，但形态变了"
		console.warn(
			`[pi-todo] this pi build has no dynamic tool activation (needs ${ENABLE_TOOL} + getAllTools/getActiveTools/setActiveTools, pi >= 0.86.1); ` +
				`${WRITE_TOOL} stays always available and the complexity gate rejects short lists at execution time instead.`,
		);
	}
	const sync: SyncOptions = { dynamic, debug };
	const state = new TodoState();

	/** 激活 + 落条目 + 同步工具集。返回是否**发生了变化**。 */
	const activate = (by: ActivationRecord['by'], evidence: string): boolean => {
		const changed = state.markActivated(by, evidence);
		if (changed) {
			pi.appendEntry(STATE_ENTRY, {
				activated: true,
				by,
				evidence,
				at: Date.now(),
			} satisfies ActivationRecord);
			debug(`activated by ${by}: ${evidence}`);
		}
		syncActivation(pi, true, sync);
		return changed;
	};

	const deps = {
		config,
		state,
		sync,
		activate,
		appendEntry: (customType: string, data: unknown) => {
			pi.appendEntry(customType, data);
		},
		debug,
	};

	// ── 工具注册 ──
	// 两个都注册；`todo_write` 随后被 session_start 摘出活动集（潜伏）。
	pi.registerTool(makeEnableTool(deps));
	pi.registerTool(makeWriteTool(deps));

	// ── 会话生命周期：从活动分支重建（换会话 / 切分支 / fork 都走这里）──
	const restore = (label: string) => (ctx: ExtensionContext): undefined => {
		const summary = restoreActivation(pi, ctx, state, sync);
		debug(
			`${label}: activated=${summary.activated} todos=${summary.todos ?? 'none'} branchEntries=${summary.branchEntries}`,
		);
		return undefined;
	};
	pi.on('session_start', (_event, ctx) => restore('session_start')(ctx));
	pi.on('session_tree', (_event, ctx) => restore('session_tree')(ctx));

	// ── 每轮开始：记 prompt、复位计数、保证加载器在册、按需注入提示词节 ──
	pi.on('before_agent_start', (event) => {
		state.beginRun(typeof event.prompt === 'string' ? event.prompt : '');
		ensureLoaderAdvertised(pi, event, state.activated, sync);
		applyPromptSection(event, state, config);
		return undefined;
	});

	// ── 每次工具执行完：累计本轮证据；够了就主动激活并提醒 ──
	pi.on('tool_execution_end', () => {
		const calls = state.noteToolCall();
		if (!config.proactiveActivation || state.activated || state.run.nudged) return undefined;
		if (calls < config.proactiveAfterToolCalls) return undefined;
		// 主动激活用的还是**同一套**闸门（证据换成"本轮跑了这么多次工具"），
		// 不另立规则 —— 两条判定分叉是这类功能最容易烂掉的地方。
		const verdict = evaluateActivation({ prompt: state.run.prompt, turnToolCalls: calls }, config);
		if (!verdict.ok) return undefined;
		state.run.nudged = true;
		const changed = activate('proactive', `${calls} tool calls in one request`);
		if (!changed) return undefined;
		debug(`proactive activation at ${calls} tool calls; steering a reminder`);
		pi.sendMessage(
			{
				customType: NUDGE_TYPE,
				content: nudgeText(calls, config),
				display: true,
			},
			{ deliverAs: 'steer' },
		);
		return undefined;
	});

	// ── 用户侧入口：/todos 看当前清单（终端里唯一能"看见"状态的地方）──
	pi.registerCommand('todos', {
		description: 'pi-todo: show the current todo list and whether the tool is active',
		handler: async (_args: string, ctx) => {
			const head = state.activated
				? `${WRITE_TOOL} is active${state.activationEvidence ? `（${state.activationEvidence}）` : ''}`
				: `${WRITE_TOOL} is not active — call ${ENABLE_TOOL} (model) or let the run reach ${config.proactiveAfterToolCalls} tool calls`;
			const list = state.todos;
			if (!list || list.length === 0) {
				ctx.ui.notify(`${head}\n(no list written yet)`, 'info');
				return;
			}
			const body = list
				.map((t) => `${t.status === 'completed' ? '[x]' : t.status === 'in_progress' ? '[~]' : '[ ]'} ${t.content}`)
				.join('\n');
			ctx.ui.notify(`${head}\n${body}`, 'info');
		},
	});

	debug(
		`loaded. dynamicTools=${dynamic} parallel=${config.allowParallelInProgress} ` +
			`enforce=${config.enforceComplexity} minPlanItems=${config.minPlanItems} ` +
			`proactive=${config.proactiveActivation}/${config.proactiveAfterToolCalls} config=${configPath}`,
	);

	// 暴露给测试 / 未来的 /todo 类命令
	return {
		config,
		configPath,
		problems,
		enabled: true as const,
		state,
		activation: { activate, sync },
	};
}

export { DEFAULT_CONFIG, resolveConfig } from './src/config.js';
export { evaluateActivation, evaluateWrite, promptSignals, rejectionMessage } from './src/complexity.js';
export { countTodos, readTodoList, renderCounts, sameTodoList, TODO_STATUSES, toTodoList } from './src/model.js';
export { ENABLE_TOOL, WRITE_TOOL, supportsDynamicTools } from './src/activation.js';
export { STATE_ENTRY, WRITE_ENTRY, TodoState } from './src/state.js';
export type { ActivationRecord, RunState } from './src/state.js';
export type { ComplexityEvidence, ComplexityVerdict, PromptSignals } from './src/complexity.js';
export type { TodoConfig } from './src/config.js';
export type { TodoCounts, TodoItem, TodoStatus } from './src/model.js';
