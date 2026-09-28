// @vitest-environment jsdom
/**
 * **跨语言金标**：`session_title_generate` 的键集合，mock 与 Rust 两份清单必须一致。
 *
 * 这条是**补票**。上一版真机点了「生成标题」，用户收到的提示是：
 *
 *   标题已更新为「问候与日期询问」（cc-switch-zhipu-glm/glm-5.3-flash · NaNs · 素材 undefined 字）
 *
 * 原因是 Rust 的 `Generated` 忘了 `rename_all = "camelCase"`，发出来的是
 * `elapsed_ms` / `prompt_chars`，前端读 `elapsedMs` / `promptChars` ——
 * 两边都不报错，`undefined / 1000` 变成 `NaN`，直接渲染给了用户。
 *
 * **为什么既有的测试全绿**：前端用例 mock 的是 `session_title_generate`，
 * 返回的是**手写的 camelCase**。mock 与 Rust 各写各的、谁也没对着谁，
 * 于是 Rust 那边漏了 `camelCase` 时，前端测试照样全绿。
 * 这正是 docs/15 规矩 27 说的那件事：**两份手写清单互为金标**，
 * 而不是"用被测物证明被测物"。
 *
 * 与它配对的是 Rust 侧的 `generated_result_keys_are_camel_case`
 * （`src-tauri/src/sessions/title.rs`）——那份清单是**另写一遍**的。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/feedback', () => ({ toast: { error: vi.fn(), success: vi.fn() }, FeedbackBridge: () => null }));

import { mockInvoke } from '@/lib/mockBackend';
import {
  describeRun,
  normalizeModelOptions,
  normalizeTitleResult,
  type TitleResult,
} from '@/lib/sessionTitle';

/** 与 `src-tauri/src/sessions/title.rs::generated_result_keys_are_camel_case` 同源。 */
const RESULT_KEYS = [
  'title',
  'raw',
  'provider',
  'modelId',
  'modelUsed',
  'thinkingUsed',
  'elapsedMs',
  'promptChars',
  'applied',
  'source',
];

/** 与 `title.rs::source_description_keys_are_camel_case` 同源。 */
const SOURCE_KEYS = [
  'cwd',
  'provider',
  'modelId',
  'modelUsed',
  'modelSource',
  'modelError',
  'thinking',
  'firstMessage',
  'recentMessages',
  'userMessageCount',
  'messageCount',
  'currentName',
  'strategy',
  'maxChars',
  'promptChars',
];

/** 与 `title.rs::model_options_keys_are_camel_case` 同源。 */
const MODEL_OPTIONS_KEYS = ['models', 'note', 'piBin', 'elapsedMs'];

/**
 * pi 的思考档位（`packages/coding-agent/src/cli/args.ts:60` 的
 * `VALID_THINKING_LEVELS`）。Rust 侧 `title.rs::THINKING_LEVELS` 是**另一份**手写清单，
 * 两边的用例互为金标——抄错一个字母时 pi 只会打一行 stderr 警告然后静默用默认档，
 * 界面上完全看不出区别。
 */
const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

describe('标题生成的 mock 形状（跨语言金标）', () => {
  it('session_title_generate 的键与 Rust 契约一致', async () => {
    const r = (await mockInvoke('session_title_generate', { path: '/m/a.jsonl' })) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual([...RESULT_KEYS].sort());
    // 数字字段必须是数字：前端要拿它们做算术（undefined/1000 = NaN）
    expect(typeof r.elapsedMs).toBe('number');
    expect(Number.isFinite(r.elapsedMs as number)).toBe(true);
    expect(typeof r.promptChars).toBe('number');
    expect(typeof r.applied).toBe('boolean');
  });

  it('session_title_source 的键与 Rust 契约一致', async () => {
    const r = (await mockInvoke('session_title_source', { path: '/m/a.jsonl' })) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual([...SOURCE_KEYS].sort());
    expect(typeof r.maxChars).toBe('number');
    expect(Array.isArray(r.recentMessages)).toBe(true);
  });

  it('mock 的生成结果经过 describeRun 不会出现 NaN / undefined', async () => {
    const raw = await mockInvoke('session_title_generate', { path: '/m/a.jsonl' });
    // 直接喂给 describeRun：它只认归一化后的形状
    const r = (await (await import('@/lib/sessionTitle')).generateTitle('/m/a.jsonl')) as TitleResult;
    expect(r.elapsedMs).not.toBeNull();
    const line = describeRun(r);
    expect(line).not.toMatch(/NaN|undefined/);
    expect(line).toContain('mock-glm/glm-5.3-flash');
    void raw;
  });

  it('title_model_options 的键与 Rust 契约一致，且 reasoning 是布尔', async () => {
    const r = (await mockInvoke('title_model_options', {})) as Record<string, unknown>;
    expect(Object.keys(r).sort()).toEqual([...MODEL_OPTIONS_KEYS].sort());
    expect(Array.isArray(r.models)).toBe(true);
    expect(typeof r.elapsedMs).toBe('number');
    // reasoning 必须是布尔：字符串 "yes" 在 JS 里是真值，
    // 会让"不支持推理的模型"看起来支持思考——一个很像事实的错误结论
    for (const m of r.models as Record<string, unknown>[]) {
      expect(typeof m.reasoning).toBe('boolean');
      expect(typeof m.provider).toBe('string');
      expect(typeof m.id).toBe('string');
    }
  });

  it('归一化层把非布尔的 reasoning 收成 false 而不是当真值', () => {
    const opts = normalizeModelOptions({
      models: [
        { provider: 'p', id: 'good', reasoning: true },
        { provider: 'p', id: 'string-flag', reasoning: 'yes' },
        { provider: 'p', id: '', reasoning: true },
        { id: 'no-provider', reasoning: true },
      ],
      note: '',
      piBin: '/bin/pi',
      elapsed_ms: 1,
    });
    // 缺 provider/id 的项被丢掉；字符串 reasoning 降级成 false（宁可少说"支持"）
    expect(opts.models.map((m) => m.id)).toEqual(['good', 'string-flag']);
    expect(opts.models[1]!.reasoning).toBe(false);
    // 认不出的键（snake_case）不会被当成 elapsedMs —— 归一化只认 camelCase
    expect(opts.elapsedMs).toBeNull();
    expect(opts.note).toBeNull();
    // 完全没有 models 数组时也不炸
    expect(normalizeModelOptions(undefined).models).toEqual([]);
    expect(normalizeModelOptions({}).models).toEqual([]);
  });

  it('思考档位清单与 pi 的 VALID_THINKING_LEVELS 逐个一致', async () => {
    const { THINKING_LEVELS, thinkingLabel, thinkingOptions } = await import('@/lib/thinking');
    expect([...THINKING_LEVELS]).toEqual(PI_THINKING_LEVELS);
    // 每一档都要有中文名：漏一个的后果是下拉里出现一个英文/空白的选项
    for (const lv of THINKING_LEVELS) {
      expect(thinkingLabel(lv)).toBeTruthy();
      expect(thinkingLabel(lv)).not.toBe(lv);
    }
    expect(thinkingOptions().map((o) => o.value)).toEqual(PI_THINKING_LEVELS);
    // 认不出的值原样显示（不隐藏"我们不认识它"这件事）
    expect(thinkingLabel('wat')).toBe('wat');
  });

  it('设了思考强度时提示里会说出来（用户要知道自己的选择生效了）', async () => {
    const { normalizeTitleResult, describeRun } = await import('@/lib/sessionTitle');
    const withThinking = normalizeTitleResult({
      title: 't', raw: 'r', modelUsed: 'p/m', thinkingUsed: 'xhigh',
      elapsedMs: 1000, promptChars: 10, applied: true,
    });
    expect(describeRun(withThinking)).toBe('p/m · 1.0s · 素材 10 字 · 思考 极高');
    // 没设 = 不提（那是模型的常态，写出来只会让提示更长）
    const without = normalizeTitleResult({
      title: 't', raw: 'r', modelUsed: 'p/m', elapsedMs: 1000, promptChars: 10, applied: true,
    });
    expect(describeRun(without)).toBe('p/m · 1.0s · 素材 10 字');
    expect(without.thinkingUsed).toBeNull();
  });

  it('形状漂移时降级而不是渲染成 NaN（补票的兜底那一层）', () => {    // 模拟"又有人忘了 camelCase"：只有 snake_case 字段。
    // 归一化这一层是补票——根因已经在 Rust 侧锁住了，但**任何**将来的字段漂移
    // 都不该把 NaN / undefined 送到用户眼前。
    const legacy = {
      title: '问候与日期询问',
      raw: '问候与日期询问',
      modelUsed: 'cc-switch-zhipu-glm/glm-5.3-flash',
      applied: true,
      elapsed_ms: 2300,
      prompt_chars: 190,
      source: {},
    };
    const r = normalizeTitleResult(legacy);
    // 认不出来的字段变成 null，而不是 undefined（前端要做算术）
    expect(r.elapsedMs).toBeNull();
    expect(r.promptChars).toBeNull();
    const line = describeRun(r);
    // 关键：宁可少说一句，也不能出现 NaN / undefined
    expect(line).not.toMatch(/NaN|undefined/);
    expect(line).toContain('cc-switch-zhipu-glm/glm-5.3-flash');
    // 正常形状仍然照常渲染三段
    const ok = normalizeTitleResult({
      title: 't', raw: 'r', modelUsed: 'p/m', applied: true, elapsedMs: 2300, promptChars: 190,
    });
    expect(describeRun(ok)).toBe('p/m · 2.3s · 素材 190 字');
    expect(describeRun(normalizeTitleResult({ title: 't', modelUsed: 'p/m', applied: false })))
      .toBe('p/m · 未写入');
  });
});
