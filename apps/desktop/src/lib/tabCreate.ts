/**
 * 受保护的 tab 创建（docs/05 §4.2）：`MAX_WORKERS` 触顶时先询问用户是否回收最闲会话；
 * 以及**同一会话文件的并发创建去重**（docs/02 §6.3 的前端一半）。
 *
 * ## 为什么要去重（2026-09-23 用户终端日志，"非常偶尔会报错"）
 *
 *   [piggy] spawn pi [3a8c24e9-…] --session …/12-10-31-790Z_2c118184-….jsonl
 *   [piggy] tab_create ok: 3a8c24e9-…
 *   [piggy] spawn pi [c3d9ea15-…] --session …/12-10-31-790Z_2c118184-….jsonl   ← 同一个文件
 *   [piggy] tab_create FAILED: 会话文件已被标签页 3a8c24e9-… 打开: …/12-10-31-790Z_2c118184-….jsonl
 *
 * Rust 的会话互斥锁本身是对的（并发调用被 registry 锁串起来，第二个必然看见第一个），
 * 而且在返回错误前 `worker.shutdown()` 了，没有进程泄漏。**问题在前端**：
 *
 *   `SessionsSidebar.openSession` 的"已经开着就聚焦"查的是 zustand store，
 *   而 store 要到 `openSessionTab → ensureTab → addTab` 才更新 —— 也就是
 *   **整个 `tab_create` IPC 往返期间 store 里都还没有这个标签**。
 *   两次点击落进同一个窗口，就都会查到"没打开"，都去建 worker，
 *   第二个被 Rust 挡下来变成一条红色 toast。双击是最常见的触发方式（所以"非常偶尔"）。
 *
 * 修法：把这个不变量收到**唯一的漏斗**里 —— `createTabGuarded` 对同一会话文件幂等。
 * 并发调用复用同一个 promise；已建成但调用方还没写 store 的，复用同一份快照。
 *
 * 只重试一次（MAX_WORKERS 回收后）：回收后仍失败说明是别的原因（如 pi 缺失），
 * 此时把原始错误抛给调用方。
 */
import { cmd } from '@/lib/ipc';
import { confirm } from '@/lib/feedback';
import { createTab, useTabs, type TabInfo, type TabSnapshot } from '@/stores/tabs';

export interface CreateTabInput {
  cwd?: string;
  sessionPath?: string;
  name?: string;
}

/** 宿主容量错误的前缀（Rust 侧抛出，见 docs/02 §7）。 */
const MAX_WORKERS = 'MAX_WORKERS';

/** 会话文件 → 未完成的创建。键只在 `sessionPath` 存在时有意义（新会话每次都是新文件）。 */
interface Inflight {
  promise: Promise<TabSnapshot>;
  /** 建成后回填；标签后来被关掉时用它做同步清理。 */
  tabId: string | null;
}
const inflight = new Map<string, Inflight>();

/** 按会话文件找已打开的标签（store 里的字段是 camelCase，`addTab` 做过映射）。 */
export function findTabBySession(sessionPath: string): TabInfo | undefined {
  return Object.values(useTabs.getState().tabs).find((t) => t.sessionFile === sessionPath);
}

/**
 * 幂等创建：同一会话文件**永远不会**同时建出两个 worker。
 *
 * 缓存不随 settle 立即逐出 —— 逐出会在"promise 落定"与"调用方把标签写进 store"
 * 之间再开一个小口子。改为**同步**清理：建成过的条目若其标签已不在 store 里就丢掉，
 * 于是"关掉再打开同一个会话"照常重建（判据同 `EditorArea.createTabForRestore`）。
 */
export function createTabGuarded(input: CreateTabInput): Promise<TabSnapshot> {
  const key = input.sessionPath;
  if (!key) return createTabFlow(input); // 新会话：每次都是新文件，没有可去重的键

  // 同步清理已关闭标签的条目，避免这张表随用过的会话数无限增长
  for (const [k, e] of inflight) {
    if (e.tabId && !useTabs.getState().tabs[e.tabId]) inflight.delete(k);
  }

  const cached = inflight.get(key);
  if (cached) {
    return cached.promise.then((snap) => {
      if (useTabs.getState().tabs[snap.tab_id]) return snap; // 还开着 → 复用，不再建 worker
      inflight.delete(key);
      return createTabGuarded(input);
    });
  }

  const entry: Inflight = { promise: createTabFlow(input), tabId: null };
  // 建成回填 tabId；失败**不缓存**，否则一次失败会把这条路永久堵死
  entry.promise.then(
    (snap) => {
      entry.tabId = snap.tab_id;
    },
    () => inflight.delete(key),
  );
  inflight.set(key, entry);
  return entry.promise;
}

/** 真正的创建流程（含 MAX_WORKERS 回收重试一次）。 */
async function createTabFlow(input: CreateTabInput): Promise<TabSnapshot> {
  try {
    return await createTab(input);
  } catch (e) {
    const text = String(e);
    if (!text.startsWith(MAX_WORKERS)) throw e;

    const reclaimed = await new Promise<boolean>((resolve) => {
      confirm({
        title: '活跃会话已达上限',
        content: `${text.replace(`${MAX_WORKERS}: `, '')}要自动回收最空闲的会话吗？（休眠不丢消息，激活时自动恢复）`,
        okText: '回收最闲并继续',
        cancelText: '取消',
        onOk: async () => {
          try {
            await cmd('tab_sleep_idlest', {});
            resolve(true);
          } catch {
            resolve(false);
          }
        },
        onCancel: () => resolve(false),
      });
    });

    if (!reclaimed) throw e;
    return createTab(input);
  }
}

/** 仅测试用：清空去重缓存（模块级状态跨用例残留会互相干扰）。 */
export function __resetCreateTabCache(): void {
  inflight.clear();
}
