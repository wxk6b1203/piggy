/**
 * 动态工具激活 —— "像 subagents 一样主动激活"的那一半。
 *
 * ## 这套机制是从哪来的
 *
 * pi 从 0.86.1 起给了三个 API：`pi.getAllTools()` / `pi.getActiveTools()` /
 * `pi.setActiveTools(names)`。`pi-subagents` 用它做了一个**加载器工具**：
 * 常驻的 `subagents_enable` 一被调用，才把真正干活的 `subagent` 放进活动工具集
 * （`pi-subagents/src/extension/tool-activation.js:112-171`：
 * `LOADER_NAME = "subagents_enable"`，`MINIMUM_DYNAMIC_TOOLS_VERSION = [0, 86, 1]`）。
 * 本扩展照搬这个形状：
 *
 * | 工具 | 常驻？ | 作用 |
 * |---|---|---|
 * | `todo_enable` | 是 | 加载器：模型判断"这活儿多步"时调用它 |
 * | `todo_write` | **否**（默认潜伏） | 真正写清单 |
 *
 * 潜伏是**真的潜伏**：`todo_enable` 没被调用之前，`todo_write` 根本不在模型的工具表里
 * （不是"调了再报错"）。这一点很关键 —— 工具表里的每一个 schema 都是每一轮请求的
 * 固定成本，而且一个永远躺在那里的 `todo_write` 会持续诱导模型去用它。
 *
 * ## 与 pi-subagents 的一处不同：谁说了算
 *
 * pi-subagents 把选择结果交给 pi 原生的"工具装载记录"（它读 `toolsAdded`/`toolsRemoved`
 * 这两条 pi 内部投影，注释里写着 `SAFETY: ... its read-only extension type omits it`）。
 * 本仓**不碰内部 API**：激活与否由我们自己的会话条目 `pi-todo/state` 说了算
 * （见 `state.ts`）—— 分支/回退后重建出来的状态因此是"这条历史线"上的真实状态。
 *
 * ## 宿主太老怎么办
 *
 * 没有这三个 API 时**不静默降级**：打一条明确的警告，然后把 `todo_write` 保持常驻
 * —— 此时"使用约束"仍然成立，只是从"工具表里没有"退化成"调了会被 execute 拒"
 * （闸门在 `complexity.ts`，与激活无关）。README「降级行为」一节写明了这个差别。
 */

import type { BeforeAgentStartEvent, ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

/** 加载器工具名（常驻）。 */
export const ENABLE_TOOL = 'todo_enable';
/** 干活工具名（默认潜伏）。 */
export const WRITE_TOOL = 'todo_write';
/** 动态工具激活所需的最低 pi 版本（`pi-subagents` 同款下限）。 */
export const MIN_DYNAMIC_TOOLS_VERSION = '0.86.1';

/** 宿主是否支持动态工具激活。 */
export function supportsDynamicTools(pi: ExtensionAPI): boolean {
	return (
		typeof pi.getAllTools === 'function' &&
		typeof pi.getActiveTools === 'function' &&
		typeof pi.setActiveTools === 'function'
	);
}

/** 把活动工具集同步成"当前状态该有的样子"。 */
export interface SyncOptions {
	/** 是否支持动态工具（不支持时只会保证加载器在册） */
	dynamic: boolean;
	/** 调试日志 */
	debug?: (message: string) => void;
}

/**
 * 同步活动工具集：`todo_write` 在册 ⇔ `activated`；加载器**永远**在册。
 *
 * 为什么加载器永远在册：它一旦掉出工具表，模型就再也没有把手把它拉回来了
 * （`todo_write` 是潜伏的）。pi-subagents 同样有这条不变量（`setSelection` 里
 * `if (!next.includes(LOADER_NAME)) next.push(LOADER_NAME)`）。
 *
 * @param pi - 扩展 API
 * @param activated - 目标状态
 * @param opts - 能力与日志
 * @returns 实际生效后的活动工具名（**读回来**的，不是我们以为写下去的）
 */
export function syncActivation(pi: ExtensionAPI, activated: boolean, opts: SyncOptions): string[] {
	if (!opts.dynamic) return pi.getActiveTools?.() ?? [];
	const available = new Set((pi.getAllTools?.() ?? []).map((tool) => tool.name));
	if (!available.has(ENABLE_TOOL)) {
		// 工具还没注册（或注册失败）：什么都不做，别把工具集改坏
		return pi.getActiveTools();
	}
	const next = new Set(pi.getActiveTools());
	next.add(ENABLE_TOOL);
	if (activated && available.has(WRITE_TOOL)) next.add(WRITE_TOOL);
	else next.delete(WRITE_TOOL);
	// 潜伏工具不能留在 `selectedTools` 里 —— 见 ensureLoaderAdvertised
	pi.setActiveTools([...next]);
	const applied = pi.getActiveTools();
	opts.debug?.(`syncActivation(${activated}) → [${applied.join(', ')}]`);
	return applied;
}

/**
 * `before_agent_start`：保证加载器出现在**这一轮**的系统提示词里。
 *
 * 为什么不能只靠 `setActiveTools`：`systemPromptOptions.selectedTools` 是每轮渲染
 * 提示词时现算的，扩展改了它就以它为准（`agent-session.ts:1708-1713`：
 * "If a handler edits selectedTools it wins over pi.setActiveTools()"）。
 * pi-subagents 在这里做同一件事（`tool-activation.js:158-169`），包括：
 *
 *   - 把加载器补进 `selectedTools`；
 *   - 把**潜伏**的 `todo_write` 从 `selectedTools` 里摘掉（否则它会以"可用工具"
 *     的身份出现在提示词里，潜伏就白做了）；
 *   - 顺带把加载器放回活动工具集。
 *
 * @param pi - 扩展 API
 * @param event - `before_agent_start` 事件（`systemPromptOptions` 可改）
 * @param activated - `todo_write` 当前是否激活
 * @param opts - 能力与日志
 */
export function ensureLoaderAdvertised(
	pi: ExtensionAPI,
	event: BeforeAgentStartEvent,
	activated: boolean,
	opts: SyncOptions,
): void {
	if (!opts.dynamic) return;
	const available = new Set((pi.getAllTools?.() ?? []).map((tool) => tool.name));
	if (!available.has(ENABLE_TOOL)) return;
	const options = event.systemPromptOptions;
	const selected = new Set(options.selectedTools);
	selected.add(ENABLE_TOOL);
	// 一改就得**两个方向都写对**：pi 里改过 `selectedTools` 之后就以它为准
	// （`agent-session.ts:1708-1713`），所以"激活了却没写进去"会让工具在提示词里消失，
	// 而"没激活却留着"更是直接把潜伏废掉。
	if (activated) selected.add(WRITE_TOOL);
	else selected.delete(WRITE_TOOL);
	options.selectedTools = [...selected];
	if (!pi.getActiveTools().includes(ENABLE_TOOL)) {
		pi.setActiveTools([...pi.getActiveTools(), ENABLE_TOOL]);
	}
}

/**
 * 会话开始/切分支后重建状态并同步工具集。
 *
 * @param pi - 扩展 API
 * @param ctx - 扩展上下文
 * @param state - 会话状态（`rebuildFromBranch` 会在原地更新它）
 * @param opts - 能力与日志
 * @returns 重建摘要
 */
export function restoreActivation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: { rebuildFromBranch: (ctx: ExtensionContext) => { activated: boolean; todos: number | null; branchEntries: number } },
	opts: SyncOptions,
): { activated: boolean; todos: number | null; branchEntries: number } {
	const summary = state.rebuildFromBranch(ctx);
	syncActivation(pi, summary.activated, opts);
	return summary;
}
