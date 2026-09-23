/**
 * Piggy 权限守卫扩展 —— 由 Piggy 以 `pi -e <本文件>` 注入，只在「工作区内修改」档启用。
 *
 * ## 为什么必须有它
 * pi 的 `write` / `edit` **不做工作区边界检查**：
 *   packages/coding-agent/src/core/tools/path-utils.ts`resolveToCwd()` 只做 `~` 展开与
 *   相对/绝对路径规整，绝对路径直接落盘。
 * 因此 `--tools read,grep,find,ls,write,edit` 只能**拿掉 shell**，并不能把"修改"限制在工作区内。
 * 边界只能靠扩展的 `tool_call` 钩子拦截：
 *   packages/coding-agent/src/core/extensions/types.ts:1217 `ToolCallEventResult.block`
 *
 * ## 策略来源
 * 白名单根目录从环境变量 `PIGGY_GUARD_ROOTS` 读取（平台路径分隔符分隔；Piggy 目前只传一个 = 标签页 cwd）。
 * **该变量缺失时一律拒绝写操作（fail-closed）** —— 宁可挡住，也不要在策略丢失时静默放开。
 * 相对路径以第一个根目录为基准解析（与 pi 的会话 cwd 一致）。
 *
 * ## 覆盖范围（说清楚，不含糊）
 * 只拦截 `write` / `edit` 两个内置写工具。本档已用 `--tools` 白名单移除了 `bash` / `powershell`，
 * 但**扩展/自定义工具不在守护范围内**——若某扩展自带写文件工具，它能绕过本守卫。
 */

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';

const PATH_SEP = process.platform === 'win32' ? ';' : ':';

/** 本档拦截的工具名。 */
export const PIGGY_GUARDED_TOOLS = ['write', 'edit'];

/**
 * 把路径规整为绝对真实路径。
 * 目标可能尚不存在（新建文件），此时逐级向上找到第一个存在的祖先再做 realpath，
 * 以穿透符号链接——否则 `workspace/link -> /etc` 这类路径会骗过前缀比较。
 * @param {string} p 待规整路径
 * @returns {string} 绝对路径（无法解析时退回字面绝对路径）
 */
export function canonicalize(p) {
  let cur = resolve(p);
  /** @type {string[]} */
  const tail = [];
  for (;;) {
    try {
      return resolve(realpathSync(cur), ...tail);
    } catch {
      // 该级不存在：记下尾段继续向上
    }
    const parent = dirname(cur);
    if (parent === cur) return resolve(p); // 已到根仍失败
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
 * @param {{toolName: string, input: unknown}} event 工具调用事件
 * @param {string[]|null} roots 白名单根目录
 * @param {string} baseCwd 相对路径基准（= 第一个根目录）
 * @returns {{block: true, reason: string}|undefined} 返回 undefined 表示放行
 */
export function checkWrite(event, roots, baseCwd) {
  if (!PIGGY_GUARDED_TOOLS.includes(event?.toolName)) return undefined;

  const raw = /** @type {{path?: unknown}} */ (event?.input)?.path;
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { block: true, reason: 'Piggy 守卫：写工具未提供 path，已拒绝' };
  }
  if (roots === null) {
    return {
      block: true,
      reason: 'Piggy 守卫：未收到工作区白名单（PIGGY_GUARD_ROOTS 缺失），已拒绝一切写入',
    };
  }
  const abs = canonicalize(isAbsolute(raw) ? raw : resolve(baseCwd, raw));
  if (roots.some((root) => isInside(abs, root))) return undefined;

  return {
    block: true,
    reason: `Piggy 守卫：${abs} 在工作区之外。当前档位「工作区内修改」只允许改动 ${roots.join('、')}。`,
  };
}

/**
 * 扩展入口。
 * @param {import('@earendil-works/pi-coding-agent').ExtensionAPI} pi
 */
export default function piggyGuard(pi) {
  const roots = guardRoots();
  const baseCwd = roots?.[0] ?? process.cwd();
  if (roots === null) {
    // 提前告警：真到拦截时才报错会淹没在工具结果里
    console.error('[piggy-guard] PIGGY_GUARD_ROOTS 缺失，本会话所有写入都会被拒绝');
  }
  pi.on('tool_call', async (event) => checkWrite(event, roots, baseCwd));
}
