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
 * ## 流式（2026-09-24 起也渲染 markdown）
 *
 * 早先流式阶段是纯文本直写，理由是"中间态的 markdown 是非法文法，每个 delta 跑一遍
 * parser 必然抖动且浪费 CPU"。前半句对，后半句只对**全量** parse 成立 —— 现在走
 * {@link IncrementalMarkdownParser}（冻结前缀 + 只重解析尾部，键 = 绝对源偏移），
 * 解析量降到 1/10 量级，而且已经画好的块**连元素一起复用**，不会重挂。
 * 真正的抖动只剩尾部 1~2 块里"字面符号 → 成形"那一下，这是部分渲染的固有代价。
 * 转正那一次仍是整段 parse（引用式链接/脚注要靠它自愈），组件 `memo` 住
 * （文本不变就不重解析）。
 */
import { memo, useMemo, useState, type ReactNode } from 'react';
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

function blocks(
  tokens: Tokens.Generic[],
  keyPrefix: string,
  memoryKey: string | null,
  streaming = false,
): ReactNode[] {
  return tokens.map((t, i) => blockToken(t, `${keyPrefix}-${i}`, memoryKey, streaming));
}

function listItem(item: Tokens.ListItem, key: string, memoryKey: string | null, streaming = false): ReactNode {
  const checked = item.task ? item.checked : null;
  // 列表项里的**单个 text 段**不再包 <p>（行距才不会被撑开），多块结构照常
  const inner =
    item.tokens.length === 1 && item.tokens[0]!.type === 'text'
      ? nested(item.tokens[0] as Tokens.Generic, `${key}-p`)
      : blocks(item.tokens as Tokens.Generic[], key, memoryKey, streaming);
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

function blockToken(
  token: Tokens.Generic,
  key: string,
  memoryKey: string | null,
  streaming = false,
): ReactNode {
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
          {t.items.map((item, i) => listItem(item, `${key}-${i}`, memoryKey, streaming))}
        </Tag>
      );
    }
    case 'blockquote': {
      const t = token as Tokens.Blockquote;
      // 引用里可能只有一行文本，也可能是完整块
      const hasBlocks = t.tokens.some((x) => x.type !== 'paragraph' && x.type !== 'text');
      return (
        <blockquote key={key}>
          {hasBlocks ? blocks(t.tokens, key, memoryKey, streaming) : <p>{nested(t, key)}</p>}
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
      return (
        <CodeBlock
          key={key}
          code={t.text}
          lang={lang || 'text'}
          title={lang || undefined}
          // 流式中的围栏**不高亮**（内容每帧都在长，shiki 每帧重跑一遍纯属白烧 CPU；
          // 落定那一次会正常上色）。见 `CodeBlock` 的 `streaming`。
          streaming={streaming}
          // 同一个键在同一个位置永远算出同一个值（键 = 块的**绝对源偏移**，见 `lexSpans`），
          // 所以"卸载再挂载"能找回用户上一次的折叠状态（见 lib/rowMemory）
          memoryKey={memoryKey ? `${memoryKey}:${key}` : null}
        />
      );
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

/* ── 流式：冻结前缀 + 只重解析尾部 ──────────────────────────────────────── */

/**
 * 尾部留几个块**不冻结**：它们最可能被后文改写（一段话还在长、列表还在加项）。
 *
 * DSH 的 `UNSTABLE_TAIL_BLOCKS` 也是 2（`ui-primitives/src/markdown/incremental.ts`）：
 * 留 1 块时"上一块刚冻住就被改写"会偶发，留 3 块以上则每次重解析的尾巴更长、收益变小。
 */
const UNSTABLE_TAIL_BLOCKS = 2;

/** 一个 token 加上它在**源串里的绝对偏移**。 */
interface TokenSpan {
  token: Tokens.Generic;
  type: string;
  /** 起始偏移 = 前面所有 token 的 `raw` 长度之和 */
  start: number;
  end: number;
}

/**
 * 词法分析 + 绝对偏移。
 *
 * `marked` 的每个 token 都带 `raw`，且**累加严格等于源串长度**（实测：`sum(raw.length) ===
 * text.length`），所以偏移不用自己数行、也不会漂。键用它而不是用下标：块的**下标**
 * 会随前面的块合并/拆分而变，偏移不会 —— 这正是"已经画好的部分不重挂"的前提。
 *
 * @param text - 这一段的源串（增量解析时是**尾部**，不是整段）
 * @param base - 这段源串在整段消息里的起始偏移
 */
function lexSpans(text: string, base = 0): TokenSpan[] {
  const tokens = marked.lexer(text) as TokensList;
  let off = base;
  return (tokens as unknown as Tokens.Generic[]).map((token) => {
    const start = off;
    off += (token.raw ?? '').length;
    return { token, type: token.type, start, end: off };
  });
}

/** 空行不占渲染位置（`def` 也不产元素），算"块"的只有真正画出来的那些。 */
const isBlockToken = (s: TokenSpan): boolean => s.type !== 'space' && s.type !== 'def';

/**
 * 本帧可以**冻住**到哪个偏移（绝对）。
 *
 * 两条约束：
 *   ① 至少留下最后 {@link UNSTABLE_TAIL_BLOCKS} 个块继续重解析；
 *   ② 切点必须落在**空行之后**（或文末）—— 就地切开会让"跨块的块"变义：
 *      `标题\n---` 会被切成段落 + 分隔线、缩进代码会被切掉缩进、列表惰性续行会被切断。
 *      切在空行之后，尾部就一次性拿到了完整的块边界。
 *
 * 实测（`markdown.test.tsx` 的增量用例）：setext 标题 / 未闭合围栏 / 引用定义在后面 /
 * 列表惰性续行 / 缩进代码 / 表格混排六种构造逐字符流式 —— **冻结区 0 次变化、
 * 尾部解析与全量解析 0 次不一致**。
 */
function freezePoint(spans: TokenSpan[], prevCut: number): number {
  const blocks = spans.filter(isBlockToken);
  if (blocks.length <= UNSTABLE_TAIL_BLOCKS) return prevCut;
  const last = blocks[blocks.length - UNSTABLE_TAIL_BLOCKS - 1]!;
  const after = spans.find((s) => s.start === last.end);
  if (!after) return last.end; // 正好到文末
  return after.type === 'space' ? after.end : prevCut;
}

/** 一帧的渲染结果：可以整体复用的冻结块 + 每帧重建的尾巴。 */
interface IncrementalFrame {
  frozen: ReactNode[];
  tail: ReactNode[];
}

/**
 * 流式 markdown 的**增量解析器**（DSH `IncrementalMarkdownParser` 的同构实现）。
 *
 * ## 为什么需要它
 *
 * 流式正文此前是纯文本（`docs/04 §5.1` 的双阶段策略），理由是"中间态的 markdown 是非法
 * 文法，每帧全量 parse 会抖"。这条理由对**全量** parse 成立，对增量 parse 不成立：
 *
 * | | 5.8KB 全文 | 80 字符尾部 |
 * |---|---|---|
 * | `marked.lexer` | ≈541 µs/次 | ≈11 µs/次 |
 *
 * 而"抖"的真正来源不是解析，是**重挂**：如果每帧都把整棵树重新建一遍，已经画好的标题、
 * 表格、代码块会跟着重建，用户看到上面在闪。所以冻结的不只是"解析结果"，还有**元素本身**
 * （`frozen` 数组里存的是上一帧就渲染好的 React 元素，引用不变 → React 直接跳过那棵子树）。
 *
 * ## 代价（写清楚，别当 bug）
 *
 * · 尾部 1~2 块里会看到"字面符号 → 成形"的跳变：半截的 `**加粗`、没闭合的表格会先按
 *   字面显示，补齐后变成粗体/表格（DSH 也一样，它只是把不稳定区压到 2 块）；
 * · 引用式链接 / 脚注在流式期间是字面（定义还没到），**落定时全量重解析会自愈**
 *   （`Markdown` 走的是整段 lexer，见它的注释）。
 */
export class IncrementalMarkdownParser {
  private source = '';
  private memoryKey: string | null = null;
  private cut = 0;
  private frozen: ReactNode[] = [];

  /**
   * 推进一步。
   *
   * @param text - 这一帧的**完整**正文（累积值，不是 delta）
   * @param memoryKey - 围栏折叠态的记忆前缀（换行身份时要重置缓存）
   * @returns 冻结块（可整体复用）与尾巴（每帧重建）
   */
  render(text: string, memoryKey: string | null): IncrementalFrame {
    // 非追加输入（换页/换窗/编辑）或换了行身份：整个丢掉重来。
    // `startsWith` 是**memcmp**，比重新解析便宜好几个数量级 —— 值得每帧做一次。
    if (memoryKey !== this.memoryKey || this.cut > text.length || !text.startsWith(this.source)) {
      this.frozen = [];
      this.cut = 0;
      this.memoryKey = memoryKey;
    }
    this.source = text;
    let spans: TokenSpan[];
    try {
      spans = lexSpans(text.slice(this.cut), this.cut);
    } catch {
      // 畸形 markdown：这一帧退回纯文本（与 `Markdown` 的兜底同一口径：绝不白屏）
      return { frozen: this.frozen, tail: [<p key="md-fallback">{text.slice(this.cut)}</p>] };
    }
    const nextCut = freezePoint(spans, this.cut);
    // 只有**新**冻住的那几块需要渲染一次；之后它们永远复用这一份元素
    for (const span of spans) {
      if (span.end > nextCut) break;
      this.frozen.push(blockToken(span.token, `md-${span.start}`, this.memoryKey, false));
    }
    this.cut = nextCut;
    const tail = spans
      .filter((s) => s.start >= this.cut)
      .map((s) => blockToken(s.token, `md-${s.start}`, this.memoryKey, true));
    return { frozen: this.frozen, tail };
  }
}

/**
 * 流式正文的 markdown 渲染（`docs/04 §5.1`）。
 *
 * 与 {@link Markdown} 的差别只有一个：文本还在长，所以走增量解析
 * （冻结前缀按绝对偏移复用元素，只有尾部每帧重建）。
 * 造型（class / 块级元素 / 代码卡片）与落定之后**完全一致** —— 转正那一刻只是把
 * "流式那份"换成"整段 parse 的那份"，视觉上不该有跳变。
 *
 * @param props.text - 累积正文（每帧都在变）
 * @param props.memoryKey - 围栏折叠态记忆前缀（同 `Markdown`）
 */
export const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  memoryKey = null,
}: {
  text: string;
  memoryKey?: string | null;
}) {
  /* 解析器住在 ref 里：它是**渲染缓存**（冻结块 + 元素），不是状态。
     重复调用是幂等的（同样的 text 再来一次不会重复冻结），所以 StrictMode 的双渲染安全。 */
  const [parser] = useState(() => new IncrementalMarkdownParser());
  const { frozen, tail } = parser.render(text, memoryKey);
  /* ⚠️ 必须拼成**一个数组**再交给 React。
     写成 `{frozen}{tail}`（两个数组兄弟）会让 React 按"第几个数组"给隐式键加前缀：
     同一个块从尾部挪进冻结区时，键从 `.1:md-8` 变成 `.0:md-8` —— 在 React 眼里是
     两个不同的键，于是**卸载重建**（实测：标题在冻结那一帧闪掉）。
     拼成一个数组后键只有一套，块的"转正"就是一次普通的 reconcile。 */
  const children = frozen.length === 0 ? tail : [...frozen, ...tail];
  return <div className="pg-md pg-md-streaming">{children}</div>;
});

/**
 * Markdown 渲染组件。
 *
 * @param props.text - markdown 原文（转正后的稳定文本）
 * @param props.compact - 紧凑变体（思考正文用：13px/20px、块间距减半）
 * @param props.memoryKey - 围栏代码块的折叠态记忆前缀（`lib/rowMemory`；缺省不记忆）
 */
export const Markdown = memo(function Markdown({
  text,
  compact = false,
  memoryKey = null,
}: {
  text: string;
  compact?: boolean;
  memoryKey?: string | null;
}) {
  const nodes = useMemo(() => {
    try {
      // 键用**绝对源偏移**（不是下标）：与流式那一份同口径，
      // 于是"流式中折叠过的代码块"在转正之后还记得（`lib/rowMemory` 的键跟着一致）。
      const spans = lexSpans(text);
      return spans.map((s) => blockToken(s.token, `md-${s.start}`, memoryKey));
    } catch {
      // 解析失败（畸形 markdown）**不能白屏**：退回纯文本
      return [<p key="fallback">{text}</p>];
    }
  }, [text, memoryKey]);
  return <div className={`pg-md${compact ? ' pg-md-compact' : ''}`}>{nodes}</div>;
});
