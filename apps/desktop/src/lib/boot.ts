/**
 * 启动闸门：**任何建 tab 之前，必须先完成"收割上一上下文的遗留 worker"**。
 *
 * ## 为什么需要它
 * `boot_reset` 的语义是「新 JS 上下文接管前，收割上一 JS 上下文遗留的孤儿 worker」
 * （HMR 重载 / 窗口刷新后 Rust 进程还活着，registry 里可能挂着一批没人认领的 tab）。
 * Rust 侧实现是**先取一次 id 快照，再逐个 `close_tab`**（commands.rs::boot_reset）——
 * 也就是说：**快照那一刻 registry 里有什么，就关什么。**
 *
 * 而它和 dockview 的布局恢复本来是**两条互不相干的异步链**，谁先落地全看时序：
 *
 *   AppFrame 的 boot effect :  await cmd('boot_reset')            ← 收割
 *   EditorArea 的 onReady   :  await cmd('layout_load')
 *                              → createTab(...) × N               ← 建 tab
 *
 * 只要有一次 `tab_create` 抢在 `boot_reset` 取快照之前完成，那个 tab 就会被立刻关掉：
 * **前端 useTabs / dockview 依旧显示它，Rust registry 里却没有了**。
 * 之后这个 tab 上的任何命令都返回「tab 不存在: <uuid>」——
 * 实测症状：刚打开时标签页看着都在，但模型选择器空列表、转写空白、报 tab 不存在。
 *
 * 注意这是**竞态**，不是必现：`tab_create` 要 spawn pi 进程，通常比 `boot_reset` 慢，
 * 所以多数时候看起来正常——这类"大多数时候没事"的 bug 最难查，因此必须从时序上根除，
 * 而不是靠"应该不会那么快"。
 *
 * ## 做法
 * 把收割变成一道**闸门**：`bootGate()` 返回同一个 promise，`createTab()` 先 await 它。
 * 于是「建 tab」与「收割」之间有了确定的先后关系，与两侧的调度顺序无关。
 * 单例挂 globalThis，和 `__piggyBootPromise` 一样为了 HMR 重载时保活
 * （保住才有意义：闸门只该在新 JS 上下文里重新开一次）。
 */
import { cmd } from '@/lib/ipc';

interface BootGlobals {
  __piggyBootGate?: Promise<void>;
}
const g = globalThis as unknown as BootGlobals;

/**
 * 收割上一上下文遗留的 worker（幂等；同一 JS 上下文只真正执行一次）。
 * `boot_reset` 失败不阻塞启动——首启本来就没有遗留。
 */
export function bootGate(): Promise<void> {
  g.__piggyBootGate ??= cmd('boot_reset').then(
    () => undefined,
    () => undefined,
  );
  return g.__piggyBootGate;
}

/** @internal 仅供测试：清掉单例，让下一次调用重新收割 */
export function resetBootGateForTest(): void {
  g.__piggyBootGate = undefined;
}
