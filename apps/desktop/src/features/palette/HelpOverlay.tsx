"use no memo";
/** 快捷键速查 + 改绑（docs/07：可自定义；冲突检测） */
import { useMemo, useState } from 'react';
import { Modal } from 'antd';
import { allCommands, registrySize } from '@/lib/commands';
import { chordOf, conflictsFor, displayChord, keysFor, saveOverride } from '@/lib/keymap';
import { useUi } from '@/stores/ui';

export function HelpOverlay() {
  const open = useUi((s) => s.helpOpen);
  const setOpen = useUi((s) => s.setHelpOpen);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);
  // registry 是外部可变状态：以 open 为显式依赖重算，避免编译器 memo 复用旧元素（M1 修正记录）
  const cmds = useMemo(() => allCommands(), [open]);

  const startCapture = (id: string) => {
    setConflict(null);
    setCapturing(id);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      window.removeEventListener('keydown', onKey, true);
      setCapturing(null);
      if (e.key === 'Escape') return;
      const chord = chordOf(e);
      const conflicts = conflictsFor(chord, id);
      if (conflicts.length > 0) {
        setConflict(`「${displayChord(chord)}」已被 ${conflicts.join(', ')} 占用，未保存`);
        return;
      }
      saveOverride(id, chord);
    };
    window.addEventListener('keydown', onKey, true);
  };

  console.debug('[help] render cmds =', cmds.length, 'registry =', registrySize(), 'open =', open);
  return (
    <Modal
      open={open}
      title={`快捷键（${cmds.length}/${registrySize()}）`}
      footer={null}
      onCancel={() => {
        setOpen(false);
        setConflict(null);
      }}
      width={560}
      destroyOnHidden
    >
      {conflict && <div className="pg-banner">{conflict}</div>}
      <div className="pg-help-list">
        {cmds.map((c) => {
          const chord = keysFor(c.id);
          return (
            <div key={c.id} className="pg-help-row">
              <span className="pg-help-title">
                {c.title}
                <span className="pg-help-id">{c.id}</span>
              </span>
              <button
                className="pg-btn pg-help-keys"
                title="点击后按下新组合"
                onClick={() => startCapture(c.id)}
              >
                {capturing === c.id ? '按下新组合…' : chord ? displayChord(chord) : '未绑定'}
              </button>
            </div>
          );
        })}
      </div>
      <div className="pg-fg-dim" style={{ marginTop: 8, fontSize: 11 }}>
        点击键位后按新组合即改绑（Esc 取消）；覆盖保存在本地。冲突会被拒绝并提示。
      </div>
    </Modal>
  );
}
