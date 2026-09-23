/** 轨迹 store 测试（WP7）：system 上下文正文提取（sections），不再打占位符 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTrajectory } from '@/stores/trajectory';

const { ipcMocks } = vi.hoisted(() => ({
  ipcMocks: { cmd: vi.fn(), on: vi.fn() },
}));
vi.mock('@/lib/ipc', () => ({ cmd: ipcMocks.cmd, on: ipcMocks.on }));

const TAB = 'tab-1';
const fixtures = join(import.meta.dirname, '../../../../packages/pi-protocol/fixtures');
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as Record<string, unknown>;

function resetStore() {
  useTrajectory.setState({ rows: {}, loaded: {} });
}

describe('trajectoryStore：system 上下文展示', () => {
  beforeEach(resetStore);

  it('message_end(system)：提取 preamble 摘要 + 节数，detail 可展开', () => {
    useTrajectory.getState().appendCommit(TAB, fixture('event_message_end_system.json') as never);
    const rows = useTrajectory.getState().rows[TAB]!;
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.kind).toBe('system');
    expect(r.text).toContain('You are an expert');
    expect(r.text).toContain('7 节');
    expect(r.expandable).toBe(true);
    expect(r.detail).toContain('【tools】');
    expect(r.detail).toContain('【cwd】');
  });

  it('content 非空时优先 content，sections 作为展开详情', () => {
    useTrajectory.getState().appendCommit(TAB, {
      type: 'message_end',
      message: { role: 'system', content: '自定义系统提示', sections: { tools: '<tools/>' } },
    } as never);
    const r = useTrajectory.getState().rows[TAB]![0]!;
    expect(r.text).toContain('自定义系统提示');
    expect(r.detail).toContain('【tools】');
  });

  it('空 system（无 content 无 sections）保留占位符兜底', () => {
    useTrajectory.getState().appendCommit(TAB, { type: 'message_end', message: { role: 'system' } } as never);
    const r = useTrajectory.getState().rows[TAB]![0]!;
    expect(r.text).toBe('(系统上下文)');
    expect(r.expandable).toBeFalsy();
  });

  it('load（get_entries 快照）：system entry 同样提取正文', async () => {
    ipcMocks.cmd.mockResolvedValue({
      entries: [
        {
          type: 'message',
          id: 'e0',
          timestamp: '2026-09-22T01:00:00.000Z',
          message: { role: 'system', content: '', sections: { preamble: 'You are piggy host.', tools: '<tools>\n- read\n</tools>' } },
        },
        { type: 'message', id: 'e1', timestamp: '2026-09-22T01:00:01.000Z', message: { role: 'user', content: 'hi' } },
      ],
    });
    await useTrajectory.getState().load(TAB);
    const rows = useTrajectory.getState().rows[TAB]!;
    const sys = rows.find((r) => r.kind === 'system')!;
    expect(sys).toBeTruthy();
    expect(sys.text).toContain('You are piggy host.');
    expect(sys.text).toContain('2 节');
    expect(sys.ts).toBe(Date.parse('2026-09-22T01:00:00.000Z'));
  });
});
