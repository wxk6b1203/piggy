// @vitest-environment jsdom
/**
 * `feedback.ts` 的回归测试。
 *
 * 背景（2026-09-23 实测踩到）：`FeedbackBridge` 只挂在 `<ConfigProvider>` 里、
 * 没有包在 antd 的 `<App>` 组件内，于是 `App.useApp()` 静默返回
 * `{ message: {}, notification: {}, modal: {} }`（`antd/es/app/context.js:3-7` 的默认值）。
 * 又因为兜底写法是 `ctxMessage ?? staticMessage`（按**对象**判断，`{}` 是真值，
 * `??` 不生效），`{}['error']` 就是 `undefined`，调用即
 * `TypeError: fn is not a function`。
 *
 * 后果不是"提示不好看"，而是**报错通道自己抛异常**：
 * 设置页点按钮失败时 `catch { toast.error(...) }` 二次抛出，
 * 用户看到的是"点了完全没反应"，控制台只有一行 `fn is not a function`。
 *
 * 所以这里锁两件事：
 *   1. 桥没挂 / 挂错位置时，toast 仍然可用（不许抛）；
 *   2. 桥正常挂载时，走的是带上下文的实例（主题才跟得上）。
 */
import { describe, expect, it, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { App as AntdApp, ConfigProvider } from 'antd';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

import { FeedbackBridge, toast } from '@/lib/feedback';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(node: React.ReactNode) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
});

describe('toast 通道绝不能自己抛异常', () => {
  it('桥未挂载时（模块变量的初始状态）也要能调用', () => {
    // 这条覆盖单元测试 / 桥挂载前就触发的提示
    expect(() => toast.error('未挂载')).not.toThrow();
    expect(() => toast.success('未挂载')).not.toThrow();
  });

  it('桥挂错位置（只在 ConfigProvider 内，缺 antd <App>）时也要能调用', () => {
    // 这正是线上那个 bug 的形态：useApp() 返回空对象，不许因此炸掉
    mount(
      <ConfigProvider>
        <FeedbackBridge />
      </ConfigProvider>,
    );
    expect(() => toast.error('挂错位置')).not.toThrow();
  });

  it('桥正确挂载（ConfigProvider + antd <App>）时能调用', () => {
    mount(
      <ConfigProvider>
        <AntdApp component={false}>
          <FeedbackBridge />
        </AntdApp>
      </ConfigProvider>,
    );
    expect(() => toast.error('正确挂载')).not.toThrow();
    expect(() => toast.info('正确挂载')).not.toThrow();
  });
});

describe('必须走上下文实例，而不是静默退回静态 API', () => {
  // 只断言"不抛"是不够的：加了按方法回退之后，即使桥挂错位置也不会抛，
  // 于是测试永远绿（实测确认过）。真正要守的是**走哪条路**：
  //   正确挂载（ConfigProvider + antd <App>）→ 用 useApp() 给的上下文实例（主题跟得上）
  //   挂错位置（缺 <App>）              → 只能退回 antd 静态 API（会打印"不消费 context"警告）
  // 用静态 message.error 是否被调用来区分这两条路。

  it('正确挂载时**不**经过 antd 静态 message', async () => {
    // 必须从 'antd' 取 message —— 与 feedback.ts 用的是同一个说明符。
    // 用 'antd/es/message' 在 vitest 下可能解析成另一个模块实例，spy 就白打了。
    const { message: staticMessage } = await import('antd');
    const spy = vi.spyOn(staticMessage, 'error').mockImplementation((() => {}) as never);

    mount(
      <ConfigProvider>
        <AntdApp component={false}>
          <FeedbackBridge />
        </AntdApp>
      </ConfigProvider>,
    );
    toast.error('走上下文');

    expect(spy, '桥挂对了就不该落到静态 API').not.toHaveBeenCalled();
  });

  it('缺 antd <App> 时退回静态 message（证明上一条的断言确实有区分度）', async () => {
    const { message: staticMessage } = await import('antd');
    const spy = vi.spyOn(staticMessage, 'error').mockImplementation((() => {}) as never);

    mount(
      <ConfigProvider>
        <FeedbackBridge />
      </ConfigProvider>,
    );
    toast.error('只能退回静态');

    expect(spy, '桥挂错位置时必须退回静态 API（否则这条测试没有区分度）').toHaveBeenCalled();
  });
});

describe('真实 <App /> 树里桥位正确', () => {
  it('触发 toast 不抛异常', async () => {
    const { invokeMock, listenMock } = vi.hoisted(() => {
      const invokeMock = vi.fn();
      const listenMock = vi.fn();
      listenMock.mockResolvedValue(() => {});
      return { invokeMock, listenMock };
    });
    vi.doMock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
    vi.doMock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
    vi.doMock('@tauri-apps/api/event', () => ({ listen: (...a: unknown[]) => listenMock(...a) }));
    invokeMock.mockRejectedValue(new Error('ipc 不可用（本测试只关心 toast 通道）'));

    const { message: staticMessage } = await import('antd');
    const spy = vi.spyOn(staticMessage, 'error').mockImplementation((() => {}) as never);

    const { default: RealApp } = await import('@/App');
    const { createRoot: create } = await import('react-dom/client');
    const div = document.createElement('div');
    document.body.appendChild(div);
    const r = create(div);
    await act(async () => {
      r.render(<RealApp />);
    });
    await act(async () => {
      await new Promise((res) => setTimeout(res, 60));
    });

    expect(() => toast.error('真实 App 树')).not.toThrow();
    // 关键断言：真实应用树里桥必须挂对，不许落到静态 API（线上 bug 就是这层包裹丢了）
    expect(spy, 'App 里 FeedbackBridge 必须在 antd <App> 内').not.toHaveBeenCalled();

    await act(async () => r.unmount());
    div.remove();
  });
});
