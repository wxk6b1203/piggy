/**
 * 提供商配置的 IPC 边界（docs/15 规则 28：IPC 返回值必须校验形状）。
 *
 * 为什么单独测这一层：`provider_overview` 的消费方是整棵设置页。真机之外还有
 * 测试里的通配 mock、后端字段改名、老版本后端等情况——`raw.providers.length`
 * 直接爆掉的话，用户看到的是**整个设置页白屏**，而且崩在 promise 里，
 * 连 React 错误边界都接不住（本项目在 `loadApps` 上真实踩过一次）。
 *
 * 这一层同时也是"参数名对不对"的锁：真机是 camelCase → snake_case，
 * 写错了不会有编译错误，只会静默拿不到值。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));

import {
  discoverModels,
  loadOverview,
  removeProvider,
  removeProviderKey,
  saveProvider,
  setProviderKey,
} from '@/lib/providers';

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
});

describe('loadOverview：形状收口', () => {
  it('后端给空对象 → 退化成空表，不抛', async () => {
    const o = await loadOverview();
    expect(o.providers).toEqual([]);
    expect(o.catalog).toEqual([]);
    expect(o.apiOptions).toEqual([]);
    expect(o.paths.models).toBe('');
  });

  it('后端给 null / 字段类型不对 → 同样退化', async () => {
    invokeMock.mockResolvedValue(null);
    expect((await loadOverview()).providers).toEqual([]);
    invokeMock.mockResolvedValue({ providers: 'oops', catalog: 3, apiOptions: null });
    const o = await loadOverview();
    expect(o.providers).toEqual([]);
    expect(o.catalog).toEqual([]);
    expect(o.apiOptions).toEqual([]);
  });

  it('正常形状原样透传', async () => {
    invokeMock.mockResolvedValue({
      providers: [{ provider: 'a' }],
      catalog: [{ id: 'deepseek' }],
      apiOptions: ['openai-completions'],
      defaults: { provider: 'a', model: 'm' },
      paths: { agent: '/x', auth: '/x/a.json', models: '/x/m.json', settings: '/x/s.json' },
    });
    const o = await loadOverview();
    expect(o.providers).toHaveLength(1);
    expect(o.apiOptions).toEqual(['openai-completions']);
    expect(o.defaults.model).toBe('m');
  });
});

describe('discoverModels：形状收口 + 参数名', () => {
  it('后端给空对象 → models 空表、source 至少是个合法值', async () => {
    const d = await discoverModels('deepseek', 'https://api.deepseek.com', 'openai-completions');
    expect(d.models).toEqual([]);
    expect(['catalog', 'network']).toContain(d.source);
    expect(d.url).toBe('');
  });

  it('密钥留空时显式送 null（Rust 侧是 Option<String>，缺参数会报错）', async () => {
    await discoverModels('deepseek', 'https://x', 'openai-completions', '   ');
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ apiKey: null });
    invokeMock.mockClear();
    await discoverModels('deepseek', 'https://x', 'openai-completions', ' sk-1 ');
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ apiKey: 'sk-1' });
  });
});

describe('写操作：命令名与参数名', () => {
  it('provider_save → { provider, patch }', async () => {
    await saveProvider('a', { name: 'A' });
    expect(invokeMock.mock.calls[0]).toEqual(['provider_save', { provider: 'a', patch: { name: 'A' } }]);
  });

  it('provider_set_key 默认写 auth，可显式写 models', async () => {
    await setProviderKey('a', 'sk-1');
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ apiKey: 'sk-1', store: 'auth' });
    invokeMock.mockClear();
    await setProviderKey('a', 'sk-1', 'models');
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ store: 'models' });
  });

  it('provider_remove_key 默认两处都删；provider_remove 只带 provider', async () => {
    await removeProviderKey('a');
    expect(invokeMock.mock.calls[0]![1]).toMatchObject({ provider: 'a', store: 'both' });
    invokeMock.mockClear();
    await removeProvider('a');
    expect(invokeMock.mock.calls[0]).toEqual(['provider_remove', { provider: 'a' }]);
  });
});
