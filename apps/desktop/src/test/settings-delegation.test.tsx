// @vitest-environment jsdom
/**
 * 「子代理委派」开关（docs/06 §6）。
 *
 * 这个开关最容易出的问题不是"点不动"，而是**点了没用却不说**：
 * 限制档位（仅可查看 / 工作区内修改）下 `--tools` 白名单会把扩展工具整个过滤掉，
 * pi 进程里根本没有 `subagent`，开关开了也毫无变化。真机验证：
 *
 *   --tools read,grep,find,ls  →  pi.getAllTools() = ['read','grep','find','ls']
 *
 * 本项目的铁律是"权限档绝不能悄悄降级/静默失效"，所以设置页必须**当场说出原因**，
 * 而不是让用户开个会话慢慢发现。这里锁三件事：
 *   1. 开关能读能写（走真机同形的 camelCase / snake_case）；
 *   2. 档位不是 full 时开关**禁用**且给出可见原因；
 *   3. 档位是 full 且已开启时，说明它到底做了什么（追加策略 + 自动激活工具）。
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
  invokeMock.mockImplementation(async (name: string) => {
    switch (name) {
      case 'perf_config_load':
        return { ...cfg };
      case 'perf_config_save':
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

/** 设置页有四个 tab，委派开关在「运行」里；默认停在 Provider 认证。 */
async function mountRuntime() {
  mountDom(<SettingsTab />);
  await flush();
  const btn = [...domContainer().querySelectorAll<HTMLButtonElement>('.pg-settings-tabs button')].find(
    (b) => b.textContent === '运行',
  );
  if (!btn) throw new Error('找不到「运行」标签页');
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

  it('限制档位下开关禁用，并**当场说明原因**（不能等用户开会话才发现）', async () => {
    cfg.permission_mode = 'readonly';
    await mountRuntime();
    const { sw } = delegationSwitch();
    expect(sw.disabled).toBe(true);
    const text = domContainer().textContent ?? '';
    expect(text).toContain('子代理委派在该档位不可用');
    expect(text).toContain('完全权限');
    // 原因要具体到机制，不能只说"不可用"
    expect(text).toContain('--tools');
  });

  it('完全权限档：可点，点一下把 subagentDelegation=true 存下去', async () => {
    cfg.permission_mode = 'full';
    await mountRuntime();
    const { sw } = delegationSwitch();
    expect(sw.disabled).toBe(false);
    await act(async () => {
      sw.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(savedDelegation()).toContain(true);
  });

  it('完全权限档 + 已开启：说明它做了什么（追加策略 + 自动激活工具）', async () => {
    cfg.permission_mode = 'full';
    cfg.subagent_delegation = true;
    await mountRuntime();
    const text = domContainer().textContent ?? '';
    expect(text).toContain('subagents_enable');
    expect(text).toContain('系统提示词');
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
