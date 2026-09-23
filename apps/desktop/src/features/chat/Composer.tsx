/**
 * Composer v3（WP3，docs/04 §7 / docs/12 §3.8）：图片粘贴/拖拽、斜杠补全、队列、Esc 中断还原。
 * 呈现层对齐 DSH：圆角卡片（r22）+ 占位行 + 工具行（`+` / 权限胶囊 ｜ 模型胶囊 / 圆形发送）；
 * 状态行与上下文环在卡**下方**的 dock（DSH 无底部状态栏）。
 * 协议语义未改：流式中发送必须带 streamingBehavior（docs/02 §7.2）。
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/feedback';
import { cmd } from '@/lib/ipc';
import { wakeIfNeeded } from '@/lib/sleep';
import { useTabMsg } from '@/stores/messages';
import { useTabs } from '@/stores/tabs';
import { useSessionStats } from '@/stores/stats';
import { Icon } from '@/features/common/Icon';
import { ModelPicker } from './ModelPicker';
import { PermissionPicker } from './PermissionPicker';
import { SessionStatusLine } from './SessionStatusLine';

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

/**
 * 补全列表一次最多放多少条。
 *
 * 这里**不是**可见行数（可见高度由 CSS `max-height` 决定、超出可滚动）。
 * 曾经的 `.slice(0, 8)` 把 8 当成了"看得见的条数"，于是第 9 条以后**根本不在 DOM 里**：
 * 列表既滚不动、也没有键盘导航（↑↓ 被 preventDefault 掉却不做任何事），
 * 用户装了 pi-subagents 后命令变多，第一屏之后的命令就再也够不着了。
 */
const MAX_SLASH_ITEMS = 200;

export function SessionWorkspaceComposer({ tabId }: { tabId: string }) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [slash, setSlash] = useState<{ items: SlashCommand[]; query: string; index: number } | null>(null);
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  const slashRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streaming = useTabMsg(tabId, (t) => t.streaming);
  const queue = useTabMsg(tabId, (t) => t.queue);
  const banner = useTabMsg(tabId, (t) => t.banner);

  const send = async (opts?: { behavior?: 'steer' | 'followUp' }) => {
    const value = text.trim();
    if (!value && images.length === 0) return;
    try {
      await wakeIfNeeded(tabId); // 休眠标签：发送即透明唤醒（05 §4.3）
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
      toast.error(String(e));
    }
  };

  const abortAndRestore = async () => {
    if (!streaming) return;
    try {
      const q = await cmd<{ steering: string[]; followUp: string[] }>('pi_clear_queue', { tabId });
      const restored = [...(q.steering ?? []), ...(q.followUp ?? [])].join('\n');
      await cmd('pi_abort', { tabId });
      if (restored) setText(restored);
      toast.info('已中断，排队消息已还原');
    } catch (e) {
      toast.error(String(e));
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
        .then((r) => {
          setCommands(r.commands ?? []);
          // 命令列表是异步到的：到了之后要按当前输入重算一次，否则这一轮永远只显示空列表
          const items = (r.commands ?? [])
            .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
            .slice(0, MAX_SLASH_ITEMS);
          setSlash((cur) => (cur && cur.query === query ? { items, query, index: 0 } : cur));
        })
        .catch(() => setCommands([]));
      setSlash({ items: [], query, index: 0 });
      return;
    }
    const items = commands
      .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
      .slice(0, MAX_SLASH_ITEMS);
    setSlash({ items, query, index: 0 });
  };

  const applySlash = (c: SlashCommand | undefined) => {
    if (!c) return;
    setText(`/${c.name} `);
    setSlash(null);
    areaRef.current?.focus();
  };

  /** ↑↓ 在补全列表里移动选中项（环绕），列表滚到哪就自动把选中项带进视野。 */
  const moveSlash = (delta: number) => {
    setSlash((cur) => {
      if (!cur || cur.items.length === 0) return cur;
      const n = cur.items.length;
      return { ...cur, index: (cur.index + delta + n) % n };
    });
  };

  // 键盘移动后把选中项滚进视野（jsdom 没有 scrollIntoView，测试里跳过）
  useEffect(() => {
    const el = slashRef.current?.querySelector('[data-active="true"]');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [slash?.index, slash?.query]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && slash.items.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        moveSlash(1);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        moveSlash(-1);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.nativeEvent.isComposing)) {
        e.preventDefault();
        applySlash(slash.items[slash.index] ?? slash.items[0]);
        return;
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
              <Icon name="file-media" size={12} /> {im.name}
              <button
                className="pg-img-remove"
                onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* DSH 输入卡（docs/12 §3.8）：占位行 + 工具行同处一个 r22 卡 */}
      <div className="pg-composer-card">
        <div className="pg-composer-box">
          <textarea
            ref={areaRef}
            className="pg-composer-input"
            value={text}
            placeholder={
              streaming
                ? '输入转向指令…（⌘↵ steer / ⌘⇧↵ follow-up / Esc 中断）'
                : '发消息或创建任务, / 调用指令, @ 文件或对话'
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
            <div className="pg-slash" ref={slashRef} role="listbox" aria-label="指令补全">
              {slash.items.map((c, i) => (
                <button
                  key={c.name}
                  className="pg-slash-item"
                  data-active={i === slash.index || undefined}
                  role="option"
                  aria-selected={i === slash.index}
                  onMouseEnter={() =>
                    setSlash((cur) => (cur && cur.index !== i ? { ...cur, index: i } : cur))
                  }
                  onClick={() => applySlash(c)}
                >
                  <code>/{c.name}</code>
                  <span className="pg-slash-desc">{c.description ?? c.source ?? ''}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="pg-composer-tools">
          <div className="pg-composer-tools-left">
            {/* DSH 只有 `+`；`@` / `/` 是输入框内的触发符，不是按钮（docs/12 §3.8） */}
            <button
              className="pg-composer-add"
              title="添加文件或调用指令"
              aria-haspopup="listbox"
              onClick={() => {
                setText((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}/`);
                areaRef.current?.focus();
              }}
            >
              <Icon name="add" size={14} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              hidden
              onChange={async (e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length) {
                  const imgs = await Promise.all(files.map(fileToBase64));
                  setImages((prev) => [...prev, ...imgs].slice(0, 6));
                }
                e.target.value = '';
              }}
            />
            <span className="pg-composer-sep" aria-hidden="true" />
            <PermissionPicker tabId={tabId} />
          </div>

          <div className="pg-composer-tools-right">
            {streaming ? (
              <>
                <button
                  className="pg-pill pg-pill-action"
                  onClick={() => void send({ behavior: 'steer' })}
                  title="打断当前回合并立即插入（⌘↵）"
                >
                  转向
                </button>
                <button
                  className="pg-pill pg-pill-action"
                  onClick={() => void send({ behavior: 'followUp' })}
                  title="等当前回合结束后追加（⌘⇧↵）"
                >
                  追加
                </button>
                <button
                  className="pg-round-btn pg-round-danger"
                  onClick={() => void abortAndRestore()}
                  title="中断并取回排队消息（Esc）"
                >
                  <Icon name="debug-stop" size={14} />
                </button>
              </>
            ) : null}
            <ModelPicker tabId={tabId} />
            <button
              className="pg-send-btn"
              disabled={!text.trim() && images.length === 0}
              onClick={() => void send()}
              title="发送（↵）"
            >
              <Icon name="arrow-up" size={16} />
            </button>
          </div>
        </div>
      </div>

      {/* DSH dock（docs/12 §3.8/§3.9）：状态行 + 上下文环，位于输入卡**下方** */}
      <div className="pg-composer-dock">
        <SessionStatusLine tabId={tabId} />
        <ContextMeter tabId={tabId} />
      </div>
    </div>
  );
}

/**
 * 上下文环（DSH `ContextMeter.tsx`，docs/12 §3.10）：几何照抄——
 * viewBox 0 0 14 14、r=5.5、C=2π·5.5、rotate(-90 7 7)；容量缺失时 DSH 返回 null，此处同。
 */
function ContextMeter({ tabId }: { tabId: string }) {
  const stats = useSessionStats(tabId);
  const pct = stats?.contextUsage?.percent;
  if (pct == null) return null;

  const value = Math.max(0, Math.min(100, pct));
  const C = 2 * Math.PI * 5.5;
  const title = `上下文占用 ${value}%（${fmtTokens(stats?.contextUsage?.tokens)} / ${fmtTokens(stats?.contextUsage?.contextWindow)}）`;

  return (
    <button className="pg-ctx-meter" title={title} aria-label={title}>
      <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
        <g transform="rotate(-90 7 7)">
          <circle className="pg-ctx-track" cx="7" cy="7" r="5.5" />
          <circle
            className="pg-ctx-fill"
            cx="7"
            cy="7"
            r="5.5"
            strokeDasharray={`${(C * value) / 100} ${C}`}
          />
        </g>
      </svg>
      <span>{value}%</span>
    </button>
  );
}

function fmtTokens(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
