/**
 * piggy-bridge v1（docs/06 §4，M3 B 层）：
 * pi 扩展，桥接 pi-subagents 的 in-process event-bus RPC v1 与 Piggy GUI。
 *
 * 通道约定（06 §4.2，双端同仓原子演进）：
 * - GUI → bridge：`/piggy:<verb> [argsJson]` 扩展命令（prompt 即时执行）
 * - bridge → GUI：`ctx.ui.set_editor_text("PIGGY:1:" + json)` 数据载荷（前端劫持解析）
 *   + `ctx.ui.notify`（人读摘要） + `ctx.ui.setWidget`（舰队状态行）
 *
 * verbs：status / steer / interrupt / stop / resume / fleet-refresh
 * 能力协商：ping（nonRecoveringSteer 等能力位）；pi-subagents 未安装时返回明确降级提示。
 *
 * 本文件只依赖文档化的扩展 API（pi docs/extension-api.md）与 subagents RPC v1
 * 文档化缝（subagents:rpc:v1:* 事件），不触碰两者任何内部模块（06 §4.5）。
 */

interface UiApi {
  setEditorText(text: string): void;
  notify(message: string, notifyType?: 'info' | 'warning' | 'error' | 'success'): void;
  setWidget(lines: string[] | null): void;
}

interface PiApi {
  name?: string;
  ui: UiApi;
  /** 注册扩展命令：pi 在 prompt 中遇到 `/name args` 时回调（流式中也立即执行） */
  registerCommand(
    name: string,
    handler: (args: string, ctx: unknown) => void | Promise<void>,
  ): void;
  /** 事件监听（文档化事件面） */
  on(event: string, handler: (payload: unknown) => void): void;
}

/** subagents RPC v1 文档化缝 */
interface SubagentsRpc {
  request(action: string, payload: unknown): Promise<unknown>;
}

const VERSION_PREFIX = 'PIGGY:1:';

export default function piggyBridge(pi: PiApi): void {
  let rpc: SubagentsRpc | null = null;
  let capabilities: Record<string, unknown> = {};

  const send = (payload: unknown, humanSummary?: string): void => {
    const json = VERSION_PREFIX + JSON.stringify(payload);
    pi.ui.setEditorText(json);
    if (humanSummary) pi.ui.notify(humanSummary, 'info');
  };

  const degraded = (verb: string): void => {
    send(
      { kind: 'bridge', ok: false, error: 'pi-subagents 未安装', verb },
      '未检测到 pi-subagents（安装后重启 pi：pi install npm:pi-subagents）',
    );
    pi.ui.setWidget(['fleet: pi-subagents 未安装', 'fleet: 安装后本行变为舰队状态']);
  };

  async function call(action: string, payload: unknown): Promise<unknown> {
    if (!rpc) throw new Error('pi-subagents RPC 未就绪');
    return rpc.request(action, payload);
  }

  // 就绪 + 能力协商（06 §4.3）
  pi.on('subagents:rpc:v1:ready', (bus) => {
    const b = bus as { request(action: string, payload: unknown): Promise<unknown> };
    b.request('ping', {})
      .then((pong) => {
        rpc = b;
        capabilities = (pong as { capabilities?: Record<string, unknown> })?.capabilities ?? {};
        pi.ui.notify(
          `piggy-bridge 就绪（pi-subagents 能力: ${Object.keys(capabilities).join(', ') || 'basic'}）`,
          'success',
        );
      })
      .catch(() => {
        rpc = b; // ping 不通也保持通道，动词级报错
        pi.ui.notify('piggy-bridge：pi-subagents ping 失败（版本不匹配？）', 'warning');
      });
  });

  pi.registerCommand('piggy:status', async () => {
    if (!rpc) return degraded('status');
    try {
      const status = await call('status', {});
      const runs = (status as { runs?: unknown[] })?.runs ?? [];
      const lines = [
        `fleet: ${runs.length} runs`,
        ...((status as { lanes?: unknown[] })?.lanes ?? []).slice(0, 8).map((l) => `fleet·lane: ${JSON.stringify(l).slice(0, 80)}`),
      ];
      pi.ui.setWidget(lines);
      send({ kind: 'status', ok: true, status }, `舰队状态已同步（${runs.length} runs）`);
    } catch (e) {
      send({ kind: 'status', ok: false, error: String(e) }, `status 失败: ${String(e)}`);
    }
  });

  pi.registerCommand('piggy:steer', async (args) => {
    if (!rpc) return degraded('steer');
    // args: <runId> [index] <message...>
    const [runId, second, ...rest] = args.trim().split(/\s+/);
    const payload: Record<string, unknown> = { runId };
    let message: string;
    if (rest.length === 0) {
      message = second ?? '';
    } else {
      payload.index = Number(second);
      message = rest.join(' ');
    }
    payload.message = message;
    try {
      const receipt = await call('steer', payload);
      const delivery = (receipt as { deliveryStatus?: string })?.deliveryStatus ?? 'unknown';
      send({ kind: 'steer', ok: true, receipt, runId }, `steer 已送达（${delivery}）`);
    } catch (e) {
      send({ kind: 'steer', ok: false, error: String(e), runId }, `steer 失败: ${String(e)}`);
    }
  });

  pi.registerCommand('piggy:interrupt', async (args) => {
    if (!rpc) return degraded('interrupt');
    try {
      const receipt = await call('interrupt', { runId: args.trim() });
      send({ kind: 'interrupt', ok: true, receipt, runId: args.trim() }, '已中断');
    } catch (e) {
      send({ kind: 'interrupt', ok: false, error: String(e) }, `interrupt 失败: ${String(e)}`);
    }
  });

  pi.registerCommand('piggy:stop', async (args) => {
    if (!rpc) return degraded('stop');
    try {
      const receipt = await call('stop', { runId: args.trim() });
      send({ kind: 'stop', ok: true, receipt, runId: args.trim() }, '已停止');
    } catch (e) {
      send({ kind: 'stop', ok: false, error: String(e) }, `stop 失败: ${String(e)}`);
    }
  });

  pi.registerCommand('piggy:resume', async (args) => {
    if (!rpc) return degraded('resume');
    const [runId, ...msg] = args.trim().split(/\s+/);
    try {
      const receipt = await call('resume', { runId, message: msg.join(' ') });
      send({ kind: 'resume', ok: true, receipt, runId }, '已续跑');
    } catch (e) {
      send({ kind: 'resume', ok: false, error: String(e) }, `resume 失败: ${String(e)}`);
    }
  });

  pi.registerCommand('piggy:fleet-refresh', async () => {
    // 状态变化时 bridge 主动 setWidget（06 §4.3 轮询替代）
    if (!rpc) return degraded('fleet-refresh');
    try {
      const status = await call('status', {});
      const runs = (status as { runs?: unknown[] })?.runs ?? [];
      pi.ui.setWidget([`fleet: ${runs.length} runs · ${new Date().toLocaleTimeString()}`]);
    } catch (e) {
      pi.ui.setWidget([`fleet: 刷新失败 ${String(e)}`]);
    }
  });
}
