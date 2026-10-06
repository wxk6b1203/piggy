/**
 * per-tab 事件接线（docs/03 §2.14）：幂等挂载，tab 关闭时拆除。
 *
 * 帧 → `messagesStore.applyFrame`（写进**流式那一行**的槽位）；
 * commit → `applyCommit`（同一行转正 / 新行入列 / 分页状态）；
 * 后台 tab 一样收（内容不丢，切回来不会缺一段）。
 */
import { on, cmd } from '@/lib/ipc';
import { markSleeping } from '@/lib/sleep';
import { useMessages } from '@/stores/messages';
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
      await on(`pi:commit:${tabId}`, (ev: { type: string }) => {
        /*
         * 一轮的边界（流式那一行的生死）在**事件层**认，不在渲染侧：
         * `message_start` 建行、`message_end` 转正都必须与帧走在同一条通道上
         * （`agent_start` 与紧随其后的帧走同一条 IPC，到达顺序即发送顺序）。
         * 渲染侧只能"下一帧再清"，没有这个保证 —— 探针实测过：清晚了会把新一轮
         * 开头已经收到的帧抹掉，那一行最后是空的。
         */
        useMessages.getState().applyCommit(tabId, ev);
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
             收尾、扩展把消息吞了……）。落地成「已中止」，别让它永远转圈。
             ⚠️ 顺序：先落地（要读 `pendingId`），再走下面那些"落定之后"的事。 */
          useMessages
            .getState()
            .interruptTurn(tabId, '本轮结束，但没有收到最终消息（已中止）');
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
      }),
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
        }
        /* pi **启动就失败**的情况（今天最现实的一种：扩展工具名冲突 —— 用户自己装过一份
           同名插件，pi 会打印 "Tool "x" conflicts with …" 然后根本不进会话）。
           Rust 侧把 stderr 尾部随 `pi:state` 发过来了，但前端此前**一个字段都没读**，
           于是用户只看到"worker 崩溃"却没有任何原因。把它作为会话内的一行说出来。 */
        if ((st.state === 'crashed' || st.state === 'stopped') && typeof st.stderrTail === 'string') {
          const line = st.stderrTail.trim();
          if (line !== '') {
            useMessages.getState().extensionError(tabId, 'pi 启动/运行失败', line);
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

export function disposeTabListeners(tabId: string) {
  const p = listeners.get(tabId);
  if (p) {
    void p.then((f) => f());
    listeners.delete(tabId);
  }
}

type TabModel = { id?: string; provider?: string } | null;
