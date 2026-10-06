/**
 * 配置读取与校验。
 *
 * 优先级（后者覆盖前者）：**默认值 → 配置文件 → 环境变量 → 命令行 flag**。
 * 三条通道都给，是因为三种使用场景差别很大：
 *
 * - **Piggy / GUI 里跑的 pi**：没人给它加命令行参数，环境变量也不一定继承得到
 *   —— 配置文件（`<agentDir>/pi-todo.json`）是唯一顺手的方式；
 * - **终端里的 `pi`**：`--todo-parallel` 这类 flag 最直接；
 * - **脚本 / CI**：环境变量最好写。
 *
 * 校验纪律（沿用 pi-guardrails）：**未知即拒绝**。不认识的键、类型不对的值、
 * 越界的数字都**不会**被静默忽略 —— 它们进 `problems`、打到 stderr，该字段回落到
 * 默认值。理由：一个拼错的键如果被静默忽略，用户会以为"我配了"，而实际没生效。
 *
 * 注意一处**故意的默认值差异**：DSH 的 `allowParallelInProgress` 是**必填、没有默认**
 * （`packages/todo/tool-todo/src/index.ts:36-43`，缺了直接加载失败）。插件没有"部署
 * 时强制二选一"的位置，所以本仓选了一个默认值 —— `false`（一次只推进一件事），
 * 因为它是更保守的那一侧，而且想并行的人会去看文档。
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { GateThresholds } from './complexity.js';

/** 生效的配置。 */
export interface TodoConfig extends GateThresholds {
	/** 扩展总开关（false = 两个工具都不注册） */
	enabled: boolean;
	/** 是否允许多条同时 `in_progress`（DSH 的同名配置；本仓默认 false） */
	allowParallelInProgress: boolean;
	/**
	 * 是否执行复杂度闸门。
	 *
	 * **默认关闭**（2026-09-29 用户裁定）：闸门是启发式，"措辞短但实际多步"的请求会被
	 * 低估，而默认拦人比默认放行更烦人。想要那条约束时显式打开：
	 * 配置文件写 `true` / `PI_TODO_ENFORCE_COMPLEXITY=1` / `pi --todo-enforce`
	 * （flag 只影响那一次调用 —— 终端里想试就试，Piggy 不受影响）。
	 */
	enforceComplexity: boolean;
	/** 内容与上一份完全相同的写入是否拒绝（省 token；默认开） */
	rejectNoopWrites: boolean;
	/** 单份清单的条目上限 */
	maxItems: number;
	/** 本轮工具调用到这一步还没开清单时，主动激活并提醒（默认开） */
	proactiveActivation: boolean;
	/** 主动激活的触发门槛（本轮工具调用数） */
	proactiveAfterToolCalls: number;
	/** 是否把使用规则写进系统提示词 */
	promptGuidance: boolean;
	/** 打调试日志（stderr） */
	debug: boolean;
}

/** 默认配置。 */
export const DEFAULT_CONFIG: TodoConfig = {
	enabled: true,
	allowParallelInProgress: false,
	enforceComplexity: false,
	minPlanItems: 3,
	enableMinScore: 3,
	enableMinToolCalls: 3,
	writeMinScore: 2,
	smallPlanToolCalls: 2,
	rejectNoopWrites: true,
	maxItems: 30,
	proactiveActivation: true,
	proactiveAfterToolCalls: 5,
	promptGuidance: true,
	debug: false,
};

/** 配置解析结果：生效配置 + 解析过程中的问题（**不静默**）。 */
export interface ConfigResolution {
	config: TodoConfig;
	/** 读文件失败、未知键、类型不对…… 每条都能说清"哪个来源的哪个键" */
	problems: string[];
	/** 配置文件路径（可能不存在） */
	configPath: string;
}

/** 字段类型表：校验与取值共用一处，避免"加字段忘了校验"。 */
const FIELD_TYPES: Record<keyof TodoConfig, 'boolean' | 'number'> = {
	enabled: 'boolean',
	allowParallelInProgress: 'boolean',
	enforceComplexity: 'boolean',
	minPlanItems: 'number',
	enableMinScore: 'number',
	enableMinToolCalls: 'number',
	writeMinScore: 'number',
	smallPlanToolCalls: 'number',
	rejectNoopWrites: 'boolean',
	maxItems: 'number',
	proactiveActivation: 'boolean',
	proactiveAfterToolCalls: 'number',
	promptGuidance: 'boolean',
	debug: 'boolean',
};

/** 数值字段的合法区间（越界 = 配置错误，不是"钳一下就行"）。 */
const NUMBER_RANGES: Partial<Record<keyof TodoConfig, [number, number]>> = {
	minPlanItems: [2, 10],
	enableMinScore: [1, 8],
	enableMinToolCalls: [1, 50],
	writeMinScore: [1, 8],
	smallPlanToolCalls: [1, 50],
	maxItems: [2, 200],
	proactiveAfterToolCalls: [1, 200],
};

/** 环境变量名 ↔ 配置键（`PI_TODO_<SNAKE>`）。 */
const ENV_PREFIX = 'PI_TODO_';

/** `allowParallelInProgress` → `ALLOW_PARALLEL_IN_PROGRESS`。 */
function envName(key: keyof TodoConfig): string {
	return ENV_PREFIX + key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase();
}

/** pi 的 agent 目录规则（`PI_CODING_AGENT_DIR` 优先，否则 `~/.pi/agent`）。 */
export function agentDir(): string {
	const env = process.env['PI_CODING_AGENT_DIR'];
	if (typeof env === 'string' && env.trim().length > 0) return env;
	return join(homedir(), '.pi', 'agent');
}

/**
 * 把一个来源（文件/环境变量）里的键值并进 `draft`，逐项校验。
 *
 * @param draft - 目标配置（就地修改）
 * @param source - 来源名（写进 problems，用户能知道该去改哪）
 * @param values - 原始键值
 * @param problems - 问题收集器
 */
function mergeSource(
	draft: TodoConfig,
	source: string,
	values: Record<string, unknown>,
	problems: string[],
): void {
	for (const [rawKey, rawValue] of Object.entries(values)) {
		const key = rawKey as keyof TodoConfig;
		if (!(key in FIELD_TYPES)) {
			problems.push(`${source}: unknown key \`${rawKey}\` (ignored)`);
			continue;
		}
		const want = FIELD_TYPES[key];
		if (want === 'boolean') {
			if (typeof rawValue === 'boolean') {
				draft[key] = rawValue as never;
			} else {
				problems.push(`${source}: \`${rawKey}\` must be a boolean (got ${typeof rawValue})`);
			}
			continue;
		}
		const num = typeof rawValue === 'string' && rawValue.trim() !== '' ? Number(rawValue) : rawValue;
		if (typeof num !== 'number' || !Number.isFinite(num) || !Number.isInteger(num)) {
			problems.push(`${source}: \`${rawKey}\` must be an integer (got ${JSON.stringify(rawValue)})`);
			continue;
		}
		const range = NUMBER_RANGES[key];
		if (range && (num < range[0] || num > range[1])) {
			problems.push(`${source}: \`${rawKey}\` must be within [${range[0]}, ${range[1]}] (got ${num})`);
			continue;
		}
		draft[key] = num as never;
	}
}

/**
 * 从环境变量里取配置（只认 `PI_TODO_*`）。
 *
 * 命名是**机械映射**：`allowParallelInProgress` → `PI_TODO_ALLOW_PARALLEL_IN_PROGRESS`
 * （大写 + 驼峰处插下划线）。没有短别名 —— 别名会带来"两个名字哪个生效"的问题。
 *
 * 未知的 `PI_TODO_*` **会被点名**：拼错一个环境变量最难查（用户以为配上了），
 * 所以宁可吵一声。
 *
 * @param env - 环境变量表
 * @param problems - 问题收集器
 * @returns 覆盖项
 */
export function envOverrides(env: NodeJS.ProcessEnv = process.env, problems: string[] = []): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	const known = new Set(Object.keys(FIELD_TYPES).map((k) => envName(k as keyof TodoConfig)));
	for (const key of Object.keys(env)) {
		if (!key.startsWith(ENV_PREFIX)) continue;
		if (key === `${ENV_PREFIX}CONFIG`) continue; // 预留：显式指定配置文件路径
		if (!known.has(key)) problems.push(`environment: unknown variable \`${key}\` (ignored)`);
	}
	for (const key of Object.keys(FIELD_TYPES) as (keyof TodoConfig)[]) {
		const raw = env[envName(key)];
		if (raw === undefined || raw === '') continue;
		if (FIELD_TYPES[key] === 'boolean') {
			// 布尔环境变量：`1/true/yes/on` 为真，`0/false/no/off` 为假，其它算错（进 problems）
			const lower = raw.trim().toLowerCase();
			if (['1', 'true', 'yes', 'on'].includes(lower)) out[key] = true;
			else if (['0', 'false', 'no', 'off'].includes(lower)) out[key] = false;
			else out[key] = raw;
		} else {
			out[key] = raw;
		}
	}
	return out;
}

/** 读配置文件（不存在 = 正常，不是问题）。 */
function readConfigFile(path: string, problems: string[]): Record<string, unknown> {
	let text: string;
	try {
		text = readFileSync(path, 'utf-8');
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code !== 'ENOENT') problems.push(`config file ${path}: ${(err as Error).message}`);
		return {};
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (err) {
		problems.push(`config file ${path}: invalid JSON (${(err as Error).message})`);
		return {};
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		problems.push(`config file ${path}: top level must be a JSON object`);
		return {};
	}
	// 允许把配置写在 `piTodo` 键下（给"一个文件放多个插件配置"留口子），也允许平铺。
	const nested = (parsed as { piTodo?: unknown }).piTodo;
	if (nested !== undefined) {
		if (typeof nested !== 'object' || nested === null || Array.isArray(nested)) {
			problems.push(`config file ${path}: \`piTodo\` must be an object`);
			return {};
		}
		return nested as Record<string, unknown>;
	}
	return parsed as Record<string, unknown>;
}

/**
 * 解析配置。
 *
 * @param overrides - 额外的最高优先级来源（命令行 flag 解析结果）
 * @param env - 环境变量（测试注入用）
 * @returns 生效配置 + 问题清单 + 配置文件路径
 */
export function resolveConfig(
	overrides: Record<string, unknown> = {},
	env: NodeJS.ProcessEnv = process.env,
): ConfigResolution {
	const problems: string[] = [];
	const config: TodoConfig = { ...DEFAULT_CONFIG };
	const configPath = join(agentDir(), 'pi-todo.json');
	mergeSource(config, `config file ${configPath}`, readConfigFile(configPath, problems), problems);
	mergeSource(config, 'environment', envOverrides(env, problems), problems);
	mergeSource(config, 'command line', overrides, problems);
	// 交叉校验：单条清单的下限不能超过上限，否则"永远写不进去"这种自锁很难查
	if (config.minPlanItems > config.maxItems) {
		problems.push(
			`\`minPlanItems\` (${config.minPlanItems}) exceeds \`maxItems\` (${config.maxItems}); \`maxItems\` raised`,
		);
		config.maxItems = config.minPlanItems;
	}
	return { config, problems, configPath };
}
