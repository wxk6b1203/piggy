// @vitest-environment jsdom
/**
 * 「插件」配置页（docs/04 §2.3，docs/03 §2.15）。
 *
 * 这一页最容易出的不是"崩了"，而是**说了假话**——所以每条用例都对着一种具体的
 * 失真方式：
 *
 *   ① **四种来源都要出现，且各自带正确的类型徽标**。混成一种"插件"会让用户
 *      分不清"我装的包"和"谁扔在发现目录里的文件"——这两者的删除方式、
 *      升级方式、以及"pi 会不会加载"都不一样。
 *   ② **"状态是谁定的"必须显示出来**。pi 的启用/停用是 settings.json 里的
 *      `-`/`+`/`!` 通配符，不是布尔开关；不说清哪一层哪条规则，
 *      用户看到开关就会以为是它说了算（docs/15 规矩 30）。
 *   ③ **停用态与"找不到文件"必须能看见**。后者是"声明了但没装上"，
 *      藏起来的话用户只会看到一条永远加载不出来的条目。
 *   ④ **pi 内置扩展不可管理**：开关必须禁用（pi 里 `-ne` 都关不掉它）。
 *   ⑤ **安装前要拦住裸包名**：pi 的 `isLocalPath` 只看前缀，`@scope/pkg` 会被
 *      当成本地路径，实测报 `Path does not exist`——不提示 `npm:` 用户查不出来。
 *   ⑥ **启停写完之后要重新拉取**，不做前端本地合并（否则界面显示的和 pi 读到的会分叉）。
 *   ⑦ **IPC 形状不对时不许白屏**（docs/15 规矩 28）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock, toastError } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn() },
  FeedbackBridge: () => null,
}));

import { PluginsSection } from '@/features/settings/PluginsSection';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const q = <T extends Element>(sel: string) => domContainer().querySelector<T>(sel);
const qa = <T extends Element>(sel: string) => [...domContainer().querySelectorAll<T>(sel)];
const byText = <T extends Element>(sel: string, text: string) =>
  qa<T>(sel).find((e) => (e.textContent ?? '').replace(/\s/g, '') === text);

/** 一行插件的最小形状（字段名与 Rust 侧一致）。 */
function row(over: Record<string, unknown> = {}) {
  return {
    key: 'global:package:npm:pi-guardrails',
    name: 'pi-guardrails',
    kind: 'package',
    kindLabel: '插件包',
    sourceKind: 'npm',
    sourceKindLabel: 'npm 包',
    scope: 'global',
    scopeLabel: '全局',
    source: 'npm:pi-guardrails',
    path: '/h/.pi/agent/npm/node_modules/pi-guardrails',
    exists: true,
    enabled: true,
    enabledBy: '这条包在 settings.json 的 packages 里没有过滤规则',
    version: '0.1.0',
    description: null,
    entries: ['/h/.pi/agent/npm/node_modules/pi-guardrails/index.ts'],
    removable: true,
    updatable: true,
    loadRank: 4,
    ...over,
  };
}

const OVERVIEW = {
  agentDir: '/h/.pi/agent',
  agentDirFromEnv: false,
  projectDir: '/proj',
  groups: [
    {
      id: 'global',
      label: '全局',
      dir: '/h/.pi/agent',
      settingsPath: '/h/.pi/agent/settings.json',
      count: 3,
      plugins: [
        row(),
        row({
          key: 'global:discovered:/h/.pi/agent/extensions/quiet.ts',
          name: 'quiet.ts',
          kind: 'discovered',
          kindLabel: '发现目录',
          sourceKind: 'discovered',
          sourceKindLabel: '发现目录',
          source: '/h/.pi/agent/extensions/quiet.ts',
          path: '/h/.pi/agent/extensions/quiet.ts',
          enabled: false,
          enabledBy: '被 /h/.pi/agent/settings.json 的 - 规则强制排除',
          updatable: false,
          loadRank: 3,
        }),
        row({
          key: 'global:package:npm:@me/gone',
          name: '@me/gone',
          source: 'npm:@me/gone',
          exists: false,
          entries: [],
        }),
      ],
    },
    {
      id: 'builtin',
      label: 'pi 内置',
      dir: '（随 pi 发布）',
      settingsPath: null,
      count: 1,
      plugins: [
        row({
          key: 'builtin:builtin:llama.cpp',
          name: 'llama.cpp',
          kind: 'builtin',
          kindLabel: 'pi 内置',
          sourceKind: 'builtin',
          sourceKindLabel: '内置',
          scope: 'builtin',
          scopeLabel: 'pi 内置',
          source: 'llama.cpp',
          path: '(pi 内置：…/llama)',
          removable: false,
          updatable: false,
          loadRank: -1,
        }),
      ],
    },
  ],
  warnings: [],
  counts: { total: 4, enabled: 3, disabled: 1, missing: 1, updatable: 1 },
};

function prime(overview: unknown = OVERVIEW, extra: Record<string, unknown> = {}) {
  invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    // extra 里放函数时当实现调用（否则返回的会是函数本身，测试会静默拿到一个函数）
    if (name in extra) {
      const v = extra[name];
      return typeof v === 'function' ? (v as (a?: Record<string, unknown>) => unknown)(args) : v;
    }
    switch (name) {
      case 'plugin_overview':
        return overview;
      case 'plugin_jobs':
        return { jobs: [] };
      case 'plugin_project_trust':
        return { trusted: true, matched: '/proj', dir: '/proj', trustFile: '/h/trust.json' };
      case 'plugin_check_source': {
        return { ok: true, problem: null, hint: '', sourceKind: 'npm', sourceKindLabel: 'npm 包' };
      }
      default:
        return {};
    }
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  toastError.mockReset();
});

// unmountDom 是异步的（要跑空 React 排在宏任务里的收尾工作）。
// 忘了 await 就会和下一个用例的 mountDom 抢 container —— 表现是
// "dom-render: 请先调用 mountDom()"，看着像组件坏了，其实是测试自己没等。
afterEach(async () => {
  await unmountDom();
});

describe('插件页', () => {
  it('四种来源各自渲染，停用态与"找不到文件"都能看见', async () => {
    prime();
    mountDom(<PluginsSection />);
    await flush();

    const kinds = qa('.pg-plugin-kind').map((e) => e.textContent);
    expect(kinds).toContain('插件包');
    expect(kinds).toContain('发现目录');
    expect(kinds).toContain('pi 内置');

    // 停用态
    const rows = qa('.pg-plugin-row');
    expect(rows.length).toBe(4);
    expect(rows.filter((r) => r.getAttribute('data-plugin-enabled') === '0').length).toBe(1);
    // 声明了但没装上
    expect(qa('.pg-plugin-row.is-missing').length).toBe(1);
    expect(q('.pg-plugin-tag.is-danger')?.textContent).toBe('找不到文件');
    // 分组顺序 = pi 的加载优先级
    expect(qa('[data-plugin-group]').map((g) => g.getAttribute('data-plugin-group'))).toEqual([
      'global',
      'builtin',
    ]);
  });

  it('展开一条停用的，必须说清是哪一层哪条规则定的', async () => {
    prime();
    mountDom(<PluginsSection />);
    await flush();

    const off = qa('.pg-plugin-row').find((r) => r.getAttribute('data-plugin-enabled') === '0')!;
    await act(async () => {
      off.querySelector<HTMLButtonElement>('.pg-plugin-name')!.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    const why = q('[data-plugin-enabled-by]')?.textContent ?? '';
    // 必须是"哪份文件里的哪条规则"，不是"已停用"这种同义反复
    expect(why).toContain('settings.json');
    expect(why).toContain('- 规则');
  });

  it('pi 内置扩展的开关是禁用的（pi 里 -ne 都关不掉它）', async () => {
    prime();
    mountDom(<PluginsSection />);
    await flush();

    const builtin = qa('.pg-plugin-row').find((r) =>
      r.getAttribute('data-plugin-key')?.startsWith('builtin:'),
    )!;
    const sw = builtin.querySelector<HTMLButtonElement>('.ant-switch')!;
    expect(sw).toBeTruthy();
    expect(sw.disabled).toBe(true);
    // 也不该有删除按钮
    expect(builtin.querySelector('.ant-btn-dangerous')).toBeNull();
  });

  it('启停走 plugin_set_enabled，写完重新拉取（不做本地合并）', async () => {
    let enabled = false;
    const calls: string[] = [];
    invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      calls.push(name);
      if (name === 'plugin_set_enabled') {
        enabled = args?.enabled === true;
        return { ok: true };
      }
      if (name === 'plugin_overview') {
        // 第二次拉取时把状态翻过来——界面必须跟着它走
        const ov = structuredClone(OVERVIEW);
        ov.groups[0]!.plugins[1]!.enabled = enabled;
        return ov;
      }
      if (name === 'plugin_jobs') return { jobs: [] };
      if (name === 'plugin_project_trust') return { trusted: true };
      return {};
    });

    mountDom(<PluginsSection />);
    await flush();
    expect(qa('.pg-plugin-row')[1]!.getAttribute('data-plugin-enabled')).toBe('0');

    await act(async () => {
      qa('.pg-plugin-row')[1]!.querySelector<HTMLButtonElement>('.ant-switch')!.click();
      await new Promise((r) => setTimeout(r, 60));
    });

    const set = invokeMock.mock.calls.find((c) => c[0] === 'plugin_set_enabled');
    expect(set).toBeTruthy();
    expect((set![1] as Record<string, unknown>).enabled).toBe(true);
    expect((set![1] as Record<string, unknown>).key).toBe('global:discovered:/h/.pi/agent/extensions/quiet.ts');
    // 写完之后必须重新读（而不是把本地状态改一改了事）
    expect(calls.filter((c) => c === 'plugin_overview').length).toBeGreaterThan(1);
    expect(qa('.pg-plugin-row')[1]!.getAttribute('data-plugin-enabled')).toBe('1');
  });

  it('安装对话框拦住裸包名并给出 npm: 写法', async () => {
    prime(OVERVIEW, {
      plugin_check_source: (args: Record<string, unknown>) => {
        const s = String(args.source ?? '');
        if (s.startsWith('npm:')) {
          return { ok: true, problem: null, hint: '', sourceKind: 'npm', sourceKindLabel: 'npm 包' };
        }
        return {
          ok: false,
          problem: 'pi 会把裸名字当本地路径，而不是 npm 包名',
          hint: `想装 npm 包请写成 npm:${s}`,
          sourceKind: 'local',
          sourceKindLabel: '本地路径',
        };
      },
    });
    mountDom(<PluginsSection />);
    await flush();

    await act(async () => {
      byText<HTMLButtonElement>('.pg-plugin-head-actions button', '添加插件')!.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]')!;
    expect(input).toBeTruthy();

    // 受控输入：必须走原生 setter，直接改 value 不会触发 React
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, '@scope/pkg');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
    });
    const problem = document.querySelector('.pg-plugin-dialog-error')?.textContent ?? '';
    expect(problem).toContain('裸名字');
    expect(problem).toContain('npm:@scope/pkg');
    // 非法来源时「安装」不可点
    const install = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => (b.textContent ?? '').replace(/\s/g, '') === '安装',
    )!;
    expect(install.disabled).toBe(true);
  });

  it('点「填入示例」把示例填进输入框并放行安装', async () => {
    prime();
    mountDom(<PluginsSection />);
    await flush();

    await act(async () => {
      byText<HTMLButtonElement>('.pg-plugin-head-actions button', '添加插件')!.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    await act(async () => {
      document.querySelector<HTMLButtonElement>('.pg-plugin-guide li button')!.click();
      await new Promise((r) => setTimeout(r, 400));
    });
    const input = document.querySelector<HTMLInputElement>('[role="dialog"] input[type="text"]')!;
    expect(input.value).toBe('npm:pi-guardrails');
    const install = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => (b.textContent ?? '').replace(/\s/g, '') === '安装',
    )!;
    expect(install.disabled).toBe(false);

    await act(async () => {
      install.click();
      await new Promise((r) => setTimeout(r, 60));
    });
    const run = invokeMock.mock.calls.find((c) => c[0] === 'plugin_run');
    expect(run).toBeTruthy();
    expect(run![1]).toMatchObject({ action: 'install', source: 'npm:pi-guardrails', scope: 'global' });
  });

  it('删除包走 pi remove，删除发现目录里的走回收站', async () => {
    prime();
    mountDom(<PluginsSection />);
    await flush();

    // 包：danger 按钮 → 确认弹窗 → plugin_run(remove)
    const pkgRow = qa('.pg-plugin-row')[0]!;
    await act(async () => {
      pkgRow.querySelector<HTMLButtonElement>('.ant-btn-dangerous')!.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    const okBtn = [...document.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')].find(
      (b) => (b.textContent ?? '').replace(/\s/g, '') === '删除',
    )!;
    expect(okBtn).toBeTruthy();
    await act(async () => {
      okBtn.click();
      await new Promise((r) => setTimeout(r, 60));
    });
    const run = invokeMock.mock.calls.find((c) => c[0] === 'plugin_run');
    expect(run![1]).toMatchObject({ action: 'remove', source: 'npm:pi-guardrails' });

    invokeMock.mockClear();
    await act(async () => {
      qa('.pg-plugin-row')[1]!.querySelector<HTMLButtonElement>('.ant-btn-dangerous')!.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    const ok2 = [...document.querySelectorAll<HTMLButtonElement>('.ant-modal-footer button')].find(
      (b) => (b.textContent ?? '').replace(/\s/g, '') === '删除',
    )!;
    await act(async () => {
      ok2.click();
      await new Promise((r) => setTimeout(r, 60));
    });
    // 发现目录里的没有 pi 卸载命令 → 走 delete_discovered（回收站），不是 plugin_run
    expect(invokeMock.mock.calls.some((c) => c[0] === 'plugin_delete_discovered')).toBe(true);
    expect(invokeMock.mock.calls.some((c) => c[0] === 'plugin_run')).toBe(false);
  });

  it('IPC 形状不对时不许白屏（groups 不是数组 / rows 缺字段）', async () => {
    prime({ groups: 'nope', counts: null });
    mountDom(<PluginsSection />);
    await flush();
    expect(q('.pg-plugin')).toBeTruthy();
    expect(toastError).not.toHaveBeenCalled();

    // 缺字段的一条被丢掉，其余照常渲染
    prime({
      agentDir: '/h/.pi/agent',
      projectDir: null,
      groups: [{ id: 'global', label: '全局', plugins: [{ name: '没有 key 的一条' }, row()] }],
      counts: {},
      warnings: [],
    });
    mountDom(<PluginsSection />);
    await flush();
    expect(qa('.pg-plugin-row').length).toBe(1);
    expect(q('.pg-plugin-name')?.textContent).toBe('pi-guardrails');
  });

  it('未信任的项目要提前说（pi 会整份忽略 .pi/settings.json）', async () => {
    prime(OVERVIEW, { plugin_project_trust: { trusted: false, matched: null } });
    mountDom(<PluginsSection />);
    // 两段串联的异步：先 plugin_overview，再 plugin_project_trust
    await flush();
    await flush();
    const warn = qa('.pg-plugin-warn').map((w) => w.textContent ?? '').join('\n');
    expect(warn).toContain('还没被 pi 信任');
  });
});
