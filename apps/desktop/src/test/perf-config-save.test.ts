// @vitest-environment jsdom
/**
 * `perf_config_save` 的唯一入口（`lib/perfConfig.ts`）。
 *
 * 为什么值得单独钉：2026-10-13 用户实测 —— 设置页里关掉「结构化提问」直接报
 * `invalid args \`maxWorkers\` for command \`perf_config_save\`: missing required key maxWorkers`。
 * 那条命令的 `maxWorkers` / `idleTimeoutMin` 在真机上是**必填**的，而当时那个调用点
 * 只发了 `bundledPlugins`；浏览器门禁跑在 mock 上、mock 对缺参宽容，所以一路全绿到用户手上。
 *
 * 这里断言的就是那条约束本身：**必填字段永远带上**，且取自磁盘现值。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@/lib/ipc', () => ({ cmd: (...a: unknown[]) => invokeMock(...a) }));

import { savePerfConfig } from '@/lib/perfConfig';

/** 磁盘上现在是这样一份配置。 */
const DISK = { max_workers: 6, idle_timeout_min: 20, bundled_plugins: ['pi-ask'] };

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (name: string) => {
    if (name === 'perf_config_load') return { ...DISK };
    return null;
  });
});

/** 取出这次 `perf_config_save` 发出去的参数。 */
const sentSave = (): Record<string, unknown> => {
  const call = invokeMock.mock.calls.find((c) => c[0] === 'perf_config_save');
  expect(call, '压根没发 perf_config_save').toBeTruthy();
  return call![1] as Record<string, unknown>;
};

describe('savePerfConfig', () => {
  it('必填字段取自**磁盘现值**（调用方不用管，缺了真机会直接报错）', async () => {
    await savePerfConfig({ bundledPlugins: ['pi-ask', 'pi-todo'] });
    const args = sentSave();
    expect(args.maxWorkers, '缺 maxWorkers → 真机报 missing required key').toBe(6);
    expect(args.idleTimeoutMin).toBe(20);
    expect(args.bundledPlugins).toEqual(['pi-ask', 'pi-todo']);
  });

  it('patch 里给了就覆盖磁盘值（同样是必填字段）', async () => {
    await savePerfConfig({ max_workers: 12, idle_timeout_min: 0 });
    const args = sentSave();
    expect(args.maxWorkers).toBe(12);
    expect(args.idleTimeoutMin).toBe(0);
  });

  it('没提到的字段**不塞进参数**（塞 null 会被后端当成"要改"）', async () => {
    await savePerfConfig({ bundledPlugins: ['pi-ask'] });
    const args = sentSave();
    for (const key of ['titleModel', 'titleThinking', 'piPath', 'subagentDelegation', 'transcriptDetail']) {
      expect(Object.hasOwn(args, key), `${key} 不该出现在这次调用里`).toBe(false);
    }
  });

  it('`null` 是有意义的取值（清空覆盖），不能被当成"没传"', async () => {
    await savePerfConfig({ titleModel: null, piPath: null });
    const args = sentSave();
    expect(Object.hasOwn(args, 'titleModel'), 'null 被当成"没传"→ 清不掉覆盖').toBe(true);
    expect(args.titleModel).toBeNull();
    expect(Object.hasOwn(args, 'piPath')).toBe(true);
  });

  it('先读现值再写（读-改-写：不会把没提到的字段抹成默认）', async () => {
    await savePerfConfig({ bundledPlugins: [] });
    const names = invokeMock.mock.calls.map((c) => c[0]);
    expect(names[0], '没先读现值就拿不到必填字段').toBe('perf_config_load');
    expect(names[1]).toBe('perf_config_save');
  });

  it('读不到现值时报错（不拿 0 去覆盖磁盘上的并发数）', async () => {
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'perf_config_load') throw new Error('boom');
      return null;
    });
    await expect(savePerfConfig({ bundledPlugins: [] })).rejects.toThrow('boom');
    expect(invokeMock.mock.calls.some((c) => c[0] === 'perf_config_save'), '读失败还硬写').toBe(false);
  });
});
