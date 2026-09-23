// @vitest-environment jsdom
/**
 * 代码块高亮 / 折叠回归测试（docs/04 §5.2）。
 *
 * 起因（2026-09-23 用户截图）："代码块没有高亮（也没有部分高亮）也没有折叠，只有最大高度"。
 *
 * 查下来**不是样式问题**，是三件事叠在一起：
 *
 *  1. **高亮从来没生效过**。`import(`shiki/langs/${id}.mjs`)` 是裸说明符 + 变量，
 *     Vite 的 dynamic-import-vars 不分析裸说明符，原样留在产物里；浏览器执行时抛
 *     `TypeError: Failed to resolve module specifier 'shiki/langs/go.mjs'`，
 *     而调用点外面套着 `.catch(() => setHtml(null))` —— 异常被吞成"纯文本"。
 *     真机实测（用户正在跑的 dev server）：`hasShiki:false, spanCount:0`，
 *     **控制台一条错误都没有**。所以这条 bug 活了很久没人发现。
 *  2. **没有部分高亮**：工具结果是一个裸 `<pre>`，diff 的增删行没有任何区分。
 *  3. **没有折叠**：只有 `max-height:240px`，第 240px 之后的内容用户够不到。
 *
 * 这里锁住能在 Node/jsdom 里确定性地判定的部分；**布局相关的**（滚动、真实颜色、
 * `.shiki` 是否真的生成）由 `scripts/ui-startup-check.mjs` 在真浏览器里断言 ——
 * jsdom 的 `scrollHeight` 恒为 0，在这里断言只会假过。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { mountDom, unmountDom, domContainer } from './dom-render';
import { CodeBlock } from '@/features/chat/CodeBlock';
import {
  AUTO_COLLAPSE_LINES,
  LANG_IDS,
  MAX_RENDER_LINES,
  countLines,
  diffLineKind,
  inferToolLang,
  langLoader,
  looksLikeDiff,
  resolveLangId,
} from '@/features/chat/highlight';

afterEach(async () => {
  await unmountDom();
});

/* ------------------------------------------------------------------ 语言表 */

describe('语言表：每一条都必须真的能加载', () => {
  /**
   * 逐条**真实 import**（不是查表、不是 mock）。
   *
   * 这条用例的价值在于它抓的是"路径写错/语言不存在"——旧代码把 `bash` 映射到
   * `shell`、把 `ts` 映射到 `tsx` 这类错误，在类型层面完全看不出来（都是字符串），
   * 运行期也被 catch 吞掉。只有在真正 import 一次之后才会现形。
   */
  it('LANG_IDS 里每个 id 都能 import 出语法（default 是注册数组）', async () => {
    const bad: string[] = [];
    for (const id of LANG_IDS) {
      const loader = langLoader(id);
      if (!loader) {
        bad.push(`${id}: 表里有 id 却取不到 loader`);
        continue;
      }
      try {
        const mod = (await loader()) as { default?: unknown };
        const regs = mod.default;
        if (!Array.isArray(regs) || regs.length === 0) {
          bad.push(`${id}: default 不是非空数组（${typeof regs}）`);
          continue;
        }
        const hasScope = regs.some(
          (r) => typeof (r as { scopeName?: unknown })?.scopeName === 'string',
        );
        if (!hasScope) bad.push(`${id}: 注册项里没有 scopeName`);
      } catch (e) {
        bad.push(`${id}: import 失败 ${String(e).slice(0, 120)}`);
      }
    }
    expect(bad).toEqual([]);
  }, 120_000);

  it('语言表规模合理（不是只剩三五个语言却装作支持很多）', () => {
    expect(LANG_IDS.length).toBeGreaterThanOrEqual(60);
    expect(new Set(LANG_IDS).size).toBe(LANG_IDS.length);
  });
});

describe('语言别名归一', () => {
  it.each([
    ['bash', 'shellscript'],
    ['sh', 'shellscript'],
    ['zsh', 'shellscript'],
    ['yml', 'yaml'],
    ['ts', 'typescript'],
    ['tsx', 'tsx'],
    ['js', 'javascript'],
    ['py', 'python'],
    ['golang', 'go'],
    ['rs', 'rust'],
    ['c++', 'cpp'],
    ['c#', 'csharp'],
    ['objc', 'objective-c'],
    ['ps1', 'powershell'],
    ['tf', 'hcl'],
    ['md', 'markdown'],
    ['patch', 'diff'],
    ['', ''],
  ])('%s → %s', (raw, want) => {
    const r = resolveLangId(raw);
    if (want === '') {
      // 空标签：明确"不高亮"，不是"不认识"
      expect(r.kind).toBe('plain');
    } else {
      expect(r).toEqual({ kind: 'lang', id: want });
    }
  });

  it('明确要求纯文本的标签归为 plain（不是 unknown）', () => {
    for (const s of ['text', 'txt', 'plain', 'output', 'NONE']) {
      expect(resolveLangId(s).kind).toBe('plain');
    }
  });

  it('不认识的标签归为 unknown 且带上原文（界面要能说出来）', () => {
    expect(resolveLangId('klingon')).toEqual({ kind: 'unknown', raw: 'klingon' });
  });

  it('非法标签（含空格/路径片段）一律 plain，不拿去拼 import', () => {
    for (const s of ['../../etc/passwd', 'a b', 'sh;rm -rf /', '**']) {
      expect(resolveLangId(s).kind).toBe('plain');
    }
  });
});

/* -------------------------------------------------------------------- diff */

describe('diff 行分类（"部分高亮"的判定）', () => {
  it('+++/--- 是文件头，不是增删行', () => {
    // 这条最容易错：按前缀判会把 `+++ b/x.go` 当成"新增了一行 ++ b/x.go"
    expect(diffLineKind('+++ b/3_optimize_ws_goroutines/epoll.go')).toBe('meta');
    expect(diffLineKind('--- a/3_optimize_ws_goroutines/epoll.go')).toBe('meta');
  });

  it('增/删/块头/元信息各归各类', () => {
    expect(diffLineKind('+    "golang.org/x/sys/unix"')).toBe('add');
    expect(diffLineKind('-    "github.com/gorilla/websocket"')).toBe('del');
    expect(diffLineKind('@@ -1,9 +1,9 @@')).toBe('hunk');
    expect(diffLineKind('diff --git a/x.go b/x.go')).toBe('meta');
    expect(diffLineKind('index 2da34df..0902aa3 100644')).toBe('meta');
    expect(diffLineKind('new file mode 100644')).toBe('meta');
    expect(diffLineKind('\\ No newline at end of file')).toBe('meta');
  });

  it('上下文行与空行是 ctx（不着色）', () => {
    expect(diffLineKind(' package main')).toBe('ctx');
    expect(diffLineKind('')).toBe('ctx');
  });

  it('用户截图里那段真实 diff 逐行判定正确', () => {
    const real = [
      'diff --git a/3_optimize_ws_goroutines/epoll.go b/3_optimize_ws_goroutines/epoll.go',
      'index 2da34df..0902aa3 100644',
      '--- a/3_optimize_ws_goroutines/epoll.go',
      '+++ b/3_optimize_ws_goroutines/epoll.go',
      '@@ -1,9 +1,9 @@',
      ' package main',
      ' ',
      ' import (',
      '-    "github.com/gorilla/websocket"',
      '+    "golang.org/x/sys/unix"',
      ' )',
    ];
    expect(real.map(diffLineKind)).toEqual([
      'meta',
      'meta',
      'meta',
      'meta',
      'hunk',
      'ctx',
      'ctx',
      'ctx',
      'del',
      'add',
      'ctx',
    ]);
  });
});

describe('diff 嗅探', () => {
  it('认得 git diff / 裸 hunk / ---+++ 对', () => {
    expect(looksLikeDiff('diff --git a/x b/x\nindex 1..2')).toBe(true);
    expect(looksLikeDiff('@@ -1,2 +1,2 @@\n-a\n+b')).toBe(true);
    expect(looksLikeDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@')).toBe(true);
  });

  it('不把普通文本误判成 diff', () => {
    expect(looksLikeDiff('ls -la 的输出\n总计 96')).toBe(false);
    expect(looksLikeDiff('我说 --- 这三个横线只是分隔符')).toBe(false);
    expect(looksLikeDiff('')).toBe(false);
  });
});

describe('工具结果的语言嗅探', () => {
  it('bash 吐 diff → 按 diff 上色（截图里的情形）', () => {
    expect(inferToolLang('bash', 'diff --git a/x b/x\n@@ -1 +1 @@\n-a\n+b')).toEqual({
      lang: 'diff',
      source: 'diff',
    });
  });

  it('bash 的普通输出 → shell', () => {
    expect(inferToolLang('bash', 'total 96\ndrwxr-xr-x  4 wxk  wheel')).toEqual({
      lang: 'shellscript',
      source: 'shell',
    });
  });

  it('read/write 的结果体不含路径 → 老实承认不知道（不瞎猜语言）', () => {
    expect(inferToolLang('read', '# pi-guardrails\n\n把 DSH 的机制移植到 pi')).toEqual({
      lang: '',
      source: 'none',
    });
    expect(inferToolLang('write', 'Successfully wrote to /tmp/x')).toEqual({
      lang: '',
      source: 'none',
    });
  });
});

describe('行数', () => {
  it('末尾换行不算额外一行', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('a')).toBe(1);
    expect(countLines('a\n')).toBe(1);
    expect(countLines('a\nb')).toBe(2);
  });
});

/* -------------------------------------------------------------- 组件行为 */

const FENCE = '```go\npackage main\n```';

describe('CodeBlock 渲染（jsdom 能确定性判定的部分）', () => {
  it('围栏切分仍把代码块与正文分开', async () => {
    const { splitFences } = await import('@/features/chat/CodeBlock');
    const segs = splitFences(`前言\n${FENCE}\n后记`);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'code', 'text']);
    expect(segs[1]).toMatchObject({ lang: 'go', code: 'package main' });
  });

  it('标题栏显示语言与行数', () => {
    mountDom(<CodeBlock code={'a\nb\nc'} lang="go" />);
    const bar = domContainer().querySelector('.pg-codeblock-lang')!;
    expect(bar.textContent).toContain('go');
    expect(bar.textContent).toContain('3 行');
  });

  it('title 覆盖语言名（工具结果用 toolName）', () => {
    mountDom(<CodeBlock code={'a\nb'} lang="diff" title="bash" />);
    expect(domContainer().querySelector('.pg-codeblock-lang')!.textContent).toContain('bash');
  });

  it('未收录的语言**说出来**，不装作高亮过', () => {
    mountDom(<CodeBlock code="x" lang="klingon" />);
    expect(domContainer().querySelector('.pg-codeblock-hlwarn')!.textContent).toBe('未收录此语言');
  });

  it('纯文本标签不报"未收录"', () => {
    mountDom(<CodeBlock code="x" lang="text" />);
    expect(domContainer().querySelector('.pg-codeblock-hlwarn')).toBeNull();
  });

  it('超过 40 行默认折叠，但**内容全在 DOM 里**（可 Ctrl+F / 可复制）', () => {
    const code = Array.from({ length: AUTO_COLLAPSE_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
    mountDom(<CodeBlock code={code} lang="text" collapsible />);
    const root = domContainer();
    expect(root.querySelector('.pg-codeblock-body')!.hasAttribute('data-collapsed')).toBe(true);
    // 关键：折叠 ≠ 不渲染。旧实现是 `.slice(0,8)` 那种"内容根本不在 DOM 里"。
    expect(root.querySelector('pre')!.textContent!.split('\n')).toHaveLength(AUTO_COLLAPSE_LINES + 5);
  });

  it('短块不自动折叠', () => {
    mountDom(<CodeBlock code={'a\nb'} lang="go" collapsible />);
    expect(domContainer().querySelector('.pg-codeblock-body')!.hasAttribute('data-collapsed')).toBe(false);
  });

  it('折叠开关能来回切换（键盘可达：是真 button，带 aria-expanded）', () => {
    const code = Array.from({ length: AUTO_COLLAPSE_LINES + 5 }, (_, i) => `line ${i}`).join('\n');
    mountDom(<CodeBlock code={code} lang="text" collapsible />);
    const root = domContainer();
    const toggle = root.querySelector<HTMLButtonElement>('.pg-codeblock-btn')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    act(() => toggle.click());
    expect(root.querySelector('.pg-codeblock-body')!.hasAttribute('data-collapsed')).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    act(() => toggle.click());
    expect(root.querySelector('.pg-codeblock-body')!.hasAttribute('data-collapsed')).toBe(true);
  });

  it('病态超长输出：显式截断 + 说清截了多少 + 一键放开', () => {
    const total = MAX_RENDER_LINES + 37;
    const code = Array.from({ length: total }, (_, i) => `row ${i}`).join('\n');
    mountDom(<CodeBlock code={code} lang="log" />);
    const root = domContainer();
    expect(root.querySelector('pre')!.textContent!.split('\n')).toHaveLength(MAX_RENDER_LINES);
    const notice = root.querySelector('.pg-codeblock-trunc')!;
    expect(notice.textContent).toContain(String(MAX_RENDER_LINES));
    expect(notice.textContent).toContain(String(total));
    act(() => root.querySelector<HTMLButtonElement>('.pg-codeblock-trunc-btn')!.click());
    expect(root.querySelector('pre')!.textContent!.split('\n')).toHaveLength(total);
    expect(root.querySelector('.pg-codeblock-trunc')).toBeNull();
  });
});

/* ------------------------------------------------------------ 反模式源码门 */

describe('源码门：不许再把动态 import 写成不可分析的形式', () => {
  const SRC = join(process.cwd(), 'src');

  function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx)$/.test(p)) out.push(p);
    }
    return out;
  }

  /**
   * 去注释后再扫：这些头注释里**故意**写着反模式的原文（用来解释它为什么错），
   * 不剥掉的话门会把自己的说明文字当成违规 —— 假阳性比没有门更坏，
   * 它会训练人忽略这条红灯。
   */
  function stripComments(text: string): string {
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  }

  /**
   * 这是这次 bug 的**根因形态**：`import(`...${x}...`)` 里的说明符是裸包名。
   * Vite 的 dynamic-import-vars **不支持裸说明符**，构建期连 warning 都不给，
   * 产物里原样保留，运行期才抛 —— 再被 catch 一吞，就是"静默无高亮"。
   *
   * 允许的写法只有两种：字面量说明符，或相对路径（`./`、`/`、`@/`）里的变量。
   */
  it('没有裸说明符的模板字符串动态 import', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      const re = /import\(\s*`([^`]*)`|import\(\s*'([^']*\$\{)|import\(\s*"([^"]*\$\{)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        const spec = (m[1] ?? m[2] ?? m[3] ?? '').trim();
        const bare = !/^(\.|\/|@\/)/.test(spec);
        if (bare) offenders.push(`${file.replace(`${SRC}/`, '')}: import(\`${spec}\`)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('语言表用的是字面量 shiki/langs/<name>.mjs', () => {
    const text = stripComments(readFileSync(join(SRC, 'features/chat/highlight.ts'), 'utf8'));
    const lits = text.match(/import\('shiki\/langs\/[a-z0-9-]+\.mjs'\)/g) ?? [];
    expect(lits.length).toBe(LANG_IDS.length);
    // 反向：不许出现任何带 ${ 的 shiki 语言 import
    expect(text).not.toMatch(/import\(`[^`]*shiki[^`]*`\)/);
  });
});
