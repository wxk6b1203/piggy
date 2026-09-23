/**
 * fleetStore（docs/06 §5，M3）：A 层（宿主编排，Rust fleet:changed）+ B 层（piggy-bridge
 * 会话内子代理快照，PIGGY:1 载荷）统一视图模型。
 */
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';

export const BRIDGE_PREFIX = 'PIGGY:1:';

export interface FleetLane {
  key: string;
  role: string;
  status: 'pending' | 'running' | 'settled' | 'failed';
  tabId: string | null;
  resultPreview?: string | null;
}

export interface FleetRun {
  id: string;
  templateId: string;
  task: string;
  cwd: string;
  status: 'running' | 'done' | 'aborted';
  lanes: FleetLane[];
}

/** B 层：bridge status 快照中的一条子代理 lane */
export interface BridgeLane {
  agent?: string;
  status?: string;
  elapsed?: number;
  tokens?: number;
  cost?: number;
}

interface BridgeSnapshot {
  fetchedAt: number;
  lanes: BridgeLane[];
  raw: unknown;
}

interface FleetState {
  runs: Record<string, FleetRun>;
  order: string[];
  /** B 层：按 tabId 归组的子代理快照；installed=null = 未探测 */
  bridge: {
    installed: boolean | null;
    byTab: Record<string, BridgeSnapshot>;
  };

  applySnapshot(payload: { runs?: FleetRun[] }): void;
  applyBridgePayload(tabId: string, payload: unknown): boolean;
  markBridgeMissing(tabId: string): void;
  clear(): void;
}

/** 纯函数：解析 PIGGY:1 载荷（可单测）。非本协议载荷返回 null。 */
export function parseBridgePayload(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || !text.startsWith(BRIDGE_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text.slice(BRIDGE_PREFIX.length)) as Record<string, unknown>;
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

export const useFleet = create<FleetState>()(
  immer((set) => ({
    runs: {},
    order: [],
    bridge: { installed: null, byTab: {} },

    applySnapshot(payload) {
      set((s) => {
        s.runs = {};
        s.order = [];
        for (const run of payload.runs ?? []) {
          s.runs[run.id] = run;
          s.order.push(run.id);
        }
      });
    },

    /** bridge set_editor_text 载荷 → B 层快照；返回是否为本协议数据 */
    applyBridgePayload(tabId, payload) {
      const parsed = parseBridgePayload(payload);
      if (!parsed) return false;
      set((s) => {
        s.bridge.installed = true;
        if (parsed.kind === 'status' && parsed.ok) {
          const status = parsed.status as { lanes?: BridgeLane[] } | undefined;
          s.bridge.byTab[tabId] = {
            fetchedAt: Date.now(),
            lanes: status?.lanes ?? [],
            raw: parsed.status,
          };
        } else if (parsed.ok === false) {
          // 明确失败（含"未安装"降级）
          if (String(parsed.error ?? '').includes('未安装')) {
            s.bridge.installed = false;
          }
          s.bridge.byTab[tabId] = {
            fetchedAt: Date.now(),
            lanes: [],
            raw: parsed,
          };
        }
      });
      return true;
    },

    markBridgeMissing(tabId) {
      set((s) => {
        s.bridge.installed = false;
        s.bridge.byTab[tabId] = { fetchedAt: Date.now(), lanes: [], raw: { error: '未安装' } };
      });
    },

    clear() {
      set((s) => {
        s.runs = {};
        s.order = [];
      });
    },
  })),
);
