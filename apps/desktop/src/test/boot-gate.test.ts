/**
 * 启动时序回归：**建 tab 必须排在 `boot_reset`（收割遗留 worker）之后**。
 *
 * 背景（2026-09-23 实测）：`AppFrame` 的 boot effect 会 `await cmd('boot_reset')`，
 * 而 `EditorArea` 的布局恢复是另一条异步链，会 `createTab(...)`。
 * Rust 的 `boot_reset` 是「先取 id 快照，再逐个 close_tab」——
 * 于是只要有一次 `tab_create` 抢在快照之前落地，那个 tab 就被关掉了，
 * 而前端 useTabs / dockview 依旧显示它：之后这个 tab 上任何命令都返回
 * 「tab 不存在: <uuid>」，症状是刚打开时标签都在、但模型列表空白、转写空白。
 *
 * 这是竞态（多数时候 tab_create 更慢所以看不出来），所以测试要**确定性地**复现：
 * 把 boot_reset 卡住不返回，断言此时 tab_create 一次都不许发出去。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { ipcMocks } = vi.hoisted(() => ({
  ipcMocks: { cmd: vi.fn(), on: vi.fn() },
}));
vi.mock('@/lib/ipc', () => ({ cmd: ipcMocks.cmd, on: ipcMocks.on }));

import { bootGate, resetBootGateForTest } from '@/lib/boot';
import { createTab } from '@/stores/tabs';

/** 记录调用顺序，便于断言"谁先谁后"而不只是"有没有被调用"。 */
function record() {
  const calls: string[] = [];
  ipcMocks.cmd.mockImplementation((name: string) => {
    calls.push(name);
    return Promise.resolve({ tab_id: 't', cwd: '/x' });
  });
  return calls;
}

beforeEach(() => {
  resetBootGateForTest();
  ipcMocks.cmd.mockReset();
});

describe('启动闸门：建 tab 不会抢在 boot_reset 前面', () => {
  it('boot_reset 未返回时，tab_create 一次都不发', async () => {
    const calls: string[] = [];
    let releaseBoot!: () => void;
    const bootDone = new Promise<void>((resolve) => {
      releaseBoot = resolve;
    });
    ipcMocks.cmd.mockImplementation((name: string) => {
      calls.push(name);
      if (name === 'boot_reset') return bootDone;
      return Promise.resolve({ tab_id: 't', cwd: '/x' });
    });

    const pending = createTab({ cwd: '/x' });
    await Promise.resolve(); // 让 createTab 走到 await 之后
    expect(calls).toEqual(['boot_reset']); // ← 关键断言：还没建 tab

    releaseBoot();
    await pending;
    expect(calls).toEqual(['boot_reset', 'tab_create']);
  });

  it('顺序恒定：boot_reset 先于每一次 tab_create（含并发建多个）', async () => {
    const calls = record();
    await Promise.all([createTab({ cwd: '/a' }), createTab({ cwd: '/b' }), createTab({ cwd: '/c' })]);
    expect(calls[0]).toBe('boot_reset');
    expect(calls.filter((c) => c === 'tab_create')).toHaveLength(3);
    expect(calls.filter((c) => c === 'boot_reset')).toHaveLength(1); // 单例，只收割一次
  });

  it('boot_reset 失败也不阻塞建 tab（首启本来就没有遗留）', async () => {
    ipcMocks.cmd.mockImplementation((name: string) => {
      if (name === 'boot_reset') return Promise.reject(new Error('首启'));
      return Promise.resolve({ tab_id: 't', cwd: '/x' });
    });
    await expect(createTab({ cwd: '/x' })).resolves.toBeTruthy();
  });

  it('bootGate() 返回同一个 promise（幂等）', () => {
    ipcMocks.cmd.mockResolvedValue(null);
    expect(bootGate()).toBe(bootGate());
    expect(ipcMocks.cmd).toHaveBeenCalledTimes(1);
  });
});
