// @vitest-environment jsdom
/**
 * 工具窄行（用户 2026-09-23："多消息以及多工具消息的情况下，主工作区空间利用率非常低，
 * 能不能跟 dsh 一样，用窄窄的可展开的折叠？"）。
 *
 * 此前一个工具结果 = 整块代码卡片：实测 6 行 `read` 占 **258px**、3 行 `bash` 占 **201px**，
 * 每块还带 16px 上下外边距。DSH 的对话里一个工具调用是**一行 24px**：
 *
 * ```text
 * ▸ 运行命令 · pnpm test        ← 折叠：图标 + 标题 + 圆点 + 摘要（一行，超长省略号）
 * ```
 *
 * 这里锁四件事：
 *   ① 行模型（标题/摘要/变体）按 DSH 的表 + pi 的真实参数键推导；
 *   ② 默认**折叠**且正文留在 DOM 里但不可见（本仓"折叠 ≠ 不渲染"的纪律）；
 *   ③ 点一下/按回车能展开，展开后还是原来那块代码卡片；
 *   ④ 失败行的摘要取结果首行并标红（DSH 的 `errorSummary`）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { MessageView } from '@/features/chat/MessageView';
import { toolRowModel, toolSummary, toolTitle, toolVariant, firstLine } from '@/features/chat/toolRowModel';
import { domContainer, mountDom, unmountDom } from './dom-render';

afterEach(async () => {
  await unmountDom();
});

/** 一行工具结果（`call` = store 里 join 出来的调用参数）。 */
function toolView(toolName: string, toolCallId: string, text: string, isError = false) {
  return {
    id: `m-${toolCallId}`,
    role: 'toolResult' as const,
    offset: null,
    message: { role: 'toolResult' as const, toolName, toolCallId, content: [{ type: 'text', text }], isError },
  };
}

describe('行模型：标题与摘要（对齐 DSH 的表 + pi 的参数键）', () => {
  it('pi 的 8 个核心工具都有中文标题，未知工具退到「工具调用」', () => {
    expect(toolTitle('bash')).toBe('运行命令');
    expect(toolTitle('powershell')).toBe('运行命令');
    expect(toolTitle('read')).toBe('读取');
    expect(toolTitle('write')).toBe('写入');
    expect(toolTitle('edit')).toBe('编辑');
    expect(toolTitle('grep')).toBe('搜索');
    expect(toolTitle('find')).toBe('搜索');
    expect(toolTitle('ls')).toBe('列目录');
    expect(toolTitle('subagent')).toBe('委派任务');
    expect(toolTitle('klingon-tool')).toBe('工具调用');
    expect(toolVariant('grep')).toBe('search');
    expect(toolVariant('klingon-tool')).toBe('others');
  });

  it('摘要按变体挑参数键（pi 的 schema）：command / path / pattern', () => {
    expect(toolSummary('bash', { command: 'pnpm test', timeout: 5000 })).toBe('pnpm test');
    expect(toolSummary('read', { path: 'src/a.ts', offset: 10 })).toBe('src/a.ts');
    expect(toolSummary('edit', { path: 'src/a.ts', edits: [] })).toBe('src/a.ts');
    expect(toolSummary('search', { pattern: 'boundary\\(', path: 'src' })).toBe('boundary\\(');
    // bash 优先 description（DSH 的工具带这个字段；pi 的没有 → 落到 command）
    expect(toolSummary('bash', { description: '跑测试', command: 'pnpm test' })).toBe('跑测试');
    // 变体没列到键时退到"第一个非空字符串参数"（DSH 的兜底）
    expect(toolSummary('others', { foo: 1, bar: '  hello  ' })).toBe('hello');
    expect(toolSummary('others', { foo: 1 })).toBe('');
    expect(toolSummary('bash', undefined)).toBe('');
  });

  it('摘要只占一行：到第一个换行为止（DSH `firstLine`）', () => {
    expect(firstLine('a\nb')).toBe('a');
    expect(firstLine('  a  ')).toBe('a');
    expect(toolSummary('bash', { command: 'echo 1\necho 2' })).toBe('echo 1');
  });

  it('失败行取结果首行（失败原因比"当时想跑什么"重要），并标 error', () => {
    const m = toolRowModel('bash', { command: 'pnpm test' }, 'Error: 12 tests failed\n第二行', true);
    expect(m.state).toBe('error');
    expect(m.summary).toBe('Error: 12 tests failed');
    expect(m.summaryFromResult).toBe(true);
    const ok = toolRowModel('bash', { command: 'pnpm test' }, 'PASS', false);
    expect(ok.state).toBe('ok');
    expect(ok.summary).toBe('pnpm test');
    expect(ok.summaryFromResult).toBe(false);
  });

  it('拿不到调用参数时退到结果首行，并如实标记来源（不编命令）', () => {
    const m = toolRowModel('bash', undefined, 'PASS 12 tests\n其它', false);
    expect(m.summary).toBe('PASS 12 tests');
    expect(m.summaryFromResult).toBe(true);
  });
});

describe('工具窄行渲染', () => {
  const CALL = { name: 'bash', args: { command: 'pnpm test -- --grep boundary' } };

  it('默认折叠：一行 24px，标题 + 摘要都看得见', () => {
    mountDom(
      <MessageView view={toolView('bash', 'c1', 'PASS 12 tests\n更多输出') as never} call={CALL} />,
    );
    const root = domContainer();
    const row = root.querySelector('[data-tool-row]')!;
    expect(row.getAttribute('data-open')).toBeNull();
    expect(row.getAttribute('data-state')).toBe('ok');
    expect(row.textContent).toContain('运行命令');
    expect(row.textContent).toContain('pnpm test -- --grep boundary');
    // 摘要求自调用参数（不是结果首行）
    expect(row.querySelector('.pg-trow-summary')!.getAttribute('data-summary-source')).toBe('args');
  });

  it('折叠 ≠ 不渲染：正文留在 DOM 里但不可见（Ctrl+F / 复制拿得到）', () => {
    mountDom(
      <MessageView view={toolView('bash', 'c1', 'PASS 12 tests\n更多输出') as never} call={CALL} />,
    );
    const body = domContainer().querySelector('[data-tool-body]')!;
    expect(body).not.toBeNull();
    expect(body.getAttribute('hidden')).toBe('until-found');
    // 内容真的在（不是被 slice 掉）
    expect(body.textContent).toContain('更多输出');
    expect(body.querySelector('.pg-codeblock')).not.toBeNull();
  });

  it('点一下展开：正文可见，再点收起', async () => {
    mountDom(
      <MessageView view={toolView('bash', 'c1', 'PASS 12 tests\n更多输出') as never} call={CALL} />,
    );
    const head = domContainer().querySelector('[data-disclosure-row]') as HTMLElement;
    expect(head.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      head.click();
    });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(domContainer().querySelector('[data-tool-body]')!.hasAttribute('hidden')).toBe(false);
    await act(async () => {
      head.click();
    });
    expect(domContainer().querySelector('[data-tool-body]')!.getAttribute('hidden')).toBe('until-found');
  });

  it('键盘可达：Enter / Space 都能展开（DSH `DisclosureRow` 同款）', async () => {
    mountDom(
      <MessageView view={toolView('read', 'c2', 'file body') as never} call={{ name: 'read', args: { path: 'src/a.ts' } }} />,
    );
    const head = domContainer().querySelector('[data-disclosure-row]') as HTMLElement;
    await act(async () => {
      head.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    await act(async () => {
      head.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(head.getAttribute('aria-expanded')).toBe('false');
  });

  it('失败行：红色状态 + 结果首行摘要', () => {
    mountDom(
      <MessageView
        view={toolView('bash', 'c3', 'Error: command not found', true) as never}
        call={CALL}
      />,
    );
    const row = domContainer().querySelector('[data-tool-row]')!;
    expect(row.getAttribute('data-state')).toBe('error');
    expect(row.querySelector('.pg-trow-summary')!.textContent).toBe('Error: command not found');
  });

  it('空结果：只有标题、没有摘要，也不可展开', () => {
    mountDom(<MessageView view={toolView('bash', 'c4', '') as never} call={undefined} />);
    const row = domContainer().querySelector('[data-tool-row]')!;
    expect(row.textContent).toContain('运行命令');
    expect(row.querySelector('.pg-trow-summary')).toBeNull();
    expect(domContainer().querySelector('[data-disclosure-row]')!.getAttribute('data-expandable')).toBeNull();
  });
});

describe('思考行也是窄行', () => {
  it('折叠成「思考 · 首行」，展开看全文', async () => {
    mountDom(
      <MessageView
        view={{
          id: 'a1',
          role: 'assistant',
          offset: null,
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: '先确认入口。\n第二行思考内容。' }],
          },
        } as never}
      />,
    );
    const root = domContainer();
    const row = root.querySelector('[data-thinking-row]')!;
    expect(row.textContent).toContain('思考');
    expect(row.querySelector('.pg-trow-summary')!.textContent).toBe('先确认入口。');
    const body = root.querySelector('[data-thinking-body]')!;
    expect(body.getAttribute('hidden')).toBe('until-found');
    expect(body.textContent).toContain('第二行思考内容。');
    await act(async () => {
      (root.querySelector('[data-disclosure-row]') as HTMLElement).click();
    });
    expect(row.querySelector('[data-thinking-body]')!.hasAttribute('hidden')).toBe(false);
  });
});
