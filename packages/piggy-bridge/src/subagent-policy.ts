/**
 * 子代理委派的权限继承（docs/06 §6.3，2026-10-30）。
 *
 * ## 为什么不是"开关打开就完事"
 *
 * `pi-subagents` 的 child 默认按 **agent 自己声明的 tools** 启动（例如 `worker` 带
 * `bash/read/edit/write`），并不自动继承父会话的 `--tools`。父会话在限制档位里
 * 只拿到 `read,grep,find,ls`（或再带 `write,edit`），如果子代理拿到 `bash`，
 * 就出现"只读的父进程派生出可执行 shell 的子代理"——这是越权，不能接受。
 *
 * `pi-subagents` 为此提供了两个**公开**的进程内注册表（session-scoped）：
 *
 * - `capability-ceiling`：把子代理的 `allowedTools` 收窄到父会话同一套；
 * - `required-child-extensions`：强制每个子会话加载 Piggy 的守卫扩展，
 *   这样即便子代理拿到 `write/edit`，写边界和敏感目录仍由守卫执行。
 *
 * 这里直接用它们公开的全局注册表键，而不 `import "pi-subagents/..."`：
 * bridge 是一个**单文件**注入扩展，和 `pi-subagents` 各自独立安装；
 * 在 bridge 的模块图上加一个运行时依赖会把打包/解析耦合到用户机器上的版本。
 * 键与 version 都是 pi-subagents 文档化的 v1 契约；注册表不存在时我们
 * **fail-closed**（返回 blocked，不激活 subagent），绝不"注册不上还继续放行"。
 *
 * ## 继承的语义
 *
 * | 父档位 | 子代理 allowedTools | 子会话守卫 |
 * |---|---|---|
 * | 仅可查看 | read,grep,find,ls | 强制加载 |
 * | 工作区内修改 | read,grep,find,ls,write,edit | 强制加载 |
 * | 完全权限 | 不注册 ceiling（不限制） | 不注册 |
 *
 * 注意 ceiling 是**交集**：agent 自己声明的 `bash` 会被去掉；`write` 只有在父档位
 * 本来就有时才保留。嵌套委派不在 ceiling 里（`subagent` 本身不在 allowedTools）。
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const CAPABILITY_REGISTRY_KEY = Symbol.for('pi-subagents.capability-ceiling.v1');
export const REQUIRED_EXTENSIONS_REGISTRY_KEY = Symbol.for('pi-subagents.required-child-extensions.v1');
export const POLICY_SOURCE = 'piggy';
export const GUARD_EXTENSION_ID = 'piggy-guard';

export interface ChildPolicyEnv {
  PIGGY_PERMISSION_MODE?: string;
  PIGGY_SUBAGENT_ALLOWED_TOOLS?: string;
  PIGGY_GUARD_SCRIPT?: string;
}

export type PolicyPlan =
  | { kind: 'none' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'ready'; allowedTools: string[]; guardScript: string };

function parseTools(raw: string | undefined): string[] {
  return [
    ...new Set(
      (raw ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * 从 Rust 侧传进来的环境变量算出"这次会话该怎么限制子代理"。
 *
 * 纯函数，便于单测；不读 `process.env`，调用方显式传入。
 */
export function readChildPolicy(env: ChildPolicyEnv): PolicyPlan {
  const mode = env.PIGGY_PERMISSION_MODE?.trim();
  if (!mode || mode === 'full') return { kind: 'none' };
  if (mode !== 'read-only' && mode !== 'workspace') {
    return { kind: 'blocked', reason: `未知权限档位 ${mode}` };
  }

  const allowedTools = parseTools(env.PIGGY_SUBAGENT_ALLOWED_TOOLS);
  if (allowedTools.length === 0) {
    return { kind: 'blocked', reason: 'PIGGY_SUBAGENT_ALLOWED_TOOLS 缺失（父会话工具边界未知）' };
  }

  const guard = env.PIGGY_GUARD_SCRIPT?.trim();
  if (!guard) return { kind: 'blocked', reason: 'PIGGY_GUARD_SCRIPT 缺失（子会话无法加载守卫）' };
  if (!path.isAbsolute(guard)) return { kind: 'blocked', reason: `守卫脚本不是绝对路径: ${guard}` };

  let real: string;
  try {
    real = fs.realpathSync(guard);
    if (!fs.statSync(real).isFile()) {
      return { kind: 'blocked', reason: `守卫脚本不是文件: ${real}` };
    }
  } catch (e) {
    return { kind: 'blocked', reason: `守卫脚本无法解析: ${String(e)}` };
  }
  return { kind: 'ready', allowedTools: allowedTools.sort(), guardScript: real };
}

interface CapabilityRegistryRoot {
  get(sessionId: string): Map<symbol, { source: string; ceiling: unknown }> | undefined;
  set(sessionId: string, value: Map<symbol, { source: string; ceiling: unknown }>): void;
  delete(sessionId: string): void;
  readonly size: number;
}

interface RequiredRegistryRoot {
  version: number;
  bySession: Map<string, ReadonlyArray<{ id: string; path: string; requireForAllRunners?: true }>>;
}

/** pi-subagents 的安装版本；找不到返回 undefined（调用方 fail-closed）。 */
export function piSubagentsVersion(): string | undefined {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), '.pi', 'agent');
  const candidates = [
    path.join(agentDir, 'npm', 'node_modules', 'pi-subagents', 'package.json'),
    path.join(agentDir, 'extensions', 'pi-subagents', 'package.json'),
    path.join(process.cwd(), 'node_modules', 'pi-subagents', 'package.json'),
  ];
  for (const p of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf-8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.trim()) return parsed.version.trim();
    } catch {
      // 继续找下一个候选
    }
  }
  return undefined;
}

/** capability ceiling / required child extensions 都是 0.78 起可用的公开注册表。 */
export function supportsChildPolicy(version: string | undefined): boolean {
  if (!version) return false;
  const parts = version.split('.');
  const major = Number.parseInt(parts[0] ?? '', 10);
  const minor = Number.parseInt(parts[1] ?? '', 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return false;
  return major > 0 || minor >= 78;
}

/**
 * 两个注册表都是**懒创建**的：pi-subagents 只在第一次解析/注册时才写 globalThis。
 * bridge 必须能在它之前注册，所以这里按同样的 v1 形状补建；版本检查
 * （`supportsChildPolicy`）保证不会对不认识的旧版本"补建一个没人读的注册表"。
 */
function capabilityRegistry(): CapabilityRegistryRoot {
  let root = (globalThis as Record<symbol, unknown>)[CAPABILITY_REGISTRY_KEY];
  if (root === undefined) {
    root = new Map();
    (globalThis as unknown as Record<symbol, unknown>)[CAPABILITY_REGISTRY_KEY] = root;
  }
  if (!(root instanceof Map)) {
    throw new Error('pi-subagents capability-ceiling registry 形状不对（版本过旧？）');
  }
  return root as CapabilityRegistryRoot;
}

function requiredRegistry(): RequiredRegistryRoot {
  let root = (globalThis as Record<symbol, unknown>)[REQUIRED_EXTENSIONS_REGISTRY_KEY] as
    | RequiredRegistryRoot
    | undefined;
  if (root === undefined) {
    root = { version: 1, bySession: new Map() };
    (globalThis as unknown as Record<symbol, unknown>)[REQUIRED_EXTENSIONS_REGISTRY_KEY] = root;
  }
  if (!root || root.version !== 1 || !(root.bySession instanceof Map)) {
    throw new Error('pi-subagents required-child-extensions registry 形状不对（版本过旧？）');
  }
  return root;
}

/**
 * 限制档位下 workflow 脚本委派的拦截理由（null = 放行）。
 *
 * workflow 的 `runs.host` 能起宿主命令，子代理的 capability ceiling 与路径守卫
 * 都覆盖不到；所以在受限档位直接拒绝，只放行普通 agent 委派。
 */
export function restrictedWorkflowBlockReason(input: unknown, mode: string | undefined): string | null {
  if (!mode || mode === 'full') return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  if (record.workflow === undefined && record.script === undefined) return null;
  return 'Piggy：限制档位下不允许 workflow 脚本委派（脚本的宿主命令无法继承路径守卫）；请直接委托一个 agent。';
}

/**
 * 给当前父会话安装子代理限制。返回的 dispose 必须在会话结束时调用，
 * 否则注册表会在同一进程里泄漏到后续会话。
 *
 * 失败时抛错；调用方必须把失败当成"不能启用委派"，不能静默忽略。
 */
export function installChildPolicy(
  sessionId: string,
  plan: Extract<PolicyPlan, { kind: 'ready' }>,
  version: string | undefined = piSubagentsVersion(),
): { dispose(): void } {
  if (!sessionId) throw new Error('installChildPolicy 需要 sessionId');
  if (!supportsChildPolicy(version)) {
    throw new Error(
      `pi-subagents 版本过旧或找不到（${version ?? '未安装'}）；需要 ≥0.78 才能把子代理限制在父会话权限内`,
    );
  }
  const caps = capabilityRegistry();
  const required = requiredRegistry();
  const reqMap = required.bySession;
  if (reqMap.has(sessionId)) {
    throw new Error(`会话 ${sessionId} 已经注册过 required child extensions，拒绝覆盖`);
  }

  let bySession = caps.get(sessionId);
  if (!bySession) {
    bySession = new Map();
    caps.set(sessionId, bySession);
  }
  const token = Symbol(`${POLICY_SOURCE}:${sessionId}`);
  const ceiling = {
    version: 1,
    allowedTools: [...plan.allowedTools],
    denyExtensions: false,
    sources: [POLICY_SOURCE],
  };
  bySession.set(token, { source: POLICY_SOURCE, ceiling });

  const snapshot = Object.freeze([
    Object.freeze({ id: GUARD_EXTENSION_ID, path: plan.guardScript, requireForAllRunners: true as const }),
  ]);
  reqMap.set(sessionId, snapshot);

  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      bySession?.delete(token);
      if (bySession?.size === 0) caps.delete(sessionId);
      if (reqMap.get(sessionId) === snapshot) reqMap.delete(sessionId);
    },
  };
}
