// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { live } from '@/lib/live';

/** 实时块引擎（docs/04 §4 渲染分帧）：直写 DOM、不触发 React */
describe('LiveEngine', () => {
  function mounted() {
    live.reset();
    const scroll = document.createElement('div');
    const container = document.createElement('div');
    scroll.appendChild(container);
    document.body.appendChild(scroll);
    live.mount(container, scroll);
    return { scroll, container };
  }

  it('text 增量直写文本节点（appendData 语义）', () => {
    const { container } = mounted();
    live.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    live.handleFrame({ text: [{ contentIndex: 0, delta: 'Hello' }] });
    live.handleFrame({ text: [{ contentIndex: 0, delta: ' ' }, { contentIndex: 0, delta: 'Piggy' }] });
    const p = container.querySelector('.pg-live-text') as HTMLElement;
    expect(p.textContent).toBe('Hello Piggy');
    // 单文本节点（appendData 而非重建）
    const textNodes = Array.from(p.childNodes).filter((n) => n.nodeType === 3);
    expect(textNodes.length).toBe(1);
  });

  it('thinking 与 toolcall 信号建块', () => {
    const { container } = mounted();
    live.handleFrame({
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

  it('mount 前到达的帧在 mount 后冲刷（竞态安全）', () => {
    live.unmount();
    live.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    live.handleFrame({ text: [{ contentIndex: 0, delta: 'buffered' }] });
    // 手动 mount（不走 helper 的 reset：本用例验证的正是 pending 的存活）
    const scroll = document.createElement('div');
    const container = document.createElement('div');
    scroll.appendChild(container);
    document.body.appendChild(scroll);
    live.mount(container, scroll);
    expect((container.querySelector('.pg-live-text') as HTMLElement).textContent).toBe('buffered');
  });

  it('reset 清空（message_end 转正后）', () => {
    const { container } = mounted();
    live.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    live.handleFrame({ text: [{ contentIndex: 0, delta: 'x' }] });
    live.reset();
    expect(container.textContent).toBe('');
    // reset 后新块可重建
    live.handleFrame({ signals: [{ type: 'text_start', contentIndex: 0 }] });
    live.handleFrame({ text: [{ contentIndex: 0, delta: 'y' }] });
    expect((container.querySelector('.pg-live-text') as HTMLElement).textContent).toBe('y');
  });

  it('usage 1Hz 节流回调', () => {
    const { scroll } = mounted();
    scroll.remove();
    const seen: string[] = [];
    live.onUsage((t) => seen.push(t));
    live.handleFrame({ usage: { totalTokens: 100, cost: { total: 0.5 } } });
    live.handleFrame({ usage: { totalTokens: 200, cost: { total: 0.75 } } }); // 节流窗口内
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('100');
    live.onUsage(null);
  });
});
