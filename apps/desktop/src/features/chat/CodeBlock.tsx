/**
 * 代码块高亮（04 §5.2、05 §3.5/§5.5，M2）：
 * - Shiki 细粒度按需：core + oniguruma 引擎 + 语言包全部动态 import，绝不全量打包；
 * - 语言 LRU ≤ 16：超出即重建 highlighter（shiki 不支持卸载语言，重建是最省内存的上限策略）；
 * - 进入视口才高亮（IntersectionObserver），离屏块零高亮成本；
 * - 双主题输出走 CSS 变量（github-light/dark），换主题零重解析。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/features/common/Icon';

type Highlighter = Awaited<ReturnType<typeof import('shiki/core').createHighlighterCore>>;

let hlPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Map<string, true>();
const LANG_LRU_MAX = 16;

async function getHighlighter(): Promise<Highlighter> {
  if (!hlPromise) {
    hlPromise = import('shiki/core').then(({ createHighlighterCore }) =>
      createHighlighterCore({
        themes: [import('shiki/themes/github-dark.mjs'), import('shiki/themes/github-light.mjs')],
        langs: [],
        engine: import('shiki/engine/oniguruma').then((m) =>
          m.createOnigurumaEngine(import('shiki/wasm')),
        ),
      }),
    );
  }
  return hlPromise;
}

async function loadLang(lang: string): Promise<string | null> {
  const hl = await getHighlighter();
  const id = lang === 'shell' || lang === 'bash' || lang === 'zsh' ? 'shell' : lang;
  const key = hl.getLoadedLanguages().includes(id) ? id : null;
  if (key) {
    loadedLangs.delete(id);
    loadedLangs.set(id, true);
    return id;
  }
  try {
    await hl.loadLanguage(await import(`shiki/langs/${id}.mjs`));
  } catch {
    return null; // 未知语言：纯文本渲染
  }
  loadedLangs.set(id, true);
  if (loadedLangs.size > LANG_LRU_MAX) {
    // LRU 上限：shiki 无法卸载语言，整体重建（低频操作，仅多语言混排时触发）
    loadedLangs.clear();
    hlPromise = null;
  }
  return id;
}

/** 纯文本/高亮的统一出口：plain=true 永不高亮（离屏、受限语言） */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const visibleRef = useRef(false);
  const LANG_RE = /^[a-z0-9+#-]+$/i;

  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (en.isIntersecting) visibleRef.current = true;
      }
      if (visibleRef.current && !html && el) {
        const id = LANG_RE.test(lang) ? lang.toLowerCase() : '';
        if (!id) {
          setHtml(null);
          io.disconnect();
          return;
        }
        void loadLang(id)
          .then(async (resolved) => {
            const hl = await getHighlighter();
            if (!resolved) throw new Error('lang unavailable');
            return hl.codeToHtml(code, {
              lang: resolved,
              themes: { light: 'github-light', dark: 'github-dark' },
              defaultColor: false,
            });
          })
          .then((out) => setHtml(out))
          .catch(() => setHtml(null))
          .finally(() => io.disconnect());
      }
    });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, lang]);

  return (
    <div className="pg-codeblock">
      {/* DSH CodeCard（docs/12 §3.3）：标题条 11px/18px、左侧语言、右侧 24x24 图标按钮 */}
      <div className="pg-codeblock-bar">
        <span className="pg-codeblock-lang">{lang || '代码'}</span>
        <button
          className="pg-codeblock-copy"
          title="复制"
          aria-label="复制代码"
          onClick={() => void navigator.clipboard.writeText(code)}
        >
          <Icon name="copy" size={14} />
        </button>
      </div>
      <pre
        ref={preRef}
        className="pg-pre pg-codeblock-pre"
        dangerouslySetInnerHTML={html ? { __html: html } : undefined}
      >
        {html ? undefined : escapeHtml(code)}
      </pre>
    </div>
  );
}

/** 转正消息的围栏代码块切分（04 §5.2；完整 unified 管线为后续增强） */
export function splitFences(text: string): Array<{ kind: 'code'; lang: string; code: string } | { kind: 'text'; text: string }> {
  const out: Array<{ kind: 'code'; lang: string; code: string } | { kind: 'text'; text: string }> = [];
  const re = /^```([a-zA-Z0-9+#-]*)\n([\s\S]*?)^```/gm;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push({ kind: 'text', text: text.slice(last, m.index) });
    out.push({ kind: 'code', lang: m[1] ?? '', code: (m[2] ?? '').replace(/\n$/, '') });
    last = re.lastIndex;
  }
  if (last < text.length) out.push({ kind: 'text', text: text.slice(last) });
  return out;
}
