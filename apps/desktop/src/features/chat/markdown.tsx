/**
 * Markdown 渲染（助手正文 / 思考正文 / 压缩摘要）。
 *
 * ## 为什么需要它
 *
 * 用户 2026-09-23 的截图：助手回答里的 `## 🔴 严重缺陷`、`**默认配置受影响**`、`---`
 * **原样显示**成了一串井号和星号。核实：`MessageView` 的 text 分支此前只做了
 * `splitFences()`（围栏 → 代码卡片），**其余一律当纯文本**——
 * docs/04 §5 早就写了"Markdown 只在转正时解析一次"，但那个 parser 一直没落地。
 *
 * ## 用 marked，但**只当 parser 用**（关键设计）
 *
 * marked 的默认用法是 `marked.parse()` 产出 **HTML 字符串**、再 `innerHTML` 塞进 DOM；
 * 它自己 README 的第一条警告就是"**Marked does not sanitize the output HTML**，
 * 请用 DOMPurify"（`marked/README.md:54`）。那条路要额外引一个 sanitizer、
 * 多一条 `innerHTML` 信任边界，而且**我们自己的代码卡片与外链处理都接不上**
 * （HTML 串里挂不了 onClick，只能事件委托；围栏也没法直接换成 `CodeBlock`）。
 *
 * 所以这里走 **`marked.lexer()` → token 树 → React 元素**：拿 marked 的语法覆盖与速度，
 * **不产生任何 HTML 字符串**（全仓没有 `dangerouslySetInnerHTML`），于是：
 *
 * 1. **原始 HTML 一个字节都不进 DOM**：`html` token 按纯文本渲染；
 * 2. **URL 白名单**：链接只认 `http:` / `https:` / `mailto:`，图片只认 `http:` / `https:`；
 *    其余降级成纯文本（连地址一起显示，用户还能复制）；
 * 3. **链接点击走宿主命令** `open_external_url`（Rust 侧再校验一次 scheme），
 *    不导航 webview —— 见 `lib/externalLink.ts`；
 * 4. 围栏代码块直接交给**我们自己那块代码卡片**（shiki 按需高亮 / 折叠 / 复制 / 行数）。
 *
 * 语法覆盖走 marked 的 **GFM**（表格 / 任务列表 / 删除线 / autolink 全开），
 * 与 DSH 的渲染面一致（DSH 用 micromark+mdast，那是它的实现选择；
 * Piggy 这边按"marked 足够 + 依赖少"取舍）。
 *
 * ## 流式（不改）
 *
 * 流式阶段仍是纯文本直写（docs/04 §5：流式中间态的 markdown 是非法文法，
 * 每个 delta 跑一遍 parser 必然抖动且浪费 CPU）。转正时这一次 parse 就是全部成本，
 * 组件 `memo` 住（文本不变就不重解析）。
 */
import { memo, useMemo, type ReactNode } from 'react';
import { marked, type Tokens, type TokensList } from 'marked';
import { CodeBlock } from './CodeBlock';
import { openExternalUrl } from '@/lib/externalLink';

/** 链接允许的 scheme（白名单，不是黑名单）。 */
const LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
/** 图片允许的 scheme（比链接更窄：不允许 mailto）。 */
const IMAGE_SCHEMES = new Set(['http:', 'https:']);

/**
 * 解析并校验 URL。
 *
 * @param url - markdown 里的原始目标
 * @param schemes - 允许的 scheme 集合
 * @returns 通过校验的 URL；不通过返回 `null`（调用方降级成纯文本）
 */
export function safeUrl(url: string, schemes: ReadonlySet<string> = LINK_SCHEMES): string | null {
  const raw = (url ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    return schemes.has(parsed.protocol) ? parsed.toString() : null;
  } catch {
    // 相对路径 / 锚点 / 畸形 URL：桌面应用里没有"当前页"可跳，一律降级
    return null;
  }
}

/* ── 行内 ─────────────────────────────────────────────────────────────── */

/** 行内 token 序列 → React 节点。 */
function inline(tokens: Tokens.Generic[] | undefined, keyPrefix: string): ReactNode[] {
  return (tokens ?? []).map((t, i) => inlineToken(t, `${keyPrefix}-${i}`));
}

/** marked 的 token 只要有 `tokens` 就还能往下钻（text/strong/em/link… 都可能带）。 */
function nested(token: Tokens.Generic, key: string): ReactNode[] {
  return inline(token.tokens, key);
}

function inlineToken(token: Tokens.Generic, key: string): ReactNode {
  switch (token.type) {
    case 'text': {
      const t = token as Tokens.Text;
      // text 里可能有嵌套（GFM autolink、内联强调…）
      return t.tokens ? <span key={key}>{nested(t, key)}</span> : <span key={key}>{t.text}</span>;
    }
    case 'escape':
      return <span key={key}>{(token as Tokens.Escape).text}</span>;
    case 'strong':
      return <strong key={key}>{nested(token, key)}</strong>;
    case 'em':
      return <em key={key}>{nested(token, key)}</em>;
    case 'del':
      return <del key={key}>{nested(token, key)}</del>;
    case 'codespan':
      return (
        <code key={key} className="pg-md-code">
          {(token as Tokens.Codespan).text}
        </code>
      );
    case 'br':
      return <br key={key} />;
    case 'link': {
      const t = token as Tokens.Link;
      const href = safeUrl(t.href);
      const label = nested(t, key);
      if (!href) {
        // 不在白名单：**降级成纯文本**（连地址一起显示，用户还能自己复制）
        return (
          <span key={key} className="pg-md-unsafe" title={`不打开的链接：${t.href}`}>
            {label}
            <span className="pg-md-unsafe-url"> ({t.href})</span>
          </span>
        );
      }
      return (
        <a
          key={key}
          className="pg-md-link"
          href={href}
          title={t.title ?? href}
          onClick={(e) => {
            // 不导航 webview：交宿主用系统浏览器打开（Rust 侧再校验 scheme）
            e.preventDefault();
            void openExternalUrl(href);
          }}
        >
          {label}
        </a>
      );
    }
    case 'image': {
      const t = token as Tokens.Image;
      const src = safeUrl(t.href, IMAGE_SCHEMES);
      if (!src) {
        // 图片不在白名单：显示替代文本，不制造破图
        return (
          <span key={key} className="pg-md-unsafe">
            [图片：{t.text || t.href}]
          </span>
        );
      }
      return <img key={key} className="pg-md-img" src={src} alt={t.text ?? ''} title={t.title ?? undefined} />;
    }
    case 'html':
      // 原始 HTML 按**纯文本**渲染（绝不让它进 DOM）
      return (
        <span key={key} className="pg-md-html">
          {(token as Tokens.HTML).text}
        </span>
      );
    default:
      // 没映射的行内 token：把原文拿出来（宁可少样式，不要丢内容）
      return <span key={key}>{token.raw ?? ''}</span>;
  }
}

/* ── 块 ──────────────────────────────────────────────────────────────── */

function blocks(tokens: Tokens.Generic[], keyPrefix: string): ReactNode[] {
  return tokens.map((t, i) => blockToken(t, `${keyPrefix}-${i}`));
}

function listItem(item: Tokens.ListItem, key: string): ReactNode {
  const checked = item.task ? item.checked : null;
  // 列表项里的**单个 text 段**不再包 <p>（行距才不会被撑开），多块结构照常
  const inner =
    item.tokens.length === 1 && item.tokens[0]!.type === 'text'
      ? nested(item.tokens[0] as Tokens.Generic, `${key}-p`)
      : blocks(item.tokens as Tokens.Generic[], key);
  return (
    <li key={key} className={item.task ? 'pg-md-task' : undefined}>
      {checked == null ? null : (
        <input
          type="checkbox"
          checked={checked}
          readOnly
          tabIndex={-1}
          aria-label={checked ? '已完成' : '未完成'}
        />
      )}
      {inner}
    </li>
  );
}

function blockToken(token: Tokens.Generic, key: string): ReactNode {
  switch (token.type) {
    case 'space':
    case 'def':
      // 空行与链接定义：不产生元素（定义已经被 marked 解析进各自的 link token）
      return null;
    case 'paragraph':
      return <p key={key}>{nested(token, key)}</p>;
    case 'heading': {
      const t = token as Tokens.Heading;
      const Tag = (`h${Math.min(6, Math.max(1, t.depth))}` as unknown) as 'h1';
      return <Tag key={key}>{nested(t, key)}</Tag>;
    }
    case 'list': {
      const t = token as Tokens.List;
      const Tag = t.ordered ? 'ol' : 'ul';
      return (
        <Tag
          key={key}
          start={t.ordered && t.start !== '' && Number(t.start) !== 1 ? Number(t.start) : undefined}
        >
          {t.items.map((item, i) => listItem(item, `${key}-${i}`))}
        </Tag>
      );
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      // 引用里可能只有一行文本，也可能是完整块
      const hasBlocks = t.tokens.some((x) => x.type !== 'paragraph' && x.type !== 'text');
      return (
        <blockquote key={key}>
          {hasBlocks ? blocks(t.tokens, key) : <p>{nested(t, key)}</p>}
        </blockquote>
      );
    }
    case 'hr':
      return <hr key={key} />;
    case 'code': {
      // 围栏代码块 → 与对话里同一块代码卡片（shiki 按需高亮 / 折叠 / 复制 / 行数）
      const t = token as Tokens.Code;
      const lang = (t.lang ?? '').trim();
      // 没有语言标签的围栏走 `text`（纯文本、不报"未收录此语言"）
      return <CodeBlock key={key} code={t.text} lang={lang || 'text'} title={lang || undefined} />;
    }
    case 'table': {
      const t = token as Tokens.Table;
      const align = (i: number): { textAlign?: 'left' | 'center' | 'right' } =>
        t.align[i] ? { textAlign: t.align[i]! } : {};
      return (
        <div key={key} className="pg-md-tablewrap">
          <table>
            <thead>
              <tr>
                {t.header.map((cell, i) => (
                  <th key={i} style={align(i)}>
                    {inline(cell.tokens, `${key}-h-${i}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {t.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, i) => (
                    <td key={i} style={align(i)}>
                      {inline(cell.tokens, `${key}-${r}-${i}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'html':
      return (
        <p key={key} className="pg-md-html">
          {(token as Tokens.HTML).text}
        </p>
      );
    default:
      return (
        <p key={key} className="pg-md-unknown">
          {token.raw ?? ''}
        </p>
      );
  }
}

/** marked 的默认就够：GFM 全开（表格/任务列表/删除线/autolink）、不换行、同步。 */
marked.use({ gfm: true, breaks: false, async: false });

/**
 * Markdown 渲染组件。
 *
 * @param props.text - markdown 原文（转正后的稳定文本）
 * @param props.compact - 紧凑变体（思考正文用：13px/20px、块间距减半）
 */
export const Markdown = memo(function Markdown({ text, compact = false }: { text: string; compact?: boolean }) {
  const nodes = useMemo(() => {
    try {
      const tokens = marked.lexer(text) as TokensList;
      return blocks(tokens as unknown as Tokens.Generic[], 'md');
    } catch {
      // 解析失败（畸形 markdown）**不能白屏**：退回纯文本，与流式阶段一致
      return [<p key="fallback">{text}</p>];
    }
  }, [text]);
  return <div className={`pg-md${compact ? ' pg-md-compact' : ''}`}>{nodes}</div>;
});
