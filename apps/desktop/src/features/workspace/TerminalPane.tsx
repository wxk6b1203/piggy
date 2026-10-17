/**
 * 内嵌终端（docs/04 §1.7）：xterm.js + 真 PTY（Rust `pty.rs`）。
 *
 * ## 它和「bash 面板」不是一回事
 *
 * | | 内嵌终端（本组件） | bash 面板（`BashPanel`） |
 * |---|---|---|
 * | 谁在执行 | **你自己**敲命令，真 shell（pty） | 交给 pi 的 `bash` 工具跑 |
 * | 起始目录 | **当前会话的工作目录**（用户 2026-10-17 明确要求） | 会话 cwd（pi 侧） |
 * | 状态 | 活着的进程（交互式、有 tty） | 一次 RPC 调用的输出流 |
 *
 * ## 生命周期（写清楚，别让用户猜）
 *
 * - 面板打开时创建 PTY 并 `term.open()`；**面板关掉 = 这个终端结束**（组件卸载 →
 *   `pty_close`，shell 进程回收）。这是有意的：面板重新打开时按"当前会话 cwd"重新起一个，
 *   否则"换了个项目点终端，还停在旧目录里"会更让人困惑。要保留会话内进程现状，
 *   就先把面板切成 bash、别关面板（切 pane 不卸载组件）。
 * - 用户点「重启」→ 先关旧的、再按**当前** cwd 起一个新的。
 * - cwd 只在一开始定一次：切换会话标签**不会**把正在用的终端搬走（VS Code 同义）。
 *
 * ## 为什么用 `import()` 拿 xterm
 *
 * xterm + css 约 300 KB，而终端是"按需打开"的：静态 import 会把它塞进主 chunk。
 * `@xterm/xterm/css/xterm.css` 也必须在创建实例前加载（否则瞬间是白底黑字的裸文字）。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/features/common/Icon';
import { cmd, on } from '@/lib/ipc';
import { useTabs } from '@/stores/tabs';
import { useUi } from '@/stores/ui';

type Phase = 'starting' | 'ready' | 'exited' | 'error';

/** PTY 事件负载（Rust `pty:out:<id>`）。 */
type PtyEvent = { data?: string; exited?: boolean };

/**
 * xterm 的配色：从 CSS 令牌现读（`tokens.css` 是唯一真相，深色/浅色两套都在里面）。
 *
 * xterm 的 `theme` 只吃字面色值、读不到 CSS 变量 —— 与 Monaco `defineTheme` 同一个限制
 * （docs/15 规矩 1）。所以这里在**挂载时**读一次计算值；换主题时由下面的 effect 重新读。
 */
function readTheme(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string): string => {
    const v = css.getPropertyValue(name).trim();
    return v === '' ? fallback : v;
  };
  return {
    background: pick('--pg-bg-app', '#1b1b1c'),
    foreground: pick('--pg-fg', '#f9fafb'),
    cursor: pick('--pg-accent', '#7aaaff'),
    cursorAccent: pick('--pg-bg-app', '#1b1b1c'),
    selectionBackground: pick('--pg-active', 'rgba(255,255,255,0.14)'),
    black: '#3b3b3f',
    brightBlack: '#6b6b70',
    red: pick('--pg-error', '#f25a5a'),
    yellow: pick('--pg-warn', '#f59e0b'),
    green: pick('--pg-ok', '#22c55e'),
    blue: pick('--pg-accent', '#7aaaff'),
  };
}

/** 终端字体：与代码块同一套等宽栈（`--pg-mono`，读不出就退系统等宽）。 */
function readFont(): { fontFamily: string; fontSize: number } {
  const css = getComputedStyle(document.documentElement);
  const family = css.getPropertyValue('--pg-mono').trim();
  return {
    fontFamily: family === '' ? "'SF Mono', Menlo, Consolas, monospace" : family,
    fontSize: 12,
  };
}

export function TerminalPane({ tabId, active }: { tabId: string | null; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null);
  const ptyRef = useRef<string | null>(null);
  const [phase, setPhase] = useState<Phase>('starting');
  const [error, setError] = useState<string | null>(null);
  /** 递增 = 重启（重建 PTY 与终端实例） */
  const [generation, setGeneration] = useState(0);
  const theme = useUi((s) => s.theme);
  /** 起终端时用的目录：**只在这一刻读**，之后切换会话不搬家（组件不重挂） */
  const cwd = useTabs((s) => (tabId ? s.tabs[tabId]?.cwd : undefined));
  const cwdRef = useRef<string | null>(null);
  cwdRef.current = cwd ?? null;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    let ptyId: string | null = null;
    let term: import('@xterm/xterm').Terminal | null = null;
    let observer: ResizeObserver | null = null;
    const host = hostRef.current;
    if (!host) return;

    setPhase('starting');
    setError(null);
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !hostRef.current) return;

      term = new Terminal({
        cursorBlink: true,
        fontSize: readFont().fontSize,
        fontFamily: readFont().fontFamily,
        theme: readTheme(),
        scrollback: 5000,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      termRef.current = term;
      fitRef.current = fit;
      const doFit = (): void => {
        try {
          fit.fit();
        } catch {
          // 面板隐藏/尺寸为 0 时 xterm 会抛；下一帧尺寸回来会再触发
        }
      };
      doFit();
      observer = new ResizeObserver(doFit);
      observer.observe(host);

      const r = await cmd<{ id: string }>('pty_open', { cwd: cwdRef.current });
      if (disposed) {
        void cmd('pty_close', { id: r.id });
        return;
      }
      ptyId = r.id;
      ptyRef.current = r.id;

      term.onData((data) => {
        if (!ptyId) return;
        void cmd('pty_write', { id: ptyId, data }).catch((e) => {
          setError(String(e));
          setPhase('error');
        });
      });
      term.onResize(({ rows, cols }) => {
        if (!ptyId) return;
        void cmd('pty_resize', { id: ptyId, rows, cols });
      });
      unlisten = await on(`pty:out:${ptyId}`, (payload) => {
        const p = payload as PtyEvent;
        if (p.exited === true) {
          setPhase('exited');
          term?.write('\r\n\x1b[2m[进程已退出，点「重启」重新开一个终端]\x1b[0m\r\n');
          return;
        }
        if (typeof p.data === 'string') term?.write(p.data);
      });
      setPhase('ready');
      if (active) term.focus();
    })().catch((e) => {
      if (disposed) return;
      setError(String(e));
      setPhase('error');
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      unlisten?.();
      if (ptyId) void cmd('pty_close', { id: ptyId });
      ptyRef.current = null;
      term?.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // `cwdRef` 是 ref（只读一次）；theme 变化不该重建 PTY，见下面的 effect
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  /* 换主题：xterm 的配色是**字面值**，只能改实例选项（不重建终端，否则现场全丢） */
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = readTheme();
  }, [theme]);

  /* 切到终端 pane：把焦点给回终端（否则输入还在 bash 的 textarea 里） */
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    // 面板刚从隐藏变可见时尺寸是刚回来的，先重新 fit 再聚焦
    try {
      fitRef.current?.fit();
    } catch {
      /* 见 doFit */
    }
    term.focus();
  }, [active]);

  const restart = (): void => setGeneration((n) => n + 1);

  return (
    <div className="pg-terminal" data-terminal>
      <div ref={hostRef} className="pg-terminal-host" data-terminal-host />
      {phase !== 'ready' && phase !== 'starting' ? (
        <div className="pg-terminal-note" role="status">
          {phase === 'error'
            ? `终端启动失败：${error ?? '未知错误'}`
            : '终端进程已退出'}
          <button className="pg-terminal-restart" onClick={restart}>
            重启
          </button>
        </div>
      ) : null}
      <button
        className="pg-terminal-reopen"
        title="重启终端（回到当前会话的工作目录）"
        aria-label="重启终端"
        onClick={restart}
      >
        <Icon name="refresh" size={12} />
      </button>
    </div>
  );
}
