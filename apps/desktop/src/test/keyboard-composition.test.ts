// @vitest-environment jsdom
/**
 * 输入法合成期的键盘守卫（用户报："macOS 下如果输入中文，回车是选择，但是消息还是被发出去了"）。
 *
 * 关键那一幕是**时序**：确认候选词时浏览器先发 `compositionend`、再发 `keydown`，
 * 于是那次 keydown 的 `isComposing === false` —— 只查 `isComposing` 的实现会把半成品发出去。
 * 这里就按这个顺序造事件，另外补 `keyCode 229`（老引擎唯一的线索）与"松手后恢复"。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { observeComposition } from '@/lib/keyboardComposition';

let guard: ReturnType<typeof observeComposition>;
beforeEach(() => {
  guard?.dispose();
  guard = observeComposition(document);
});

/** 造一次键盘事件（`isComposing` 在 jsdom 里要手动给）。 */
function key(type: 'keydown' | 'keyup', init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent(type, { key: 'Enter', bubbles: true, ...init });
}

describe('observeComposition', () => {
  it('合成中：一律挡掉', () => {
    document.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(guard.guards(key('keydown', { isComposing: true }))).toBe(true);
  });

  it('**迟到的 keydown**（compositionend 之后才到的那个回车）也必须挡掉', () => {
    document.dispatchEvent(new CompositionEvent('compositionstart'));
    document.dispatchEvent(new CompositionEvent('compositionend'));
    // 这一次 keydown 的 isComposing 已经是 false —— 只看它就会误发
    expect(guard.guards(key('keydown', { isComposing: false }))).toBe(true);
    // 只兜一次：松手（keyup）之后恢复正常
    document.dispatchEvent(key('keyup'));
    expect(guard.guards(key('keydown', { isComposing: false }))).toBe(false);
  });

  it('老引擎：合成期把所有键报成 keyCode 229 也要挡掉', () => {
    document.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(guard.guards(key('keydown', { keyCode: 229 }))).toBe(true);
  });

  it('输入法面板被系统收走（blur）之后不再兜：不会永久吞回车', () => {
    document.dispatchEvent(new CompositionEvent('compositionstart'));
    document.dispatchEvent(new CompositionEvent('compositionend'));
    window.dispatchEvent(new Event('blur'));
    expect(guard.guards(key('keydown', { isComposing: false }))).toBe(false);
  });

  it('平时（没在合成）不挡任何键', () => {
    expect(guard.guards(key('keydown'))).toBe(false);
    expect(guard.guards(key('keydown', { key: 'a', keyCode: 65 }))).toBe(false);
  });

  it('dispose 之后监听器全摘掉（合成事件不再改变判据）', () => {
    guard.dispose();
    document.dispatchEvent(new CompositionEvent('compositionstart'));
    expect(guard.guards(key('keydown', { isComposing: false }))).toBe(false);
    guard = observeComposition(document); // 交回给 beforeEach 的清理
  });
});
