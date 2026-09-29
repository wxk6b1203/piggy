// @vitest-environment jsdom
/**
 * 展开态必须活过**虚拟化的卸载/重挂**（用户 2026-09-23 报）。
 *
 * 现场：思考/工具行展开看完 → 往上滚一点（这一行滚出虚拟窗口，被卸载）→ 再滚回底部
 * → 行是**全新挂载**的组件，`useState(false)` 让它又折回去了，"看不到过程"。
 *
 * 这里锁三件事：
 *   ① 同一行卸载再挂载，展开态还在（思考行 / 工具行 / 工具正文的代码块各一条）；
 *   ② 行与行、标签与标签之间不许串（键的口径见 `row-memory.test.ts`）；
 *   ③ 关标签（`forgetRowTab`）之后必须忘掉 —— 否则新会话的行会捡到旧状态。
 *
 * ⚠️ 用"卸载整棵树再挂载"复刻虚拟化卸载：jsdom 里没有滚动、没有布局，
 * 虚拟化器本身跑不起来（`transcript-page.test.tsx` 用假几何 + mock 虚拟化器补这一层），
 * 而"组件实例没了、状态还在不在"这件事在这里是一样的。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { MessageView } from '@/features/chat/MessageView';
import type { MessageView as MessageViewT } from '@/stores/messages';
import { forgetRowTab, resetRowMemory, rowMemorySize } from '@/lib/rowMemory';
import { AUTO_COLLAPSE_LINES } from '@/features/chat/highlight';
import { domContainer, mountDom, unmountDom } from './dom-render';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue({}) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));

beforeEach(() => {
  resetRowMemory();
});
afterEach(async () => {
  await unmountDom();
});

const TAB = 'tab-mem';

/** 助手消息（带一个思考块）。 */
function assistantWithThinking(rowKey: string, text = '想一想：先量几何，再决定要不要贴底。'): MessageViewT {
  return {
    id: rowKey,
    role: 'assistant' as const,
    offset: null,
    message: {
      role: 'assistant' as const,
      content: [{ type: 'thinking' as const, thinking: text }],
      timestamp: 1,
    },
  };
}

function toolView(rowKey: string, text = 'file contents'): MessageViewT {
  return {
    id: rowKey,
    role: 'toolResult' as const,
    offset: null,
    message: {
      role: 'toolResult' as const,
      toolName: 'read',
      toolCallId: `call-${rowKey}`,
      content: [{ type: 'text', text }],
      isError: false,
    },
  };
}

const head = () => domContainer().querySelector<HTMLElement>('[data-disclosure-row]')!;
const thinkingRow = () => domContainer().querySelector<HTMLElement>('[data-thinking-row]')!;
const toolRow = () => domContainer().querySelector<HTMLElement>('[data-tool-row]')!;

async function click(el: HTMLElement | null | undefined) {
  await act(async () => {
    el?.click();
    await new Promise((r) => setTimeout(r, 5));
  });
}

function mount(view: MessageViewT, memory: { tabId: string; rowKey: string } | undefined) {
  mountDom(<MessageView view={view} memory={memory} />);
}

describe('思考行', () => {
  it('展开 → 卸载 → 重挂：还是展开的（这就是"看不到过程"那条）', async () => {
    const view = assistantWithThinking('r1');
    mount(view, { tabId: TAB, rowKey: 'r1' });
    expect(thinkingRow().hasAttribute('data-open'), '默认是折的').toBe(false);

    await click(head());
    expect(thinkingRow().hasAttribute('data-open')).toBe(true);

    // 滚出虚拟窗口：行组件被卸载（连同它的 useState）
    await unmountDom();
    mount(view, { tabId: TAB, rowKey: 'r1' });
    expect(thinkingRow().hasAttribute('data-open'), '重挂之后又折回去了').toBe(true);
  });

  it('没有行身份（轨迹视图那种孤立渲染）时不记忆，行为与从前一致', async () => {
    const view = assistantWithThinking('r1');
    mount(view, undefined);
    await click(head());
    expect(thinkingRow().hasAttribute('data-open')).toBe(true);
    await unmountDom();
    mount(view, undefined);
    expect(thinkingRow().hasAttribute('data-open')).toBe(false);
  });

  it('行与行不串：只记住被点开的那一行', async () => {
    mount(assistantWithThinking('r1'), { tabId: TAB, rowKey: 'r1' });
    await click(head());
    await unmountDom();

    mount(assistantWithThinking('r2'), { tabId: TAB, rowKey: 'r2' });
    expect(thinkingRow().hasAttribute('data-open'), 'r2 没被点过').toBe(false);
  });

  it('标签与标签不串：换个 tabId 就是另一行', async () => {
    mount(assistantWithThinking('r1'), { tabId: TAB, rowKey: 'r1' });
    await click(head());
    await unmountDom();

    mount(assistantWithThinking('r1'), { tabId: 'tab-other', rowKey: 'r1' });
    expect(thinkingRow().hasAttribute('data-open')).toBe(false);
  });

  it('关标签之后必须忘掉（新会话的行不许捡到旧状态）', async () => {
    const view = assistantWithThinking('r1');
    mount(view, { tabId: TAB, rowKey: 'r1' });
    await click(head());
    await unmountDom();

    forgetRowTab(TAB);
    expect(rowMemorySize()).toBe(0);
    mount(view, { tabId: TAB, rowKey: 'r1' });
    expect(thinkingRow().hasAttribute('data-open')).toBe(false);
  });
});

describe('工具行（含正文的代码块）', () => {
  it('展开态活过卸载/重挂', async () => {
    const view = toolView('r1');
    mount(view, { tabId: TAB, rowKey: 'r1' });
    expect(toolRow().hasAttribute('data-open')).toBe(false);
    await click(head());
    expect(toolRow().hasAttribute('data-open')).toBe(true);

    await unmountDom();
    mount(view, { tabId: TAB, rowKey: 'r1' });
    expect(toolRow().hasAttribute('data-open')).toBe(true);
  });

  it('正文代码块的"长输出默认折叠"不许把用户展开过的又折回去', async () => {
    // 超过自动折叠阈值的长输出：挂载时自动折上
    const lines = Array.from({ length: AUTO_COLLAPSE_LINES + 10 }, (_, i) => `line ${i + 1}`);
    const view = toolView('r1', lines.join('\n'));
    mount(view, { tabId: TAB, rowKey: 'r1' });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    const body = () => domContainer().querySelector<HTMLElement>('.pg-codeblock-body')!;
    const barBtn = () => domContainer().querySelector<HTMLButtonElement>('.pg-codeblock-btn')!;
    expect(body().hasAttribute('data-collapsed'), '长输出应当自动折上').toBe(true);

    // 用户点开（外层行 + 代码块）→ 卸载 → 重挂：两个都还得是开着的
    await click(head());
    await click(barBtn());
    expect(body().hasAttribute('data-collapsed')).toBe(false);

    await unmountDom();
    mount(view, { tabId: TAB, rowKey: 'r1' });
    expect(toolRow().hasAttribute('data-open'), '工具行').toBe(true);
    expect(
      domContainer().querySelector<HTMLElement>('.pg-codeblock-body')!.hasAttribute('data-collapsed'),
      '代码块被自动折叠覆盖了用户的选择',
    ).toBe(false);
  });
});
