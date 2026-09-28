/**
 * 预览滚动条的回合数据（docs/04 §2.6）。
 *
 * ## 为什么要"回合"而不是"消息"
 *
 * 滚动条上一条刻度 = 一轮对话（用户提问 + 它的回答），这也是 DSH 的粒度
 * （`TurnNavigator` 的 `TurnRailItem`）。按消息画刻度的话，一次工具密集的回答会画出
 * 几十条刻度，梯子立刻失去形状；按回合画，"我在这段会话的哪一轮"一眼就能看出来。
 *
 * ## 为什么这里能覆盖**整段历史**
 *
 * Piggy 打开会话时一次性把全部消息灌进 `messagesStore`（`hydrate`），没有分页/折叠，
 * 所以从 store 里就能算出**从头到尾**每一轮——不需要 DSH 那套"宿主侧 turn outline
 * 投影 + 未加载锚点"（它们是为了支持历史分页：刻度的 anchor 分 loaded/unloaded 两种，
 * 点未加载的刻度要先翻页）。等 Piggy 哪天做了"加载更早"，这里要跟着加 anchor 概念。
 *
 * 纯函数 + 单独成文件：刻度数量、截断、分组规则都值得单测，而组件测试里
 * 造 2000 条消息太慢。
 */

/** 一条刻度（一个回合）。 */
export interface RailItem {
  /** 第几轮，从 1 开始（给无障碍标签与预览标题用） */
  turn: number;
  /** 这一轮在转录里的**行下标**（用户消息那一行）——跳转要用它 */
  rowIndex: number;
  /** 用户消息（预览框标题），已压成一行并截断 */
  prompt: string;
  /** 回答的正文摘要（预览框正文），已压成一行并截断；没有则空串 */
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

function finish(
  cur: { rowIndex: number; prompt: string; response: string[] },
  turn: number,
): RailItem {
  return {
    turn,
    rowIndex: cur.rowIndex,
    prompt: condense(cur.prompt, PROMPT_MAX),
    response: condense(cur.response.join(' '), RESPONSE_MAX),
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
  if (atBottom) return items[items.length - 1]!.turn;
  let active: number | null = null;
  for (const it of items) {
    if (it.rowIndex <= readingRowIndex) active = it.turn;
    else break;
  }
  return active ?? items[0]!.turn;
}
