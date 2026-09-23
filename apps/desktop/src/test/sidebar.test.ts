/** 侧栏视图模型测试（DSH 重构）：分组排序 / 折叠 / 展开计数 / 创建时间优先 */
import { describe, expect, it } from 'vitest';
import { buildSidebar, createdMs, PREVIEW_LIMIT, type SessionGroup } from '@/stores/sessions';

const meta = (name: string, mtime: number) => ({
  path: `/p/${name}.jsonl`,
  file_name: `${name}.jsonl`,
  session_id: name,
  cwd: '/p',
  name: null,
  first_message: name,
  mtime_ms: mtime,
  size: 1,
});

const groups: SessionGroup[] = [
  { cwd: '/old-proj', label: 'old-proj', sessions: [meta('a', 1000), meta('b', 900)] },
  { cwd: '/new-proj', label: 'new-proj', sessions: [meta('c', 5000), meta('d', 4000), meta('e', 3000), meta('f', 2000), meta('g', 1000)] },
];

describe('buildSidebar（DSH 式侧栏）', () => {
  it('组按最新会话降序；组内会话降序', () => {
    const view = buildSidebar(groups, {}, {});
    expect(view[0]!.cwd).toBe('/new-proj');
    expect(view[0]!.sessions[0]!.first_message).toBe('c');
    expect(view[1]!.cwd).toBe('/old-proj');
  });

  it(`默认每组显示前 ${PREVIEW_LIMIT} 个，其余进 hiddenCount`, () => {
    const view = buildSidebar(groups, {}, {});
    expect(view[0]!.visible).toHaveLength(PREVIEW_LIMIT);
    expect(view[0]!.hiddenCount).toBe(2);
    expect(view[1]!.hiddenCount).toBe(0);
  });

  it('展开组显示全部且 hiddenCount 归零', () => {
    const view = buildSidebar(groups, {}, { '/new-proj': true });
    expect(view[0]!.visible).toHaveLength(5);
    expect(view[0]!.hiddenCount).toBe(0);
  });

  it('折叠组 visible 为空、hiddenCount = 全量', () => {
    const view = buildSidebar(groups, { '/new-proj': true }, {});
    expect(view[0]!.visible).toHaveLength(0);
    expect(view[0]!.hiddenCount).toBe(5);
  });

  it('搜索过滤后的组继续走同一视图模型', () => {
    const filtered = groups.map((g) => ({
      ...g,
      sessions: g.sessions.filter((m) => m.first_message!.includes('c')),
    })).filter((g) => g.sessions.length > 0);
    const view = buildSidebar(filtered, {}, {});
    expect(view).toHaveLength(1);
    expect(view[0]!.label).toBe('new-proj');
  });
});

/* ---------------- 排序口径：创建时间，不是 mtime ---------------- */

const metaBoth = (name: string, created: number, mtime: number) => ({
  path: `/p/${name}.jsonl`,
  file_name: `${name}.jsonl`,
  session_id: name,
  cwd: '/p',
  name: null,
  first_message: name,
  mtime_ms: mtime,
  created_ms: created,
  size: 1,
});

describe('侧栏按创建时间排序（mtime 只作兜底）', () => {
  it('老会话被写入一次也不跳到顶部', () => {
    // old：创建最早，但刚被写过（mtime 最新）—— 用 mtime 排会把它顶到第一
    const g: SessionGroup[] = [
      {
        cwd: '/p',
        label: 'p',
        sessions: [metaBoth('old', 100, 9000), metaBoth('mid', 500, 500), metaBoth('new', 900, 900)],
      },
    ];
    const view = buildSidebar(g, {}, {});
    expect(view[0]!.sessions.map((s) => s.first_message)).toEqual(['new', 'mid', 'old']);
    expect(createdMs(view[0]!.sessions[0]!)).toBe(900);
  });

  it('分组之间同样按最新创建时间排', () => {
    const g: SessionGroup[] = [
      { cwd: '/a', label: 'a', sessions: [metaBoth('a1', 100, 9999)] },
      { cwd: '/b', label: 'b', sessions: [metaBoth('b1', 800, 1)] },
    ];
    const view = buildSidebar(g, {}, {});
    expect(view.map((x) => x.cwd)).toEqual(['/b', '/a']);
  });

  it('缺少 created_ms 时回落到 mtime（老后端 / 老 mock 兼容）', () => {
    expect(createdMs(meta('x', 1234) as never)).toBe(1234);
  });
});
