/**
 * 会话内的状态：激活与否、当前清单、本轮的证据计数。
 *
 * ## 状态放哪：会话条目，不是内存
 *
 * pi 的扩展**没有** key-value 存储（docs/extensions.md 只说 `pi.appendEntry`）。
 * 官方的两个例子（`examples/extensions/todo.ts`、plan-mode）都是同一套路：
 * **内存里持有 + 从会话分支重建**。本仓照做，但把重建的根据收窄成两条自定义条目：
 *
 * | 条目 `customType` | 数据 | 谁读 |
 * |---|---|---|
 * | `pi-todo/state` | `{activated, by, at}` | 本扩展：恢复"已经开过清单"这件事 |
 * | `todo/write`    | `{todos}`            | **Piggy**：整表快照（与 DSH 的事件同名同形） |
 *
 * 为什么 `todo/write` 这个名字要和 DSH 一模一样：DSH 把清单放在**事件**里
 * （`packages/todo/tool-todo/src/types.ts:26-31` 的 `todo/write` 事件声明），UI 从
 * 事件流折叠出「当前计划」。Piggy 的 todo 面板就是同一条链路的移植 ——
 * 事件名一致，两边的投影逻辑才可能逐行对照。
 *
 * ## 分支正确性
 *
 * `ctx.sessionManager.getBranch()` 返回的是**活动分支**（叶子→根，见
 * `core/session-manager.ts:1467-1475`），所以分支/回退之后重建出来的状态
 * 天然对得上"这条历史线上到底发生过什么"—— 这正是把状态放进会话条目、
 * 而不是放进内存或外部文件的原因。
 */

import type { ExtensionContext, SessionEntry } from '@earendil-works/pi-coding-agent';

import { readTodoList, type TodoItem } from './model.js';

/** 激活记录的条目名。 */
export const STATE_ENTRY = 'pi-todo/state';
/** 清单快照的条目名（**与 DSH 的会话事件同名**）。 */
export const WRITE_ENTRY = 'todo/write';

/** 激活记录的数据。 */
export interface ActivationRecord {
	activated: boolean;
	/** 谁激活的：`model`（模型自己调 todo_enable）/ `proactive`（插件按工作量主动激活） */
	by: 'model' | 'proactive';
	/** 激活时依据的证据摘要（事后可查"当时凭什么放行"） */
	evidence: string;
	at: number;
}

/** 一轮（agent run）内的证据计数。 */
export interface RunState {
	/** 本轮用户的原始请求（`before_agent_start` 给的） */
	prompt: string;
	/** 本轮已执行完的工具调用数 */
	toolCalls: number;
	/** 本轮是否已经发过主动激活提醒（防自激） */
	nudged: boolean;
}

/** 扩展的会话内状态。 */
export class TodoState {
	/** `todo_write` 是否已激活 */
	activated = false;
	/** 激活依据（人话，写进调试日志与 /todos） */
	activationEvidence = '';
	/** 最近一次写入的清单（`null` = 本次会话还没写过） */
	todos: TodoItem[] | null = null;
	/** 本轮证据 */
	run: RunState = { prompt: '', toolCalls: 0, nudged: false };

	/** 开新一轮：换 prompt、清零计数。 */
	beginRun(prompt: string): void {
		this.run = { prompt, toolCalls: 0, nudged: false };
	}

	/** 记一次工具执行，返回本轮累计次数。 */
	noteToolCall(): number {
		this.run.toolCalls += 1;
		return this.run.toolCalls;
	}

	/** 记下激活（幂等：重复调用不改依据）。 */
	markActivated(by: ActivationRecord['by'], evidence: string): boolean {
		if (this.activated) return false;
		this.activated = true;
		this.activationEvidence = `${by}: ${evidence}`;
		return true;
	}

	/**
	 * 从活动分支重建状态（`session_start` / `session_tree` 时调用）。
	 *
	 * 顺序很关键：`getBranch()` 是**叶子→根**，所以第一次命中的就是"最新的那条"。
	 *
	 * @param ctx - 扩展上下文（只读会话管理器）
	 * @returns 重建摘要（调试/测试用）
	 */
	rebuildFromBranch(ctx: ExtensionContext): { activated: boolean; todos: number | null; branchEntries: number } {
		const branch = readBranch(ctx);
		let activation: ActivationRecord | null = null;
		let list: TodoItem[] | null = null;
		let sawWrite = false;
		for (const entry of branch) {
			if (entry.type !== 'custom') continue;
			if (!activation && entry.customType === STATE_ENTRY) {
				activation = readActivation(entry.data);
			}
			if (!sawWrite && entry.customType === WRITE_ENTRY) {
				sawWrite = true;
				const data = entry.data as { todos?: unknown } | undefined;
				list = readTodoList(data?.todos) ?? null;
			}
			if (activation && sawWrite) break;
		}
		this.activated = activation?.activated === true;
		this.activationEvidence = activation ? activation.evidence : '';
		this.todos = list;
		return { activated: this.activated, todos: list ? list.length : null, branchEntries: branch.length };
	}
}

/**
 * 读活动分支。会话管理器在扩展的只读类型里就有 `getBranch()`，所以**不需要**像
 * pi-subagents 那样去够内部 API（它为了读 `buildSessionContext` 留了一处 SAFETY 注释）。
 * 拿不到（老 pi / 未落盘的会话）时返回空数组 —— 状态退化成"本进程内存里知道的那些"。
 */
function readBranch(ctx: ExtensionContext): SessionEntry[] {
	const manager = ctx?.sessionManager as { getBranch?: () => SessionEntry[] } | undefined;
	if (!manager || typeof manager.getBranch !== 'function') return [];
	try {
		return manager.getBranch() ?? [];
	} catch {
		return [];
	}
}

/** 从条目数据里读激活记录（形状不对 → `null`，绝不猜）。 */
function readActivation(data: unknown): ActivationRecord | null {
	if (typeof data !== 'object' || data === null) return null;
	const d = data as Partial<ActivationRecord>;
	if (typeof d.activated !== 'boolean') return null;
	return {
		activated: d.activated,
		by: d.by === 'proactive' ? 'proactive' : 'model',
		evidence: typeof d.evidence === 'string' ? d.evidence : '',
		at: typeof d.at === 'number' ? d.at : 0,
	};
}
