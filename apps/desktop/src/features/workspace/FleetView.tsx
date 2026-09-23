/**
 * Fleet 视图（docs/06 §5，M3）：A 层宿主编排 runs + B 层 piggy-bridge 会话内子代理。
 *
 * 说明：此视图在 2026-09-23 的一次批量改写事故中随 `RightBar.tsx` 一起丢失（见 docs/14 §0.1），
 * 本轮按 `stores/fleet.ts` 的现存接口重建。store 与测试当时均未受损，故行为以它们为准。
 */
import { useEffect, useState } from 'react';
import { cmd } from '@/lib/ipc';
import { toast } from '@/lib/feedback';
import { useFleet, type FleetRun } from '@/stores/fleet';
import { useTabs } from '@/stores/tabs';
import { Icon } from '@/features/common/Icon';

const STATUS_LABEL: Record<string, string> = {
  pending: '等待',
  running: '运行中',
  settled: '完成',
  failed: '失败',
  done: '完成',
  aborted: '已中止',
};

export function FleetView({ tabId }: { tabId: string | null }) {
  const runs = useFleet((s) => s.runs);
  const order = useFleet((s) => s.order);
  const bridge = useFleet((s) => s.bridge);
  const cwd = useTabs((s) => (tabId ? s.tabs[tabId]?.cwd : undefined));
  const [templates, setTemplates] = useState<Record<string, { label: string }>>({});
  const [templateId, setTemplateId] = useState('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void cmd<Record<string, { label: string }>>('fleet_templates', {})
      .then((t) => {
        setTemplates(t ?? {});
        const first = Object.keys(t ?? {})[0];
        if (first) setTemplateId((cur) => cur || first);
      })
      .catch(() => setTemplates({}));
  }, []);

  const start = async () => {
    if (!task.trim() || !templateId) return;
    if (!cwd) {
      toast.error('没有活动工作区目录，无法启动编排');
      return;
    }
    setBusy(true);
    try {
      // Rust 侧签名为 cwd: String（非 Option），必须传真实目录
      await cmd('fleet_start', { templateId, task: task.trim(), cwd });
      setTask('');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  };

  const abort = async (id: string) => {
    try {
      await cmd('fleet_abort', { runId: id });
    } catch (e) {
      toast.error(String(e));
    }
  };

  const list: FleetRun[] = order.map((id) => runs[id]).filter(Boolean) as FleetRun[];
  const visible = tabId ? (bridge.byTab[tabId]?.lanes ?? []) : [];

  return (
    <div className="pg-fleet">
      <section className="pg-fleet-section">
        <div className="pg-fleet-title">开始编排</div>
        <div className="pg-fleet-start">
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {Object.keys(templates).length === 0 && <option value="">（无可用模板）</option>}
            {Object.entries(templates).map(([id, t]) => (
              <option key={id} value={id}>
                {t.label ?? id}
              </option>
            ))}
          </select>
          <textarea
            className="pg-fleet-task"
            placeholder="任务描述…"
            rows={2}
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
          <button
            className="pg-fleet-go"
            disabled={busy || !task.trim() || !templateId || !cwd}
            onClick={() => void start()}
          >
            <Icon name="play" size={13} /> 启动
          </button>
        </div>
      </section>

      <section className="pg-fleet-section">
        <div className="pg-fleet-title">编排任务（{list.length}）</div>
        {list.length === 0 && <div className="pg-fleet-empty pg-fg-dim">暂无编排任务</div>}
        {list.map((r) => (
          <div key={r.id} className="pg-fleet-run">
            <div className="pg-fleet-run-head">
              <span className={`pg-fleet-status pg-fs-${r.status}`}>
                {STATUS_LABEL[r.status] ?? r.status}
              </span>
              <span className="pg-fleet-run-task" title={r.task}>
                {r.task}
              </span>
              {r.status === 'running' && (
                <button title="中止" onClick={() => void abort(r.id)}>
                  <Icon name="debug-stop" size={12} />
                </button>
              )}
            </div>
            {r.lanes.map((l) => (
              <div key={l.key} className="pg-fleet-lane">
                <span className={`pg-fleet-dot pg-lane-${l.status}`} />
                <span className="pg-fleet-lane-role">{l.role}</span>
                <span className="pg-fleet-lane-status">{STATUS_LABEL[l.status] ?? l.status}</span>
                {l.resultPreview ? (
                  <span className="pg-fleet-lane-result" title={l.resultPreview}>
                    {l.resultPreview}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="pg-fleet-section">
        <div className="pg-fleet-title">会话内子代理</div>
        {bridge.installed === false && (
          <div className="pg-fleet-empty pg-fg-dim">未安装 piggy-bridge 扩展</div>
        )}
        {bridge.installed !== false && visible.length === 0 && (
          <div className="pg-fleet-empty pg-fg-dim">当前会话无子代理活动</div>
        )}
        {visible.map((l, i) => (
          <div key={`${l.agent ?? 'lane'}-${i}`} className="pg-fleet-lane">
            <span className="pg-fleet-dot" />
            <span className="pg-fleet-lane-role">{l.agent ?? '子代理'}</span>
            <span className="pg-fleet-lane-status">
              {l.status ?? '—'}
              {l.elapsed != null ? ` · ${(l.elapsed / 1000).toFixed(1)}s` : ''}
              {l.tokens != null ? ` · ${l.tokens} tok` : ''}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
