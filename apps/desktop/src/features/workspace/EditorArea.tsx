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
import { forgetRowTab } from '@/lib/rowMemory';
import { useTabs, createTab, type TabSnapshot } from '@/stores/tabs';
import { createTabGuarded } from '@/lib/tabCreate';
import { useUi } from '@/stores/ui';
import { useMessages } from '@/stores/messages';
import { loadTail } from '@/lib/transcriptPage';
import { wakeIfNeeded } from '@/lib/sleep';
import { t } from '@/lib/i18n';
import { Icon } from '@/features/common/Icon';
import { SessionWorkspace } from '@/features/chat/SessionWorkspace';
import { SettingsTab } from '@/features/settings/SettingsTab';
import { FilePreview } from '@/features/preview/FilePreview';
import { DiffView } from '@/features/preview/DiffView';
import { EmptyEditor } from './EmptyEditor';

export interface SessionParams {
  kind: 'session';
  tabId: string;
  sessionFile: string | null;
  cwd: string;
  title: string;
  /** 占位面板（乐观 UI）：`tab_create` 还没回来时先把标签画出来，就绪后换成真面板。
   *  这类面板**不进布局持久化**（见 `persist()` 里的过滤）。 */
  pending?: boolean;
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
/**
 * 改动标签（diff 视图）。
 *
 * 参数里只放 `{tabId, callId}`，**不放 patch 本身**：这份参数会被
 * dockview 序列化进布局 JSON（localStorage），一个 patch 动辄几 KB，
 * 放进去等于把整份 diff 抄进布局。改动内容就在 messages store 的工具结果索引里
 * （`details`），标签页按这两个 id 去取（`features/preview/DiffView.tsx`）。
 */
export interface DiffParams {
  kind: 'diff';
  tabId: string;
  toolCallId: string;
  /** 展示用的文件名（取不到内容时还能说清这是哪个文件的改动） */
  title?: string;
}
export type PanelParams = SessionParams | SettingsParams | PreviewParams | DiffParams;

/**
 * 正在打开的会话（乐观 UI 的占位内容）。
 *
 * 为什么要有它：`tab_create` 要 spawn 一个 pi 进程并握手（macOS 实测 0.5s 左右，
 * Windows 上更久），而**在它回来之前界面上什么都没有** —— 用户点了"新建会话"
 * 或者点了侧栏某一行，屏幕纹丝不动，只能再点一次（于是又撞上重复创建那条路）。
 * 现在点击后立刻画出标签与这块骨架，`tab_create` 回来时换成真面板。
 *
 * 内容刻意极简（一行转圈 + 一句"正在启动 pi"）：这里**不能**猜任何东西
 * （模型、标题、消息都还不知道），说错比空着更糟。
 */
function SessionOpening({ title }: { title: string }) {
  return (
    <div className="pg-workspace pg-session-opening" data-session-opening>
      <div className="pg-session-opening-box">
        <span className="pg-spinner" aria-hidden />
        <span className="pg-session-opening-title">正在启动 pi…</span>
        <span className="pg-session-opening-sub">{title}</span>
      </div>
    </div>
  );
}

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
  session: (props: IDockviewPanelProps<SessionParams>) =>
    props.params.pending ? (
      <SessionOpening title={props.params.title} />
    ) : (
      <SessionWorkspace tabId={props.params.tabId} />
    ),
  settings: () => <SettingsTab />,
  preview: PreviewPanel,
  diff: (props: IDockviewPanelProps<DiffParams>) => (
    <DiffView
      tabId={props.params.tabId}
      callId={props.params.toolCallId}
      title={props.params.title}
      onOpenFile={(path) => openPreviewTab(path, path, path.split(/[\\/]/).pop() ?? path)}
    />
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
  const named = useStore(useTabs, (s) => (tabId ? s.tabs[tabId]?.sessionName ?? null : null));
  /**
   * 标签页标题**跟着会话名走**。
   *
   * `openSessionTab` 给的只是"打开那一刻"的标题（有名字时是名字，没有时是首条消息 /
   * 目录名）—— 之后任何改名（重新生成标题、重命名、`/name`）都必须在这一格上看得见，
   * 否则用户点完"重新生成标题"只看到侧栏变了、标签页与上方标题还是旧的（2026-09-23 报）。
   *
   * 放在**这里**而不是每个改名入口各写一遍 `setTitle`：这是唯一一处订阅会话名的标签
   * 渲染点，一处就兜住所有路径（含将来新增的）。名字被清空时保留原标题 ——
   * 退回一个我们编不出来的标签，不如留着上一条。
   */
  useEffect(() => {
    if (named && props.api.title !== named) props.api.setTitle(named);
  }, [named, props.api]);
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
    value: { dockview: stripPendingPanels(api()?.toJSON()), updated_at: Date.now() },
  }).catch(() => {});
}, 800);

/**
 * 从要落盘的布局里**剔掉占位面板**（乐观 UI 的中间态）。
 *
 * 为什么必须剔：占位面板的 `params.sessionFile` 是空的，下次启动 `restore()` 会把它
 * 当成"旧布局遗留的无文件会话"标成 `missing` —— 于是"点一下新会话、立刻关掉应用"
 * 会在下次启动时留下一个「会话文件不存在」的僵尸标签。占位是**几秒钟的 UI 状态**，
 * 不该进持久化。
 */
export function stripPendingPanels(json: unknown): unknown {
  const j = json as { panels?: Record<string, { id?: string }> } | undefined;
  if (!j?.panels) return json;
  for (const [id, p] of Object.entries(j.panels)) {
    if (id.startsWith(PENDING_PREFIX) || String(p?.id ?? '').startsWith(PENDING_PREFIX)) delete j.panels[id];
  }
  return j;
}

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
  const known = !!t.tabs[snap.tab_id];
  t.addTab(snap);
  void import('@/lib/tabEvents').then(({ ensureTabListeners }) => ensureTabListeners(snap.tab_id));
  /* 转录**分页**装载（docs/03 §2.19）：先读会话文件尾部一页，不等 pi 把整段历史搬过来。
     文件读不到时 loadTail 自己会退回 pi_get_messages（lib/transcriptPage.ts）。

     ⚠️ 已经装过的标签**不要再读一遍**：`loadTail` 走 `hydratePage`，它会**重置**这个 tab
     的消息（清空 `byId`/`ids` 再灌）。双击的第二次调用（同一个快照）若也读一遍，
     刚渲染出来的转录会被无谓地洗一次 —— 那正是"快速点两下"的另一半副作用。 */
  if (known) return;
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

/**
 * 打开（或聚焦）一个会话标签。
 *
 * ## 幂等（用户 2026-09-23 报：快速点两下同一个会话就报错）
 *
 * ```text
 * Error: dockview: panel with id session:045df709-… already exists
 * ```
 *
 * 双击 / 手快连点两次时，两次点击**都落在 `createTabGuarded` 的同一个 await 窗口里**
 * （`findTabBySession` 那时还查不到 —— store 要等 IPC 回来才更新），去重让它们拿到
 * **同一个快照**（同一个 `tab_id`），于是两次都会走到这里。真 dockview 的
 * `addPanel` 见到重复 id 是**直接抛**（`_doAddPanel`，dockview-core:17360），
 * 于是用户看到一条红色 toast，而标签其实早就开好了。
 *
 * 面板 id 就是 `session:<tabId>`，所以"已经有一个 `params.tabId` 相同的面板"
 * 等价于"这个会话已经开着了" —— 聚焦它、直接返回。
 *
 * ⚠️ 按 `params.tabId` 找、**不拼面板 id**：布局恢复后面板 id 与 tabId 会分叉
 * （见 `findSessionPanel` 的说明），拼字符串在恢复过的会话上会找不到。
 */
/** 占位面板的 id 前缀（`stripPendingPanels` 与门禁都靠它认人）。 */
const PENDING_PREFIX = 'session:pending:';
let pendingSeq = 0;
/** 同一份"要打开的会话"只允许有一个占位（连点两次不该画出两个骨架标签）。 */
const pendingKeys = new Map<string, string>();

/**
 * 先画出占位标签（乐观 UI）。
 *
 * @param key - 去重键（会话文件；新会话用 `new:<cwd>`）
 * @param title - 标签标题
 * @returns 占位面板 id（`undefined` = dockview 还没就绪，调用方照常走后面的流程）
 */
export function openPendingSessionTab(key: string, title: string): string | undefined {
  const exist = pendingKeys.get(key);
  if (exist) {
    api()?.getPanel(exist)?.focus();
    return exist;
  }
  const id = `${PENDING_PREFIX}${++pendingSeq}`;
  const dash = api();
  if (!dash) return undefined;
  dash.addPanel({
    id,
    component: 'session',
    title,
    params: { kind: 'session', tabId: id, sessionFile: null, cwd: '', title, pending: true } satisfies SessionParams,
  });
  dash.getPanel(id)?.focus();
  pendingKeys.set(key, id);
  return id;
}

/** 关掉占位面板（无论成功还是失败都要走这一步，否则骨架会永远挂着）。 */
export function closePendingSessionTab(key: string): void {
  const id = pendingKeys.get(key);
  if (!id) return;
  pendingKeys.delete(key);
  api()?.getPanel(id)?.api.close();
}

/**
 * **打开会话的唯一入口**（带乐观 UI）：先画占位 → 建 tab → 换成真面板。
 *
 * 所有入口（侧栏点会话、新建会话、命令面板、Fleet）都走它 ——
 * "先反馈再等待"这条体验只在**一个漏斗**里实现，别在每个调用点各写一遍
 * （写两遍的下场是其中一条忘了关占位，转录里永远多一个骨架标签）。
 *
 * @param input - `createTabGuarded` 的入参（会话文件 / cwd / 名字）
 * @param title - 标签标题（占位与真面板都用它）
 * @returns 建成后的快照（调用方需要时可用；失败会把占位收掉并抛出原错误）
 */
export async function openSessionTabOptimistic(
  input: { cwd?: string; sessionPath?: string; name?: string },
  title: string,
): Promise<TabSnapshot> {
  const key = input.sessionPath ?? `new:${input.cwd ?? ''}`;
  openPendingSessionTab(key, title);
  try {
    const snap = await createTabGuarded(input);
    await openSessionTab(snap, title);
    return snap;
  } finally {
    /* ⚠️ `finally` 而不是 `catch`：成功路径也要关占位（真面板已经在那儿了），
       失败路径更要关（否则骨架永远转圈）。关占位在 `openSessionTab` 之后 ——
       先加真面板再关占位，视觉上不会出现"空一下"。 */
    closePendingSessionTab(key);
  }
}

export async function openSessionTab(snap: TabSnapshot, title: string) {
  ensureTab(snap);
  const existing = findSessionPanel(snap.tab_id);
  if (existing) {
    existing.focus();
    return;
  }
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

/**
 * 打开（或聚焦）一个**改动标签**。
 *
 * 面板 id 按 `会话 + 调用` 定：同一个文件在同一轮里只开一个标签，再点一次是聚焦
 * （与 `openPreviewTab` 的 `preview:<key>` 同一套幂等口径）。同一文件在**另一轮**
 * 再改一次就是另一个 callId → 另一个标签，两个版本的改动可以并排看。
 */
export function openDiffTab(tabId: string, toolCallId: string, title: string) {
  const id = `diff:${tabId}:${toolCallId}`;
  const existing = api()?.getPanel(id);
  if (existing) {
    existing.focus();
    // 复用既有面板时**改参数**：同一个 callId 只在标签已被复用（布局恢复）时才会变标题
    existing.api.updateParameters({ kind: 'diff', tabId, toolCallId, title } satisfies DiffParams);
    return;
  }
  api()?.addPanel({
    id,
    component: 'diff',
    title: `± ${title}`,
    params: { kind: 'diff', tabId, toolCallId, title } satisfies DiffParams,
  });
  api()?.getPanel(id)?.focus();
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
