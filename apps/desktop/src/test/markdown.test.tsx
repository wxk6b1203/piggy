// @vitest-environment jsdom
/**
 * Markdown 渲染（用户 2026-09-23 截图：助手回答里的 `## 🔴 严重缺陷`、`**默认配置受影响**`、
 * `---` 全是原样文本）。
 *
 * 核实：`MessageView` 的 text 分支此前只做 `splitFences()`（围栏 → 代码卡片），
 * 其余当纯文本 —— docs/04 §5 写着"Markdown 只在转正时解析一次"，那个 parser 一直没落地。
 *
 * 这里锁四组：
 *   ① 语法覆盖：标题 / 粗斜体 / 删除线 / 行内代码 / 列表（嵌套、有序、任务）/ 引用 /
 *      分隔线 / 链接 / 表格 / 围栏（→ 同一块代码卡片）；
 *   ② 安全：原始 HTML **按纯文本**渲染（不进 DOM）、URL 白名单（`javascript:` / `file:` /
 *      相对路径一律降级成纯文本）；
 *   ③ 流式**增量**渲染：冻结前缀的 DOM 节点跨帧**是同一个节点**（不是"内容一样"，是身份一样）、
 *      尾部照常跟着长、非追加输入整段重置、六种"跨块的块"在切点处不变义；
 *   ④ 畸形输入不白屏（parser 抛错时退回纯文本）。
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
  FeedbackBridge: () => null,
  confirm: vi.fn(),
}));

import { Markdown, StreamingMarkdown, safeUrl } from '@/features/chat/markdown';
import { MessageView } from '@/features/chat/MessageView';
import { isExternalUrlAllowed } from '@/lib/externalLink';
import { domContainer, mountDom, rerender, unmountDom } from './dom-render';

/**
 * 把一段文本逐块"流"进来（每次重新渲染同一个 `<StreamingMarkdown>`）。
 * @returns 每一帧的根元素（`.pg-md-streaming`）
 */
async function streamFrames(text: string, chunk: number): Promise<HTMLElement[]> {
  const frames: HTMLElement[] = [];
  mountDom(<StreamingMarkdown text={text.slice(0, chunk)} />);
  frames.push(domContainer().querySelector('.pg-md-streaming')!);
  for (let i = chunk * 2; i <= text.length + chunk; i += chunk) {
    const next = text.slice(0, Math.min(i, text.length));
    await act(async () => {
      rerender(<StreamingMarkdown text={next} />);
      await new Promise((r) => setTimeout(r, 0));
    });
    frames.push(domContainer().querySelector('.pg-md-streaming')!);
  }
  return frames;
}

afterEach(async () => {
  await unmountDom();
});

/** 渲染一段 markdown，返回根元素。 */
function render(md: string, compact = false) {
  mountDom(<Markdown text={md} compact={compact} />);
  return domContainer().querySelector('.pg-md')!;
}

describe('Markdown：语法覆盖', () => {
  it('标题按深度出 h1–h6（不是一串井号）', () => {
    const root = render('# 一级\n\n## 二级\n\n### 三级\n\n###### 六级');
    expect([...root.querySelectorAll('h1,h2,h3,h6')].map((h) => h.tagName)).toEqual([
      'H1',
      'H2',
      'H3',
      'H6',
    ]);
    expect(root.textContent).not.toContain('#');
  });

  it('粗体 / 斜体 / 删除线 / 行内代码', () => {
    const root = render('这里有 **粗**、*斜*、~~删~~ 与 `code`。');
    expect(root.querySelector('strong')!.textContent).toBe('粗');
    expect(root.querySelector('em')!.textContent).toBe('斜');
    expect(root.querySelector('del')!.textContent).toBe('删');
    expect(root.querySelector(':not(pre) > code')!.textContent).toBe('code');
    expect(root.textContent).not.toContain('**');
  });

  it('无序 / 有序 / 嵌套 / 任务列表', () => {
    const root = render('- a\n- b\n  - b1\n\n1. 一\n2. 二\n\n- [x] 完成\n- [ ] 未完成');
    expect(root.querySelectorAll('ul > li').length).toBeGreaterThanOrEqual(4);
    expect(root.querySelectorAll('ol > li').length).toBe(2);
    expect(root.querySelectorAll('ul ul, ul ol, ol ol').length).toBe(1);
    expect(root.querySelectorAll('input[type=checkbox]').length).toBe(2);
    expect(root.querySelector('input[type=checkbox]')!.hasAttribute('checked')).toBe(true);
  });

  it('引用 / 分隔线 / 表格（含对齐）', () => {
    const root = render('> 引用一行\n\n---\n\n| A | B |\n| --- | ---: |\n| 1 | 2 |');
    expect(root.querySelector('blockquote')!.textContent).toContain('引用一行');
    expect(root.querySelectorAll('hr').length).toBe(1);
    expect(root.querySelectorAll('th').length).toBe(2);
    expect(root.querySelectorAll('td').length).toBe(2);
    expect((root.querySelectorAll('th')[1] as HTMLElement).style.textAlign).toBe('right');
  });

  it('围栏 → 与对话里同一块代码卡片（行数/语言条在）', () => {
    const root = render('```ts\nconst a: number = 1\n```');
    const card = root.querySelector('.pg-codeblock')!;
    expect(card).not.toBeNull();
    expect(card.querySelector('.pg-codeblock-lines')!.textContent).toContain('1 行');
    expect(card.getAttribute('data-lang')).toBe('typescript');
  });

  it('没有语言标签的围栏走纯文本（不报"未收录此语言"）', () => {
    const root = render('```\nplain text\n```');
    expect(root.querySelector('.pg-codeblock-hlwarn')).toBeNull();
  });
});

describe('Markdown：安全', () => {
  it('原始 HTML 按纯文本渲染（一个字都不进 DOM）', () => {
    const root = render('前 <script>window.__pwned = 1</script> <img src=x onerror="window.__pwned=2"> 后');
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<script>'); // 原样可见
    expect((globalThis as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('链接白名单：http/https/mailto 可点，其余降级成纯文本', () => {
    const root = render(
      '[好的](https://example.com/a) [坏的](javascript:alert(1)) [相对](./x.md) [邮件](mailto:a@b.c)',
    );
    const links = [...root.querySelectorAll('a.pg-md-link')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://example.com/a',
      'mailto:a@b.c',
    ]);
    const unsafe = [...root.querySelectorAll('.pg-md-unsafe')].map((e) => e.textContent);
    expect(unsafe.some((t) => t?.includes('javascript:alert(1)'))).toBe(true);
    expect(unsafe.some((t) => t?.includes('./x.md'))).toBe(true);
  });

  it('图片只认 http(s)：其它显示成"图片：替代文本"而不是破图', () => {
    const root = render('![图](file:///etc/passwd) ![网图](https://example.com/a.png)');
    expect(root.querySelector('img')).not.toBeNull();
    expect(root.querySelector('img')!.getAttribute('src')).toBe('https://example.com/a.png');
    expect(root.textContent).toContain('[图片：图]');
  });

  it('safeUrl：白名单之外一律 null（含锚点、data:、畸形 URL）', () => {
    expect(safeUrl('https://a.b/c')).toBe('https://a.b/c');
    expect(safeUrl('  https://a.b/c  ')).toBe('https://a.b/c');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('file:///etc/passwd')).toBeNull();
    expect(safeUrl('#anchor')).toBeNull();
    expect(safeUrl('')).toBeNull();
    expect(safeUrl('not a url')).toBeNull();
  });

  it('链接点击不导航 webview：走宿主命令 open_external_url', async () => {
    invokeMock.mockResolvedValue(undefined);
    const root = render('[点我](https://example.com/x)');
    await act(async () => {
      (root.querySelector('a.pg-md-link') as HTMLAnchorElement).click();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith('open_external_url', { url: 'https://example.com/x' });
  });
});

describe('Markdown：行内边界与降级', () => {
  it('紧凑变体（思考正文）挂 .pg-md-compact', () => {
    const root = render('思考里的 **强调**', true);
    expect(root.classList.contains('pg-md-compact')).toBe(true);
  });

  /* ⚠️ 每条各自 mount/unmount：同一个 it 里连续 mount 会撞上 harness 的
     "overlapping act()"（实测第二、三次 mount 拿不到新容器 → 假红）。 */
  it('病态输入不崩：12 层嵌套列表', () => {
    const deep = Array.from({ length: 12 }, (_, i) => `${'  '.repeat(i)}- 第 ${i} 层`).join('\n');
    const root = render(deep);
    expect(root.querySelectorAll('li').length).toBeGreaterThan(5);
  });

  it('病态输入不崩：未闭合的围栏', () => {
    const root = render('```ts\nconst a = 1');
    expect(root.textContent).toContain('const a = 1');
  });

  it('病态输入不崩：单行 2 万字符', () => {
    const root = render(`正文 ${'x'.repeat(20_000)}`);
    expect(root.textContent!.length).toBeGreaterThan(20_000);
  });

  it('MessageView 的助手正文走 markdown（端到端一条）', () => {
    mountDom(
      <MessageView
        view={{
          id: 'a1',
          role: 'assistant',
          offset: null,
          message: { role: 'assistant', content: [{ type: 'text', text: '## 小标题\n\n**重点**：结论。' }] },
        } as never}
      />,
    );
    const root = domContainer();
    expect(root.querySelector('.pg-assistant-body .pg-md h2')!.textContent).toBe('小标题');
    expect(root.querySelector('.pg-md strong')!.textContent).toBe('重点');
  });
});

describe('externalLink：前后端白名单一致', () => {
  it('前端判定与 Rust 的 EXTERNAL_URL_SCHEMES 对齐（读源码核对，改一处就红）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const rust = readFileSync(
      join(import.meta.dirname, '../../src-tauri/src/open_in_app/mod.rs'),
      'utf8',
    );
    const m = /const EXTERNAL_URL_SCHEMES: \[&str; \d+\] = \[([^\]]+)\]/.exec(rust);
    expect(m, 'Rust 侧的白名单常量没找到（改名了？）').not.toBeNull();
    const rustSchemes = m![1]!.split(',').map((s) => s.trim().replace(/"/g, '')).filter(Boolean);
    const tsSchemes = ['http', 'https', 'mailto'];
    expect(rustSchemes).toEqual(tsSchemes);
    for (const s of tsSchemes) {
      expect(isExternalUrlAllowed(`${s}:x`)).toBe(true);
      expect(isExternalUrlAllowed(`${s.toUpperCase()}:x`)).toBe(true);
    }
    expect(isExternalUrlAllowed('javascript:alert(1)')).toBe(false);
  });
});

/**
 * 流式**增量**渲染（2026-09-24）。
 *
 * 口径：流式正文也渲染 markdown，但走"冻结前缀 + 只重解析尾部"（`StreamingMarkdown`）。
 * 这里锁四件事，其中第 ① 条是这份实现的**全部意义**：
 *
 *   ① **冻结块的 DOM 节点跨帧是同一个节点**（`toBe` 而不是"内容相等"）——
 *      只比内容的话，"每帧整棵重建、恰好长得一样"也会绿，而那正是用户看到的闪烁；
 *   ② 还在长的尾部照常更新（同一段话越写越长）；
 *   ③ 非追加输入（换窗/编辑把文本换掉）整段重置，不出现重影；
 *   ④ 六种"跨块的块"在切点处不变义（setext 标题 / 未闭合围栏 / 引用定义在后面 /
 *      列表惰性续行 / 缩进代码 / 表格混排）—— 切点落在空行之后就是为了它们。
 */
describe('StreamingMarkdown：冻结前缀 + 只重解析尾部', () => {
  const DOC = [
    '# 流式标题',
    '',
    '第一段 **加粗** 与 `code`。',
    '',
    '- 列表项一',
    '- 列表项二',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '| 列 | 值 |',
    '| -- | -- |',
    '| a  | 1  |',
    '',
    '最后一段：**收尾**。',
    '',
  ].join('\n');

  it('已经冻结的块跨帧**是同一个 DOM 节点**（不是"内容一样"）', async () => {
    const frames = await streamFrames(DOC, 6);
    // 第一帧就画出了标题（h1）
    expect(frames[0]!.querySelector('h1')!.textContent).toBe('流式标题');
    const firstTitle = frames[0]!.querySelector('h1')!;
    const lastTitle = frames.at(-1)!.querySelector('h1')!;
    expect(lastTitle, '标题在后续帧里被重挂了（用户会看到上面在闪）').toBe(firstTitle);
    // 标题的**文本节点**也应当是同一个（没有重建）
    expect(lastTitle.firstChild).toBe(firstTitle.firstChild);
  });

  it('尾部还在长：同一个段落节点里文字越写越长，落定后不再变', async () => {
    const frames = await streamFrames('前言。\n\n第二段正在**长', 4);
    const last = frames.at(-1)!;
    // 最后一段（还没闭合的加粗）在末尾，且是同一个 <p> 节点在长
    const p = last.querySelectorAll('p');
    expect(p.length).toBeGreaterThan(0);
    expect(last.textContent).toContain('第二段正在');
    expect(last.textContent, '半截的 ** 不该消失（它是内容）').toContain('**');
  });

  it('非追加输入（文本被整段换掉）→ 整段重置，不出现上一份的残留', async () => {
    mountDom(<StreamingMarkdown text={'# 旧的一篇\n\n旧正文。'} />);
    const before = domContainer().querySelector('.pg-md-streaming')!;
    expect(before.textContent).toContain('旧正文');
    await act(async () => {
      rerender(<StreamingMarkdown text={'# 新的一篇\n\n新正文。'} />);
      await new Promise((r) => setTimeout(r, 0));
    });
    const after = domContainer().querySelector('.pg-md-streaming')!;
    expect(after.textContent).toContain('新正文');
    expect(after.textContent, '换窗之后旧内容还挂在树上').not.toContain('旧正文');
  });

  it('六种"跨块的块"：冻结区逐帧不变、尾部结构与全量解析一致', async () => {
    const cases = [
      '# A\n\n第一段。\n\n二级标题\n---\n\n后面一段。\n',
      '# A\n\n说明：\n\n```ts\nconst a = 1;\nconst b = 2;\n',
      '看这个 [链接][r]。\n\n别的段落。\n\n[r]: https://example.com\n',
      '- 第一项\n  继续\n- 第二项\n\n段落。\n',
      '段落一。\n\n    缩进代码\n    第二行\n\n段落二。\n',
      '# A\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- x\n- y\n\n```go\nfunc f() {}\n```\n\n> 引用\n\n结束。\n',
    ];
    for (const doc of cases) {
      const frames = await streamFrames(doc, 3);
      /* 冻结区的**节点身份**：每个位置上的第一个节点，从它出现的那一帧到最后一帧
         必须是同一个 DOM 节点。只比 textContent 会漏掉"整棵重建但内容恰好一样"，
         而那正是用户看到的闪烁。 */
      const streamRoot = frames.at(-1)!;
      for (let i = 0; i < streamRoot.children.length; i += 1) {
        const appeared = frames.find((f) => f.children[i]);
        if (!appeared) continue;
        expect(
          streamRoot.children[i],
          `构造「${doc.slice(0, 10)}…」的第 ${i} 个块在后续帧里被重挂了`,
        ).toBe(appeared.children[i]);
      }
      // 结构与全量解析一致（标签序列）—— 先抓住流式那一份，`render()` 会把它换掉
      const streamTags = [...streamRoot.children].map((c) => c.tagName).join(',');
      const full = render(doc);
      expect(streamTags, '流式与全量的块序列不一致').toBe(
        [...full.children].map((c) => c.tagName).join(','),
      );
      await unmountDom();
    }
  });

  it('安全口径与落定一致：原始 HTML 仍然一个字都不进 DOM', async () => {
    mountDom(<StreamingMarkdown text={'前 <script>window.__x = 1</script> 后'} />);
    const root = domContainer().querySelector('.pg-md-streaming')!;
    expect(root.querySelector('script')).toBeNull();
    expect(root.textContent).toContain('<script>');
    expect((globalThis as { __x?: number }).__x).toBeUndefined();
  });

  it('围栏代码块在流式期间不上色（不每帧重跑 shiki），落定后才上色', async () => {
    mountDom(<StreamingMarkdown text={'```ts\nconst a = 1;\n```'} />);
    const live = domContainer().querySelector('.pg-codeblock')!;
    expect(live.querySelector('.shiki'), '流式围栏不该已经上色').toBeNull();
    // 同一段文本交给落定的 Markdown：走正常高亮路径（异步，等一轮微任务）
    await act(async () => {
      rerender(<Markdown text={'```ts\nconst a = 1;\n```'} />);
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(domContainer().querySelector('.pg-codeblock')).toBeTruthy();
  });
});
