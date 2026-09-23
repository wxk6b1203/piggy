/**
 * EditorArea（WP1，docs/04 §1.3/§1.8）：dockview-react 官方绑定。
 * panel：session（会话工作面）/ settings（工具 tab）/ preview（✦ 预览，单实例可替换）/ welcome。
 * 布局持久化：layout_load/save（~/.piggy/layout.json）。
 */
import {
  DockviewReact,
  type BuiltInContextMenuItem,
  type ReactContextMenuItemConfig,
  type DockviewApi,
  type GetTabContextMenuItemsParams,
  type IDockviewHeaderActionsProps,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  type IDockviewPanelHeaderProps,
} from 'dockview-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import type { DockviewTheme } from 'dockview';
import { debounce } from '@/lib/debounce';
import { cmd } from '@/lib/ipc';
import { disposeTabListeners } from '@/lib/tabEvents';
import { disposeLive } from '@/lib/live';
import { useTabs, createTab, type TabSnapshot } from '@/stores/tabs';
import { useUi } from '@/stores/ui';
import { useMessages } from '@/stores/messages';
import { wakeIfNeeded } from '@/lib/sleep';
import { t } from '@/lib/i18n';
import { Icon } from '@/features/common/Icon';
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
  /** 项目根（快捷编辑的越界守卫边界；缺省 = 只读） */
  root?: string;
}
export type PanelParams = SessionParams | SettingsParams | PreviewParams;

/* ---------------- 面板组件注册表 ---------------- */

const components = {
  session: (props: IDockviewPanelProps<SessionParams>) => <SessionWorkspace tabId={props.params.tabId} />,
  settings: () => <SettingsTab />,
  preview: (props: IDockviewPanelProps<PreviewParams>) => (
    <FilePreview path={props.params.path} root={props.params.root} />
  ),
  missing: () => <div className="pg-missing">会话文件不存在或已删除（可关闭此标签）</div>,
  welcome: () => (
    <div className="pg-welcome">
      <div className="pg-welcome-logo">🐷</div>
      <div className="pg-welcome-title">Piggy</div>
      <div className="pg-welcome-hint">{t('welcome.hint')}</div>
    </div>
  ),
};

/**
 * tab 头：流式 ● / 未读 • 徽标（订阅 tabsStore，响应式）。
 *
 * ⚠️ 必须通过 `defaultTabComponent` 这个**独立 prop** 传进去。
 * dockview-react 的实现是（dist/package/main.esm.mjs:559-566）：
 *   frameworkTabComponents = { ...props.tabComponents };
 *   if (props.defaultTabComponent) frameworkTabComponents['default'] = props.defaultTabComponent;
 *   updateOptions({ defaultTabComponent: props.defaultTabComponent ? 'default' : undefined });
 * 也就是说 `tabComponents={{ default: PgTab }}` **不会生效**——它注册了组件，
 * 但 `defaultTabComponent` 选项仍是 undefined，dockview 会退回它自己的默认 tab。
 * 这个组件曾因此从未渲染过（徽标一直是死的），所以才在 DOM 里只看到 `.dv-default-tab`。
 */
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

// dockview api 存 globalThis：HMR 重载本模块时保活（模块级变量会丢引用导致所有 open* 失效）
interface PiggyGlobals {
  __piggyDock?: DockviewApi;
  /** 启动恢复单例：StrictMode/HMR 会触发多次 onReady，不挡会为每个面板重复建 worker/会话文件 */
  __piggyRestorePromise?: Promise<void>;
  __piggyRestoreDock?: DockviewApi;
}
const g = globalThis as unknown as PiggyGlobals;
function setDockApi(a: DockviewApi | null) {
  g.__piggyDock = a ?? undefined;
}
function api(): DockviewApi | null {
  return g.__piggyDock ?? null;
}
const persist = debounce(() => {
  if (!api) return;
  void cmd('layout_save', {
    value: { dockview: api()?.toJSON(), updated_at: Date.now() },
  }).catch(() => {});
}, 800);

function onReady(e: DockviewReadyEvent) {
  setDockApi(e.api);
  e.api.onDidActivePanelChange((ev) => {
    const tabId = (ev.panel?.params as SessionParams | undefined)?.tabId;
    if (tabId) {
      useTabs.getState().setActive(tabId);
      void wakeIfNeeded(tabId); // 休眠标签激活即唤醒（05 §4.3）
    }
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
  void restoreOnce();
}

/** 启动恢复（单例；同一 dockview 实例只恢复一次）。
 * StrictMode 双 onReady 各绑一个新实例，所以实例变了要重跑一轮；
 * 同一会话文件的重复 createTab 由 inflightRestores 去重兜底。 */
function restoreOnce(): Promise<void> {
  const cur = api();
  if (g.__piggyRestorePromise && g.__piggyRestoreDock === cur) return g.__piggyRestorePromise;
  g.__piggyRestoreDock = cur ?? undefined;
  g.__piggyRestorePromise = (async () => {
    await restore();
  })();
  return g.__piggyRestorePromise;
}

/** 恢复期 createTab 去重（键=会话文件）：并发两轮 restore 时同一文件只建一个 worker。
 * 缓存不随 settle 逐出（StrictMode 两轮 restore 一先一后，逐出会令后轮撞互斥锁），
 * 复用前校验缓存 tab 仍存活，已关闭则逐出重建。 */
const restoreTabCache = new Map<string, Promise<TabSnapshot>>();
function createTabForRestore(sessionFile: string, cwd: string): Promise<TabSnapshot> {
  const cached = restoreTabCache.get(sessionFile);
  if (cached) {
    return cached.then((snap) => {
      if (useTabs.getState().tabs[snap.tab_id]) return snap;
      restoreTabCache.delete(sessionFile);
      return createTabForRestore(sessionFile, cwd);
    });
  }
  const p = createTab({ sessionPath: sessionFile, cwd });
  restoreTabCache.set(sessionFile, p);
  p.catch(() => {});
  return p;
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
          // 旧布局遗留的无文件会话（precreate 之前的空白会话）：文件不存在无从恢复，
          // 直接标 missing；绝不能再走"新建会话"，否则每次恢复都凭空多出一批空白会话
          if (!params.sessionFile) {
            p.params = { kind: 'preview', path: '__missing__' };
            continue;
          }
          try {
            const snap: TabSnapshot = await createTabForRestore(params.sessionFile, params.cwd);
            ensureTab(snap);
            params.tabId = snap.tab_id;
            params.sessionFile = snap.session_file;
          } catch {
            p.params = { kind: 'preview', path: '__missing__' };
          }
        }
      }
      api()?.fromJSON(serialized as never);
      if (api()?.panels.length === 0) await openWelcome();
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
  api()?.addPanel({
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
  api()?.getPanel(`session:${snap.tab_id}`)?.focus();
}

export function openSettingsTab() {
  const id = 'settings';
  if (api()?.getPanel(id)) {
    api()?.getPanel(id)!.focus();
    return;
  }
  api()?.addPanel({ id, component: 'settings', title: '设置', params: { kind: 'settings' } });
}

/** 聚焦已打开的会话标签；没有该标签返回 false */
export function focusSessionTab(tabId: string): boolean {
  const panel = api()?.getPanel(`session:${tabId}`);
  if (panel) {
    panel.focus();
    return true;
  }
  return false;
}

export function openPreviewTab(key: string, path: string, title: string, root?: string) {
  const id = `preview:${key}`;
  api()?.getPanel(id)?.api.close();
  api()?.addPanel({
    id,
    component: 'preview',
    title: `✦ ${title}`,
    params: { kind: 'preview', path, root },
  });
}

export function closeActivePanel() {
  if (!api) return;
  const active = api()?.activePanel ?? api()?.panels.find((x) => x.id === `session:${useTabs.getState().activeTabId}`);
  active?.api.close();
}

export async function openWelcome() {
  if (api()?.getPanel('welcome')) return;
  api()?.addPanel({ id: 'welcome', component: 'welcome', title: 'Piggy', params: {} });
}

const darkTheme: DockviewTheme = { name: 'piggy-dark', className: 'pg-dv-theme-dark', colorScheme: 'dark' };
const lightTheme: DockviewTheme = { name: 'piggy-light', className: 'pg-dv-theme-light', colorScheme: 'light' };

/**
 * 关闭全部标签。
 *
 * 刻意**逐个 `panel.api.close()`** 而不是 `api.clear()`：`clear()` 把布局重置为空，
 * 但不保证为每个面板触发 `onDidRemovePanel`，而 worker 回收 / store 清理 / 监听器释放
 * 全挂在那个回调上（见 onReady）。走 clear() 会留下一堆孤儿 pi 进程。
 *
 * 语义与"逐个关闭"一致：worker 关停、会话文件保留，侧栏仍能重新打开。
 */
export function closeAllTabs() {
  const a = api();
  if (!a) return;
  for (const p of [...a.panels]) p.api.close(); // 复制一份：关闭会改动 panels
}

/** 关闭除活动面板外的全部标签。 */
export function closeOtherTabs() {
  const a = api();
  if (!a) return;
  const keep = a.activePanel;
  if (!keep) return;
  for (const p of [...a.panels]) {
    if (p.id !== keep.id) p.api.close();
  }
}

/**
 * tab 右键菜单。
 *
 * 不用 dockview 的内置字符串项（`'close' | 'closeOthers' | 'closeAll'`）：
 * 它们的文案是**写死的英文**（Close / Close Others / Close All），
 * 与其余中文界面不一致，而 dockview v8 没有提供本地化内置项的入口
 * （只有面向读屏的 announcement strings 能覆盖）。所以自带 label + action。
 */
function tabContextMenu({
  panel,
  api,
}: GetTabContextMenuItemsParams): (BuiltInContextMenuItem | ReactContextMenuItemConfig)[] {
  const all = [...api.panels];
  const at = all.findIndex((p) => p.id === panel.id);
  const rightCount = at < 0 ? 0 : all.length - at - 1;

  return [
    { label: '关闭', action: () => panel.api.close() },
    {
      label: '关闭其他',
      action: () => {
        for (const p of [...api.panels]) if (p.id !== panel.id) p.api.close();
      },
    },
    {
      label: '关闭右侧',
      disabled: rightCount === 0,
      action: () => {
        for (const p of all.slice(at + 1)) p.api.close();
      },
    },
    'separator',
    { label: `关闭全部（${api.panels.length}）`, action: () => closeAllTabs() },
  ];
}

/**
 * 标签栏右端的操作按钮。
 *
 * 存在的理由：关闭全部只放在右键菜单里**发现不了**（用户报的就是标签开太多没法收拾）。
 * 数量 ≤1 时隐藏，避免只有一个标签时还杵着一个"关闭全部"。
 */
function TabActions({ panels }: IDockviewHeaderActionsProps) {
  const [confirming, setConfirming] = useState(false);
  if (panels.length <= 1) return null;

  const run = () => {
    if (!confirming) {
      // 会关停所有会话的 worker，所以二次确认；3 秒内没再点就复位
      setConfirming(true);
      window.setTimeout(() => setConfirming(false), 3000);
      return;
    }
    setConfirming(false);
    closeAllTabs();
  };

  return (
    <div className="pg-tab-actions">
      <button
        type="button"
        className={`pg-tab-action${confirming ? ' pg-tab-action-danger' : ''}`}
        title={confirming ? `再点一次确认关闭全部 ${panels.length} 个标签` : `关闭全部标签（${panels.length}）`}
        onClick={run}
      >
        <Icon name={confirming ? 'alert' : 'close-all'} size={13} />
        {confirming ? '确认关闭全部' : null}
      </button>
    </div>
  );
}

export function EditorArea() {
  const themeName = useUi((s) => s.theme);
  return (
    <div className="pg-editor-area">
      <DockviewReact
        components={components}
        defaultTabComponent={PgTab}
        getTabContextMenuItems={tabContextMenu}
        rightHeaderActionsComponent={TabActions}
        onReady={onReady}
        theme={themeName === 'dark' ? darkTheme : lightTheme}
        className="pg-dv"
      />
    </div>
  );
}
