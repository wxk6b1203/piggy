/**
 * 护栏一（v2）：真原子 CAS
 *
 * 消除 `guard-write.ts` 的 TOCTOU 窗口。
 *
 * ## 窗口在哪
 *
 * `tool_call` 钩子里的检查与工具真正落盘之间有一段空档：
 *
 * ```
 *   tool_call 钩子            ← 检查版本戳
 *        ⋮  ← 别的写入者可以在这里改文件
 *   write.execute()           ← 无条件落盘（pi 内置实现不做版本校验）
 * ```
 *
 * ## 怎么消除
 *
 * pi 的 `createWriteToolDefinition` / `createEditToolDefinition` 接受一个公开的
 * `operations` 接缝，而**内置 `execute` 已经把整段操作（含 `ops.writeFile`）包在
 * `withFileMutationQueue` 里**。于是把判定塞进 `ops.writeFile`（而不是塞在 execute 外层，
 * 那样会撞上「`withFileMutationQueue` 不可重入 → 死锁」，见 README 约束 2）：
 *
 * ```
 *   withFileMutationQueue(path, async () => {
 *       mkdir
 *       ops.writeFile()  ← 判定 + 落盘，同一临界区，无窗口
 *   })
 * ```
 *
 * 判定用的锁与 pi 内置工具用的是**同一个模块级队列**（`withFileMutationQueue` 是公开导出），
 * 所以它同时和「模型正在跑的 `edit`」「另一个并发工具调用」互斥。
 *
 * ## 判定语义与 DSH 对齐
 *
 * | 上次观察 | write（`replaceIfVersion` / `createIfAbsent`） | edit（`editIntent`） |
 * |---|---|---|
 * | present | 当前戳必须与观察戳相同 | 同左 |
 * | present 但文件已消失 | 拦截（并发删除） | 拦截 |
 * | absent | 只允许在仍不存在时创建 | 拦截 `FS_NOT_FOUND` |
 * | 无记录 | 放行（创建也是「未读就改」，但 hook 已拦；见下） | 拦截 `FS_NOT_OBSERVED` |
 *
 * ⚠️ 「无记录」这一行**故意放行**：`tool_call` 钩子（`guard-write.ts`）会在工具执行前
 * 拦住「未读就改」。本模块不重复拦，是因为创建新文件（absent → create）是正常路径，
 * 而「无记录」与「观察为 absent」在只看得见 store 的这里无法区分动机。
 * 换句话说：**拦截的权威在 hook，原子性的权威在这里**，两层各自负责一件事。
 *
 * ## 写后记录观察
 *
 * DSH 在 `fs.writeText` / `fs.editText` 成功后发 `fs/observed`，把新版本记进观察表。
 * 不这么做的话，「读 → 写 → 再写」的第二次会被误判为陈旧（文件被**自己**改了）。
 * 所以这里在落盘后、**仍在临界区内**取一次戳并回写观察表。
 */

import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from "node:fs/promises";
import { constants, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import type { GuardrailConfig } from "./config.js";
import { isAllowed } from "./config.js";
import type { ObservationStore, Stamp } from "./observation.js";
import { canonicalKey, stampOf } from "./observation.js";
import { publishFile } from "./publish.js";

/**
 * 与 DSH 的 `FsError` 同形的错误。
 *
 * ⚠️ 不 `import { FsError } from "@earendil-works/pi-coding-agent"` —— 该类**不是公开导出**
 * （pi 也没有 `exports` 子路径，私有模块 import 不进去）。而且 pi 只把 `error.message`
 * 转给模型，`code` 属性根本到不了模型眼前，所以这里把 code 直接写进文案。
 */
export class GuardError extends Error {
	readonly code: string;
	constructor(message: string, code: string) {
		super(`${message}\n[${code}]`);
		this.name = "GuardError";
		this.code = code;
	}
}

/**
 * 注册边界用的宽松工具定义类型。
 *
 * `ToolDefinition<TParams>` 在 TParams 上是不变的（见 registerAtomicGuard 内注释），
 * 而这里只需要"一个能交给 pi.registerTool 的工具定义"，不需要参数类型的关联。
 */
type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface AtomicGuardDeps {
	store: ObservationStore;
	config: GuardrailConfig;
	/** getter，因为会话切换可能改变 cwd */
	cwd: () => string;
	/** 惰性解析的白名单（已 realpath 规范化） */
	allowResolver: () => Promise<string[]>;
	debug: (...args: unknown[]) => void;
}

/** 判定结果：放行 / 放行并附带回写观察表用的戳 / 拦截 */
type CasOutcome =
	| { kind: "ok"; observed: Stamp | undefined }
	| { kind: "blocked"; reason: string; code: string };

export interface CasOptions {
	/**
	 * 文件当前必须不存在时，是否允许创建。
	 * - write：true（`createIfAbsent`）
	 * - edit：false（`editIntent` 对 absent 报 `FS_NOT_FOUND`）
	 */
	allowCreate: boolean;
	/** 工具名，用于文案 */
	tool: "write" | "edit";
}

/**
 * 在锁内做一次 CAS 判定。
 *
 * 调用者必须已经持有该路径的 `withFileMutationQueue`（由内置 execute 持有）。
 */
async function casCheck(
	key: string,
	rawPath: string,
	deps: AtomicGuardDeps,
	opts: CasOptions,
): Promise<CasOutcome> {
	const { store, config, allowResolver, debug } = deps;

	// 护栏总开关关闭时，原子层也不做任何判定（否则「关掉护栏」会变成半开）
	if (!config.enforceObservation) return { kind: "ok", observed: undefined };

	if (config.allow.length > 0 && isAllowed(key, await allowResolver())) {
		debug(`atomic: allow-listed, skip ${key}`);
		return { kind: "ok", observed: undefined };
	}

	const prior = store.get(key);
	const display = rawPath;
	const resolvedNote = key === rawPath ? "" : ` (resolved: ${key})`;

	// ── 无观察记录 ──
	//
	// ⚠️ 必须在**锁内真的 stat 一次**，不能因为"hook 放行了"就无条件放行。
	//
	// 曾经的实现分成两半：hook 层拦「无记录且文件存在」，原子层对「无记录」直接放行。
	// 现在 hook 层不再对"无记录"做判断（放行，让创建新文件走正常路径），
	// 那么**"已存在但从未读过"就只剩这一道关**。若这里不确认，
	// `write` 会静默覆盖一个模型没看过的文件 —— 正是本护栏要防的事。
	//
	// 判据是"文件现在存不存在"，而不是"有没有观察记录"：
	//   - 不存在 → 创建，没有可破坏的东西，放行
	//   - 存在   → 模型没看过它，拒绝并要求先读
	if (prior === undefined) {
		const now = await safeStamp(key);
		if (now.exists) {
			debug(`atomic: reject ${opts.tool} (exists but never observed)`, key);
			return {
				kind: "blocked",
				reason:
					`cannot modify "${display}"${resolvedNote}: file has not been read` +
					` — read the file, then retry.` +
					`\n(Guardrail: read-before-write. This file already exists and you have not read it;` +
					` reading it will let you write against its real content.)`,
				code: "FS_NOT_OBSERVED",
			};
		}
		// 确实不存在 → 创建路径，放行
		return { kind: "ok", observed: undefined };
	}

	// ── 观察为 absent ──
	if (!prior.exists) {
		// edit 对「确认不存在」直接拒绝：DSH 的 editIntent 报 FS_NOT_FOUND，语义比
		// 「重读一下」更准确 —— 重读只会再记一次 absent，模型会卡在同一个判断上。
		if (!opts.allowCreate) {
			debug(`atomic: reject ${opts.tool} (FS_NOT_FOUND)`, key);
			return {
				kind: "blocked",
				reason:
					`cannot edit "${display}"${resolvedNote}: not found` +
					` — use write to create it, or re-read if you expected it to exist.`,
				code: "FS_NOT_FOUND",
			};
		}
		const now = await safeStamp(key);
		if (now.exists) {
			// 读时不存在、现在存在了 —— 并发创建者。要求重读，不做「反正要覆盖」的假设。
			debug(`atomic: reject ${opts.tool} (observed absent, now present)`, key);
			return {
				kind: "blocked",
				reason:
					`cannot modify "${display}"${resolvedNote}: it did not exist when last observed` +
					` but exists now — re-read the file, then retry.`,
				code: "FS_NOT_OBSERVED",
			};
		}
		// 确实仍不存在：创建路径放行
		return { kind: "ok", observed: undefined };
	}

	// ── 观察为 present：比对版本戳 ──
	if (!config.detectStale) return { kind: "ok", observed: undefined };

	let now: Stamp;
	try {
		now = await stampOf(key);
	} catch (err) {
		// 无法判定新鲜度 → fail-closed
		debug("atomic: stamp error, fail-closed", key, err);
		return {
			kind: "blocked",
			reason:
				`cannot modify "${display}"${resolvedNote}: could not verify whether the file changed` +
				` (${err instanceof Error ? err.message : String(err)}) — re-read the file, then retry.`,
			code: "FS_UNVERIFIABLE",
		};
	}

	if (!now.exists) {
		debug(`atomic: reject ${opts.tool} (vanished)`, key);
		return {
			kind: "blocked",
			reason:
				`cannot modify "${display}"${resolvedNote}: the file was deleted after it was read` +
				` — re-read (or re-create) it, then retry.`,
			code: "FS_STALE_VERSION",
		};
	}

	if (now.stamp !== prior.stamp) {
		debug(`atomic: reject ${opts.tool} (stale)`, key, prior.stamp, "->", now.stamp);
		return {
			kind: "blocked",
			reason:
				`cannot ${opts.tool} "${display}"${resolvedNote}: file changed since it was read` +
				` — re-read the file, then retry.` +
				`\n(Guardrail: atomic version check. This is the check that cannot be raced —` +
				` the file was verified and written under the same lock.)`,
			code: "FS_STALE_VERSION",
		};
	}

	return { kind: "ok", observed: now };
}

async function safeStamp(key: string): Promise<Stamp> {
	try {
		return await stampOf(key);
	} catch {
		// 调用方只用于「观察为 absent」分支；异常在此等价于「仍不可知」，按不存在处理
		return { exists: false, stamp: "absent" };
	}
}

/**
 * 判定 + 落盘 + 回写观察，**全部在调用方已持有的锁内**。
 *
 * 抛 `FsError` 表示拦截 —— 内置 execute 不做 catch，异常会冒泡成工具结果，
 * 模型看到的就是下面这条护栏文案。
 */
async function guardedWrite(
	absolutePath: string,
	content: string,
	deps: AtomicGuardDeps,
	opts: CasOptions,
	onWritten: (key: string, observed: Stamp | undefined) => void,
): Promise<void> {
	const key = await canonicalKey(absolutePath, deps.cwd());
	const outcome = await casCheck(key, absolutePath, deps, opts);
	if (outcome.kind === "blocked") {
		throw new GuardError(outcome.reason, outcome.code);
	}

	// 落盘。两种方式：
	// - atomicPublish="rename"：同目录暂存 + fsync + rename，崩溃不会留半个文件
	// - atomicPublish="off"：直接 writeFile（与 pi 内置一致，也是 v2 的行为）
	// CAS 判定与落盘同处一个临界区，这一点两种方式都一样。
	if (deps.config.atomicPublish === "rename") {
		const published = await publishFile(absolutePath, content, { debug: deps.debug });
		if (published.mode === "direct") {
			deps.debug("atomic: published via direct write (staging unsupported on this filesystem)");
		}
	} else {
		await fsWriteFile(absolutePath, content, "utf-8");
	}

	// ⚠️ 仍在临界区内取戳：等锁释放后再 stat，会把这个窗口里的并发改动
	// 记成「已观察」，于是**下次写入漏判**。
	let observed: Stamp | undefined = outcome.observed;
	try {
		observed = await stampOf(key);
	} catch (err) {
		// 取不到戳不影响本次写入（已经落盘了），只是观察表不更新 —— 下次会要求重读
		deps.debug("atomic: post-write stamp failed, observation not updated", key, err);
		observed = undefined;
	}
	onWritten(key, observed);
}

/** 写后回写观察表的统一入口。 */
function recordObservation(store: ObservationStore, key: string, observed: Stamp | undefined, debug: (...a: unknown[]) => void) {
	if (observed === undefined) {
		// 落盘成功但戳不可知：丢掉旧记录，避免拿旧戳当新戳用
		store.forget(key);
		return;
	}
	store.observe(key, observed, true);
	debug(`atomic: record observation after write ${key} exists=${observed.exists} ${observed.stamp}`);
}

/**
 * 本扩展包根的 realpath（guard-atomic.ts 位于 `<root>/src/` 下）。
 * 自检用它把 write 的注册来源判定为：自己 / 兄弟实例 / 外人。
 */
const SELF_ROOT: string | undefined = (() => {
	try {
		return realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
	} catch {
		return undefined;
	}
})();

/** 同包实例（兄弟）的路径特征：路径里有名为 pi-guardrails 的目录段 */
const PACKAGE_SEGMENT = "pi-guardrails";

type OwnerVerdict = "ours" | "sibling" | "foreign";

/**
 * 判定 write 的注册来源（sourceInfo 形状照抄 pi 的 source-info.d.ts:4-10，
 * 扩展工具的 path 是加载入口，如 `<root>/index.ts`）。
 *
 * - ours：路径解析后落在本包根内。pi 给的路径可能是相对/symlink 形态，统一 realpath 后比较。
 * - sibling：同一包的另一份实例（全局自动发现 + `-e` 双加载时，后注册者胜出）。
 *   那仍是本护栏自己的 CAS 语义 → 不降级，只 debug。
 * - foreign：其余一切 —— 包括 builtin 合成的 `<builtin:write>`
 *   （`agent-session.js:_refreshToolRegistry`，realpath 不出真路径）。
 *   判不了 = 不可信（fail-closed）。
 */
function ownerVerdict(sourceInfo: unknown): OwnerVerdict {
	const raw = (sourceInfo as { path?: unknown } | undefined)?.path;
	if (typeof raw !== "string" || raw.length === 0) return "foreign";
	let resolved = raw;
	try {
		resolved = realpathSync(raw);
	} catch {
		/* 合成路径（如 `<builtin:write>`）不存在 → 原样比较 */
	}
	if (SELF_ROOT !== undefined && (resolved === SELF_ROOT || resolved.startsWith(`${SELF_ROOT}/`))) {
		return "ours";
	}
	if (resolved.split(/[\\/]/).includes(PACKAGE_SEGMENT)) return "sibling";
	return "foreign";
}

/**
 * 注册 write / edit 的原子覆盖。
 *
 * 失败**不抛**（扩展加载不该因为护栏自故障而失败）。任何「原子层不可信」的情况
 * （注册失败 / 工具被后续扩展顶替 / 注册来源不可验证）都走 `degradeAtomic`：
 * 把 `config.atomicWrite` 置回 `"off"`，让 hook 层（`guard-write.ts` 的
 * `isAtomicallyCovered` 按 config 判断）立即恢复 v1 检查，并 console.error 大声说明。
 *
 * ⚠️ 降级**必须落到 config 上**，只打印日志是不够的 —— hook 层对被覆盖工具是
 * 无条件全权委托；不降级的话 write 会处于「零保护 + 提示词仍在宣称护栏存在」
 * 的状态（交付后审查确认过的缺陷）。
 */
export function registerAtomicGuard(pi: ExtensionAPI, deps: AtomicGuardDeps): void {
	const { config, debug } = deps;
	const mode = config.atomicWrite;
	if (mode === "off") return;

	const degradeAtomic = (reason: string, err?: unknown): void => {
		if (config.atomicWrite === "off") return; // 已降级过，别重复吵
		config.atomicWrite = "off";
		console.error(
			`[pi-guardrails] ⚠️ ${reason}\n` +
				`  已把 atomicWrite 降为 "off"：hook 层恢复 v1 检查（非原子，TOCTOU 窗口仍在，\n` +
				`  创建新文件也要先读一次）；提示词引导会随之只描述仍然为真的护栏。` +
				(err !== undefined ? `\n  原始错误：${err instanceof Error ? err.message : String(err)}` : ""),
		);
	};

	// cwd 变了就重建（内置 execute 用 ctx.cwd 解析路径，但 schema/渲染器与 cwd 无关）
	//
	// ⚠️ 这里必须用 `AnyToolDefinition`（参数放宽到 any），不能写 `ToolDefinition`。
	// `ToolDefinition<TParams>` 在 TParams 上是**不变**的：`renderCall` 的签名为
	// `(args: TParams, ...) => Component`，函数参数逆变 + 返回值协变 ⇒ 具体类型与
	// `unknown` 互不赋值。把 createWriteToolDefinition 的产物塞进
	// `Map<string, ToolDefinition>` 会报 TS2322（`npm run check` 抓到的）。
	// 在注册边界放宽是可接受的：调用方是 pi 的按名查找，本来就不做参数类型关联。
	const writeByCwd = new Map<string, AnyToolDefinition>();
	const editByCwd = new Map<string, AnyToolDefinition>();
	const observe = (key: string, observed: Stamp | undefined) => recordObservation(deps.store, key, observed, debug);

	const writeFor = (cwd: string): AnyToolDefinition => {
		const cached = writeByCwd.get(cwd);
		if (cached) return cached;

		// 只用 createWriteToolDefinition 就够了：**它自己把 execute 包在
		// withFileMutationQueue 里**（write.ts:67；createWriteTool 只是再套一层
		// wrapToolDefinition 补 ctx 工厂）。edit 侧同理（edit.ts:163）。
		//
		// 这曾经被我误判成"Definition 没有锁" —— 当时的"证据"其实来自测试里
		// join(cwd, 绝对路径) 的路径拼接 bug。教训：**别把测试失败直接当成产品缺陷**，
		// 先确认测试本身在测什么。见 test/smoke.mjs 的锁参与用例。
		const definition = createWriteToolDefinition(cwd, {
			operations: {
				// 保持内置默认行为：0o666 由 umask 决定权限，不擅自改成 0600
				writeFile: (absolutePath, content) =>
					guardedWrite(absolutePath, content, deps, { allowCreate: true, tool: "write" }, observe),
				mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
			},
		});

		writeByCwd.set(cwd, definition);
		return definition;
	};

	const editFor = (cwd: string): AnyToolDefinition => {
		const cached = editByCwd.get(cwd);
		if (cached) return cached;
		const definition = createEditToolDefinition(cwd, {
			operations: {
				access: async (absolutePath) => {
					await fsAccess(absolutePath, constants.F_OK);
				},
				readFile: (absolutePath) => fsReadFile(absolutePath),
				writeFile: (absolutePath, content) =>
					guardedWrite(absolutePath, content, deps, { allowCreate: false, tool: "edit" }, observe),
			},
		});
		editByCwd.set(cwd, definition);
		return definition;
	};

	//
	// ── 注册结果自检（缺陷防御）──
	//
	// pi 对同名扩展工具的解析是「后注册者静默胜出」：`agent-session.js` 的
	// `_refreshToolRegistry` 把 builtin 定义先放进 Map，再逐个 `set()` 扩展工具，
	// **无冲突检测**。任何在我们之后加载、也注册了 write 的扩展都会把本护栏的
	// CAS 覆盖悄悄顶掉。那时 hook 层看到的 config.atomicWrite 仍是 "write"，
	// 会继续全权委托 → write 零保护，而 <guardrails> 提示词仍在宣称「未读就写
	// 会被拦」—— 提示词撒谎，且没有任何报错。所以必须在首个 agent 回合开始时
	// 显式验证注册归属；不对就降级。扩展工具只在 load 阶段注册、/reload 会整体
	// 重建实例，所以一次自检足够。
	let selfCheckDone = false;
	pi.on("before_agent_start", async () => {
		if (selfCheckDone) return undefined;
		selfCheckDone = true;
		try {
			// ToolInfo 形状照抄 pi 的 extensions/types.d.ts:1279-1281
			// （Pick<ToolDefinition, "name"|"description"|"parameters"|"promptGuidelines">
			//  & { sourceInfo: SourceInfo }）；getAllTools 是 ExtensionAPI 的方法（同文件
			//  :1072），首个回合开始时 runtime 已绑定，此时调用是合法的。
			const tools: ToolInfo[] = pi.getAllTools();
			const expected = mode === "write+edit" ? ["write", "edit"] : ["write"];
			for (const name of expected) {
				const tool = tools.find((t) => t.name === name);
				if (!tool) continue; // 被 excludeTools 排除 → 没有写路径，无需判定
				const verdict = ownerVerdict(tool.sourceInfo);
				if (verdict === "ours" || verdict === "sibling") {
					debug(`atomic: self-check ok (${name} owner=${verdict})`);
					continue;
				}
				degradeAtomic(
					verdict === "foreign"
						? `检测到 "${name}" 工具已被其他扩展顶替（source=${JSON.stringify(
							(tool.sourceInfo as { source?: unknown } | undefined)?.source ?? "?",
						  )}），本护栏的锁内 CAS 判定已失效`
						: `无法验证 "${name}" 工具的注册来源（sourceInfo 缺 path），锁内 CAS 判定可信度未知`,
				);
			}
		} catch (err) {
			// 自检自身故障**不降级**（那会把好端端的护栏关掉），只 debug。
			debug("atomic: self-check failed (non-fatal)", err);
		}
		return undefined;
	});

	try {
		// 预加载 typebox schema 形状：直接复用 pi 内置定义，参数字段不会漂移。
		// ⚠️ 必须在 try **内**：本函数 docstring 承诺「失败不抛」—— pi 版本漂移时
		// 这里抛出的错要被下面的 catch 转成降级，而不是让整个扩展加载失败。
		const writeDef = createWriteToolDefinition(deps.cwd());
		const editDef = createEditToolDefinition(deps.cwd());

		pi.registerTool({
			...writeDef,
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const definition = writeFor(ctx?.cwd ?? deps.cwd());
				return definition.execute(
					toolCallId,
					params,
					signal,
					onUpdate,
					// 结构上就是同一个 ctx；两侧的 ExtensionContext 来自不同模块实例，故此处放宽类型
					ctx as never,
				);
			},
		} as ToolDefinition);

		if (mode === "write+edit") {
			pi.registerTool({
				...editDef,
				async execute(toolCallId, params, signal, onUpdate, ctx) {
					const definition = editFor(ctx?.cwd ?? deps.cwd());
					return definition.execute(toolCallId, params, signal, onUpdate, ctx as never);
				},
			} as ToolDefinition);
		}

		debug(`atomic: registered (mode=${mode}) — CAS now runs inside withFileMutationQueue`);
	} catch (err) {
		// 降级：必须改配置而不只是打印，否则 hook 层继续全权委托 → write 零保护。必须吵。
		degradeAtomic("原子写入覆盖注册失败，锁内 CAS 不可用", err);
	}
}

/** 供测试直接驱动 CAS 判定（不经 pi）。 */
export const __test = { casCheck, recordObservation };
export type { CasOutcome };
