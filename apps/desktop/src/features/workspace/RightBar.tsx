/**
 * 右侧栏（文件 + 统计 + 会话树）。
 *
 * 对齐 DSH（docs/12 §6）：DSH 右栏是**文档/代码预览**面板，token 用量等窗口级状态归 Composer dock，
 * 不占右栏。因此默认视图是「文件」，统计降为次级入口，避免同一份数据在两处重复呈现。
 * 图标统一用 VS Code codicons（docs/13），替换此前的 emoji。
 */
import { useEffect, useState } from 'react';
import { Tree } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { cmd } from '@/lib/ipc';
import { baseName } from '@/lib/paths';
import { windowEvents } from '@/lib/windowEvents';
import { Icon } from '@/features/common/Icon';
import { FileIcon } from '@/features/common/FileIcon';
import { toast } from '@/lib/feedback';
import { useTabs } from '@/stores/tabs';
import { openPreviewTab } from './EditorArea';
import { FleetView } from './FleetView';

type RightView = 'files' | 'stats' | 'tree' | 'fleet';

export function RightBar({ tabId }: { tabId: string | null }) {
  const [view, setView] = useState<RightView>('files');
  return (
    <div className="pg-rightbar">
      <div className="pg-rightbar-body">
        {view === 'files' && <FilesView tabId={tabId} />}
        {view === 'stats' && <StatsView tabId={tabId} />}
        {view === 'tree' && <TreeView tabId={tabId} />}
        {view === 'fleet' && <FleetView tabId={tabId} />}
      </div>
      <div className="pg-rightrail">
        <button
          className={`pg-rail-btn${view === 'files' ? ' pg-rail-active' : ''}`}
          title="文件（项目根）"
          onClick={() => setView('files')}
        >
          <Icon name="files" size={15} />
        </button>
        <button
          className={`pg-rail-btn${view === 'stats' ? ' pg-rail-active' : ''}`}
          title="统计"
          onClick={() => setView('stats')}
        >
          <Icon name="dashboard" size={15} />
        </button>
        <button
          className={`pg-rail-btn${view === 'tree' ? ' pg-rail-active' : ''}`}
          title="会话树"
          onClick={() => setView('tree')}
        >
          <Icon name="git-branch" size={15} />
        </button>
        <button
          className={`pg-rail-btn${view === 'fleet' ? ' pg-rail-active' : ''}`}
          title="Fleet（子代理）"
          onClick={() => setView('fleet')}
        >
          <Icon name="server-process" size={15} />
        </button>
      </div>
    </div>
  );
}

interface StatsData {
  tokens?: { input?: number; output?: number; total?: number; cacheRead?: number };
  cost?: number;
  contextUsage?: { tokens?: number | null; contextWindow?: number | null; percent?: number | null };
  userMessages?: number;
  assistantMessages?: number;
  toolCalls?: number;
}

function StatsView({ tabId }: { tabId: string | null }) {
  const [stats, setStats] = useState<StatsData | null>(null);
  useEffect(() => {
    if (!tabId) return;
    const refresh = () => {
      void cmd<StatsData>('pi_get_session_stats', { tabId }).then(setStats).catch(() => {});
    };
    refresh();
    return windowEvents.on('refresh-stats', (id) => {
      if (id === tabId) refresh();
    });
  }, [tabId]);

  if (!tabId) return <div className="pg-fg-dim pg-rightbar-pad">无活动会话</div>;
  const total = stats?.tokens?.total;
  const ctx = stats?.contextUsage;
  const pct = ctx?.percent;
  return (
    <div className="pg-stats">
      <Row label="总 tokens" value={total?.toLocaleString() ?? '—'} />
      <Row
        label="输入 / 输出"
        value={stats?.tokens ? `${(stats.tokens.input ?? 0).toLocaleString()} / ${(stats.tokens.output ?? 0).toLocaleString()}` : '—'}
      />
      <Row label="缓存读" value={stats?.tokens?.cacheRead?.toLocaleString() ?? '—'} />
      <Row label="成本" value={stats?.cost != null ? `$${Number(stats.cost).toFixed(4)}` : '—'} />
      <div className="pg-stat-row">
        <span className="pg-stat-label">上下文</span>
        <span className="pg-stat-value">{pct != null ? `${pct}%` : '—'}</span>
      </div>
      <div className="pg-usage-bar">
        <div
          className="pg-usage-fill"
          style={{ width: `${Math.min(100, pct ?? 0)}%` }}
          data-level={(pct ?? 0) > 85 ? 'high' : (pct ?? 0) > 60 ? 'mid' : 'low'}
        />
      </div>
      <Row label="消息" value={stats ? `${stats.userMessages ?? 0} 用户 / ${stats.assistantMessages ?? 0} 助手` : '—'} />
      <Row label="工具调用" value={stats?.toolCalls?.toLocaleString() ?? '—'} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="pg-stat-row">
      <span className="pg-stat-label">{label}</span>
      <span className="pg-stat-value">{value}</span>
    </div>
  );
}

function TreeView({ tabId }: { tabId: string | null }) {
  const [nodes, setNodes] = useState<DataNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tabId) return;
    setNodes([]);
    void cmd<{ tree?: RawTreeNode[] }>('pi_get_tree', { tabId })
      .then((r) => setNodes(toAntdTree(r.tree ?? [])))
      .catch((e) => setError(String(e)));
  }, [tabId]);

  if (!tabId) return <div className="pg-fg-dim pg-rightbar-pad">无活动会话</div>;
  if (error) return <div className="pg-fg-dim pg-rightbar-pad">树加载失败：{error}</div>;
  return (
    <div className="pg-tree">
      <Tree treeData={nodes} selectable={false} blockNode defaultExpandAll showLine />
    </div>
  );
}

/** get_tree 节点形状：{ entry, children }（id 在 entry 内，docs/02 §5.2） */
interface RawTreeNode {
  id?: string;
  entry?: { id?: string; role?: string; content?: unknown };
  children?: RawTreeNode[];
}

function textSnippet(content: unknown): string {
  if (typeof content === 'string') return content.slice(0, 40);
  if (Array.isArray(content)) {
    for (const b of content) {
      if ((b as { type?: string }).type === 'text')
        return ((b as { text?: string }).text ?? '').slice(0, 40);
    }
  }
  return '';
}

function toAntdTree(tree: RawTreeNode[]): DataNode[] {
  let count = 0;
  const convert = (n: RawTreeNode): DataNode => {
    count += 1;
    const id = n.entry?.id ?? n.id ?? `node-${count}`;
    const role = n.entry?.role;
    const snippet =
      role === 'user' || role === 'assistant' ? ` ${textSnippet(n.entry?.content)}` : '';
    const node: DataNode = {
      key: id,
      title: role ? `${role} · ${id.slice(0, 6)}${snippet}` : id.slice(0, 8),
      children: [],
    };
    if (count < 500 && Array.isArray(n.children)) {
      node.children = n.children.map(convert);
    }
    return node;
  };
  return tree.map(convert);
}

/* ---------------- 文件视图：活动 tab 项目根的只读目录树（docs/04 §1.6） ---------------- */

interface FsEntry {
  name: string;
  isDir: boolean;
  size: number;
}

/** 每个已展开目录的条目缓存：key = 绝对路径。 */
function FilesView({ tabId }: { tabId: string | null }) {
  const cwd = useTabs((s) => (tabId ? s.tabs[tabId]?.cwd : undefined));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [children, setChildren] = useState<Record<string, FsEntry[]>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setExpanded(new Set());
    setChildren({});
    setError(null);
  }, [cwd]);

  const loadDir = async (dir: string, root: string) => {
    try {
      const r = await cmd<{ entries: FsEntry[] }>('fs_list_dir', { root, path: dir });
      setChildren((prev) => ({ ...prev, [dir]: r.entries ?? [] }));
    } catch (e) {
      toast.error(String(e));
    }
  };

  // 首屏加载根目录（懒加载只针对子目录）
  useEffect(() => {
    if (cwd) void loadDir(cwd, cwd);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd]);

  const toggle = (dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else {
        next.add(dir);
        if (!children[dir] && cwd) void loadDir(dir, cwd);
      }
      return next;
    });
  };

  if (!tabId || !cwd) return <div className="pg-rightbar-pad pg-fg-dim">无活动会话</div>;
  if (error) return <div className="pg-rightbar-pad pg-fg-dim">目录读取失败：{error}</div>;

  return (
    <div className="pg-files" role="tree" aria-label="项目文件">
      <div className="pg-files-head" title={cwd}>
        <Icon name="root-folder" size={13} />
        <span className="pg-files-rootname">{baseName(cwd) || cwd}</span>
      </div>
      <DirEntries
        dir={cwd}
        depth={0}
        expanded={expanded}
        children={children}
        onToggle={toggle}
        onError={setError}
      />
    </div>
  );
}

function DirEntries({
  dir,
  depth,
  expanded,
  children,
  onToggle,
  onError,
}: {
  dir: string;
  depth: number;
  expanded: Set<string>;
  children: Record<string, FsEntry[]>;
  onToggle: (dir: string) => void;
  onError: (e: string) => void;
}) {
  const entries = children[dir];
  if (!entries) return null;
  return (
    <>
      {entries.map((e) => {
        const full = `${dir}/${e.name}`;
        const isOpen = expanded.has(full);
        return (
          <div key={full}>
            <button
              className="pg-files-row"
              style={{ paddingLeft: 8 + depth * 12 }}
              role="treeitem"
              aria-expanded={e.isDir ? isOpen : undefined}
              title={full}
              onClick={() => {
                if (e.isDir) onToggle(full);
                else openPreviewTab(full, full, e.name, dir);
              }}
            >
              <FileIcon name={e.name} isDir={e.isDir} open={isOpen} size={14} />
              <span className="pg-files-name">{e.name}</span>
            </button>
            {e.isDir && isOpen && (
              <DirEntries
                dir={full}
                depth={depth + 1}
                expanded={expanded}
                children={children}
                onToggle={onToggle}
                onError={onError}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
