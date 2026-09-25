// @vitest-environment jsdom
/**
 * **跨语言金标**：mock 的 `plugin_overview` 行键集合必须与 Rust 契约测试里那份一致。
 *
 * 为什么值得单写一条：前端浏览器门禁（`ui:startup`）跑的是 mock，它与 Rust 侧**各写各的**。
 * Rust 那边把 `enabledBy` 改名成 `enabled_by` 时：
 *   · Rust 契约测试会红（`ipc_contract.rs::plugin_overview_row_shape` 逐个锁了键）；
 *   · 但门禁跑 mock，照样全绿 —— 真机上却是"每一行都显示不出状态依据"。
 *
 * 还有一条这一页独有的风险：行的 `key` 是**启停/删除的回传标识**。
 * 键名或拼法在两边分叉时，界面上不会报错——它只是点了没反应。
 * 所以这里连 `key` 的拼法（`<scope>:<kind>:<source>`）也一起锁。
 */
import { describe, expect, it } from 'vitest';
import { mockInvoke } from '@/lib/mockBackend';

/** 与 `src-tauri/tests/ipc_contract.rs::plugin_overview_row_shape` 里的清单同源。 */
const ROW_KEYS = [
  'key',
  'name',
  'kind',
  'kindLabel',
  'sourceKind',
  'sourceKindLabel',
  'scope',
  'scopeLabel',
  'source',
  'path',
  'exists',
  'enabled',
  'enabledBy',
  'version',
  'description',
  'entries',
  'removable',
  'updatable',
  'loadRank',
];

const GROUP_KEYS = ['id', 'label', 'dir', 'settingsPath', 'count', 'plugins'];
const COUNT_KEYS = ['total', 'enabled', 'disabled', 'missing', 'updatable'];
const SCOPES = ['project', 'global', 'builtin'];

type Overview = {
  agentDir: string;
  agentDirFromEnv: boolean;
  projectDir: string | null;
  groups: Record<string, unknown>[];
  warnings: unknown[];
  counts: Record<string, unknown>;
};

async function overview(): Promise<Overview> {
  return (await mockInvoke('plugin_overview')) as Overview;
}

describe('插件页 mock 形状（跨语言金标）', () => {
  it('顶层字段齐备', async () => {
    const o = await overview();
    for (const k of ['agentDir', 'agentDirFromEnv', 'projectDir', 'groups', 'warnings', 'counts']) {
      expect(Object.keys(o), `顶层缺少 ${k}`).toContain(k);
    }
    expect(typeof o.agentDir).toBe('string');
    expect(typeof o.agentDirFromEnv).toBe('boolean');
    for (const k of COUNT_KEYS) expect(typeof o.counts[k], `counts.${k} 不是数字`).toBe('number');
  });

  it('分组顺序与 pi 的加载优先级一致，且字段齐备', async () => {
    const o = await overview();
    expect(o.groups.map((g) => g.id)).toEqual(SCOPES);
    for (const g of o.groups) {
      // settingsPath 允许为 null（内置组没有设置文件）
      expect(Object.keys(g).sort()).toEqual([...GROUP_KEYS].sort());
      expect(typeof g.count).toBe('number');
      expect(Array.isArray(g.plugins)).toBe(true);
    }
  });

  it('每一行的键集合完全一致，且 key 的拼法是 <scope>:<kind>:<source>', async () => {
    const o = await overview();
    const rows = o.groups.flatMap((g) => g.plugins as Record<string, unknown>[]);
    expect(rows.length).toBeGreaterThanOrEqual(4);

    for (const row of rows) {
      // 完全相等（不是"包含"）：多一个字段说明两边已经分叉了
      expect(Object.keys(row).sort(), `行的键集合变了：${JSON.stringify(row.key)}`).toEqual(
        [...ROW_KEYS].sort(),
      );
      const key = String(row.key);
      const parts = key.split(':');
      expect(SCOPES).toContain(parts[0]);
      expect(parts[1]).toBe(row.kind);
      expect(typeof row.enabled).toBe('boolean');
      expect(typeof row.exists).toBe('boolean');
      expect(typeof row.loadRank).toBe('number');
      expect(Array.isArray(row.entries)).toBe(true);
    }
  });

  it('四种来源都有样本，且含一条停用、一条缺失（门禁据此核对渲染分支）', async () => {
    const o = await overview();
    const rows = o.groups.flatMap((g) => g.plugins as Record<string, unknown>[]);
    const kinds = new Set(rows.map((r) => r.kind));
    for (const k of ['package', 'discovered', 'builtin']) {
      expect(kinds, `mock 里没有 ${k} 类型的样本，门禁那条核对会空转`).toContain(k);
    }
    expect(rows.some((r) => r.enabled === false)).toBe(true);
    expect(rows.some((r) => r.exists === false)).toBe(true);
    // 内置不可管理：这条不成立的话，门禁"内置开关必须禁用"就失去意义
    const builtin = rows.find((r) => r.kind === 'builtin')!;
    expect(builtin.removable).toBe(false);
    expect(builtin.updatable).toBe(false);
  });

  it('来源校验与 Rust 同规则：裸包名要被指出来', async () => {
    const bare = (await mockInvoke('plugin_check_source', { source: '@scope/pkg' })) as Record<
      string,
      unknown
    >;
    expect(bare.ok).toBe(false);
    expect(String(bare.hint)).toContain('npm:@scope/pkg');

    const ok = (await mockInvoke('plugin_check_source', { source: 'npm:@scope/pkg' })) as Record<
      string,
      unknown
    >;
    expect(ok.ok).toBe(true);
    expect(ok.sourceKind).toBe('npm');
  });

  it('启停真的改状态（门禁"点开关后那一行变了"才不是空转）', async () => {
    const before = await overview();
    const target = before.groups
      .flatMap((g) => g.plugins as Record<string, unknown>[])
      .find((r) => r.kind === 'discovered' && r.enabled === false)!;
    await mockInvoke('plugin_set_enabled', { key: target.key, enabled: true });
    const after = await overview();
    const now = after.groups
      .flatMap((g) => g.plugins as Record<string, unknown>[])
      .find((r) => r.key === target.key)!;
    expect(now.enabled).toBe(true);
    // 复原，免得影响同文件里后面的用例
    await mockInvoke('plugin_set_enabled', { key: target.key, enabled: false });
  });
});
