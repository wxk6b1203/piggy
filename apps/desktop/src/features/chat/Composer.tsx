/**
 * Composer v3（WP3，docs/04 §7 / docs/12 §3.8）：图片粘贴/拖拽、斜杠补全、队列、Esc 中断还原。
 * 呈现层对齐 DSH：圆角卡片（r22）+ 占位行 + 工具行（`+` / 权限胶囊 ｜ 模型胶囊 / 圆形发送）；
 * 状态行与上下文环在卡**下方**的 dock（DSH 无底部状态栏）。
 * 协议语义未改：流式中发送必须带 streamingBehavior（docs/02 §7.2）。
 *
 * 斜杠补全来自**两处**（docs/04 §7.2）：Piggy 内建命令（`lib/slashCommands`，
 * pi 的 `get_commands` 不返回它们）+ pi 的扩展/prompt/skill 命令。
 * 内建命令在提交前被拦下就地执行——否则模型会收到字符串 `/compact`。
 */
import { useEffect, useRef, useState } from 'react';
import { observeComposition } from '@/lib/keyboardComposition';
import { toast } from '@/lib/feedback';
import { cmd } from '@/lib/ipc';
import { fileToPendingImage, type PendingImage } from '@/lib/pendingImage';
import { wakeIfNeeded } from '@/lib/sleep';
import { useMessages, useTabMsg } from '@/stores/messages';
import { useQueue } from '@/stores/queue';
import { useSessionStats } from '@/stores/stats';
import { clampPercent, DECIMALS, formatPercent, formatTokens } from '@/lib/tokenFormat';
import {
  builtinRows,
  dispatchSlashInput,
  isKnownSlashCommand,
  type SlashRow,
} from '@/lib/slashCommands';
import { Icon } from '@/features/common/Icon';
import { ModelPicker } from './ModelPicker';
import { QueueDock } from './QueueDock';
import { TodoPanel } from './TodoPanel';
import { PermissionPicker } from './PermissionPicker';
import { SessionStatusLine } from './SessionStatusLine';

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
  const [slash, setSlash] = useState<{ items: SlashRow[]; query: string; index: number } | null>(null);
  const [commands, setCommands] = useState<SlashRow[] | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);
  /* 输入法合成守卫：监听挂在 document 上（合成事件不一定落在 textarea 上），
     所以在这里建一次、卸载时摘掉。 */
  const [composition] = useState(() => observeComposition(document));
  const slashRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streaming = useTabMsg(tabId, (t) => t.streaming);
  const queueRows = useQueue((s) => s.tabs[tabId]?.rows.length ?? 0);
  const pausedRows = useQueue((s) => s.tabs[tabId]?.paused.length ?? 0);

  /**
   * 发送。三个投递语义（docs/02 §7.2 / docs/04 §7.3）：
   *  - 空闲：普通 `prompt`（不带 `streamingBehavior`）；
   *  - 流式中 `steer`：进 pi 的 steering 队列，下一个步进边界插进**当前**回合；
   *  - 流式中 `followUp`：进 followUp 队列，等这一轮真的结束才成为下一回合。
   *
   * ⚠️ 流式中**必须**带 `streamingBehavior`：pi 对没带的直接报错
   * （`Agent is already processing. Specify streamingBehavior …`，`agent-session.ts:2099`）。
   */
  const send = async (opts?: { behavior?: 'steer' | 'followUp' }) => {
    const value = text.trim();
    if (!value && images.length === 0) return;
    /* 投递语义**必须在 `await` 之前定下来**（2026-10-15 单测逼出来的真 bug）：
       老写法把它放在 `await wakeIfNeeded()` 之后，于是这个窗口里 `streaming` 一翻面，
       `⌘↵`（插话）就被静默降级成入队 —— 用户按的是"立刻插进当前回合"，实际却排在队尾。
       语义是**按手势**决定的，不该被一次 IPC 的往返时间左右。 */
    const live = useMessages.getState().tabs[tabId]?.streaming ?? streaming;
    const behavior = live ? (opts?.behavior ?? 'followUp') : undefined;
    try {
      await wakeIfNeeded(tabId); // 休眠标签：发送即透明唤醒（05 §4.3）
      await useQueue.getState().enqueue(tabId, {
        text: value || '（见图片）',
        images,
        behavior,
      });
      setText('');
      setImages([]);
      setSlash(null);
    } catch (e) {
      toast.error(String(e));
    }
  };

  /**
   * 提交：**先当指令认一遍**，认出来就地执行，认不出才走队列（docs/04 §7.2）。
   *
   * 两条入口（Enter / 发送按钮）都必须走这里——只改一处的话，点按钮发出去的
   * `/compact` 仍然是字符串，模型会一本正经地回答"好的，我来压缩"。
   */
  const submit = async (opts?: { behavior?: 'steer' | 'followUp' }) => {
    const value = text.trim();
    if (value && isKnownSlashCommand(value)) {
      if (await dispatchSlashInput(value, { tabId })) {
        setText('');
        setImages([]);
        setSlash(null);
        return;
      }
    }
    await send(opts);
  };

  /**
   * 空草稿 `⌘/Ctrl+Enter`：把队列里剩下的**全部**插话进当前回合（DSH `steerQueue`）。
   *
   * 逐条**顺序**下发（不是 `Promise.all`）：插话顺序对模型可见，而且并发下发在
   * pi 侧的到达顺序没有保证。中途失败就停在那儿，剩下的仍在队列里。
   */
  const steerAll = async () => {
    const rows = useQueue.getState().tabs[tabId]?.rows ?? [];
    if (rows.length === 0) return;
    for (const row of rows) {
      try {
        await useQueue.getState().enqueue(tabId, {
          text: row.text,
          images: row.images,
          behavior: 'steer',
        });
      } catch (e) {
        toast.error(`插话发送失败，请重试。（${String(e)}）`);
        return;
      }
    }
  };

  /**
   * Esc：只中断这一轮，**不动队列**。
   *
   * 老实现是"中断 + 把队列拼回草稿"（`clear_queue` + `pi_abort`），那是把两件事绑死了：
   * 用户只想让 agent 停下来，结果草稿被覆盖、队列消失。现在队列有自己的一行行 UI
   * （可编辑/取回/插话），中断就只是中断 —— 队列留在 dock 里，由用户决定。
   */
  const abortTurn = async () => {
    if (!streaming) return;
    try {
      await cmd('pi_abort', { tabId });
    } catch (e) {
      toast.error(String(e));
    }
  };

  /**
   * 刷新补全列表：**内建命令（同步可得）+ pi 命令（异步拉一次）**。
   *
   * pi 的 `get_commands` 只给扩展/prompt/skill 命令，内建那 24 条不在协议里
   * （`lib/slashCommands` 顶部有说明），所以列表必须由两边拼起来。
   * 列表异步到齐后要按**当前输入**重算一次，否则这一轮永远只显示半张列表。
   */
  const refreshSlash = (value: string) => {
    const m = /^\/([a-z0-9:_-]*)$/i.exec(value);
    if (!m) {
      setSlash(null);
      return;
    }
    const query = m[1] ?? '';
    const merge = (piRows: SlashRow[]): SlashRow[] => {
      const q = query.toLowerCase();
      const rows = [...builtinRows(query), ...piRows.filter((c) => c.name.toLowerCase().includes(q))];
      return rows.slice(0, MAX_SLASH_ITEMS);
    };
    if (!commands) {
      void cmd<{ commands: SlashRow[] }>('pi_get_commands', { tabId })
        .then((r) => {
          const piRows = r.commands ?? [];
          setCommands(piRows);
          setSlash((cur) => (cur && cur.query === query ? { items: merge(piRows), query, index: 0 } : cur));
        })
        .catch(() => setCommands([]));
      setSlash({ items: merge([]), query, index: 0 });
      return;
    }
    setSlash({ items: merge(commands), query, index: 0 });
  };

  /**
   * 选中补全项。
   *
   * 三种行为（对应 DSH 的 action / argued enter / host command）：
   *  - 内建且**不需要参数** → 立即执行（选中即动作）；
   *  - 内建但需要参数 / 标注暂无入口 → 插入 `/name `，由用户补参数或看解释；
   *  - pi 的扩展/prompt/skill 命令 → 插入 `/name `，**发给 pi 由它解析**（Piggy 不重复实现）。
   */
  const applySlash = (c: SlashRow | undefined) => {
    if (!c) return;
    setSlash(null);
    areaRef.current?.focus();
    if (c.source === 'builtin' && !c.insertOnly) {
      setText('');
      void dispatchSlashInput(`/${c.name}`, { tabId });
      return;
    }
    setText(`/${c.name} `);
  };

  /** ↑↓ 在补全列表里移动选中项（环绕），列表滚到哪就自动把选中项带进视野。 */
  const moveSlash = (delta: number) => {
    setSlash((cur) => {
      if (!cur || cur.items.length === 0) return cur;
      const n = cur.items.length;
      return { ...cur, index: (cur.index + delta + n) % n };
    });
  };

  useEffect(() => () => composition.dispose(), [composition]);

  // 键盘移动后把选中项滚进视野（jsdom 没有 scrollIntoView，测试里跳过）
  useEffect(() => {
    const el = slashRef.current?.querySelector('[data-active="true"]');
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [slash?.index, slash?.query]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    /* 输入法合成期一律不处理按键（`isComposing` 单独用不够：macOS 上确认候选的那次
       keydown 是在 `compositionend` **之后**到达的，`isComposing` 已经是 false ——
       用户报的"中文回车是选择，消息却发出去了"就是它）。见 `lib/keyboardComposition`。 */
    if (composition.guards(e.nativeEvent)) return;
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
      if (e.key === 'Tab' || e.key === 'Enter') {
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
      void abortTurn();
      return;
    }
    /* ── 手势表（docs/04 §7.3，对齐 DSH `submission-policy`）──
       空闲：`↵` 发送 ／ `⌘↵` 也是发送（DSH 空闲时两个手势同义）。
       流式中：`↵` **入队**（默认 busyEnter='queue'，老实现是"按了没反应"）；
              `⌘↵` 立刻插话（steer）；`⌘⇧↵` 显式追加（followUp，等这一轮结束）。 */
    const accelerated = e.metaKey || e.ctrlKey;
    /* ⚠️ 这里**不能**再写 `!e.shiftKey`（2026-10-15 单测逼出来的真 bug）：
       带上它之后 `⌘⇧↵` 既不满足这一支、也不满足下面那支（下面那支要求不带 shift），
       于是这个**文档里写着的手势**在流式中什么都不做 —— 静默失效。
       现在只按"有没有加速键"分：⌘↵ 插话、⌘⇧↵ 追加、裸 ↵ 入队。 */
    if (e.key === 'Enter' && accelerated) {
      e.preventDefault();
      // 空草稿的 ⌘↵ = 把队列全部插话（DSH `steerQueue`）—— 队列非空时优先它
      if (text.trim() === '' && images.length === 0 && streaming && queueRows + pausedRows > 0) {
        void steerAll();
        return;
      }
      void submit({ behavior: e.shiftKey ? 'followUp' : 'steer' });
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // 内建指令在流式中**照样就地执行**（`/compact` 是客户端调用，不是插进回合的消息）；
      // 其余一律入队（pi 侧 `streamingBehavior:'followUp'`）。
      e.preventDefault();
      void submit();
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
      const imgs = await Promise.all(files.map(fileToPendingImage));
      setImages((prev) => [...prev, ...imgs].slice(0, 6));
    }
  };

  const onDrop = async (e: React.DragEvent) => {
    const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
    if (files.length > 0) {
      e.preventDefault();
      const imgs = await Promise.all(files.map(fileToPendingImage));
      setImages((prev) => [...prev, ...imgs].slice(0, 6));
    }
  };

  return (
    <div className="pg-composer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
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
      {/* 计划面板（DSH `TodoPanel` @ `conversation.input.dock`）：
          DSH 渲染这个槽就在输入卡**正上方**（ConversationContent.tsx:155-161 先 dock 再 inputBar），
          这里保持同一位置。没有 todo 能力时组件自己返回 null。 */}
      <TodoPanel tabId={tabId} />
      {/* 等待队列（DSH `QueueDock` @ 同一个 dock 槽，order 20 —— docs/04 §7.3）。
          空队列自己返回 null，所以这里不需要条件渲染。 */}
      <QueueDock tabId={tabId} running={streaming} />

      <div className="pg-composer-card">
        <div className="pg-composer-box">
          <textarea
            ref={areaRef}
            className="pg-composer-input"
            value={text}
            placeholder={composerPlaceholder({
              streaming,
              empty: text.trim() === '' && images.length === 0,
              queued: queueRows + pausedRows,
              paused: pausedRows,
            })}
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
                  key={`${c.source ?? ''}:${c.name}`}
                  className="pg-slash-item"
                  data-active={i === slash.index || undefined}
                  data-source={c.unsupported ? 'pi-builtin' : (c.source ?? 'pi')}
                  role="option"
                  aria-selected={i === slash.index}
                  onMouseEnter={() =>
                    setSlash((cur) => (cur && cur.index !== i ? { ...cur, index: i } : cur))
                  }
                  onClick={() => applySlash(c)}
                >
                  <code>
                    /{c.name}
                    {c.argumentHint ? <span className="pg-slash-arg"> {c.argumentHint}</span> : null}
                  </code>
                  <span className="pg-slash-desc">{c.description ?? ''}</span>
                  <span className="pg-slash-src" data-src={c.unsupported ? 'pi-builtin' : (c.source ?? 'pi')}>
                    {c.unsupported ? 'pi 内建 · 暂无入口' : c.source === 'builtin' ? '内建' : (c.source ?? 'pi')}
                  </span>
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
                  const imgs = await Promise.all(files.map(fileToPendingImage));
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
                {/* 流式中两个投递语义的**显式**入口（手势之外的等价路径：⌘↵ / ⌘⇧↵）。
                    普通 ↵ 只入队（DSH 默认 busyEnter='queue'），所以按钮上写明各自的去向。 */}
                <button
                  className="pg-pill pg-pill-action"
                  onClick={() => void send({ behavior: 'steer' })}
                  title="插话发送：下一个步进边界插进当前回合（⌘↵）"
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
                  onClick={() => void abortTurn()}
                  title="中断这一轮（Esc）—— 队列留在下面，不会被清掉"
                >
                  <Icon name="debug-stop" size={14} />
                </button>
              </>
            ) : null}
            <ModelPicker tabId={tabId} />
            <button
              className="pg-send-btn"
              data-send-mode={streaming ? (text.trim() ? 'queue' : 'stop') : 'send'}
              disabled={!text.trim() && images.length === 0}
              onClick={() => void submit()}
              title={
                !streaming
                  ? '发送（↵）'
                  : text.trim()
                    ? '排队发送：等这一轮结束再发（↵）；插话发送用 ⌘↵'
                    : '把队列里的消息全部插话发送（⌘↵）'
              }
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
 *
 * 环上的百分数保持 DSH 的整数口径（它表达的是"还剩多少余量"），
 * 而 title 里的**上下文占用**按 3 位小数展示（lib/tokenFormat）。
 *
 * ⚠️ 两个数都必须过 `formatPercent`：pi 给的是 f64 商，直接拼模板串会把
 * `20.316000000000003` 这样的 IEEE-754 尾巴印在界面上（用户 2026-09-23 报的就是这条）。
 */
function ContextMeter({ tabId }: { tabId: string }) {
  const stats = useSessionStats(tabId);
  const pct = stats?.contextUsage?.percent;
  if (pct == null) return null;

  const value = clampPercent(pct);
  const C = 2 * Math.PI * 5.5;
  const title = `上下文占用 ${formatPercent(value, DECIMALS)}%（${formatTokens(stats?.contextUsage?.tokens)} / ${formatTokens(stats?.contextUsage?.contextWindow)}）`;

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
      <span>{formatPercent(value, 0)}%</span>
    </button>
  );
}

/**
 * 输入框占位文案（DSH `InputBar` 的 placeholder 优先级，docs/12 §3.8）。
 *
 * 优先级（第一个命中就用它）：
 *   1. **空草稿 + 队列非空 + 运行中** → `⌘↵` 会把队列全部插话，这句话必须说出来
 *      （DSH 里这是 `placeholder.steerQueue` 唯一的存在理由：这个手势没有任何别的发现入口）；
 *   2. 运行中（草稿非空）→ 说明 ↵ 是入队、⌘↵ 是插话；
 *   3. 空闲 → 默认文案。
 *
 * ⚠️ 老实现里这条提示是错的（`输入转向指令…（⌘↵ steer / ⌘⇧↵ follow-up / Esc 中断）`），
 * 而那时 **Enter 在流式中是空操作** —— 文案承诺了一个不存在的通道。
 */
function composerPlaceholder(o: {
  streaming: boolean;
  empty: boolean;
  queued: number;
  paused: number;
}): string {
  if (o.streaming && o.empty && o.queued > 0) {
    return o.paused > 0
      ? `⌘/Ctrl+Enter 插话发送队列里的 ${o.queued} 条（其中 ${o.paused} 条已暂停）`
      : 'Cmd/Ctrl+Enter 插话发送全部排队消息';
  }
  if (o.streaming) return '回车入队等这一轮结束；⌘/Ctrl+回车立刻插话，Esc 中断';
  return '发消息或创建任务, / 调用指令, @ 文件或对话';
}
