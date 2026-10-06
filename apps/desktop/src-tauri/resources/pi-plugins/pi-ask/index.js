/**
 * pi-ask —— 结构化提问（对标 DSH 的 `ask_user_question` 提问卡）。
 *
 * ## 模型看到的行为
 *
 *   一轮里可以问 1–6 个问题，每个问题可以有 0–8 个选项（可多选）、也可以只要自由文本。
 *   工具**阻塞**到用户回答为止；回答以普通工具结果回到模型手里：
 *
 *     用户回答了：
 *     - 数据来源：[生产库] （用户补充：只读账号）
 *     - 还要改哪些文件：(自由文本) 顺手把 tests/ 里的旧断言删掉
 *
 * ## 为什么用 `ui.select` 这一条通道（而不是自定义协议）
 *
 * pi 在 RPC 模式下只把四种 UI 方法发给宿主：`select` / `confirm` / `input` / `notify`
 * 等（`dist/modes/rpc/rpc-mode.js` 里 `createExtensionUIContext`，`custom()` 在 RPC 下
 * **直接返回 undefined**）。所以"一张卡问多个问题"只能靠宿主把 `select` 的**标题**当成
 * 信封来认：
 *
 *   标题 = `piggy:ask:v1:<toolCallId>`，选项固定一项「提交」
 *
 * Piggy 侧的 `lib/questionChannel.ts` 认这个前缀 → **不弹普通选择框**，而是按工具调用
 * 的参数（`questions`）在转录里画一张提问卡；用户提交后把回答 JSON 作为
 * `extension_ui_response.value` 回给这里。工具调用 id 写在标题里是为了**不用猜**：
 * 一个回合里可能有多次提问（也可能并行多个工具调用），宿主必须能对上号。
 *
 * 别的宿主（pi TUI、别的 GUI）不认这个前缀，所以这里**降级**成逐个问题弹原生对话框
 * —— 那条路只用 pi 的公开能力，任何宿主都能用，只是没有"一张卡"的样子。
 *
 * ## `/plan` 计划模式（复用同一张卡）
 *
 * `/plan` 打开"只读 + 先出方案"的模式：`edit`/`write` 被拦（带理由回到模型），
 * 用户输入的每条消息前会加一段计划模式说明，另外激活 `exit_plan_mode` 工具。
 * 模型调它提交方案 → **同一张提问卡**问"批准并离开计划模式 / 继续规划"，
 * 批准则关模式、把方案正文交回；不批准则把用户的反馈原样交给模型继续改。
 *
 * ## 依赖面
 *
 * 只用 pi 的虚拟模块：`typebox`（参数 schema）。**没有 npm 依赖** —— 目标机器上可能
 * 没有 node/npm，这个文件就是最终产物，不需要构建（所以刻意写成 plain ESM JS，
 * 与 `pi-subagents` 一样是 `.js` 入口）。
 */

import { Type } from 'typebox';

import {
  ASK_SUBMIT_LABEL,
  ASK_TITLE_PREFIX,
  HOST_ENV,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  PLAN_PREAMBLE,
  PLAN_STATUS_KEY,
  WRITE_TOOLS,
  normalizeQuestions,
  renderAnswers,
} from './lib.js';

function questionParams() {
  const Option = Type.Object(
    {
      label: Type.String({ description: 'Option text the user picks (short).' }),
      description: Type.Optional(Type.String({ description: 'One line explaining the tradeoff.' })),
    },
    { additionalProperties: false },
  );
  const Question = Type.Object(
    {
      id: Type.Optional(Type.String({ description: 'Stable id for this question (defaults to q1, q2, …).' })),
      header: Type.Optional(Type.String({ description: 'Very short label, e.g. "数据来源".' })),
      question: Type.String({ description: 'The question itself, one sentence.' }),
      options: Type.Optional(Type.Array(Option, { description: 'Choices. Omit for a free-text question.' })),
      multiSelect: Type.Optional(Type.Boolean({ description: 'Allow picking more than one option.' })),
      allowCustom: Type.Optional(
        Type.Boolean({ description: 'Also offer a free-text answer next to the options (default true).' }),
      ),
    },
    { additionalProperties: false },
  );
  return Type.Object(
    {
      questions: Type.Array(Question, { description: `1–${MAX_QUESTIONS} questions asked in one card.` }),
    },
    { additionalProperties: false },
  );
}

/**
 * Piggy 提问卡通道：发一个"信封 select"，等宿主把 JSON 回答塞回 `value`。
 *
 * @param ui - `ctx.ui`
 * @param toolCallId - 工具调用 id（宿主靠它对上号）
 * @param signal - 工具的中断信号（用户中止这一轮时宿主会关掉对话框）
 * @returns 回答数组；用户取消/超时返回 null
 */
async function askViaPiggy(ui, toolCallId, signal) {
  const raw = await ui.select(`${ASK_TITLE_PREFIX}${toolCallId}`, [ASK_SUBMIT_LABEL], {
    ...(signal ? { signal } : {}),
  });
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.answers)) return parsed.answers;
    if (parsed?.cancelled === true) return null;
    return null;
  } catch {
    return null;
  }
}

/**
 * 别的宿主：逐个问题弹原生对话框（只用 pi 的公开能力，不依赖 Piggy）。
 *
 * @param ui - `ctx.ui`
 * @param questions - 归一化后的问题
 * @returns 回答数组；用户中途取消返回 null
 */
async function askSequentially(ui, questions) {
  const answers = [];
  for (const q of questions) {
    const title = q.header !== '' ? `${q.header} — ${q.question}` : q.question;
    if (q.options.length === 0) {
      const value = await ui.input(title, '输入回答（留空表示跳过）');
      if (value === undefined) return null;
      answers.push({ id: q.id, selected: [], custom: value });
      continue;
    }
    const labels = q.options.map((o) => o.label);
    if (q.multiSelect) {
      const picked = await ui.input(`${title}\n（可多选：填序号，逗号分隔）`, labels.map((l, i) => `${i + 1}. ${l}`).join('  '));
      if (picked === undefined) return null;
      const selected = picked
        .split(/[,，\s]+/)
        .map((s) => Number.parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= labels.length)
        .map((n) => labels[n - 1]);
      answers.push({ id: q.id, selected, custom: '' });
      continue;
    }
    const value = await ui.select(title, labels);
    if (value === undefined) return null;
    answers.push({ id: q.id, selected: [value], custom: '' });
  }
  return answers;
}

/**
 * 插件入口。
 *
 * @param pi - pi 的扩展 API
 */
export default function piAsk(pi) {
  const host = typeof process !== 'undefined' ? process.env?.[HOST_ENV] : undefined;
  const isPiggy = typeof host === 'string' && host !== '';
  /** 计划模式（按会话；pi 一个进程一个会话，所以模块级变量就够） */
  let planMode = false;

  const ASK_TOOL = 'ask_user_question';
  const EXIT_TOOL = 'exit_plan_mode';

  pi.registerTool({
    name: ASK_TOOL,
    label: '提问',
    description: [
      'Ask the user 1–6 structured questions and wait for the answers.',
      'Use it when a decision is genuinely the user\'s (which approach, which data source, which tradeoff)',
      'instead of guessing. Each question may offer options (multi-select allowed) and/or free text.',
      'Do not use it for trivial confirmations, and do not ask what the code already answers.',
    ].join(' '),
    promptSnippet: 'Ask the user structured questions when a decision is theirs',
    parameters: questionParams(),
    // 提问与别的一次性工具不同：它要等用户，和其他工具并行没有意义
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const questions = normalizeQuestions(params);
      if (questions.length === 0) {
        return { content: [{ type: 'text', text: 'pi-ask：没有收到任何有效问题（questions 为空？）' }] };
      }
      if (!ctx?.hasUI || !ctx.ui) {
        return {
          content: [
            {
              type: 'text',
              text: '宿主没有可用的交互界面，无法提问。请改用普通文本把问题写出来，让用户直接回复。',
            },
          ],
        };
      }
      let answers = null;
      if (isPiggy) answers = await askViaPiggy(ctx.ui, toolCallId, signal);
      if (answers === null && !isPiggy) answers = await askSequentially(ctx.ui, questions);
      if (answers === null) {
        return {
          content: [
            {
              type: 'text',
              text: '用户没有回答（取消或超时）。不要重复提问；按你的最佳判断继续，并在回复里说明你假设了什么。',
            },
          ],
        };
      }
      return { content: [{ type: 'text', text: renderAnswers(questions, answers) }] };
    },
  });

  /* ── 计划模式 ─────────────────────────────────────────────────────────── */

  /**
   * 打开/关闭计划模式：状态栏 + 拦截写工具 + 激活/收起 `exit_plan_mode`。
   *
   * @param on - 是否进入计划模式
   * @param ctx - 当前上下文（拿 ui 与工具表）
   */
  function setPlanMode(on, ctx) {
    planMode = on;
    try {
      ctx?.ui?.setStatus?.(PLAN_STATUS_KEY, on ? '计划模式：只读，先出方案' : undefined);
    } catch {
      /* 状态栏失败不影响功能 */
    }
    try {
      const all = new Set((pi.getAllTools?.() ?? []).map((t) => t.name));
      const active = pi.getActiveTools?.() ?? [];
      if (on) {
        if (all.has(EXIT_TOOL)) pi.setActiveTools?.([...new Set([...active, EXIT_TOOL])]);
      } else {
        pi.setActiveTools?.(active.filter((n) => n !== EXIT_TOOL));
      }
    } catch {
      /* 动态工具表在旧 pi 上不存在（0.86.1 起才有）：模式仍然有效，只是工具常驻 */
    }
  }

  pi.registerCommand('plan', {
    description: '进入计划模式：只调研与出方案，改文件的工具会被拦下',
    handler: async (_args, ctx) => {
      setPlanMode(true, ctx);
      ctx?.ui?.notify?.('已进入计划模式：只读，模型会先给方案再等你批准', 'info');
    },
  });

  pi.registerCommand('plan-off', {
    description: '退出计划模式（不经过审批）',
    handler: async (_args, ctx) => {
      setPlanMode(false, ctx);
      ctx?.ui?.notify?.('已退出计划模式', 'info');
    },
  });

  // 计划模式下按用户消息注入说明（`input` 事件可以改写输入）
  pi.on?.('input', (event) => {
    if (!planMode) return { action: 'continue' };
    const text = typeof event?.text === 'string' ? event.text : '';
    if (text.startsWith('[计划模式]')) return { action: 'continue' };
    return { action: 'transform', text: `${PLAN_PREAMBLE}${text}` };
  });

  // 计划模式下拦下写文件的工具（理由回到模型手里，它会换个做法）
  pi.on?.('tool_call', (event) => {
    if (!planMode) return;
    const name = String(event?.toolName ?? event?.name ?? '');
    if (!WRITE_SET.has(name)) return;
    return {
      block: true,
      reason: '计划模式：先别改文件。把"准备怎么改"写进方案，用 exit_plan_mode 提交给用户批准。',
    };
  });

  pi.registerTool({
    name: EXIT_TOOL,
    label: '提交方案',
    description:
      'Submit the implementation plan for approval and leave plan mode. Call it only in plan mode, with the full plan as markdown starting with a "# " heading.',
    promptSnippet: 'Submit the plan for approval (plan mode only)',
    parameters: Type.Object(
      { plan: Type.String({ description: 'The plan, markdown, starting with a "# " heading.' }) },
      { additionalProperties: false },
    ),
    executionMode: 'sequential',
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const plan = typeof params?.plan === 'string' ? params.plan.trim() : '';
      if (plan === '' || !plan.startsWith('#')) {
        return { content: [{ type: 'text', text: '方案不能为空，并且要以 "# " 开头（markdown 标题）。' }] };
      }
      if (!ctx?.hasUI || !ctx.ui) {
        setPlanMode(false, ctx);
        return { content: [{ type: 'text', text: '宿主没有交互界面，已直接退出计划模式。\n\n方案：\n' + plan }] };
      }
      const questions = [
        {
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
      ];
      let answers = null;
      /* 宿主按 `exit_plan_mode` 的**工具参数**画卡片（方案正文就在参数里），
         所以这里不需要额外载荷 —— 信封只带工具调用 id。 */
      if (isPiggy) answers = await askViaPiggy(ctx.ui, toolCallId, signal);
      else {
        answers = await askSequentially(ctx.ui, questions);
      }
      const item = answers?.find?.((a) => a.id === 'review');
      const approval = item?.selected?.[0];
      const feedback = typeof item?.custom === 'string' ? item.custom.trim() : '';
      if (approval === '批准' && feedback === '') {
        setPlanMode(false, ctx);
        return { content: [{ type: 'text', text: `用户批准了方案，已离开计划模式。开始执行：\n\n${plan}` }] };
      }
      return {
        content: [
          {
            type: 'text',
            text:
              '用户没有批准，仍留在计划模式。' +
              (feedback !== '' ? `用户的反馈：${feedback}` : '用户选择继续规划。') +
              '\n\n请据此修改方案，再提交一次。',
          },
        ],
      };
    },
  });
}
