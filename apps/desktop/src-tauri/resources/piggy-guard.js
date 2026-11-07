/**
 * Piggy 权限守卫扩展 —— 由 Piggy 以 `pi -e <本文件>` 注入，两个限制档
 *（仅可查看 / 工作区内修改）都启用。
 *
 * ## 为什么必须有它
 * pi 的 `write` / `edit` **不做工作区边界检查**：
 *   packages/coding-agent/src/core/tools/path-utils.ts`resolveToCwd()` 只做 `~` 展开与
 *   相对/绝对路径规整，绝对路径直接落盘。
 * 因此 `--tools read,grep,find,ls,write,edit` 只能**拿掉 shell**，并不能把"修改"限制在工作区内。
 * 边界只能靠扩展的 `tool_call` 钩子拦截：
 *   packages/coding-agent/src/core/extensions/types.ts:1217 `ToolCallEventResult.block`
 *
 * ## 策略来源（**每次写调用现算**，见 `boundaryFor`）
 * 边界 = **会话自己的工作目录**（`ctx.sessionManager.getCwd()`，即"工作区"这个词的定义）。
 * 环境变量 `PIGGY_GUARD_ROOTS`（Piggy 在 spawn 时注入，平台路径分隔符分隔）是**兜底**：
 * 拿不到会话 cwd 时才用它；两边都没有则一律拒绝写操作（fail-closed）——
 * 宁可挡住，也不要在策略丢失时静默放开。
 * 相对路径以边界根目录为基准解析（与 pi 的会话 cwd 一致）。
 *
 * ⚠️ 为什么不能"加载时读一次环境变量就定死"：预热 worker 会被复用去开**别的项目**的会话
 * （`switch_session` 改的是会话 cwd，**不改进程环境**），那样边界会停留在"被预热时那个目录"，
 * 切到项目 B 之后写 B 被拦、写 A 反而放行。2026-10-10 审计发现并修掉。
 * 也别用 `ctx.cwd`：它在 pi 里是冻结值，`switch_session` 之后不会变。
 *
 * ## 覆盖范围（说清楚，不含糊）
 * 拦两类：
 * 1. `write` / `edit`（写边界）：目标必须在会话工作区内（本档已用 `--tools` 白名单移除
 *    `bash` / `powershell`），**并且**目标不能落在敏感目录里——即使工作区就是 home。
 * 2. `read` / `grep` / `find` / `ls`（读敏感目录）：pi 的读工具同样接受绝对路径、
 *    `@` 前缀、`file://`、Windows `/c/...` 与 `~` 展开（`resolveToCwd()`），而
 *    `~/.pi/agent/auth.json` 里存着**所有 API key 明文**——不拦的话，受限档里一次 prompt
 *    injection 就能把密钥读进模型上下文（2026-10-28 审查发现）。
 *    读侧不限制工作区（"仅可查看"承诺的是不改，不是不看系统文件），只对**敏感目录**
 *    （`.pi` / `.ssh` / `.aws` / `.gnupg` + `PI_CODING_AGENT_DIR`，凭据与私钥所在）
 *    fail-closed；`grep`/`find` 的搜索根若是敏感目录的祖先也拒（否则 `grep(path:"~")`
 *    会递归读进去）。
 *
 * **路径解析必须逐字复刻 pi 的 `normalizePath`**（`resolvePiPath`）：少一个 `@`/`file://`/
 * `/c/` 就是一条绕过。2026-10-28 审查实测过这几种形状都能读走 auth.json。
 *
 * **扩展/自定义工具不在守护范围内**——若某扩展自带写文件工具，它能绕过本守卫。
 * 敏感目录清单与 Rust 侧 `config/paths.rs::SENSITIVE_HOME_SUBDIRS` 镜像，两边同步改。
 */

import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PATH_SEP = process.platform === 'win32' ? ';' : ':';

/** 运行期档位文件（`~/.piggy/permission/<tab>.json`，由 Rust 原子写）。 */
export const PERMISSION_FILE_ENV = 'PIGGY_PERMISSION_FILE';
/** spawn 期档位（兜底；文件读不到时用）。与 Rust `pi/process.rs::PERMISSION_ENV` 同名。 */
export const PERMISSION_ENV = 'PIGGY_PERMISSION_MODE';
/** spawn 期工具集（逗号分隔）。档位文件缺失时的最后一道兜底。 */
export const PERMISSION_TOOLS_ENV = 'PIGGY_PERMISSION_TOOLS';

/**
 * 读当前档位。
 *
 * **文件是唯一真相**：切档发生在另一个进程（Rust），扩展不能缓存。每次工具调用都读
 * （几十字节，一次 `readFileSync`），换来"切档立即生效"。
 *
 * 降级链：文件 → 环境变量（spawn 期档位）。文件半写/缺失时退回环境变量，
 * 这样"切档失败"最多是"没切成"，不会变成"没有限制"。
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(path: string, encoding: string) => string} [readFile]
 * @returns {{mode: string, all: boolean, activeTools: string[]|null}}
 */
export function readPermission(env = process.env, readFile = readFileSync) {
  const file = typeof env[PERMISSION_FILE_ENV] === 'string' ? env[PERMISSION_FILE_ENV].trim() : '';
  if (file) {
    try {
      const parsed = JSON.parse(readFile(file, 'utf8'));
      if (parsed && typeof parsed.mode === 'string') {
        const list = Array.isArray(parsed.activeTools)
          ? parsed.activeTools.filter((n) => typeof n === 'string')
          : [];
        return {
          mode: parsed.mode,
          all: parsed.all === true || parsed.mode === 'full',
          // 空列表 = 文件坏了一半：不拿它当"一个工具都不给"，退回"不做名字过滤"
          activeTools: list.length > 0 ? list : null,
        };
      }
    } catch {
      /* 文件还没写出来 / 正在 rename 的瞬间：退回环境变量 */
    }
  }
  const mode =
    typeof env[PERMISSION_ENV] === 'string' && env[PERMISSION_ENV].trim()
      ? env[PERMISSION_ENV].trim()
      : 'workspace';
  const fromEnv = String(env[PERMISSION_TOOLS_ENV] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // ⚠️ 名单缺失时**不能**返回"不过滤"：限制档的 bash 不在路径守卫范围内，
  // 一次文件丢失就会变成提权。这里宁可 fail-closed（toolAllowed 对 null 返回 false）。
  return { mode, all: mode === 'full', activeTools: fromEnv.length > 0 ? fromEnv : null };
}

/**
 * 工具名是否被当前档位允许。
 * 文件名过滤是**第二道**（第一道是 `pi.setActiveTools()` 不把工具声明给模型）；
 * 它兜住"扩展在运行期又注册了工具"这类 setActiveTools 还没跟上的窗口。
 *
 * @param {string} toolName
 * @param {{all: boolean, activeTools: string[]|null}} perm
 * @returns {boolean}
 */
export function toolAllowed(toolName, perm) {
  if (perm.all) return true;
  // 名单缺失 = fail-closed。绝不能让"文件没了"变成"限制没了"。
  if (!perm.activeTools) return false;
  return perm.activeTools.includes(toolName);
}

/** pi `normalizePath` 会归一化的 Unicode 空格（NBSP / en-space / … / 全角空格）。 */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** 本档拦截写操作的工具名。 */
export const PIGGY_GUARDED_TOOLS = ['write', 'edit'];

/** 本档做敏感目录检查的读工具名（未提供 path 参数时以会话 cwd 为基准）。 */
export const PIGGY_GUARDED_READ_TOOLS = ['read', 'grep', 'find', 'ls'];

/** 会**递归**读取内容的工具：搜索根是敏感目录的祖先时也必须拒绝。 */
export const PIGGY_RECURSIVE_READ_TOOLS = ['grep', 'find'];

/** 主目录下的敏感目录名（凭据/私钥所在）。与 `config/paths.rs::SENSITIVE_HOME_SUBDIRS` 镜像。 */
export const SENSITIVE_HOME_DIRS = ['.pi', '.ssh', '.aws', '.gnupg'];

/**
 * 复刻 pi `normalizeWindowsShellPath()`：把 Git Bash / MSYS / Cygwin / WSL 的
 * `/c/Users/...`、`/mnt/c/...`、`/cygdrive/c/...` 转成 `C:\Users\...`。
 *
 * 守卫必须做这一步：pi 的 `resolveToCwd()` 会在 Windows 上先做它，再判断绝对/相对。
 * 不做的话，`/c/Users/x/.pi/agent/auth.json` 在守卫眼里是 `C:\c\Users\...`（不敏感），
 * 在 pi 眼里却是 `C:\Users\x\.pi\agent\auth.json`——一个字符的差别就能读走密钥。
 * @param {string} filePath
 * @returns {string}
 */
export function normalizeWindowsShellPath(filePath) {
  if (!filePath.startsWith('/') || filePath.startsWith('//') || filePath.includes('\\')) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll('/', '\\');
  return `${match[1].toUpperCase()}:\\${suffix ?? ''}`;
}

/**
 * 复刻 pi 的 `resolveToCwd()`（`packages/coding-agent/src/utils/paths.ts::normalizePath`
 * + `resolvePath`）。**这是守卫和 pi 看到同一个文件的前提**，少一步就是一个绕过：
 *
 * - Unicode 空格归一（`normalizeUnicodeSpaces`）
 * - 去掉 CLI 的 `@` 前缀（`stripAtPrefix`）——`@~/.pi/...` 在 pi 眼里就是 `~/.pi/...`
 * - Windows 的 `/c/...` 盘符转换（`normalizeWindowsShellPath`）
 * - `~` / `~/` / `~\` 展开
 * - `file://` → 本地路径
 * - 相对路径以**会话 cwd** 为基准
 *
 * @param {string} filePath 模型给的工具参数
 * @param {string} baseCwd 会话 cwd（相对路径基准）
 * @param {string} [home] 主目录（`~` 展开基准；测试注入用）
 * @param {NodeJS.Platform} [platform] 平台（测试注入用）
 * @returns {string|null} 绝对路径；`file://` 不合法时返回 null（调用方 fail-closed）
 */
export function resolvePiPath(filePath, baseCwd, home = homedir(), platform = process.platform) {
  let normalized = String(filePath).replace(UNICODE_SPACES, ' ');
  if (normalized.startsWith('@')) normalized = normalized.slice(1);
  if (platform === 'win32') normalized = normalizeWindowsShellPath(normalized);
  if (normalized === '~') {
    normalized = home;
  } else if (normalized.startsWith('~/') || (platform === 'win32' && normalized.startsWith('~\\'))) {
    normalized = join(home, normalized.slice(2));
  }
  if (/^file:\/\//.test(normalized)) {
    // 只有 scheme+分隔符、没有路径（`file://`）在 Node 里会解析成 `/` —— 那不是模型想指的
    // 文件，按畸形处理（fail-closed）。2026-11-07 起 Node 24.14 的 fileURLToPath 不再抛错，
    // 旧实现会把它当根目录放行。
    if (/^file:\/\/*$/i.test(normalized)) return null;
    try {
      normalized = fileURLToPath(normalized);
    } catch {
      return null; // 畸形 file URL：拒绝，不退回"当成普通相对路径"
    }
  }
  return isAbsolute(normalized) ? normalized : resolve(baseCwd, normalized);
}

/**
 * 去掉 Windows 的 verbatim 前缀（`\\?\C:\...` → `C:\...`，`\\?\UNC\s\share` → `\\s\share`）。
 *
 * Node 的 `realpathSync` 对 verbatim 输入会原样保留 `\\?\`，而 `homedir()` 给的敏感根
 * 没有前缀；不归一的话 `read("\\\\?\\C:\\Users\\x\\.pi\\agent\\auth.json")` 在守卫眼里
 * 不在敏感目录内，pi 的 `fs.readFile` 却照读。只在 Windows 生效。
 * @param {string} p
 * @returns {string}
 */
export function stripWindowsVerbatim(p) {
  if (process.platform !== 'win32') return p;
  return p.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/i, '');
}

/**
 * 把路径规整为绝对真实路径。
 * 目标可能尚不存在（新建文件），此时逐级向上找到第一个存在的祖先再做 realpath，
 * 以穿透符号链接——否则 `workspace/link -> /etc` 这类路径会骗过前缀比较。
 * @param {string} p 待规整路径
 * @returns {string} 绝对路径（无法解析时退回字面绝对路径）
 */
export function canonicalize(p) {
  let cur = resolve(stripWindowsVerbatim(p));
  /** @type {string[]} */
  const tail = [];
  for (;;) {
    try {
      return resolve(stripWindowsVerbatim(realpathSync(cur)), ...tail);
    } catch {
      // 该级不存在：记下尾段继续向上
    }
    const parent = dirname(cur);
    if (parent === cur) return resolve(stripWindowsVerbatim(p)); // 已到根仍失败
    tail.unshift(cur.slice(parent.length + 1));
    cur = parent;
  }
}

/**
 * 解析环境变量里的白名单根目录。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]|null} 规整后的根目录；缺失/为空时返回 null（调用方须 fail-closed）
 */
export function guardRoots(env = process.env) {
  const raw = env.PIGGY_GUARD_ROOTS ?? '';
  const list = raw
    .split(PATH_SEP)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(canonicalize);
  return list.length > 0 ? list : null;
}

/**
 * 会话自己的工作目录（pi 的 `ctx.sessionManager.getCwd()`）。
 *
 * ⚠️ 不要用 `ctx.cwd` 代替它：那个值在 pi 里是**冻结**的（`runner.js` 构造时赋值一次，
 * `createContext()` 只是把它读出来），`switch_session` 之后不会变。
 * 而 `sessionManager` 是活的 —— pi 自己也用它建会话上下文（`agent-session.js` 的
 * `sessionManager.getCwd()`），所以它才是"这次写入的基准目录"的权威来源。
 *
 * @param {{sessionManager?: {getCwd?: () => unknown}}} [ctx] 扩展钩子的第二个参数
 * @returns {string|null} 绝对路径；拿不到就返回 null（调用方回退）
 */
export function sessionCwdOf(ctx) {
  const raw = ctx?.sessionManager?.getCwd?.();
  return typeof raw === 'string' && raw.trim() !== '' ? canonicalize(raw) : null;
}

/**
 * 本次写操作的边界（白名单根目录）。
 *
 * ## 为什么是"每次调用算一次"，而不是加载时算一次
 *
 * Piggy 的「工作区内修改」档会给进程注入 `PIGGY_GUARD_ROOTS=<标签页 cwd>`，而这个变量是
 * **spawn 那一刻写死的**（`pi/process.rs`）。但**会话的 cwd 可以在同一个进程里变**：
 * `switch_session`（崩溃复活、切权限档位重启都走它）按会话文件头把会话切到目标目录，
 * 改的是会话 cwd、**不改进程环境**。于是加载时算一次的边界会停留在"起进程时那个目录"：
 * 切到项目 B 之后，写 B 被拦、写 A 反而放行 —— 两个方向都错。
 * 2026-10-10 审计发现（本机 full 档看不到，只有「工作区内修改」档才会踩）。
 *
 * 判据：**写边界 = 会话自己的工作目录**（"工作区"这个词的定义），环境变量只是兜底。
 *
 * @param {{sessionManager?: {getCwd?: () => unknown}}} [ctx] 扩展钩子的第二个参数
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]|null} 根目录；两边都拿不到返回 null（fail-closed）
 */
export function boundaryFor(ctx, env = process.env) {
  const session = sessionCwdOf(ctx);
  if (session !== null) return [session];
  return guardRoots(env);
}

/**
 * 判断目标是否落在某个根目录内（含根目录本身）。
 * @param {string} target 已规整的绝对路径
 * @param {string} root 已规整的绝对根目录
 * @returns {boolean}
 */
export function isInside(target, root) {
  if (target === root) return true;
  return target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * 判定一次写调用是否放行。抽成纯函数以便脱离 pi 运行时直接测试。
 *
 * 两道闸：
 * 1. **敏感目录一律拒**——即使工作区就是 home（新会话默认 cwd 就是 `~`），
 *    也不能让 `write` 落到 `~/.ssh` / `~/.pi` / 自定义 agent 目录里；
 * 2. 目标必须在工作区内（`PIGGY_GUARD_ROOTS` / 会话 cwd）。
 *
 * @param {{toolName: string, input: unknown}} event 工具调用事件
 * @param {string[]|null} roots 白名单根目录
 * @param {string} baseCwd 相对路径基准（= 第一个根目录）
 * @param {object} [opts]
 * @param {string[]} [opts.sensitiveRoots] `sensitiveRootsOf()` 的结果
 * @param {string} [opts.home] 主目录（`~` 展开基准）
 * @param {boolean} [opts.caseInsensitive] Windows 为 true
 * @returns {{block: true, reason: string}|undefined} 返回 undefined 表示放行
 */
export function checkWrite(event, roots, baseCwd, opts = {}) {
  if (!PIGGY_GUARDED_TOOLS.includes(event?.toolName)) return undefined;

  const raw = /** @type {{path?: unknown}} */ (event?.input)?.path;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { block: true, reason: 'Piggy 守卫：写工具未提供 path，已拒绝' };
  }
  const home = opts.home ?? homedir();
  const caseInsensitive = opts.caseInsensitive ?? process.platform === 'win32';
  const sensitive = opts.sensitiveRoots ?? sensitiveRootsOf(home);
  const resolved = resolvePiPath(raw, baseCwd, home);
  if (resolved === null) {
    return { block: true, reason: 'Piggy 守卫：无法解析这个路径（畸形 file:// URL），已拒绝' };
  }
  const abs = canonicalize(resolved);
  if (sensitive.some((root) => isInsideFoldCase(abs, root, caseInsensitive))) {
    return {
      block: true,
      reason: `Piggy 守卫：${abs} 在敏感目录内（API key / 私钥所在），任何档位都不允许写入`,
    };
  }
  if (roots === null) {
    return {
      block: true,
      reason: 'Piggy 守卫：未收到工作区白名单（PIGGY_GUARD_ROOTS 缺失），已拒绝一切写入',
    };
  }
  if (roots.some((root) => isInside(abs, root))) return undefined;

  return {
    block: true,
    reason: `Piggy 守卫：${abs} 在工作区之外。当前档位「工作区内修改」只允许改动 ${roots.join('、')}。`,
  };
}

/**
 * 主目录下的敏感根目录（规整后），外加**实际 agent 目录**。
 *
 * `~/.pi` 只是默认值：pi 支持 `PI_CODING_AGENT_DIR` 把 auth.json 搬到别处。
 * 守卫跑在 pi 进程里，能读到同一个环境变量；不把它算进来，改过 agent 目录的机器上
 * 读侧/写侧都保护不到 auth.json。
 *
 * @param {string} [home] 主目录（默认 `os.homedir()`；测试注入用）
 * @param {NodeJS.ProcessEnv} [env] 环境变量（测试注入用）
 * @returns {string[]} 规整后的敏感目录绝对路径
 */
export function sensitiveRootsOf(home = homedir(), env = process.env) {
  const roots = SENSITIVE_HOME_DIRS.map((d) => canonicalize(join(home, d)));
  const custom = typeof env.PI_CODING_AGENT_DIR === 'string' ? env.PI_CODING_AGENT_DIR.trim() : '';
  if (custom) {
    const abs = resolvePiPath(custom, process.cwd(), home, process.platform);
    if (abs) roots.push(canonicalize(abs));
  }
  return roots;
}

/**
 * 大小写不敏感的 `isInside`（Windows 文件系统不区分大小写；realpath 只保证**存在部分**
 * 的 casing 一致，`os.homedir()` 与目标 realpath 的盘符/祖先大小写仍可能不同）。
 * @param {string} target 已规整的绝对路径
 * @param {string} root 已规整的绝对根目录
 * @param {boolean} caseInsensitive
 * @returns {boolean}
 */
export function isInsideFoldCase(target, root, caseInsensitive) {
  return caseInsensitive
    ? isInside(target.toLowerCase(), root.toLowerCase())
    : isInside(target, root);
}

/**
 * 判定一次读调用是否放行（敏感目录 fail-closed）。
 * 抽成纯函数以便脱离 pi 运行时直接测试。
 *
 * ## 两条判据（缺一条都能读走密钥）
 *
 * 1. **目标在敏感目录内** → 拒。目标用 `resolvePiPath()` 解析，与 pi 的
 *    `read`/`grep`/`find`/`ls` 看到的是同一个路径（`@` / `file://` / `/c/` / `~` 全算）。
 * 2. **递归读工具（grep/find）的搜索根是敏感目录的祖先** → 拒。只查"搜索根本身是否敏感"
 *    挡不住 `grep(path: "~")`：根是 home（不敏感），递归下去会读 `~/.pi/agent/auth.json`。
 *    未提供 path 时搜索根就是会话 cwd；新会话默认 cwd 就是 home，所以这条同样适用。
 *
 * `ls` 只返回目录项名字、不返回文件内容，因此不按祖先拒；它自己的目标若在敏感目录内照旧拒。
 *
 * @param {{toolName: string, input: unknown}} event 工具调用事件
 * @param {object} opts
 * @param {string[]} opts.sensitiveRoots `sensitiveRootsOf()` 的结果
 * @param {string} opts.baseCwd 相对路径基准（与写侧一致 = 会话 cwd）
 * @param {string} opts.home 主目录（`~` 展开基准）
 * @param {boolean} [opts.caseInsensitive] Windows 为 true
 * @returns {{block: true, reason: string}|undefined} 返回 undefined 表示放行
 */
export function checkRead(event, opts) {
  if (!PIGGY_GUARDED_READ_TOOLS.includes(event?.toolName)) return undefined;

  const raw = /** @type {{path?: unknown}} */ (event?.input)?.path;
  // 未提供 path：pi 以会话 cwd 为基准；递归读工具必须拿这个 cwd 做祖先判定
  const effective = typeof raw === 'string' && raw.trim() !== '' ? raw : opts.baseCwd;
  const resolved = resolvePiPath(effective, opts.baseCwd, opts.home);
  if (resolved === null) {
    return { block: true, reason: 'Piggy 守卫：无法解析这个路径（畸形 file:// URL），已拒绝读取' };
  }
  const abs = canonicalize(resolved);
  const caseInsensitive = opts.caseInsensitive ?? false;
  const inside = (path, root) => isInsideFoldCase(path, root, caseInsensitive);

  const hit = opts.sensitiveRoots.find((root) => inside(abs, root));
  if (hit) {
    return {
      block: true,
      reason: `Piggy 守卫：${abs} 在敏感目录内（API key / 私钥所在），本档位不允许读取`,
    };
  }
  if (PIGGY_RECURSIVE_READ_TOOLS.includes(event.toolName)) {
    const ancestor = opts.sensitiveRoots.find((root) => inside(root, abs));
    if (ancestor) {
      return {
        block: true,
        reason: `Piggy 守卫：搜索根 ${abs} 包含敏感目录 ${ancestor}，递归读取会越过边界；请把 path 指到工作区子目录`,
      };
    }
  }
  return undefined;
}

/**
 * 扩展入口。
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 */
export default function piggyGuard(pi) {
  const envRoots = guardRoots();
  if (envRoots === null) {
    // 提前告警：真到拦截时才报错会淹没在工具结果里
    console.error('[piggy-guard] PIGGY_GUARD_ROOTS 缺失，本会话所有写入都会被拒绝');
  }

  /* 完全权限档的"基线工具集"：进入完全权限时恢复到它。
     只在**完全权限**下刷新——限制档里 `getActiveTools()` 已经被我们自己收窄了，
     拿它当基线会把收窄结果当成"全部"。 */
  const state = { fullTools: null, narrowed: false };

  const applyMode = () => {
    const perm = readPermission();
    if (typeof pi.setActiveTools !== 'function') return perm;
    if (perm.all) {
      if (state.narrowed && state.fullTools) {
        pi.setActiveTools(state.fullTools);
        state.narrowed = false;
      }
      return perm;
    }
    if (perm.activeTools) {
      pi.setActiveTools(perm.activeTools);
      state.narrowed = true;
    }
    return perm;
  };

  pi.on('session_start', () => {
    // 先记基线（此刻还是 pi 的默认全集），再按档位收窄
    if (typeof pi.getActiveTools === 'function') state.fullTools = pi.getActiveTools();
    applyMode();
  });

  /* 每轮开始前重放一次档位：切档可能发生在两轮之间（用户点了档位、或另一个入口改了文件）。
     这个位置是权威的——`before_agent_start` 里调用 `setActiveTools()` 不会被 pi 撤销。 */
  pi.on('before_agent_start', () => {
    const perm = readPermission();
    if (perm.all && typeof pi.getActiveTools === 'function') {
      // 完全权限下让 pi 当权威：新注册的工具（MCP 连接完成等）会被自动激活
      if (state.narrowed && state.fullTools) {
        pi.setActiveTools(state.fullTools);
        state.narrowed = false;
      }
      state.fullTools = pi.getActiveTools();
      return;
    }
    applyMode();
  });

  /* ⚠️ 边界**每次调用现算**（见 boundaryFor）：会话可能在同一个进程里被 switch_session
     切到别的目录，spawn 时写死的 PIGGY_GUARD_ROOTS 那时已经过期，只有会话自己的 cwd 是权威。 */
  pi.on('tool_call', async (event, ctx) => {
    const perm = readPermission();
    // 完全权限：不拦、不查路径（与 2026-11-07 之前"不注入守卫"的语义一致）
    if (perm.all) return undefined;
    // 第一道已经由 setActiveTools 拿掉；这一道兜住"扩展运行期新注册"的窗口
    if (!toolAllowed(event?.toolName, perm)) {
      return {
        block: true,
        reason: `Piggy 守卫：当前权限档位「${perm.mode}」不提供工具 ${event?.toolName}`,
      };
    }
    const roots = boundaryFor(ctx);
    const baseCwd = roots?.[0] ?? process.cwd();
    const home = homedir();
    const sensitiveRoots = sensitiveRootsOf(home);
    const caseInsensitive = process.platform === 'win32';
    const write = checkWrite(event, roots, baseCwd, { home, sensitiveRoots, caseInsensitive });
    if (write) return write;
    return checkRead(event, {
      sensitiveRoots,
      baseCwd,
      home,
      caseInsensitive,
    });
  });
}
