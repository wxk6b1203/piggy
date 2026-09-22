/**
 * EditorArea（WP1，docs/04 §1.3/§1.8）：dockview-react 官方绑定。
 * panel：session（会话工作面）/ settings（工具 tab）/ preview（✦ 预览，单实例可替换）/ welcome。
 * 布局持久化：layout_load/save（~/.piggy/layout.json）。
 */
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
} from 'dockview-react';
import { useStore } from 'zustand';
import type { DockviewTheme } from 'dockview';
import { debounce } from '@/lib/debounce';
import { cmd } from '@/lib/ipc';
import { disposeTabListeners } from '@/lib/tabEvents';
import { disposeLive } from '@/lib/live';
import { useTabs, createTab, type TabSnapshot } from '@/stores/tabs';
import { useUi } from '@/stores/ui';
import { useMessages } from '@/stores/messages';
import { SessionWorkspace } from '@/features/chat/SessionWorkspace';
import { SettingsTab } from '@/features/settings/SettingsTab';
import { FilePreview } from '@/features/preview/FilePreview';

export interface SessionParams {
  kind: 'session';
  tabId: string;
  sessionFile: string | null;
  cwd: string;
  title: string;
}
export interface SettingsParams {
  kind: 'settings';
}
export interface PreviewParams {
  kind: 'preview';
  path: string;
}
export type PanelParams = SessionParams | SettingsParams | PreviewParams;

/* ---------------- 面板组件注册表 ---------------- */

const components = {
  session: (props: IDockviewPanelProps<SessionParams>) => <SessionWorkspace tabId={props.params.tabId} />,
  settings: () => <SettingsTab />,
  preview: (props: IDockviewPanelProps<PreviewParams>) => <FilePreview path={props.params.path} />,
  missing: () => <div className="pg-missing">会话文件不存在或已删除（可关闭此标签）</div>,
  welcome: () => (
    <div className="pg-welcome">
      <div className="pg-welcome-logo">🐷</div>
      <div className="pg-welcome-title">Piggy</div>
      <div className="pg-welcome-hint">从左侧选择一个会话，或新建会话开始</div>
    </div>
  ),
};

/** tab 头：流式 ● / 未读 • 徽标（订阅 tabsStore，响应式） */
function PgTab(props: IDockviewPanelHeaderProps) {
  const tabId = (props.params as SessionParams | undefined)?.tabId ?? null;
  const unread = useStore(useTabs, (s) => (tabId ? !!s.unread[tabId] : false));
  const busy = useStore(useTabs, (s) => (tabId ? s.tabs[tabId]?.workerState === 'busy' : false));
  const dot = busy ? ' ●' : unread ? ' •' : '';
  return (
    <div className="pg-dv-tab">
      <span className="pg-dv-tab-title">
        {props.api.title}
        {dot}
      </span>
    </div>
  );
}

let api: DockviewApi | null = null;
const persist = debounce(() => {
  if (!api) return;
  void cmd('layout_save', {
    value: { dockview: api.toJSON(), updated_at: Date.now() },
  }).catch(() => {});
}, 800);

function onReady(e: DockviewReadyEvent) {
  api = e.api;
  e.api.onDidActivePanelChange((ev) => {
    const tabId = (ev.panel?.params as SessionParams | undefined)?.tabId;
    if (tabId) useTabs.getState().setActive(tabId);
  });
  e.api.onDidRemovePanel((panel) => {
    const tabId = (panel.params as SessionParams | undefined)?.tabId;
    if (tabId) {
      void cmd('tab_close', { tabId }).catch(() => {});
      disposeTabListeners(tabId);
      disposeLive(tabId);
      useTabs.getState().removeTab(tabId);
      useMessages.getState().remove(tabId);
    }
    persist();
  });
  e.api.onDidAddPanel(() => persist());
  e.api.onDidLayoutChange(() => persist());
  void restore();
}

function ensureTab(snap: TabSnapshot) {
  const t = useTabs.getState();
  t.addTab(snap);
  void import('@/lib/tabEvents').then(({ ensureTabListeners }) => ensureTabListeners(snap.tab_id));
  void cmd<{ messages: unknown[] }>('pi_get_messages', { tabId: snap.tab_id })
    .then((r) => useMessages.getState().hydrate(snap.tab_id, r.messages as never[]))
    .catch(() => {});
}

/** 启动恢复：读取持久化布局 → 为 session 面板重建 worker → tabId 重映射 → fromJSON */
async function restore() {
  if (!api) return;
  try {
    interface DockviewJson {
      panels?: Record<string, { params?: PanelParams }>;
    }
    const layout = await cmd<{ dockview?: DockviewJson }>('layout_load');
    const serialized = layout?.dockview;
    if (serialized?.panels && Object.keys(serialized.panels).length > 0) {
      for (const p of Object.values(serialized.panels)) {
        const params = p.params;
        if (params?.kind === 'session') {
          try {
            const snap: TabSnapshot = await createTab({
              sessionPath: params.sessionFile ?? undefined,
              cwd: params.cwd,
            });
            ensureTab(snap);
            params.tabId = snap.tab_id;
            params.sessionFile = snap.session_file;
          } catch {
            p.params = { kind: 'preview', path: '__missing__' };
          }
        }
      }
      api.fromJSON(serialized as never);
      if (api.panels.length === 0) await openWelcome();
      return;
    }
  } catch {
    /* 布局损坏 → 全新开始 */
  }
  await openWelcome();
}

/* ---------------- 对外打开 API（sidebar / palette 调用） ---------------- */

export async function openSessionTab(snap: TabSnapshot, title: string) {
  ensureTab(snap);
  api?.addPanel({
    id: `session:${snap.tab_id}`,
    component: 'session',
    title,
    params: {
      kind: 'session',
      tabId: snap.tab_id,
      sessionFile: snap.session_file,
      cwd: snap.cwd,
      title,
    } satisfies PanelParams,
  });
  api?.getPanel(`session:${snap.tab_id}`)?.focus();
}

export function openSettingsTab() {
  const id = 'settings';
  if (api?.getPanel(id)) {
    api.getPanel(id)!.focus();
    return;
  }
  api?.addPanel({ id, component: 'settings', title: '设置', params: { kind: 'settings' } });
}

export function openPreviewTab(key: string, path: string, title: string) {
  const id = `preview:${key}`;
  api?.getPanel(id)?.api.close();
  api?.addPanel({ id, component: 'preview', title: `✦ ${title}`, params: { kind: 'preview', path } });
}

export function closeActivePanel() {
  if (!api) return;
  const active = api.activePanel ?? api.panels.find((x) => x.id === `session:${useTabs.getState().activeTabId}`);
  active?.api.close();
}

export async function openWelcome() {
  if (api?.getPanel('welcome')) return;
  api?.addPanel({ id: 'welcome', component: 'welcome', title: 'Piggy', params: {} });
}

const darkTheme: DockviewTheme = { name: 'piggy-dark', className: 'pg-dv-theme-dark', colorScheme: 'dark' };
const lightTheme: DockviewTheme = { name: 'piggy-light', className: 'pg-dv-theme-light', colorScheme: 'light' };

export function EditorArea() {
  const themeName = useUi((s) => s.theme);
  return (
    <div className="pg-editor-area">
      <DockviewReact
        components={components}
        tabComponents={{ default: PgTab }}
        onReady={onReady}
        theme={themeName === 'dark' ? darkTheme : lightTheme}
        className="pg-dv"
      />
    </div>
  );
}
