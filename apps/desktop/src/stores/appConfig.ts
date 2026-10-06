/**
 * 应用级配置里**界面要用到**的那一小片（docs/03 §3.2）。
 *
 * 为什么单独开一个 store：`PerfConfig` 以前只有设置页自己读（用 `perf_config_load`
 * 拉一次、改完再写回去），别的界面拿不到。而"预览滚动条放哪边"是**转录要读**的配置——
 * 设置页改完必须立刻影响所有已打开的会话，所以需要一个双方都能订阅的地方。
 *
 * 只放**界面真的读**的字段（`railPlacement`、`transcriptDetail`）。不要把整份 PerfConfig
 * 搬进来：并发数、权限档位那些是后端行为，多一份前端副本就多一个不一致的地方。
 */
import { create } from 'zustand';
import { cmd } from '@/lib/ipc';

export type RailPlacement = 'off' | 'left' | 'right';

/**
 * 「工作步骤展示」四档（docs/04 §2.1.6，DSH 的 `transcriptView`）。
 *
 * - `compact` 简洁：历史回合折成一行（不带耗时），思考行不显示摘要；
 * - `standard` 标准（默认）：历史回合折成一行（状态 + 耗时），思考摘要取首行；
 * - `detailed` 详细：历史回合**不折**，只留一行不可折叠的「已完成工作 · 用时」；
 * - `verbose` 完全展开：折叠行不出现，过程全可见。
 */
export type TranscriptDetail = 'compact' | 'standard' | 'detailed' | 'verbose';

interface AppConfigState {
  /** 预览滚动条位置（默认右：与 DSH 的轮次导航条同侧） */
  railPlacement: RailPlacement;
  /** 工作步骤展示档位（默认 standard：与 DSH 的 Desktop 默认一致） */
  transcriptDetail: TranscriptDetail;
  loaded: boolean;
  load(): Promise<void>;
  /** 设置页保存成功后调用：把新值推给所有订阅者（不重新拉 IPC） */
  setRailPlacement(p: RailPlacement): void;
  setTranscriptDetail(d: TranscriptDetail): void;
}

/** 认不出的值收回默认档（与 Rust `RailPlacement` 的 `#[serde(other)]` 同义）。 */
function coerceRail(v: unknown): RailPlacement {
  return v === 'off' || v === 'left' || v === 'right' ? v : 'right';
}

/** 同上，对 `TranscriptDetail`；`normal`/`expanded` 是 DSH 的历史取值，一并认。 */
function coerceDetail(v: unknown): TranscriptDetail {
  switch (v) {
    case 'compact':
    case 'standard':
    case 'detailed':
    case 'verbose':
      return v;
    case 'normal':
      return 'detailed';
    case 'expanded':
      return 'verbose';
    default:
      return 'standard';
  }
}

export const useAppConfig = create<AppConfigState>()((set) => ({
  railPlacement: 'right',
  transcriptDetail: 'standard',
  loaded: false,

  async load() {
    try {
      const c = await cmd<{ transcript_rail?: string; transcript_detail?: string }>('perf_config_load');
      set({
        railPlacement: coerceRail(c?.transcript_rail),
        transcriptDetail: coerceDetail(c?.transcript_detail),
        loaded: true,
      });
    } catch {
      // 读不到配置不是致命错误：用默认档继续（与 Rust 侧 perf_config_load 的回落同义），
      // 但不把 loaded 置真——下次还有机会读到真实值。
    }
  },

  setRailPlacement(p) {
    set({ railPlacement: coerceRail(p) });
  },

  setTranscriptDetail(d) {
    set({ transcriptDetail: coerceDetail(d) });
  },
}));

/** 非 React 场景（命令里）读当前值。 */
export const railPlacementNow = (): RailPlacement => useAppConfig.getState().railPlacement;
