/**
 * Token 数与命中率的显示口径（对应 DSH `client/chat/token-format.ts`）。
 *
 * ## 为什么单独成文件
 *
 * 同一组数字在三个地方出现——输入卡下方的状态行、上下文环的 title、右栏「统计」——
 * 各自算一遍就会出现"同一个 15400 在一处是 15.4K、另一处是 15K"这种前后不一致。
 * DSH 也是同一个模块给三处共用（`formatTokens` / `formatExactTokens` /
 * `formatCacheHitPercent`）。
 *
 * ## 精度：3 位小数（用户要求，2026-09-23）
 *
 * 用户看到的两个数——**上下文长度**与**缓存命中率**——原先分别被四舍五入到
 * 整数 K（`15400 → 15K`）和整数百分比（`87.4% → 87%`），长上下文里
 * "这一轮到底涨了多少 token"、"缓存到底有没有命中"都看不出来。
 * 现在统一保留 {@link DECIMALS} 位小数：
 *
 * ```text
 * 15400     → 15.400K        999      → 999
 * 1234567   → 1.235M         1000000  → 1.000M
 * 缓存命中  → 87.345%        全命中    → 100%（不写小数）
 * ```
 *
 * 小数位**不省略末尾的 0**（`toFixed` 语义）：三处数字列宽一致才好对比，
 * 也避免"这一处到底有没有按 3 位小数显示"的自我怀疑。
 *
 * 想改成别的精度只动 {@link DECIMALS} 一处；命中率的"诚实规则"见
 * {@link formatCacheHitPercent}。
 */

/** 上下文长度与命中率的显示小数位（`15.400K` / `87.345%`）。 */
export const DECIMALS = 3;

/** 千 / 百万分档（DSH `number.thousand` / `number.million` 的中文口径同款）。 */
const THOUSAND = 1_000;
const MILLION = 1_000_000;

/**
 * 紧凑 token 数：`517` / `15.400K` / `1.235M`。
 *
 * 分档与 DSH 一致（`<1000` 不压缩、`<1e6` 用 K、再往上用 M），
 * 只有小数位按 {@link DECIMALS}。
 *
 * @param value - 非负 token 数；`null` / `undefined` / 非有限数 → `—`
 * @returns 展示串
 */
export function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const n = Math.max(0, value);
  if (n < THOUSAND) return String(Math.round(n));
  if (n < MILLION) return `${(n / THOUSAND).toFixed(DECIMALS)}K`;
  return `${(n / MILLION).toFixed(DECIMALS)}M`;
}

/**
 * 精确 token 数（带千分位）：`15,400`。
 *
 * 右栏「统计」的明细行用这个——那一栏是"账本"，压缩成 K 就丢信息了。
 *
 * @param value - token 数；缺失 → `—`
 * @returns 展示串
 */
export function formatExactTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return Math.round(value).toLocaleString('en-US');
}

/**
 * 缓存命中率：`缓存读 / 提示词总量`，保留 {@link DECIMALS} 位小数。
 *
 * **诚实规则（照抄 DSH `formatCacheHitPercent`）**：只要有 1 个 token 没命中，
 * 就绝不显示成 `100%`——四舍五入到 100 时改用更多小数位把它区分出来
 * （`99.9999%`）。否则"99.6% 命中"会被读成"全命中"，而这个数正是用来
 * 判断缓存有没有生效的。
 *
 * @param cacheReadTokens - 命中缓存的提示词 token 数
 * @param promptTokens - 提示词总 token 数（输入 + 缓存读）
 * @param decimals - 小数位，默认 {@link DECIMALS}
 * @returns 百分数串（不含 `%`），无提示词输入时 `null`
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  decimals: number = DECIMALS,
): string | null {
  if (!Number.isFinite(cacheReadTokens) || !Number.isFinite(promptTokens)) return null;
  if (promptTokens <= 0) return null;
  const read = Math.max(0, Math.min(cacheReadTokens, promptTokens));
  const missed = promptTokens - read;
  if (missed === 0) return '100';

  const d = Math.max(0, Math.min(6, Math.trunc(decimals)));
  const plain = percentUnits(read, promptTokens, d);
  if (plain < 100 * 10 ** d) return fixedPercent(plain, d);

  // 部分命中但四舍五入到了 100：加小数位直到能区分出"没满"。
  for (let extra = 1; extra <= 6; extra += 1) {
    const places = d + extra;
    const scale = 100 * 10 ** places;
    const units = Math.floor((read * scale) / promptTokens);
    if (units < scale) return fixedPercent(units, places);
  }
  // 理论上到不了这里（missed>0 时必然存在可区分的位数）；兜底比"假装 100"诚实。
  return '99.999999';
}

/** 按 `decimals` 位四舍五入后的"百分比 × 10^decimals"（整数，half-up）。 */
function percentUnits(read: number, prompt: number, decimals: number): number {
  const scale = 100 * 10 ** decimals;
  const num = read * scale;
  const q = Math.floor(num / prompt);
  const r = num - q * prompt;
  return r * 2 >= prompt ? q + 1 : q;
}

/** `units / 10^decimals`，固定 `decimals` 位（不省略末尾 0）。 */
function fixedPercent(units: number, decimals: number): string {
  if (decimals === 0) return String(units);
  const whole = Math.floor(units / 10 ** decimals);
  const frac = String(units % 10 ** decimals).padStart(decimals, '0');
  return `${whole}.${frac}`;
}
