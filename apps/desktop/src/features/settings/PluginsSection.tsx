/**
 * 「插件」配置页（docs/04 §2.3，docs/03 §2.15）。
 *
 * 版式对齐 DSH 的插件页（`client/ui-plugin-manager`）：**分组 + 卡片行**——
 * 每组一个标题与计数，行内左侧身份（类型徽标 + 名字 + 来源），右侧开关；
 * 点名字展开详情（路径 / 入口 / **状态是谁定的**）。
 *
 * 与 DSH 的三处**有意不同**（都写在 docs/04 §2.3）：
 *   1. **按作用域分组**（本项目 / 全局 / pi 内置）而不是 DSH 的"官方 / 已安装"。
 *      pi 的插件没有"官方"这一层，真正决定行为的是**哪份 settings.json**；
 *      而 pi 的加载优先级（`package-manager.ts:176-192`）就是按这个排的，
 *      分组与优先级一致，用户看到的顺序就是 pi 加载的顺序。
 *   2. **每一行都显示"状态是谁定的"**（`enabledBy`）。pi 的启用/停用是通配符
 *      表达的不是布尔开关，不说清哪一层哪条规则，用户看到开关就会以为是它说了算。
 *   3. **不提供"打开 pi config TUI"**。DSH 有 HMR 可以热应用；pi 只有交互式 TUI 的
 *      `/reload`，RPC 没有对应命令，所以在 Piggy 里改完必须**新开会话**才生效——
 *      这一点在页头明说，而不是让用户改完一脸疑惑。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Modal, Switch, Tooltip } from 'antd';
import { toast } from '@/lib/feedback';
import { on } from '@/lib/ipc';
import { cmd } from '@/lib/ipc';
import { openPath } from '@/lib/openInApp';
import {
  cancelJob,
  deleteDiscovered,
  isJobDone,
  isJobOk,
  loadJobs,
  loadPlugins,
  rowActions,
  runPluginAction,
  setPluginEnabled,
  type PluginJob,
  type PluginOverview,
  type PluginRow,
} from '@/lib/plugins';
import { InstallPluginDialog } from './InstallPluginDialog';

/** 类型徽标：四种来源各一个颜色，扫一眼就能分清"这是装的包还是扔在目录里的文件"。 */
function KindBadge({ row }: { row: PluginRow }) {
  return (
    <span className={`pg-plugin-kind is-${row.kind}`} title={`${row.kindLabel}（${row.sourceKindLabel}）`}>
      {row.kindLabel}
    </span>
  );
}

/** 任务日志：安装/升级是分钟级的 npm/git 操作，失败原因只在原始输出里。 */
function JobPanel({ job, onCancel, onClose }: { job: PluginJob; onCancel: () => void; onClose: () => void }) {
  const done = isJobDone(job);
  const ok = isJobOk(job);
  const tail = job.lines.slice(-12);
  return (
    <div className="pg-plugin-job" role="status" aria-live="polite">
      <div className="pg-plugin-job-head">
        <span className="pg-plugin-job-title">
          {job.running ? '正在执行…' : ok ? '已完成' : '失败'}
          <span className="pg-plugin-job-target"> {job.target}</span>
        </span>
        <span className="pg-plugin-job-actions">
          {job.running ? (
            <Button size="small" onClick={onCancel}>
              取消
            </Button>
          ) : (
            <Button size="small" onClick={onClose}>
              关闭
            </Button>
          )}
        </span>
      </div>
      <div className="pg-plugin-job-cmd" title={job.command}>
        <code>{job.command}</code>
        <span className="pg-plugin-job-cwd">{job.cwd}</span>
      </div>
      <pre className="pg-plugin-job-log">
        {job.truncated ? '…（较早的输出已省略）\n' : ''}
        {tail.length === 0 ? '（还没有输出）' : tail.join('\n')}
      </pre>
      {done && !ok && (
        <p className="pg-plugin-job-fail">
          {job.error ?? `pi 以退出码 ${job.exitCode} 结束`}——上面的原始输出里有原因。
          网络、权限、依赖冲突都只在这里能看出来。
        </p>
      )}
    </div>
  );
}

export function PluginsSection() {
  const [data, setData] = useState<PluginOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [openKeys, setOpenKeys] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [installOpen, setInstallOpen] = useState(false);
  const [jobs, setJobs] = useState<PluginJob[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PluginRow | null>(null);
  const [trust, setTrust] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await loadPlugins();
      setData(next);
      setLoadError(null);
      return next;
    } catch (e) {
      setLoadError(String(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void load();
    void loadJobs().then(setJobs).catch(() => {});
  }, [load]);

  // 作用域里有本项目时才检查信任：未信任 = pi 会整份忽略 .pi/settings.json，
  // 项目里的插件一个都不加载。这是"列出来了却没生效"的最常见原因。
  useEffect(() => {
    const dir = data?.projectDir;
    if (!dir) {
      setTrust(null);
      return;
    }
    void cmd<{ trusted: boolean }>('plugin_project_trust', { projectDir: dir })
      .then((r) => setTrust(r.trusted))
      .catch(() => setTrust(null));
  }, [data?.projectDir]);

  // 任务输出：按行推过来，追加到同一个 job 上。
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    const unlisten: (() => void)[] = [];
    void (async () => {
      const offLog = await on<{ id: string; line: string }>(`plugin:log:${jobId}`, (p) => {
        if (!alive) return;
        setJobs((prev) =>
          prev.map((j) => (j.id === p.id ? { ...j, lines: [...j.lines, p.line] } : j)),
        );
      });
      const offDone = await on<{ id: string; exitCode: number | null; error: string | null; ok: boolean }>(
        `plugin:done:${jobId}`,
        (p) => {
          if (!alive) return;
          setJobs((prev) =>
            prev.map((j) =>
              j.id === p.id ? { ...j, running: false, exitCode: p.exitCode, error: p.error } : j,
            ),
          );
          // 装完/删完/升级完都要重拉：界面显示的必须就是 pi 真正读到的
          void load();
          if (p.ok) toast.success('完成');
        },
      );
      unlisten.push(offLog, offDone);
    })();
    return () => {
      alive = false;
      unlisten.forEach((f) => f());
    };
  }, [jobId, load]);

  const currentJob = useMemo(() => jobs.find((j) => j.id === jobId) ?? null, [jobs, jobId]);

  const toggle = async (row: PluginRow, enabled: boolean) => {
    if (busyKey) return;
    setBusyKey(row.key);
    try {
      await setPluginEnabled(row.key, enabled, data?.projectDir ?? null);
      await load();
      toast.success(enabled ? `已启用 ${row.name}` : `已停用 ${row.name}`);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const update = async (row: PluginRow) => {
    try {
      const id = await runPluginAction({
        action: 'update',
        source: row.source,
        scope: row.scope === 'project' ? 'project' : 'global',
        projectDir: data?.projectDir ?? null,
      });
      const fresh = await loadJobs();
      setJobs(fresh);
      setJobId(id);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const remove = async (row: PluginRow) => {
    setConfirm(null);
    try {
      if (row.kind === 'discovered') {
        // 发现目录里的插件 pi 没有卸载命令，只能删文件（走回收站）
        await deleteDiscovered(row.key);
        await load();
        toast.success(`已把 ${row.name} 移到回收站`);
        return;
      }
      const id = await runPluginAction({
        action: 'remove',
        source: row.source,
        scope: row.scope === 'project' ? 'project' : 'global',
        projectDir: data?.projectDir ?? null,
      });
      const fresh = await loadJobs();
      setJobs(fresh);
      setJobId(id);
    } catch (e) {
      toast.error(String(e));
    }
  };

  const startJob = async (fn: () => Promise<string>) => {
    try {
      const id = await fn();
      setJobs(await loadJobs());
      setJobId(id);
    } catch (e) {
      toast.error(String(e));
      throw e;
    }
  };

  if (loadError) {
    return (
      <section className="pg-plugin">
        <p className="pg-plugin-error" role="alert">
          读不出插件列表：{loadError}
        </p>
        <Button onClick={() => void load()}>重试</Button>
      </section>
    );
  }
  if (!data) {
    return <p className="pg-plugin-loading">正在读取插件…</p>;
  }

  const { counts } = data;

  return (
    <section className="pg-plugin">
      <header className="pg-plugin-head">
        <div>
          <h2 className="pg-plugin-title">插件</h2>
          <p className="pg-plugin-intro">
            安装、删除、升级、启停 pi 的扩展。共 {counts.total} 个，
            已启用 {counts.enabled} 个
            {counts.disabled > 0 && `，已停用 ${counts.disabled} 个`}
            {counts.missing > 0 && `，${counts.missing} 个找不到文件`}。
          </p>
        </div>
        <div className="pg-plugin-head-actions">
          <Button onClick={() => void load()}>刷新</Button>
          <Button type="primary" onClick={() => setInstallOpen(true)}>
            添加插件
          </Button>
        </div>
      </header>

      {/* 生效时机：pi 没有 RPC 的 reload，改完只有新会话才看得见 */}
      <p className="pg-plugin-note">
        改动对新开的会话生效——已经在跑的会话还持有旧的插件列表（pi 的 <code>/reload</code>{' '}
        只在交互式终端里有效，RPC 没有对应命令）。
      </p>

      {data.agentDirFromEnv && (
        <p className="pg-plugin-warn">
          pi 的配置目录被环境变量 <code>PI_CODING_AGENT_DIR</code> 指到了{' '}
          <code>{data.agentDir}</code>，这里管的就是那个目录。
        </p>
      )}

      {data.projectDir && trust === false && (
        <p className="pg-plugin-warn">
          本项目 <code>{(data.projectDir ?? '') + '/.pi'}</code> 还没被 pi 信任，
          pi 会**整份忽略**项目里的 .pi/settings.json——下面「本项目」组的插件一个都不会加载。
          在终端里跑一次 <code>pi</code> 并同意信任，或用 <code>pi -a</code> 启动即可。
        </p>
      )}

      {data.warnings.map((w) => (
        <p className="pg-plugin-warn" key={w}>
          {w}
        </p>
      ))}

      {currentJob && (
        <JobPanel
          job={currentJob}
          onCancel={() => void cancelJob(currentJob.id)}
          onClose={() => setJobId(null)}
        />
      )}

      {data.groups.map((g) => (
        <section className="pg-plugin-group" key={g.id} data-plugin-group={g.id}>
          <div className="pg-plugin-group-head">
            <h3 className="pg-plugin-group-title">{g.label}</h3>
            <span className="pg-plugin-group-count" data-plugin-count={g.plugins.length}>
              {g.plugins.length}
            </span>
            {g.settingsPath && (
              <span className="pg-plugin-group-dir" title={g.settingsPath}>
                {g.settingsPath}
              </span>
            )}
          </div>
          {g.plugins.length === 0 ? (
            <p className="pg-plugin-empty">这个作用域里还没有插件。</p>
          ) : (
            <ul className="pg-plugin-rows">
              {g.plugins.map((row) => {
                const acts = rowActions(row);
                const open = openKeys.has(row.key);
                return (
                  <li
                    className={`pg-plugin-row${row.enabled ? '' : ' is-off'}${row.exists ? '' : ' is-missing'}`}
                    key={row.key}
                    data-plugin-key={row.key}
                    data-plugin-enabled={row.enabled ? '1' : '0'}
                  >
                    <div className="pg-plugin-rowline">
                      <KindBadge row={row} />
                      <div className="pg-plugin-main">
                        <div className="pg-plugin-titleline">
                          <button
                            type="button"
                            className="pg-plugin-name"
                            aria-expanded={open}
                            onClick={() =>
                              setOpenKeys((prev) => {
                                const next = new Set(prev);
                                if (next.has(row.key)) next.delete(row.key);
                                else next.add(row.key);
                                return next;
                              })
                            }
                          >
                            {row.name}
                          </button>
                          {row.version && <span className="pg-plugin-tag">v{row.version}</span>}
                          {!row.exists && <span className="pg-plugin-tag is-danger">找不到文件</span>}
                        </div>
                        <span className="pg-plugin-source" title={row.source}>
                          {row.source}
                        </span>
                      </div>
                      <div className="pg-plugin-end">
                        {row.updatable && (
                          <Button size="small" onClick={() => void update(row)}>
                            升级
                          </Button>
                        )}
                        {acts.canDelete && (
                          <Button size="small" danger onClick={() => setConfirm(row)}>
                            删除
                          </Button>
                        )}
                        <Tooltip title={acts.canToggle ? (row.enabled ? '停用' : '启用') : acts.reason}>
                          <span className="pg-plugin-switch">
                            <Switch
                              size="small"
                              checked={row.enabled}
                              disabled={!acts.canToggle || busyKey === row.key}
                              aria-label={`${row.enabled ? '停用' : '启用'} ${row.name}`}
                              onChange={(v) => void toggle(row, v)}
                            />
                          </span>
                        </Tooltip>
                      </div>
                    </div>
                    {open && (
                      <dl className="pg-plugin-detail">
                        <dt>状态由谁决定</dt>
                        <dd data-plugin-enabled-by>{row.enabledBy}</dd>
                        <dt>加载优先级</dt>
                        <dd>
                          第 {row.loadRank} 档
                          {row.loadRank === 4 && '（包在最后：同路径被更靠前的来源覆盖）'}
                          {row.loadRank === -1 && '（内置，最先）'}
                        </dd>
                        <dt>磁盘位置</dt>
                        <dd className="pg-plugin-path">
                          <code>{row.path}</code>
                          {row.exists && (
                            <Button
                              size="small"
                              type="link"
                              onClick={() => void openPath(row.path, 'reveal').catch((e) => toast.error(String(e)))}
                            >
                              在文件管理器里显示
                            </Button>
                          )}
                        </dd>
                        <dt>pi 会加载</dt>
                        <dd>
                          {row.entries.length === 0 ? (
                            <span className="pg-plugin-dim">
                              {row.kind === 'builtin' ? '随 pi 进程加载' : '没有可加载的入口（pi 会跳过它）'}
                            </span>
                          ) : (
                            <ul className="pg-plugin-entries">
                              {row.entries.map((e) => (
                                <li key={e}>
                                  <code>{e}</code>
                                </li>
                              ))}
                            </ul>
                          )}
                        </dd>
                        {row.description && (
                          <>
                            <dt>说明</dt>
                            <dd>{row.description}</dd>
                          </>
                        )}
                      </dl>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      ))}

      {counts.total === 0 && <p className="pg-plugin-empty">还没有装任何插件。</p>}

      <InstallPluginDialog
        open={installOpen}
        hasProject={!!data.projectDir}
        onClose={() => setInstallOpen(false)}
        onSubmit={async (source, scope) => {
          setInstallOpen(false);
          await startJob(() =>
            runPluginAction({ action: 'install', source, scope, projectDir: data.projectDir }),
          );
        }}
      />

      <Modal
        open={confirm !== null}
        title={`删除「${confirm?.name ?? ''}」？`}
        okText="删除"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        onCancel={() => setConfirm(null)}
        onOk={() => confirm && void remove(confirm)}
      >
        {confirm?.kind === 'discovered' ? (
          <p>它会被移到回收站（可以再拖回来）。pi 对发现目录里的扩展没有卸载命令，删文件是唯一方式。</p>
        ) : (
          <p>
            会执行 <code>pi remove {confirm?.source}</code>：删掉安装目录**并且**从 settings.json
            里移除这条声明。装到一半失败留下的文件不会被清理。
          </p>
        )}
      </Modal>
    </section>
  );
}
