/**
 * per-tab 事件接线（docs/03 §2.14）：幂等挂载，tab 关闭时拆除。
 * 帧：一律进实时块引擎（后台 tab 只是没有可见节点，文本照攒，见下面的说明）；
 * commit：一律入 per-tab store；后台 settled → 未读徽标。
 */
import { on, cmd } from '@/lib/ipc';
import { liveFor } from '@/lib/live';
import { markSleeping } from '@/lib/sleep';
import { useMessages } from '@/stores/messages';
import { useTodo } from '@/stores/todo';
import { useTabs } from '@/stores/tabs';
import { useDialogs, type UiRequest } from '@/stores/dialogs';
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
         * "只给活动 tab 做视觉，省掉后台的 DOM 工作"）。但实时块的文本就是**内容**：
         * 切走那段时间的增量一丢，切回来时那一轮就缺一段（同一个 tab 内看起来像"流式重启"），
         * 而 DSH 的实时尾部挂在每个会话自己的状态里，不存在"切走就丢字"。
         * 现在的代价只是"往摘出文档的节点上追加文本"（`lib/live` 的 `attach`/`detach`：
         * 没有节点就只累积字符串），没有布局，也没有多余的重渲染。
         */
        liveFor(tabId).handleFrame(frame);
      }),
    );
    un.push(
      await on(`pi:commit:${tabId}`, (ev: { type: string }) => {
        useMessages.getState().applyCommit(tabId, ev);
        // 任务清单走同一条事件流：新一轮清空 / 新写入替换（DSH 的 turn/start 语义）
        useTodo.getState().noteCommit(tabId, ev);
        useTrajectory.getState().appendCommit(tabId, ev);
        if (ev.type === 'bash_execution_update') {
          const b = ev as unknown as { delta?: string };
          useBash.getState().append(tabId, b.delta ?? '');
        }
        if (ev.type === 'agent_settled') {
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
        useTabs
          .getState()
          .setWorkerState(tabId, (st.state ?? 'ready') as never, st);
      }),
    );
    un.push(
      await on(`pi:ui-req:${tabId}`, (req: UiRequest) => {
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
