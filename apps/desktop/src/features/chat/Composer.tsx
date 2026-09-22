/**
 * Composer（docs/04 §7 M0 版）：
 * Enter 发送 / Shift+Enter 换行；流式中 Cmd+Enter=steer、Cmd+Shift+Enter=follow-up；
 * Esc = clear_queue→回填→abort（docs/02 §7.3 协议推荐流程）。
 */
import { useRef, useState } from 'react';
import { message as antdMessage } from 'antd';
import { cmd } from '@/lib/ipc';
import { useMessages } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';

export function Composer() {
  const [text, setText] = useState('');
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const streaming = useMessages((s) => s.streaming);
  const queue = useMessages((s) => s.queue);
  const tabId = useTabs((s) => s.tabId);

  const send = async (opts?: { behavior?: 'steer' | 'followUp' }) => {
    const value = text.trim();
    if (!value || !tabId) return;
    try {
      await cmd<boolean>('pi_prompt', {
        tabId,
        message: value,
        streamingBehavior: streaming ? (opts?.behavior ?? 'steer') : undefined,
      });
      setText('');
    } catch (e) {
      antdMessage.error(String(e));
    }
  };

  const abortAndRestore = async () => {
    if (!tabId || !streaming) return;
    try {
      const q = await cmd<{ steering: string[]; followUp: string[] }>('pi_clear_queue', { tabId });
      const restored = [...(q.steering ?? []), ...(q.followUp ?? [])].join('\n');
      await cmd('pi_abort', { tabId });
      if (restored) setText(restored);
      antdMessage.info('已中断，排队消息已还原');
    } catch (e) {
      antdMessage.error(String(e));
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && streaming) {
      e.preventDefault();
      void abortAndRestore();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (streaming) return; // 流式中 Enter 不发送（协议要求 streamingBehavior，走按钮）
      e.preventDefault();
      void send();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send({ behavior: e.shiftKey ? 'followUp' : 'steer' });
    }
  };

  return (
    <div className="pg-composer">
      {streaming ? (
        <div className="pg-queuebar">
          <span className="pg-streaming-dot" /> agent 运行中
          {queue.steering.length + queue.followUp.length > 0 && (
            <span>
              · 排队 {queue.steering.length + queue.followUp.length} 条（Esc 取回并中断）
            </span>
          )}
        </div>
      ) : null}
      <textarea
        ref={areaRef}
        className="pg-textarea"
        value={text}
        placeholder={streaming ? '输入转向指令…（⌘↵ steer / ⌘⇧↵ follow-up / Esc 中断）' : '发送消息（Enter），Shift+Enter 换行'}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        rows={Math.min(6, Math.max(1, text.split('\n').length))}
      />
      <div className="pg-composer-actions">
        {streaming ? (
          <>
            <button className="pg-btn" onClick={() => void send({ behavior: 'steer' })}>
              Steer ⌘↵
            </button>
            <button className="pg-btn" onClick={() => void send({ behavior: 'followUp' })}>
              Follow-up ⌘⇧↵
            </button>
            <button className="pg-btn pg-btn-danger" onClick={() => void abortAndRestore()}>
              中断 Esc
            </button>
          </>
        ) : (
          <button className="pg-btn pg-btn-primary" disabled={!text.trim()} onClick={() => void send()}>
            发送 ↵
          </button>
        )}
      </div>
    </div>
  );
}
