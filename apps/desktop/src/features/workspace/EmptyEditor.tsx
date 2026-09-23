/**
 * 空编辑区占位（VS Code 的 empty editor group / DSH 的空水面）。
 *
 * 为什么需要：**关掉全部标签之后，编辑区只剩一片黑** —— 没有任何入口，也没有一句话
 * 告诉用户这里能干什么（用户截图正是这个状态：标签是空的、侧栏也收起了，整屏无处可点）。
 *
 * 三块内容照 VS Code 的空编辑组（用户给的截图）：
 *   ① 水印：很淡的大 logo，垫在最后面，不吃鼠标事件；
 *   ② 基础快捷键表：左边动作名、右边键位；
 *   ③ 中央入口：点一下就执行（不是纯装饰的说明文字）。
 *
 * ⚠️ 动作名与键位**全部来自命令注册表**（`getCommand` + `keysFor` + `displayChord`），
 * 一个字符串都不写死 —— 写死的话改键位/改标题之后这里就开始骗人，而且没有任何东西会变红。
 * 代价是首帧读不到：注册发生在 `useAppCommands()` 的 effect 里，晚于本组件的首次渲染，
 * 所以挂载后补一帧（`bump`）。这不是轮询，只跑一次。
 */
import { useEffect, useReducer } from 'react';
import { getCommand } from '@/lib/commands';
import { displayChord, keysFor } from '@/lib/keymap';
import { useTabs } from '@/stores/tabs';
import { Icon, type IconName } from '@/features/common/Icon';

/** 快捷键表（顺序即显示顺序；id 必须真在注册表里，`src/test/empty-editor.test.tsx` 会核）。 */
const SHORTCUT_IDS = [
  'session.new',
  'palette.open',
  'session.search',
  'sidebar.toggle',
  'model.pick',
  'help.shortcuts',
];

/** 中央入口：第一个是主入口（实心按钮），其余是次级。 */
const ENTRY_IDS: { id: string; icon: IconName }[] = [
  { id: 'session.new', icon: 'add' },
  { id: 'palette.open', icon: 'chevron-right' },
  { id: 'session.search', icon: 'search' },
  { id: 'settings.open', icon: 'settings-gear' },
  { id: 'help.shortcuts', icon: 'key' },
];

export function EmptyEditor() {
  const [, bump] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    bump(); // 命令注册在 AppFrame 的 effect 里，首帧注册表还是空的
  }, []);

  const run = (id: string) => {
    void getCommand(id)?.run({ activeTabId: useTabs.getState().activeTabId });
  };

  const shortcuts = SHORTCUT_IDS.map((id) => {
    const cmd = getCommand(id);
    const chord = keysFor(id);
    return cmd && chord ? { id, title: cmd.title, keys: displayChord(chord) } : null;
  }).filter((r) => r !== null);

  return (
    <div className="pg-empty">
      <div className="pg-empty-watermark" aria-hidden="true">
        <span className="pg-empty-logo">🐷</span>
        <span className="pg-empty-wordmark">Piggy</span>
      </div>

      <div className="pg-empty-inner">
        {shortcuts.length > 0 && (
          <div className="pg-empty-keys" aria-label="基础快捷键">
            {shortcuts.map((s) => (
              <div key={s.id} className="pg-empty-key-row" data-cmd={s.id}>
                <span className="pg-empty-key-title">{s.title}</span>
                <kbd className="pg-empty-kbd">{s.keys}</kbd>
              </div>
            ))}
          </div>
        )}

        {/* 中央入口：真的会执行命令（走的是与键位/命令面板同一个注册表） */}
        <div className="pg-empty-entries">
          {ENTRY_IDS.map((e, i) => {
            const cmd = getCommand(e.id);
            if (!cmd) return null;
            const chord = keysFor(e.id);
            return (
              <button
                key={e.id}
                type="button"
                data-cmd={e.id}
                className={`pg-empty-entry${i === 0 ? ' pg-empty-entry-primary' : ''}`}
                title={chord ? `${cmd.title}（${displayChord(chord)}）` : cmd.title}
                onClick={() => run(e.id)}
              >
                <Icon name={e.icon} size={14} />
                {cmd.title}
              </button>
            );
          })}
        </div>

        <div className="pg-empty-hint">没有打开的标签 —— 左侧栏可以挑一个历史会话，上面的入口也都能用。</div>
      </div>
    </div>
  );
}
