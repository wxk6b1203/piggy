/** 消息渲染器（antd-free，docs/04 §2 铁律）：按 role 分发，内容块轻渲染。
 *
 *  对齐 DSH（docs/12 §3.2/§3.3/§3.11）：
 *  - **没有角色芯片 / 头像 / badge**——身份只靠「右对齐气泡」vs「整宽正文」表达；
 *  - 用户 = `UserStyleBubble`（r22 / padding 10px 16px / 右对齐）；
 *  - 助手 = 整宽 markdown + 结尾操作行（`.actions { margin-top:16px; margin-left:-6px }`）。
 */
import { useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { MessageView } from '@/stores/messages';
import type { AgentMessage, ContentBlock } from '@piggy/pi-protocol';
import { CodeBlock, splitFences } from './CodeBlock';
import { inferToolLang } from './highlight';
import { Icon } from '@/features/common/Icon';
import { ChangedFiles, changedFilesOf } from './ChangedFiles';
import { turnFailure, type TurnFailure } from '@/lib/turnFailure';

export function MessageView({ view }: { view: MessageView }) {
  const m = view.message as AgentMessage & { content?: unknown };
  const role = view.role;
  if (role === 'user') {
    return (
      <div className="pg-user-row">
        <div className="pg-user-stack">
          <div className="pg-bubble">{textOf(m.content)}</div>
        </div>
      </div>
    );
  }
  if (role === 'assistant') {
    const blocks = (Array.isArray(m.content) ? m.content : []) as ContentBlock[];
    const full = textOf(m.content);
    const changed = changedFilesOf(blocks);
    const failure = turnFailure(m);
    return (
      <div className="pg-message pg-assistant">
        <div className="pg-assistant-body">
          {blocks.map((b, i) => (
            <Block key={i} block={b} />
          ))}
        </div>
        {/* 失败/中断回合：pi 用普通 assistant 消息表达（content 为空 + stopReason/errorMessage）。
            没有这块卡片时，整条消息渲染出来是**一片空白**——用户看到的是"发出去没反应"。 */}
        {failure ? <TurnFailureCard failure={failure} /> : null}
        {/* DSH 回合尾：改动文件卡片（docs/12 §3.5） */}
        <ChangedFiles files={changed} />
        {full.trim() ? <MessageActions text={full} message={m} /> : null}
      </div>
    );
  }
  if (role === 'toolResult') {
    const rm = m as { toolName?: string; content?: ContentBlock[]; isError?: boolean };
    const text = textOf(rm.content);
    // 工具结果走**同一个代码卡片**（04 §5.2）：diff 认出来按 diff 上色 + 增删行底色，
    // 跑命令类工具按 shell 上色，其余纯文本 —— 但三者都拿到折叠、行数、复制、超高展开。
    // 旧实现是一个裸 `<pre max-height:240px>`：没有高亮、没有折叠、第 N 行之后够不到。
    const { lang } = inferToolLang(rm.toolName, text);
    return (
      <div className={`pg-message pg-toolresult${rm.isError ? ' pg-error' : ''}`}>
        <div className="pg-role">
          <Icon name={rm.isError ? 'error' : 'check'} size={12} /> {rm.toolName ?? 'tool'}
        </div>
        {text ? <CodeBlock code={text} lang={lang} title={rm.toolName ?? 'tool'} collapsible /> : null}
      </div>
    );
  }
  if (role === 'bashExecution') {
    const bm = m as { command?: string; output?: string; exitCode?: number };
    return (
      <div className="pg-message pg-bash">
        <div className="pg-role">bash → exit {bm.exitCode ?? '?'}</div>
        <div className="pg-cmd">$ {bm.command}</div>
        {bm.output ? (
          <CodeBlock code={bm.output} lang={inferToolLang('bash', bm.output).lang} title="bash" collapsible />
        ) : null}
      </div>
    );
  }
  return null;
}

/**
 * 失败/中断回卡片。
 *
 * 「中断」用中性色、不加 `role="alert"`——那是用户自己按的，不该报警；
 * 「失败」用 `--pg-error` 且 `role="alert"`，读屏会播报。
 * 原始错误文本逐字展示（provider 原话往往直接指出问题），提示只作为"可能原因"另起一行。
 */
function TurnFailureCard({ failure }: { failure: TurnFailure }) {
  const aborted = failure.kind === 'aborted';
  return (
    <div
      className={`pg-turn-failure${aborted ? ' pg-turn-aborted' : ''}`}
      data-kind={failure.kind}
      {...(aborted ? {} : { role: 'alert' })}
    >
      <div className="pg-turn-failure-head">
        <Icon name={aborted ? 'circle-slash' : 'error'} size={13} />
        <span className="pg-turn-failure-title">{failure.title}</span>
      </div>
      {failure.detail ? <pre className="pg-turn-failure-detail">{failure.detail}</pre> : null}
      {failure.hint ? <p className="pg-turn-failure-hint">{failure.hint}</p> : null}
    </div>
  );
}

/** DSH 助手操作行（docs/12 §3.7）：28×28 按钮，默认隐藏、hover 显现（opacity 80ms）。 */
function MessageActions({ text, message }: { text: string; message: AgentMessage }) {
  const [copied, setCopied] = useState(false);
  const ts = (message as { timestamp?: number }).timestamp;

  return (
    <div className="pg-actions">
      <button
        className="pg-action-btn"
        title={copied ? '已复制' : '复制全文'}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1200);
          });
        }}
      >
        <Icon name={copied ? 'check' : 'copy'} size={15} />
      </button>
      {ts ? (
        <time className="pg-action-time" dateTime={new Date(ts).toISOString()}>
          {new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
        </time>
      ) : null}
    </div>
  );
}

function Block({ block }: { block: ContentBlock }) {
  const b = block as {
    type?: string;
    text?: string;
    thinking?: string;
    name?: string;
    arguments?: unknown;
    data?: string;
    mimeType?: string;
    path?: string;
  };
  switch (b.type) {
    case 'text': {
      // 转正阶段（04 §5.2）：围栏代码块 → Shiki 按需高亮，其余保持纯文本
      const segs = splitFences(b.text ?? '');
      return (
        <>
          {segs.map((s, i) =>
            s.kind === 'code' ? (
              <CodeBlock key={i} code={s.code} lang={s.lang} />
            ) : (
              <p key={i} className="pg-text">
                {s.text}
              </p>
            ),
          )}
        </>
      );
    }
    case 'thinking':
      return (
        <details className="pg-thinking">
          <summary>思考</summary>
          <div className="pg-thinking-body">{b.thinking}</div>
        </details>
      );
    case 'toolCall':
      // DSH `AssistantMarkdown` 分派：tool-call **不在正文层渲染**——它归「工具行」
      // （对话里由 toolResult 行表达，全量明细在轨迹视图）。docs/12 §3.3。
      return null;
    case 'image':
      return <ImageBlock block={block} />;
    default:
      // 未知块：透传展示原始 JSON（docs/02 §5.1）
      return (
        <details className="pg-unknown">
          <summary>未知块 {b.type}</summary>
          <pre className="pg-pre">{JSON.stringify(block, null, 2)}</pre>
        </details>
      );
  }
}

/** 图片渲染（04 §5.3、05 §6.4）：大 base64 载荷转 Blob URL（按对象记忆，不重复解码）；
 * 带本地 path 的块走 Tauri asset 协议直读文件。 */
const blobUrlCache = new WeakMap<object, string>();

function ImageBlock({ block }: { block: object }) {
  const b = block as { data?: string; mimeType?: string; path?: string };
  const url = useMemo(() => {
    if (b.path) return undefined; // path 分支在下方经 convertFileSrc 解析
    if (!b.data) return undefined;
    const cached = blobUrlCache.get(block);
    if (cached) return cached;
    try {
      const bin = atob(b.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: b.mimeType ?? 'image/png' }));
      blobUrlCache.set(block, url);
      return url;
    } catch {
      return undefined;
    }
  }, [block, b.data, b.mimeType, b.path]);
  const assetUrl = useMemo(() => {
    if (!b.path) return undefined;
    // Tauri asset 协议（05 §6.4 反 data URI）：本地文件直读，scope 限 $HOME/$TMP
    return convertFileSrc(b.path);
  }, [b.path]);
  const src = url ?? assetUrl;
  if (!src) return null;
  return (
    <img
      className="pg-image"
      src={src}
      alt=""
      loading="lazy"
      onClick={() => window.open(src, '_blank')}
    />
  );
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => ((b as { type?: string })?.type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('');
  }
  return '';
}

