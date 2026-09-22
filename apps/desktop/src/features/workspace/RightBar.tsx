/** 右侧栏（M1 基础视图：统计 + 会话树；文件/变更/子代理 = M2） */
import { useEffect, useState } from 'react';
import { Tree } from 'antd';
import type { DataNode } from 'antd/es/tree';
import { cmd } from '@/lib/ipc';
import { windowEvents } from '@/lib/windowEvents';

type RightView = 'stats' | 'tree';

export function RightBar({ tabId }: { tabId: string | null }) {
  const [view, setView] = useState<RightView>('stats');
  return (
    <div className="pg-rightbar">
      <div className="pg-rightbar-body">
        {view === 'stats' ? <StatsView tabId={tabId} /> : <TreeView tabId={tabId} />}
      </div>
      <div className="pg-rightrail">
        <button
          className={`pg-rail-btn${view === 'stats' ? ' pg-rail-active' : ''}`}
          title="统计"
          onClick={() => setView('stats')}
        >
          📊
        </button>
        <button
          className={`pg-rail-btn${view === 'tree' ? ' pg-rail-active' : ''}`}
          title="会话树"
          onClick={() => setView('tree')}
        >
          🌿
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
      <div className="pg-ctx-meter">
        <div
          className="pg-ctx-fill"
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

interface TreeNode {
  id: string;
  parentId?: string | null;
  entry?: { role?: string; content?: unknown };
}

function TreeView({ tabId }: { tabId: string | null }) {
  const [nodes, setNodes] = useState<DataNode[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!tabId) return;
    setNodes([]);
    void cmd<{ tree?: TreeNode[] }>('pi_get_tree', { tabId })
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

function toAntdTree(tree: TreeNode[]): DataNode[] {
  let count = 0;
  const walk = (n: TreeNode): DataNode => {
    count += 1;
    const role = n.entry?.role ?? n.id.slice(0, 6);
    const label = n.entry ? `${role}` : n.id.slice(0, 8);
    return {
      key: n.id,
      title: `${label} · ${n.id.slice(0, 6)}`,
      children: [],
    };
  };
  // get_tree 是嵌套 {entry, children}；这里保守渲染（≤500 节点）
  const convert = (n: { id: string; entry?: { role?: string }; children?: unknown[] }): DataNode => {
    count += 1;
    const role = n.entry?.role;
    const node: DataNode = {
      key: n.id,
      title: role ? `${role} · ${n.id.slice(0, 6)}` : n.id.slice(0, 8),
      children: [],
    };
    if (count < 500 && Array.isArray(n.children)) {
      node.children = (n.children as never[]).map(convert);
    }
    return node;
  };
  void walk;
  return tree.map((n) => convert(n as never));
}
