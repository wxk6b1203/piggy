/**
 * 子代理权限继承（docs/06 §6.3）：ceiling 与 required guard 的注册/清理。
 *
 * 这些测试直接打 pi-subagents 的**公开全局注册表**，不启动 pi：
 * 它们守的是"限制档位下子代理只能拿到父会话的工具，且子会话必须加载守卫"。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  CAPABILITY_REGISTRY_KEY,
  GUARD_EXTENSION_ID,
  POLICY_SOURCE,
  REQUIRED_EXTENSIONS_REGISTRY_KEY,
  installChildPolicy,
  readChildPolicy,
  restrictedWorkflowBlockReason,
} from './subagent-policy';

type RequiredSnapshot = ReadonlyArray<{ id: string; path: string; requireForAllRunners?: true }>;
type CapRegistry = Map<string, Map<symbol, { source: string; ceiling: unknown }>>;
interface ReqRegistry {
  version: number;
  bySession: Map<string, RequiredSnapshot>;
}

let caps: CapRegistry;
let req: ReqRegistry;
let dir: string;
let guard: string;

beforeEach(() => {
  caps = new Map();
  req = { version: 1, bySession: new Map() };
  (globalThis as unknown as Record<symbol, unknown>)[CAPABILITY_REGISTRY_KEY] = caps;
  (globalThis as unknown as Record<symbol, unknown>)[REQUIRED_EXTENSIONS_REGISTRY_KEY] = req;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piggy-policy-'));
  guard = path.join(dir, 'piggy-guard.js');
  fs.writeFileSync(guard, '// guard');
});

afterEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[CAPABILITY_REGISTRY_KEY];
  delete (globalThis as unknown as Record<symbol, unknown>)[REQUIRED_EXTENSIONS_REGISTRY_KEY];
  fs.rmSync(dir, { recursive: true, force: true });
});

const env = (overrides: Record<string, string | undefined> = {}) => ({
  PIGGY_PERMISSION_MODE: 'workspace',
  PIGGY_SUBAGENT_ALLOWED_TOOLS: 'read,grep,find,ls,write,edit',
  PIGGY_GUARD_SCRIPT: guard,
  ...overrides,
});

describe('readChildPolicy：从父会话环境算出子代理边界', () => {
  it('完全权限 / 未设置档位 → none（不注册）', () => {
    expect(readChildPolicy({ PIGGY_PERMISSION_MODE: 'full' })).toEqual({ kind: 'none' });
    expect(readChildPolicy({})).toEqual({ kind: 'none' });
  });

  it('限制档位 → ready，并排序去重工具名', () => {
    expect(readChildPolicy(env({ PIGGY_SUBAGENT_ALLOWED_TOOLS: 'write, read,read' }))).toEqual({
      kind: 'ready',
      allowedTools: ['read', 'write'],
      guardScript: fs.realpathSync(guard),
    });
  });

  it('缺工具名单 / 缺守卫 / 守卫不存在 → blocked（fail-closed）', () => {
    expect(readChildPolicy(env({ PIGGY_SUBAGENT_ALLOWED_TOOLS: '' }))).toMatchObject({ kind: 'blocked' });
    expect(readChildPolicy(env({ PIGGY_GUARD_SCRIPT: '' }))).toMatchObject({ kind: 'blocked' });
    expect(readChildPolicy(env({ PIGGY_GUARD_SCRIPT: path.join(dir, 'nope.js') }))).toMatchObject({
      kind: 'blocked',
    });
  });

  it('未知档位 → blocked（不把新档位当 Full 放行）', () => {
    expect(readChildPolicy(env({ PIGGY_PERMISSION_MODE: 'sandbox' }))).toMatchObject({ kind: 'blocked' });
  });
});

describe('restrictedWorkflowBlockReason：workflow 不进限制档位', () => {
  it('普通 agent 委派放行', () => {
    expect(restrictedWorkflowBlockReason({ agent: 'reviewer', task: 'x' }, 'workspace')).toBeNull();
  });
  it('workflow / script 在限制档位拦截，Full 放行', () => {
    expect(restrictedWorkflowBlockReason({ workflow: 'review' }, 'read-only')).toContain('workflow');
    expect(restrictedWorkflowBlockReason({ script: 'return 1' }, 'workspace')).toContain('workflow');
    expect(restrictedWorkflowBlockReason({ workflow: 'review' }, 'full')).toBeNull();
    expect(restrictedWorkflowBlockReason({ workflow: 'review' }, undefined)).toBeNull();
  });
});

describe('installChildPolicy：ceiling + required guard', () => {
  it('注册后子代理拿到同一套工具，子会话强制加载守卫；dispose 全部清掉', () => {
    const plan = readChildPolicy(env());
    if (plan.kind !== 'ready') throw new Error('测试前置失败');
    const handle = installChildPolicy('session-1', plan, '0.78.0');

    const ceiling = caps.get('session-1')?.values().next().value?.ceiling as {
      allowedTools: string[];
      denyExtensions: boolean;
      sources: string[];
    };
    expect(ceiling.allowedTools).toEqual(['edit', 'find', 'grep', 'ls', 'read', 'write']);
    expect(ceiling.denyExtensions).toBe(false);
    expect(ceiling.sources).toEqual([POLICY_SOURCE]);

    expect(req.bySession.get('session-1')).toEqual([
      { id: GUARD_EXTENSION_ID, path: fs.realpathSync(guard), requireForAllRunners: true },
    ]);

    handle.dispose();
    expect(caps.has('session-1')).toBe(false);
    expect(req.bySession.has('session-1')).toBe(false);
  });

  it('同一会话已注册过 required extensions → 拒绝覆盖，不留下半个 ceiling', () => {
    req.bySession.set('session-1', [{ id: 'other', path: guard }]);
    const plan = readChildPolicy(env());
    if (plan.kind !== 'ready') throw new Error('测试前置失败');

    expect(() => installChildPolicy('session-1', plan, '0.78.0')).toThrow(/已经注册/);
    expect(caps.has('session-1')).toBe(false);
    expect(req.bySession.get('session-1')).toEqual([{ id: 'other', path: guard }]);
  });

  it('pi-subagents 版本过旧 / 找不到 → 抛错（调用方据此 fail-closed）', () => {
    const plan = readChildPolicy(env());
    if (plan.kind !== 'ready') throw new Error('测试前置失败');
    expect(() => installChildPolicy('session-1', plan, '0.70.0')).toThrow(/≥0.78/);
    expect(() => installChildPolicy('session-1', plan, '')).toThrow(/≥0.78/);
  });
});
