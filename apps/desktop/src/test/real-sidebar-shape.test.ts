/** 用**真机数据形状**验一遍侧栏（不是 mock）：117 个会话 / 82 组 → 修好后前几组是谁 */
import { describe, expect, it } from 'vitest';
import { buildSidebar, MISSING_CWD_KEY, type SessionGroup } from '@/stores/sessions';

const g = (cwd: string, label: string, n: number, missing: boolean, base: number): SessionGroup => ({
  cwd, label,
  sessions: Array.from({ length: n }, (_, i) => ({
    path: `${cwd}#${i}`, file_name: `f${i}.jsonl`, session_id: `s${i}`, cwd,
    name: null, first_message: `t${i}`, mtime_ms: base + i, created_ms: base + i, size: 1,
    cwd_missing: missing,
  })),
});

describe('真机形状：用户的两个项目 + 76 个已删除项目分组', () => {
  const real = [
    g('/Users/wxk', 'wxk', 25, false, 1_700_000_000_000),
    g('/Users/wxk/Documents/Project/1m-go-websockets', '1m-go-websockets', 5, false, 1_690_000_000_000),
    g('/Users/wxk/Documents/Project/pi', 'pi', 4, false, 1_680_000_000_000),
    g('/Users/wxk/Documents/Project/pi-guardrails', 'pi-guardrails', 2, false, 1_670_000_000_000),
    g('/private/tmp/smoke-final', 'smoke-final', 1, false, 1_660_000_000_000),
    g('/Users/wxk/Documents/Project/piggy', 'piggy', 1, false, 1_650_000_000_000),
  ];
  // 76 个 tmp 分组，各 1 个会话，而且都比真项目**新**
  const junk = Array.from({ length: 76 }, (_, i) =>
    g(`/private/tmp/ctrl/case-${i}`, `case-${i}`, 1, true, 1_750_000_000_000 + i),
  );

  it('排在最前的是真项目，临时目录汇总成一组沉底', () => {
    const view = buildSidebar([...junk, ...real], {}, {});
    expect(view.map((v) => v.label).slice(0, 6)).toEqual([
      'wxk', '1m-go-websockets', 'pi', 'pi-guardrails', 'smoke-final', 'piggy',
    ]);
    expect(view).toHaveLength(7);
    const bucket = view[6]!;
    expect(bucket.cwd).toBe(MISSING_CWD_KEY);
    expect(bucket.sessions).toHaveLength(76);
    expect(bucket.visible).toHaveLength(0);
    // 总数守恒：一个会话都没被丢掉
    const input = [...junk, ...real].reduce((n, g2) => n + g2.sessions.length, 0);
    expect(view.reduce((n, v) => n + v.sessions.length, 0)).toBe(input);
    expect(input).toBe(114);
  });
});
