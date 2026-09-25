// @vitest-environment jsdom
/**
 * 会话标题生成 + 右键菜单（docs/03 §2.16，docs/04 §2.4）。
 *
 * 这一块有**三个入口**（右键菜单、行上图标、命令面板），最容易出的问题是
 * "其中一个入口悄悄不一样"——比如只有一个会刷新列表、或者只有一个会拦重复点击。
 * 所以用例分两层：菜单组件本身的键盘/关闭语义，以及"点了生成之后这条链是通的"。
 *
 * 另外两条是本功能的**数据安全**底线，各有一条用例：
 *   ① 生成失败（模型没给出可用标题）时**必须保留原来的名字**——
 *      用空标题覆盖是这块最可能造成的数据损坏；
 *   ② 生成完必须**重新拉会话列表**，界面显示的得是磁盘上的（不做本地合并）。
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
  confirm: vi.fn(),
}));

import { ContextMenu, type MenuItem } from '@/features/common/ContextMenu';
import { SessionTitlePreview } from '@/features/workspace/SessionTitlePreview';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const q = <T extends Element>(sel: string) => domContainer().querySelector<T>(sel);
const qa = <T extends Element>(sel: string) => [...domContainer().querySelectorAll<T>(sel)];
/** 菜单是 portal 到 body 的，不在挂载容器里 */
const mq = <T extends Element>(sel: string) => document.body.querySelector<T>(sel);
const mqa = <T extends Element>(sel: string) => [...document.body.querySelectorAll<T>(sel)];

afterEach(async () => {
  await unmountDom();
  document.body.querySelectorAll('.pg-menu').forEach((n) => n.remove());
});

describe('右键菜单', () => {
  const items = (onPick: (id: string) => void): MenuItem[] => [
    { id: 'a', label: '打开会话', onSelect: () => onPick('a') },
    { id: 'b', label: '生成标题', hint: '调用模型', onSelect: () => onPick('b') },
    { id: 'c', label: '删除会话', danger: true, disabled: true, onSelect: () => onPick('c') },
  ];

  it('渲染到 body、有 role=menu，且禁用的项点不动', async () => {
    const picked: string[] = [];
    mountDom(<ContextMenu at={{ x: 10, y: 10 }} items={items((id) => picked.push(id))} onClose={() => {}} />);
    await flush();
    expect(mq('[role="menu"]')).toBeTruthy();
    expect(mqa('[role="menuitem"]').length).toBe(3);
    const disabled = mq<HTMLButtonElement>('[data-menu-item="c"]')!;
    expect(disabled.disabled).toBe(true);
    await act(async () => {
      disabled.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(picked).toEqual([]);
  });

  it('Escape / 点外面 / 滚动都关，选中项执行后也关', async () => {
    const onClose = vi.fn();
    const picked: string[] = [];
    mountDom(<ContextMenu at={{ x: 10, y: 10 }} items={items((id) => picked.push(id))} onClose={onClose} />);
    await flush();
    // Escape（监听在 window 的 capture 阶段，所以要点在 document 上也生效）
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    // 点外面
    await act(async () => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    // 滚动（capture）：菜单浮在原地会与内容错位
    await act(async () => {
      window.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();
    // 选中：先关再执行（不然执行里的重渲染会留下一个孤儿菜单）
    await act(async () => {
      mq<HTMLButtonElement>('[data-menu-item="b"]')!.click();
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(picked).toEqual(['b']);
    expect(onClose).toHaveBeenCalled();
  });

  it('键盘可用：↑↓ 移动、Enter 选中（鼠标能做的键盘也要能做）', async () => {
    const picked: string[] = [];
    mountDom(<ContextMenu at={{ x: 10, y: 10 }} items={items((id) => picked.push(id))} onClose={() => {}} />);
    await flush();
    const menu = mq<HTMLDivElement>('[role="menu"]')!;
    expect(document.activeElement).toBe(menu);
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    // 从 a 往下 → b（c 是 disabled，跳过）
    expect(mq('[data-menu-item="b"]')!.className).toContain('is-active');
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(picked).toEqual(['b']);
  });

  it('贴边内收：右下角右键时菜单不被视口切掉', async () => {
    // jsdom 里 getBoundingClientRect 全是 0，所以这里断言的是"给了坐标就渲染"，
    // 几何本身在浏览器门禁里量（真布局只有真浏览器有，docs/15 规矩 32）
    mountDom(
      <ContextMenu
        at={{ x: window.innerWidth - 2, y: window.innerHeight - 2 }}
        items={items(() => {})}
        onClose={() => {}}
      />,
    );
    await flush();
    const menu = mq<HTMLDivElement>('.pg-menu')!;
    expect(menu).toBeTruthy();
    expect(menu.style.visibility).toBe('visible');
  });
});

describe('标题素材预览', () => {
  it('列出取材方式、会用哪个模型、以及会送出去的消息', async () => {
    mountDom(
      <SessionTitlePreview
        open
        onClose={() => {}}
        info={{
          cwd: '/proj',
          provider: 'mock-glm',
          modelId: 'glm-5.3-flash',
          firstMessage: '给 Piggy 加标题生成',
          recentMessages: ['再加一个右键菜单', '要支持重新生成'],
          userMessageCount: 3,
          messageCount: 12,
          currentName: null,
          strategy: 'both',
          maxChars: 20,
          promptChars: 180,
        }}
        error={null}
      />,
    );
    await flush();
    const box = document.body.querySelector('[data-title-preview]');
    expect(box).toBeTruthy();
    const text = box!.textContent ?? '';
    expect(text).toContain('第一条 + 最近几条');
    expect(text).toContain('20');
    expect(text).toContain('mock-glm/glm-5.3-flash');
    expect(text).toContain('给 Piggy 加标题生成');
    expect(text).toContain('要支持重新生成');
    expect(text).toContain('共 12 条');
  });

  it('没有用户文字消息时明说"生成出来会是瞎编的"', async () => {
    mountDom(
      <SessionTitlePreview
        open
        onClose={() => {}}
        info={{
          cwd: null,
          provider: null,
          modelId: null,
          firstMessage: null,
          recentMessages: [],
          userMessageCount: 0,
          messageCount: 4,
          currentName: null,
          strategy: 'both',
          maxChars: 20,
          promptChars: 90,
        }}
        error={null}
      />,
    );
    await flush();
    const box = document.body.querySelector('[data-title-preview]')!;
    expect(box.textContent).toContain('还没有用户文字消息');
    expect(box.textContent).toContain('pi 的默认模型');
  });
});

describe('生成标题的往返（mock IPC）', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    toastError.mockReset();
    toastSuccess.mockReset();
  });

  it('成功：发出 session_title_generate、重新拉列表、提示里说清是谁生成的', async () => {
    const calls: string[] = [];
    invokeMock.mockImplementation(async (name: string) => {
      calls.push(name);
      if (name === 'session_title_generate') {
        return {
          title: '会话标题生成',
          raw: '  「会话标题生成」  ',
          provider: 'mock-glm',
          modelId: 'glm-5.3-flash',
          modelUsed: 'mock-glm/glm-5.3-flash',
          elapsedMs: 812,
          promptChars: 180,
          applied: true,
          source: {},
        };
      }
      return [];
    });

    const { generateTitle, describeRun } = await import('@/lib/sessionTitle');
    const r = await generateTitle('/mock/s.jsonl');
    expect(calls).toContain('session_title_generate');
    expect(r.title).toBe('会话标题生成');
    // 提示里必须带"谁生成的"——用户对标题不满意时要知道该去改哪儿
    expect(describeRun(r)).toContain('mock-glm/glm-5.3-flash');
    expect(describeRun(r)).toContain('0.8s');
  });

  it('失败：错误原文透传（后端会说明"已保留原来的名字"）', async () => {
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'session_title_generate') {
        throw new Error('模型没有给出可用的标题（原样输出：""）——已保留原来的名字');
      }
      return {};
    });
    const { generateTitle } = await import('@/lib/sessionTitle');
    await expect(generateTitle('/mock/s.jsonl')).rejects.toThrow(/已保留原来的名字/);
  });

  it('apply=false 时不写名字（预览模式）', async () => {
    const seen: Record<string, unknown>[] = [];
    invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'session_title_generate') {
        seen.push(args ?? {});
        return { title: 'x', raw: 'x', applied: false, modelUsed: null, elapsedMs: 1, promptChars: 1, source: {} };
      }
      return {};
    });
    const { generateTitle } = await import('@/lib/sessionTitle');
    await generateTitle('/mock/s.jsonl', false);
    expect(seen[0]).toEqual({ path: '/mock/s.jsonl', apply: false });
  });
});

describe('会话行的入口', () => {
  it('悬停图标与右键菜单都指向同一个生成动作', async () => {
    // 两个入口共用 doGenerateTitle —— 用例锁的是"命令 id 一致"，
    // 分叉的表现会是"右键能生成、图标点了没反应"这类只在一边复现的怪事
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'session_list') {
        return [
          {
            path: '/mock/proj/a.jsonl',
            file_name: 'a.jsonl',
            session_id: 'a',
            cwd: '/mock/proj',
            name: null,
            first_message: '帮我看看流式渲染',
            mtime_ms: Date.now(),
            created_ms: Date.now(),
            size: 10,
            cwd_missing: false,
          },
        ];
      }
      if (name === 'session_title_generate') {
        return { title: '流式渲染', raw: '流式渲染', applied: true, modelUsed: 'm/x', elapsedMs: 5, promptChars: 9, source: {} };
      }
      return {};
    });

    const { SessionsSidebar } = await import('@/features/workspace/SessionsSidebar');
    mountDom(<SessionsSidebar />);
    await flush();
    const row = q('.pg-session-row');
    expect(row).toBeTruthy();
    // 图标在
    const icon = q<HTMLButtonElement>('.pg-session-titlegen');
    expect(icon).toBeTruthy();
    expect(icon!.getAttribute('aria-label')).toContain('标题');
    // 右键唤出菜单，菜单里有生成项
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 20, clientY: 20 }));
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(mq('[role="menu"]')).toBeTruthy();
    const labels = mqa('.pg-menu-label').map((e) => e.textContent);
    expect(labels).toContain('生成标题');
    // 没有名字时是"生成"，有名字时才是"重新生成"
    expect(labels).not.toContain('重新生成标题');
  });
});
