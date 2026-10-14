/**
 * `perf_config_save` 的**唯一**入口（读-改-写）。
 *
 * ## 为什么要有这个模块
 *
 * 它是真机上唯一会写 `~/.piggy/config.json` 的命令。它的线格式（IPC 参数名）里
 * `maxWorkers` / `idleTimeoutMin` 是**必填**的，其余是可选（不传 = 保持既有值）——
 * 而这条约束**只写在 Rust 的签名里**，前端各调各的：
 *
 * ```ts
 * // 2026-10-13 用户实测报错：设置页里关掉「结构化提问」时
 * await cmd('perf_config_save', { bundledPlugins: enabled });
 * // → invalid args `maxWorkers` for command `perf_config_save`:
 * //   command perf_config_save missing required key maxWorkers
 * ```
 *
 * 浏览器门禁跑在 mock 上，而 mock 对缺参是宽容的（`Number(a.maxWorkers ?? appCfg.…`），
 * 于是**那条路一次都没被真机执行过**，直到用户手点。
 * 这是本项目反复记过的那类结构性风险：**mock 比真机宽松**（docs/14 §6）。
 *
 * 修法不是给那一处补两个字段（下一个加开关的人还会踩），而是：
 *   1. 一个函数负责"读回来 → 打补丁 → 带全必填字段写回去"；
 *   2. 类型约束摆在 [`savePerfConfig`] 的入参上（必填项由"读回来"那份保证）；
 *   3. mock 对必填参数**像 Tauri 一样报错**（见 `mockBackend.ts` 的 REQUIRED_ARGS）。
 */
import { cmd } from './ipc';

/** `perf_config_load` 读回来的形状（Rust `PerfConfig`，**snake_case**）。 */
export interface PerfConfigLoaded {
  max_workers: number;
  idle_timeout_min: number;
  pi_source?: string | null;
  pi_path?: string | null;
  subagent_delegation?: boolean;
  title_max_chars?: number;
  title_source?: string;
  title_model?: string | null;
  title_thinking?: string | null;
  transcript_rail?: string;
  transcript_detail?: string;
  bundled_plugins?: string[];
}

/**
 * 要改哪些字段。**不传 = 保持既有值**（与后端读-改-写的语义一致）。
 *
 * 这里刻意全用可选：调用方只该说自己关心的事，"把别的字段原样带回去"是这个模块的活。
 */
export interface PerfConfigPatch {
  max_workers?: number;
  idle_timeout_min?: number;
  piSource?: string;
  piPath?: string | null;
  subagentDelegation?: boolean;
  titleMaxChars?: number;
  titleSource?: string;
  /* `null` 是有意义的取值：清掉覆盖（回到"跟会话自己的模型"/"用 pi 默认档"），
     后端把 null 当"要改"，所以类型上必须允许它，不能只写 `string`。 */
  titleModel?: string | null;
  titleThinking?: string | null;
  transcriptRail?: string;
  transcriptDetail?: string;
  bundledPlugins?: string[];
}

/**
 * 读-改-写 `config.json`：只有 `patch` 里出现的字段会被改。
 *
 * @param patch - 要改的字段；其余保持磁盘上的现值
 */
export async function savePerfConfig(patch: PerfConfigPatch): Promise<void> {
  // 先把现状读回来 —— 必填的 `maxWorkers` / `idleTimeoutMin` 由此保证**永远带着**，
  // 而不是指望每个调用点自己记得（那正是出错过的地方）。
  const cur = await cmd<PerfConfigLoaded>('perf_config_load');
  const args: Record<string, unknown> = {
    maxWorkers: patch.max_workers ?? cur.max_workers,
    idleTimeoutMin: patch.idle_timeout_min ?? cur.idle_timeout_min,
  };
  /* 可选字段：`undefined` 不塞进去（塞了会被序列化成 null，后端把 null 当"要改"）。
     注意 `null` 是有意义的（清空 title_model / pi_path），所以判据是 `!== undefined`。 */
  const optional: Array<[string, unknown]> = [
    ['piSource', patch.piSource],
    ['piPath', patch.piPath],
    ['subagentDelegation', patch.subagentDelegation],
    ['titleMaxChars', patch.titleMaxChars],
    ['titleSource', patch.titleSource],
    ['titleModel', patch.titleModel],
    ['titleThinking', patch.titleThinking],
    ['transcriptRail', patch.transcriptRail],
    ['transcriptDetail', patch.transcriptDetail],
    ['bundledPlugins', patch.bundledPlugins],
  ];
  for (const [key, value] of optional) {
    if (value !== undefined) args[key] = value;
  }
  await cmd('perf_config_save', args);
}
