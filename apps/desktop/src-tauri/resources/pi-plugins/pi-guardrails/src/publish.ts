/**
 * 原子发布（v3）：写暂存文件 → fsync → rename
 *
 * ## 补的是哪个洞
 *
 * `atomicWrite`（CAS）管的是「**我读到的东西还有效吗**」—— 它是**认知**层面的正确性。
 * 本模块管的是「**我写到一半崩了，文件会不会烂**」—— **物理**层面的正确性。
 * pi 的内置 `write` 是直接 `writeFile`，没有 rename，所以：
 *
 * ```
 *   writeFile(path, 500MB 内容)
 *        ⋮  ← 这里崩溃 / 断电 / 被 SIGKILL
 *   → 磁盘上留下一个**被截断的半个文件**，而且它是"合法"的文件
 * ```
 *
 * 换成同目录暂存 + fsync + rename 之后，读者只可能看到旧内容或新内容：
 *
 * ```
 *   写 .<name>.<pid>.<uuid>.tmpdir/<name>.tmp   ← 崩在这里，目标文件**完全没动**
 *   fsync(文件)                                  ← 保证内容真的落盘，不是只进了页缓存
 *   rename(tmp, target)                          ← 原子：这一刻起读者才看到新内容
 *   fsync(目录)                                  ← 让 rename 本身也持久
 * ```
 *
 * ## 语义细节（都是踩过才知道的）
 *
 * 1. **目标存在时保留它的权限位**。`rename` 会把暂存文件的 mode 一起带过去，
 *    而暂存文件是 0600；不显式 chmod 回去，`0644` 的文件会在一次写入后变成 `0600`。
 *    新建文件则保持 `0o666 & ~umask`（与内置 `writeFile` 一致）——
 *    为了不擅自决定 umask，这里用**不传 mode** 的写入让内核套用 umask。
 * 2. **符号链接必须解析**。`rename` 是替换目录项，不会跟着符号链接走。
 *    不解析的话 `write("./link")` 会把链接**本身**换成一个普通文件，
 *    而内置 `writeFile` 是写链接指向的目标 —— 那就成了静默破坏。
 *    **悬空链接**（链接在、目标不在）也必须跟着走：realpath 对它失败，
 *    回落到「父目录+文件名」拿到的是链接自己 —— rename 会把链接换成普通文件
 *    （交付后审查实测抓到）。必须逐级 readlink 跟随；链接环则 ELOOP 报错，绝不猜。
 * 3. **临时名唯一**，且在**同目录**内（跨设备 rename 会 EXDEV）。
 * 4. **失败要清理暂存目录**，否则用户目录里会攒一堆 `.xxx.tmpdir`。
 * 5. **不支持时降级**：某些文件系统（部分 FUSE / 网络挂载）不允许在目录里建新条目，
 *    但允许原地改文件。此时退回直接写，并 `debug()` 出来 —— “假装原子”比“明确降级”更危险。
 * 6. **目标存在时检查写权限**。rename 只要求**目录**可写；内置 `writeFile`（打开
 *    O_WRONLY）对只读文件会 EACCES 失败。不补 access(W_OK)，chmod 444 保护的文件
 *    会被本扩展**静默覆盖**（实测抓到）—— 写入语义不能比内置更弱。
 *
 * 对应 DSH 的 `dsh-fs-local` `writeFileAtomic`（0o700 暂存目录 + 0o600 文件 + rename）。
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, resolve } from "node:path";
import {
	access,
	lstat,
	mkdir,
	open,
	readlink,
	realpath,
	rename,
	rm,
	stat,
	writeFile as fsWriteFile,
} from "node:fs/promises";

/** 判定「这个文件系统不支持暂存+rename」的错误码 —— 命中则降级为直接写 */
const FALLBACK_CODES = new Set(["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "ENOSYS", "EINVAL"]);

function codeOf(err: unknown): string | undefined {
	return typeof err === "object" && err !== null && "code" in err
		? String((err as { code?: unknown }).code)
		: undefined;
}

export interface PublishDeps {
	debug: (...args: unknown[]) => void;
}

export interface PublishResult {
	/** 实际使用的发布方式，便于测试与诊断 */
	mode: "rename" | "direct";
}

/**
 * 符号链接跟随深度上限。超过视为链接环 —— 明确报错，而不是猜一条路径然后
 * 把某个无辜的目录项 rename 掉。取值与 realpath 的常见实现一致（Linux/macOS 均 40）。
 */
const MAX_LINK_DEPTH = 40;

/**
 * 解析出「真正应该被替换的那个文件路径」。
 *
 * `rename` 是替换目录项，**不跟随符号链接**。而 pi 内置的 `writeFile` 会跟随。
 * 不解析就直接 rename，`write("./link")` 会把链接本身换成一个普通文件 ——
 * 静默破坏，且用户下次发现时已经晚了。
 *
 * 解析规则：
 * 1. 逐级跟随符号链接（`lstat` 不跟随，所以能看见链接本身），**包括悬空链接**：
 *    链接在、目标不在时 realpath 会失败，但不能因此把链接自己当目标（实测抓到过）；
 * 2. 真身存在 → `realpath` 给出真身（顺便解析路径中部的链接）；
 * 3. 真身不存在，但路径上有目录链接（如 `./linkdir/new.txt`）→ 用 `realpath(dir)` 拼回去；
 * 4. 都没有 → 原路径。
 */
async function resolveLinkTarget(absolutePath: string): Promise<string> {
	let current = absolutePath;
	let depth = 0;
	while (depth < MAX_LINK_DEPTH) {
		let st;
		try {
			st = await lstat(current);
		} catch {
			break; // 这一段不存在（且不是链接）→ 走下面的父目录解析
		}
		if (!st.isSymbolicLink()) break; // 真身（普通文件/目录）
		const link = await readlink(current);
		current = isAbsolute(link) ? normalize(link) : resolve(dirname(current), link);
		depth += 1;
	}
	if (depth >= MAX_LINK_DEPTH) {
		throw new Error(`ELOOP: too many levels of symbolic links while resolving "${absolutePath}"`);
	}

	try {
		return await realpath(current);
	} catch {
		/* 目标不存在，继续尝试解析父目录 */
	}

	const dir = dirname(current);
	const base = basename(current);
	if (dir === current) return current; // 根

	try {
		return join(await realpath(dir), base);
	} catch {
		/* 父目录也不存在（新建深层路径）：此时的中间目录还没有链接可解析 */
		return current;
	}
}

/**
 * 把 `content` 发布到 `absolutePath`。
 *
 * 只做"物理"层面的事 —— 调用方负责在**同一个临界区内**先做 CAS 判定。
 */
export async function publishFile(
	absolutePath: string,
	content: string,
	deps: PublishDeps,
): Promise<PublishResult> {
	// ① 解析符号链接：rename 不跟随链接，直接换目录项会把链接本身替换掉。
	const target = await resolveLinkTarget(absolutePath);

	const directory = dirname(target);
	await mkdir(directory, { recursive: true });

	// 目标是目录 → 提前给一条人能看懂的错误。
	// 不拦的话会一路走到 rename 再抛 EISDIR，而那条消息里带着暂存文件的临时路径
	// （`.../adir.<pid>.<uuid>.tmpdir/adir.tmp -> .../adir`）。
	// 模型看到这种路径会以为护栏自己坏了，然后开始瞎试 —— 比错误本身更糟。
	const targetStat = await stat(target).catch(() => undefined);
	if (targetStat?.isDirectory()) {
		throw new Error(`EISDIR: cannot write "${absolutePath}": it is a directory, not a file`);
	}

	// ⚠️ 写权限检查（这一步必须我们自己补）：
	//
	// rename 只要求**目录**可写，不检查**文件**写权限；而内置 writeFile（打开
	// O_WRONLY）对只读文件会 EACCES 失败。不补这道检查，chmod 444 保护的文件
	// 会被本扩展静默覆盖（实测抓到）—— 写入语义不能比内置更弱。
	//
	// 目标不存在时 access 报 ENOENT，那是创建路径，放行；其余错误**原样抛出**：
	// 这不是护栏故障，而是一次与内置一致的正当拒绝，模型该看到真实的失败原因。
	try {
		await access(target, constants.W_OK);
	} catch (err) {
		if (codeOf(err) !== "ENOENT") throw err;
	}

	// ② 记录目标现有权限位（只在"替换"时有意义；新建走 umask 默认）
	let existingMode: number | undefined;
	try {
		const st = await lstat(target);
		if (st.isFile()) existingMode = st.mode & 0o7777;
	} catch {
		/* 新建 */
	}

	const stagingDir = join(directory, `.${basename(target)}.${process.pid}.${randomUUID()}.tmpdir`);
	const tempPath = join(stagingDir, `${basename(target)}.tmp`);

	let stagingCreated = false;
	try {
		// 0o700：暂存目录只有本用户可读写执行（DSH 同款）
		await mkdir(stagingDir, { mode: 0o700 });
		stagingCreated = true;

		// ⚠️ 这里**不能**传 mode 0o600。
		//
		// open(2) 的 mode 会被进程 umask 掩掉，而 rename 会把暂存文件的 mode 原样带到
		// 目标上 —— 对**新建文件**来说，那等于强制 0600，而内置 writeFile 走的是
		// 0o666 & ~umask（通常是 0644）。曾因此让新文件权限从 644 变成 600。
		// 不传 mode → 内核给 0o666 & ~umask，与内置一致。
		const handle = await open(tempPath, "wx");
		try {
			await handle.writeFile(content, { encoding: "utf-8" });
			// ③ fsync：不做这一步，rename 之后崩溃可能得到一个**空**文件
			//    （元数据先于数据落盘）。这是本模块存在的意义，不是可选项。
			await handle.sync();
			// 替换已有文件时保留它的权限位（暂存文件是 0644，不是原来的 mode）
			if (existingMode !== undefined) await handle.chmod(existingMode);
		} finally {
			await handle.close();
		}

		await rename(tempPath, target);

		// ④ fsync 目录：让 rename 这个目录项变更本身也持久。
		//    失败不影响"不出现半个文件"这条保证，只影响崩溃后的持久性，所以不抛。
		await syncDirectory(directory, deps);

		// ⑤ 清理暂存目录。**成功路径也必须清理** —— 早期版本只在 catch 里清理，
		//    结果每写一次就在用户目录里留一个 .xxx.tmpdir（测试直接抓到了）。
		//    此时 tempPath 已被 rename 走，剩下的是空目录。
		try {
			await rm(stagingDir, { recursive: true, force: true });
		} catch (cleanupErr) {
			deps.debug("publish: staging cleanup after success failed", stagingDir, cleanupErr);
		}
		stagingCreated = false;
	} catch (err) {
		// 清理暂存目录（失败也不能掩盖原始错误）
		if (stagingCreated) {
			try {
				await rm(stagingDir, { recursive: true, force: true });
			} catch (cleanupErr) {
				deps.debug("publish: staging cleanup failed", stagingDir, cleanupErr);
			}
		}

		const code = codeOf(err);
		if (code !== undefined && FALLBACK_CODES.has(code)) {
			// 降级：至少让写入成功，但**必须吵**，否则用户以为自己是原子的
			deps.debug(
				`publish: staging unavailable (${code}), falling back to direct write for ${target} — ` +
					`a crash mid-write can leave a truncated file`,
			);
			await fsWriteFile(target, content, "utf-8");
			return { mode: "direct" };
		}
		throw err;
	}

	return { mode: "rename" };
}

/** fsync 一个目录，使其中的 rename/mkdir 持久化。失败不抛（见调用点注释）。 */
async function syncDirectory(directory: string, deps: PublishDeps): Promise<void> {
	let handle;
	try {
		handle = await open(directory, "r");
		await handle.sync();
	} catch (err) {
		// macOS/Linux 一般支持；部分文件系统（网络挂载）会拒绝。不影响原子性。
		deps.debug("publish: directory fsync unsupported, skipping", directory, err);
	} finally {
		try {
			await handle?.close();
		} catch {
			/* 关不上也没别的办法，且已 fsync 过 */
		}
	}
}
