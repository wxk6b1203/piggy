// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { liveFor, disposeLive } from '@/lib/live';

/** 实时块引擎（docs/04 §4 渲染分帧）：直写 DOM、不触发 React；per-tab 实例 */
describe('LiveEngine（per-tab）', () => {
  let TAB = 'lt-1';
  const eng = () => liveFor(TAB);

  function mounted() {
    eng().reset();
    const scroll = document.createElement('div');
    const container = document.createElement('div');
    scroll.appendChild(container);
    document.body.appendChild(scroll);
    eng().mount(container, scroll);
    return { scroll, container };
  }

  it('text 增量直写文本节点（appendData 语义）', () => {
    const { container } = mounted();
    eng().handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    eng().handleFrame({ text: [{ contentIndex: 0, delta: 'Hello' }] });
    eng().handleFrame({ text: [{ contentIndex: 0, delta: ' ' }, { contentIndex: 0, delta: 'Piggy' }] });
    const p = container.querySelector('.pg-live-text') as HTMLElement;
    expect(p.textContent).toBe('Hello Piggy');
    const textNodes = Array.from(p.childNodes).filter((n) => n.nodeType === 3);
    expect(textNodes.length).toBe(1);
  });

  it('thinking 与 toolcall 信号建块', () => {
    const { container } = mounted();
    eng().handleFrame({
      signals: [
        { type: 'thinking_start', contentIndex: 1 },
        { type: 'toolcall_start', contentIndex: 2, id: 'c1', toolName: 'bash' },
      ],
      thinking: [{ contentIndex: 1, delta: 'hmm' }],
    });
    expect(container.querySelector('.pg-live-thinking')).toBeTruthy();
    expect((container.querySelector('.pg-thinking-body') as HTMLElement).textContent).toBe('hmm');
    expect(container.querySelector('.pg-live-toolchip')!.textContent).toContain('bash');
  });

  it('mount 前到达的帧在 mount 后冲刷（竞态安全，用全新 tab 验证 pending 存活）', () => {
    TAB = 'lt-race';
    const e = liveFor(TAB);
    e.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    e.handleFrame({ text: [{ contentIndex: 0, delta: 'buffered' }] });
    // 手动 mount（不走 helper 的 reset：本用例验证的正是 pending 的存活）
    const scroll = document.createElement('div');
    const container = document.createElement('div');
    scroll.appendChild(container);
    document.body.appendChild(scroll);
    e.mount(container, scroll);
    expect((container.querySelector('.pg-live-text') as HTMLElement).textContent).toBe('buffered');
    disposeLive(TAB);
  });

  it('reset 清空（message_end 转正后）', () => {
    const { container } = mounted();
    eng().handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    eng().handleFrame({ text: [{ contentIndex: 0, delta: 'x' }] });
    eng().reset();
    expect(container.textContent).toBe('');
    eng().handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    eng().handleFrame({ text: [{ contentIndex: 0, delta: 'y' }] });
    expect((container.querySelector('.pg-live-text') as HTMLElement).textContent).toBe('y');
  });

  it('usage 1Hz 节流回调', () => {
    const { scroll } = mounted();
    scroll.remove();
    const seen: string[] = [];
    eng().onUsage((t) => seen.push(t));
    eng().handleFrame({ usage: { totalTokens: 100, cost: { total: 0.5 } } });
    eng().handleFrame({ usage: { totalTokens: 200, cost: { total: 0.75 } } }); // 节流窗口内
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('100');
    eng().onUsage(null);
  });
});
