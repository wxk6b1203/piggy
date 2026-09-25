// @vitest-environment jsdom
/**
 * 「模型」配置页（docs/04 §3.4）：提供商列表 + 编辑卡片 + 添加流程 + 获取可用模型。
 *
 * 锁的每一条都对应一种"界面上看不出来"的失败：
 *   ① **列表来自 `provider_overview`，不自持一份**：models.json 里的自定义路由
 *      （用户的真实形态）必须出现，且密钥来源要写明白（auth.json / models.json / 环境变量）；
 *   ② **密钥写哪儿是显式的**，且默认跟随现状 —— 偷偷把内联密钥搬去 auth.json
 *      会让"我改了 models.json 怎么没生效"永远查不出来；
 *   ③ **两处都有密钥时必须警告**：pi 只用 auth.json 那把，另一把是死数据；
 *   ④ **检测要真的走 IPC**，并把"测了什么、结果如何"写在界面上（不能只闪一下"成功"）；
 *   ⑤ **保存的载荷形状**：先 provider_save（配置），再 provider_set_key（密钥），
 *      空串=删键的语义与 Rust 侧一致（写空串会让整份 models.json 校验失败）；
 *   ⑥ **IPC 返回形状不对时不许白屏**（docs/15 规则 28）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock, toastError, toastSuccess } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn() },
  FeedbackBridge: () => null,
}));

import { SettingsTab } from '@/features/settings/SettingsTab';
import { ProvidersSection } from '@/features/settings/ProvidersSection';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });

/**
 * 往受控输入框里打字。
 *
 * 直接 `input.value = x` **不会**让 React 收到变更：React 在 input 上装了 value tracker，
 * 赋值被它吃掉，随后派发的 input 事件被判定为"值没变"而忽略。必须用原型上的原生 setter
 * 绕过 tracker。antd 的 Input/Input.Password 都是受控组件，所以这条是必需的，
 * 不是"测试小技巧"——不用它，测试会告诉你"点了保存什么都没发生"。
 */
async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
}

/** antd 的 Modal / Select 下拉都渲染在 document.body 的 portal 里，不在挂载容器内。 */
const inBody = <T extends Element>(sel: string) => [...document.querySelectorAll<T>(sel)];
const q = <T extends Element>(sel: string) => domContainer().querySelector<T>(sel);
const qa = <T extends Element>(sel: string) => [...domContainer().querySelectorAll<T>(sel)];
const byText = <T extends Element>(sel: string, text: string) =>
  qa<T>(sel).find((e) => e.textContent?.includes(text));

/** 真机 `provider_overview` 的返回（形状照抄本机 ~/.pi/agent）。 */
interface RawOverview {
  providers: Record<string, unknown>[];
  catalog: Record<string, unknown>[];
  apiOptions: string[];
  defaults: { provider: string; model: string };
  paths: Record<string, string>;
}

function overview(over: Partial<RawOverview> = {}): RawOverview {
  return {
    providers: [
      {
        provider: 'cc-switch-deep-seek',
        name: 'DeepSeek',
        declared: false,
        baseUrl: 'https://api.deepseek.com/v1',
        baseUrlSource: 'models_json',
        api: 'openai-completions',
        apiSource: 'models_json',
        apis: [],
        envVar: '',
        keySource: 'models_json',
        keyMasked: 'sk-inl…dsk1',
        keyKind: 'api_key',
        hasInlineKey: true,
        models: [{ id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash', reasoning: true, contextWindow: 1000000, maxTokens: 384000 }],
        cachedModels: 0,
        isDefault: true,
      },
      {
        provider: 'deepseek',
        name: 'DeepSeek',
        declared: true,
        baseUrl: 'https://api.deepseek.com',
        baseUrlSource: 'catalog',
        api: 'openai-completions',
        apiSource: 'catalog',
        apis: ['openai-completions'],
        envVar: 'DEEPSEEK_API_KEY',
        keySource: 'auth',
        keyMasked: 'sk-aut…auth',
        keyKind: 'api_key',
        hasInlineKey: false,
        models: [],
        cachedModels: 3,
        isDefault: false,
      },
    ],
    catalog: [
      { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', api: 'openai-completions', envVar: 'DEEPSEEK_API_KEY', apis: ['openai-completions'] },
      { id: 'zai', name: 'Z.AI', baseUrl: 'https://api.z.ai/api/coding/paas/v4', api: 'openai-completions', envVar: 'ZAI_API_KEY', apis: ['openai-completions'] },
    ],
    apiOptions: ['openai-completions', 'anthropic-messages', 'openai-responses'],
    defaults: { provider: 'cc-switch-deep-seek', model: 'deepseek-flash' },
    paths: {
      agent: '/Users/mock/.pi/agent',
      auth: '/Users/mock/.pi/agent/auth.json',
      models: '/Users/mock/.pi/agent/models.json',
      settings: '/Users/mock/.pi/agent/settings.json',
    },
    ...over,
  };
}

let calls: { name: string; args: Record<string, unknown> }[] = [];

beforeEach(() => {
  calls = [];
  invokeMock.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  invokeMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args: args ?? {} });
    if (name === 'provider_overview') return overview();
    if (name === 'provider_discover') {
      return {
        source: 'network',
        url: 'https://api.deepseek.com/v1/models',
        keySource: 'models_json',
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', contextWindow: 1000000, maxTokens: 384000 },
        ],
      };
    }
    return null;
  });
});

afterEach(async () => {
  await unmountDom();
});

const mounted = (name: string) => calls.filter((c) => c.name === name);
const providerSavePatch = () => mounted('provider_save')[0]?.args.patch as Record<string, unknown>;

async function openEditor(provider: string) {
  mountDom(<ProvidersSection />);
  await flush();
  const card = q<HTMLElement>(`[data-provider="${provider}"]`)!;
  const edit = [...card.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '编辑')!;
  await act(async () => {
    edit.click();
    await new Promise((r) => setTimeout(r, 20));
  });
  return card;
}

describe('模型配置页：提供商列表', () => {
  it('列表来自 provider_overview：自定义路由与目录提供商都在，并标出密钥来源', async () => {
    mountDom(<ProvidersSection />);
    await flush();
    const rows = qa<HTMLElement>('.pg-provider-card');
    expect(rows.map((r) => r.dataset.provider)).toEqual(['cc-switch-deep-seek', 'deepseek']);
    // 自定义标记 + 默认标记
    const first = rows[0]!;
    expect(first.textContent).toContain('自定义');
    expect(first.textContent).toContain('默认');
    // 密钥来源必须写出来（两种来源在真机上同时存在，混起来看就是灾难）
    expect(first.textContent).toContain('models.json');
    expect(rows[1]!.textContent).toContain('auth.json');
    // 状态点：两行都有密钥 → 都是实心
    expect(qa('.pg-cred-dot.is-on').length).toBe(2);
    expect(qa('.pg-cred-dot.is-off').length).toBe(0);
  });

  it('没有密钥的提供商显示空心点', async () => {
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'provider_overview') {
        const o = overview();
        o.providers = [{ ...o.providers[0], keySource: 'none', keyMasked: null, hasInlineKey: false }];
        return o;
      }
      return null;
    });
    mountDom(<ProvidersSection />);
    await flush();
    expect(qa('.pg-cred-dot.is-off').length).toBe(1);
    expect(domContainer().textContent).toContain('未配置');
  });

  it('首跑姿态：一个提供商都没有时，添加卡直接展开（不用再点一次）', async () => {
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'provider_overview') return overview({ providers: [] });
      return null;
    });
    mountDom(<ProvidersSection />);
    await flush();
    expect(q('[data-add-card]')).toBeTruthy();
    expect(byText('button', '第三方模型提供商')).toBeTruthy();
  });

  /** 规则 28：IPC 返回形状不对（测试通配 mock / 后端字段改名）时不许整页白屏。 */
  it('provider_overview 返回空对象也不崩（形状防御）', async () => {
    invokeMock.mockImplementation(async () => ({}));
    mountDom(<ProvidersSection />);
    await flush();
    expect(domContainer().textContent).toContain('模型');
    expect(qa('.pg-provider-card').length).toBe(0);
  });
});

describe('模型配置页：编辑卡片', () => {
  it('保存先写配置、再写密钥；密钥默认写进 pi 凭据库 auth.json', async () => {
    await openEditor('deepseek');
    // deepseek 那行的密钥来自 auth.json → store 默认 auth
    await typeInto(q<HTMLInputElement>('[data-testid="pg-key-input"]')!, 'sk-new-key');
    const save = byText<HTMLButtonElement>('button', '保存')!;
    await act(async () => {
      save.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    const names = calls.map((c) => c.name);
    expect(names).toContain('provider_save');
    expect(names).toContain('provider_set_key');
    expect(names.indexOf('provider_save')).toBeLessThan(names.indexOf('provider_set_key'));
    expect(mounted('provider_set_key')[0]!.args).toMatchObject({
      provider: 'deepseek',
      apiKey: 'sk-new-key',
      store: 'auth',
    });
    expect(toastSuccess).not.toHaveBeenCalled(); // 成功提示交给列表行，不重复弹
  });

  it('密钥存哪儿跟随现状：内联密钥的提供商默认继续写 models.json', async () => {
    await openEditor('cc-switch-deep-seek');
    await typeInto(q<HTMLInputElement>('[data-testid="pg-key-input"]')!, 'sk-typed');
    await act(async () => {
      byText<HTMLButtonElement>('button', '保存')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(mounted('provider_set_key')[0]!.args.store).toBe('models');
  });

  it('保存的配置载荷只带表单拥有的字段，空串=删键', async () => {
    await openEditor('deepseek');
    await act(async () => {
      byText<HTMLButtonElement>('button', '保存')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    const patch = providerSavePatch();
    expect(Object.keys(patch).sort()).toEqual(['api', 'baseUrl', 'models', 'name']);
    expect(patch.name).toBe('DeepSeek');
    expect(patch.baseUrl).toBe('https://api.deepseek.com');
  });

  /** 有本地模型目录缓存时要说出来 —— 它是"不联网也能拿到模型清单"的来源。 */
  it('显示 pi 本地模型目录条数', async () => {
    await openEditor('deepseek');
    const details = q<HTMLDetailsElement>('.pg-customized')!;
    await act(async () => {
      details.open = true;
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(domContainer().textContent).toContain('pi 本地目录里有 3 个');
  });

  it('两处都有密钥时警告，并能一键删掉 models.json 里那把不生效的', async () => {
    invokeMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args: args ?? {} });
      if (name === 'provider_overview') {
        const o = overview();
        // auth.json 那把生效，models.json 里还留着一把 → 就是那个"改了没反应"的坑
        o.providers[0] = { ...o.providers[0], keySource: 'auth', hasInlineKey: true, keyMasked: 'sk-aut…auth' };
        return o;
      }
      return null;
    });
    await openEditor('cc-switch-deep-seek');
    const warn = q<HTMLElement>('.pg-provider-warn')!;
    expect(warn.textContent).toContain('当前不生效');
    const drop = [...warn.querySelectorAll<HTMLButtonElement>('button')].find((b) =>
      b.textContent?.includes('从 models.json 删掉'),
    )!;
    await act(async () => {
      drop.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(mounted('provider_remove_key')[0]!.args).toMatchObject({
      provider: 'cc-switch-deep-seek',
      store: 'models',
    });
  });

  it('模型行校验：ID 重复 / 地址不是 http(s) 时禁止保存并说明原因', async () => {
    await openEditor('cc-switch-deep-seek');
    const details = q<HTMLDetailsElement>('.pg-customized')!;
    await act(async () => {
      details.open = true;
      await new Promise((r) => setTimeout(r, 10));
    });
    // 复制一行 → ID 重复
    await act(async () => {
      byText<HTMLButtonElement>('button', '+ 添加模型')!.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    // 每行第一个输入框 = 模型 ID（表格里有 4 个输入框，别按下标猜）
    const idInputs = () =>
      qa<HTMLTableRowElement>('.pg-modelrows-table tbody tr').map(
        (tr) => tr.querySelector('input')!, 
      );
    await typeInto(idInputs()[1]!, 'deepseek-flash');
    expect(domContainer().textContent).toContain('模型 ID 不能重复');
    expect(byText<HTMLButtonElement>('button', '保存')!.disabled).toBe(true);

    // 地址不对
    await typeInto(idInputs()[1]!, 'other-id');
    await typeInto(q<HTMLInputElement>('[data-testid="pg-baseurl-input"]')!, 'api.deepseek.com');
    expect(domContainer().textContent).toContain('要以 http:// 或 https:// 开头');
    expect(byText<HTMLButtonElement>('button', '保存')!.disabled).toBe(true);
  });
});

describe('模型配置页：检测与获取可用模型', () => {
  it('检测走 provider_discover，并把"测了什么"写在界面上', async () => {
    await openEditor('cc-switch-deep-seek');
    await act(async () => {
      byText<HTMLButtonElement>('button', '检测')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    const call = mounted('provider_discover')[0]!;
    expect(call.args).toMatchObject({
      provider: 'cc-switch-deep-seek',
      baseUrl: 'https://api.deepseek.com/v1',
      api: 'openai-completions',
      apiKey: null, // 没重新输入 → 用已存的密钥
    });
    const ok = q<HTMLElement>('.pg-probe-ok')!;
    expect(ok.textContent).toContain('https://api.deepseek.com/v1/models');
    expect(ok.textContent).toContain('2 个模型');
  });

  it('检测失败要把原因显示出来（不能只说"失败"）', async () => {
    invokeMock.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args: args ?? {} });
      if (name === 'provider_overview') return overview();
      if (name === 'provider_discover') {
        throw 'https://api.deepseek.com/v1/models 返回 HTTP 401（API 密钥可能不对或没有权限）：invalid api key';
      }
      return null;
    });
    await openEditor('cc-switch-deep-seek');
    await act(async () => {
      byText<HTMLButtonElement>('button', '检测')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    const err = q<HTMLElement>('.pg-error')!;
    expect(err.textContent).toContain('401');
    expect(err.textContent).toContain('invalid api key');
  });

  it('获取可用模型 → 勾选 → 加入模型表（已有的行不重复添加）', async () => {
    await openEditor('cc-switch-deep-seek');
    await act(async () => {
      byText<HTMLButtonElement>('button', '获取可用模型')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    // deepseek-flash 已经在表里 → 勾选框禁用并标注"已添加"
    const existing = inBody<HTMLElement>('[data-fetch-id="deepseek-flash"]')[0]!;
    expect(existing.textContent).toContain('已添加');
    expect(existing.querySelector('input')!.disabled).toBe(true);
    // 勾上新模型
    await act(async () => {
      inBody<HTMLElement>('[data-fetch-id="deepseek-v4-pro"] input')[0]!.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    const adopt = inBody<HTMLButtonElement>('.ant-modal-footer button').find((b) =>
      b.textContent?.includes('添加所选'),
    )!;
    await act(async () => {
      adopt.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    const rowIds = qa<HTMLElement>('.pg-modelrows-table tbody tr').map(
      (tr) => (tr.querySelector('input') as HTMLInputElement).value,
    );
    expect(rowIds).toContain('deepseek-v4-pro');
    expect(rowIds.filter((id) => id === 'deepseek-flash').length).toBe(1);
  });
});

describe('模型配置页：添加与删除', () => {
  it('从目录添加：选中后带出目录里的默认地址，并已排除已配置的提供商', async () => {
    mountDom(<ProvidersSection />);
    await flush();
    await act(async () => {
      byText<HTMLButtonElement>('button', '+ 添加模型提供商')!.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    // antd v6 的 Select 结构是 .ant-select > .ant-select-content（v5 的 .ant-select-selector 已改名）
    const select = q<HTMLElement>('[data-testid="pg-catalog-select"] .ant-select-content')!;
    if (!select) throw new Error('找不到目录下拉框的 .ant-select-content');
    await act(async () => {
      select.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 40));
    });
    const options = inBody<HTMLElement>('.ant-select-item-option');
    expect(options.length).toBeGreaterThan(0);
    const labels = options.map((o) => o.textContent ?? '').join('|');
    // deepseek 已经配置过 → 不该出现在可添加列表里
    expect(labels).toContain('Z.AI');
    expect(labels).not.toContain('DeepSeek（deepseek）');
  });

  it('自定义 ID 的非法字符当场报错，不生成编辑器', async () => {
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'provider_overview') return overview({ providers: [] });
      return null;
    });
    mountDom(<ProvidersSection />);
    await flush();
    await act(async () => {
      byText<HTMLButtonElement>('button', '自定义模型 API')!.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    await typeInto(q<HTMLInputElement>('[data-testid="pg-custom-id"]')!, 'my/relay');
    expect(domContainer().textContent).toContain('不能含 `/`');
    expect(q('.pg-provider-editor')).toBeNull();
  });

  it('删除要确认，并说明连凭据一起删', async () => {
    mountDom(<ProvidersSection />);
    await flush();
    const card = q<HTMLElement>('[data-provider="deepseek"]')!;
    const del = [...card.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === '删除')!;
    await act(async () => {
      del.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(document.body.textContent).toContain('和 pi 凭据库里的 API 密钥');
    // antd 会在两个汉字之间插空格（autoInsertSpace），别按文案精确匹配
    const footer = inBody<HTMLButtonElement>('.ant-modal-footer button');
    expect(footer.length).toBeGreaterThan(0);
    const ok = footer[footer.length - 1]!;
    await act(async () => {
      ok.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(mounted('provider_remove')[0]!.args.provider).toBe('deepseek');
  });
});

describe('设置页导航', () => {
  it('左导航三节，默认停在「模型」，切到「高级」显示原始 JSON 编辑器', async () => {
    mountDom(<SettingsTab />);
    await flush();
    expect(qa('.pg-settings-navitem').map((b) => b.textContent)).toEqual(['模型', '通用设置', '高级']);
    expect(q('.pg-providers')).toBeTruthy();
    await act(async () => {
      byText<HTMLButtonElement>('.pg-settings-navitem', '高级')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(qa('[data-raw-file]').length).toBe(2);
    expect(domContainer().textContent).toContain('auth.json 的密钥不在这里明文显示');
  });
});
