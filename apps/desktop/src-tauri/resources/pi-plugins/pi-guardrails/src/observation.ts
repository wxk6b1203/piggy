/**
 * 路径规范化 + 文件版本戳 + 观察状态
 *
 * 对应 DSH 的 `obsSessionObserved`（per-session 观察表）与 `FsVersion`（CAS 版本戳）。
 */

import { stat, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";

/**
 * 路径规范化。
 *
 * 已知限制（README 有完整列表）：
 * - 符号链接：会尽力用 realpath 解析，但文件不存在时回落到 resolve。
 *   极端情况下（读时不存在、写时存在）key 可能不一致，导致误报"未读"。
 * - macOS 大小写不敏感：不做大小写折叠，`README.md` 与 `readme.md` 视为不同 key。
 *
 * 误报的代价是模型多读一次文件，可以接受；漏报的代价是静默写错，不可接受。
 */
export async function canonicalKey(inputPath: string, cwd: string): Promise<string> {
	const expanded = expandTilde(inputPath);
	const abs = isAbsolute(expanded) ? normalize(expanded) : normalize(resolve(cwd, expanded));

	// 先尝试整体 realpath：解析符号链接，避免 read 走 /a/link、edit 走 /a/real 时误判为"未读"
	try {
		return await realpath(abs);
	} catch {
		/* 文件不存在或不可达，走父目录规范化 */
	}

	// 回落到"规范化父目录 + 拼回文件名"。
	//
	// 这一步是**必需的，不是优化**：macOS 上 /var 与 /private/var 是同一位置，
	// 而 realpath 只在路径存在时才解析。若文件存在时记录到 /private/var/x，
	// 删除后回落到 /var/x，就会出现**同一文件两个 key** —— 观察记录丢失，
	// 报出"未读"而不是"已删除"，诊断信息完全错误。
	//
	// 目录本身即使在文件被删除后仍然存在，所以这条路径是稳定的。
	const dir = dirname(abs);
	const base = basename(abs);
	if (dir === abs) return abs; // 根目录，无父可规范化
	try {
		return join(await realpath(dir), base);
	} catch {
		// 逐级上溯，找到最深的可解析祖先目录
		return await resolveDeepestAncestor(dir, base);
	}
}

/** 逐级上溯找最深的可 realpath 的祖先，然后拼回剩余路径。 */
async function resolveDeepestAncestor(deepestMissingDir: string, leafBase: string): Promise<string> {
	let dir = deepestMissingDir;
	const suffix: string[] = [leafBase];
	while (true) {
		const parent = dirname(dir);
		if (parent === dir) return join(dir, ...suffix.reverse());
		suffix.push(basename(dir));
		try {
			return join(await realpath(parent), ...suffix.reverse());
		} catch {
			dir = parent;
		}
	}
}

/** 同步版本，仅用于不方便 await 的场景（如白名单判断）。不做 realpath。 */
export function canonicalKeySync(inputPath: string, cwd: string): string {
	const expanded = expandTilde(inputPath);
	return isAbsolute(expanded) ? normalize(expanded) : normalize(resolve(cwd, expanded));
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
	return p;
}

/** 文件版本戳。与 DSH 的 FsVersion 同构：dev:ino:size:mtimeNs:ctimeNs */
export interface Stamp {
	exists: boolean;
	stamp: string;
}

/**
 * 取版本戳。
 *
 * 已知弱点（**不要假装它是完美 CAS**）：同一纳秒内、大小不变的两次改写检测不到。
 * DSH 用同样的组合，接受同样的弱点。
 *
 * 用内容哈希做兜底只在文件很小时才划算，故不采用；若你需要更强的保证，
 * 在配置里把 detectStale 关掉，用外部工具（如 git）做变更检测。
 */
export async function stampOf(absPath: string): Promise<Stamp> {
	try {
		const s = await stat(absPath, { bigint: true });
		return {
			exists: true,
			stamp: `${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`,
		};
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") {
			return { exists: false, stamp: "absent" };
		}
		// 权限等其他错误不吞 —— 吞掉会让护栏误判为"文件不存在"
		throw err;
	}
}

/** 小文件内容哈希，用于诊断输出（不参与判定）。 */
export async function contentDigest(absPath: string): Promise<string | undefined> {
	try {
		const { readFile } = await import("node:fs/promises");
		const buf = await readFile(absPath);
		if (buf.byteLength > 256 * 1024) return undefined; // 大文件跳过
		return createHash("sha256").update(buf).digest("hex").slice(0, 12);
	} catch {
		return undefined;
	}
}

/** 一次观察记录。 */
export interface Observation {
	/** 观察时的版本戳 */
	stamp: string;
	/** 观察时文件是否存在 —— 区分"读到空文件"与"文件不存在" */
	exists: boolean;
	/** 观察是否覆盖全文（窗口化读取为 false，仅记录，当前不影响判定） */
	full: boolean;
	/** 观察发生时间（诊断用） */
	at: number;
}

/**
 * per-session 观察表。
 *
 * 对应 DSH 的 `ObservedStateGate`（WeakMap owner → targetKey），
 * 这里简化为单实例 Map —— 扩展在单进程内服务一个会话，多会话由 pi 各自加载实例。
 */
export class ObservationStore {
	private map = new Map<string, Observation>();

	observe(key: string, stamp: Stamp, full = true): void {
		this.map.set(key, { stamp: stamp.stamp, exists: stamp.exists, full, at: Date.now() });
	}

	get(key: string): Observation | undefined {
		return this.map.get(key);
	}

	/** 丢弃某个 key 的观察（例如该文件被外部工具改过） */
	forget(key: string): void {
		this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}

	/** 诊断用快照 */
	snapshot(): Array<{ key: string; stamp: string; exists: boolean; at: number }> {
		return [...this.map.entries()].map(([key, v]) => ({ key, stamp: v.stamp, exists: v.exists, at: v.at }));
	}
}
