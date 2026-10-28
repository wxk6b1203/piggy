/**
 * `piggy-guard.js` 的类型声明（TS 通过 `piggy-guard.js` → `piggy-guard.d.ts` 自动配对）。
 *
 * 守卫本体是**要打进安装包的运行时脚本**（tauri `bundle.resources`，由 `pi -e` 加载），
 * 必须是自包含的 `.js`，不能写成 TS；这里只补类型，让测试能被 `tsc` 检查。
 *
 * 改守卫的导出时同步改这里——两者不一致时 `tsc` 会报错，这是有意的（防止测试与实现漂移）。
 */

/** 本档拦截写操作的工具名。 */
export declare const PIGGY_GUARDED_TOOLS: string[];

/** 本档做敏感目录检查的读工具名（未提供 path 时以会话 cwd 为基准）。 */
export declare const PIGGY_GUARDED_READ_TOOLS: string[];

/** 会递归读取内容的读工具：搜索根是敏感目录祖先时也必须拒绝。 */
export declare const PIGGY_RECURSIVE_READ_TOOLS: string[];

/** 主目录下的敏感目录名（凭据/私钥所在），与 Rust `paths::SENSITIVE_HOME_SUBDIRS` 镜像。 */
export declare const SENSITIVE_HOME_DIRS: string[];

/** 复刻 pi 的 `normalizeWindowsShellPath`（`/c/...` → `C:\...`）。 */
export declare function normalizeWindowsShellPath(filePath: string): string;

/** 去掉 Windows verbatim 前缀（`\\?\C:\...` / `\\?\UNC\...`）；非 Windows 原样返回。 */
export declare function stripWindowsVerbatim(filePath: string): string;

/**
 * 复刻 pi 的 `resolveToCwd()`：Unicode 空格、`@` 前缀、Windows `/c/`、`~`、`file://`、
 * 相对路径基准。返回绝对路径；畸形 `file://` 返回 `null`（调用方 fail-closed）。
 */
export declare function resolvePiPath(
  filePath: string,
  baseCwd: string,
  home?: string,
  platform?: NodeJS.Platform,
): string | null;

/** 规整为绝对真实路径（穿透符号链接；目标不存在时向上找第一个存在的祖先）。 */
export declare function canonicalize(p: string): string;

/** 解析 `PIGGY_GUARD_ROOTS`；缺失/为空返回 `null`（调用方必须 fail-closed）。 */
export declare function guardRoots(env?: Record<string, string | undefined>): string[] | null;

/**
 * 扩展钩子的第二个参数里我们用到的部分。
 *
 * ⚠️ 用 `sessionManager.getCwd()` 而**不是** `ctx.cwd`：后者在 pi 里是冻结值
 * （`runner.js` 构造时赋值一次），`switch_session` 之后不会变。
 */
export interface PiggyGuardHookCtx {
  sessionManager?: { getCwd?: () => unknown };
}

/** 会话自己的工作目录（规整后的绝对路径）；拿不到返回 `null`。 */
export declare function sessionCwdOf(ctx?: PiggyGuardHookCtx): string | null;

/** 本次写操作的边界：优先会话 cwd，兜底 `PIGGY_GUARD_ROOTS`，都没有则 `null`（fail-closed）。 */
export declare function boundaryFor(
  ctx?: PiggyGuardHookCtx,
  env?: Record<string, string | undefined>,
): string[] | null;

/** 目标是否落在某个根目录内（含根目录本身；不会把 `/work-other` 误判进 `/work`）。 */
export declare function isInside(target: string, root: string): boolean;

/** 写侧可注入的策略（测试用；生产由入口一次算好传入）。 */
export interface CheckWriteOptions {
  sensitiveRoots?: string[];
  home?: string;
  caseInsensitive?: boolean;
}

/** 单次写调用的判定；返回 `undefined` 表示放行。 */
export declare function checkWrite(
  event: { toolName?: string; input?: unknown },
  roots: string[] | null,
  baseCwd: string,
  opts?: CheckWriteOptions,
): { block: true; reason: string } | undefined;

/** 主目录下的敏感根目录（规整后），含 `PI_CODING_AGENT_DIR`。 */
export declare function sensitiveRootsOf(
  home?: string,
  env?: Record<string, string | undefined>,
): string[];

/** 大小写不敏感的 `isInside`（Windows 文件系统不区分大小写）。 */
export declare function isInsideFoldCase(target: string, root: string, caseInsensitive: boolean): boolean;

/** 读侧判定入参（`~` 展开基准、相对路径基准、敏感根与大小写策略均由调用方注入）。 */
export interface CheckReadOptions {
  sensitiveRoots: string[];
  baseCwd: string;
  home: string;
  caseInsensitive?: boolean;
}

/** 单次读调用的判定（敏感目录 fail-closed，其余放行）；返回 `undefined` 表示放行。 */
export declare function checkRead(
  event: { toolName?: string; input?: unknown },
  opts: CheckReadOptions,
): { block: true; reason: string } | undefined;

/** 扩展入口：注册 `tool_call` 钩子。 */
export default function piggyGuard(pi: {
  on(event: string, handler: (event: unknown, ctx?: PiggyGuardHookCtx) => unknown): () => void;
}): void;
