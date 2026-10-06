/**
 * 复杂度闸门 —— 本扩展相对 DSH 的**唯一一处实质性功能增强**。
 *
 * ## 为什么要有它
 *
 * DSH 的 `todo_write` 对使用时机**只有提示词层面的一句话**：
 *
 *   `Skip the list for trivial single-step tasks.`
 *   —— `packages/todo/tool-todo/src/index.ts:64`
 *
 * 代码里没有任何"这条活儿值不值得开清单"的判断（`:203-220` 的 `execute` 只校验
 * `exec.agent` 与"最多一条 in_progress"）。用户在 pi 上要的是**真的拦得住**的约束：
 * "todo 功能需要有一定的使用约束，要满足一定的复杂度才支持调用"。所以本模块把
 * 那句话变成一个**可观测、可复现、可解释**的判定。
 *
 * ## 判定用的证据（全部可观测，没有"猜"）
 *
 * | 证据 | 来源 | 说明 |
 * |---|---|---|
 * | `prompt` | `before_agent_start` 的 `event.prompt` | 这一轮用户的原始请求 |
 * | `turnToolCalls` | `tool_execution_end` 计数 | 本轮（agent run）已经真实跑了几次工具 |
 * | `items` | 模型提交的清单 | 只在 `todo_write` 时有值 |
 *
 * ## 打分规则（可解释、可测试）
 *
 * `promptSignals()` 把请求文本变成 4 个信号，`score` 是它们的加权和（上限 8）：
 *
 *   +2  枚举行 ≥3 条（`- ` / `1. ` / `1、` 开头的行）—— 用户自己列了步骤
 *   +1  句子 ≥2（≥4 时 +2）
 *   +1  流程连接词 ≥2（≥3 时 +2）：然后/接着/并且/同时/分别/先…再/以及/最后
 *   +1  长度 ≥240 字符（≥600 时 +2）
 *
 * **刻意不做**的事：不调模型打分（要额外请求、要花钱、结果不稳定）、不看仓库内容
 * （那要读盘、要猜用户在说什么）。分数只是**证据强弱**，最终由下面的闸门拍板。
 *
 * ## 闸门
 *
 * ```
 * todo_enable（激活）：explicit ‖ score ≥ enableMinScore(3) ‖ turnToolCalls ≥ enableMinToolCalls(3)
 * todo_write（写入）：items ≥ 2  且  ( items ≥ minPlanItems(3) ‖ explicit ‖ score ≥ writeMinScore(2)
 *                                      ‖ turnToolCalls ≥ smallPlanToolCalls(2) )
 * ```
 *
 * 读法：**清单自己有 3 条以上就自证多步**（最常见、也最该放行的路径）；两条时要别的
 * 证据兜底；一条直接拒（一条不是计划）。用户明说要清单时一律放行 —— 人的明确要求
 * 压过任何启发式，这是本模块唯一的"人工越权通道"。
 *
 * ## 诚实的边界
 *
 * 这是启发式，不是判定"任务是否复杂"的真理。一个措辞简短但实际要做十步的请求
 * （"把这个迁移到 v2"）会被打分低估 —— 但它通常会在跑了几次工具之后（`turnToolCalls`
 * 上来）通过，或者用户直接说一句"用 todo 跟一下"。拒绝文案会把**差在哪**说清楚，
 * 所以模型不会卡死，只会被告知"现在还不够格，先干活/或者别用"。
 */

/** 打分与闸门的阈值（可由配置覆盖，见 `config.ts`）。 */
export interface GateThresholds {
	/** 单份清单的最小条目数（低于它直接拒） */
	minPlanItems: number;
	/** 激活所需的最低提示词分数 */
	enableMinScore: number;
	/** 激活所需的本轮工具调用数（够了就不再要求提示词分数） */
	enableMinToolCalls: number;
	/** 少于 `minPlanItems` 条时，写入所需的提示词分数 */
	writeMinScore: number;
	/** 少于 `minPlanItems` 条时，写入所需的本轮工具调用数 */
	smallPlanToolCalls: number;
}

/** 判定用的证据。 */
export interface ComplexityEvidence {
	/** 本轮用户请求原文（拿不到就是空串 —— 空串会让分数为 0，不会误放行） */
	prompt: string;
	/** 本轮（agent run）已执行完的工具调用数 */
	turnToolCalls: number;
	/** 本次要写入的条目数；`todo_enable` 时没有清单，传 `undefined` */
	items?: number | undefined;
}

/** 从请求文本里量出来的信号（全部可复现：同一段文本永远同一组数）。 */
export interface PromptSignals {
	/** 用户明确要求任务清单 / 计划（人工越权通道） */
	explicit: boolean;
	/** 枚举行条数 */
	enumerated: number;
	/** 流程连接词出现次数 */
	connectives: number;
	/** 句子数 */
	sentences: number;
	/** 字符数（按码点算，中文按字） */
	length: number;
	/** 加权总分（0..8） */
	score: number;
}

/** 闸门结论。 */
export interface ComplexityVerdict {
	/** 是否放行 */
	ok: boolean;
	/** 放行/拒绝的原因（逐条），拒绝时会被拼进给模型看的错误文案 */
	reasons: string[];
	/** 差在哪 —— 只有拒绝时非空，直接告诉模型"补什么才能过" */
	missing: string[];
	/** 量出来的信号（调试与测试用） */
	signals: PromptSignals;
}

/** 用户明确要清单的说法。命中即放行（人工越权通道）。 */
const EXPLICIT_PATTERNS = [
	/todo\s*list/i,
	/to-?dos?\b/i,
	/task\s+list/i,
	/check\s*list/i,
	/checklist/i,
	/任务清单/,
	/任务列表/,
	/待办/,
	/勾选/,
	/跟踪任务/,
	/用\s*todo/i,
];

/** 流程连接词：出现得越多，"这件事由多步组成"的证据越强。 */
const CONNECTIVE_PATTERN =
	/然后|接着|之后|随后|并且|同时|分别|以及|最后|先[^。！？!?\n]{0,12}再|再[去来做跑写改]|and then|\bthen\b|after that|\balso\b|\bplus\b|\bfinally\b|\bnext\b/gi;

/** 一枚列表项的行首（`- ` / `* ` / `1. ` / `1、` / `1) `）。 */
const ENUMERATED_LINE = /^\s*(?:[-*•·]|\d+[.)、])\s+\S/;

/** 量请求文本的信号。**纯函数**：同样输入永远同样输出。 */
export function promptSignals(prompt: string): PromptSignals {
	const text = typeof prompt === 'string' ? prompt : '';
	const lines = text.split('\n');
	let enumerated = 0;
	for (const line of lines) {
		if (ENUMERATED_LINE.test(line)) enumerated++;
	}
	const connectives = (text.match(CONNECTIVE_PATTERN) ?? []).length;
	const sentences = text
		.split(/[。！？!?；;\n]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0).length;
	const length = [...text].length;
	const explicit = EXPLICIT_PATTERNS.some((re) => re.test(text));

	let score = 0;
	score += enumerated >= 3 ? 2 : 0;
	score += sentences >= 4 ? 2 : sentences >= 2 ? 1 : 0;
	score += connectives >= 3 ? 2 : connectives >= 2 ? 1 : 0;
	score += length >= 600 ? 2 : length >= 240 ? 1 : 0;
	return { explicit, enumerated, connectives, sentences, length, score: Math.min(8, score) };
}

/** 一行"证据账"：拒绝文案与调试输出共用，保证说的和算的是同一件事。 */
export function describeSignals(s: PromptSignals): string {
	return (
		`prompt score ${s.score}/8 ` +
		`(sentences ${s.sentences}, connectives ${s.connectives}, enumerated ${s.enumerated}, chars ${s.length})`
	);
}

/**
 * 激活闸门：`todo_enable` 该不该放行。
 *
 * @param ev - 证据（`items` 忽略）
 * @param t - 阈值
 * @returns 结论（`missing` 列出没满足的条件）
 */
export function evaluateActivation(ev: ComplexityEvidence, t: GateThresholds): ComplexityVerdict {
	const signals = promptSignals(ev.prompt);
	const reasons: string[] = [];
	const missing: string[] = [];
	if (signals.explicit) {
		reasons.push('the user asked for a task list');
		return { ok: true, reasons, missing, signals };
	}
	if (signals.score >= t.enableMinScore) reasons.push(`prompt score ${signals.score} ≥ ${t.enableMinScore}`);
	else missing.push(`prompt score ≥ ${t.enableMinScore} (got ${signals.score})`);
	if (ev.turnToolCalls >= t.enableMinToolCalls) {
		reasons.push(`${ev.turnToolCalls} tool calls already ran in this request`);
	} else {
		missing.push(`${t.enableMinToolCalls} tool calls in this request (got ${ev.turnToolCalls})`);
	}
	const ok = reasons.length > 0;
	return { ok, reasons, missing: ok ? [] : missing, signals };
}

/**
 * 写入闸门：`todo_write` 该不该放行。
 *
 * 顺序是刻意的：先看清单自己（`items ≥ minPlanItems` 自证多步），再看旁证。
 *
 * @param ev - 证据（必须带 `items`）
 * @param t - 阈值
 * @returns 结论
 */
export function evaluateWrite(ev: ComplexityEvidence, t: GateThresholds): ComplexityVerdict {
	const signals = promptSignals(ev.prompt);
	const items = ev.items ?? 0;
	const reasons: string[] = [];
	const missing: string[] = [];

	// 第 0 关：清单本身要成立。1 条不是计划 —— 这是 DSH 只写在描述里、
	// 而本仓真的拦下来的那一条。
	if (items < 2) {
		return {
			ok: false,
			reasons: [],
			missing: [`at least 2 todo items (got ${items}) — a single task is not a plan`],
			signals,
		};
	}
	// 第 1 关：3 条以上自证多步。
	if (items >= t.minPlanItems) {
		reasons.push(`${items} todo items ≥ ${t.minPlanItems}`);
		return { ok: true, reasons, missing, signals };
	}
	// 第 2 关：两条时要有旁证。
	reasons.push(`${items} todo items`);
	if (signals.explicit) {
		reasons.push('the user asked for a task list');
		return { ok: true, reasons, missing, signals };
	}
	missing.push('a request that explicitly asks for a task list');
	if (signals.score >= t.writeMinScore) reasons.push(`prompt score ${signals.score} ≥ ${t.writeMinScore}`);
	else missing.push(`prompt score ≥ ${t.writeMinScore} (got ${signals.score})`);
	if (ev.turnToolCalls >= t.smallPlanToolCalls) {
		reasons.push(`${ev.turnToolCalls} tool calls already ran in this request`);
	} else {
		missing.push(`${t.smallPlanToolCalls} tool calls in this request (got ${ev.turnToolCalls})`);
	}
	const ok = reasons.length > 1;
	return { ok, reasons, missing: ok ? [] : missing, signals };
}

/**
 * 拒绝时给模型看的文案。
 *
 * 三条纪律：
 *   1. **说清差在哪**（把 `missing` 原样列出来）—— 模型据此要么补步骤，要么放弃；
 *   2. **给替代动作**（"直接干活，别开清单"）—— 不能只丢一句"不行"；
 *   3. **不诱导绕过**（不说"你可以再试一次"这种废话，也不暗示改小阈值）。
 *
 * @param tool - 出错的动作名（`todo_write` / `todo_enable`）
 * @param verdict - 拒绝结论
 * @param extra - 额外一行（例如空操作拒绝）
 * @returns 抛给模型看的错误文案
 */
export function rejectionMessage(tool: string, verdict: ComplexityVerdict, extra?: string): string {
	const head = `pi-todo: ${tool} refused — this task does not look multi-step enough yet.`;
	const why = `Why: ${describeSignals(verdict.signals)}.`;
	const need = verdict.missing.length > 0 ? `Missing: ${verdict.missing.join('; ')}.` : '';
	const advice =
		'Todos are for work with several concrete steps. Either do this task directly without a todo list, ' +
		'or wait until the request shows more steps / more work has already happened in this run.';
	return [head, why, need, extra ?? '', advice].filter((part) => part.length > 0).join(' ');
}
