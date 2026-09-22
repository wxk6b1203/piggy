/** 应用命令注册（docs/07 §2 默认键位表的 M1 子集）+ Keymap 挂载 */
import { useEffect } from 'react';
import { registerCommand } from '@/lib/commands';
import { useKeymap } from '@/lib/keymap';
import { useUi } from '@/stores/ui';
import { useTabs } from '@/stores/tabs';
import { cmd } from '@/lib/ipc';
import { openSessionTab, openSettingsTab } from '@/features/workspace/EditorArea';
import { createTab } from '@/stores/tabs';
import { windowEvents } from '@/lib/windowEvents';

export function useAppCommands() {
  useEffect(() => {
    const ui = () => useUi.getState();
    const tabs = () => useTabs.getState();

    registerCommand({
      id: 'palette.open',
      title: '命令面板',
      category: '应用',
      keys: 'cmd+k',
      whenInInput: true,
      run: () => ui().setPaletteOpen(true),
    });
    registerCommand({
      id: 'settings.open',
      title: '打开设置',
      category: '应用',
      keys: 'cmd+,',
      run: () => openSettingsTab(),
    });
    registerCommand({
      id: 'session.new',
      title: '新建会话',
      category: '会话',
      keys: 'cmd+n',
      run: async () => {
        try {
          const snap = await createTab({ name: '新会话' });
          await openSessionTab(snap, '新会话');
        } catch (e) {
          console.error(e);
        }
      },
    });
    registerCommand({
      id: 'tab.close',
      title: '关闭当前标签',
      category: '会话',
      keys: 'cmd+w',
      run: () => windowEvents.emit('close-active-tab'),
    });
    registerCommand({
      id: 'sidebar.toggle',
      title: '切换侧栏',
      category: '视图',
      keys: 'cmd+b',
      run: () => ui().setSidebarOpen(!ui().sidebarOpen),
    });
    registerCommand({
      id: 'theme.toggle',
      title: '切换主题',
      category: '视图',
      keys: 'cmd+shift+t',
      run: () => ui().toggleTheme(),
    });
    registerCommand({
      id: 'model.pick',
      title: '选择模型',
      category: '模型',
      keys: 'cmd+l',
      run: () => windowEvents.emit('open-model-picker'),
    });
    registerCommand({
      id: 'thinking.cycle',
      title: '循环 thinking 级别',
      category: '模型',
      keys: 'cmd+e',
      run: async () => {
        const tabId = tabs().activeTabId;
        if (!tabId) return;
        try {
          const r = await cmd<{ level?: string; data?: { level?: string } }>('pi_cycle_thinking', { tabId });
          tabs().patch(tabId, { thinkingLevel: r.level ?? r.data?.level ?? null });
        } catch (e) {
          console.error(e);
        }
      },
    });
    registerCommand({
      id: 'session.search',
      title: '搜索会话',
      category: '会话',
      keys: 'cmd+shift+f',
      run: () => windowEvents.emit('focus-session-search'),
    });
    registerCommand({
      id: 'session.compact',
      title: '压缩上下文',
      category: '会话',
      keys: 'cmd+shift+k',
      run: async () => {
        const tabId = tabs().activeTabId;
        if (!tabId) return;
        try {
          await cmd('pi_compact', { tabId });
        } catch (e) {
          console.error(e);
        }
      },
    });
    registerCommand({
      id: 'bash.toggle',
      title: '切换终端面板',
      category: '视图',
      keys: 'cmd+j',
      run: () => windowEvents.emit('toggle-bash-panel'),
    });
    registerCommand({
      id: 'help.shortcuts',
      title: '快捷键速查',
      category: '应用',
      keys: 'cmd+/',
      whenInInput: true,
      run: () => ui().setHelpOpen(true),
    });

    // 第三方：tab.close 的执行者（AppFrame 订阅）
  }, []);

  useKeymap();
}
