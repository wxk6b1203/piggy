/**
 * 内嵌终端（docs/09 M4）：OAuth 登录路线——PTY（Rust portable-pty）+ xterm.js。
 * 用法：设置 → Provider 认证 → 「内嵌终端登录…」；终端内运行 `pi` 后输入 `/login`。
 * 生命周期：Modal 关闭即 pty_close（shell 进程回收，M4 契约"防孤儿"）。
 */
import { useEffect, useRef, useState } from 'react';
import { Modal } from 'antd';
import { cmd, on } from '@/lib/ipc';

type TermModule = typeof import('@xterm/xterm');

export function LoginTerminalModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [ptyId, setPtyId] = useState<string | null>(null);
  const termRef = useRef<import('@xterm/xterm').Terminal | null>(null);

  useEffect(() => {
    if (!open) return;
    let localPtyId: string | null = null;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import('@xterm/xterm'),
        import('@xterm/addon-fit'),
      ]);
      await import('@xterm/xterm/css/xterm.css');
      if (disposed || !hostRef.current) return;
      const term = new Terminal({ fontSize: 12, cursorBlink: true });
      termRef.current = term;
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(hostRef.current);
      fit.fit();
      term.writeln('Piggy 内嵌终端：运行 `pi`，然后在 pi 里输入 /login 完成订阅登录。');
      term.onData((data) => {
        if (localPtyId) void cmd('pty_write', { id: localPtyId, data });
      });
      const r = await cmd<{ id: string }>('pty_open', {});
      if (disposed) {
        void cmd('pty_close', { id: r.id });
        return;
      }
      localPtyId = r.id;
      setPtyId(r.id);
      unlisten = await on(`pty:out:${r.id}`, (payload) => {
        const p = payload as { data?: string };
        if (p.data) term.write(p.data);
      });
      if (term.rows && localPtyId) {
        void cmd('pty_resize', { id: localPtyId, rows: term.rows, cols: term.cols });
      }
      term.focus();
    })();

    return () => {
      disposed = true;
      unlisten?.();
      if (localPtyId) void cmd('pty_close', { id: localPtyId });
      termRef.current?.dispose();
      termRef.current = null;
      setPtyId(null);
    };
  }, [open]);

  return (
    <Modal
      title={`内嵌终端${ptyId ? '' : '（连接中…）'}`}
      open={open}
      footer={null}
      width={760}
      onCancel={onClose}
      destroyOnHidden
    >
      <div
        ref={hostRef}
        style={{ height: 420, background: '#111', borderRadius: 6, padding: 6 }}
      />
    </Modal>
  );
}
