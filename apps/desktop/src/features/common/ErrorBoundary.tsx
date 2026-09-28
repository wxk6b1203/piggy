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
import { resizeProbeHint } from '@/lib/resizeProbe';

/**
 * 同一类错误在这么短的时间内再次到达就算"一次连发"，折叠掉。
 * 3 秒：浏览器报的合成事件警告通常挤在同一两帧里，而真正的重复故障
 * （例如每秒一次的轮询失败）仍然会留下带计数的记录。
 */
const REPEAT_WINDOW_MS = 3000;

/** 最近见过的错误文本 → 首次到达时刻 + 条数（见 {@link collapseRepeats}）。 */
const repeats = new Map<string, { at: number; n: number }>();

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

/**
 * 同一条错误在一瞬间连发多条时，只留一条并记下折叠了几条。
 *
 * 为什么需要：合成事件类的警告（`ResizeObserver loop ...`）浏览器会**连着报同一条**
 * ——用户 2026-09-23 贴的日志就是三行一模一样的内容，终端里看着像出了三个问题。
 * 折叠的判据是"同一条文本在 {@link REPEAT_WINDOW_MS} 内再次到达"，
 * 窗口从**第一条**算起（不因为又来了几条就无限顺延，否则一条每秒一次的
 * 警告会永远不再出现在日志里）。
 *
 * @param key - 事件文本（不含探针那类会变的补充信息）
 * @param now - 当前时刻（注入以便单测不睡等）
 * @returns `''` = 该打这条；`null` = 折叠掉；否则是"同类已折叠 N 条"的说明
 */
export function collapseRepeats(key: string, now: number): string | null {
  const prev = repeats.get(key);
  if (prev && now - prev.at <= REPEAT_WINDOW_MS) {
    prev.n += 1;
    return null;
  }
  // 表只用来记"刚发生过什么"：真有人把唯一 id 拼进消息里也不会把它撑爆
  if (repeats.size > 64) repeats.clear();
  const folded = prev ? prev.n - 1 : 0;
  repeats.set(key, { at: now, n: 1 });
  return folded > 0 ? `（同类已折叠 ${folded} 条）` : '';
}

/** 打一条 webview 错误（先过重复折叠）。 */
function reportWindowError(tag: string, detail: string, extra = ''): void {
  const key = `${tag} ${detail}`;
  const folded = collapseRepeats(key, Date.now());
  if (folded === null) return;
  reportToHost('error', `${tag} ${detail}${extra}${folded}`);
}

/** 安装全局兜底：未捕获异常与未处理的 Promise 拒绝。 */
export function installGlobalErrorReporting(): void {
  window.addEventListener('error', (e) => {
    // 三类事件的形状不一样，日志别混成一句（第一版把所有没有 `e.error` 的都写成
    // "资源加载失败: ?"，于是 ResizeObserver 的那条循环警告看起来像"资源加载失败"，
    // 排查时白绕了一圈 —— 用户 2026-09-23 贴的日志就是这种）。
    let detail: string;
    /** 附在消息末尾的补充信息（探针现场、折叠说明） */
    let extra = '';
    if (e.error) {
      detail = `${e.error.message}\n${e.error.stack ?? ''}`;
    } else if (e.target instanceof HTMLElement || e.target instanceof SVGElement) {
      // 真正的资源加载失败：target 是 img/script/link 元素
      const el = e.target as HTMLElement;
      detail = `资源加载失败: ${el.tagName.toLowerCase()} ${el.getAttribute('src') ?? el.getAttribute('href') ?? ''}`;
    } else {
      // 没有 error、也没有元素：浏览器报的**合成事件**（ResizeObserver 循环警告、
      // 跨域脚本错误等）。原样打出来，并给循环警告一句"谁是嫌疑" + 探针的现场报告。
      const isRoLoop = /ResizeObserver loop/.test(e.message);
      extra = isRoLoop ? `${resizeProbeHint()}` : '';
      if (isRoLoop) {
        extra =
          '（某个 ResizeObserver 回调里改了布局：查"观察的元素是否由自己的输出决定大小"）' + extra;
      }
      detail = `[合成事件] ${e.message}`;
    }
    reportWindowError('[window.error]', detail, extra);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | string | undefined;
    const detail = typeof r === 'string' ? r : `${r?.message ?? String(r)}\n${r?.stack ?? ''}`;
    reportWindowError('[unhandledrejection]', detail);
  });
}
