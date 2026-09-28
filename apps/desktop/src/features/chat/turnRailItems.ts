/**
 * 预览滚动条的回合数据（docs/04 §2.6）。
 *
 * ## 为什么要"回合"而不是"消息"
 *
 * 滚动条上一条刻度 = 一轮对话（用户提问 + 它的回答），这也是 DSH 的粒度
 * （`TurnNavigator` 的 `TurnRailItem`）。按消息画刻度的话，一次工具密集的回答会画出
 * 几十条刻度，梯子立刻失去形状；按回合画，"我在这段会话的哪一轮"一眼就能看出来。
 *
 * ## 刻度覆盖**整段会话**，内容只载入一部分（2026-09-23 按用户反馈修正）
 *
 * 转录是分页的（03 §2.19）：打开只读会话文件尾部一页。但刻度梯**不能**跟着只画
 * 已载入那一段——那样长会话的梯子就丢了整体形状（用户原话："预览滚动条好像不是
 * 全部的预览，变成最高一条线是虚线"）。
 *
 * 现在与 DSH 的 `mergeTurnRailItems` 同构：
 *   · **轮廓**（`session_outline`，一次扫描整个会话）给出**全部轮次**的锚点与预览文字；
 *   · **已载入的行**覆盖同名轮次，锚点从"未载入"变成"已载入"（带转录行下标）；
 *   · 未载入的刻度点下去会**先把历史翻页进来**再落位（DSH 的 `anchor.kind === 'unloaded'`
 *     分支：`pauseFollowing()` → 请求页 → 落地）。
 *
 * 于是"预览全部 / 展示部分"同时成立，而且不需要把没看过的内容读进内存。
 */

/** 一条刻度（一个回合）。 */
export interface RailItem {
  /** 第几轮，从 1 开始。**全会话的绝对编号**（轮廓给的，不随分页窗口漂） */
  turn: number;
  /**
   * 这一轮在转录里的**行下标**（用户消息那一行）——跳转要用它。
   * `null` = 这一轮还没载入（锚点在文件里，见 {@link RailItem.anchorEnd}）。
   */
  rowIndex: number | null;
  /** 未载入时的跳转游标：用户那条消息的**结束**字节偏移（`before = anchorEnd` 正好取到这一轮） */
  anchorEnd: number | null;
  /** 未载入时的起点偏移（用来判断"翻到它了没有"） */
  anchorStart: number | null;
  /** 用户消息（预览框标题），已压成一行并截断 */
  prompt: string;
  /** 回答的正文摘要（预览框正文），已压成一行并截断；没有则空串 */
  response: string;
  /** 这一轮是否已经在转录里（未载入的刻度画成虚线、点它要先翻页） */
  loaded: boolean;
}

/** 会话文件里的轮次轮廓（Rust `transcript::Outline` 的 `turns`）。 */
export interface OutlineTurn {
  turn: number;
  start: number;
  end: number;
  prompt: string;
  response: string;
}

/** 预览里用户消息最长多少个字（超出截断；预览框只显示 1 行）。 */
export const PROMPT_MAX = 80;
/** 预览里回答摘要最长多少个字（预览框显示 3 行）。 */
export const RESPONSE_MAX = 160;

/** 压成一行并截断：预览框是 fixed 高度的，换行会把它顶开。 */
export function condense(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/** 提取一条消息的纯文本（与 Transcript 的行渲染口径一致：只取 text 块）。 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const block of content) {
    const b = block as { type?: string; text?: string } | null;
    if (b?.type === 'text' && typeof b.text === 'string') {
      if (out) out += '\n';
      out += b.text;
    }
  }
  return out;
}

/** `messagesStore` 里一行的形状（只取这里要用的字段）。 */
export interface RailSourceRow {
  role: string;
  content: unknown;
  /** 这一行在会话文件里的起始字节偏移（实时 append 的行没有 → `null`） */
  offset?: number | null;
}

/**
 * 把转录的行序列切成回合。
 *
 * 规则（与 DSH 同义）：**每个 user 行开启新的一轮**，其后到下一个 user 行之间的
 * assistant 文本都属于这一轮。开头若不是 user（恢复出来的半截会话），那些行归入
 * "第 0 轮"——没有用户提问的轮次不该凭空造一条刻度，所以直接跳过（`turn` 从 1 起）。
 */
export function buildRailItems(rows: readonly RailSourceRow[]): RailItem[] {
  const items: RailItem[] = [];
  let current: { rowIndex: number; prompt: string; response: string[] } | null = null;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    if (row.role === 'user') {
      if (current) items.push(finish(current, items.length + 1));
      current = { rowIndex: i, prompt: messageText(row.content), response: [] };
      continue;
    }
    if (row.role === 'assistant' && current) {
      const text = messageText(row.content);
      if (text.trim()) current.response.push(text);
    }
  }
  if (current) items.push(finish(current, items.length + 1));
  return items;
}

/**
 * 轮廓（整段会话）+ 已载入的行 → 刻度列表。
 *
 * @param outline - 会话文件的轮次轮廓；`null`/空 = 没有轮廓，退回"只画已载入的"
 * @param rows - 已载入的转录行
 * @returns 按轮次升序的刻度（未载入的在前，已载入的随后，实时新增的排最后）
 */
export function mergeRailItems(
  outline: readonly OutlineTurn[] | null | undefined,
  rows: readonly RailSourceRow[],
): RailItem[] {
  const loaded = buildRailItems(rows);
  if (!outline || outline.length === 0) return loaded;
  // 有行、却没有一行带偏移 = 转录不是从文件分页来的（退回 `get_messages` 的兜底路径、
  // 或会话还没落盘）。此时轮廓对不上任何一行，用它只会把已载入的轮次也画成虚线 —— 老实用行算。
  // 注意**空行集不算**：轮廓先到、尾页还没到时，就该先画出整条梯子（全是未载入刻度）。
  if (rows.length > 0 && !rows.some((r) => typeof r.offset === 'number')) return loaded;

  const rowByOffset = new Map<number, number>(); // 起始偏移 → 行下标
  rows.forEach((row, i) => {
    if (row.role === 'user' && typeof row.offset === 'number') rowByOffset.set(row.offset, i);
  });

  const covered = new Set<number>();
  const items: RailItem[] = outline.map((t) => {
    const rowIndex = rowByOffset.get(t.start);
    if (rowIndex !== undefined) covered.add(rowIndex);
    return {
      turn: t.turn,
      rowIndex: rowIndex ?? null,
      anchorStart: rowIndex === undefined ? t.start : null,
      anchorEnd: rowIndex === undefined ? t.end : null,
      prompt: condense(t.prompt, PROMPT_MAX),
      response: condense(t.response, RESPONSE_MAX),
      loaded: rowIndex !== undefined,
    };
  });

  // 轮廓不知道的轮次（实时对话刚提交的、或轮廓取回之后才写进文件的）接在最后，
  // 编号从轮廓末尾继续——它们必然比轮廓里的任何一轮都新。
  let next = items.length;
  for (const item of loaded) {
    const rowIndex = item.rowIndex;
    if (rowIndex === null || covered.has(rowIndex)) continue;
    next += 1;
    items.push({ ...item, turn: next });
  }
  return items;
}

/** 在已载入的行里按偏移找行下标（跳转落位用）。 */
export function findRowIndexByOffset(rows: readonly RailSourceRow[], offset: number): number | null {
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]?.role === 'user' && rows[i]?.offset === offset) return i;
  }
  return null;
}

function finish(
  cur: { rowIndex: number; prompt: string; response: string[] },
  turn: number,
): RailItem {
  return {
    turn,
    rowIndex: cur.rowIndex,
    anchorStart: null,
    anchorEnd: null,
    prompt: condense(cur.prompt, PROMPT_MAX),
    response: condense(cur.response.join(' '), RESPONSE_MAX),
    loaded: true,
  };
}

/**
 * 当前激活的回合：取**阅读线**（视口顶部往下一点）所在的那一轮。
 *
 * 为什么不用"视口正中"：转录里一轮可能很长（一个回答占几屏），用正中会让刻度
 * 在滚动时乱跳；贴着顶部的阅读线更符合"我现在读到哪一轮"的直觉。
 * 滚到底部时直接取最后一轮（DSH 的 followingTail 同义）——否则底部那轮的
 * 刻度要到滚进阅读线才亮，而用户明明已经在看它了。
 *
 * 未载入的刻度没有行下标，不参与判定（它们都在已载入窗口之上）。
 *
 * @param items 刻度列表（按 turn 升序，rowIndex 也升序）
 * @param readingRowIndex 阅读线所在的行下标（由虚拟化器算出）
 * @param atBottom 是否已滚到底（含阈值）
 */
export function activeTurnOf(
  items: readonly RailItem[],
  readingRowIndex: number,
  atBottom: boolean,
): number | null {
  if (items.length === 0) return null;
  if (atBottom) {
    // "到底了"说的是**已载入窗口**的底，不是整段会话的底：
    // 换窗到中间时窗口下面还有更新的（未载入）轮次，取最后一条刻度会把高亮丢到没载入的地方。
    const lastLoaded = [...items].reverse().find((it) => it.loaded);
    return lastLoaded?.turn ?? items[0]!.turn;
  }
  let active: number | null = null;
  for (const it of items) {
    if (it.rowIndex === null) continue;
    if (it.rowIndex <= readingRowIndex) active = it.turn;
    else break;
  }
  return active ?? items.find((it) => it.loaded)?.turn ?? items[0]!.turn;
}
