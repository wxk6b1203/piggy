/**
 * **跨重启记住读到哪**（docs/04 §2.1.7，DSH 的 `chatScroll` 位置存储）。
 *
 * 会话开着的时候，"读到哪一行"由 `TranscriptReading` 在内存里拿着（面板被 dockview 摘出
 * DOM 再挂回来时还回去）。但这个进程一关就没了 —— 重开 Piggy、点开同一个会话，
 * 一律贴到底部。用户 2026-09-25 要求："跨重启记住阅读位置"。
 *
 * ## 键为什么是"会话文件 + 字节偏移"
 *
 * 行 id 是每次载入现生成的（`role-时间戳-序号`），重启后全变。会话文件路径天然稳定；
 * 行在文件里的**字节偏移**（`MessageView.offset`，分页读来的行都带）同样稳定 ——
 * 于是"读到哪一行"在重启后仍然能对上，哪怕中间 pi 又追加了几轮。
 *
 * ## 存哪
 *
 * `localStorage`（一个键装全部会话的位置），不写 `~/.piggy/config.json`：
 * 位置是**每次采样都可能变**的高频小状态，塞进共享配置文件会带来无谓的读改写与
 * 多实例写冲突（config.json 那边有原子写与并发约定）。代价是清缓存会丢，可接受。
 * 条目按 `at` 保留最近 {@link MAX_ENTRIES} 个会话，避免无限增长。
 *
 * ## 读不出来怎么办
 *
 * **当作没有存过**（当作第一次打开：贴底）。这一层坏了不该影响会话打开 ——
 * 所以形状校验从严、任何异常都吞掉并返回 null（与 `stores/*` 里那些"读不到就回落"同一条口径）。
 */

/** 一个会话的阅读位置（`following` = 当时贴着底）。 */
export interface ReadingPosition {
  /** 当时是不是贴着底（贴底就不必记偏移，重开继续贴底） */
  following: boolean;
  /** 锚点行在会话文件里的字节偏移；`following` 为真或没有偏移时是 null */
  offset: number | null;
  /** 视口顶端在这一行内部往下多少像素 */
  delta: number;
}

interface StoredEntry extends ReadingPosition {
  /** 最后一次写入的时间戳（LRU 用） */
  at: number;
}

const KEY = 'piggy:reading-position';
/** 保留多少个会话的位置（超出按 `at` 丢最旧的）。 */
export const MAX_ENTRIES = 200;

type Store = Record<string, StoredEntry>;

function readStore(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Store = {};
    for (const [path, value] of Object.entries(parsed as Record<string, unknown>)) {
      const e = value as Partial<StoredEntry> | null;
      if (!e || typeof e !== 'object') continue;
      if (typeof e.following !== 'boolean') continue;
      if (e.offset !== null && typeof e.offset !== 'number') continue;
      if (typeof e.delta !== 'number' || !Number.isFinite(e.delta)) continue;
      out[path] = {
        following: e.following,
        offset: typeof e.offset === 'number' ? e.offset : null,
        delta: e.delta,
        at: typeof e.at === 'number' ? e.at : 0,
      };
    }
    return out;
  } catch {
    // 无 localStorage / JSON 坏了 / 形状不对：当成"没存过"
    return {};
  }
}

function writeStore(store: Store): void {
  try {
    const entries = Object.entries(store);
    if (entries.length > MAX_ENTRIES) {
      entries.sort((a, b) => b[1].at - a[1].at);
      store = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
    }
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // 写不进去（配额满 / 隐私模式）：记位置是尽力而为，不该影响阅读
  }
}

/**
 * 读一个会话上次读到的位置。
 *
 * @param sessionFile - 会话文件绝对路径（没有它就没有跨重启的身份）
 * @returns 位置；没存过或存的东西不可用时返回 null
 */
export function loadReadingPosition(sessionFile: string | null | undefined): ReadingPosition | null {
  if (!sessionFile) return null;
  const entry = readStore()[sessionFile];
  if (!entry) return null;
  return { following: entry.following, offset: entry.offset, delta: entry.delta };
}

/** 记下一个会话的位置（`null` = 贴着底）。 */
export function saveReadingPosition(sessionFile: string | null | undefined, position: ReadingPosition): void {
  if (!sessionFile) return;
  const store = readStore();
  store[sessionFile] = { ...position, at: Date.now() };
  writeStore(store);
}

/** 忘掉一个会话的位置（会话被删/清空时用；测试也用它复位）。 */
export function forgetReadingPosition(sessionFile: string): void {
  const store = readStore();
  if (!(sessionFile in store)) return;
  delete store[sessionFile];
  writeStore(store);
}
