/**
 * 底部面板（docs/04 §1.7）：两个 pane 共用一条标题条 ——
 *
 * ```
 * ┌ 终端 │ bash ─────────────────────────── Ctrl+` │ ✕ ┐
 * │  （真实 shell，cwd = 当前会话工作目录）              │
 * └─────────────────────────────────────────────────────┘
 * ```
 *
 * 两个 pane **都保持挂载**（非活动的那个 `hidden`）：切 pane 不卸载组件 =
 * 终端里的进程与现场不会被"我就看一眼 bash"顺手杀掉。关面板才卸载（`AppFrame` 条件渲染），
 * 那时 `TerminalPane` 的 cleanup 会 `pty_close` 回收 shell。
 */
import { Icon } from '@/features/common/Icon';
import { useUi } from '@/stores/ui';
import { BashPanel } from './BashPanel';
import { TerminalPane } from './TerminalPane';

export function BottomPanel({ tabId }: { tabId: string | null }) {
  const pane = useUi((s) => s.panelPane);
  const setPane = useUi((s) => s.setPanelPane);
  const setOpen = useUi((s) => s.setPanelOpen);

  return (
    <div className="pg-bottompanel" data-bottom-panel>
      <div className="pg-panel-tabs" role="tablist" aria-label="底部面板">
        <button
          type="button"
          role="tab"
          className="pg-panel-tab"
          data-panel-tab="terminal"
          aria-selected={pane === 'terminal'}
          onClick={() => setPane('terminal')}
        >
          <Icon name="terminal" size={13} />
          终端
        </button>
        <button
          type="button"
          role="tab"
          className="pg-panel-tab"
          data-panel-tab="bash"
          aria-selected={pane === 'bash'}
          onClick={() => setPane('bash')}
        >
          <Icon name="terminal-bash" size={13} />
          bash
        </button>
        <span className="pg-panel-tabs-spacer" />
        <kbd className="pg-panel-kbd">Ctrl+`</kbd>
        <button
          type="button"
          className="pg-panel-close"
          aria-label="关闭面板"
          title="关闭面板（Ctrl+`）"
          onClick={() => setOpen(false)}
        >
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="pg-panel-body" hidden={pane !== 'terminal'}>
        <TerminalPane tabId={tabId} active={pane === 'terminal'} />
      </div>
      <div className="pg-panel-body" hidden={pane !== 'bash'}>
        <BashPanel tabId={tabId} />
      </div>
    </div>
  );
}
