/**
 * Fleet 视图（docs/06 §5）：A 层宿主编排 runs + B 层 piggy-bridge 会话内子代理。
 *
 * 说明：此视图在 2026-09-23 的一次批量改写事故中随 `RightBar.tsx` 一起丢失（见 docs/14 §0.1），
 * 本轮按 `stores/fleet.ts` 的现存接口重建。store 与测试当时均未受损，故行为以它们为准。
 * 2026-09-23 晚补：docs/09 §5.1 声称的 steer/提升为标签页/刷新当时并未真正落地，
 * 现补齐并加测试——**文档说"✅"不等于代码里有**。
 */
import { useEffect, useMemo, useState } from 'react';
import { cmd } from '@/lib/ipc';
import { toast } from '@/lib/feedback';
import { t } from '@/lib/i18n';
import { useFleet, type FleetRun } from '@/stores/fleet';
import { useTabs, type TabSnapshot } from '@/stores/tabs';
import { openSessionTab } from '@/features/workspace/EditorArea';
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
  const [steerDraft, setSteerDraft] = useState<Record<string, string>>({});
  const [steering, setSteering] = useState<string | null>(null);

  useEffect(() => {
    void cmd<Record<string, { label: string }>>('fleet_templates', {})
      .then((tpl) => {
        setTemplates(tpl ?? {});
        const first = Object.keys(tpl ?? {})[0];
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

  /** lane 追加指令（06 §3.3 steer）：worker 在跑就 steer，跑完就当普通补发。 */
  const steer = async (runId: string, laneKey: string) => {
    const key = `${runId}/${laneKey}`;
    const message = (steerDraft[key] ?? '').trim();
    if (!message) return;
    setSteering(key);
    try {
      const streamed = await cmd<boolean>('fleet_steer', { runId, laneKey, message });
      setSteerDraft((s) => ({ ...s, [key]: '' }));
      toast.success(streamed ? '已转向运行中的 lane' : 'lane 已空闲，指令已补发');
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSteering(null);
    }
  };

  /** lane 提升为标签页（06 §3.5）：拿 snapshot 挂进 dockview，看完整转录。 */
  const promote = async (runId: string, laneKey: string, label: string) => {
    try {
      const snap = await cmd<TabSnapshot>('fleet_open_lane', { runId, laneKey });
      await openSessionTab({ ...snap, session_name: snap.session_name ?? label }, label);
    } catch (e) {
      toast.error(String(e));
    }
  };

  /** B 层刷新：向活动会话发 `/piggy:status`，bridge 用 PIGGY:1 载荷回传（06 §4.2）。 */
  const refreshBridge = async () => {
    if (!tabId) return;
    const key = `${tabId}`;
    setSteering(key);
    try {
      await cmd('pi_prompt', { tabId, message: '/piggy:status' });
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSteering(null);
    }
  };

  const list: FleetRun[] = order.map((id) => runs[id]).filter(Boolean) as FleetRun[];
  const visible = tabId ? (bridge.byTab[tabId]?.lanes ?? []) : [];
  const fetchedAt = tabId ? bridge.byTab[tabId]?.fetchedAt : undefined;
  const syncedLabel = useMemo(() => {
    if (!fetchedAt) return t('fleet.notSynced');
    const secs = Math.max(0, Math.round((Date.now() - fetchedAt) / 1000));
    return secs < 5 ? '刚刚同步' : `${secs}s 前同步`;
  }, [fetchedAt]);

  return (
    <div className="pg-fleet">
      <section className="pg-fleet-section">
        <div className="pg-fleet-title">{t('fleet.start')}</div>
        <div className="pg-fleet-start">
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            {Object.keys(templates).length === 0 && <option value="">（无可用模板）</option>}
            {Object.entries(templates).map(([id, tpl]) => (
              <option key={id} value={id}>
                {tpl.label ?? id}
              </option>
            ))}
          </select>
          <textarea
            className="pg-fleet-task"
            placeholder={t('fleet.taskPlaceholder')}
            rows={2}
            value={task}
            onChange={(e) => setTask(e.target.value)}
          />
          <button
            className="pg-fleet-go"
            disabled={busy || !task.trim() || !templateId || !cwd}
            onClick={() => void start()}
          >
            <Icon name="play" size={13} /> {t('fleet.start')}
          </button>
        </div>
      </section>

      <section className="pg-fleet-section">
        <div className="pg-fleet-title">
          {t('fleet.hostRuns')}（{list.length}）
        </div>
        {list.length === 0 && <div className="pg-fleet-empty pg-fg-dim">{t('fleet.none')}</div>}
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
            {r.lanes.map((l) => {
              const key = `${r.id}/${l.key}`;
              const label = `${l.role} · ${r.task.slice(0, 24)}`;
              return (
                <div key={l.key} className="pg-fleet-lane-block">
                  <div className="pg-fleet-lane">
                    <span className={`pg-fleet-dot pg-lane-${l.status}`} />
                    <span className="pg-fleet-lane-role">{l.role}</span>
                    <span className="pg-fleet-lane-status">{STATUS_LABEL[l.status] ?? l.status}</span>
                    {l.resultPreview ? (
                      <span className="pg-fleet-lane-result" title={l.resultPreview}>
                        {l.resultPreview}
                      </span>
                    ) : null}
                    {l.tabId && (
                      <button
                        className="pg-fleet-lane-open"
                        title="提升为标签页（查看完整转录）"
                        onClick={() => void promote(r.id, l.key, label)}
                      >
                        <Icon name="link-external" size={12} />
                      </button>
                    )}
                  </div>
                  {l.status !== 'settled' && l.status !== 'failed' && (
                    <div className="pg-fleet-steer">
                      <input
                        value={steerDraft[key] ?? ''}
                        placeholder="给这条 lane 追加指令…"
                        onChange={(e) => setSteerDraft((s) => ({ ...s, [key]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            void steer(r.id, l.key);
                          }
                        }}
                      />
                      <button
                        disabled={steering === key || !(steerDraft[key] ?? '').trim()}
                        onClick={() => void steer(r.id, l.key)}
                      >
                        发送
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </section>

      <section className="pg-fleet-section">
        <div className="pg-fleet-title">
          {t('fleet.inSession')}
          <button
            className="pg-fleet-refresh"
            title={t('fleet.refresh')}
            disabled={!tabId || steering === tabId}
            onClick={() => void refreshBridge()}
          >
            <Icon name="refresh" size={12} />
          </button>
          <span className="pg-fleet-synced pg-fg-dim">
            {bridge.installed === false ? t('fleet.notInstalled') : ` · ${syncedLabel}`}
          </span>
        </div>
        {bridge.installed === false && <div className="pg-fleet-empty pg-fg-dim">{t('fleet.notInstalled')}</div>}
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
              {l.cost != null ? ` · $${l.cost.toFixed(4)}` : ''}
            </span>
          </div>
        ))}
      </section>
    </div>
  );
}
