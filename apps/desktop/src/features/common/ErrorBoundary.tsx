/**
 * 错误边界 + 崩溃可见化。
 *
 * 为什么要这个：打包版/`tauri dev` 里 DevTools 默认打不开，而 React 19 在渲染期抛出
 * 未捕获异常时会**卸载整棵树**——表现就是**全黑窗口，没有任何线索**。
 * （`pnpm tauri dev` 的黑屏就是这么来的。）
 *
 * 这里做两件事：
 *   1. 渲染期异常 → 在页面里直接显示错误与组件栈，肉眼可见，可直接截图；
 *   2. 同时经 IPC 送到 Rust stdout（`webview_log`），终端里也能看到。
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';

/** 尽力把消息送到宿主终端；不在 Tauri 环境（如纯浏览器调试）时静默忽略。 */
export function reportToHost(level: 'error' | 'warn' | 'info', message: string): void {
  try {
    const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: unknown } })
      .__TAURI_INTERNALS__;
    if (!internals?.invoke) return;
    void (internals.invoke as (cmd: string, args: unknown) => Promise<unknown>)('webview_log', {
      level,
      message,
    }).catch(() => {});
  } catch {
    /* 上报失败不能反过来影响应用 */
  }
}

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
  stack: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const stack = info.componentStack ?? '';
    this.setState({ stack });
    reportToHost('error', `[render] ${error.message}\n${error.stack ?? ''}\n${stack}`);
  }

  render(): ReactNode {
    const { error, stack } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="pg-crash" role="alert">
        <h1 className="pg-crash-title">界面渲染失败</h1>
        <p className="pg-crash-hint">
          这条信息同时已写入启动终端（前缀 <code>[piggy][webview]</code>）。请把下面的内容一并反馈。
        </p>
        <pre className="pg-crash-body">{error.message}</pre>
        {error.stack ? <pre className="pg-crash-body pg-crash-dim">{error.stack}</pre> : null}
        {stack ? <pre className="pg-crash-body pg-crash-dim">{stack}</pre> : null}
        <button className="pg-crash-reload" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }
}

/** 安装全局兜底：未捕获异常与未处理的 Promise 拒绝。 */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (e) => {
    // 资源加载失败（img/script）也会走这里，e.error 为 null
    const detail = e.error
      ? `${e.error.message}\n${e.error.stack ?? ''}`
      : `资源加载失败: ${(e.target as HTMLElement | null)?.tagName ?? '?'} ${e.message}`;
    reportToHost('error', `[window.error] ${detail}`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | string | undefined;
    const detail = typeof r === 'string' ? r : `${r?.message ?? String(r)}\n${r?.stack ?? ''}`;
    reportToHost('error', `[unhandledrejection] ${detail}`);
  });
}
