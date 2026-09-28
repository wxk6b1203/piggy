/**
 * 思考强度档位（docs/03 §2.16、docs/04 §2.2）。
 *
 * 这份清单**不是**我们自己定的，是 pi 的：
 * `packages/coding-agent/src/cli/args.ts:60` 的 `VALID_THINKING_LEVELS`
 * （`--thinking <level>` 的可选值）。Rust 侧 `sessions/title.rs::THINKING_LEVELS`
 * 是同一份清单的另一个副本，两边互为金标（`session-title-shape.test.ts`
 * 里的 `THINKING` 用例与 `thinking_levels_match_pi_cli` 各写一遍）。
 *
 * 为什么要集中在这里：以前 `ModelPicker.tsx` 里私有一份 `THINKING_LABEL`。
 * 现在会话里的选择器与设置页的「标题思考强度」都要用——复制第二份就等于
 * 埋一个"两处档位名不一样"的雷（漏一个 `xhigh` 时用户只会看到少一个选项，
 * 没有任何报错）。所以只留一份，谁要谁 import。
 *
 * 为什么值本身必须是 pi 认的那几个：pi 对**不认识**的档位只往 stderr 打一行
 * `Warning: Invalid thinking level "…"` 然后**静默用默认档**继续跑（真机验证过）。
 * 也就是说写错 = 用户以为设了、实际没设，而且界面上看不出任何区别。
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** 中文名。取值与 pi 的档位一一对应，键必须覆盖 `THINKING_LEVELS` 的全部。 */
export const THINKING_LABEL: Record<string, string> = {
  off: '关闭',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
};

/** 界面显示的档位名；认不出的值原样显示（不隐藏"我们不认识它"这件事）。 */
export function thinkingLabel(level: string): string {
  return THINKING_LABEL[level] ?? level;
}

/** 界面用的档位选项（`跟模型默认` 由调用方自己加，因为那是"不传"语义）。 */
export function thinkingOptions(): { value: string; label: string }[] {
  return THINKING_LEVELS.map((lv) => ({ value: lv, label: thinkingLabel(lv) }));
}
