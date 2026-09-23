/**
 * KeymapService（docs/07 §1）：chord 匹配 + 用户覆盖（localStorage）+ 冲突检测。
 * M1：单键组合（Cmd/Ctrl/Alt/Shift + key）；序列键 = M2。
 */
import { useEffect } from 'react';
import { allCommands, getCommand } from '@/lib/commands';
import { useTabs } from '@/stores/tabs';
import { isMock } from '@/lib/mockBackend';

export const DEFAULT_KEYS: Record<string, string> = {
  'palette.open': 'cmd+k',
  'settings.open': 'cmd+,',
  'session.new': 'cmd+n',
  'session.sleep': 'cmd+shift+s',
  'tab.close': 'cmd+w',
  'sidebar.toggle': 'cmd+b',
  'theme.toggle': 'cmd+shift+t',
  'model.pick': 'cmd+l',
  'thinking.cycle': 'cmd+e',
  'session.search': 'cmd+shift+f',
  'session.compact': 'cmd+shift+k',
  'bash.toggle': 'cmd+j',
  'help.shortcuts': 'cmd+/',
};

const LS_KEY = 'pg.keymap';

export function loadOverrides(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function saveOverride(commandId: string, chord: string | null): void {
  const all = loadOverrides();
  if (chord === null) delete all[commandId];
  else all[commandId] = chord;
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

/** 命令的当前生效键位 */
export function keysFor(commandId: string): string | undefined {
  return loadOverrides()[commandId] ?? DEFAULT_KEYS[commandId];
}

/** 冲突检测：同一 chord 被多个命令占用（除自身） */
export function conflictsFor(chord: string, exceptCommandId?: string): string[] {
  const owners: string[] = [];
  for (const c of allCommands()) {
    if (c.id === exceptCommandId) continue;
    if (keysFor(c.id) === chord) owners.push(c.id);
  }
  return owners;
}

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

/** KeyboardEvent → 规范 chord（mac: cmd/ctrl/alt/shift+key；win/linux: ctrl/alt/shift+key） */
export function chordOf(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.metaKey) parts.push('cmd');
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  let key = e.key.toLowerCase();
  if (key === ' ') key = 'space';
  if (key === 'escape') key = 'esc';
  if (key === ' ') key = 'space';
  parts.push(key);
  const normalized = parts
    .map((p) => (p === 'meta' ? 'cmd' : p))
    .filter((p, i, arr) => arr.indexOf(p) === i);
  // 平台主键统一展示（mac=cmd / 其他=ctrl）
  return normalized.join('+');
}

export function displayChord(chord: string): string {
  const parts = chord.split('+').map((p) => {
    if (p === 'cmd') return isMac ? '⌘' : 'Ctrl';
    if (p === 'ctrl') return isMac ? '⌃' : 'Ctrl';
    if (p === 'alt') return isMac ? '⌥' : 'Alt';
    if (p === 'shift') return '⇧';
    return p.toUpperCase();
  });
  return parts.join(isMac ? '' : '+');
}

function isEditable(t: EventTarget | null): boolean {
  return (
    t instanceof HTMLElement &&
    (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
  );
}

/** 全局 keydown 分发（App 挂载一次；带修饰键的组合在输入框内也生效） */
export function useKeymap() {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const chord = chordOf(e);
      const hasMod = chord.includes('cmd+') || chord.includes('ctrl+');
      if (!hasMod && isEditable(e.target)) return;
      for (const c of allCommands()) {
        if (keysFor(c.id) === chord) {
          if (isMock) console.debug('[keymap]', chord, '->', c.id);
          e.preventDefault();
          void getCommand(c.id)?.run({ activeTabId: useTabs.getState().activeTabId });
          return;
        }
      }
      if (isMock && chord.startsWith('cmd+')) console.debug('[keymap]', chord, '-> (无匹配命令)');
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
