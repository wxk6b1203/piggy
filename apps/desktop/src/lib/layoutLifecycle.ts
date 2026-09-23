/**
 * 布局生命周期判据（EditorArea 用；抽成纯函数以便脱离 dockview 测试）。
 *
 * 这里的每一条都是踩出来的（2026-09-23），而且都是**静默**踩的：
 * 界面看起来正常，坏的是"哪些 tab 还算活着"。
 */

/**
 * 本轮 `restore()` 产出的布局，还能不能套到 dockview 上？
 *
 * `restore()` 是异步的（`layout_load` + 每个面板一次 `createTab`），而 StrictMode / HMR
 * 会在它跑的过程中把 DockviewReact 卸载再挂载。**必须在 `restore()` 开始时捕获目标实例，
 * 落地前再确认它还是那个活着的实例**：
 *
 *  - 捕获后不校验（旧写法 `api()?.fromJSON(...)`）：两轮 restore 里较早那轮醒来时
 *    `api()` 已经换成新实例，于是**同一个实例被套了两次布局**；
 *  - `fromJSON()` 是**先清空再重建**：第二次套用会为每个面板触发 `onDidRemovePanel`，
 *    而处理函数把它当成"用户关了标签" → 刚恢复出来的 tab 全被关掉。
 *
 * 实测症状：面板还显示着、`useTabs` 却空了、Rust registry 也空了，
 * 该标签下所有命令一起报「tab 不存在: <uuid>」（模型列表空白、转写空白、发送无响应）。
 *
 * @param target `restore()` 开始时捕获的实例
 * @param current 落地这一刻真正活着的实例
 */
export function shouldApplyLayout(
  target: unknown | null | undefined,
  current: unknown | null | undefined,
): boolean {
  return !!target && target === current;
}

/**
 * 「面板被移除」能不能当成「用户关闭了标签」？
 *
 * 三条否决理由，缺一不可：
 *  1. `applyingLayout`：正在套用持久化布局（`fromJSON` 先清空再重建），
 *     这期间的移除是**结构性**的，不是用户操作；
 *  2. `!liveInstance`：事件来自**已失效的 dockview 实例**（StrictMode / HMR 卸载旧实例时
 *     照样会为每个面板触发回调）；
 *  3. `stillOpen`：当前活着的实例里**还有面板**在用同一个 tabId。
 */
export function shouldCloseTabOnPanelRemoved(ctx: {
  applyingLayout: boolean;
  liveInstance: boolean;
  stillOpen: boolean;
}): boolean {
  return !ctx.applyingLayout && ctx.liveInstance && !ctx.stillOpen;
}
