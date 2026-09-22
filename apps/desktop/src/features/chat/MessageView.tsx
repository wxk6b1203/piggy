/** 消息渲染器（antd-free，docs/04 §2 铁律）：按 role 分发，内容块轻渲染 */
import type { MessageView } from '@/stores/messages';
import type { AgentMessage, ContentBlock } from '@piggy/pi-protocol';

export function MessageView({ view }: { view: MessageView }) {
  const m = view.message as AgentMessage & { content?: unknown };
  const role = view.role;
  if (role === 'user') {
    return (
      <div className="pg-message pg-user">
        <div className="pg-role">you</div>
        <div className="pg-bubble">{textOf(m.content)}</div>
      </div>
    );
  }
  if (role === 'assistant') {
    const blocks = (Array.isArray(m.content) ? m.content : []) as ContentBlock[];
    return (
      <div className="pg-message pg-assistant">
        <div className="pg-role">assistant</div>
        {blocks.map((b, i) => (
          <Block key={i} block={b} />
        ))}
      </div>
    );
  }
  if (role === 'toolResult') {
    const rm = m as { toolName?: string; content?: ContentBlock[]; isError?: boolean };
    return (
      <div className={`pg-message pg-toolresult${rm.isError ? ' pg-error' : ''}`}>
        <div className="pg-role">
          {rm.isError ? '✖' : '✔'} {rm.toolName ?? 'tool'} result
        </div>
        <pre className="pg-pre">{textOf(rm.content)}</pre>
      </div>
    );
  }
  if (role === 'bashExecution') {
    const bm = m as { command?: string; output?: string; exitCode?: number };
    return (
      <div className="pg-message pg-bash">
        <div className="pg-role">bash (direct) → exit {bm.exitCode ?? '?'}</div>
        <div className="pg-cmd">$ {bm.command}</div>
        {bm.output ? <pre className="pg-pre">{bm.output}</pre> : null}
      </div>
    );
  }
  return null;
}

function Block({ block }: { block: ContentBlock }) {
  const b = block as { type?: string; text?: string; thinking?: string; name?: string; arguments?: unknown };
  switch (b.type) {
    case 'text':
      return <p className="pg-text">{b.text}</p>;
    case 'thinking':
      return (
        <details className="pg-thinking">
          <summary>◈ thinking</summary>
          <div className="pg-thinking-body">{b.thinking}</div>
        </details>
      );
    case 'toolCall':
      return (
        <div className="pg-toolcall">
          ⚙ <code>{b.name}</code>
          <pre className="pg-pre pg-args">{safeJson(b.arguments)}</pre>
        </div>
      );
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

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => ((b as { type?: string })?.type === 'text' ? (b as { text?: string }).text ?? '' : ''))
      .join('');
  }
  return '';
}

function safeJson(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
