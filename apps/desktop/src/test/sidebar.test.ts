/** 侧栏视图模型测试（DSH 重构）：分组排序 / 折叠 / 展开计数 / 创建时间优先 */
import { describe, expect, it } from 'vitest';
import { buildSidebar, createdMs, MISSING_CWD_KEY, PREVIEW_LIMIT, type SessionGroup } from '@/stores/sessions';

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

/* ---------------- 「已删除的项目目录」汇总组（真机回归） ----------------
 *
 * 现场数据：自定义 sessionDir = …/tmp/session，pi 自己把每次 `pi -p` 的会话平铺写进去，
 * 于是侧栏一次多出 76 个目录已不存在的分组（每个 1 个会话），把用户的两个真项目
 * （/Users/wxk 25 个、1m-go-websockets 5 个）挤到第 16、27 位 —— 用户报"原来的会话没有了"。
 * 这些会话不能丢（pi 的 --resume 也能看到），所以合并成一个默认收起的汇总组沉底。
 */
describe('已删除项目的会话汇总（不是过滤掉）', () => {
  const dead = (name: string, created: number, cwd: string) => ({
    ...metaBoth(name, created, created),
    cwd,
    cwd_missing: true,
  });
  const live = (name: string, created: number, cwd: string) => ({
    ...metaBoth(name, created, created),
    cwd,
    cwd_missing: false,
  });

  // 真项目的会话"更老"，临时目录的会话"更新"——纯按时间排就会把它们顶上去
  const real: SessionGroup[] = [
    { cwd: '/Users/wxk', label: 'wxk', sessions: [live('a', 1000, '/Users/wxk')] },
    {
      cwd: '/Users/wxk/Documents/Project/1m-go-websockets',
      label: '1m-go-websockets',
      sessions: [live('b', 2000, '/Users/wxk/Documents/Project/1m-go-websockets')],
    },
  ];
  const junk: SessionGroup[] = Array.from({ length: 40 }, (_, i) => ({
    cwd: `/private/tmp/ctrl/bench/case-${i}`,
    label: `case-${i}`,
    sessions: [dead(`t${i}`, 10_000 + i, `/private/tmp/ctrl/bench/case-${i}`)],
  }));

  it('目录还在的项目排前面，汇总组排最后且默认收起', () => {
    const view = buildSidebar([...junk, ...real], {}, {});
    expect(view).toHaveLength(3);
    expect(view[0]!.label).toBe('1m-go-websockets'); // 最新 → 第一
    expect(view[1]!.label).toBe('wxk');
    const last = view[2]!;
    expect(last.missingRoot).toBe(true);
    expect(last.cwd).toBe(MISSING_CWD_KEY);
    expect(last.sessions).toHaveLength(40);
    expect(last.visible).toHaveLength(0); // 默认收起
    expect(last.hiddenCount).toBe(40);
  });

  it('展开后按创建时间列出全部（会话一个都没丢）', () => {
    const view = buildSidebar([...junk, ...real], {}, { [MISSING_CWD_KEY]: true });
    const last = view[2]!;
    expect(last.visible).toHaveLength(40);
    expect(last.visible[0]!.file_name).toBe('t39.jsonl'); // 最新的在前
    expect(last.hiddenCount).toBe(0);
  });

  it('组里还有活会话就仍算普通项目（混装不误判）', () => {
    const mixed: SessionGroup[] = [
      {
        cwd: '/p',
        label: 'p',
        sessions: [dead('ghost', 100, '/p'), live('live', 200, '/p')],
      },
    ];
    const view = buildSidebar(mixed, {}, {});
    expect(view).toHaveLength(1);
    expect(view[0]!.missingRoot).toBeUndefined();
    expect(view[0]!.visible).toHaveLength(2);
  });

  it('没有已删除项目时不产生多余的空汇总组', () => {
    const view = buildSidebar(real, {}, {});
    expect(view).toHaveLength(2);
    expect(view.some((g) => g.missingRoot)).toBe(false);
  });
});
