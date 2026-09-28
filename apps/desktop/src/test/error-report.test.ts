// @vitest-environment jsdom
/**
 * webview 错误上报：三种 `window.onerror` 形状分开说，且连发的同一条折叠成一条。
 *
 * 起因（用户 2026-09-23 贴的日志）：
 *
 * ```text
 * [piggy][webview][ERROR] [window.error] 资源加载失败: ? ResizeObserver loop completed with undelivered notifications.  ×3
 * ```
 *
 * 这条日志有两处毛病，都让排查多绕了一圈：
 *   1. `window.onerror` 对合成事件（ResizeObserver 循环警告、跨域脚本错误）
 *      既没有 `error`、也没有元素，旧实现一律写成"资源加载失败: ?" —— 于是我先去查资源加载；
 *   2. 浏览器把同一条警告连着报三遍，终端里像出了三个问题。
 *
 * 现在：形状三分（运行时异常 / 真资源失败 / 合成事件）+ 循环警告附 `lib/resizeProbe`
 * 的现场报告（谁建的观察者、最后回调来自哪）+ 3 秒窗口内的同文本折叠并记条数。
 *
 * 红检方式（改坏哪一条会红）：把三分改回"没有 error 就是资源加载失败"→ 第三条红；
 * 去掉 `collapseRepeats` → 第四条红。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collapseRepeats, installGlobalErrorReporting } from '@/features/common/ErrorBoundary';

interface Logged {
  level: string;
  message: string;
}

const logs: Logged[] = [];

/** 假的宿主桥：`reportToHost` 认的就是 `__TAURI_INTERNALS__.invoke` */
function stubHost(): void {
  (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: (_cmd: string, args: Logged) => {
      logs.push(args);
      return Promise.resolve();
    },
  };
}

function synthetic(message: string): void {
  window.dispatchEvent(new ErrorEvent('error', { message }));
}

beforeAll(() => {
  stubHost();
  // 只装一次：装两次会让每个事件打两条（重复计数也就失去意义）
  installGlobalErrorReporting();
});

beforeEach(() => {
  logs.length = 0;
});

describe('window.onerror 的三种形状', () => {
  it('运行时异常：带上 message 与调用栈', () => {
    const err = new Error('boom');
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: err }));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toContain('[window.error] boom');
    expect(logs[0]!.message).toContain('error-report.test'); // 栈里有本文件名
  });

  it('真资源加载失败：说清是哪个标签、哪个地址', () => {
    // 得挂进文档：错误事件不冒泡出传播路径，游离元素的事件到不了 window
    const img = document.createElement('img');
    img.setAttribute('src', '/missing.png');
    document.body.appendChild(img);
    img.dispatchEvent(new Event('error', { bubbles: true }));
    img.remove();
    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toContain('资源加载失败: img /missing.png');
  });

  it('合成事件（ResizeObserver 循环）：不准再说成资源加载失败，并附探针现场', () => {
    synthetic('ResizeObserver loop completed with undelivered notifications.');
    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toContain('[合成事件] ResizeObserver loop completed');
    expect(logs[0]!.message).not.toContain('资源加载失败');
    expect(logs[0]!.message).toContain('观察的元素是否由自己的输出决定大小');
    expect(logs[0]!.message).toContain('RO 探针');
  });

  it('未处理的 Promise 拒绝走自己的标签', () => {
    const ev = new Event('unhandledrejection');
    Object.defineProperty(ev, 'reason', { value: new Error('nope') });
    window.dispatchEvent(ev);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.message).toContain('[unhandledrejection] nope');
  });
});

describe('连发的同一条只留一条', () => {
  it('同一帧里连发三次合成事件 → 只打一条（用户日志里那三行）', () => {
    // 文本带上用例标记：折叠表按"同一条文本"结算，跨用例复用同一句会互相吞
    const msg = 'ResizeObserver loop completed with undelivered notifications.（连发用例）';
    synthetic(msg);
    synthetic(msg);
    synthetic(msg);
    expect(logs).toHaveLength(1);
  });

  it('窗口内折叠、窗口外补一条并说明折叠了几条', () => {
    const key = '[window.error] 折叠口径单测';
    expect(collapseRepeats(key, 1_000)).toBe(''); // 第一条：照打
    expect(collapseRepeats(key, 1_500)).toBeNull(); // 窗口内：折掉
    expect(collapseRepeats(key, 2_000)).toBeNull();
    expect(collapseRepeats(key, 4_500)).toBe('（同类已折叠 2 条）');
    expect(collapseRepeats(key, 4_600)).toBeNull();
    expect(collapseRepeats(key, 9_000)).toBe('（同类已折叠 1 条）');
  });

  it('不同的错误各算各的（折叠不能把别的错误吞了）', () => {
    const a = '[window.error] 甲';
    const b = '[window.error] 乙';
    expect(collapseRepeats(a, 10_000)).toBe('');
    expect(collapseRepeats(b, 10_000)).toBe('');
    expect(collapseRepeats(a, 10_100)).toBeNull();
    expect(collapseRepeats(b, 10_100)).toBeNull();
  });
});
