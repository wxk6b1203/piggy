/**
 * `ResizeObserver` 循环警告的**溯源探针**（仅 DEV，2026-09-23）。
 *
 * ## 为什么需要它
 *
 * `ResizeObserver loop completed with undelivered notifications` 是浏览器报的
 * **合成事件**：`window.onerror` 里既没有 `error`、也没有元素，**没有调用栈**。
 * 我们前后为这条警告猜了三轮（先怀疑资源加载、再怀疑梯子量自己），
 * 所以这里补一个"现场证人"：包装 `ResizeObserver` 构造器，记下
 *   1. 谁 `new` 出来的（创建点的调用栈）——第三方库也会经过这里；
 *   2. 最近一次真的被调用的回调来自哪个创建点。
 * 警告到达时把这两条写进日志，下一次就能直接点名。
 *
 * ## 已知：这条警告在 macOS 上更吵
 *
 * 门禁（Chromium/Playwright）里从来复现不出来，而真机（Tauri = WKWebView）里偶发。
 * 这不是巧合：按规范逻辑实现会发出**远多于** Chrome 的循环错误通知
 * （csswg-drafts #6610，见 docs/03 §2.18b 的引用）。规范原文是
 * "循环结束仍有未投递的通知"就报错，而"下一帧再投递"是允许的 ——
 * 也就是说这条警告本身不代表有死循环，只代表**这一帧**没收敛完。
 * 它没有可见副作用就不影响功能；有可见副作用（抖动/跳动）就得按纪律改。
 */
import { resizeWatchLastFired, resizeWatchStats, shortenPath } from './resizeWatch';

/** 记过的"非我们"创建点（去重、上限 {@link MAX_FOREIGN_SITES} 条）。 */
const foreignSites: string[] = [];
const MAX_FOREIGN_SITES = 3;
let foreignCreated = 0;
let ownCreated = 0;
/** 最近一次真的被调用的回调属于谁、来自哪个创建点 */
let lastFiredOurs = false;
let lastFiredSite: string | null = null;

/**
 * 这一次 `new ResizeObserver` 是不是 `lib/resizeWatch` 那个共享实例建的？
 *
 * 必须**按完整路径判**（展示串会被截断，截断后可能正好把文件名截掉），
 * 否则我们自己的那一个会被算进"第三方创建"，报告就开始骗人。
 */
const OWN_CREATION = /[\\/]lib[\\/]resizeWatch\.ts/;

/** 取 3 层调用栈当"创建点"：跳过探针自己那两帧，逐帧截断（**先保住第一帧**，
 * 它才是"谁 new 的"；整体截断会把最有用的一帧切掉半截）。 */
function creationSite(): { display: string; raw: string } {
  const stack = new Error().stack ?? '';
  const frames = stack
    .split('\n')
    .slice(3, 6)
    .map((l) => l.trim().replace(/^at\s+/, ''));
  const raw = frames.join(' ← ');
  if (!raw) return { display: '(调用栈不可用)', raw: '' };
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const display = [
    clip(shortenPath(frames[0] ?? ''), 110),
    frames[1] ? clip(shortenPath(frames[1]), 80) : '',
  ]
    .filter(Boolean)
    .join(' ← ');
  return { display, raw };
}

/** 记一笔创建，返回"是不是我们自己建的"（回调里要据此归类"最后回调"）。 */
function rememberCreation(site: { display: string; raw: string }): boolean {
  const ours = OWN_CREATION.test(site.raw);
  if (ours) {
    ownCreated += 1;
  } else {
    foreignCreated += 1;
    if (foreignSites.length < MAX_FOREIGN_SITES && !foreignSites.includes(site.display)) {
      foreignSites.push(site.display);
    }
  }
  return ours;
}

/**
 * 装上探针（幂等）。必须在任何应用代码之前调用 —— 第三方库在**调用时**
 * 读全局 `ResizeObserver`，所以启动时包一次就够。
 */
export function installResizeObserverProbe(): void {
  if (!import.meta.env.DEV) return;
  const g = globalThis as { ResizeObserver?: typeof ResizeObserver & { __piggyProbed?: true } };
  const Real = g.ResizeObserver;
  if (!Real || Real.__piggyProbed) return;

  // 用普通函数当构造器：返回 inner 对象，`new Probed(cb)` 得到的还是真观察者。
  const Probed = function (this: unknown, cb: ResizeObserverCallback) {
    const created = creationSite();
    const ours = rememberCreation(created);
    return new Real((entries, obs) => {
      lastFiredOurs = ours;
      lastFiredSite = created.display;
      cb(entries, obs);
    });
  } as unknown as typeof ResizeObserver & { __piggyProbed?: true };
  Probed.__piggyProbed = true;
  g.ResizeObserver = Probed;
}

/**
 * 一句话现场报告：我们自己的观察规模 + 双方最后回调来源。
 *
 * 生产构建返回空串（探针不装，也没必要多打一行）。
 */
export function resizeProbeHint(): string {
  if (!import.meta.env.DEV) return '';
  const { instances, elements } = resizeWatchStats();
  const mine = resizeWatchLastFired();
  const parts = [
    `resizeWatch ${instances} 个实例/${elements} 个元素${
      mine ? `，最后回调 ${mine}` : lastFiredOurs && lastFiredSite ? `，最后回调 ${lastFiredSite}` : ''
    }`,
  ];
  if (foreignCreated > 0) {
    parts.push(
      `其它地方创建 ${foreignCreated} 处${
        !lastFiredOurs && lastFiredSite ? `，最后回调 ${lastFiredSite}` : ''
      }${foreignSites.length > 0 ? `｜创建点：${foreignSites.join(' ／ ')}` : ''}`,
    );
  } else {
    parts.push(`其它地方：没建过${ownCreated > 0 ? `（其中 ${ownCreated} 处走的是 resizeWatch）` : ''}`);
  }
  return `（RO 探针：${parts.join('；')}）`;
}

/** 重置探针状态（单测用；生产无调用者）。 */
export function resetResizeProbe(): void {
  foreignSites.length = 0;
  foreignCreated = 0;
  ownCreated = 0;
  lastFiredOurs = false;
  lastFiredSite = null;
}
