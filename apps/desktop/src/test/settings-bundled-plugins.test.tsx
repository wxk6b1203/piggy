// @vitest-environment jsdom
/**
 * 「内置插件」那一块（docs/06 §7、docs/17 §2.2b）。
 *
 * 三件事必须能从界面上读到，缺一个都会变成"说不清为什么没生效"：
 *   1. **这次注入了吗 / 没注入是为什么**（设置里关了 / 你装了同名扩展 / 目录缺失）；
 *   2. **这一份安装里有没有这个目录** —— 打包漏登记 `bundle.resources` 时，
 *      插件以前会从列表里**整个消失**（`filter_map`），用户只看得到"没有它"；
 *   3. **这份目录是从哪儿来的** —— 第三候选是编译期烧进二进制的构建机绝对路径，
 *      于是"打包漏登记"在构建机上跑 .app 会看起来完全正常（换机器才消失）。
 *      所以 `source_tree` 必须显眼地说出来。
 *
 * 另外钉一条 IPC 契约：读列表时要带上**当前会话的 cwd**（项目级同名扩展同样会让
 * pi 因工具名冲突直接退出，不带 cwd 的界面会承诺一个真实 spawn 时做不到的事）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));

import { BundledPluginsRow } from '@/features/settings/BundledPluginsRow';
import { useTabs } from '@/stores/tabs';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 20)); });
const q = (sel: string) => domContainer().querySelector(sel);
const qa = (sel: string) => Array.from(domContainer().querySelectorAll(sel));
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const PLUGINS = [
  {
    name: 'pi-ask',
    title: '结构化提问',
    description: '问问题',
    license: 'GPL-3.0-or-later',
    tools: ['ask_user_question'],
    commands: ['plan'],
    dir: '/app/Contents/Resources/resources/pi-plugins/pi-ask',
    origin: '随包分发',
    originKind: 'resource_dir',
    enabled: true,
    inject: true,
    skipped: null,
  },
  {
    name: 'pi-todo',
    title: '任务清单',
    description: 'todo',
    license: 'MIT',
    tools: ['todo_write'],
    commands: ['todos'],
    // 开发态：来自仓库源码树
    dir: '/repo/apps/desktop/src-tauri/resources/pi-plugins/pi-todo',
    origin: '开发态（仓库源码树）',
    originKind: 'source_tree',
    enabled: true,
    inject: true,
    skipped: null,
  },
  {
    name: 'pi-guardrails',
    title: '写前校验护栏',
    description: '写前校验',
    license: 'MIT',
    tools: ['write', 'edit'],
    commands: [],
    dir: '/app/Contents/Resources/resources/pi-plugins/pi-guardrails',
    origin: '随包分发',
    originKind: 'resource_dir',
    enabled: true,
    inject: true,
    skipped: null,
  },
  {
    name: 'pi-ghost',
    title: '缺目录的插件',
    description: '打包漏登记',
    license: 'MIT',
    tools: [],
    commands: [],
    dir: null,
    origin: null,
    originKind: null,
    enabled: true,
    inject: false,
    skipped: '这一份安装里没有这个目录（随包分发不完整：bundle.resources 没登记 resources/pi-plugins）',
  },
];

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (name: string) => {
    if (name === 'plugin_bundled') return { plugins: structuredClone(PLUGINS) };
    if (name === 'perf_config_save') return { ok: true };
    return {};
  });
  useTabs.setState({
    tabs: {
      t1: { tabId: 't1', cwd: '/work/proj', sessionFile: '/tmp/s.jsonl', workerState: 'ready' } as never,
    },
    order: ['t1'],
    activeTabId: 't1',
    unread: {},
    banner: null,
  });
});

afterEach(async () => {
  /* ⚠️ 必须 await：`unmountDom()` 是异步的（要跑空 React 的宏任务队列），
     不 await 的话它会在**下一个用例中途**把 `container` 置空 ——
     症状是"隔一个用例"报 `dom-render: 请先调用 mountDom()`。 */
  await unmountDom();
});

describe('设置页「内置插件」', () => {
  it('每一行都说出"这次注入了吗"，目录缺失的那行不缺行', async () => {
    mountDom(<BundledPluginsRow onChanged={() => {}} />);
    await flush();

    expect(qa('[data-bundled]').map((r) => r.getAttribute('data-bundled'))).toEqual([
      'pi-ask',
      'pi-todo',
      'pi-guardrails',
      'pi-ghost',
    ]);
    // 注入成功的那两行没有 skip 行
    expect(q('[data-bundled="pi-ask"] [data-bundled-skip]')).toBeNull();
    // 目录缺失那行必须留着，并且说清是"包装不完整"
    const ghost = q('[data-bundled="pi-ghost"] [data-bundled-skip]');
    expect(ghost, '缺目录的插件整行消失了 —— 用户只会以为列表里本来就没有它').toBeTruthy();
    expect(text(ghost)).toContain('随包分发不完整');
    expect(text(q('[data-bundled="pi-ghost"] .pg-bundled-dir'))).toContain('没有这个目录');
  });

  it('覆盖型插件要说明它顶替了内置工具、且不进限制档白名单', async () => {
    mountDom(<BundledPluginsRow onChanged={() => {}} />);
    await flush();
    const hint = q('[data-bundled="pi-guardrails"] [data-bundled-override]');
    expect(hint, '覆盖型插件没有提示 —— 用户会以为自己的 write 行为莫名其妙变了').toBeTruthy();
    expect(text(hint)).toContain('顶替');
    expect(text(hint)).toContain('仅可查看');
    // 普通插件不该有这条
    expect(q('[data-bundled="pi-ask"] [data-bundled-override]')).toBeNull();
  });

  it('来自仓库源码树的那行要显眼提示（打包产物里出现它就是漏登记）', async () => {
    mountDom(<BundledPluginsRow onChanged={() => {}} />);
    await flush();
    const hint = q('[data-bundled-origin="source_tree"]');
    expect(hint, '开发态来源没有提示 —— "构建机上跑 .app 一切正常"那个坑就没人拦得住').toBeTruthy();
    expect(text(hint)).toContain('源码树');
    // 正常来源不该有这条提示
    expect(q('[data-bundled="pi-ask"] [data-bundled-origin]')).toBeNull();
  });

  it('读列表时带上当前会话的 cwd（项目级同名扩展同样会让 pi 直接退出）', async () => {
    mountDom(<BundledPluginsRow onChanged={() => {}} />);
    await flush();
    const call = invokeMock.mock.calls.find((c) => c[0] === 'plugin_bundled');
    expect(call, '没有调用 plugin_bundled').toBeTruthy();
    expect((call![1] as { projectDir?: string }).projectDir).toBe('/work/proj');
  });

  it('开关按配置写回（不是按"这次注入了吗"）', async () => {
    mountDom(<BundledPluginsRow onChanged={() => {}} />);
    await flush();
    const box = q('[data-bundled-toggle="pi-ask"]') as HTMLInputElement;
    await act(async () => {
      box.click();
      await new Promise((r) => setTimeout(r, 20));
    });
    const save = invokeMock.mock.calls.find((c) => c[0] === 'perf_config_save');
    expect(save, '点勾选框没有保存').toBeTruthy();
    // 关掉 pi-ask 之后，列表里仍开着的只剩 pi-todo 与 pi-ghost（它们本来就是 enabled）
    const names = (save![1] as { bundledPlugins?: string[] }).bundledPlugins ?? [];
    expect(names).not.toContain('pi-ask');
    expect(names).toContain('pi-todo');
  });
});
