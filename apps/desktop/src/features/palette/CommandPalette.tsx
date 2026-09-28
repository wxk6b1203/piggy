"use no memo";
/** 命令面板（docs/07 §4）：命令 + 会话动态项，↑↓/Enter/Esc，Cmd+K 唤起 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { allCommands, getCommand } from '@/lib/commands';
import { displayChord, keysFor } from '@/lib/keymap';
import { baseName } from '@/lib/paths';
import { useUi } from '@/stores/ui';
import { useSessions, sessionTitle } from '@/stores/sessions';
import { useTabs } from '@/stores/tabs';
import { createTab } from '@/stores/tabs';
import { openSessionTab } from '@/features/workspace/EditorArea';

interface Item {
  key: string;
  title: string;
  hint?: string;
  keys?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setIndex(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    if (!open) return [];
    const q = query.trim().toLowerCase();
    const cmds: Item[] = allCommands().map((c) => ({
      key: `cmd:${c.id}`,
      title: c.title,
      hint: c.category,
      keys: keysFor(c.id),
      run: () => void getCommand(c.id)?.run({ activeTabId: useTabs.getState().activeTabId }),
    }));
    const sessions: Item[] = useSessions
      .getState()
      .groups.flatMap((g) => g.sessions)
      .slice(0, 20)
      .map((m) => ({
        key: `session:${m.path}`,
        title: `打开会话：${sessionTitle(m)}`,
        hint: g0(m.cwd),
        run: () => {
          void (async () => {
            const snap = await createTab({ sessionPath: m.path, cwd: m.cwd ?? undefined });
            await openSessionTab(snap, sessionTitle(m));
          })();
        },
      }));
    const all = [...cmds, ...sessions];
    if (!q) return all.slice(0, 12);
    return all
      .filter((i) => i.title.toLowerCase().includes(q) || i.hint?.toLowerCase().includes(q))
      .slice(0, 12);
  }, [open, query]);

  if (!open) return null;

  const runAt = (i: number) => {
    const item = items[i];
    if (!item) return;
    setOpen(false);
    item.run();
  };

  return (
    <div className="pg-palette-mask" onClick={() => setOpen(false)}>
      <div className="pg-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="pg-palette-input"
          placeholder="输入命令或搜索会话…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              runAt(index);
            }
          }}
        />
        <div className="pg-palette-list">
          {items.map((item, i) => (
            <button
              key={item.key}
              className={`pg-palette-item${i === index ? ' pg-active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => runAt(i)}
            >
              <span className="pg-palette-title">{item.title}</span>
              <span className="pg-palette-hint">
                {item.keys ? displayChord(item.keys) : item.hint}
              </span>
            </button>
          ))}
          {items.length === 0 && <div className="pg-palette-empty">无匹配</div>}
        </div>
      </div>
    </div>
  );
}

function g0(cwd: string | null): string {
  return cwd ? baseName(cwd) : '';
}
