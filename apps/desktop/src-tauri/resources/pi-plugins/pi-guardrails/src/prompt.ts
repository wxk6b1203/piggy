/**
 * 把护栏的存在告诉模型——但**只在护栏真的生效时**。
 *
 * ## 为什么值得做
 *
 * pi 的提示词是**分节**的（`system-prompt.ts` 的 `SystemPromptSections`），
 * 且 `before_agent_start` 事件暴露了**可变的** `systemPromptOptions`：
 *
 * ```
 * // extensions/types.d.ts:555-565
 * readonly systemPrompt: string;                    // 渲染结果（只读）
 * systemPromptOptions: NormalizedBuildSystemPromptOptions;  // ← 可变的分节对象
 * ```
 *
 * 改它的 `sections`（或 `promptGuidelines`）会经 `buildSystemPromptSections`
 * 重新渲染，并**只在变化时**产生一条 system 补丁消息（`diffSystemPromptSections`）。
 * 也就是说 pi 本来就支持 DSH 那种"分节 + 可增量更新"的提示词，只是没人用它来
 * 描述**护栏的存在**。
 *
 * ## 为什么必须按开关动态生成
 *
 * 这是本模块存在的唯一理由，也是从 DSH 学到的**最关键一条**：
 *
 * > 提示词承诺的事实，代码必须兑现；代码没做的事，提示词不许说。
 *
 * 一个静态的"我会拦截未读就改"在 `enforceObservation: false` 时就是**在骗模型** ——
 * 模型会因此放弃自己的判断，而护栏并不存在。这比没有护栏更糟。
 * 所以每一条引导都绑一个开关，关掉就不出现。
 *
 * 同理，`bash` 的证据行只有 evidence 护栏开启时才存在，`[exit code: N]` 这句
 * 也只在那种情况下说。
 *
 * ## 与 DSH 的对应
 *
 * | DSH | 本模块 |
 * |---|---|
 * | `shell/tool-bash/src/index.ts:284` 注入 "Check the [exit code: N] marker…" | `bash` 引导，且 `render.ts:59-61` 保证 marker 存在 |
 * | `render.ts:19-21` "reported, not errored" | 我们如实说：非零退出置 `isError`，从错误文案还原事实 |
 * | `fs/tool-fs/src/error.ts` 的补救文案 | 引导里给出同样的修复动作（重新读） |
 *
 * ## 已知限制
 *
 * - 只在**每轮开始**（`before_agent_start`）重新生成。会话中途改配置不会立刻反映。
 * - pi 不公开 `buildSystemPrompt*`（只有 `formatSkillsForPrompt` 是公开的），
 *   所以这里**只做注入**，渲染交给 pi。测试验证注入内容，端到端验证最终提示词。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GuardrailConfig } from "./config.js";

/** 段落名（pi 要求 `^[a-z][a-z0-9_-]*$`，且不能叫 preamble） */
export const SECTION_NAME = "guardrails";

/**
 * 生成本次配置下**为真**的引导条目。
 *
 * 每条都必须能回答："关掉哪个开关，这条就不再成立？"
 */
export function buildGuidelines(config: GuardrailConfig): string[] {
	const rules: string[] = [];

	// 「原子覆盖是否真的在场」——注册失败或工具被顶替时会被降级为 "off"。
	// 提示词必须随之收敛：hook 层的 v1 检查在锁外，承诺不了「不可竞争」，
	// 也免不了「创建新文件先读一次」的收费。
	const atomicLive = config.atomicWrite !== "off";

	// ── 写前观察校验（enforceObservation）──
	if (config.enforceObservation) {
		rules.push(
			"Read a file before writing or editing it: the read-before-write guard rejects `edit`/`write`" +
				" on a file that already exists and that you have not read." +
				(atomicLive
					? " Creating a file that does not exist needs no prior read — write it directly."
					// v1 模式（hook 层无法在锁内 stat）：创建也要先读一次，失败
					// 的 read 记录缺席并解锁 —— 与 hook 的拦截文案保持一致。
					: " If the file does not exist, read it anyway: the failed read records its absence, which unblocks creating it."),
		);
		if (config.detectStale) {
			rules.push(
				"After a `write`/`edit` in this session, the file on disk may differ from what you last read." +
					" If a write is rejected with \"file changed since it was read\", re-read the file and redo the edit" +
					" against the fresh content — do not repeat the same call." +
					(atomicLive
						? " The check runs inside the same file lock as the write, so it cannot be raced; the rejection is authoritative."
						: ""),
			);
		}
	}

	// ── 原子发布（atomicPublish）──
	if (atomicLive && config.atomicPublish === "rename") {
		rules.push(
			"File writes are published atomically (staged, fsynced, then renamed into place)," +
				" so a concurrent reader sees either the previous or the new content and never a partial file." +
				" A `write` that reports success means the content is fully on disk.",
		);
	}

	// ── bash 证据化 ──
	// ⚠️ 措辞必须与 pi 的真实行为一致：pi 对非零退出置 `isError: true`
	// （`bash.js:270` 抛错 → agent-loop 的 createErrorToolResult），
	// 我们把退出码/信号/超时还原成事实行追加在输出末尾。
	// 早年本仓曾误称"pi 不置 isError"，见 README「一次静默失效」。
	rules.push(
		"Check the `[exit code: N]` / `[timed out]` / `[killed by signal: X]` marker at the end of every bash" +
			" result and investigate failures before moving on. This is the only place the exit status appears —" +
			" pi reports a non-zero exit as an error without a structured exit field.",
	);

	return rules;
}

/**
 * 渲染成注入用的段落正文。空引导返回 `undefined`（不注入空段）。
 */
export function renderSection(config: GuardrailConfig): string | undefined {
	const rules = buildGuidelines(config);
	if (rules.length === 0) return undefined;
	return rules.map((r) => `- ${r}`).join("\n");
}

export interface PromptDeps {
	config: GuardrailConfig;
	debug: (...args: unknown[]) => void;
}

/**
 * 注册提示词贡献。
 *
 * 走 `before_agent_start` 的 `systemPromptOptions.sections` 而不是返回 `systemPrompt`：
 * 后者是**整条替换**（`forceSystemPrompt`），会让 pi 自己的工具清单、项目上下文、
 * skills 段落全部失效 —— 那是"改提示词"里最容易犯的错。
 */
export function registerPromptContribution(pi: ExtensionAPI, deps: PromptDeps): void {
	const { config, debug } = deps;

	pi.on("before_agent_start", async (event) => {
		// 总开关：关掉就完全不碰提示词。
		// ⚠️ 这里必须**同时处理"上一轮注入过"的情况** —— 直接 return 会把陈旧段落留在
		// 提示词里，而模型会继续按它行事（那比不注入更糟）。
		const section = config.promptGuidance ? renderSection(config) : undefined;

		if (section === undefined) {
			// 无引导（总开关关闭，或所有相关护栏都关了）→ 若上一轮注入过，这里要**移除**。
			// pi 的 diffSystemPromptSections 把缺失的段落记为 null 删除。
			if (event.systemPromptOptions.sections[SECTION_NAME] !== undefined) {
				delete event.systemPromptOptions.sections[SECTION_NAME];
				debug("prompt: guardrails section removed (guidance disabled or not applicable)");
			}
			return undefined;
		}

		// 原地改可变的分节对象；后续 handler 能看到，pi 负责渲染与增量补丁
		event.systemPromptOptions.sections[SECTION_NAME] = section;
		debug(`prompt: injected <${SECTION_NAME}> (${buildGuidelines(config).length} rules)`);
		return undefined;
	});
}

/** 供测试使用 */
export const __test = { buildGuidelines, renderSection, SECTION_NAME };
