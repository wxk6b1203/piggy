/**
 * 插件页的数据层（docs/04 §2.3，docs/03 §2.15）。
 *
 * 后端把 pi 的**四个插件来源**（见 `src-tauri/src/plugin/inventory.rs` 的模块文档）
 * 盘成一张表，这里只做两件事：
 *   1. **形状归一化**——后端返回的字段缺一个就可能让整页白屏，
 *      所以在进组件之前补默认值（docs/15 规矩 28：IPC 形状必须在边界处校验）；
 *   2. 把"用哪个字段判断"的知识收在一处，组件里不散落 `row.entries ?? []`。
 *
 * 启停/安装/升级之后**一律重新拉取**，不做前端本地合并——界面显示的必须就是
 * pi 真正读到的（与「模型」页同一条原则）。
 */
import { cmd } from '@/lib/ipc';

export type PluginScope = 'project' | 'global' | 'builtin';
export type PluginKind = 'package' | 'path' | 'discovered' | 'cli' | 'builtin';
export type SourceKind = 'npm' | 'git' | 'local' | 'discovered' | 'cli' | 'builtin';

export interface PluginRow {
  /** 稳定标识：`<scope>:<kind>:<source>`，启停/删除时回传 */
  key: string;
  name: string;
  kind: PluginKind;
  kindLabel: string;
  sourceKind: SourceKind;
  sourceKindLabel: string;
  scope: PluginScope;
  scopeLabel: string;
  source: string;
  path: string;
  exists: boolean;
  enabled: boolean;
  /** 是哪一层、哪条规则决定的状态（规矩 30：必须能说出"谁说了算"） */
  enabledBy: string;
  version: string | null;
  description: string | null;
  /** pi 实际会加载的扩展入口 */
  entries: string[];
  removable: boolean;
  updatable: boolean;
  /** pi 的加载优先级：0 项目登记 / 1 项目发现 / 2 全局登记 / 3 全局发现 / 4 包 / -1 内置 */
  loadRank: number;
}

export interface PluginGroup {
  id: PluginScope;
  label: string;
  dir: string;
  settingsPath: string | null;
  count: number;
  plugins: PluginRow[];
}

export interface PluginOverview {
  agentDir: string;
  agentDirFromEnv: boolean;
  projectDir: string | null;
  groups: PluginGroup[];
  warnings: string[];
  counts: {
    total: number;
    enabled: number;
    disabled: number;
    missing: number;
    updatable: number;
  };
}

const SCOPES: PluginScope[] = ['project', 'global', 'builtin'];
const KINDS: PluginKind[] = ['package', 'path', 'discovered', 'cli', 'builtin'];

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** 一行插件。字段缺失一律给安全默认值——半条坏数据不该让整页崩掉。 */
function normalizeRow(raw: unknown): PluginRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const key = asString(r.key);
  if (!key) return null;
  const kind = KINDS.includes(r.kind as PluginKind) ? (r.kind as PluginKind) : 'path';
  const scope = SCOPES.includes(r.scope as PluginScope) ? (r.scope as PluginScope) : 'global';
  return {
    key,
    name: asString(r.name, key),
    kind,
    kindLabel: asString(r.kindLabel, kind),
    sourceKind: (r.sourceKind as SourceKind) ?? 'local',
    sourceKindLabel: asString(r.sourceKindLabel, asString(r.sourceKind)),
    scope,
    scopeLabel: asString(r.scopeLabel, scope),
    source: asString(r.source),
    path: asString(r.path),
    exists: r.exists !== false,
    enabled: r.enabled === true,
    enabledBy: asString(r.enabledBy),
    version: typeof r.version === 'string' ? r.version : null,
    description: typeof r.description === 'string' ? r.description : null,
    entries: Array.isArray(r.entries) ? r.entries.filter((e): e is string => typeof e === 'string') : [],
    removable: r.removable === true,
    updatable: r.updatable === true,
    loadRank: typeof r.loadRank === 'number' ? r.loadRank : 99,
  };
}

export async function loadPlugins(projectDir?: string | null): Promise<PluginOverview> {
  const raw = await cmd<Record<string, unknown>>('plugin_overview', {
    projectDir: projectDir ?? null,
  });
  const groups: PluginGroup[] = (Array.isArray(raw.groups) ? raw.groups : [])
    .map((g) => {
      const gr = (g ?? {}) as Record<string, unknown>;
      const plugins = (Array.isArray(gr.plugins) ? gr.plugins : [])
        .map(normalizeRow)
        .filter((p): p is PluginRow => p !== null);
      return {
        id: (gr.id as PluginScope) ?? 'global',
        label: asString(gr.label, asString(gr.id)),
        dir: asString(gr.dir),
        settingsPath: typeof gr.settingsPath === 'string' ? gr.settingsPath : null,
        count: plugins.length,
        plugins,
      };
    })
    .filter((g) => g.plugins.length > 0 || g.id !== 'builtin');
  const c = (raw.counts ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' ? v : 0);
  return {
    agentDir: asString(raw.agentDir),
    agentDirFromEnv: raw.agentDirFromEnv === true,
    projectDir: typeof raw.projectDir === 'string' ? raw.projectDir : null,
    groups,
    warnings: Array.isArray(raw.warnings) ? raw.warnings.filter((w): w is string => typeof w === 'string') : [],
    counts: {
      total: num(c.total),
      enabled: num(c.enabled),
      disabled: num(c.disabled),
      missing: num(c.missing),
      updatable: num(c.updatable),
    },
  };
}

/* ---------------- 任务（安装 / 删除 / 升级是长任务） ---------------- */

export interface PluginJob {
  id: string;
  action: string;
  target: string;
  command: string;
  cwd: string;
  running: boolean;
  exitCode: number | null;
  lines: string[];
  truncated: boolean;
  error: string | null;
  startedMs: number;
}

export function isJobDone(job: PluginJob | null): boolean {
  return job !== null && !job.running && job.exitCode !== null;
}

export function isJobOk(job: PluginJob | null): boolean {
  return job !== null && job.exitCode === 0;
}

/** 起一个任务；返回 jobId。输出走 `plugin:log:<id>` 事件。 */
export async function runPluginAction(args: {
  action: 'install' | 'remove' | 'update';
  source?: string;
  scope?: 'global' | 'project';
  projectDir?: string | null;
}): Promise<string> {
  const r = await cmd<{ jobId: string }>('plugin_run', {
    action: args.action,
    source: args.source ?? null,
    scope: args.scope ?? 'global',
    projectDir: args.projectDir ?? null,
  });
  return r.jobId;
}

export async function loadJobs(): Promise<PluginJob[]> {
  const r = await cmd<{ jobs: PluginJob[] }>('plugin_jobs');
  return Array.isArray(r?.jobs) ? r.jobs : [];
}

export async function cancelJob(jobId: string): Promise<void> {
  await cmd('plugin_job_cancel', { jobId });
}

/** 启用/停用。返回后端**实际写下去**的 settings，界面据此回显（而不是猜）。 */
export async function setPluginEnabled(
  key: string,
  enabled: boolean,
  projectDir?: string | null,
): Promise<void> {
  await cmd('plugin_set_enabled', { key, enabled, projectDir: projectDir ?? null });
}

export async function addPluginPath(
  path: string,
  scope: 'global' | 'project',
  projectDir?: string | null,
): Promise<void> {
  await cmd('plugin_add_path', { path, scope, projectDir: projectDir ?? null });
}

export async function removePluginPath(
  entry: string,
  scope: 'global' | 'project',
  projectDir?: string | null,
): Promise<void> {
  await cmd('plugin_remove_path', { entry, scope, projectDir: projectDir ?? null });
}

/** 删除发现目录里的插件（走回收站，可撤销）。 */
export async function deleteDiscovered(key: string): Promise<void> {
  await cmd('plugin_delete_discovered', { key });
}

export interface SourceCheck {
  ok: boolean;
  problem: string | null;
  hint: string;
  sourceKind: SourceKind;
  sourceKindLabel: string;
}

/** 安装前的即时校验：说清 pi 会把它当什么（npm / git / 本地路径）。 */
export async function checkSource(source: string): Promise<SourceCheck> {
  const r = await cmd<Record<string, unknown>>('plugin_check_source', { source });
  return {
    ok: r.ok === true,
    problem: typeof r.problem === 'string' ? r.problem : null,
    hint: asString(r.hint),
    sourceKind: (r.sourceKind as SourceKind) ?? 'local',
    sourceKindLabel: asString(r.sourceKindLabel),
  };
}

export interface ProjectTrust {
  trusted: boolean;
  matched: string | null;
  dir: string;
  trustFile: string;
}

export async function projectTrust(projectDir: string): Promise<ProjectTrust> {
  const r = await cmd<Record<string, unknown>>('plugin_project_trust', { projectDir });
  return {
    trusted: r.trusted === true,
    matched: typeof r.matched === 'string' ? r.matched : null,
    dir: asString(r.dir),
    trustFile: asString(r.trustFile),
  };
}

/** 一排插件里"启用/停用"之外还能做什么（按来源区分）。 */
export function rowActions(row: PluginRow): { canToggle: boolean; canDelete: boolean; reason: string } {
  if (row.kind === 'builtin') {
    return { canToggle: false, canDelete: false, reason: 'pi 内置扩展：随 pi 发布，不能停用也不能卸载' };
  }
  if (row.kind === 'cli') {
    return { canToggle: false, canDelete: false, reason: '本次运行由命令行 -e 加载，改设置没用' };
  }
  if (!row.exists && row.kind === 'package') {
    return { canToggle: true, canDelete: true, reason: '声明了但磁盘上没有——可能装到一半失败，或安装目录被清理过' };
  }
  return { canToggle: true, canDelete: row.removable, reason: '' };
}
