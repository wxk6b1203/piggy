/**
 * 布局生命周期判据的回归测试。
 *
 * 这些条件本身很短，但**判错时是静默的**：界面照常显示，坏掉的是"哪些 tab 还算活着"。
 * 实测代价（2026-09-23）：StrictMode 下两轮布局恢复把同一份布局套到了同一个 dockview
 * 实例上，`fromJSON` 的先清空把刚恢复出来的 tab 全关掉 → 面板还显示着、
 * useTabs 空了、Rust registry 也空了 → 该标签下所有命令报「tab 不存在: <uuid>」。
 * 所以把判据抽成纯函数，在这里把真值表钉死。
 */
import { describe, expect, it } from 'vitest';
import { shouldApplyLayout, shouldCloseTabOnPanelRemoved } from '@/lib/layoutLifecycle';

describe('shouldApplyLayout：布局只能套到本轮开始时捕获的那个实例', () => {
  const A = { name: 'A' };
  const B = { name: 'B' };

  it('实例没换 → 套用', () => {
    expect(shouldApplyLayout(A, A)).toBe(true);
  });

  it('实例换了（StrictMode/HMR 重挂）→ 本轮作废', () => {
    expect(shouldApplyLayout(A, B)).toBe(false);
  });

  it('没有目标实例 → 不套用', () => {
    expect(shouldApplyLayout(null, A)).toBe(false);
    expect(shouldApplyLayout(undefined, undefined)).toBe(false);
  });

  it('当前实例已消失 → 不套用（不往已卸载的实例上写布局）', () => {
    expect(shouldApplyLayout(A, null)).toBe(false);
  });
});

describe('shouldCloseTabOnPanelRemoved：什么才算"用户关了标签"', () => {
  const base = { applyingLayout: false, liveInstance: true, stillOpen: false };

  it('正常用户关闭：活实例、非套用期、没有别的面板在用 → 关', () => {
    expect(shouldCloseTabOnPanelRemoved(base)).toBe(true);
  });

  it('套用布局期间（fromJSON 先清空再重建）→ 不关', () => {
    expect(shouldCloseTabOnPanelRemoved({ ...base, applyingLayout: true })).toBe(false);
  });

  it('事件来自已失效的实例 → 不关', () => {
    expect(shouldCloseTabOnPanelRemoved({ ...base, liveInstance: false })).toBe(false);
  });

  it('活实例里还有面板在用同一个 tabId → 不关', () => {
    expect(shouldCloseTabOnPanelRemoved({ ...base, stillOpen: true })).toBe(false);
  });

  it('三条否决理由同时成立 → 仍然不关', () => {
    expect(
      shouldCloseTabOnPanelRemoved({ applyingLayout: true, liveInstance: false, stillOpen: true }),
    ).toBe(false);
  });
});
