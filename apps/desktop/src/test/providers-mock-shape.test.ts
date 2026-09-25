// @vitest-environment jsdom
/**
 * **跨语言金标**：mock 的 `provider_overview` 行键集合必须与 Rust 契约测试里那份一致。
 *
 * 为什么值得单写一条：前端浏览器门禁（`ui:startup`）跑的是 mock，它与 Rust 侧**各写各的**。
 * Rust 那边把 `keySource` 改名成 `key_source` 时：
 *   · Rust 契约测试会红（`ipc_contract.rs::provider_overview_row_shape` 逐个锁了键）；
 *   · 但门禁跑 mock，照样全绿 —— 真机上却是"列表里每一项都显示未配置"。
 * 所以这里用**同一份手写清单**再锁一遍 mock。两份清单是独立写的（互为金标），
 * 不是"用被测物证明被测物"。
 */
import { describe, expect, it } from 'vitest';
import { mockInvoke } from '@/lib/mockBackend';

/** 与 `src-tauri/tests/ipc_contract.rs::provider_overview_row_shape` 里的清单同源。 */
const ROW_KEYS = [
  'provider',
  'name',
  'declared',
  'baseUrl',
  'baseUrlSource',
  'api',
  'apiSource',
  'apis',
  'envVar',
  'keySource',
  'keyMasked',
  'keyKind',
  'hasInlineKey',
  'models',
  'cachedModels',
  'isDefault',
];

describe('mock 的 provider_overview 形状', () => {
  it('行键集合与 Rust 契约一致，且类型正确', async () => {
    const out = await mockInvoke<Record<string, unknown>>('provider_overview', {});
    const rows = out.providers as Record<string, unknown>[];
    expect(Array.isArray(rows)).toBe(true);
    // mock 的形状照抄真机：两台 models.json 自定义路由（内联密钥）
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual([...ROW_KEYS].sort());
      expect(typeof row.provider).toBe('string');
      expect(typeof row.name).toBe('string');
      expect(typeof row.declared).toBe('boolean');
      expect(Array.isArray(row.apis)).toBe(true);
      expect(Array.isArray(row.models)).toBe(true);
      expect(typeof row.cachedModels).toBe('number');
      expect(typeof row.isDefault).toBe('boolean');
      expect(['auth', 'models_json', 'env', 'none']).toContain(row.keySource);
    }
    const catalog = out.catalog as Record<string, unknown>[];
    expect(catalog.length).toBeGreaterThan(0);
    for (const c of catalog) {
      expect(Object.keys(c).sort()).toEqual(['api', 'apis', 'baseUrl', 'envVar', 'id', 'name']);
    }
    expect(Array.isArray(out.apiOptions)).toBe(true);
    expect((out.paths as Record<string, string>).models).toContain('models.json');
  });

  it('目录里的 baseUrl 与 pi 的真实默认值一致（照抄生成物，不是编的）', async () => {
    const out = await mockInvoke<Record<string, unknown>>('provider_overview', {});
    const catalog = out.catalog as { id: string; baseUrl: string }[];
    const byId = new Map(catalog.map((c) => [c.id, c.baseUrl]));
    // 这几条是 pi 0.87.1 源码里的字面值（catalog_generated.rs 同源）
    expect(byId.get('deepseek')).toBe('https://api.deepseek.com');
    expect(byId.get('anthropic')).toBe('https://api.anthropic.com');
    expect(byId.get('openai')).toBe('https://api.openai.com/v1');
    expect(byId.get('zai')).toBe('https://api.z.ai/api/coding/paas/v4');
  });

  it('写入会被记住（mock 不记录写入 = 调试得出错误结论）', async () => {
    await mockInvoke('provider_save', { provider: 'tmp-x', patch: { name: 'Tmp X', baseUrl: 'https://t.example/v1' } });
    const out = await mockInvoke<Record<string, unknown>>('provider_overview', {});
    const row = (out.providers as Record<string, unknown>[]).find((r) => r.provider === 'tmp-x');
    expect(row).toBeTruthy();
    expect(row!.name).toBe('Tmp X');
    await mockInvoke('provider_remove', { provider: 'tmp-x' });
    const after = await mockInvoke<Record<string, unknown>>('provider_overview', {});
    expect((after.providers as Record<string, unknown>[]).some((r) => r.provider === 'tmp-x')).toBe(false);
  });
});
