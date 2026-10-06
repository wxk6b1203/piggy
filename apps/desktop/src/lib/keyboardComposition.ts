/**
 * 输入法（IME）合成期的键盘守卫（DSH `ui-primitives/src/keyboard-composition.ts` 的移植）。
 *
 * ## 为什么 `isComposing` 不够
 *
 * 中文/日文输入法里，**回车是"确认候选词"**，不该被当成"发送"。`KeyboardEvent.isComposing`
 * 看上去正好管这件事，但 macOS 上有一个致命时序：确认候选的那一下会先发
 * `compositionend`、**再**发 `keydown` —— 于是那个 keydown 的 `isComposing` 已经是 `false`，
 * 界面就把半成品发出去了（用户报的："macOS 下如果输入中文，回车是选择，但是消息还是被发出去了"）。
 *
 * DSH 的做法是**记住合成刚刚结束**（`ended`），并把紧随其后的那一次 keydown 也算作合成的一部分，
 * 直到 `keyup` 释放这个标记。三个信号一起用：
 *
 * ```
 * compositionstart → composing = true
 * compositionend   → composing = false, ended = true     ← 那个"迟到的 keydown"靠它兜住
 * keyup            → ended = false                        ← 松手之后恢复正常
 * blur             → 两个都清（输入法面板被系统收走时不会再发 keyup）
 * ```
 *
 * 另外补一条 `keyCode === 229`：老引擎在合成期把所有键都报成 229（`isComposing` 还没实现时
 * 的唯一线索），DSH 也保留着这条。`guards()` 每次调用都会消费掉 `ended`（一次合成只兜一次）。
 */

/** 观察合成期，返回一个"这次按键算不算合成"的判据与卸载函数。 */
export function observeComposition(doc: Document): {
  /** 这次键盘事件是否属于输入法合成（true = 调用方应当忽略它） */
  guards(event: KeyboardEvent): boolean;
  dispose(): void;
} {
  let composing = false;
  let ended = false;
  const start = (): void => {
    composing = true;
  };
  const end = (): void => {
    composing = false;
    ended = true;
  };
  const release = (): void => {
    ended = false;
  };
  const blur = (): void => {
    composing = false;
    ended = false;
  };
  doc.addEventListener('compositionstart', start, true);
  doc.addEventListener('compositionend', end, true);
  doc.addEventListener('keyup', release, true);
  doc.defaultView?.addEventListener('blur', blur);
  return {
    guards(event) {
      // `keyCode === 229` 是**只有**输入法合成期才会出现的值（旧的 IME 实现里它是唯一线索）
      const guarded = composing || ended || event.isComposing || event.keyCode === 229;
      ended = false;
      return guarded;
    },
    dispose() {
      doc.removeEventListener('compositionstart', start, true);
      doc.removeEventListener('compositionend', end, true);
      doc.removeEventListener('keyup', release, true);
      doc.defaultView?.removeEventListener('blur', blur);
    },
  };
}
