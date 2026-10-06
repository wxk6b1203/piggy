/**
 * **回合级过程折叠**（DSH `TurnProcessNodeView`，docs/04 §2.1.6）。
 *
 * ## 为什么要有它
 *
 * 现在只有**行级**折叠（工具行 24px、思考行 24px）。一轮里几十次工具调用时，
 * 屏幕上仍是一堵墙：`思考 · 我先读一下…` / `运行命令 · pnpm test` / `思考 · 现在改…` …
 * 真正要读的只有最后那段回答。DSH 把整段"过程"再折成**一行 33px**：
 * `已完成工作 · 用时 12s`（或 `已停止` / `处理失败`），回答留在外面。
 *
 * ## 折叠的边界怎么定（本仓的口径）
 *
 * 一轮 = 一条 `user` 行 + 它之后到**下一条 user 行之前**的所有行。
 * 段内分三类：
 *
 * | 类别 | 判据 | 折叠行为 |
 * |---|---|---|
 * | **打开输入** | 第一条 user 行 | 永不折（它是这一轮的问句） |
 * | **过程** | 思考/工具/中间助手消息（带工具调用、或不是最后一条回答的助手行） | 折进那一行 |
 * | **最终回答** | 段内**最后一条**有可见正文、且不带工具调用的助手行 | 永不折 |
 *
 * 不折的三种情况（DSH 的 `turnProcessAlwaysOpen` 同义）：
 *   1. **正在跑的那一轮**（段内有 `live` 行）—— 用户正看着它长；
 *   2. **中止 / 失败**的回合 —— 过程是排查现场，折起来等于藏证据；
 *   3. 段内**没有过程**（只有一问一答）—— 没有可折的东西，连标题都不画；
 *   4. 段内挂着**还没回答的提问卡**（`pendingQuestion`）—— pi 正阻塞在工具调用里，
 *      既没有流式行也没有 `streaming`，按 ①② 判会误当成"已结束"，于是把用户要回答的卡
 *      一起折起来（截图实测抓到）。"等回答"与"正在跑"同样不许折。
 *
 * ## 四档密度只改"默认开合"与"折叠行长什么样"
 *
 * 判定规则本身与档位无关（档位变化不改成员、不改用户手动开过的那些），
 * 只有 `compact`/`standard` 默认折、`detailed` 默认不折但保留标题行、`verbose` 连标题行都不画。

 * ⚠️ 与 DSH 的**有意映射差异**：DSH 的四档里有很大一部分差异落在"二级分组"
 * （一个回合内部的 process group）上，而 Piggy 没有二级分组这一层。若照字面搬，
 * `detailed` 在 Piggy 里会与 `standard` **完全一样**（它的差异项 Piggy 一个都没有），
 * 四档里有两档分不出来。所以这里按"可见度单调递增"重排：历史回合在 `compact`/`standard`
 * 折、在 `detailed` 摊开（保留标题行）、在 `verbose` 连标题行都不画 ——
 * 两端（最省版面 ↔ 全可见）与 DSH 一致，中间两档在 Piggy 里各有着落。
 *
 * 这一层是**纯函数**：输入行数组，输出"每段怎么折"，好单测也好在虚拟化里按下标消费。
 */
import type { AgentMessage } from '@piggy/pi-protocol';

/** 折叠判读要用到的那几行信息（从 store 的行里摘出来，保持纯函数）。 */
export interface FoldRowInput {
  id: string;
  role: string;
  /** 流式中的行（`live` 槽位非空） */
  live: boolean;
  /** 中断落地的行（`interrupted` 标记） */
  interrupted: boolean;
  /** 助手行的结构化终态（`stopReason` / `errorMessage`） */
  failure: 'error' | 'aborted' | null;
  /** 助手行里有没有工具调用块 */
  hasToolCall: boolean;
  /** 助手行里有没有可见正文（text 块非空） */
  hasText: boolean;
  /** 时间戳（算"用时"用；缺省 null） */
  timestamp: number | null;
  /**
   * 这一行上挂着**还没回答的提问**（`ask_user_question` / `exit_plan_mode` 的卡片）。
   *
   * 为什么要单独标出来：等用户回答的那一轮，pi 正阻塞在工具调用里 —— 没有流式行、
   * `streaming` 也是 false，按"有流式行才算没结束"的判据它会被当成**已结束**，
   * 于是整段过程连同那张卡一起被折起来：**用户根本看不到要回答什么**（截图实测抓到）。
   * 所以"等用户回答"必须与"正在跑"一样对待：过程全展开、不折。
   */
  pendingQuestion?: boolean;
}

export type TurnStatus = 'done' | 'aborted' | 'failed';

/** 一段（一轮）的折叠判读结果。 */
export interface TurnFold {
  /** 第几轮（从 0 起，按对话顺序） */
  turn: number;
  /** 段内第一行的下标（user 行） */
  start: number;
  /** 段内最后一行的下标（含） */
  end: number;
  /** 要折起来的那些行的下标（连续区间以外的也支持：见 steered 场景） */
  processIndexes: number[];
  /** 段内最终回答那一行的下标（不折）；没有就是 null */
  answerIndex: number | null;
  /** 这一轮的状态（折叠行的标题与配色用它） */
  status: TurnStatus;
  /** 用时（毫秒）；算不出来就是 null（不编数字） */
  durationMs: number | null;
  /** 折叠行的落点：过程的第一行（虚拟化里它就是"这一段的头"） */
  headIndex: number;
  /**
   * 这一轮**结束了吗**（段内没有流式行，且不是"正在跑的最后一段"）。
   * 没结束的回合过程全展开、不画折叠行 —— 用户正看着它长。
   */
  closed: boolean;
  /** 可折吗（结束 + 有过程 + 状态正常） */
  foldable: boolean;
  /**
   * 画不画那一行标题（DSH：`A Turn control exists, but there is no process content |
   * Retain its title, without a collapse action` —— 标题还兼着"这一轮到此结束"的作用）。
   * `verbose` 档由渲染方决定不画。
   */
  showHeader: boolean;
  /** 原因（测试与门禁断言用；`foldable` 为真时是 `null`） */
  reason: 'running' | 'pending-question' | 'settled-failure' | 'no-process' | null;
}

/** 从消息里摘出折叠判读需要的字段（store 的 `MessageView` 也满足这个形状）。 */
export function foldRowInput(
  row: {
    id: string;
    role: string;
    live?: unknown;
    interrupted?: boolean;
    message: AgentMessage;
  },
  pendingQuestions?: ReadonlySet<string> | null,
): FoldRowInput {
  const m = row.message as {
    role?: string;
    content?: unknown;
    stopReason?: string;
    errorMessage?: unknown;
    timestamp?: number;
  };
  const blocks = Array.isArray(m.content) ? m.content : [];
  let hasToolCall = false;
  let hasText = false;
  let pendingQuestion = false;
  for (const b of blocks) {
    const blk = b as { type?: string; text?: unknown; id?: unknown };
    if (blk?.type === 'toolCall') {
      hasToolCall = true;
      if (blk.id !== undefined && pendingQuestions?.has(String(blk.id)) === true) pendingQuestion = true;
    } else if (blk?.type === 'text' && typeof blk.text === 'string' && blk.text.trim() !== '') {
      hasText = true;
    }
  }
  const aborted = m.stopReason === 'aborted';
  const errored = m.stopReason === 'error' || (typeof m.errorMessage === 'string' && m.errorMessage !== '');
  return {
    id: row.id,
    role: row.role,
    live: row.live !== undefined && row.live !== null,
    interrupted: row.interrupted === true,
    failure: row.interrupted ? 'aborted' : aborted ? 'aborted' : errored ? 'error' : null,
    hasToolCall,
    hasText,
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : null,
    ...(pendingQuestion ? { pendingQuestion: true } : {}),
  };
}

/** 这一行算"过程"吗（思考 / 工具 / 中间助手消息）。 */
function isProcess(row: FoldRowInput, isAnswer: boolean): boolean {
  if (row.role === 'assistant') return !isAnswer;
  if (row.role === 'toolResult') return true;
  if (row.role === 'thinking') return true;
  if (row.role === 'notice') return false; // 会话内提示（重试/压缩/扩展报错）不折：它们是状态，不是过程
  return false;
}

/**
 * 把行序列切成"轮"，并给出每一轮怎么折。
 *
 * @param rows - 已载入的行（顺序 = 转录顺序）
 * @returns 每一轮的判读结果（顺序 = 对话顺序）。存在**没有 user 行的前置段**时，
 *          那一段不返回（它多半是分页窗口从半途开始的残留，不折更安全）。
 */
export function turnFolds(rows: readonly FoldRowInput[], streaming = false): TurnFold[] {
  const turns: TurnFold[] = [];
  let start = -1;
  let turn = 0;

  const flush = (end: number): void => {
    if (start < 0) return;
    turns.push(foldSegment(rows, start, end, turn, streaming));
    turn += 1;
  };

  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]!.role === 'user') {
      flush(i - 1);
      start = i;
    }
  }
  flush(rows.length - 1);
  return turns;
}

function foldSegment(
  rows: readonly FoldRowInput[],
  start: number,
  end: number,
  turn: number,
  streaming: boolean,
): TurnFold {
  const head = rows[start]!;
  // 最终回答 = 段内**最后一条**有可见正文、且不带工具调用的助手行
  let answerIndex: number | null = null;
  for (let i = end; i > start; i -= 1) {
    const r = rows[i]!;
    if (r.role === 'assistant' && r.hasText && !r.hasToolCall) {
      answerIndex = i;
      break;
    }
  }
  const processIndexes: number[] = [];
  let running = false;
  let waiting = false;
  let failure: 'error' | 'aborted' | null = null;
  for (let i = start + 1; i <= end; i += 1) {
    const r = rows[i]!;
    if (r.live) running = true;
    // 等用户回答 = 没结束（见 `FoldRowInput.pendingQuestion` 的注释）
    if (r.pendingQuestion === true) waiting = true;
    if (r.failure) failure = r.failure;
    if (isProcess(r, i === answerIndex)) processIndexes.push(i);
  }

  // 用时：段内最后一行的时间戳 − user 行的时间戳。缺任一端就算不出来（不编）。
  const lastTs = rows[end]!.timestamp;
  const durationMs = head.timestamp !== null && lastTs !== null && lastTs >= head.timestamp ? lastTs - head.timestamp : null;

  const status: TurnStatus = failure === 'error' ? 'failed' : failure === 'aborted' ? 'aborted' : 'done';
  /* 标题画在哪一行上方：
     · 有过程 → 过程的第一行（DSH：整轮折叠的范围就是"过程"，标题在它上沿）；
     · 没有过程（一问一答）→ **回答那一行**上方，而不是 user 行上方。
       后者会读成"这一轮还没问就完成了"（实测截图确认过顺序很怪）—— DSH 的
       Turn 控制也落在 user 消息**之后**（它是过程的头，不是消息的头）。 */
  const headIndex = processIndexes[0] ?? answerIndex ?? start;
  /* "结束了吗"：段内有流式行 → 没结束；此外**最后一段**在 `streaming` 为真时也算没结束
     （用户刚发出去、第一个 token 还没到，那一段只有一条 user 行）。 */
  const last = end === rows.length - 1;
  const closed = !running && !waiting && !(last && streaming);
  let reason: TurnFold['reason'] = null;
  if (waiting) reason = 'pending-question';
  else if (!closed) reason = 'running';
  else if (processIndexes.length === 0) reason = 'no-process';
  else if (failure !== null) reason = 'settled-failure';
  return {
    turn,
    start,
    end,
    processIndexes,
    answerIndex,
    status,
    durationMs,
    headIndex,
    closed,
    foldable: closed && processIndexes.length > 0 && failure === null,
    showHeader: closed && (processIndexes.length > 0 || answerIndex !== null),
    reason,
  };
}

/** 折叠行上写什么（标题 + 右侧那一段）。DSH 的 `TurnProcessNodeView` 口径。 */
export function foldLabel(fold: TurnFold, compactDuration = false): { title: string; trailing: string } {
  const title = fold.status === 'failed' ? '处理失败' : fold.status === 'aborted' ? '已停止' : '已完成工作';
  if (fold.durationMs === null || compactDuration) return { title, trailing: '' };
  return { title, trailing: formatDuration(fold.durationMs) };
}

/**
 * 用时文本（DSH：完成态用等宽数字、分秒不补前导零；≥60 分钟显示小时）。
 *
 * @param ms - 毫秒
 * @returns 例如 `12s`、`1m 05s`、`1h 02m`
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}
