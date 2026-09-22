/** 轨迹视图（WP7，docs/04 §1.10，参考 docs/11 dsh_3）：过滤 + 搜索 + 角色芯片 */
import { useEffect, useMemo, useState } from 'react';
import { useTrajectory, type TrajKind, type TrajRow } from '@/stores/trajectory';

const FILTERS: Array<{ key: TrajKind | 'all'; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'user', label: '用户' },
  { key: 'assistant', label: '助手' },
  { key: 'tool', label: '工具' },
  { key: 'system', label: '系统' },
  { key: 'context_edit', label: '上下文' },
  { key: 'compaction', label: '压缩' },
];

const KIND_CLASS: Partial<Record<TrajKind, string>> = {
  user: 'pg-traj-user',
  assistant: 'pg-traj-assistant',
  tool: 'pg-traj-tool',
  system: 'pg-traj-system',
  context_edit: 'pg-traj-ctx',
  compaction: 'pg-traj-compact',
  label: 'pg-traj-label',
};

export function TrajectoryView({ tabId }: { tabId: string }) {
  const rows = useTrajectory((s) => s.rows[tabId]);
  const loaded = useTrajectory((s) => s.loaded[tabId] ?? false);
  const load = useTrajectory((s) => s.load);
  const [filter, setFilter] = useState<TrajKind | 'all'>('all');
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!loaded) void load(tabId);
  }, [tabId, loaded, load]);

  const filtered = useMemo(() => {
    let list = rows ?? [];
    if (filter !== 'all') list = list.filter((r) => r.kind === filter);
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((r) => r.text.toLowerCase().includes(q));
    return list;
  }, [rows, filter, query]);

  return (
    <div className="pg-traj">
      <div className="pg-traj-toolbar">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`pg-btn pg-traj-filter${filter === f.key ? ' pg-btn-primary' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
        <input
          className="pg-traj-search"
          placeholder="搜索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="pg-traj-list">
        {filtered.map((r) => (
          <Row key={r.id} row={r} />
        ))}
        {filtered.length === 0 && <div className="pg-fg-dim pg-traj-empty">无匹配条目</div>}
      </div>
    </div>
  );
}

function Row({ row }: { row: TrajRow }) {
  const label =
    row.kind === 'tool'
      ? '工具'
      : row.kind === 'user'
        ? '用户'
        : row.kind === 'assistant'
          ? '助手'
          : row.kind === 'system'
            ? '系统'
            : row.kind === 'context_edit'
              ? '上下文'
              : row.kind === 'compaction'
                ? '压缩'
                : '•';
  return (
    <div className={`pg-traj-row ${KIND_CLASS[row.kind] ?? ''}`}>
      <span className={`pg-traj-chip pg-chip-${row.kind}`}>{label}</span>
      <span className="pg-traj-text" title={row.detail ?? row.text}>
        {row.text || '(空)'}
        {row.running ? ' …' : ''}
      </span>
      {row.ts ? (
        <span className="pg-traj-time">{new Date(row.ts).toLocaleTimeString()}</span>
      ) : null}
    </div>
  );
}
