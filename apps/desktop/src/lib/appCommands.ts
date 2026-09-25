/** 应用命令注册（docs/07 §2 默认键位表的 M1 子集）+ Keymap 挂载 */
import { useEffect } from 'react';
import { registerCommand } from '@/lib/commands';
import { useKeymap } from '@/lib/keymap';
import { useUi } from '@/stores/ui';
import { useTabs } from '@/stores/tabs';
import { cmd } from '@/lib/ipc';
import {
  closeAllTabs,
  closeOtherTabs,
  openSessionTab,
  openSettingsTab,
} from '@/features/workspace/EditorArea';
import { createTab } from '@/stores/tabs';
import { windowEvents } from '@/lib/windowEvents';
import { toast } from '@/lib/feedback';
import { describeRun, generateTitle } from '@/lib/sessionTitle';
import { useSessions } from '@/stores/sessions';

/**
 * 生成/重新生成**当前会话**的标题（docs/03 §2.16）。
 *
 * 与侧栏右键菜单走同一个后端命令。这里必须先解析出"当前会话的 path"——
 * 命令面板只知道 `activeTabId`，会话文件在 tabs store 里。
 */
export async function generateTitleForActiveTab(): Promise<void> {
  const { tabs, activeTabId } = useTabs.getState();
  const path = activeTabId ? tabs[activeTabId]?.sessionFile : null;
  if (!path) {
    toast.error('当前没有打开任何会话');
    return;
  }
  try {
    const r = await generateTitle(path);
    // 侧栏显示的是 session_list 的结果，生成完必须重新拉一次
    await useSessions.getState().load();
    toast.success(`标题已更新为「${r.title}」（${describeRun(r)}）`);
  } catch (e) {
    toast.error(`生成标题失败：${e}`);
  }
}

/**
 * 新建会话标签。
 *
 * 抽成函数是因为它有**两条入口**：⌘N / 命令面板（`session.new`）与折叠态图标轨
 * （`SidebarRail`）。两条入口必须走同一条路——否则改了一处、另一处悄悄不一样。
 */
export async function newSessionTab(): Promise<void> {
  try {
    const snap = await createTab({ name: '新会话' });
    await openSessionTab(snap, '新会话');
  } catch (e) {
    console.error(e);
  }
}

export function useAppCommands() {
  useEffect(() => {
    const ui = () => useUi.getState();
    const tabs = () => useTabs.getState();

    registerCommand({
      id: 'session.title.generate',
      title: '生成会话标题',
      category: '会话',
      run: () => void generateTitleForActiveTab(),
    });

    registerCommand({
      id: 'session.title.regenerate',
      title: '重新生成会话标题',
      category: '会话',
      run: () => void generateTitleForActiveTab(),
    });

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
      run: () => newSessionTab(),
    });
    registerCommand({
      id: 'tab.close',
      title: '关闭当前标签',
      category: '会话',
      keys: 'cmd+w',
      run: () => windowEvents.emit('close-active-tab'),
    });
    registerCommand({
      id: 'tab.closeOthers',
      title: '关闭其他标签',
      category: '会话',
      keys: 'cmd+alt+w',
      run: () => closeOtherTabs(),
    });
    registerCommand({
      id: 'tab.closeAll',
      title: '关闭全部标签',
      category: '会话',
      keys: 'cmd+shift+w',
      run: () => closeAllTabs(),
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
      // Composer 里的模型选择器监听这个信号并展开自己的菜单（Picker.openSignal）。
      // 信号必须在有活动会话时才有意义——没有 tab 就没有锚点。
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
      id: 'openin.pick',
      title: '打开方式（在外部应用中打开工作目录）',
      category: '视图',
      // 与 `model.pick` 同一个套路：命令只发信号，真正的菜单挂在会话头部那颗胶囊上。
      // **故意不给默认键位** —— DSH 也没有（它的入口只有头部那颗按钮），
      // 与其编一个占用用户键位的组合，不如让它在命令面板里可达。
      run: () => windowEvents.emit('open-in-app-picker'),
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
