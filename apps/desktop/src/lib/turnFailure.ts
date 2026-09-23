/**
 * 回合终态判读（pi 契约，2026-09-23 用真实 pi 抓包确认）。
 *
 * pi 把「这一轮没成」也表达成一条**普通的 assistant 消息**，而不是单独的错误事件：
 *
 *   模型报错 → { content: [], stopReason: 'error',   errorMessage: '401: {"message":"Authentication Fails, …"}' }
 *   用户中断 → { content: [], stopReason: 'aborted', errorMessage: 'Request aborted' }
 *
 * 两者 `content` 都是空数组。任何"只渲染 content"的视图（MessageView / 轨迹表）
 * 都会画出一个**空回合**——用户看到的就是「消息发出去了，什么都没回来」。
 * 错误文本一直都在消息里，只是从来没有代码读过它。
 *
 * 本模块把这段判读抽成纯函数，让转写视图与轨迹视图用**同一套**规则，
 * 避免两处各自解释导致行为不一致。
 */

export type TurnFailureKind = 'error' | 'aborted';

export interface TurnFailure {
  kind: TurnFailureKind;
  /** 一句话结论 */
  title: string;
  /** provider / pi 的原始文本，不改写；中断且只有模板话术时为空串 */
  detail: string;
  /** 按错误文本匹配出的可能原因；匹配不到就没有这个字段（不猜） */
  hint?: string;
}

/** 用户主动中断时 pi 固定发这句话，没有信息量，不值得占版面。 */
const ABORT_BOILERPLATE = /^(request )?aborted( by user)?\.?$/i;

/**
 * 常见故障 → 可执行提示。
 *
 * 只在**证据明确**时给提示：模式串都取得比较窄（状态码 / 标准 errno / provider 固定话术），
 * 且原始文本永远照原样展示，提示只作为"可能原因"出现。宁可没有提示，也不要猜错方向。
 */
const HINTS: Array<{ re: RegExp; hint: string }> = [
  {
    re: /(^|\D)(401|403)(\D|$)|unauthor|authentication|invalid[ _-]?api[ _-]?key|api key[^"]{0,40}invalid/i,
    hint:
      '凭据被拒：API key 无效或已过期。在「设置 › Provider 认证」或「设置 › 自定义模型」' +
      '（models.json 里的 apiKey）更新后需重开会话——已运行的会话持有旧配置。',
  },
  {
    re: /(^|\D)429(\D|$)|rate[ _-]?limit|too many requests|quota|insufficient[ _-]?balance/i,
    hint: '限流或额度不足：稍后重试，或换一个模型／provider。',
  },
  {
    re: /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET)\b|fetch failed|socket hang up|network error/i,
    hint: '网络不通：检查该 provider 的 baseUrl 与代理设置是否可达。',
  },
  {
    re: /model[^.]{0,40}(not[ _-]?found|not[ _-]?exist|unknown|unsupported|no access)|no such model/i,
    hint: '模型不可用：该 provider 下没有这个模型 ID，或账号无权访问。',
  },
];

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 判读一条 assistant 消息是否为失败回合。
 * @param m pi 的 assistant 消息（或任意未知形状的输入）
 * @returns 失败描述；正常回合返回 null
 */
export function turnFailure(m: unknown): TurnFailure | null {
  const msg = (m ?? {}) as { role?: string; stopReason?: string; errorMessage?: unknown };
  if (msg.role !== 'assistant') return null;

  const raw = typeof msg.errorMessage === 'string' ? oneLine(msg.errorMessage) : '';
  const aborted = msg.stopReason === 'aborted';
  // 判据比 stopReason 宽：只要带了错误文本就算失败。
  // pi 将来新增终态（如 length/deferred）时，带 errorMessage 的那些不会重新变成空白回合。
  const failed = msg.stopReason === 'error' || aborted || raw !== '';
  if (!failed) return null;

  if (aborted) {
    return {
      kind: 'aborted',
      title: '已中止',
      detail: ABORT_BOILERPLATE.test(raw) ? '' : raw,
    };
  }

  const hint = raw ? HINTS.find((h) => h.re.test(raw))?.hint : undefined;
  return {
    kind: 'error',
    title: '本轮失败',
    detail: raw || '模型调用失败，且 provider 未返回错误详情。',
    ...(hint ? { hint } : {}),
  };
}
