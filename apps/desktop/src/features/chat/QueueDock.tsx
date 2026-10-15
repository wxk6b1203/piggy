/**
 * 等待队列 dock（对齐 DSH `QueueDock.tsx`，docs/12 §3.8）：输入卡**正上方**的那一条。
 *
 * ## 与 DSH 的差异（都是 pi 的能力边界决定的，不是偷懒）
 *
 * | DSH | 这里 | 为什么 |
 * |---|---|---|
 * | 每行 `edit` / `remove` / `steer` 三个动作，host 按 `MessageId` 原地改 | 「编辑 / 取回 / 插话」 | pi 队列**没有 id、没有任何按条操作**；唯一的内容读取口是破坏性的 `clear_queue` |
 * | 行有 `queued` / `steering` 两种悬挂态 | 只有一种：行在队列里 | pi 没有"已插话但未落转录"的权威态，编一个出来只会骗人 |
 * | 折叠头显示 "N queued messages" | 同款，外加「已暂停 N 条」 | 「取回」之后那批**已经不在 pi 的队列里**，必须一眼看出来 |
 * | 破坏性动作走 host 的 toast/notice | 行内二次确认条（chat 子树禁 antd） | 两个动作都**不可撤销**，不能点错就没了 |
 *
 * ## 「取回」为什么必须带走尾巴
 *
 * pi 的队列只能整清（`clear_queue` 返回清掉的 `{steering, followUp}`，`agent-session.ts:2427`）。
 * 要改/删中间某一条、又不想把后面的顺序搞乱，唯一诚实的做法就是：
 * **把这一条和它后面的全部取回、缓存在本地，用户改完再按原序放回**。
 * 所以文案里永远写明"还带走了几条"，并且第一次点的时候要确认。
 */
import { useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/feedback';
import { Icon } from '@/features/common/Icon';
import { useQueue, type QueueRow } from '@/stores/queue';

/** 空队列的稳定引用（见组件里 `?? EMPTY_ROWS` 的注释）。 */
const EMPTY_ROWS: QueueRow[] = [];

/** 预览截断长度（DSH `QUEUE_PREVIEW_CHARS`，按**码点**数）。 */
const PREVIEW_CHARS = 200;

function previewOf(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : flat;
}

/** 行内确认条要问的事（两个破坏性动作共用同一条）。 */
type Pending =
  | { kind: 'take'; id: string; extra: number }
  | { kind: 'clear'; count: number };

export function QueueDock({ tabId, running }: { tabId: string; running: boolean }) {
  const q = useQueue((s) => s.tabs[tabId]);
  const store = useQueue.getState();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  /** 编辑是从"队列里"点开的：取消时要把这次取回原样放回去 */
  const [editTook, setEditTook] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  /* ⚠️ 空数组要**复用同一个常量**：每渲染新建 `[]` 会让下面依赖 `paused` 的 effect
     每次渲染都重跑（eslint 的 `react-hooks/exhaustive-deps` 会当场点名）。 */
  const rows = q?.rows ?? EMPTY_ROWS;
  const paused = q?.paused ?? EMPTY_ROWS;
  const busy = q?.busy ?? false;
  const taking = q?.taking ?? false;
  const total = rows.length + paused.length;
  const foreign = rows.filter((r) => r.ownership === 'foreign').length;
  const isPaused = (id: string): boolean => paused.some((p) => p.id === id);

  useEffect(() => {
    if (total === 0) {
      setEditing(null);
      setPending(null);
    }
  }, [total]);
  // 编辑态只在"这一行还在"时保留
  useEffect(() => {
    if (editing && !paused.some((r) => r.id === editing.id)) setEditing(null);
  }, [editing, paused]);
  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  if (total === 0) return null;

  /* 折叠只对 >1 行有意义；编辑/事务/确认条进行中强制展开（否则"点了编辑却看不见编辑框"）。 */
  const interaction = editing !== null || taking || busy || pending !== null;
  const expanded = !(q?.collapsed ?? true) || interaction;
  const listVisible = total === 1 || expanded;

  const doTake = async (row: QueueRow) => {
    const r = await store.take(tabId, row.id);
    if (!r.ok) {
      toast.error(`取回失败：${r.error}`);
      return;
    }
    if (r.delivered > 0) toast.info(`有 ${r.delivered} 条已经开始发送，没能取回（它们会照常发出）`);
    if (r.foreign > 0) toast.info(`另外 ${r.foreign} 条不是 Piggy 排的（插件注入），已一并取回暂存`);
  };

  const onTake = (row: QueueRow) => {
    const i = rows.findIndex((r) => r.id === row.id);
    const extra = rows.length - i - 1;
    if (extra > 0) {
      setPending({ kind: 'take', id: row.id, extra });
      return;
    }
    void doTake(row);
  };

  const onOpenEdit = async (row: QueueRow) => {
    const wasQueued = !isPaused(row.id);
    if (wasQueued) {
      const i = rows.findIndex((r) => r.id === row.id);
      const extra = rows.length - i - 1;
      // 编辑一条"还在 pi 队列里"的行 = 先取回（连带尾巴），再就地改
      const r = await store.take(tabId, row.id);
      if (!r.ok) {
        toast.error(`取回失败：${r.error}`);
        return;
      }
      if (extra > 0) toast.info(`连同后面 ${extra} 条一起取回暂存，改完会按原序放回`);
      if (r.delivered > 0) toast.info(`有 ${r.delivered} 条已经开始发送，没能取回`);
    }
    setEditTook(wasQueued);
    setEditing({ id: row.id, text: row.text });
  };

  const onSaveEdit = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (text === '') return;
    store.editPaused(tabId, editing.id, text);
    setEditing(null);
    setEditTook(false);
    // 改完直接按原序放回（一次 Enter 到底；DSH 的编辑也是"存了就生效"）
    const r = await store.putBack(tabId);
    if (!r.ok) toast.error(r.error);
  };

  const onCancelEdit = async () => {
    setEditing(null);
    if (editTook) {
      setEditTook(false);
      const r = await store.putBack(tabId);
      if (!r.ok) toast.error(r.error);
    }
  };

  const onSteer = async (row: QueueRow) => {
    try {
      /* 「插话」= 让它立刻进当前回合：改用 steering 队列下发同一条内容。
         只管发 —— pi 的 `queue_update` 会告诉我们这一条已经不在 followUp 队列里了
         （下一帧就对账掉）。**不做**"自己先摘再发"：中间失败会让消息两头都不在。 */
      await store.enqueue(tabId, { text: row.text, images: row.images, behavior: 'steer' });
    } catch (e) {
      toast.error(`插话发送失败：${String(e)}`);
    }
  };

  const onConfirm = async () => {
    const p = pending;
    setPending(null);
    if (!p) return;
    if (p.kind === 'take') {
      const row = rows.find((r) => r.id === p.id);
      if (row) await doTake(row);
      return;
    }
    try {
      await store.clearAll(tabId);
    } catch (e) {
      toast.error(`清空失败：${String(e)}`);
    }
  };

  const headCount = `${rows.length} 条排队消息${paused.length > 0 ? ` · ${paused.length} 条已暂停` : ''}`;

  return (
    <div className="pg-queue" data-queue-dock="">
      {pending && (
        <div className="pg-queue-confirm" role="alert" data-queue-confirm="">
          <Icon name="alert" size={13} />
          <span>
            {pending.kind === 'take'
              ? `取回会连同后面 ${pending.extra} 条一起暂存（放回时按原序）`
              : `清空会丢弃全部 ${pending.count} 条待发消息，不可撤销`}
          </span>
          <button type="button" className="pg-queue-act-text" data-confirm-ok="" onClick={() => void onConfirm()}>
            确定
          </button>
          <button type="button" className="pg-queue-act-text" data-confirm-cancel="" onClick={() => setPending(null)}>
            取消
          </button>
        </div>
      )}
      {total > 1 && (
        <div className="pg-queue-head">
          <button
            type="button"
            className="pg-queue-head-toggle"
            aria-expanded={expanded}
            aria-label={headCount}
            disabled={editing !== null || taking}
            onClick={() => store.touch(tabId, { collapsed: !(q?.collapsed ?? true) })}
          >
            <Icon name="list-ordered" size={12} />
            <span>{headCount}</span>
            <Icon name={expanded ? 'chevron-down' : 'chevron-up'} size={14} />
          </button>
          {paused.length > 0 && (
            <button
              type="button"
              className="pg-queue-act-text"
              data-continue=""
              title="按原序把已暂停的那些放回队列"
              disabled={taking || editing !== null}
              onClick={() => {
                void store.putBack(tabId).then((r) => {
                  if (!r.ok) toast.error(r.error);
                  else toast.success('已按原序放回队列');
                });
              }}
            >
              继续发送
            </button>
          )}
          <button
            type="button"
            className="pg-queue-act"
            data-clear=""
            aria-label="清空全部待发消息"
            title="清空全部待发消息（含已暂停的）"
            disabled={taking || editing !== null}
            onClick={() => setPending({ kind: 'clear', count: total })}
          >
            <Icon name="trash" size={13} />
          </button>
        </div>
      )}
      {listVisible && (
        <ul className="pg-queue-list" data-queue-list="">
          {[...paused, ...rows].map((row) => (
            <QueueRowView
              key={row.id}
              row={row}
              paused={isPaused(row.id)}
              running={running}
              busy={busy || taking}
              editing={editing?.id === row.id ? editing : null}
              editRef={editRef}
              onEditText={(text) => setEditing({ id: row.id, text })}
              onOpenEdit={() => void onOpenEdit(row)}
              onCancelEdit={() => void onCancelEdit()}
              onSaveEdit={() => void onSaveEdit()}
              onTake={() => onTake(row)}
              onDrop={() => store.dropPaused(tabId, row.id)}
              onSteer={() => void onSteer(row)}
            />
          ))}
        </ul>
      )}
      {foreign > 0 && (
        <div className="pg-queue-note" data-foreign-note="">
          其中 {foreign} 条不是 Piggy 排的（插件注入）；pi 的 clear_queue 会连它们一起清掉
        </div>
      )}
    </div>
  );
}

function QueueRowView({
  row,
  paused,
  running,
  busy,
  editing,
  editRef,
  onEditText,
  onOpenEdit,
  onCancelEdit,
  onSaveEdit,
  onTake,
  onDrop,
  onSteer,
}: {
  row: QueueRow;
  paused: boolean;
  running: boolean;
  busy: boolean;
  editing: { id: string; text: string } | null;
  editRef: React.RefObject<HTMLTextAreaElement | null>;
  onEditText: (text: string) => void;
  onOpenEdit: () => void;
  onCancelEdit: () => void;
  onSaveEdit: () => void;
  onTake: () => void;
  onDrop: () => void;
  onSteer: () => void;
}) {
  const disabled = busy;
  return (
    <li
      className="pg-queue-row"
      data-paused={paused || undefined}
      data-foreign={row.ownership === 'foreign' || undefined}
    >
      {editing ? (
        <>
          <textarea
            ref={editRef}
            className="pg-queue-edit"
            aria-label="编辑排队消息"
            value={editing.text}
            rows={1}
            onChange={(e) => onEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSaveEdit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                onCancelEdit();
              }
            }}
          />
          <span className="pg-queue-actions">
            <button
              type="button"
              className="pg-queue-act"
              aria-label="保存排队消息"
              disabled={disabled || editing.text.trim() === ''}
              onClick={onSaveEdit}
            >
              <Icon name="check" size={13} />
            </button>
            <button type="button" className="pg-queue-act" aria-label="取消编辑" disabled={disabled} onClick={onCancelEdit}>
              <Icon name="close" size={13} />
            </button>
          </span>
        </>
      ) : (
        <>
          {row.images.length > 0 && (
            <span className="pg-queue-thumbs" aria-label="排队消息图片">
              {row.images.map((im, i) => (
                <img
                  key={i}
                  className="pg-queue-thumb"
                  src={`data:${im.mimeType};base64,${im.data}`}
                  alt={im.name}
                />
              ))}
            </span>
          )}
          <span className="pg-queue-text">
            {previewOf(row.text)}
            {paused && <span className="pg-queue-badge">已暂停</span>}
            {row.ownership === 'foreign' && <span className="pg-queue-badge pg-queue-badge-foreign">插件</span>}
          </span>
          <span className="pg-queue-actions">
            <button
              type="button"
              className="pg-queue-act"
              data-edit=""
              aria-label="编辑排队消息"
              title="取回编辑（会连同后面几条一起暂存）"
              disabled={disabled}
              onClick={onOpenEdit}
            >
              <Icon name="edit" size={13} />
            </button>
            {paused ? (
              <button
                type="button"
                className="pg-queue-act"
                data-drop=""
                aria-label="删除排队消息"
                title="删除这一条（不放回）"
                disabled={disabled}
                onClick={onDrop}
              >
                <Icon name="trash" size={13} />
              </button>
            ) : (
              <button
                type="button"
                className="pg-queue-act"
                data-take=""
                aria-label="取回排队消息"
                title="取回暂存（第 2 条起会连同后面的尾巴一起取回）"
                disabled={disabled}
                onClick={onTake}
              >
                <Icon name="history" size={13} />
              </button>
            )}
            <button
              type="button"
              className="pg-queue-act"
              data-steer=""
              aria-label="插话发送"
              title={running ? '插话发送：下一个步进边界插进当前回合' : '仅运行中可插话发送'}
              disabled={disabled || !running || paused || row.ownership === 'foreign'}
              onClick={onSteer}
            >
              <Icon name="send" size={13} />
            </button>
          </span>
        </>
      )}
    </li>
  );
}
