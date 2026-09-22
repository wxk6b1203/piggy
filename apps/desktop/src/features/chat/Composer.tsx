/**
 * Composer v2（WP3，docs/04 §7）：图片粘贴/拖拽、斜杠补全、队列、Esc 中断还原。
 * 协议语义：流式中发送必须带 streamingBehavior（docs/02 §7.2）。
 */
import { useEffect, useRef, useState } from 'react';
import { message as antdMessage } from 'antd';
import { cmd } from '@/lib/ipc';
import { useTabMsg } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';

interface PendingImage {
  data: string; // base64（无 data: 前缀）
  mimeType: string;
  name: string;
}
interface SlashCommand {
  name: string;
  description?: string;
  source?: string;
}

async function fileToBase64(file: File): Promise<PendingImage> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    data: btoa(binary),
    mimeType: file.type || 'image/png',
    name: file.name || 'image',
  };
}

export function SessionWorkspaceComposer({ tabId }: { tabId: string }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [slash, setSlash] = useState<{ items: SlashCommand[]; query: string } | null>(null);
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const streaming = useTabMsg(tabId, (t) => t.streaming);
  const queue = useTabMsg(tabId, (t) => t.queue);
  const banner = useTabMsg(tabId, (t) => t.banner);

  const send = async (opts?: { behavior?: 'steer' | 'followUp' }) => {
    const value = text.trim();
    if (!value && images.length === 0) return;
    try {
      await cmd<boolean>('pi_prompt', {
        tabId,
        message: value || '（见图片）',
        images: images.map((im) => ({ type: 'image', data: im.data, mimeType: im.mimeType })),
        streamingBehavior: streaming ? (opts?.behavior ?? 'steer') : undefined,
      });
      setText('');
      setImages([]);
      setSlash(null);
    } catch (e) {
      antdMessage.error(String(e));
    }
  };

  const abortAndRestore = async () => {
    if (!streaming) return;
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

  const refreshSlash = (value: string) => {
    const m = /^\/([a-z0-9:_-]*)$/i.exec(value);
    if (!m) {
      setSlash(null);
      return;
    }
    const query = m[1] ?? '';
    if (!commands) {
      void cmd<{ commands: SlashCommand[] }>('pi_get_commands', { tabId })
        .then((r) => setCommands(r.commands ?? []))
        .catch(() => setCommands([]));
      setSlash({ items: [], query });
      return;
    }
    const items = commands
      .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 8);
    setSlash({ items, query });
  };

  const applySlash = (c: SlashCommand) => {
    setText(`/${c.name} `);
    setSlash(null);
    areaRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && slash.items.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        return; // M1：不做键盘选择，点击补全
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlash(null);
        return;
      }
    }
    if (e.key === 'Escape' && streaming) {
      e.preventDefault();
      void abortAndRestore();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      if (slash) {
        e.preventDefault();
        if (slash.items[0]) applySlash(slash.items[0]);
        return;
      }
      if (streaming) return; // 流式中 Enter 不发送（走 Steer/Follow-up 按钮）
      e.preventDefault();
      void send();
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void send({ behavior: e.shiftKey ? 'followUp' : 'steer' });
    }
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const files: File[] = [];
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      const imgs = await Promise.all(files.map(fileToBase64));
      setImages((prev) => [...prev, ...imgs].slice(0, 6));
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      e.preventDefault();
      const imgs = await Promise.all(files.map(fileToBase64));
      setImages((prev) => [...prev, ...imgs].slice(0, 6));
    }
  };

  return (
    <div className="pg-composer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {banner && <div className="pg-composer-banner">{banner}</div>}
      {streaming ? (
        <div className="pg-queuebar">
          <span className="pg-streaming-dot" /> agent 运行中
          {queue.steering.length + queue.followUp.length > 0 && (
            <span>· 排队 {queue.steering.length + queue.followUp.length} 条（Esc 取回并中断）</span>
          )}
        </div>
      ) : null}
      {images.length > 0 && (
        <div className="pg-imgs">
          {images.map((im, i) => (
            <span key={i} className="pg-img-chip" title={im.name}>
              🖼 {im.name}
              <button
                className="pg-img-remove"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="pg-composer-box">
        <textarea
          ref={areaRef}
          className="pg-textarea"
          value={text}
          placeholder={
            streaming
              ? '输入转向指令…（⌘↵ steer / ⌘⇧↵ follow-up / Esc 中断）'
              : '发消息，/ 调用指令，粘贴或拖入图片'
          }
          onChange={(e) => {
            setText(e.target.value);
            refreshSlash(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          rows={Math.min(6, Math.max(1, text.split('\n').length))}
        />
        {slash && slash.items.length > 0 && (
          <div className="pg-slash">
            {slash.items.map((c) => (
              <button key={c.name} className="pg-slash-item" onClick={() => applySlash(c)}>
                <code>/{c.name}</code>
                <span className="pg-slash-desc">{c.description ?? c.source ?? ''}</span>
              </button>
            ))}
          </div>
        )}
      </div>
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
          <button
            className="pg-btn pg-btn-primary"
            disabled={!text.trim() && images.length === 0}
            onClick={() => void send()}
          >
            发送 ↵
          </button>
        )}
      </div>
    </div>
  );
}
