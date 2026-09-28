/** 消息渲染器（antd-free，docs/04 §2 铁律）：按 role 分发，内容块轻渲染。
 *
 *  对齐 DSH（docs/12 §3.2/§3.3/§3.11）：
 *  - **没有角色芯片 / 头像 / badge**——身份只靠「右对齐气泡」vs「整宽正文」表达；
 *  - 用户 = `UserStyleBubble`（r22 / padding 10px 16px / 右对齐）；
 *  - 助手 = 整宽 markdown + 结尾操作行（`.actions { margin-top:16px; margin-left:-6px }`）。
 *
 * 另加压缩行（`compaction`）：分页从会话文件读时，压缩条目是历史里真实存在的一行
 * （docs/03 §2.19），DSH 的对话里同样有「上下文已压缩」。
 */
import { useMemo, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { MessageView } from '@/stores/messages';
import type { AgentMessage, ContentBlock } from '@piggy/pi-protocol';
import { CodeBlock } from './CodeBlock';
import { inferToolLang } from './highlight';
import { Icon } from '@/features/common/Icon';
import { ChangedFiles, changedFilesOf } from './ChangedFiles';
import { DisclosureRow } from '@/features/common/DisclosureRow';
import { Markdown } from './markdown';
import { ToolRow } from './ToolRow';
import { TodoRow } from './TodoRow';
import { useTodoSupported } from '@/stores/todo';
import type { TodoItem } from '@/lib/todoModel';
import { firstLine } from './toolRowModel';
import { turnFailure, type TurnFailure } from '@/lib/turnFailure';
import { formatExactTokens } from '@/lib/tokenFormat';

export function MessageView({
  view,
  call,
  baseline,
}: {
  view: MessageView;
  /** 该行的工具调用参数（`toolCalls[toolCallId]`，见 stores/messages.ts） */
  call?: { name: string; args?: Record<string, unknown> } | undefined;
  /** todo_write 行的**上一份**清单（差异对比；见 lib/todoModel 的 `todoBaselines`） */
  baseline?: TodoItem[] | undefined;
}) {
  const todoOn = useTodoSupported();
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
    const rm = m as { toolName?: string; toolCallId?: string; content?: ContentBlock[]; isError?: boolean };
    const text = textOf(rm.content);
    /* 工具结果 = **一行窄行**（`运行命令 · pnpm test`），展开才是那块代码卡片。
       用户 2026-09-23："多工具消息时主工作区空间利用率非常低，能不能跟 dsh 一样做窄折叠"——
       实测：6 行 read 结果此前占 258px、3 行 bash 占 201px，而 DSH 的一行是 24px（docs/12 §3.3、
       DSH `ToolRow`/`DisclosureRow`）。摘要取自调用参数（store 的 `toolCalls` 索引）。 */
    /* 任务清单（`todo_write`）不是普通工具调用：它是一份**计划**，
       所以渲染成清单行（DSH `TodoRow`）而不是"标题 + 摘要 + 代码块"。
       前提是探测到 todo 插件且已启用 —— 没装插件时与从前一模一样（走通用工具行）。 */
    if (todoOn && rm.toolName === 'todo_write') {
      return (
        <TodoRow
          args={call?.args}
          toolCallId={rm.toolCallId}
          text={text}
          isError={rm.isError === true}
          baseline={baseline}
        />
      );
    }
    return (
      <ToolRow
        toolName={rm.toolName}
        toolCallId={rm.toolCallId}
        args={call?.args}
        isError={rm.isError === true}
        text={text}
      />
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
  // 压缩行（文件里的 `compaction` 条目，docs/03 §2.19）：DSH 的对话里也有这一行
  // （`CompactionItem` / 「上下文已压缩」）。摘要折起来——
  // 它可能很长，但"这儿发生过压缩、当时多少 token"必须一眼看得见。
  //
  // 用户 2026-09-23："上下文压缩的轨迹无法看到细节"——核实后 Rust 侧只转出了
  // summary / tokensBefore / timestamp 三个字段，pi 的 `CompactionEntry` 里的
  // `firstKeptEntryId`（保留边界）/ `details`（读改过哪些文件）/ `usage`（摘要调用用量）
  // / `fromHook` 全被丢掉了。现在都显示出来（Rust 侧同步转出，见 `sessions/transcript.rs`）。
  if (role === 'compaction') {
    const cm = m as {
      summary?: string;
      tokensBefore?: number | null;
      firstKeptEntryId?: string | null;
      fromHook?: boolean | null;
      usage?: { totalTokens?: number | null; cost?: { total?: number | null } | null } | null;
      details?: { readFiles?: string[] | null; modifiedFiles?: string[] | null } | null;
    };
    const readFiles = cm.details?.readFiles ?? [];
    const modifiedFiles = cm.details?.modifiedFiles ?? [];
    const usageTokens = cm.usage?.totalTokens ?? null;
    const cost = cm.usage?.cost?.total ?? null;
    return (
      <div className="pg-message pg-compaction" data-compaction-row>
        <div className="pg-role">
          <Icon name="archive" size={12} /> 上下文已压缩
          {cm.tokensBefore != null ? (
            <span className="pg-compaction-tokens">
              （此前 {formatExactTokens(cm.tokensBefore)} tok）
            </span>
          ) : null}
        </div>
        {/* 这一行是"这次压缩做了什么"的账本：边界 / 文件 / 摘要调用用量。
            全都来自条目本身，没有一项是推算出来的。 */}
        {cm.firstKeptEntryId ? (
          <div className="pg-compaction-meta" data-compaction-kept>
            保留自 <code>{cm.firstKeptEntryId}</code> 起，之前的条目已被摘要取代
          </div>
        ) : null}
        {readFiles.length || modifiedFiles.length ? (
          <div className="pg-compaction-meta" data-compaction-files>
            涉及文件：读 {readFiles.length} / 改 {modifiedFiles.length}
            {modifiedFiles.length ? <span title={modifiedFiles.join('\n')}> · {modifiedFiles.slice(0, 3).join('、')}{modifiedFiles.length > 3 ? ' …' : ''}</span> : null}
          </div>
        ) : null}
        {usageTokens != null || cm.fromHook ? (
          <div className="pg-compaction-meta" data-compaction-usage>
            {usageTokens != null ? `摘要调用 ${formatExactTokens(usageTokens)} tok` : ''}
            {cost != null && cost > 0 ? ` · $${cost.toFixed(4)}` : ''}
            {cm.fromHook ? `${usageTokens != null ? ' · ' : ''}摘要来自扩展` : ''}
          </div>
        ) : null}
        {cm.summary ? (
          <details className="pg-compaction-summary">
            <summary>压缩摘要</summary>
            <div className="pg-thinking-body">
              <Markdown text={cm.summary} compact />
            </div>
          </details>
        ) : null}
      </div>
    );
  }
  return null;
}

/** 思考行的窄行包装：受控展开 + 首行摘要（DSH `message.think`）。 */
function ThinkingRow({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const summary = text ? firstLine(text) : '';
  return (
    <div className="pg-thinkrow" data-thinking-row data-open={open || undefined}>
      <DisclosureRow
        icon={<Icon name="lightbulb" size={14} />}
        title="思考"
        open={open}
        expandable={text !== ''}
        onToggle={() => setOpen((v) => !v)}
        rowClassName="pg-thinkrow-head"
        bodyProps={{ 'data-thinking-body': '1' }}
        collapsedContent={
          summary ? (
            <>
              <span className="pg-trow-sep" aria-hidden="true" />
              <span className="pg-trow-summary" title={summary}>
                {summary}
              </span>
            </>
          ) : null
        }
      >
        <div className="pg-thinking-body">
          <Markdown text={text} compact />
        </div>
      </DisclosureRow>
    </div>
  );
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
    case 'text':
      /* 转正阶段渲染 **Markdown**（04 §5）。
         用户 2026-09-23 的截图：`## 🔴 严重缺陷`、`**默认配置受影响**`、`---` 全是原样文本。
         核实：这一支此前只做 `splitFences()`（围栏 → 代码卡片），其余当纯文本 ——
         docs/04 §5 早就写着"Markdown 只在转正时解析一次"，但那个 parser 一直没落地。
         流式阶段**不变**（仍是纯文本直写：流式中间态的 markdown 是非法文法，逐帧 parse 只会抖）。 */
      return <Markdown key="text" text={b.text ?? ''} />;
    case 'thinking':
      // 思考行也是**窄行**（DSH `DisclosureRow` + `message.think`）：标题「思考」+ 首行摘要，
      // 展开看全文。旧版是 `<details><summary>思考</summary>`——几何与工具行不齐，
      // 而且摘要不显示"想了什么"，一行 24px 的信息量被浪费掉了。
      return <ThinkingRow text={b.thinking ?? ''} />;
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

