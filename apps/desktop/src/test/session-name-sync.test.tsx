// @vitest-environment jsdom
/**
 * 会话名 → **已打开标签**的同步（用户 2026-09-23："点击重新生成标题之后，
 * 上方的标题也要更新"）。
 *
 * 现场：点「生成/重新生成标题」之后**侧栏那一行变了**（它读 `session_list`，
 * 生成完 `load()` 一拉就新），而**上方的会话头部与标签页标题读的是 tabs store 的
 * `sessionName`** —— 没人推过去，用户看到的就是"左边变了、上面还是旧标题"。
 *
 * 这里钉四件事：
 *   ① `applySessionName` 把名字推给**所有**打开着这个会话文件的标签（真机上同一
 *      会话文件被互斥锁保护、只会有一个，去重表按路径匹配才是对的）；
 *   ② 别的会话不受影响（推错对象 = 把 A 的标题写到 B 头上）；
 *   ③ 名字为空/空白 = 清掉，不许留下一个空标题把头部撑成空白；
 *   ④ 头部（`SessionHead`）**响应式**跟着变（它是唯一显示"上方标题"的地方）。
 *
 * 标签页标题那一格（dockview 的 `api.setTitle`）在真浏览器里量：`ui-startup-check.mjs`
 * 第 14 段 —— jsdom 里拿不到真的 dockview 面板 api。
 */
const { invokeMock, toastError } = vi.hoisted(() => ({ invokeMock: vi.fn(), toastError: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { SessionHead } from '@/features/chat/SessionHead';
import { applySessionName, useTabs, type TabInfo } from '@/stores/tabs';
import { useMessages } from '@/stores/messages';
import { domContainer, mountDom, unmountDom } from './dom-render';

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn() },
  FeedbackBridge: () => null,
  confirm: vi.fn(),
}));
vi.mock('@/stores/sessions', () => ({ useSessions: { getState: () => ({ load: vi.fn().mockResolvedValue(undefined) }) } }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));

const A = '/mock/a.jsonl';
const B = '/mock/b.jsonl';

function tab(tabId: string, sessionFile: string | null, sessionName: string | null = null): TabInfo {
  return {
    tabId,
    cwd: '/mock/proj',
    sessionFile,
    sessionId: null,
    sessionName,
    workerState: 'ready',
    model: null,
    thinkingLevel: null,
    permission: 'workspace',
  };
}

beforeEach(() => {
  useMessages.setState({ tabs: {} });
  useTabs.setState({
    tabs: { t1: tab('t1', A), t2: tab('t2', B), t3: tab('t3', A, '旧名字') },
    order: ['t1', 't2', 't3'],
    activeTabId: 't1',
    unread: {},
    banner: null,
  });
});
afterEach(async () => {
  await unmountDom();
});

const nameOf = (tabId: string) => useTabs.getState().tabs[tabId]?.sessionName ?? null;

describe('applySessionName', () => {
  it('按会话文件推给所有打开着它的标签，返回被更新的 tabId', () => {
    const hit = applySessionName(A, '项目严重缺陷排查').sort();
    expect(hit).toEqual(['t1', 't3']);
    expect(nameOf('t1')).toBe('项目严重缺陷排查');
    expect(nameOf('t3')).toBe('项目严重缺陷排查');
  });

  it('别的会话一个字节都不动（推错对象 = 把 A 的标题写到 B 头上）', () => {
    applySessionName(A, '只该改 A');
    expect(nameOf('t2'), 'B 被误改了').toBeNull();
  });

  it('空白名字 = 清掉（不许留一个空标题把头部撑成空白）', () => {
    applySessionName(A, '   ');
    expect(nameOf('t3')).toBeNull();
    applySessionName(A, null);
    expect(nameOf('t3')).toBeNull();
  });

  it('路径按字面比较，与 findTabBySession 同一口径（多一个空格就不算同一个会话）', () => {
    // 有意不做"模糊匹配"：多推一个标签的代价（把 A 的标题写到 B 头上）比漏推大得多，
    // 而两个路径都来自宿主自己的（session_list / pi 的 get_state.sessionFile）。
    applySessionName(` ${A} `, '带空格');
    expect(useTabs.getState().tabs.t1?.sessionName).toBeNull();
  });

  it('没有标签打开这个会话时什么都不做（不报错、不新建）', () => {
    expect(applySessionName('/mock/nobody.jsonl', '无人')).toEqual([]);
    expect(Object.keys(useTabs.getState().tabs)).toEqual(['t1', 't2', 't3']);
  });
});

describe('会话头部跟着变（"上方的标题"）', () => {
  it('推到 store 之后头部立刻换成新名字', async () => {
    useMessages.getState().hydratePage(
      't1',
      [{ role: 'user', message: { role: 'user', content: [{ type: 'text', text: '帮我看看这个项目的流式渲染管线' }], timestamp: 1 } }] as never[],
      { cursor: 0, hasMore: false },
    );
    mountDom(<SessionHead tabId="t1" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    const head = () => (domContainer().querySelector('.pg-session-head-title')?.textContent ?? '').trim();
    expect(head(), '没有名字时头部退回第一条用户消息').toContain('流式渲染管线');

    await act(async () => {
      applySessionName(A, '项目严重缺陷排查');
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(head(), '生成标题之后上方还是旧标题').toBe('项目严重缺陷排查');
  });
});

describe('命令面板那条入口（⌘K → 重新生成会话标题）', () => {
  it('生成完也把名字推给打开的标签（不能只有侧栏那条路会推）', async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'session_title_generate') {
        return {
          title: '面板生成的标题',
          raw: '「面板生成的标题」',
          provider: 'mock-glm',
          modelId: 'glm-5.3-flash',
          modelUsed: 'mock-glm/glm-5.3-flash',
          elapsedMs: 700,
          promptChars: 120,
          applied: true,
          source: {},
        };
      }
      return {};
    });

    const { generateTitleForActiveTab } = await import('@/lib/appCommands');
    await act(async () => {
      await generateTitleForActiveTab();
    });
    expect(nameOf('t1'), '当前活动标签的名字没跟着改（上方标题就会是旧的）').toBe('面板生成的标题');
    expect(nameOf('t2'), '别的会话被误改了').toBeNull();
  });

  it('后端说没写下去（applied=false）时不许本地改口', async () => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(async (name: string) => {
      if (name === 'session_title_generate') {
        return { title: '没写下去的标题', raw: '', applied: false, source: {} };
      }
      return {};
    });
    const { generateTitleForActiveTab } = await import('@/lib/appCommands');
    await act(async () => {
      await generateTitleForActiveTab();
    });
    expect(nameOf('t1'), '磁盘上没改，界面就不许先说改了').toBeNull();
  });
});
