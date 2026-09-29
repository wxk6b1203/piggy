/**
 * EditorArea（WP1，docs/04 §1.3/§1.8）：dockview-react 官方绑定。
 * panel：session（会话工作面）/ settings（工具 tab）/ preview（✦ 预览，单实例可替换）/ welcome。
 * 布局持久化：layout_load/save（~/.piggy/layout.json）。
 */
import {
  DockviewDefaultTab,
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
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { DockviewTheme } from 'dockview';
import { debounce } from '@/lib/debounce';
import { cmd } from '@/lib/ipc';
import { windowEvents } from '@/lib/windowEvents';
import { shouldApplyLayout, shouldCloseTabOnPanelRemoved } from '@/lib/layoutLifecycle';
import { disposeTabListeners } from '@/lib/tabEvents';
import { disposeLive } from '@/lib/live';
import { forgetRowTab } from '@/lib/rowMemory';
import { useTabs, createTab, type TabSnapshot } from '@/stores/tabs';
import { useUi } from '@/stores/ui';
import { useMessages } from '@/stores/messages';
import { loadTail } from '@/lib/transcriptPage';
import { wakeIfNeeded } from '@/lib/sleep';
import { t } from '@/lib/i18n';
import { Icon } from '@/features/common/Icon';
import { SessionWorkspace } from '@/features/chat/SessionWorkspace';
import { SettingsTab } from '@/features/settings/SettingsTab';
import { FilePreview } from '@/features/preview/FilePreview';
import { EmptyEditor } from './EmptyEditor';

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

/**
 * 预览面板：把 dockview 的**可见性**透给 `FilePreview` → `MonacoHost`。
 *
 * 为什么要这一层：dockview 会把非活动面板的 React 树留着（DOM 摘掉、组件不卸载），
 * 于是"每开一个预览标签就永久多一个活着的 Monaco 实例"—— 实测开到第 7 个就撞上
 * 旧的 `MAX_INSTANCES = 6` 硬上限，而且撞上之后关标签也回不来。
 * 这里把 `api.isVisible` 往下传，`MonacoHost` 对不可见的挂载点**根本不创建**编辑器
 * （切回来再建，~70ms；预览是只读的，代价可控）。
 */
function PreviewPanel(props: IDockviewPanelProps<PreviewParams>) {
  const [visible, setVisible] = useState(props.api.isVisible);
  useEffect(() => {
    setVisible(props.api.isVisible);
    const sub = props.api.onDidVisibilityChange((e) => setVisible(e.isVisible));
    return () => sub.dispose();
  }, [props.api]);
  return <FilePreview path={props.params.path} root={props.params.root} visible={visible} />;
}

const components = {
  session: (props: IDockviewPanelProps<SessionParams>) => <SessionWorkspace tabId={props.params.tabId} />,
  settings: () => <SettingsTab />,
  preview: PreviewPanel,
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
 *
 * ⚠️ 但传了这个 prop 之后，**dockview 内建的 tab 就整个不再渲染**——包括关闭按钮。
 * 自己手画一个"看起来像"的 × 是错的（会丢掉中键关闭、`aria-label`、拖动时的
 * pointer 处理、`hideClose` 等一整套行为）。所以这里**直接复用 dockview 自己的
 * `DockviewDefaultTab`**，只把徽标作为 `data-*` 透传给它——`rest` 会被展开到
 * 那个 div 上，而徽标用 CSS 伪元素画在标题后面。
 * 结果：关闭按钮等内建行为一字不差，徽标能力也保住了。
 */
function PgTab(props: IDockviewPanelHeaderProps) {
  const tabId = (props.params as SessionParams | undefined)?.tabId ?? null;
  const unread = useStore(useTabs, (s) => (tabId ? !!s.unread[tabId] : false));
  const busy = useStore(useTabs, (s) => (tabId ? s.tabs[tabId]?.workerState === 'busy' : false));
  return (
    <DockviewDefaultTab
      {...props}
      data-busy={busy ? '' : undefined}
      data-unread={!busy && unread ? '' : undefined}
    />
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
  // 本次 onReady 绑定的事件只对**这个实例**有效。
  // StrictMode / HMR 会卸载再挂载 DockviewReact：旧实例拆除时照样触发 remove/active 回调，
  // 而那些回调对新实例来说全是噪音（同一个 tabId 在新实例里可能正开着）。
  const myApi = e.api;
  const isLive = () => api() === myApi;

  e.api.onDidActivePanelChange((ev) => {
    if (!isLive()) return;
    const tabId = (ev.panel?.params as SessionParams | undefined)?.tabId;
    if (tabId) {
      useTabs.getState().setActive(tabId);
      void wakeIfNeeded(tabId); // 休眠标签激活即唤醒（05 §4.3）
    }
  });
  e.api.onDidRemovePanel((panel) => {
    const tabId = (panel.params as SessionParams | undefined)?.tabId;
    if (!tabId) {
      persist();
      return;
    }
    // ⚠️ 「面板被移除」不等于「用户关了标签」——判据见 lib/layoutLifecycle.ts。
    //
    // 这次的**病根**在 restore()：两轮恢复把同一份布局套到了同一个实例上（由
    // shouldApplyLayout 挡住）。下面三条是**纵深防御**，把"哪些移除不是用户操作"
    // 一次说清楚，避免下次改动又把其中一类放进来。
    // 一旦误判，症状是**静默**的：面板还显示着、useTabs 空了、Rust registry 也空了，
    // 该标签下所有命令一起报「tab 不存在: <uuid>」（模型列表空白、转写空白、发送无响应）。
    const close = shouldCloseTabOnPanelRemoved({
      applyingLayout,
      liveInstance: isLive(),
      stillOpen: !!api()?.panels.some(
        (p) => (p.params as SessionParams | undefined)?.tabId === tabId,
      ),
    });
    if (!close) {
      persist();
      return;
    }
    void cmd('tab_close', { tabId }).catch(() => {});
    disposeTabListeners(tabId);
    disposeLive(tabId);
    useTabs.getState().removeTab(tabId);
    useMessages.getState().remove(tabId);
    // 行的展开态记忆跟着行一起走（`lib/rowMemory`）：留着就是拿不到的垃圾
    forgetRowTab(tabId);
    persist();
  });
  e.api.onDidAddPanel(() => persist());
  e.api.onDidLayoutChange(() => persist());
  // 空态占位：面板增删都要重算。与上面那些"业务回调"分开订阅 —— 那边有多个 return 分支，
  // 把同步塞进去迟早漏一条（而漏掉的症状恰恰是"关光标签后什么都不显示"）。
  e.api.onDidAddPanel(() => {
    if (isLive()) syncEmptyPanels();
  });
  e.api.onDidRemovePanel(() => {
    if (isLive()) syncEmptyPanels();
  });
  syncEmptyPanels();
  void restoreOnce();
}

/**
 * 编辑区里还剩几个面板 → 广播给 `EmptyEditor`（0 个 = 显示空态占位）。
 *
 * 走 `windowEvents` 这条既有的轻事件总线，而不是把 dockview api 塞进 store 或轮询：
 * `onReady` 是模块级函数（见上：它刻意不放进组件，HMR/StrictMode 下靠 globalThis 保活），
 * 拿不到组件里的 setState。
 */
function syncEmptyPanels() {
  windowEvents.emit('editor-panels', String(api()?.panels.length ?? 0));
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
  // 转录**分页**装载（docs/03 §2.19）：先读会话文件尾部一页，不等 pi 把整段历史搬过来。
  // 文件读不到时 loadTail 自己会退回 pi_get_messages（lib/transcriptPage.ts）。
  void loadTail(snap.tab_id, snap.session_file).catch(() => {});
}

/**
 * 正在套用持久化布局。
 *
 * `fromJSON()` 会**先清空再重建**面板（内部 clear → 逐个 remove），
 * 于是套用布局期间会为每个面板触发一次 `onDidRemovePanel`。
 * 那些是**结构性**的移除，不是用户关标签——不区分的话会把刚恢复出来的 tab 全杀掉。
 * 实测（2026-09-23）：StrictMode 下 `restore()` 跑两轮，两轮都把 `fromJSON`
 * 套到了同一个活着的实例上，第二轮清空时把第一轮建好的 tab 全关了：
 * 面板还显示着、`useTabs` 却空了、Rust registry 也空了
 * → 该标签下所有命令一起报「tab 不存在: <uuid>」。
 */
let applyingLayout = false;

/** 启动恢复：读取持久化布局 → 为 session 面板重建 worker → tabId 重映射 → fromJSON。
 * `@internal` 导出仅为测试（见 test/layout-restore.test.ts）——这条时序只有把
 * "恢复途中实例被换掉"造出来才测得到，浏览器里等它是碰运气。 */
export async function restore() {
  const target = api();
  if (!target) return;
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
      // 实例已经换了一轮：本轮作废，交给新实例那一轮去套用。
      // 否则两轮会各套一次同一个实例，第二次清空即"自己关掉自己的标签"（判据见 layoutLifecycle.ts）。
      if (!shouldApplyLayout(target, api())) return;
      applyingLayout = true;
      try {
        target.fromJSON(serialized as never);
      } finally {
        applyingLayout = false;
      }
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

/**
 * 按 tabId 找已打开的会话面板。
 *
 * ⚠️ 不能拿面板 id 拼（`session:${tabId}`）：**恢复布局时面板 id 与 tabId 会分叉**。
 * `restore()` 为每个 session 面板新建 worker 后只改写 `params.tabId`（新 uuid），
 * 面板 id 仍是上一进程留下的 `session:<旧 uuid>`。这是刻意的——面板 id 还挂在 grid
 * 树里，改它要重建整棵树。但拼字符串查找就会**永远找不到**，
 * 表现为点侧栏已打开的会话时又开一个重复标签（Rust 侧还会以
 * "会话文件已被标签页 X 打开" 拒绝，用户看到一句莫名其妙的报错）。
 * 所以统一按 `params.tabId` 找。
 */
function findSessionPanel(tabId: string) {
  return api()
    ?.panels.find((p) => (p.params as SessionParams | undefined)?.tabId === tabId);
}

/** 聚焦已打开的会话标签；没有该标签返回 false */
export function focusSessionTab(tabId: string): boolean {
  const panel = findSessionPanel(tabId);
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
  const a = api();
  if (!a) return;
  const activeTabId = useTabs.getState().activeTabId;
  const active =
    a.activePanel ?? (activeTabId ? findSessionPanel(activeTabId) : undefined);
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
        title={
          confirming
            ? `再点一次确认关闭全部 ${panels.length} 个标签（会关停它们的会话进程）`
            : `关闭全部标签（${panels.length}）`
        }
        aria-label={confirming ? '确认关闭全部标签' : '关闭全部标签'}
        onClick={run}
      >
        <Icon name={confirming ? 'alert' : 'close-all'} size={13} />
        {/* 确认态用短文案 + 红色：长文案在窄窗口会把标签栏挤到溢出 */}
        {confirming ? '确认关闭' : null}
      </button>
    </div>
  );
}

export function EditorArea() {
  const themeName = useUi((s) => s.theme);
  // 面板数为 0 = 空编辑区 → 盖一层空态占位（见 EmptyEditor）。
  // 初值 true 是对的：onReady 之前确实一个面板都没有。
  const [empty, setEmpty] = useState(true);
  useEffect(
    () => windowEvents.on('editor-panels', (n) => setEmpty(n === '0')),
    [],
  );
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
      {empty && <EmptyEditor />}
    </div>
  );
}
