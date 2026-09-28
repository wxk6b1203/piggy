/**
 * 代码块（04 §5.2、05 §3.5/§5.5，M2；M2.2 修复高亮 + 折叠）：
 * - Shiki 细粒度按需：core + oniguruma 引擎 + 语言包全部动态 import，绝不全量打包；
 *   语言表见 `highlight.ts`（**必须字面量**，那里的头注释解释了为什么）；
 * - 语言 LRU ≤ 16：超出即重建 highlighter（shiki 不支持卸载语言，重建是最省内存的上限策略）；
 * - 进入视口才高亮（IntersectionObserver），离屏块零高亮成本；
 * - 双主题输出走 CSS 变量（github-light/dark），换主题零重解析；
 * - **diff 逐行语义类**（`pg-dl-add/del/hunk/meta`）→ 增删行有底色，这是"部分高亮"；
 * - **折叠**：标题栏常驻折叠开关；高度超上限给"展开/收起"；超长输出显式截断并可放开；
 * - 高亮**失败不再静默**：标题栏标记"未能高亮"，真实原因进 console.warn。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { t, tf } from '@/lib/i18n';
import { watchSize } from '@/lib/resizeWatch';
import { Icon } from '@/features/common/Icon';
import {
  AUTO_COLLAPSE_LINES,
  MAX_RENDER_LINES,
  countLines,
  diffLineKind,
  langLoader,
  resolveLangId,
  type LangId,
} from './highlight';

type Highlighter = Awaited<ReturnType<typeof import('shiki/core').createHighlighterCore>>;
type Transformers = NonNullable<NonNullable<Parameters<Highlighter['codeToHtml']>[1]>['transformers']>;

let hlPromise: Promise<Highlighter> | null = null;
const loadedLangs = new Set<string>();
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

/**
 * 加载语言并把规范 id 返回给调用方。失败时**抛出**（由调用点标记在界面上），
 * 绝不返回 null 假装成功 —— 旧实现正是在这里把异常吞成"纯文本"，
 * 于是"高亮从来没生效"这件事在界面上和控制台里都看不见。
 */
async function loadLang(id: LangId): Promise<LangId> {
  const hl = await getHighlighter();
  if (hl.getLoadedLanguages().includes(id)) {
    loadedLangs.delete(id);
    loadedLangs.add(id);
    return id;
  }
  const loader = langLoader(id);
  if (!loader) throw new Error(`language not in table: ${id}`);
  // shiki 细粒度语言模块的 default 导出是**语法数组**（自带 embeddedLangs 展开），
  // 直接交给 loadLanguage；shiki 内部的 normalizeGetter 会拆掉 module namespace。
  await hl.loadLanguage((await loader()) as Parameters<Highlighter['loadLanguage']>[0]);
  loadedLangs.add(id);
  if (loadedLangs.size > LANG_LRU_MAX) {
    // LRU 上限：shiki 无法卸载语言，整体重建（低频操作，仅多语言混排时触发）
    loadedLangs.clear();
    hlPromise = null;
  }
  return id;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** diff 逐行语义词 → hast 追加类。空串=上下文行，不加类。 */
const DIFF_CLASS: Record<string, string> = {
  add: 'pg-dl-add',
  del: 'pg-dl-del',
  hunk: 'pg-dl-hunk',
  meta: 'pg-dl-meta',
  ctx: '',
};

export interface CodeBlockProps {
  code: string;
  /** 围栏标签（可为别名，交给 `resolveLangId` 归一）。 */
  lang: string;
  /** 标题栏左侧文字；给了就覆盖语言名（工具结果用 toolName）。 */
  title?: string;
  /** 强制显示折叠开关（工具结果用；长块本来就会自动出现）。 */
  collapsible?: boolean;
  /** 长行是否折行。默认：有高亮的不折（保列对齐），纯文本折。 */
  wrap?: boolean;
}

export function CodeBlock({ code, lang, title, collapsible, wrap }: CodeBlockProps) {
  const preRef = useRef<HTMLPreElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const visibleRef = useRef(false);

  const resolution = resolveLangId(lang);
  const langId = resolution.kind === 'lang' ? resolution.id : null;
  const totalLines = countLines(code);
  const clamped = !showAll && totalLines > MAX_RENDER_LINES;
  const shown = useMemo(
    () => (clamped ? code.replace(/\n$/, '').split('\n').slice(0, MAX_RENDER_LINES).join('\n') : code),
    [clamped, code],
  );
  const doWrap = wrap ?? langId === null;

  // 长输出默认折叠：一屏装不下时先只给标题栏 + 行数，让用户决定要不要铺开。
  // 只判定一次 —— 后续由用户掌控，不能因为内容流式增长把用户已经展开的又折回去。
  const autoDecided = useRef(false);
  useEffect(() => {
    if (autoDecided.current) return;
    autoDecided.current = true;
    if (totalLines > AUTO_COLLAPSE_LINES) setCollapsed(true);
  }, [totalLines]);

  useEffect(() => {
    const el = preRef.current;
    if (!el || collapsed || !langId) return;
    let cancelled = false;

    const highlight = () => {
      const lines = shown.split('\n');
      const transformers: Transformers =
        langId === 'diff'
          ? [
              {
                line(node, line) {
                  const cls = DIFF_CLASS[diffLineKind(lines[line - 1] ?? '')];
                  if (!cls) return;
                  const prev = node.properties.class;
                  node.properties.class = `${typeof prev === 'string' && prev ? `${prev} ` : ''}${cls}`;
                },
              },
            ]
          : [];
      void loadLang(langId)
        .then(async (id) => {
          const hl = await getHighlighter();
          return hl.codeToHtml(shown, {
            lang: id,
            themes: { light: 'github-light', dark: 'github-dark' },
            defaultColor: false,
            transformers,
          });
        })
        .then((out) => {
          if (cancelled) return;
          setHtml(out);
          setFailed(false);
        })
        .catch((e: unknown) => {
          // 不吞异常：标记打到界面上，原因进控制台。
          if (cancelled) return;
          setHtml(null);
          setFailed(true);
          console.warn(`[piggy] 代码高亮失败 lang=${langId}：`, e);
        });
    };

    // 没有 IntersectionObserver（旧 WebKit、测试环境）时**当作已进入视口立即高亮**：
    // 少一层懒加载，好过整块 `<pre>` 直接抛异常白屏。
    if (typeof IntersectionObserver === 'undefined') {
      highlight();
      return () => {
        cancelled = true;
      };
    }

    const io = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) visibleRef.current = true;
      if (!visibleRef.current) return;
      io.disconnect();
      highlight();
    });
    io.observe(el);
    return () => {
      cancelled = true;
      io.disconnect();
    };
  }, [shown, langId, collapsed]);

  /**
   * 正文高度是否超过 CSS 上限 → 决定要不要给"显示更多"。
   *
   * **量的是 `<pre>` 不是外层 body**：限高和 `overflow:auto` 都长在 `pre` 上，
   * body 的 `scrollHeight == clientHeight` 恒成立，量 body 永远得到"没超高"，
   * 按钮一次都不会出现（第一版就是这么写的，真机探针抓到的）。
   *
   * 尺寸订阅走 `lib/resizeWatch`（**全应用共用一个 ResizeObserver**）：
   * 每个代码块各建一两个观察者的话，一次会话就是几百个观察者 ——
   * 每个都是"回调 → setState → 布局变"这条链上独立的一环（用户日志里的
   * `ResizeObserver loop` 警告就是这么来的）。观察者只负责"外部尺寸变了叫我"，
   * 内容变化由依赖项 `html` / `shown` / `collapsed` / `expanded` / `doWrap` 触发。
   */
  const measure = useCallback(() => {
    const pre = preRef.current;
    if (!pre) return;
    setOverflowing(pre.scrollHeight - pre.clientHeight > 4);
  }, []);
  useLayoutEffect(() => {
    const pre = preRef.current;
    if (!pre) return;
    measure();
    const unwatch = watchSize(pre, measure);
    const inner = pre.firstElementChild;
    const unwatchInner = inner ? watchSize(inner, measure) : () => {};
    return () => {
      unwatch();
      unwatchInner();
    };
  }, [measure, collapsed, html, expanded, doWrap]);

  const status =
    failed ? t('code.hlFailed') : resolution.kind === 'unknown' ? t('code.hlUnknown') : null;

  return (
    <div className="pg-codeblock" data-lang={langId ?? undefined} data-wrap={doWrap ? '1' : undefined}>
      {/* DSH CodeCard（docs/12 §3.3）：标题条 11px/18px、左侧语言、右侧 24x24 图标按钮 */}
      <div className="pg-codeblock-bar">
        <span className="pg-codeblock-lang" title={status ?? undefined}>
          {title || lang || t('code.fallbackTitle')}
          {totalLines > 0 ? <span className="pg-codeblock-lines">{tf('code.lines', { n: totalLines })}</span> : null}
          {status ? <span className="pg-codeblock-hlwarn">{status}</span> : null}
        </span>
        <span className="pg-codeblock-ops">
          {collapsible || totalLines >= 6 ? (
            <button
              className="pg-codeblock-btn"
              title={collapsed ? t('code.expand') : t('code.collapse')}
              aria-label={collapsed ? t('code.expand') : t('code.collapse')}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed((v) => !v)}
            >
              <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={14} />
            </button>
          ) : null}
          <button
            className="pg-codeblock-btn"
            title={t('code.copy')}
            aria-label={t('code.copy')}
            onClick={() => void navigator.clipboard.writeText(code)}
          >
            <Icon name="copy" size={14} />
          </button>
        </span>
      </div>
      <div
        ref={bodyRef}
        className="pg-codeblock-body"
        data-collapsed={collapsed ? '1' : undefined}
        data-expanded={expanded ? '1' : undefined}
      >
        <pre
          ref={preRef}
          className="pg-pre pg-codeblock-pre"
          dangerouslySetInnerHTML={html ? { __html: html } : undefined}
        >
          {html ? undefined : escapeHtml(shown)}
        </pre>
        {/* 高度超过上限时压底的"展开"：内容**始终全部在 DOM 里**（可 Ctrl+F、可选中、可复制），
            这里只是放开可视高度。绝不制造用户够不到的内容。 */}
        {overflowing ? (
          <button className="pg-codeblock-more" onClick={() => setExpanded((v) => !v)}>
            {expanded ? t('code.showLess') : t('code.showMore')}
          </button>
        ) : null}
        {/* 病态超长输出：显式截断 + 说清截了多少 + 一键放开，绝不静默截断 */}
        {clamped ? (
          <div className="pg-codeblock-trunc">
            <span>{tf('code.truncated', { n: MAX_RENDER_LINES, total: totalLines })}</span>
            <button className="pg-codeblock-trunc-btn" onClick={() => setShowAll(true)}>
              {t('code.showAll')}
            </button>
          </div>
        ) : null}
      </div>
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
