/**
 * per-tab 事件接线（docs/03 §2.14）：幂等挂载，tab 关闭时拆除。
 *
 * 帧 → `messagesStore.applyFrame`（写进**流式那一行**的槽位）；
 * commit → `applyCommit`（同一行转正 / 新行入列 / 分页状态）；
 * 后台 tab 一样收（内容不丢，切回来不会缺一段）。
 */
import { on, cmd } from '@/lib/ipc';
import { textOfContent } from '@/lib/messageText';
import { markSleeping } from '@/lib/sleep';
import { useMessages } from '@/stores/messages';
import { dropQueueTab, useQueue } from '@/stores/queue';
import { useTodo } from '@/stores/todo';
import { useTabs } from '@/stores/tabs';
import { useDialogs, type UiRequest } from '@/stores/dialogs';
import { useQuestions } from '@/stores/questions';
import { handleFireAndForget } from '@/features/dialogs/DialogRouter';
import { windowEvents } from '@/lib/windowEvents';
import { useTrajectory } from '@/stores/trajectory';
import { useBash } from '@/stores/bash';
import type { Frame } from '@piggy/pi-protocol';

const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

type VoidFn = () => void;
/** `pi:commit` 事件（`type` 是判别式，其余字段随类型而定）。 */
type TabEvent = { type: string } & Record<string, unknown>;
const listeners = new Map<string, Promise<VoidFn>>();

export async function ensureTabListeners(tabId: string): Promise<void> {
  if (listeners.has(tabId)) return;
  const promise = (async () => {
    const un: VoidFn[] = [];
    un.push(
      await on(`pi:frame:${tabId}`, (frame: Frame) => {
        /*
         * 后台 tab 的帧**也收**。
         *
         * 早先这里写着 `if (activeTabId === tabId)` —— 后台 tab 的帧直接丢弃（当时的理由：
         * "只给活动 tab 做视觉"）。但流式的文本就是**内容**：切走那段时间的增量一丢，
         * 切回来时那一轮就缺一段（同一个 tab 内看起来像"流式重启"），而 DSH 的流式内容
         * 挂在每个会话自己的状态里，不存在"切走就丢字"。
         *
         * 现在没有可见节点时只是往 store 里累积字符串（不触发任何布局）——
         * `lib/live` 那套 attach/detach 与它带来的节点身份问题一起消失了。
         */
        useMessages.getState().applyFrame(tabId, frame);
      }),
    );
    un.push(
      await on(`pi:commit:${tabId}`, (ev: TabEvent) => applyCommitEvent(tabId, ev)),
    );
    un.push(
      await on(`pi:state:${tabId}`, (st: { state?: string } & Record<string, unknown>) => {
        if (st.state === 'sleeping') markSleeping(tabId); // 主动休眠/空闲回收（05 §4）
        /* ⚠️ 崩了/睡了而这一轮**还在流**：必须当场把这一轮落地（docs/15 §4 那条缺口）。
           从前这里只改 worker 状态，于是 `streaming` 一直是 true、实时行一直挂着、
           "停止"按钮一直可用 —— 界面假装还在跑，而那个 `message_end` 永远不会来。
           已流出的字不丢（`interruptTurn` 把实时块转正成一条「已中止」的消息）。
           顺序：先落地再改 worker 状态（落地要读 `pendingId`）。 */
        if (st.state === 'crashed' || st.state === 'sleeping') {
          useMessages
            .getState()
            .interruptTurn(
              tabId,
              st.state === 'crashed'
                ? 'pi 进程崩溃（本轮已中断，已生成的内容保留在上面）'
                : 'pi 进程被回收休眠（本轮已中断，已生成的内容保留在上面）',
            );
          /* 待答提问也要一起清掉（与 `agent_settled` 那支对称）：
             发问的那个进程已经没了，插件那边的 `select` 永远不会再被回答；
             留着卡片的后果更糟 —— 用户点提交时 `ui_reply` 会**按需复活一个新 worker**
             （commands.rs 的 `ui_reply` → `ensure_worker`）再把 `extension_ui_response`
             写进去，而新进程从来没发过那个 id，于是回答被静默吞掉、界面只看到
             "点了没反应"。清掉卡片 = 用户知道这一问已经作废。 */
          useQuestions.getState().clearTab(tabId);
        }
        /* pi **启动就失败**的情况（今天最现实的一种：扩展工具名冲突 —— 用户自己装过一份
           同名插件，pi 会打印 "Tool "x" conflicts with …" 然后根本不进会话）。
           Rust 侧把 stderr 尾部随 `pi:state` 发过来了，但前端此前**一个字段都没读**，
           于是用户只看到"worker 崩溃"却没有任何原因。把它作为会话内的一行说出来。 */
        if ((st.state === 'crashed' || st.state === 'stopped') && typeof st.stderrTail === 'string') {
          const line = st.stderrTail.trim();
          if (line !== '') {
            /* 工具名冲突是这一堆失败里最常见的一种（用户自己装过同名插件，或**项目目录**里有
               `<cwd>/.pi/extensions/<同名>`）：pi 只回一句
               `Tool "x" conflicts with <path>` 然后**根本不进会话**，用户看不出该动什么。
               这里把那句话翻译成"去哪儿改"，其余的 stderr 原样保留（pi 的原话往往最准）。 */
            const conflict = /Tool "([^"]+)" conflicts with (.+)/.exec(line);
            const hint = conflict?.[1] && conflict[2]
              ? `\n→ 工具「${conflict[1]}」有两个来源：${conflict[2].trim()} 与 Piggy 自带的那份。` +
                '两者留一个：删掉你自己装的那份，或到「设置 › 通用 › 内置插件」把 Piggy 这份关掉。'
              : '';
            useMessages.getState().extensionError(tabId, 'pi 启动/运行失败', line + hint);
          }
        }
        useTabs
          .getState()
          .setWorkerState(tabId, (st.state ?? 'ready') as never, st);
      }),
    );
    un.push(
      await on(`pi:ui-req:${tabId}`, (req: UiRequest) => {
        /* 提问卡（docs/06 §7）：pi-ask 的 select 标题里带信封 —— 那种请求**不弹普通
           选择框**（问题与选项在转录的工具行里），只登记待答请求，等卡片来回答。 */
        if (req.method === 'select' && useQuestions.getState().accept(req, tabId)) return;
        if (DIALOG_METHODS.has(req.method)) useDialogs.getState().push(req);
        else handleFireAndForget(req, tabId);
      }),
    );
    return () => {
      for (const f of un) f();
    };
  })();
  listeners.set(tabId, promise);
  await promise;
}


/**
 * `pi:commit` 的全部落库逻辑（**导出是为了让测试走生产接线**，2026-10-17）。
 *
 * 为什么必须抽出来：`queue-dock.test.tsx` 原先自己抄了一遍"applyCommit → 取用户消息文本
 * → reconcile 三步"。那是**测试在验证自己** —— 生产哪天换了 `delivered` 的口径，
 * 那 31 条仍然会绿。抽成函数后监听器只做分发，测试直接调它，两边是同一条路。
 *
 * 一轮的边界（流式那一行的生死）在**事件层**认，不在渲染侧：`message_start` 建行、
 * `message_end` 转正都必须与帧走在同一条通道上（`agent_start` 与紧随其后的帧走同一条
 * IPC，到达顺序即发送顺序）。渲染侧只能"下一帧再清"，探针实测过：清晚了会把新一轮
 * 开头已经收到的帧抹掉，那一行最后是空的。
 *
 * @param tabId - 会话标签
 * @param ev - `pi:commit` 的原始事件（`{ type, ... }`）
 */
export function applyCommitEvent(tabId: string, ev: TabEvent): void {
  /*
   * 一轮的边界（流式那一行的生死）在**事件层**认，不在渲染侧：
   * `message_start` 建行、`message_end` 转正都必须与帧走在同一条通道上
   * （`agent_start` 与紧随其后的帧走同一条 IPC，到达顺序即发送顺序）。
   * 渲染侧只能"下一帧再清"，没有这个保证 —— 探针实测过：清晚了会把新一轮
   * 开头已经收到的帧抹掉，那一行最后是空的。
   */
  useMessages.getState().applyCommit(tabId, ev);
  /* 等待队列的影子（`stores/queue.ts`）：pi 的队列是权威，影子只补它给不了的东西
     （稳定 id / 图片 / 归属）。三条线都必须接在这里，因为队列的生命周期完全由
     pi 的事件驱动：
       · `queue_update` → 对账（唯一的内容来源，pi 没有同步读取队列的 RPC）；
       · 落地的**用户消息** → 这一条已经进转录了，影子摘掉它；
       · `agent_settled` → `steering` 队列必然已空（`followUp` 要留着：它们正是
         "等这轮结束就发"的那批，pi 会在下一次 run 开头把它们变成新回合）。 */
  if (ev.type === 'queue_update') {
    const q = ev as unknown as { steering?: string[]; followUp?: string[] };
    /* `userText`：这一帧里落地的用户消息。pi 消费掉队列项之后 `queue_update`
       里就没有它了 —— 不把"它已经进转录了"这件事一起告诉对账，影子会把它
       当成外来行重新造一条出来（见 `reconcileRows` 的注释）。 */
    const userText = userMessageText(ev);
    useQueue.getState().reconcile(
      tabId,
      { steering: q.steering ?? [], followUp: q.followUp ?? [] },
      userText ? [userText] : [],
    );
}
if (ev.type === 'message_end') {
  const text = userMessageText(ev);
  if (text) useQueue.getState().delivered(tabId, text);
}
if (ev.type === 'agent_settled') useQueue.getState().settled(tabId);
// 任务清单走同一条事件流：新一轮清空 / 新写入替换（DSH 的 turn/start 语义）
useTodo.getState().noteCommit(tabId, ev);
useTrajectory.getState().appendCommit(tabId, ev);
if (ev.type === 'bash_execution_update') {
  const b = ev as unknown as { delta?: string };
  useBash.getState().append(tabId, b.delta ?? '');
}
if (ev.type === 'agent_settled') {
  /* 这一轮结束了：还挂着的待答提问已经没有去处（插件的 select 早被 pi 关掉），
     清掉它们 —— 否则卡片会一直停在"等你回答"，点了提交只得到沉默的失败。 */
  useQuestions.getState().clearTab(tabId);
  /* 一轮落定时**还挂着流式行** = 那个 `message_end` 没来（用户中断、pi 出错后直接
     收尾、扩展把消息吞了……）。落地成一张卡片，别让它永远转圈。
     pi 1.1.0 起 `agent_settled` 自带权威字段 **`aborted`**：true = 我们请求过中断
     （用户按了 Esc / 点了停止），false = 这一轮是自己结束的却没给 `message_end`
     —— 后者是**出错**，该画报警色而不是"你自己取消的"中性色。
     ⚠️ 顺序：先落地（要读 `pendingId`），再走下面那些"落定之后"的事。 */
  const aborted = (ev as { aborted?: boolean }).aborted === true;
  useMessages
    .getState()
    .interruptTurn(
      tabId,
      aborted
        ? '本轮已中止（中断请求已生效）'
        : '本轮结束，但没有收到最终消息（pi 可能出错了；运行日志里通常有原因）',
      { failed: !aborted },
    );
  const t = useTabs.getState();
  if (t.activeTabId !== tabId) t.markUnread(tabId);
  windowEvents.emit('refresh-stats', tabId);
  void cmd<Record<string, unknown>>('pi_get_state', { tabId }).then((st) => {
    t.patch(tabId, {
      model: (st.model as TabModel) ?? null,
      thinkingLevel: (st.thinkingLevel as string) ?? null,
    });
  }).catch(() => {});
}
}

export function disposeTabListeners(tabId: string) {
  const p = listeners.get(tabId);
  if (p) {
    void p.then((f) => f());
    listeners.delete(tabId);
  }
  // tab 关了，队列影子跟着走（它只是 pi 队列的镜像，留着就是一堆幽灵行）
  dropQueueTab(tabId);
}

type TabModel = { id?: string; provider?: string } | null;

/**
 * 一条事件里"用户消息的纯文本"（没有就是空串）。
 *
 * 队列影子要用它把"已经进转录的那条"从队列里摘掉：pi 消费队列项之后队列里就没有它了，
 * 而 `queue_update` 只有文本、没有 id，所以只能按文本对上。
 * 内容可能是裸字符串，也可能是 `[{type:'text',text}]` 块数组（真机是后者）。
 */
function userMessageText(ev: unknown): string {
  const m = (ev as { message?: { role?: string; content?: unknown } }).message;
  return m?.role === 'user' ? textOfContent(m.content) : '';
}
