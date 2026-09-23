// @vitest-environment jsdom
/**
 * 失败回合的可见性回归测试。
 *
 * 背景（2026-09-23 实测，用真实 pi 抓包确认）：pi 把失败表达成一条**普通的 assistant 消息**——
 *
 *   模型报错：{ content: [], stopReason: 'error',   errorMessage: '401: {"message":"Authentication Fails, …"}' }
 *   用户中断：{ content: [], stopReason: 'aborted', errorMessage: 'Request aborted' }
 *
 * `content` 是空数组，于是 `MessageView` 渲染出来**一片空白**，轨迹表也只有一行空行。
 * 用户看到的现象是「消息发出去了，再也回不了消息」——而真正的错误文本（401 / API key 无效）
 * 一直躺在消息里，全代码库没有任何一处读过 `stopReason` / `errorMessage`。
 *
 * 这里锁三件事：
 *   1. `turnFailure()` 能判读出失败与中断（且不误判正常回合）；
 *   2. 失败原因确实**渲染到了 DOM 里**（不是只进了 store）；
 *   3. 失败提示与错误详情都来自真实抓包文本，不被改写。
 */
import { describe, expect, it, afterEach } from 'vitest';
import { MessageView } from '@/features/chat/MessageView';
import { turnFailure } from '@/lib/turnFailure';
import { domContainer, mountDom, unmountDom } from './dom-render';

/** 真实抓包原样（2026-09-23，provider=cc-switch-deep-seek / model=deepseek-flash）。 */
const REAL_401 =
  '401: {"message":"Authentication Fails, Your api key: ****4d37 is invalid",' +
  '"type":"authentication_error","param":null,"code":"invalid_request_error"}';

const errorMessage = (errorMessage: string) => ({
  role: 'assistant' as const,
  content: [],
  usage: { input: 0, output: 0, totalTokens: 0 },
  stopReason: 'error',
  errorMessage,
});

function render(node: React.ReactNode): string {
  return mountDom(node).textContent ?? '';
}

afterEach(unmountDom);

describe('turnFailure：判读 pi 的回合终态', () => {
  it('模型报错（真实 401 报文）→ error，原样保留错误文本', () => {
    const f = turnFailure(errorMessage(REAL_401));
    expect(f).not.toBeNull();
    expect(f!.kind).toBe('error');
    expect(f!.title).toBe('本轮失败');
    expect(f!.detail).toBe(REAL_401);
  });

  it('401 → 给出「凭据被拒」方向的可能原因（不是泛泛的"出错了"）', () => {
    const f = turnFailure(errorMessage(REAL_401));
    expect(f!.hint).toBeTruthy();
    expect(f!.hint).toContain('API key');
  });

  it('429 / 网络不通 / 模型不存在也能认出方向', () => {
    expect(turnFailure(errorMessage('429 Too Many Requests'))!.hint).toContain('限流');
    expect(turnFailure(errorMessage('fetch failed'))!.hint).toContain('网络');
    expect(turnFailure(errorMessage('model deepseek-x not found'))!.hint).toContain('模型');
  });

  it('无法归因的错误：给原始文本，但不硬凑提示', () => {
    const f = turnFailure(errorMessage('something exploded'));
    expect(f!.kind).toBe('error');
    expect(f!.detail).toBe('something exploded');
    expect(f!.hint).toBeUndefined();
  });

  it('用户中断 → aborted，且丢掉 "Request aborted" 这句模板话术', () => {
    const f = turnFailure({ role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request aborted' });
    expect(f!.kind).toBe('aborted');
    expect(f!.title).toBe('已中止');
    expect(f!.detail).toBe('');
  });

  it('中断但带了真实原因时保留原因', () => {
    const f = turnFailure({ role: 'assistant', content: [], stopReason: 'aborted', errorMessage: '用户按了停止' });
    expect(f!.detail).toBe('用户按了停止');
  });

  it('正常回合 / 非 assistant / 空输入都不算失败', () => {
    expect(turnFailure({ role: 'assistant', content: [{ type: 'text', text: 'hi' }], stopReason: 'stop' })).toBeNull();
    expect(turnFailure({ role: 'user', content: 'hi' })).toBeNull();
    expect(turnFailure(undefined)).toBeNull();
    expect(turnFailure(errorMessage('') as never)).not.toBeNull(); // stopReason=error 本身就是失败
  });

  it('带了 errorMessage 的非 error 终态也算失败（pi 将来新增终态时不回退成空白）', () => {
    expect(turnFailure({ role: 'assistant', content: [], stopReason: 'deferred', errorMessage: 'nope' })).not.toBeNull();
  });

  it('stopReason=error 但 provider 没给详情时不至于空白', () => {
    const f = turnFailure({ role: 'assistant', content: [], stopReason: 'error' });
    expect(f!.detail).toBeTruthy();
  });
});

describe('MessageView：失败回合不再是空白', () => {
  const view = (message: unknown) => ({ id: 'm1', role: 'assistant', message }) as never;

  it('渲染出错误文本与可能原因', () => {
    const text = render(<MessageView view={view(errorMessage(REAL_401))} />);
    expect(text).toContain('本轮失败');
    expect(text).toContain('Authentication Fails');
    expect(text).toContain('****4d37');
    expect(text).toContain('API key');
  });

  it('失败卡片用 role="alert"（读屏会播报）', () => {
    render(<MessageView view={view(errorMessage(REAL_401))} />);
    expect(domContainer().querySelector('.pg-turn-failure')!.getAttribute('role')).toBe('alert');
  });

  it('中断卡片不报警，只标「已中止」', () => {
    const text = render(
      <MessageView view={view({ role: 'assistant', content: [], stopReason: 'aborted', errorMessage: 'Request aborted' })} />,
    );
    expect(text).toContain('已中止');
    expect(text).not.toContain('Request aborted'); // 模板话术不占版面
    expect(domContainer().querySelector('.pg-turn-aborted')!.getAttribute('role')).toBeNull();
  });

  it('正常回合不出现失败卡片（不误报）', () => {
    const text = render(
      <MessageView view={view({ role: 'assistant', content: [{ type: 'text', text: '一切正常' }], stopReason: 'stop' })} />,
    );
    expect(text).toContain('一切正常');
    expect(domContainer().querySelector('.pg-turn-failure')).toBeNull();
  });
});
