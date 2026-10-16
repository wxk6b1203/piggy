/**
 * 会话等待队列（docs/04 §7.3 / docs/12 §3.8）：**pi 的队列是权威，这里是它的影子**。
 *
 * ## 为什么不能只读 pi 的队列
 *
 * pi 的队列是**两个 `string[]`**（`agent-session.ts:394-396` 的 `_steeringMessages` /
 * `_followUpMessages`），`queue_update` 只把它们原样发出来：
 *
 * - **没有 id** —— pi 自己在消费时也是按**文本相等** `indexOf` 找的（`:1127/:1133`）；
 * - **没有图片** —— 图片只活在 agent 内部队列的 `AgentMessage.content` 里（`:2266-2274`），
 *   事件里根本看不见；
 * - **没有按条操作** —— 33 条 RPC 里跟队列有关的只有 `prompt{streamingBehavior}` /
 *   `steer` / `follow_up` / `clear_queue`，**没有任何**"改第 N 条/删第 N 条/插话第 N 条"。
 *
 * 所以影子这一层的职责是补上 pi 给不了的那部分：稳定 id、图片、归属（本地/外来）、
 * 「取回」之后要能原样放回去。
 *
 * ## 唯一的手法：取回 = 整条尾巴一起取（`clear_queue` 是 pi 唯一的内容读取口）
 *
 * `clear_queue` 是**破坏性读**：清空并返回清掉的队列（`agent-session.ts:2427-2435`）。
 * 于是"取回第 2 条"在协议上只能是"把第 2 条及它后面的一起取回、缓存在这里"，
 * 用户改完再按原序放回（`plan` 的事务）。这不是妥协的产物，而是与 pi 的
 * `one-at-a-time` 队列语义天然对齐的形态：**尾巴本来就是要按序发的**。
 *
 * ⚠️ 三个必须让用户知道的代价（都由 UI 明确说出来，不许静默）：
 * 1. **外来行**（插件 `pi.sendMessage({deliverAs})` 注入的、`deliverAs:'nextTurn'` 的）
 *    在 `queue_update` 里**看不见**（`:2331-2338`），但**会被 `clear_queue` 一起清掉**。
 *    影子只能靠"对不上账"把它们标出来，清空前必须提示有多少条不认识的行。
 * 2. 取回窗口内，`clear_queue` 之前就已进入 pi 内部队列的消息我们拿不回来 —— 用
 *    `clear_queue` 的返回值对账，对不上的行**不重建**（重建等于重复发）。
 * 3. 队列**不落盘**（pi 与 DSH 都不落盘）：应用退出即丢，这里不引入持久化。
 */
import { create } from 'zustand';
import { cmd } from '@/lib/ipc';
import type { PendingImage } from '@/lib/pendingImage';

/** 影子行在 pi 里属于哪个队列（决定放回时的 `streamingBehavior` 与送达时机）。 */
export type QueueTarget = 'steering' | 'followUp';

/** 影子行的来源：本地发的，还是 pi 队列里"我们不认识"的那些。 */
export type QueueOwnership = 'local' | 'foreign';

export interface QueueRow {
  /** 影子自己的稳定 id（pi 没有 id，所以**只在本机有效**，跨 `queue_update` 靠文本+顺序续上） */
  id: string;
  /** 下发给 pi 的文本（纯图片消息就是 `（见图片）`，与 Composer 的口径一致） */
  text: string;
  /** 随消息一起下发的图片（只活在影子里 —— `queue_update` 不带图片） */
  images: PendingImage[];
  target: QueueTarget;
  ownership: QueueOwnership;
  /** 正在下发（同 DSH 的 `pendingSubmissions`：这期间整队动作禁用，防重入） */
  sending: boolean;
}

/**
 * 线上投递语义（`streamingBehavior`）→ 影子内部的队列归属。
 *
 * 两个命名域**必须分开**：线上只有 `'steer'` / `'followUp'`（pi 只认这两个字面量），
 * 影子内部把"进 steering 队列"叫 `'steering'`（与 `queue_update` 的字段名对齐）。
 * 之前把内部值当线上值发出去过，pi 把它当"没指定 streamingBehavior"直接拒了，
 * 而拒绝发生在 await 里 —— 于是表现成"点了插话什么也没发生"（静默失败）。
 */
export type DeliveryBehavior = 'steer' | 'followUp';
const targetOf = (b: DeliveryBehavior): QueueTarget => (b === 'steer' ? 'steering' : 'followUp');

export interface TakeOk {
  ok: true;
  /** 取回了几条**暂停中**的行（不含 `delivered`：那些已经被 pi 吃进回合了） */
  paused: number;
  /** 顺带发现的外来行（清空前要提示用户的那批） */
  foreign: number;
  /** 对不上账、已经不在了的行（在 clear 之前就被 pi 消费掉） */
  delivered: number;
}

export interface TakeErr {
  ok: false;
  error: string;
}

/**
 * 队列影子。`rows` 是 pi 队列的镜像；`paused` 是从 `pausedFrom` 开始被取回、暂存在本地的尾巴。
 *
 * 为什么尾巴单独一份而不在原数组里打标：暂停的行**已经不在 pi 的队列里**了，
 * 两者的权威来源不同（一个是事件，一个是本地），混在一起会让每次 `queue_update`
 * 都可能误删暂停行。
 */
export interface TabQueue {
  rows: QueueRow[];
  paused: QueueRow[];
  /**
   * **已经被 pi 消费掉**的文本（这一轮里进过转录的）。
   *
   * 为什么必须记：`queue_update` 是快照，而"从快照里消失"有两种意思 ——
   * ① 被消费了（消息已经进转录）、② 被 `clear_queue` 清掉了（我们主动取回）。
   * 只靠快照分不出来，于是"取回"过程中 pi 自己的那次 clear 回声会把整队抹掉，
   * 再对账时已消费的行会被当成外来行重新造一条（重复出现在界面上）。
   * 有了这份记忆，两种消失就分得开了。
   */
  consumed: string[];
  /** 正在下发（`enqueue` 的乐观窗口） */
  busy: boolean;
  /** 正在跑取回/放回事务（期间禁用一切队列动作） */
  taking: boolean;
  /**
   * 刚收到 `agent_settled`。
   *
   * 为什么需要它（2026-10-15 用户实报：编辑打勾之后排队的另一条没了）：
   * pi **在回合结束时不会推 `queue_update`**（只在入队/消费/清空时推），所以
   * `settled()` 之后最先到的那条快照可能是**回合结束前**的旧状态（最常见的形态：
   * steering 已经被消费、快照是空的）。拿它去对账就会把 **followUp 行**一起抹掉 ——
   * 而那些行恰恰是"等下一轮就发"的、必须留着的。
   * 所以落定之后的那一次对账要跳过删除；下一条 `message_end`（下一轮真的开始了，
   * 快照也重新变新鲜）再把标志清掉。
   */
  turnEnded: boolean;
  /** 「编辑」正在改哪一行（一次只许一条，同 DSH） */
  editingId: string | null;
  /** 折叠（只在 >1 行时有意义；行数归零时复位） */
  collapsed: boolean;
}

const emptyTab = (): TabQueue => ({
  rows: [],
  paused: [],
  consumed: [],
  busy: false,
  taking: false,
  turnEnded: false,
  editingId: null,
  collapsed: true,
});

interface QueueState {
  tabs: Record<string, TabQueue>;
  ensure: (tabId: string) => void;
  /**
   * `queue_update` → 对账（不改 pi，只把影子拉齐）。
   *
   * `delivered`：**这一帧里已经在转录中落地的用户消息文本**。pi 消费队列项之后
   * 队列里就没有它了，如果不说一声，影子会把它当成"外来行"重新造出来。
   */
  reconcile: (
    tabId: string,
    snapshot: { steering: string[]; followUp: string[] },
    delivered?: readonly string[],
  ) => void;
  /** `agent_settled`：一轮落定，`steering` 队列里的东西已经被吃光了 */
  settled: (tabId: string) => void;
  /** 某条文本已经在转录里落地了 → 影子该把它摘掉 */
  delivered: (tabId: string, text: string) => void;
  /**
   * 投递一条消息。`behavior` 决定它去哪儿（**不许有默认值**）：
   *   · `undefined` → 空闲，普通 `prompt`（起一轮，**不进队列**）；
   *   · `'steer'`   → 进 pi 的 steering 队列，下一个步进边界插进当前回合；
   *   · `'followUp'`→ 进 followUp 队列，等这一轮结束再说。
   *
   * ⚠️ 名字对齐**线上值**（`streamingBehavior: 'steer' | 'followUp'`），不要用影子内部的
   * `'steering'`：那一层是我们自己的命名，pi 只认 `'steer'`（实测发错值会被
   * `session.prompt` 当"没指定"拒掉，而拒绝发生在 await 里 → 静默失败）。
   * 影子的 `target` 由这里映射，调用方一律传线上值。
   *
   * ⚠️ 这里曾经把 `followUp` 当默认值，于是**空闲时发的消息也被标成入队** ——
   * 真机空闲时会忽略这个字段（`agent-session.ts:2097` 的 `if (this.isStreaming)`），
   * 所以它照样起了一轮、看起来没事，但语义是错的（队列影子会记一条永远不会被队列
   * 承认的行）。单测 `空闲时 ↵ 直发` 就是钉这一条的。
   */
  enqueue: (
    tabId: string,
    row: { text: string; images: PendingImage[]; behavior?: DeliveryBehavior },
  ) => Promise<{ queued: boolean }>;
  take: (tabId: string, id: string) => Promise<TakeOk | TakeErr>;
  putBack: (tabId: string) => Promise<TakeOk | TakeErr>;
  dropPaused: (tabId: string, id: string) => void;
  clearAll: (tabId: string) => Promise<void>;
  setEditing: (tabId: string, id: string | null) => void;
  editPaused: (tabId: string, id: string, text: string) => void;
  touch: (tabId: string, patch: Partial<TabQueue>) => void;
}

/** 影子行的 id：`queue-<n>` 就够了 —— 它只在本机一份影子内需要唯一。 */
let seq = 1;
const nextId = (): string => `q${seq++}`;

/**
 * 把影子与 pi 的快照对账。**纯函数**（单独出来是为了让"文本重复""外来行""被吃掉的行"
 * 这三种形状能被穷举测到，而不用起 store）。
 *
 * 匹配口径与 pi 自己一致：**按目标队列 + 文本 + 先到先得**（pi 消费时就是 `indexOf`）。
 * 因此两条一模一样的消息在协议层本来就不可区分 —— 这里也就只能按顺序续 id。
 */
export function reconcileRows(
  rows: QueueRow[],
  snapshot: { steering: string[]; followUp: string[] },
  delivered: readonly string[] = [],
): QueueRow[] {
  const incoming: Array<{ text: string; target: QueueTarget; ownership: QueueOwnership }> = [
    ...snapshot.steering.map((text) => ({ text, target: 'steering' as const, ownership: 'local' as const })),
    ...snapshot.followUp.map((text) => ({ text, target: 'followUp' as const, ownership: 'local' as const })),
  ];
  const used = new Set<number>();
  const out: QueueRow[] = [];
  /* 已经**被 pi 消费掉**的文本（按 tab 记，见 store 里的 `delivered`）。
     判据意义：一条消息一旦进过转录，就不能在后续对账里作为"外来行"重新冒出来。 */
  const gone = new Set(delivered);
  for (const item of incoming) {
    // 先找"同目标 + 同文本 + 还没被认领"的影子行：认领它就能保住 id 与图片
    const idx = rows.findIndex(
      (r, i) => !used.has(i) && r.target === item.target && r.text === item.text && r.sending,
    );
    const fallback = idx >= 0
      ? idx
      : rows.findIndex((r, i) => !used.has(i) && r.target === item.target && r.text === item.text);
    if (fallback >= 0) {
      used.add(fallback);
      const row = rows[fallback]!;
      out.push({ ...row, sending: false, ownership: 'local' });
      continue;
    }
    /* 对不上账的行有两种，必须分开（2026-10-15 单测逼出来的真 bug）：
       ① 已经从队列里消失、并且**已经在转录里落地**了（pi 在 `turn_end` 后 drain，
          `agent-loop.ts:295`）→ 它根本不是外来行，**不许**再冒出来；
       ② 真的是别人排的（插件的 `pi.sendMessage({deliverAs})`、`deliverAs:'nextTurn'`）——
          它们**看不见但清得掉**，必须显式标出来，不能装作队列里只有自己的东西。
       漏掉 ① 的后果：一条已经进回合的消息会在下一次对账时变成"插件注入"重新出现，
       而它其实已经发过了 —— 界面直接骗人。 */
    if (gone.has(item.text)) continue;
    out.push({
      id: nextId(),
      text: item.text,
      images: [],
      target: item.target,
      ownership: 'foreign',
      sending: false,
    });
  }
  return out;
}

/**
 * 影子行 → 下发参数。
 *
 * ⚠️ 这个转换不能省（测试逼出来的真 bug）：行上存的是影子的 `target`
 * （`'steering' | 'followUp'`），而 `sendToPi` 要的是**线上值** `behavior`
 * （`'steer' | 'followUp'`）。直接把行丢给 `sendToPi` 时 `behavior` 是 undefined，
 * 于是流式中下发不带 `streamingBehavior` —— pi 直接拒绝，表现是"放回点了没反应"。
 */
const wireOf = (row: QueueRow): { text: string; images: PendingImage[]; behavior: DeliveryBehavior } => ({
  text: row.text,
  images: row.images,
  behavior: row.target === 'steering' ? 'steer' : 'followUp',
});

/** 取某一行时，**一起被取回**的尾巴：从该行起、到队列末尾（含第一行本身）。 */
function tailFrom(rows: QueueRow[], id: string): QueueRow[] {
  const i = rows.findIndex((r) => r.id === id);
  if (i < 0) return [];
  return rows.slice(i);
}

/**
 * `take` 阶段已经替哪些行重新下发过（键 = `tabId\0rowId`）。
 *
 * 为什么需要：`clear_queue` 会**整清**，连"保留的前缀"也清掉，所以 `take` 必须
 * 立刻把它们按原序重发回去。等 `putBack` 时再发就会重复投递 —— 这份注册表让
 * `putBack` 知道"这条已经发过了，只把它从暂存挪回队列"。
 */
const alreadySent = new Set<string>();

export const useQueue = create<QueueState>((set, get) => {
  const patch = (tabId: string, fn: (t: TabQueue) => Partial<TabQueue>): void => {
    set((s) => {
      const cur = s.tabs[tabId] ?? emptyTab();
      return { tabs: { ...s.tabs, [tabId]: { ...cur, ...fn(cur) } } };
    });
  };
  const read = (tabId: string): TabQueue => get().tabs[tabId] ?? emptyTab();

  /** 下发一条（`behavior` 为空 = 空闲直发；给了就是 pi 的两种队列投递语义之一）。 */
  const sendToPi = async (
    tabId: string,
    row: { text: string; images: PendingImage[]; behavior?: DeliveryBehavior },
  ): Promise<void> => {
    const p: Record<string, unknown> = { tabId, message: row.text };
    if (row.images.length > 0) {
      p.images = row.images.map((im) => ({ type: 'image', data: im.data, mimeType: im.mimeType }));
    }
    // 空 `streamingBehavior` 一律**不发这个字段**：真机在流式中缺了它会直接报错，
    // 所以"没带"必须只表示"空闲直发"这一种意思。
    // 线上值就是 `'steer' | 'followUp'`（影子的 `target` 才叫 `'steering'`）
    if (row.behavior) p.streamingBehavior = row.behavior === 'steer' ? 'steer' : 'followUp';
    await cmd<boolean>('pi_prompt', p);
  };

  return {
    tabs: {},

    ensure: (tabId) =>
      set((s) => (s.tabs[tabId] ? s : { tabs: { ...s.tabs, [tabId]: emptyTab() } })),

    reconcile: (tabId, snapshot, delivered = []) => {
      /* 事务进行中不接受对账：`pi_clear_queue` 一回来，pi 自己那次"空快照"的
         `queue_update` 也会到。此刻影子里的行**正是本次取回要保住的那批**，
         让空快照把它们抹掉，取回就变成了"后半段凭空消失 + 已消费的行被当成外来行重造"。
         事务结束时 `take` 自己会用 `clear_queue` 的返回值把影子重建到位。 */
      patch(tabId, (cur) => {
        const consumed = [...new Set([...cur.consumed, ...delivered])];
        /* 落定之后的那一次对账**不删行**：pi 在回合结束时根本不推 `queue_update`，
           所以此刻手上这条快照可能还是回合结束前的旧状态（常见的空快照）。
           照它删，就会把"等下一轮就发"的 followUp 行一起抹掉（用户实报的那个 bug）。
           删除交给明确的信号：`delivered`（消费）、`take`/`clearAll`（我们自己清的）。 */
        /* ⚠️ **空快照不许无理由地抹掉还在队列里的行**（2026-10-15 用户实报"编辑打勾之后
           另一条也没了"）。空快照的来源太多：`clear_queue` 那次清空的回声、回合结束前
           最后一次状态、我们自己取回时中间态……它们都不是"队列真的空了"的权威证据。
           真正的删除有明确信号：`delivered`（被消费）、`take`/`clearAll`（我们自己清）。
           这里只做**增量**：认领已有行、把对不上账的标成外来行。 */
        if (snapshot.steering.length === 0 && snapshot.followUp.length === 0 && cur.rows.length > 0) {
          return {};
        }
        if (cur.turnEnded) {
          const have = new Set(cur.rows.map((r) => r.text));
          const extra = reconcileRows([], snapshot, consumed).filter((r) => !have.has(r.text));
          return { rows: [...cur.rows, ...extra] };
        }
        const rows = reconcileRows(cur.rows, snapshot, consumed);
        // 行数与暂停堆都空了 → 折叠态复位（DSH 同款：下一波默认收起）
        const collapsed = rows.length === 0 && cur.paused.length === 0 ? true : cur.collapsed;
        return { rows, consumed, collapsed };
      });
    },

    /* 一轮落定：`steering` 队列必然已经清空（它只服务于当前回合 —— pi 在
       `turn_end` 后 drain，见 `agent-loop.ts:295`）。但 **`followUp` 不清**：
       它们正是"等这轮结束就发"的那批，pi 会在下一次 run 开头把它们变成新回合
       （`agent-loop.ts:302-308`），影子必须跟着留着（否则界面上队列凭空消失，
       而消息其实还在 pi 里排着）。
       顺带把暂停堆里的 `steering` 行降级成 `followUp`：回合都结束了，放回时再带
       `streamingBehavior:'steer'` 已经没有意义（agent 空闲时 pi 忽略这个字段）。 */
    settled: (tabId) =>
      patch(tabId, (cur) => ({
        turnEnded: true,
        rows: cur.rows.filter((r) => r.target !== 'steering'),
        paused: cur.paused.map((r) => (r.target === 'steering' ? { ...r, target: 'followUp' as const } : r)),
      })),

    delivered: (tabId, text) =>
      patch(tabId, (cur) => {
        const consumed = cur.consumed.includes(text) ? cur.consumed : [...cur.consumed, text];
        // 只摘一条：pi 消费时也是 `indexOf` 先到先得
        const i = cur.rows.findIndex((r) => r.text === text);
        if (i < 0) return { consumed, turnEnded: false };
        return { rows: [...cur.rows.slice(0, i), ...cur.rows.slice(i + 1)], consumed, turnEnded: false };
      }),

    enqueue: async (tabId, row) => {
      get().ensure(tabId);
      const cur = read(tabId);
      /* 空闲直发：**不进队列、也不碰影子** —— 它就是这一轮的用户消息，pi 会直接起一轮。
         以前这里会先乐观插一行再等 `queue_update` 认领，而空闲路径根本不会推
         `queue_update`，于是那行会永远挂在"发送中"。 */
      if (!row.behavior) {
        await sendToPi(tabId, row);
        return { queued: false };
      }
      // 暂停期间不许再往 pi 里塞东西：pi 的队列只有 FIFO + 只能整清，
      // 混进来就没法保证"按原序放回"了（docs/04 §7.3 的顺序契约）。
      if (cur.paused.length > 0) {
        const shadow: QueueRow = {
          id: nextId(),
          text: row.text,
          images: row.images,
          target: targetOf(row.behavior),
          ownership: 'local',
          sending: false,
        };
        patch(tabId, (c) => ({ paused: [...c.paused, shadow] }));
        return { queued: true };
      }
      const optimistic: QueueRow = {
        id: nextId(),
        text: row.text,
        images: row.images,
        target: targetOf(row.behavior),
        ownership: 'local',
        sending: true,
      };
      patch(tabId, (c) => ({ rows: [...c.rows, optimistic], busy: true }));
      try {
        await sendToPi(tabId, row);
        return { queued: true };
      } catch (e) {
        // 没发出去就把它摘掉（别留一条永远"发送中"的幽灵行）
        patch(tabId, (c) => ({ rows: c.rows.filter((r) => r.id !== optimistic.id) }));
        throw e;
      } finally {
        patch(tabId, () => ({ busy: false }));
      }
    },

    take: async (tabId, id) => {
      const cur = read(tabId);
      const row = cur.rows.find((r) => r.id === id);
      if (!row) return { ok: false, error: '这一条已经不在队列里了' };
      const expecting = tailFrom(cur.rows, id);
      /* 进函数时的全量行快照。**不能**在 `await` 之后回头读 store 或读 patch 回调里的
         `cur` —— 那时 pi 自己那次"空快照"的 `queue_update` 可能已经到了，
         影子已经被抹光，而这批行正是本次取回要保住的对象（实测：保不住的行
         会被当成外来行重造一条，界面上变成两条）。 */
      const before = cur.rows;
      const consumedBefore = cur.consumed;
      patch(tabId, () => ({ taking: true }));
      try {
        const cleared = await cmd<{ steering: string[]; followUp: string[] }>('pi_clear_queue', { tabId });
        /* 对账：`clear_queue` 的返回值里**没有**的行 = 在 clear 之前就已经被 pi 吃进回合了。
           那些行**不许重建**（重建就是重复发一遍）。 */
        const pool: string[] = [...(cleared.steering ?? []), ...(cleared.followUp ?? [])];
        const missing = new Set<string>();
        for (const r of expecting) {
          const i = pool.indexOf(r.text);
          if (i >= 0) pool.splice(i, 1);
          else missing.add(r.id);
        }
        const delivered = missing.size;
        const paused = expecting
          .filter((r) => !missing.has(r.id))
          .map((r) => ({ ...r, sending: false }));
        const kept = before.filter((r) => !expecting.some((e) => e.id === r.id));
        /* ⚠️ `clear_queue` 是**整清**：保留的那截前缀也被一起清掉了。必须立刻按原序
           重新下发，否则"界面上还排着"与"pi 队列里其实已经没了"两边会越差越远
           （用户实报：编辑打勾之后另一条也没了 —— 根因就是它在前缀里，被 clear 掉了，
           而我们只在 `putBack` 时才会重发，中间任何一次对账都会把它判成"外来行"或删掉）。
           重新下发的是**同一条内容、同一个位置**，用户看不到任何变化。 */
        for (const r of kept) {
          await sendToPi(tabId, wireOf(r));
          alreadySent.add(`${tabId}\u0000${r.id}`);
        }
        /* 池子里剩下的就是"我们不认识、但 pi 队列里确实有"的那些（插件注入的）。
           ⚠️ 文本与保留下来的行**同名**的要排除：同名在协议层本来就不可区分
           （pi 消费队列项时也是按文本 `indexOf`），再冒一条出来就是重复显示。 */
        const keptTexts = new Set(kept.map((r) => r.text));
        const foreignRows: QueueRow[] = pool
          .filter((text) => !keptTexts.has(text))
          .map((text) => ({
            id: nextId(),
            text,
            images: [],
            target: 'followUp',
            ownership: 'foreign',
            sending: false,
          }));
        /* 对不上账的那批 = 已经被 pi 吃进回合了：记进 `consumed`，
           免得它们在下一次对账里被当成外来行重新出现。 */
        const consumed = [
          ...new Set([...consumedBefore, ...expecting.filter((r) => missing.has(r.id)).map((r) => r.text)]),
        ];
        set((s) => ({
          tabs: {
            ...s.tabs,
            [tabId]: {
              ...(s.tabs[tabId] ?? emptyTab()),
              rows: [...kept, ...foreignRows],
              paused,
              consumed,
              taking: false,
              editingId: null,
              collapsed: false,
            },
          },
        }));
        return { ok: true, paused: paused.length, foreign: foreignRows.length, delivered };
      } catch (e) {
        patch(tabId, () => ({ taking: false }));
        return { ok: false, error: String(e) };
      }
    },

    putBack: async (tabId) => {
      const cur = read(tabId);
      if (cur.paused.length === 0) return { ok: true, paused: 0, foreign: 0, delivered: 0 };
      patch(tabId, () => ({ taking: true }));
      const done: string[] = [];
      /** take 阶段已经被重新下发过的行（前缀）：绝不能再发一次。 */
      const skip = (row: QueueRow): boolean => {
        const key = `${tabId}\u0000${row.id}`;
        if (!alreadySent.has(key)) return false;
        alreadySent.delete(key);
        return true;
      };
      /** 放回时按**原序**逐条下发；每成功一条就把它从暂停堆挪回影子队列。 */
      const put = async (row: QueueRow): Promise<TakeOk | TakeErr> => {
        try {
          await sendToPi(tabId, wireOf(row));
          done.push(row.id);
          /* 从暂存摘掉，并**把这一行认回队列**（保留原 id 与图片）。
             为什么不能只等 `queue_update`：pi 的入队事件确实会推，但"我们正在事务里"
             （`taking`）会把那次对账跳过 —— 只等它就等于等一次永远不会被处理的事件，
             表现就是"放回之后那一行不见了"。这里只补"自己刚发出去的这条"，
             不删任何东西，所以不会与权威快照打架。 */
          set((s) => {
            const t = s.tabs[tabId] ?? emptyTab();
            const exists = t.rows.some((r) => r.text === row.text && r.target === row.target);
            return {
              tabs: {
                ...s.tabs,
                [tabId]: {
                  ...t,
                  paused: t.paused.filter((r) => r.id !== row.id),
                  rows: exists ? t.rows : [...t.rows, { ...row, sending: false }],
                },
              },
            };
          });
          return { ok: true, paused: 0, foreign: 0, delivered: 0 };
        } catch (e) {
          // 第一条就失败 → 老老实实退回暂停态（队列原样没动，用户还能再点一次）；
          // 中途失败 → 前面几条已经在 pi 队列里了，**绝不重发**，如实报出来。
          patch(tabId, () => ({ taking: false, editingId: null }));
          get().reconcile(tabId, { steering: [], followUp: [] });
          return {
            ok: false,
            error: done.length === 0
              ? String(e)
              : `放回中断：前 ${done.length} 条已进队列，其余仍在暂存（${String(e)}）`,
          };
        }
      };
      let last: TakeOk | TakeErr = { ok: true, paused: 0, foreign: 0, delivered: 0 };
      for (const row of [...cur.paused]) {
        if (skip(row)) {
          // 前缀那条：take 已经替它发过了，这里只把它从暂存挪回队列
          set((s) => {
            const t = s.tabs[tabId] ?? emptyTab();
            return {
              tabs: {
                ...s.tabs,
                [tabId]: {
                  ...t,
                  paused: t.paused.filter((r) => r.id !== row.id),
                  rows: t.rows.some((r) => r.text === row.text) ? t.rows : [...t.rows, row],
                },
              },
            };
          });
          continue;
        }
        last = await put(row);
        if (!last.ok) return last;
      }
      patch(tabId, () => ({ taking: false, editingId: null, turnEnded: false }));
      return last;
    },

    dropPaused: (tabId, id) =>
      patch(tabId, (cur) => ({ paused: cur.paused.filter((r) => r.id !== id) })),

    clearAll: async (tabId) => {
      patch(tabId, () => ({ taking: true }));
      try {
        await cmd<{ steering: string[]; followUp: string[] }>('pi_clear_queue', { tabId });
      } finally {
        set((s) => ({
          tabs: {
            ...s.tabs,
            [tabId]: {
              ...(s.tabs[tabId] ?? emptyTab()),
              rows: [],
              paused: [],
              taking: false,
              editingId: null,
              collapsed: true,
            },
          },
        }));
      }
    },

    setEditing: (tabId, id) => patch(tabId, () => ({ editingId: id })),

    editPaused: (tabId, id, text) =>
      patch(tabId, (cur) => ({
        paused: cur.paused.map((r) => (r.id === id ? { ...r, text } : r)),
      })),

    touch: (tabId, p) => patch(tabId, () => p),
  };
});

/** 测试与 `disposeTabListeners` 用：把某个 tab 的影子彻底删掉。 */
export function dropQueueTab(tabId: string): void {
  useQueue.setState((s) => {
    const next = { ...s.tabs };
    delete next[tabId];
    return { tabs: next };
  });
}
