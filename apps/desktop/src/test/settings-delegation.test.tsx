// @vitest-environment jsdom
/**
 * 「子代理委派」开关（docs/06 §6）。
 *
 * 2026-10-30 前限制档位（仅可查看 / 工作区内修改）不能委派：`--tools` 会把扩展
 * 工具整个过滤掉。现在 Rust 侧把 `subagent/subagents_enable` 显式加进白名单，
 * bridge 再把父会话的工具名注册成子代理 capability ceiling，并强制子会话加载守卫。
 *
 * 设置页锁三件事：
 *   1. 开关能读能写（走真机同形的 camelCase / snake_case）；
 *   2. 限制档位下开关**可点**，并明确说"子代理继承当前权限档位"；
 *   3. 已开启时说明它到底做了什么（追加策略 + 自动激活工具）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));

import { SettingsTab } from '@/features/settings/SettingsTab';
import { mountDom, unmountDom, domContainer } from './dom-render';

/** 真机 `perf_config_load` 的返回形状（snake_case）。 */
let cfg: Record<string, unknown> = {};

beforeEach(() => {
  cfg = {
    max_workers: 8,
    idle_timeout_min: 10,
    permission_mode: 'workspace',
    pi_source: 'system',
    pi_path: null,
    subagent_delegation: false,
  };
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    switch (name) {
      case 'perf_config_load':
        return { ...cfg };
      case 'perf_config_save':
        /* 真机是读-改-写：写下去的要能被下一次 `perf_config_load` 读到。
           不落盘的话"再点一次关掉"这类用例会假绿/假红（组件 reload 后又回到旧值）。 */
        if (args?.subagentDelegation !== undefined) cfg.subagent_delegation = Boolean(args.subagentDelegation);
        return null;
      case 'permission_modes':
        return {
          modes: [
            { id: 'readonly', label: '仅可查看', tools: 'read,grep,find,ls' },
            { id: 'workspace', label: '工作区内修改', tools: 'read,grep,find,ls,write,edit' },
            { id: 'full', label: '完全权限', tools: null },
          ],
        };
      case 'pi_source_options':
        return { source: 'system', options: [], builtinAvailable: false, customPath: null };
      default:
        return null;
    }
  });
});

afterEach(async () => {
  await unmountDom();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

/** 设置页左侧导航的第一项是「模型」，委派开关在「通用设置」里。 */
async function mountRuntime() {
  mountDom(<SettingsTab />);
  await flush();
  const btn = [...domContainer().querySelectorAll<HTMLButtonElement>('.pg-settings-navitem')].find(
    (b) => b.textContent === '通用设置',
  );
  if (!btn) throw new Error('找不到「通用设置」导航项');
  await act(async () => {
    btn.click();
    await new Promise((r) => setTimeout(r, 30));
  });
}

/** 找到「子代理委派」那一行里的 switch。 */
function delegationSwitch(): { row: HTMLElement; sw: HTMLButtonElement } {
  const rows = [...domContainer().querySelectorAll<HTMLElement>('.pg-settings-row')];
  const row = rows.find((r) => r.textContent?.includes('子代理委派'));
  if (!row) throw new Error('设置页里找不到「子代理委派」这一行');
  const sw = row.querySelector<HTMLButtonElement>('button[role="switch"]');
  if (!sw) throw new Error('该行里没有 switch');
  return { row, sw };
}

/** 保存调用里带 subagentDelegation 的那次。 */
const savedDelegation = () =>
  invokeMock.mock.calls.filter((c) => c[0] === 'perf_config_save').map((c) => c[1]?.subagentDelegation);

describe('设置页：子代理委派开关', () => {
  it('读回后端状态（开 = checked）', async () => {
    cfg.subagent_delegation = true;
    cfg.permission_mode = 'full';
    await mountRuntime();
    expect(delegationSwitch().sw.getAttribute('aria-checked')).toBe('true');
  });

  it('限制档位下也可开启，并说明子代理继承当前权限档位', async () => {
    cfg.permission_mode = 'readonly';
    await mountRuntime();
    const { sw } = delegationSwitch();
    expect(sw.disabled).toBe(false);
    await act(async () => {
      sw.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(savedDelegation()).toContain(true);

    const text = domContainer().textContent ?? '';
    expect(text).toContain('子代理');
    expect(text).toContain('继承当前权限档位');
    expect(text).not.toContain('子代理委派在该档位不可用');
  });

  it('工作区内修改档 + 已开启：说明它做了什么（策略 + 自动激活 + 继承）', async () => {
    cfg.permission_mode = 'workspace';
    cfg.subagent_delegation = true;
    await mountRuntime();
    const text = domContainer().textContent ?? '';
    expect(text).toContain('subagents_enable');
    expect(text).toContain('系统提示词');
    expect(text).toContain('子代理');
  });

  it('关闭时保存的是 false（不是"不传"，否则关不掉）', async () => {
    cfg.permission_mode = 'full';
    cfg.subagent_delegation = true;
    await mountRuntime();
    const { sw } = delegationSwitch();
    await act(async () => {
      sw.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(savedDelegation()).toContain(false);
  });
});
