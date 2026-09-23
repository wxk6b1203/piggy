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

/** 真实抓包原样（2026-09-23，provider=cc-switch-deep-seek / model=deepseek-flash）。 */
const REAL_401 =
  '401: {"message":"Authentication Fails, Your api key: ****4d37 is invalid",' +
  '"type":"authentication_error","param":null,"code":"invalid_request_error"}';

describe('trajectoryStore：失败回合 + 实时/快照构造一致', () => {
  beforeEach(resetStore);

  it('message_end(error)：标红 + 摘要带错误原文 + 详情含可能原因', () => {
    useTrajectory.getState().appendCommit(TAB, {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: REAL_401 },
    } as never);
    const r = useTrajectory.getState().rows[TAB]![0]!;
    expect(r.kind).toBe('assistant');
    expect(r.failed).toBe(true);
    expect(r.text).toContain('本轮失败');
    expect(r.text).toContain('Authentication Fails');
    expect(r.expandable).toBe(true);
    expect(r.detail).toContain(REAL_401);
    expect(r.detail).toContain('可能原因');
  });

  it('message_end(aborted)：出现「已中止」但不标红（用户自己按的）', () => {
    useTrajectory.getState().appendCommit(TAB, {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request aborted' },
    } as never);
    const r = useTrajectory.getState().rows[TAB]![0]!;
    expect(r.text).toContain('已中止');
    expect(r.failed).toBeFalsy();
  });

  /**
   * 这条是**发散守卫**：实时追加曾内联成 `{text: textOf(content)}`，不设 detail/expandable，
   * 而 load() 走 assistantRow()。结果是同一个会话「看着看着」和「重新打开」长得不一样。
   */
  it('实时追加的长回复与 load 快照构造一致（都能展开、摘要相同）', async () => {
    const long = `长回复开始 ${'内容'.repeat(200)} 结束`;
    const msg = { role: 'assistant', content: [{ type: 'text', text: long }], timestamp: 1790000000000 };
    useTrajectory.getState().appendCommit(TAB, { type: 'message_end', message: msg } as never);
    const live = useTrajectory.getState().rows[TAB]![0]!;

    ipcMocks.cmd.mockResolvedValue({
      entries: [{ type: 'message', id: 'e0', timestamp: '2026-09-22T01:00:00.000Z', message: msg }],
    });
    await useTrajectory.getState().load(TAB);
    const snap = useTrajectory.getState().rows[TAB]![0]!;

    expect(live.expandable).toBe(true);
    expect(live.detail).toBe(long);
    expect(snap.text).toBe(live.text);
    expect(snap.detail).toBe(live.detail);
    expect(snap.expandable).toBe(live.expandable);
  });
});
