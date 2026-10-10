/**
 * `piggy-guard.js` 的类型声明（TS 通过 `piggy-guard.js` → `piggy-guard.d.ts` 自动配对）。
 *
 * 守卫本体是**要打进安装包的运行时脚本**（tauri `bundle.resources`，由 `pi -e` 加载），
 * 必须是自包含的 `.js`，不能写成 TS；这里只补类型，让测试能被 `tsc` 检查。
 *
 * 改守卫的导出时同步改这里——两者不一致时 `tsc` 会报错，这是有意的（防止测试与实现漂移）。
 */

/** 本档拦截的工具名。 */
export declare const PIGGY_GUARDED_TOOLS: string[];

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

/** 单次写调用的判定；返回 `undefined` 表示放行。 */
export declare function checkWrite(
  event: { toolName?: string; input?: unknown },
  roots: string[] | null,
  baseCwd: string,
): { block: true; reason: string } | undefined;

/** 扩展入口：注册 `tool_call` 钩子。 */
export default function piggyGuard(pi: {
  on(event: string, handler: (event: unknown, ctx?: PiggyGuardHookCtx) => unknown): () => void;
}): void;
