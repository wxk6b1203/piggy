/**
 * Monaco 实例池（docs/10 §2.3 的"并发上限"改成**回收水位**）。
 *
 * ## 为什么原来那道"上限"是个墙，而不是保护
 *
 * 起因（用户）："monaco editor 很吃资源吗？能放开限制 editor 个数吗？"
 * 实测（真浏览器，`editor.create` 直接量）：首个实例 ~9MB（含 Monaco 核心与第一门 tokenizer 的
 * 首次开销），**之后每个实例 ~0.5–1.5MB JS 堆、~70ms 创建**；12 个实例总计 ~18MB。
 * 也就是说每实例的开销根本不大 —— 而 `MAX_INSTANCES = 6` 那道墙的成因其实是另一件事：
 * **dockview 把非活动面板的 React 树留着**（DOM 从文档里摘掉，但组件不卸载），
 * 于是每开一个预览标签就**永久**多一个活着的 Monaco 实例，开到第 7 个就撞墙；
 * 而"已超限"是渲染时算一次的 `useRef`，撞上之后**永远显示"请关闭部分预览标签"**，
 * 关掉别的标签也不会恢复（要重新挂载）。
 *
 * ## 现在的语义
 *
 * - **不可见的挂载点根本不创建编辑器**（可见性由 dockview 的 panel api 提供）：
 *   开 20 个预览标签 = 只有当前那一个活着，切回去时再建（~70ms，预览是只读的，代价可控）。
 * - 仍然保留一个**水位** `MAX_LIVE_EDITORS`：最近显示过的实例会留一小会儿，
 *   让来回切标签不至于每次都重建；**超过水位时回收"最久没显示过的隐藏实例"**（LRU），
 *   而不是拒绝新实例。
 * - **没有"拒绝"这条路径**：实在没有可回收的（比如分屏里全都在显示）就允许超出水位 ——
 *   多占几 MB 远好过一个点不动的界面。
 *
 * 这个模块是**纯策略**（没有 Monaco、没有 React），所以策略本身可以在 node 里被逐条验证。
 */

/** 保留水位（不是拒绝线）：最近显示过的隐藏实例最多留这么多个。 */
export const MAX_LIVE_EDITORS = 6;

interface Slot {
  /** 当前是否显示（由挂载点汇报）。 */
  visible: boolean;
  /** 最近一次「可见」的序号（越大越新）。 */
  lastVisible: number;
  /** 回收这个实例：调用方负责 dispose 编辑器，并（如果它仍可见）重新创建。 */
  evict: () => void;
}

const slots = new Map<string, Slot>();
let clock = 0;

/** 当前活着的实例数（门禁与单测读它）。 */
export function liveEditors(): number {
  return slots.size;
}

/** 仅供测试：清空池子（不动真实编辑器）。 */
export function resetPoolForTest(): void {
  slots.clear();
  clock = 0;
}

/** 登记一个可见实例。超过水位时先回收最久没显示过的隐藏实例。 */
export function acquireEditor(id: string, evict: () => void): void {
  slots.set(id, { visible: true, lastVisible: ++clock, evict });
  while (slots.size > MAX_LIVE_EDITORS) {
    const victim = [...slots.entries()]
      .filter(([key, slot]) => key !== id && !slot.visible)
      .sort((a, b) => a[1].lastVisible - b[1].lastVisible)[0];
    if (!victim) break; // 全都在显示 → 允许超出水位（宁可多占内存，也不给点了没反应的界面）
    slots.delete(victim[0]); // 先摘牌，避免被回收者的回调再回到池子里
    victim[1].evict();
  }
}

/** 挂载点汇报可见性。隐藏**不**销毁实例（留给 LRU 决定），只影响回收顺序。 */
export function setEditorVisible(id: string, visible: boolean): void {
  const slot = slots.get(id);
  if (!slot) return;
  slot.visible = visible;
  if (visible) slot.lastVisible = ++clock;
}

/** 挂载点卸载 / 编辑器销毁时摘牌。 */
export function releaseEditor(id: string): void {
  slots.delete(id);
}

/** 当前活着的实例 id（排障用；顺序 = Map 插入序）。 */
export function liveEditorIds(): string[] {
  return [...slots.keys()];
}
