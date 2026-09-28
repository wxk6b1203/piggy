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
  useTrajectory.setState({ rows: {}, loaded: {}, pendingCompaction: {} });
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

/**
 * 压缩行（用户 2026-09-23："上下文压缩的轨迹是无法看到细节的？"）。
 *
 * 夹具用真机形状（本机 `2026-09-21T14-18-43-680Z_01a0c455….jsonl` 里那条压缩条目 +
 * pi `docs/compaction.md` §CompactionEntry Structure）。此前 `entryToRow` 只产出
 * `{kind:'compaction', text:'上下文压缩'}` —— 没有 detail、没有 expandable，
 * 所以轨迹里那一行**连点都点不开**。
 */
describe('trajectoryStore：压缩行的细节', () => {
  beforeEach(resetStore);

  const ENTRY = {
    type: 'compaction',
    id: 'c1',
    parentId: 'a1',
    timestamp: '2026-09-22T16:59:27.763Z',
    summary: '## Goal\n构建 Piggy\n\n## Progress\n- 分页完成',
    firstKeptEntryId: '86e95bf3',
    tokensBefore: 561_660,
    usage: { input: 475_045, output: 3_494, totalTokens: 478_539, cost: { total: 0.1234 } },
    details: { readFiles: ['docs/03.md', 'docs/04.md'], modifiedFiles: ['src/a.ts'] },
    fromHook: false,
  };

  it('load 快照：摘要行给计数，展开后有边界/文件/用量/摘要全文', async () => {
    ipcMocks.cmd.mockResolvedValue({ entries: [ENTRY] });
    await useTrajectory.getState().load(TAB);
    const r = useTrajectory.getState().rows[TAB]![0]!;

    expect(r.kind).toBe('compaction');
    expect(r.text).toContain('上下文已压缩');
    expect(r.text).toContain('561.660K'); // formatTokens：与状态行同一份口径
    expect(r.expandable).toBe(true);
    expect(r.detail).toContain('压缩前上下文：561,660 tok');
    expect(r.detail).toContain('保留边界：从 86e95bf3 起');
    expect(r.detail).toContain('摘要调用用量：478,539 tok · $0.1234');
    expect(r.detail).toContain('涉及文件：读 2 / 改 1');
    expect(r.detail).toContain('docs/03.md');
    expect(r.detail).toContain('## Goal'); // 摘要全文
  });

  it('实时：start → entry_appended → end(result) 合成**一行**，且带上 estimatedTokensAfter', () => {
    const st = () => useTrajectory.getState();
    st().appendCommit(TAB, { type: 'compaction_start', reason: 'manual' } as never);
    expect(st().rows[TAB]!.length).toBe(1);
    expect(st().rows[TAB]![0]!.text).toContain('正在压缩上下文…');
    expect(st().rows[TAB]![0]!.text).toContain('手动 /compact');

    st().appendCommit(TAB, { type: 'entry_appended', entry: ENTRY } as never);
    expect(st().rows[TAB]!.length).toBe(1); // 复用占位行，不新增
    expect(st().rows[TAB]![0]!.detail).toContain('86e95bf3');

    st().appendCommit(TAB, {
      type: 'compaction_end',
      reason: 'manual',
      aborted: false,
      willRetry: false,
      result: { ...ENTRY, estimatedTokensAfter: 18_204 },
    } as never);
    const rows = st().rows[TAB]!;
    expect(rows.length).toBe(1);
    expect(rows[0]!.running).toBe(false);
    expect(rows[0]!.text).toContain('→ 约 18.204K tok');
    expect(rows[0]!.detail).toContain('压缩后估计：18,204 tok');
    expect(rows[0]!.detail).toContain('触发：手动 /compact');
  });

  it('失败不许说成"完成"（pi 失败时不落盘条目，旧实现写的是「上下文压缩完成」）', () => {
    const st = () => useTrajectory.getState();
    st().appendCommit(TAB, { type: 'compaction_start', reason: 'threshold' } as never);
    st().appendCommit(TAB, {
      type: 'compaction_end',
      reason: 'threshold',
      aborted: false,
      willRetry: true,
      errorMessage: 'provider 返回 500',
    } as never);
    const r = st().rows[TAB]![0]!;
    expect(r.text).toContain('上下文压缩失败：provider 返回 500');
    expect(r.text).not.toContain('完成');
    expect(r.failed).toBe(true);
    expect(r.detail).toContain('随后会自动重试');
  });

  it('中断（aborted）：改口成"被中断"，不留"正在压缩…"', () => {
    const st = () => useTrajectory.getState();
    st().appendCommit(TAB, { type: 'compaction_start', reason: 'manual' } as never);
    st().appendCommit(TAB, {
      type: 'compaction_end',
      reason: 'manual',
      aborted: true,
      willRetry: false,
    } as never);
    const r = st().rows[TAB]![0]!;
    expect(r.text).toContain('被中断');
    expect(r.running).toBeFalsy();
  });

  it('没有 start 也自洽：单独的 entry_appended / compaction_end 各留一行，不丢信息', () => {
    const st = () => useTrajectory.getState();
    st().appendCommit(TAB, { type: 'entry_appended', entry: ENTRY } as never);
    expect(st().rows[TAB]!.length).toBe(1);
    st().appendCommit(TAB, {
      type: 'compaction_end',
      reason: 'threshold',
      aborted: false,
      willRetry: false,
      result: { ...ENTRY, estimatedTokensAfter: 20_000 },
    } as never);
    expect(st().rows[TAB]!.length).toBe(2);
    expect(st().rows[TAB]![1]!.detail).toContain('压缩后估计');
  });
});
