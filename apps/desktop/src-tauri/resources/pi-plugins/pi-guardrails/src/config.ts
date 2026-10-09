/**
 * 配置读取与校验
 *
 * 设计原则：**未知即拒绝**（fail-closed）。护栏的价值来自"绝不放行不确定的写"，
 * 所以默认值一律偏严格，放宽必须显式配置。
 */

export interface GuardrailConfig {
	/** 未读就改拦截。注意：pi 的 ToolCallEventResult 只有 block 二值，**没有"警告式放行"**，见 README */
	enforceObservation: boolean;
	/** 陈旧写入检测（读后文件被外部改动）。需要 enforceObservation 为 true 才有意义 */
	detectStale: boolean;
	/**
	 * 原子 CAS 覆盖范围（v2）。
	 *
	 * - `"off"`：只走 `tool_call` 钩子，检查与写入之间有 TOCTOU 窗口（v1 行为）
	 * - `"write"`（默认）：覆盖内置 `write`，判定在 `withFileMutationQueue` 临界区内完成
	 * - `"write+edit"`：`edit` 也覆盖。`edit` 的失败模式更少见（它自己会先读文件），
	 *   但读写之间同样有窗口
	 *
	 * ⚠️ 覆盖意味着**用 pi 的公开 API 重建这两个工具**。参数字段/渲染器都从内置定义
	 * 复制（渲染器由 pi 的 `withBuiltInRenderers` 按工具名补回），但内置实现一旦变化，
	 * 这里需要跟着改。要退回 v1 就设 `"off"`。
	 */
	atomicWrite: "off" | "write" | "write+edit";
	/**
	 * 原子发布（v3）：写暂存文件 → fsync → rename 覆盖目标。
	 *
	 * - `"off"`：直接 `writeFile`。崩溃/中断可能留下**半个文件**（内容被截断）
	 * - `"rename"`（默认）：同目录暂存 + fsync + rename。读者要么看到旧内容，要么看到
	 *   新内容，**不存在中间态**
	 *
	 * 与 `atomicWrite` 是两件事，别混：
	 * - `atomicWrite`（CAS）管「**我读到的东西还有效吗**」—— 防止基于过期认知覆盖别人的改动
	 * - `atomicPublish`（本项）管「**我写到一半崩了文件会不会烂**」—— 防止留下截断文件
	 *
	 * 两者都做才算 DSH 的 `writeText` 语义完整。
	 */
	atomicPublish: "off" | "rename";
	/**
	 * 把"护栏存在"这件事写进系统提示词（分节注入，不替换 pi 的提示词）。
	 *
	 * 只为**当前配置下为真**的护栏生成引导 —— 关掉的护栏不会出现在提示词里。
	 * 关掉本项则完全不注入。
	 */
	promptGuidance: boolean;
	/** 路径前缀白名单，命中的路径跳过全部文件护栏 */
	allow: string[];
	/** 空响应兜底 */
	guardEmptyResponse: boolean;
	/** 同一 agent run 内最多兜几次（防自激） */
	maxEmptyContinuations: number;
	/** 连击探测阈值 */
	repeatThresholds: number[];
	/** 连击探测的白名单工具（空 = 全部工具） */
	repeatInclude: string[];
	/** 连击探测的黑名单工具 */
	repeatExclude: string[];
	/** bash 证据化的"空输出+非零退出"是否置 isError */
	markEmptyFailureAsError: boolean;
	/** 提醒消息的投递方式。**必须是 "steer"** —— 见 README 的 deliverAs 说明 */
	deliverAs: "steer" | "followUp" | "nextTurn";
	/** 调试输出 */
	debug: boolean;
}

export const DEFAULT_CONFIG: GuardrailConfig = {
	enforceObservation: true,
	detectStale: true,
	atomicWrite: "write",
	atomicPublish: "rename",
	promptGuidance: true,
	allow: [],
	guardEmptyResponse: true,
	maxEmptyContinuations: 2,
	repeatThresholds: [3, 5, 8],
	repeatInclude: [],
	repeatExclude: [
		// 轮询类工具天然会重复，默认不提醒
		"job_output",
		"job_list",
	],
	markEmptyFailureAsError: false,
	deliverAs: "steer",
	debug: false,
};

/** 从扩展选项对象合并配置；未知键忽略，类型不符的键回落到默认值。 */
export function resolveConfig(raw: unknown): GuardrailConfig {
	if (raw === undefined || raw === null) return { ...DEFAULT_CONFIG };
	if (typeof raw !== "object") {
		throw new Error(`pi-guardrails: config must be an object, got ${typeof raw}`);
	}
	const o = raw as Record<string, unknown>;
	const out: GuardrailConfig = { ...DEFAULT_CONFIG };

	const bool = (k: keyof GuardrailConfig) => {
		if (typeof o[k] === "boolean") (out[k] as boolean) = o[k] as boolean;
	};
	const num = (k: keyof GuardrailConfig, min: number) => {
		const v = o[k];
		if (typeof v === "number" && Number.isFinite(v) && v >= min) (out[k] as number) = Math.floor(v);
	};
	const strArr = (k: keyof GuardrailConfig) => {
		const v = o[k];
		if (Array.isArray(v) && v.every((x) => typeof x === "string")) (out[k] as string[]) = [...(v as string[])];
	};

	bool("enforceObservation");
	bool("detectStale");
	bool("guardEmptyResponse");
	bool("markEmptyFailureAsError");
	bool("debug");
	bool("promptGuidance");
	num("maxEmptyContinuations", 0);
	strArr("allow");
	strArr("repeatInclude");
	strArr("repeatExclude");

	const rt = o.repeatThresholds;
	if (Array.isArray(rt) && rt.length > 0 && rt.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 2)) {
		out.repeatThresholds = [...new Set(rt as number[])].sort((a, b) => a - b);
	}

	const d = o.deliverAs;
	if (d === "steer" || d === "followUp" || d === "nextTurn") out.deliverAs = d;

	const aw = o.atomicWrite;
	if (aw === "off" || aw === "write" || aw === "write+edit") out.atomicWrite = aw;

	const ap = o.atomicPublish;
	if (ap === "off" || ap === "rename") out.atomicPublish = ap;

	// 原子覆盖依赖 hook 层的判定：总开关关了就没有观察表可用，
	// 此时若还覆盖内置 write，只是白白重建一个行为相同的工具。
	if (!out.enforceObservation && out.atomicWrite !== "off") {
		out.atomicWrite = "off";
	}

	if (out.deliverAs === "nextTurn") {
		// 这是个几乎必然的配置错误：nextTurn 只在用户下次发 prompt 时才注入。
		// 不抛错（可能有人故意这么用），但必须吵。
		console.error(
			"[pi-guardrails] ⚠️ deliverAs=\"nextTurn\" 意味着提醒要等到用户下次发言才送达模型 —— " +
				"护栏将形同虚设。除非你明确知道自己在做什么，请改用 \"steer\"。",
		);
	}

	return out;
}

/** 路径是否在白名单内（前缀匹配，已规范化为绝对路径）。 */
export function isAllowed(absPath: string, allow: string[]): boolean {
	if (allow.length === 0) return false;
	return allow.some((prefix) => absPath === prefix || absPath.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`));
}

/**
 * 把白名单前缀统一成"已解析符号链接的绝对路径"形态。
 *
 * 必要性：macOS 上 `/var/...` 与 `/private/var/...` 是同一位置，
 * `realpath` 会统一成后者。若白名单停留在 `/var/...` 而检查路径是
 * `/private/var/...`，白名单会**静默失效** —— 这是个危险的失败方向
 * （护栏没生效，使用者却以为生效了）。
 *
 * 目录不存在时回落到 resolve 形态。
 */
export async function canonicalizeAllowList(prefixes: string[], cwd: string): Promise<string[]> {
	const { canonicalKey } = await import("./observation.js");
	const out: string[] = [];
	for (const p of prefixes) out.push(await canonicalKey(p, cwd));
	return out;
}

/** 惰性+记忆化：白名单只规范化一次。config 本身保持纯数据，不挂 Promise。 */
export function makeAllowResolver(config: GuardrailConfig, cwd: string) {
	let cache: Promise<string[]> | undefined;
	return (): Promise<string[]> => {
		cache ??= canonicalizeAllowList(config.allow, cwd).catch((err) => {
			console.error("[pi-guardrails] ⚠️ 白名单规范化失败，按原样使用：", err);
			return [...config.allow];
		});
		return cache;
	};
}
