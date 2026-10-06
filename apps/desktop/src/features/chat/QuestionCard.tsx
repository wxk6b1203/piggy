/**
 * 提问卡（docs/06 §7，对标 DSH 的 `ask_user_question` 卡）。
 *
 * ## 它为什么长在**工具行**里
 *
 * 提问是插件的一个工具调用（`ask_user_question`），参数里就是结构与选项，工具结果里
 * 是用户的回答 —— 也就是说这一问一答**本来就在转录里**。再弹一个 modal 只会把内容
 * 从会话里撕出去（滚回去看不见"当时问了什么、答了什么"），所以卡片直接渲染在工具行
 * 的位置上：未答时可交互，答完变成只读的问答记录。
 *
 * ## 谁把回答送回去
 *
 * `answer()` → `ui_reply` → pi 把值交回插件的 `ui.select` → 插件返回工具结果。
 * 待答请求由 `stores/questions.ts` 按 `toolCallId` 存着（请求从 `pi:ui-req` 来）。
 * 中断/换轮时请求已经没了，卡片应当退回只读（见下面的 `pending` 判断）。
 */
import { useMemo, useState } from 'react';
import { Icon } from '@/features/common/Icon';
import { cmd } from '@/lib/ipc';
import { toast } from '@/lib/feedback';
import { useQuestions } from '@/stores/questions';
import { useTabMsg, type ToolResultView } from '@/stores/messages';

interface Option {
  label: string;
  description?: string;
}

interface Question {
  id: string;
  header: string;
  question: string;
  options: Option[];
  multiSelect: boolean;
  allowCustom: boolean;
}

/** 一条回答（与 `pi-ask/lib.js` 的 `renderAnswers` 同一形状）。 */
interface Answer {
  id: string;
  selected: string[];
  custom: string;
}

/**
 * 参数 → 卡片数据（与插件的 `normalizeQuestions` 同一口径；参数是模型给的，得防脏）。
 *
 * @param args - 工具调用参数
 * @returns 问题数组
 */
export function questionsOf(args: Record<string, unknown> | undefined): Question[] {
  const raw = args?.questions;
  const list = Array.isArray(raw) ? raw : [];
  const out: Question[] = [];
  for (const item of list.slice(0, 6)) {
    const q = item as Record<string, unknown>;
    const question = typeof q?.question === 'string' ? q.question.trim() : '';
    if (question === '') continue;
    const options: Option[] = (Array.isArray(q.options) ? q.options : [])
      .map((o) => {
        const opt = o as Record<string, unknown>;
        return {
          label: typeof opt?.label === 'string' ? opt.label.trim() : '',
          ...(typeof opt?.description === 'string' && opt.description.trim() !== ''
            ? { description: opt.description.trim() }
            : {}),
        };
      })
      .filter((o) => o.label !== '')
      .slice(0, 8);
    out.push({
      id: typeof q.id === 'string' && q.id.trim() !== '' ? q.id.trim() : `q${out.length + 1}`,
      header: typeof q.header === 'string' ? q.header.trim() : '',
      question,
      options,
      multiSelect: q.multiSelect === true,
      allowCustom: q.allowCustom !== false,
    });
  }
  return out;
}

/**
 * 计划审批卡（`exit_plan_mode`）：同一张卡，但**先给方案全文**。
 *
 * @param args - `exit_plan_mode` 的参数
 * @returns 单个问题（批准 / 继续规划）
 */
function planReviewOf(args: Record<string, unknown> | undefined): { plan: string; question: Question } {
  const plan = typeof args?.plan === 'string' ? args.plan : '';
  return {
    plan,
    question: {
      id: 'review',
      header: '方案审批',
      question: '批准这个方案并离开计划模式吗？',
      options: [
        { label: '批准', description: '离开计划模式，从下一步开始按方案执行。' },
        { label: '继续规划', description: '留在计划模式；你的反馈会回到模型手里。' },
      ],
      multiSelect: false,
      allowCustom: true,
    },
  };
}

export function QuestionCard({
  tabId,
  callId,
  toolName,
  args,
  result,
}: {
  tabId: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown> | undefined;
  /** 工具结果（答完之后就有；未答时 undefined） */
  result: ToolResultView | undefined;
}) {
  const isPlan = toolName === 'exit_plan_mode';
  const { plan, question: planQuestion } = useMemo(() => planReviewOf(args), [args]);
  const questions = useMemo(
    () => (isPlan ? [planQuestion] : questionsOf(args)),
    [isPlan, planQuestion, args],
  );
  const pending = useQuestions((s) => s.pending[callId]);
  const settle = useQuestions((s) => s.settle);
  const streaming = useTabMsg(tabId, (t) => t.streaming);

  /** 逐题回答（选项 + 自由文本） */
  const [draft, setDraft] = useState<Record<string, { selected: string[]; custom: string }>>({});
  const [sending, setSending] = useState(false);
  const answered = result !== undefined;
  // 请求已经不在了（中断/换轮）而结果也没来：卡片退回只读，别让用户点一个没有去处的提交
  const interactive = pending !== undefined && !answered && (streaming || pending !== undefined);

  const pick = (q: Question, label: string): void => {
    setDraft((d) => {
      const cur = d[q.id] ?? { selected: [], custom: '' };
      const selected = q.multiSelect
        ? cur.selected.includes(label)
          ? cur.selected.filter((x) => x !== label)
          : [...cur.selected, label]
        : cur.selected[0] === label
          ? []
          : [label];
      return { ...d, [q.id]: { ...cur, selected } };
    });
  };

  const answer = async (): Promise<void> => {
    if (!pending) return;
    setSending(true);
    const answers: Answer[] = questions.map((q) => ({
      id: q.id,
      selected: draft[q.id]?.selected ?? [],
      custom: (draft[q.id]?.custom ?? '').trim(),
    }));
    try {
      await cmd('ui_reply', {
        tabId,
        response: {
          type: 'extension_ui_response',
          id: pending.requestId,
          value: JSON.stringify({ answers }),
        },
      });
      settle(callId);
    } catch (e) {
      toast.error(`回答没能送回去：${String(e)}`);
    } finally {
      setSending(false);
    }
  };

  const cancel = async (): Promise<void> => {
    if (!pending) return;
    try {
      await cmd('ui_reply', {
        tabId,
        response: { type: 'extension_ui_response', id: pending.requestId, cancelled: true },
      });
    } finally {
      settle(callId);
    }
  };

  const title = isPlan ? '方案审批' : '提问';
  return (
    <div className="pg-qcard" data-question-card data-tool={toolName} data-answered={answered ? '' : undefined}>
      <div className="pg-qcard-head">
        <Icon name={isPlan ? 'checklist' : 'comment-discussion'} size={13} />
        <span className="pg-qcard-title">{title}</span>
        {questions.length > 1 ? <span className="pg-qcard-count">{questions.length} 个问题</span> : null}
        {answered ? (
          <span className="pg-qcard-done">
            <Icon name="check" size={12} /> 已回答
          </span>
        ) : null}
      </div>
      {isPlan && plan !== '' ? (
        <details className="pg-qcard-plan" data-question-plan open>
          <summary>方案全文</summary>
          {/* 方案是模型写的 markdown：这里按纯文本展示（不引 markdown 渲染器，
              免得方案里的 HTML 变成注入面）。展开/收起交给原生 details。 */}
          <pre className="pg-qcard-plan-body">{plan}</pre>
        </details>
      ) : null}
      {questions.map((q) => {
        const state = draft[q.id] ?? { selected: [], custom: '' };
        return (
          <div className="pg-qcard-q" key={q.id} data-question={q.id}>
            <div className="pg-qcard-label">
              {q.header !== '' ? <span className="pg-qcard-header">{q.header}</span> : null}
              <span className="pg-qcard-text">{q.question}</span>
              {q.multiSelect ? <span className="pg-qcard-multi">可多选</span> : null}
            </div>
            {q.options.length > 0 ? (
              <div className="pg-qcard-opts">
                {q.options.map((o) => {
                  const on = state.selected.includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type="button"
                      className="pg-qcard-opt"
                      data-option={o.label}
                      data-selected={on ? '' : undefined}
                      disabled={!interactive || sending}
                      onClick={() => pick(q, o.label)}
                      title={o.description ?? o.label}
                    >
                      <span className="pg-qcard-opt-label">{o.label}</span>
                      {o.description !== undefined ? (
                        <span className="pg-qcard-opt-desc">{o.description}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {q.allowCustom && interactive ? (
              <input
                className="pg-qcard-custom"
                data-question-custom={q.id}
                placeholder={q.options.length > 0 ? '补充说明（可选）' : '输入回答…'}
                value={state.custom}
                disabled={sending}
                /* ⚠️ 必须从 `d` 里取**当前**选中项：用渲染闭包里的 `state` 会在
                   "先点选项、紧接着打字"时把刚点的选项覆盖掉（React 会把这两次更新
                   合到一批里，闭包里的 selected 还是旧的）—— 门禁第 27 段实测抓到过。 */
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    [q.id]: { selected: d[q.id]?.selected ?? [], custom: e.target.value },
                  }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void answer();
                }}
              />
            ) : null}
          </div>
        );
      })}
      {interactive ? (
        <div className="pg-qcard-actions">
          <button type="button" className="pg-btn pg-btn-primary" disabled={sending} onClick={() => void answer()}>
            {sending ? '提交中…' : isPlan ? '提交审批' : '提交'}
          </button>
          <button type="button" className="pg-btn" disabled={sending} onClick={() => void cancel()}>
            {isPlan ? '先不审批（我来说）' : '跳过'}
          </button>
        </div>
      ) : null}
      {!interactive && !answered ? (
        <div className="pg-qcard-stale" data-question-stale>
          这一轮的提问已经结束（中断或超时），回答无处可去。
        </div>
      ) : null}
      {answered ? <div className="pg-qcard-result">{result?.text ?? ''}</div> : null}
    </div>
  );
}
