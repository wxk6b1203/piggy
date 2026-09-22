/** usePiggy：单 tab 全量事件接线（pi:frame / pi:commit / pi:state / pi:ui-req） */
import { useEffect } from 'react';
import { on } from '@/lib/ipc';
import { live } from '@/lib/live';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { useDialogs, type UiRequest } from '@/stores/dialogs';
import { handleFireAndForget } from '@/features/dialogs/DialogRouter';
import type { Frame } from '@piggy/pi-protocol';

const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

export function usePiggy() {
  const tabId = useTabs((s) => s.tabId);

  // 初始化：发现 pi → 创建 tab → 拉取既有消息
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const snap = await useTabs.getState().init();
        if (cancelled) return;
        const messages = await import('@/lib/ipc').then(({ cmd }) =>
          cmd<{ messages: unknown[] }>('pi_get_messages', { tabId: snap.tab_id }),
        );
        useMessages.getState().hydrate(messages.messages as never[]);
        void useTabs.getState().refreshStats();
      } catch (e) {
        useTabs.setState({ banner: `启动失败：${String(e)}` });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 事件接线（tabId 就绪后）
  useEffect(() => {
    if (!tabId) return;
    const unlistens = [
      on(`pi:frame:${tabId}`, (frame: Frame) => live.handleFrame(frame)),
      on(`pi:commit:${tabId}`, (ev: { type: string }) => {
        useMessages.getState().applyCommit(ev);
        if (ev.type === 'agent_settled') {
          void useTabs.getState().refreshStats();
          void useTabs.getState().refreshState();
        }
      }),
      on(`pi:state:${tabId}`, (st: { state?: string } & Record<string, unknown>) => {
        useTabs.getState().setWorkerState((st.state ?? 'ready') as never, st);
      }),
      on(`pi:ui-req:${tabId}`, (req: UiRequest) => {
        if (DIALOG_METHODS.has(req.method)) useDialogs.getState().push(req);
        else handleFireAndForget(req);
      }),
    ];
    return () => {
      for (const u of unlistens) void u.then((f) => f());
    };
  }, [tabId]);
}
