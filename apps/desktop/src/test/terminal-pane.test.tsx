// @vitest-environment jsdom
/**
 * 内嵌终端（`features/workspace/TerminalPane.tsx`，docs/04 §1.7）。
 *
 * 起因（2026-10-17 用户）："内嵌终端需要实现，按 vscode 的快捷键是 ctrl+`，
 * 需要加个图标按钮在合适的位置，**默认跳转到当前的工作目录**"。
 * 此前 `pty.rs` 把起始目录写死成主目录（当时只服务 OAuth 登录），所以"当前项目"
 * 这件事在终端里从来没成立过 —— 这份用例第一条就是钉它。
 *
 * xterm 本身在 jsdom 里跑不起来（要 canvas / 真实尺寸），所以这里替身掉
 * `@xterm/xterm` 与 addon：**验的是接线**（谁在什么时候、用什么参数、发了哪些命令），
 * 不是 xterm 的渲染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';

const { invokeMock, writers, instances } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  /** 所有写进终端的文本（按实例顺序） */
  writers: [] as string[],
  instances: [] as unknown[],
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (channel: string, cb: (e: { payload: unknown }) => void) => {
    bus.set(channel, cb);
    return () => bus.delete(channel);
  },
}));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));
vi.mock('@/lib/feedback', () => {
  const toast = { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn(), loading: vi.fn() };
  return { toast, FeedbackBridge: () => null, confirm: vi.fn() };
});

/* xterm 替身：只保留接线用得到的那几个方法 */
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {};
    private dataCb: ((d: string) => void) | null = null;
    private resizeCb: ((s: { rows: number; cols: number }) => void) | null = null;
    constructor(opts: Record<string, unknown>) {
      this.options = opts;
      instances.push(this);
    }
    open(): void {}
    write(text: string): void {
      writers.push(text);
    }
    focus(): void {}
    dispose(): void {}
    loadAddon(): void {}
    onData(cb: (d: string) => void): void {
      this.dataCb = cb;
    }
    onResize(cb: (s: { rows: number; cols: number }) => void): void {
      this.resizeCb = cb;
    }
    /** 替身专用：模拟用户敲键 */
    type(data: string): void {
      this.dataCb?.(data);
    }
    resize(rows: number, cols: number): void {
      this.resizeCb?.({ rows, cols });
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }));

import { TerminalPane } from '@/features/workspace/TerminalPane';
import { useTabs } from '@/stores/tabs';
import { useUi } from '@/stores/ui';
import { domContainer, mountDom, unmountDom } from './dom-render';

const bus = new Map<string, (e: { payload: unknown }) => void>();
const TAB = 'tab-term';

type Call = { cmd: string; args: Record<string, unknown> };
let calls: Call[] = [];

function installBackend(): void {
  calls = [];
  let n = 0;
  invokeMock.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
    calls.push({ cmd: name, args: args ?? {} });
    if (name === 'pty_open') {
      n += 1;
      return { id: `pty-${n}`, rows: 24, cols: 80 };
    }
    return null;
  });
}

const callsOf = (cmd: string): Call[] => calls.filter((c) => c.cmd === cmd);

/**
 * 等 TerminalPane 里那几层 await（dynamic import xterm → pty_open → 挂 pty:out 监听）落地。
 *
 * ⚠️ 不能写成"flush 固定次数"：全套件并发跑时，动态 import 的耗时会被别的 worker 拖长，
 * 固定次数会在重负载下偶发失败（实测：单跑绿、全套件偶尔红）。这里按**条件**等。
 */
async function waitFor(pred: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i += 1) {
    if (pred()) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
  }
  throw new Error(`超时：${label}`);
}

const settle = (): Promise<void> =>
  waitFor(() => callsOf('pty_open').length > 0 && [...bus.keys()].some((k) => k.startsWith('pty:out:')), '终端初始化');

beforeEach(() => {
  vi.clearAllMocks();
  writers.length = 0;
  instances.length = 0;
  bus.clear();
  installBackend();
  useTabs.setState({
    tabs: { [TAB]: { tabId: TAB, sessionFile: '/tmp/s.jsonl', cwd: '/tmp/proj', workerState: 'ready' } } as never,
    order: [TAB],
    activeTabId: TAB,
    unread: {},
    banner: null,
  });
  useUi.setState({ panelOpen: true, panelPane: 'terminal' });
});

afterEach(async () => {
  await unmountDom();
});

describe('内嵌终端', () => {
  it('起始目录 = 当前会话的工作目录（不是主目录）', async () => {
    mountDom(<TerminalPane tabId={TAB} active />);
    await settle();

    const opens = callsOf('pty_open');
    expect(opens, '打开面板就该起一个 PTY').toHaveLength(1);
    expect(opens[0]!.args.cwd, '终端必须落在当前工作目录（用户 2026-10-17 明确要求）').toBe('/tmp/proj');
  });

  it('PTY 输出写进终端；键盘输入与尺寸变化发回 PTY', async () => {
    mountDom(<TerminalPane tabId={TAB} active />);
    await settle();

    // Rust 侧的 pty:out 通道 → xterm.write
    const onOut = bus.get('pty:out:pty-1');
    expect(onOut, '没监听 pty:out:<id>').toBeTruthy();
    await act(async () => {
      onOut!({ payload: { data: 'hello\r\n' } });
      await Promise.resolve();
    });
    expect(writers).toContain('hello\r\n');

    // 键盘 → pty_write
    const term = instances[0] as { type(d: string): void; resize(r: number, c: number): void };
    await act(async () => {
      term.type('ls -la\r');
      await Promise.resolve();
    });
    expect(callsOf('pty_write').at(-1)?.args).toEqual({ id: 'pty-1', data: 'ls -la\r' });

    // 尺寸 → pty_resize
    await act(async () => {
      term.resize(40, 120);
      await Promise.resolve();
    });
    expect(callsOf('pty_resize').at(-1)?.args).toEqual({ id: 'pty-1', rows: 40, cols: 120 });
  });

  it('面板关闭（组件卸载）= 结束这个终端：pty_close 被调用', async () => {
    mountDom(<TerminalPane tabId={TAB} active />);
    await settle();
    expect(callsOf('pty_close')).toHaveLength(0);

    await unmountDom();
    expect(callsOf('pty_close').map((c) => c.args.id)).toEqual(['pty-1']);
  });

  it('进程退出 → 显示提示与「重启」；重启按当前目录起新 PTY', async () => {
    mountDom(<TerminalPane tabId={TAB} active />);
    await settle();

    await act(async () => {
      bus.get('pty:out:pty-1')!({ payload: { exited: true } });
      await Promise.resolve();
    });
    expect(domContainer().textContent).toContain('终端进程已退出');

    // 重启按钮（面板右下角那颗，aria-label 固定）
    const btn = domContainer().querySelector('[aria-label="重启终端"]') as HTMLButtonElement | null;
    expect(btn, '找不到重启按钮').toBeTruthy();
    await act(async () => {
      btn!.click();
      await Promise.resolve();
    });
    await waitFor(() => callsOf('pty_open').length === 2, '重启后的第二个 PTY');
    expect(callsOf('pty_open')).toHaveLength(2);
    expect(callsOf('pty_close').map((c) => c.args.id)).toContain('pty-1');
  });
});

describe('面板开合（store）', () => {
  it('Ctrl+` 的手势语义：togglePanel("terminal") 开/合；已开着 bash 时切回终端', () => {
    const ui = useUi.getState();
    ui.setPanelOpen(false);
    useUi.getState().togglePanel('terminal');
    expect(useUi.getState().panelOpen).toBe(true);
    expect(useUi.getState().panelPane).toBe('terminal');

    // 开着终端时再按 = 收起（VS Code 同义）
    useUi.getState().togglePanel('terminal');
    expect(useUi.getState().panelOpen).toBe(false);

    // 开着 bash 时按终端键 = 切 pane，不收起
    useUi.getState().togglePanel('bash');
    useUi.getState().togglePanel('terminal');
    expect(useUi.getState().panelOpen).toBe(true);
    expect(useUi.getState().panelPane).toBe('terminal');
  });
});
