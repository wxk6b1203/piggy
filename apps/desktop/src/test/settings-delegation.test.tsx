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
  invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    switch (name) {
      case 'perf_config_load':
        return { ...cfg };
      case 'perf_config_save':
        /* 真机是读-改-写：写下去的要能被下一次 `perf_config_load` 读到。
           不落盘的话"再点一次关掉"这类用例会假绿/假红（组件 reload 后又回到旧值）。 */
        if (args?.warmWorker !== undefined) cfg.warm_worker = Boolean(args.warmWorker);
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

/**
 * 预热 worker 开关（docs/05 §5.7）。
 *
 * 它默认**关**，理由必须能在界面上读到（macOS 上只省 ~250 ms、"点了没反应"已由
 * 乐观 UI 解决；真正的收益在 Windows 还没量过）—— 所以这里钉三件事：
 * 读得到真实值、点了真的写 `warmWorker`、默认是关的。
 */
describe('设置页：预热会话进程开关', () => {
  function warmSwitch(): HTMLButtonElement {
    const rows = [...domContainer().querySelectorAll<HTMLElement>('.pg-settings-row')];
    const row = rows.find((r) => r.textContent?.includes('预热会话进程'));
    if (!row) throw new Error('设置页里找不到「预热会话进程」这一行');
    const sw = row.querySelector<HTMLButtonElement>('button[role="switch"]');
    if (!sw) throw new Error('该行里没有 switch');
    return sw;
  }

  it('默认关；后端说开着才 checked', async () => {
    await mountRuntime();
    expect(warmSwitch().getAttribute('aria-checked')).toBe('false');

    cfg.warm_worker = true;
    await mountRuntime();
    expect(warmSwitch().getAttribute('aria-checked')).toBe('true');
  });

  it('点一下把 warmWorker=true 存下去（关的时候存 false，不是"不传"）', async () => {
    await mountRuntime();
    await act(async () => {
      warmSwitch().click();
      await new Promise((r) => setTimeout(r, 30));
    });
    const saves = invokeMock.mock.calls.filter((c) => c[0] === 'perf_config_save');
    expect(saves.length, '点开关没有保存').toBeGreaterThan(0);
    expect(saves.at(-1)![1]?.warmWorker).toBe(true);

    // ⚠️ 等久一点：保存期间开关是 disabled 的（`busy` 守卫），点太快会点空
    await act(async () => {
      await new Promise((r) => setTimeout(r, 120));
    });
    await act(async () => {
      warmSwitch().click();
      await new Promise((r) => setTimeout(r, 60));
    });
    const again = invokeMock.mock.calls.filter((c) => c[0] === 'perf_config_save');
    expect(again.at(-1)![1]?.warmWorker, '关的时候必须显式写 false，否则关不掉').toBe(false);
  });
});
