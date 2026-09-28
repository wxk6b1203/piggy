// @vitest-environment jsdom
/**
 * 通用设置里的「标题模型 / 思考强度」（docs/04 §2.2、docs/03 §2.16）。
 *
 * 这一块以前是一个自由输入框（"填 provider/modelId"）。改成下拉之后，
 * 新的失败方式全是"界面上看起来正常、实际什么也没发生"这一类：
 *   ① 下拉里没有可选项 / 分组错位——用户以为 pi 没有模型；
 *   ② 选完没写回 config（`perf_config_save` 的字段名写错就静默无效）；
 *   ③ **不支持推理的模型**仍然能选思考档：pi 的 `clampThinkingLevel` 会静默降级成
 *      `off`，于是"我明明选了高"永远查不出来；
 *   ④ 列表拉不到时**没有退路**：以前能手打任意模型名，改下拉后如果只有下拉，
 *      用户遇到"pi 没列出来的模型"就再也填不进去了。
 * 这四条各有一条用例。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock, toastError, toastSuccess } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/lib/feedback', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn() },
  FeedbackBridge: () => null,
  confirm: vi.fn(),
}));

import { GeneralSection } from '@/features/settings/GeneralSection';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 40)); });
const q = <T extends Element>(sel: string) => domContainer().querySelector<T>(sel);
/** antd 的下拉 portal 到 document.body，不在挂载容器里 */
const inBody = <T extends Element>(sel: string) => [...document.querySelectorAll<T>(sel)];

/** 与真机同形的 `pi --list-models` 结果（含一个不支持推理的模型）。 */
const MODELS = [
  { provider: 'mock-glm', id: 'glm-5.3-flash', reasoning: true },
  { provider: 'mock-glm', id: 'glm-5.3', reasoning: true },
  { provider: 'mock-plain', id: 'no-think-model', reasoning: false },
];

const calls: { name: string; args: Record<string, unknown> }[] = [];

/**
 * 一份**会记住保存**的配置。
 *
 * 真机的 `perf_config_save` 是读-改-写、之后设置页会 `reload()` 再读回来；
 * 如果这里的 `perf_config_load` 永远返回初始值，那么"选完模型再读回来"这条链
 * 在 mock 下就是断的——测试要么断言不到（假红），要么断言到的东西真机上不成立（假绿）。
 */
const cfg: Record<string, unknown> = {
  max_workers: 8,
  idle_timeout_min: 10,
  permission_mode: 'full',
  subagent_delegation: false,
  title_max_chars: 20,
  title_source: 'both',
  title_model: null,
  title_thinking: null,
};

function prime(overrides: Record<string, unknown> = {}) {
  invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    const a = args ?? {};
    calls.push({ name, args: a });
    if (name in overrides) {
      const v = overrides[name];
      if (typeof v === 'function') return (v as (x: Record<string, unknown>) => unknown)(a);
      if (v instanceof Error) throw v;
      // 显式给的配置也要能被后续保存改到，所以拷进同一份状态
      if (name === 'perf_config_load') Object.assign(cfg, v);
      return v;
    }
    switch (name) {
      case 'pi_source_options':
        return {
          source: 'system',
          customPath: null,
          builtinAvailable: false,
          builtinPath: null,
          current: { path: '/usr/local/bin/pi', version: '0.87.1', source: 'system', via: '系统安装', fromEnv: false },
          options: [
            { id: 'system', label: '系统 pi', available: true },
            { id: 'bundled', label: '捆绑 pi', available: false },
            { id: 'custom', label: '自定义路径', available: true },
          ],
        };
      case 'permission_modes':
        return { modes: [{ id: 'full', label: '完全权限', tools: null, pathGuard: false }] };
      case 'perf_config_load':
        return { ...cfg };
      case 'perf_config_save':
        // 与真机同义：只改传进来的那几个字段（读-改-写）
        if (a.titleMaxChars !== undefined) cfg.title_max_chars = a.titleMaxChars;
        if (a.titleSource !== undefined) cfg.title_source = a.titleSource;
        if (a.titleModel !== undefined) cfg.title_model = a.titleModel || null;
        if (a.titleThinking !== undefined) cfg.title_thinking = a.titleThinking || null;
        return null;
      case 'session_dir_effective':
        return { dir: '/tmp/sessions', isCustom: false, raw: null };
      case 'title_model_options':
        return { models: MODELS, note: null, piBin: '/usr/local/bin/pi', elapsedMs: 612 };
      default:
        return null;
    }
  });
}

/** 打开某个 antd Select 的下拉（v6 的结构是 .ant-select-content）。 */
async function openSelect(attr: string) {
  const el = q<HTMLElement>(`[${attr}] .ant-select-content`);
  if (!el) throw new Error(`找不到 ${attr} 的下拉框（.ant-select-content）`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));
  });
}

async function pickOption(label: string) {
  const hit = inBody<HTMLElement>('.ant-select-item-option').find((o) =>
    (o.textContent ?? '').includes(label),
  );
  if (!hit) {
    throw new Error(
      `下拉里没有「${label}」：${inBody('.ant-select-item-option').map((o) => o.textContent).join(' | ')}`,
    );
  }
  await act(async () => {
    hit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));
  });
}

const savedTitleArgs = () =>
  calls.filter((c) => c.name === 'perf_config_save').map((c) => c.args);

/**
 * 最后一次 `perf_config_save` 的载荷。
 *
 * 没有就**直接抛**：让断言在 `undefined` 上打转只会得到一句
 * "expected undefined to be 'x'"，看不出是"根本没发命令"还是"发了但字段不对"。
 */
function lastSavedTitle(): Record<string, unknown> {
  const args = savedTitleArgs();
  if (args.length === 0) throw new Error('设置页没有发出任何 perf_config_save');
  return args[args.length - 1]!;
}

beforeEach(() => {
  invokeMock.mockReset();
  calls.length = 0;
  // 每个用例从一份干净配置开始（`cfg` 是跨用例共享的）
  Object.assign(cfg, {
    max_workers: 8,
    idle_timeout_min: 10,
    permission_mode: 'full',
    subagent_delegation: false,
    title_max_chars: 20,
    title_source: 'both',
    title_model: null,
    title_thinking: null,
  });
  toastError.mockReset();
  toastSuccess.mockReset();
});

afterEach(async () => {
  await unmountDom();
});

describe('标题模型：下拉 + 思考强度', () => {
  it('模型下拉来自 title_model_options，并按 provider 分组', async () => {
    prime();
    mountDom(<GeneralSection />);
    await flush();
    // 数据源必须是"问 pi"这条命令（不是前端自己拼一份模型清单）
    expect(calls.map((c) => c.name)).toContain('title_model_options');
    await openSelect('data-title-model-select');
    const labels = inBody<HTMLElement>('.ant-select-item-option').map((o) => o.textContent ?? '');
    expect(labels.join('|')).toContain('glm-5.3-flash');
    // 分组标题是 provider 名（同 provider 的两个模型在一组里）
    const groups = inBody<HTMLElement>('.ant-select-item-group').map((o) => o.textContent ?? '');
    expect(groups).toContain('mock-glm');
    expect(groups).toContain('mock-plain');
    // 不支持推理的模型要**当场标出来**，而不是等用户选了思考档才发现
    expect(labels.join('|')).toContain('不支持思考');
  });

  it('选中模型后写回 config（titleModel = provider/id）', async () => {
    prime();
    mountDom(<GeneralSection />);
    await flush();
    await openSelect('data-title-model-select');
    await pickOption('glm-5.3-flash');
    const saved = lastSavedTitle();
    expect(saved.titleModel).toBe('mock-glm/glm-5.3-flash');
    // 没碰的字段照旧带上（后端是读-改-写，但前端每次都给全量）
    expect(saved.titleThinking).toBe('');
  });

  it('思考强度是可选档位列表，选中后写回 config（titleThinking）', async () => {
    prime();
    mountDom(<GeneralSection />);
    await flush();
    await openSelect('data-title-thinking-select');
    const labels = inBody<HTMLElement>('.ant-select-item-option').map((o) => o.textContent ?? '');
    expect(labels).toEqual(['关闭', '极简', '低', '中', '高', '极高', '最大']);
    await pickOption('极高');
    expect(lastSavedTitle().titleThinking).toBe('xhigh');
    // 选了档位之后必须说清"pi 还会按模型能力再收敛一次"——
    // 实测没声明的模型里「极高/最大」都发成 high，不说就是静默失效
    await flush();
    expect(q('[data-title-thinking-clamp]')).toBeTruthy();
  });

  it('选了不支持推理的模型 → 思考档禁用**并说明原因**（pi 会静默降级成 off）', async () => {
    prime();
    mountDom(<GeneralSection />);
    await flush();
    await openSelect('data-title-model-select');
    await pickOption('no-think-model');
    await flush();
    // 禁用 + 理由缺一不可：只禁用不说原因 = 用户以为界面坏了
    const note = q('[data-title-thinking-note]');
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain('没有声明推理能力');
    const sel = q<HTMLElement>('[data-title-thinking-select]');
    expect(sel!.className).toContain('ant-select-disabled');
  });

  it('模型列表拉不到 → 退回手动输入，并把原因说出来（不能只剩一个空下拉）', async () => {
    prime({
      title_model_options: () => {
        throw new Error('pi 列出模型失败（退出码 1）：No models are available.');
      },
    });
    mountDom(<GeneralSection />);
    await flush();
    // 手动输入这条退路必须在（以前这里是自由输入框，改下拉后不能把路堵死）
    // 只看**真的**手动输入框：antd 的 Select 内部也有一个带 aria-label 的 input，
    // 不区分的话这条断言在"下拉正常渲染"时也会为真
    const input = q<HTMLInputElement>('input.ant-input[aria-label="标题模型"]');
    expect(input).toBeTruthy();
    expect(q('[data-title-model-select]')).toBeNull();
    const note = q('[data-title-models-note]');
    expect(note).toBeTruthy();
    expect(note!.textContent).toContain('拉取模型列表失败');
    expect(note!.textContent).toContain('手动填');
  });

  it('pi 列不出任何模型（列表为空）→ 也说清楚，并给手动输入', async () => {
    prime({
      title_model_options: {
        models: [],
        note: 'No models are available. Configure a provider in ~/.pi/agent/auth.json',
        piBin: '/usr/local/bin/pi',
        elapsedMs: 300,
      },
    });
    mountDom(<GeneralSection />);
    await flush();
    const note = q('[data-title-models-note]');
    expect(note).toBeTruthy();
    // pi 的原话要带出来：真正的原因（没配密钥）就在里面，比"没有可用模型"有用
    expect(note!.textContent).toContain('没有列出任何可用模型');
    expect(note!.textContent).toContain('auth.json');
    expect(q<HTMLInputElement>('input.ant-input[aria-label="标题模型"]')).toBeTruthy();
  });

  it('已有覆盖时下拉显示它，清空 = 回到"跟会话自己的模型"', async () => {
    prime({
      perf_config_load: {
        max_workers: 8,
        idle_timeout_min: 10,
        permission_mode: 'full',
        subagent_delegation: false,
        title_max_chars: 20,
        title_source: 'both',
        title_model: 'mock-glm/glm-5.3',
        title_thinking: 'high',
      },
    });
    mountDom(<GeneralSection />);
    await flush();
    expect(domContainer().textContent).toContain('mock-glm/glm-5.3');
    // 点 × 清空 → 写回空串（= 清掉覆盖），不是写一个空模型名
    const clear = q<HTMLElement>('[data-title-model-select] .ant-select-clear');
    expect(clear).toBeTruthy();
    await act(async () => {
      clear!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      clear!.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(lastSavedTitle().titleModel).toBe('');
  });

  it('历史配置里的非法思考档不会让界面炸（后端 clamp 会丢掉它）', async () => {
    prime({
      perf_config_load: {
        max_workers: 8,
        idle_timeout_min: 10,
        permission_mode: 'full',
        subagent_delegation: false,
        title_max_chars: 20,
        title_source: 'both',
        title_model: null,
        // config.json 是可以手改的：拼错的档位不该让整页设置崩掉
        title_thinking: 'HIGH',
      },
    });
    mountDom(<GeneralSection />);
    await flush();
    expect(q('[data-title-settings]')).toBeTruthy();
    // 认不出的值原样显示（不假装它是"高"）
    expect(domContainer().textContent).toContain('HIGH');
  });
});
