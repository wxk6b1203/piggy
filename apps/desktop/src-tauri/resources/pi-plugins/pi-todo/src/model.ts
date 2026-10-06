/**
 * 清单的数据模型与校验。
 *
 * 这是 DSH `dsh-tool-todo` 的**逐条对照实现**（`packages/todo/tool-todo/src/index.ts:91-111`
 * 的 `toTodoList` / `:113-120` 的投影 schema / `:26` 的三态枚举）。刻意保持：
 *
 * - **整表替换**：每次调用提交**完整**清单，没有局部更新、没有按条编辑、没有稳定 id
 *   （DSH README「Known Limitations」第 3 条：`Whole-list replacement is the only operation`）；
 * - **三态**：`pending` / `in_progress` / `completed`；
 * - **错误文案与 DSH 逐字一致** —— 模型在两套实现下看到的失败原因必须是同一句话，
 *   否则"换到 pi 上行为变了"会被误判成模型不听话。
 *
 * 本文件是**纯函数**：不碰 pi、不碰 fs、不碰时钟。约束（复杂度闸门）在
 * `complexity.ts`，本文件只管"这份清单本身是不是合法的清单"。
 */

/** 一条任务的生命周期状态（DSH `TodoItem['status']`）。 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed';

/** 三态的运行期集合（校验与 schema 共用一处）。 */
export const TODO_STATUSES = ['pending', 'in_progress', 'completed'] as const;

/**
 * 清单里的一项。
 *
 * DSH 刻意只留 `content` + `status`（`src/types.ts:14-24`：**没有** id / priority /
 * activeForm —— 整表替换下条目不需要稳定身份）。本仓照抄，不扩展字段。
 */
export interface TodoItem {
	/** 要做什么 —— 一行祈使句，UI 直接显示 */
	content: string;
	/** 生命周期状态；并行工作时可以有多条 `in_progress` */
	status: TodoStatus;
}

/** 三态计数（DSH 成功回执里就是这三个数）。 */
export interface TodoCounts {
	pending: number;
	inProgress: number;
	completed: number;
}

/** 模型提交的**未校验**条目：任何字段都可能缺失或类型不对。 */
export interface RawTodoItem {
	content?: unknown;
	status?: unknown;
}

/**
 * 校验并规范化整份清单。规则与 DSH 完全一致，外加一条本仓的上限防呆。
 *
 * @param raw - 模型提交的清单（schema 已经挡掉了未知字段，这里挡值约束）
 * @param allowParallel - 是否允许多条同时 `in_progress`
 * @param maxItems - 单份清单的条目上限（防呆；DSH 没有这条，见 README「与 DSH 的差异」）
 * @returns 规范化后的清单（content 已 trim）
 * @throws Error - 文案与 DSH 逐字一致，外加 `too many todos`
 */
export function toTodoList(raw: readonly RawTodoItem[], allowParallel: boolean, maxItems: number): TodoItem[] {
	if (raw.length > maxItems) {
		throw new Error(`invalid todos: too many items (got ${raw.length}, at most ${maxItems})`);
	}
	const todos: TodoItem[] = [];
	const seen = new Set<string>();
	let active = 0;
	for (const item of raw) {
		const content = typeof item.content === 'string' ? item.content.trim() : '';
		if (content.length === 0) {
			throw new Error('invalid todo: `content` must be a non-empty string');
		}
		if (seen.has(content)) {
			throw new Error(`invalid todos: duplicate content ${JSON.stringify(content)}`);
		}
		seen.add(content);
		if (item.status === 'in_progress') active++;
		todos.push({ content, status: item.status as TodoItem['status'] });
	}
	if (!allowParallel && active > 1) {
		throw new Error(`invalid todos: at most one task may be in_progress (got ${active})`);
	}
	return todos;
}

/** 数一遍三态（DSH `src/index.ts:211` 的 `count`）。 */
export function countTodos(todos: readonly TodoItem[]): TodoCounts {
	let pending = 0;
	let inProgress = 0;
	let completed = 0;
	for (const t of todos) {
		if (t.status === 'completed') completed++;
		else if (t.status === 'in_progress') inProgress++;
		else pending++;
	}
	return { pending, inProgress, completed };
}

/**
 * DSH 的成功回执原文（`src/index.ts:200`）：
 * `Updated todo list: <pending> pending, <inProgress> in progress, <completed> completed.`
 *
 * Piggy 侧有一条测试直接断言这个格式（`apps/desktop/src/test/todo-model.test.ts`），
 * 改这里就会红 —— 界面上的「3 待处理 · 1 进行中」与模型看到的回执必须能对上账。
 */
export function renderCounts(counts: TodoCounts): string {
	return `Updated todo list: ${counts.pending} pending, ${counts.inProgress} in progress, ${counts.completed} completed.`;
}

/**
 * 两份清单是否**逐条相同**（用于拒绝原地重写的空操作）。
 *
 * 为什么值得单独一条规则：整表替换下，"再写一遍一模一样的清单"只花 token、
 * 不改变任何状态，却在会话里留下一次调用。DSH 不拦（它的 diff 模型只会显示
 * 「清单没有变化」），本仓默认拦掉，可用 `rejectNoopWrites: false` 关。
 */
export function sameTodoList(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		const x = a[i];
		const y = b[i];
		if (!x || !y) return false;
		if (x.content !== y.content || x.status !== y.status) return false;
	}
	return true;
}

/** 从任意 JSON 里读出清单（会话条目回放用；形状不对返回 `null`，绝不猜）。 */
export function readTodoList(value: unknown): TodoItem[] | null {
	if (!Array.isArray(value)) return null;
	const out: TodoItem[] = [];
	for (const raw of value) {
		if (typeof raw !== 'object' || raw === null) return null;
		const item = raw as { content?: unknown; status?: unknown };
		if (typeof item.content !== 'string') return null;
		if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') return null;
		out.push({ content: item.content, status: item.status });
	}
	return out;
}
