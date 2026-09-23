/**
 * 轨迹视图（docs/12 §4 —— 按 DSH 源码规格重写，替换基于截图推断的旧版）。
 *
 * 关键更正（docs/12 附录 B C2/C3）：
 *  - **没有角色过滤器**。工具栏只有「时长」开关 + 「轮次」「调用」两个折叠开关 + 搜索框；
 *    唯一的过滤是文本搜索（空白切词 AND、大小写不敏感子串，未命中行直接不渲染）。
 *  - kind 枚举只有 7 种：系统 / 用户 / 上下文 / 助手 / 工具 / 子工具 / 已压缩。
 *    旧版的 `label`（分支标记）**在 DSH 中不存在**；pi 确实会发 session_info/label 事件，
 *    这里保留为「标记」芯片并明确标注为 Piggy 扩展，避免静默丢数据。
 *  - 工具行是 `name payload → result` 的两列网格，不是 `args → result` 单行文本。
 *
 * 芯片几何照抄 `.kindTag`：19px 高 / padding 0 5px / r4 / 10px 字号 / weight 650 / letter-spacing .035em。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTrajectory, type TrajKind, type TrajRow } from '@/stores/trajectory';
import { Icon, type IconName } from '@/features/common/Icon';
import { TrajectoryTimeline } from './TrajectoryTimeline';

/** Piggy 内部 kind → DSH 账本 kind（7 种）+ Piggy 扩展。 */
type LedgerKind = 'system' | 'user' | 'context' | 'message' | 'tool' | 'subtool' | 'compacted' | 'mark';

const KIND_OF: Record<TrajKind, LedgerKind> = {
  user: 'user',
  assistant: 'message',
  tool: 'tool',
  system: 'system',
  context_edit: 'context',
  compaction: 'compacted',
  label: 'mark',
  other: 'mark',
};

/** DSH `KIND_LABEL_KEY`（中文标签；英文侧是全大写，Piggy 只用中文界面）。 */
const KIND_LABEL: Record<LedgerKind, string> = {
  system: '系统',
  user: '用户',
  context: '上下文',
  message: '助手',
  tool: '工具',
  subtool: '子工具',
  compacted: '已压缩',
  mark: '标记',
};

/** DSH `KIND_ICON`：system→settings、user→user、context→information、compacted→compact、
 *  message→sparkle、tool/subtool→wrench。codicons 侧用等价字形。 */
const KIND_ICON: Record<LedgerKind, IconName> = {
  system: 'settings-gear',
  user: 'account',
  context: 'info',
  message: 'sparkle',
  tool: 'tools',
  subtool: 'tools',
  compacted: 'archive',
  mark: 'bookmark',
};

export function TrajectoryView({ tabId }: { tabId: string }) {
  const rows = useTrajectory((s) => s.rows[tabId]);
  const loaded = useTrajectory((s) => s.loaded[tabId] ?? false);
  const load = useTrajectory((s) => s.load);
  const [query, setQuery] = useState('');
  const [collapsedTurns, setCollapsedTurns] = useState<ReadonlySet<number>>(new Set());
  const [collapsedAssistants, setCollapsedAssistants] = useState<ReadonlySet<string>>(new Set());
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!loaded) void load(tabId);
  }, [tabId, loaded, load]);

  /** 轮次 = 从每条 user 行开始（DSH 的 turn 概念）。 */
  const turns = useMemo(() => {
    const list: Array<{ turn: number; rows: TrajRow[] }> = [];
    for (const r of rows ?? []) {
      if (r.kind === 'user' || list.length === 0) {
        list.push({ turn: list.length + 1, rows: [r] });
      } else {
        list[list.length - 1]!.rows.push(r);
      }
    }
    return list;
  }, [rows]);

  /** DSH 搜索：空白切词 AND + 大小写不敏感子串；未命中直接不渲染。 */
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (r: TrajRow) => {
    if (terms.length === 0) return true;
    const hay = `${KIND_LABEL[KIND_OF[r.kind]]} ${r.text} ${r.detail ?? ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  };

  const visibleTurns = useMemo(
    () =>
      turns
        .map((t) => ({ ...t, rows: t.rows.filter(matches) }))
        .filter((t) => t.rows.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [turns, query],
  );

  const allTurnsCollapsed = collapsedTurns.size > 0 && collapsedTurns.size >= visibleTurns.length;
  const allAssistantsCollapsed = collapsedAssistants.size > 0;

  const toggleAllTurns = () =>
    setCollapsedTurns(allTurnsCollapsed ? new Set() : new Set(visibleTurns.map((t) => t.turn)));
  const toggleAllAssistants = () =>
    setCollapsedAssistants(
      allAssistantsCollapsed ? new Set() : new Set((rows ?? []).filter((r) => r.kind === 'assistant').map((r) => r.id)),
    );

  // 时间线用的"行序"必须与渲染顺序一致：轮次头是 rows[0]，其后是 rows[1..]
  const flatRows = useMemo(() => visibleTurns.flatMap((t) => t.rows), [visibleTurns]);
  const flatIndexOf = useMemo(() => {
    const m = new Map<string, number>();
    flatRows.forEach((r, i) => m.set(r.id, i));
    return m;
  }, [flatRows]);

  let turnNo = 0;
  return (
    <div className="pg-traj">
      {/* DSH `TrajectoryToolbar`：32px，4 个控件，无角色过滤器 */}
      <div className="pg-traj-toolbar" role="toolbar" aria-label="轨迹工具栏">
        <div className="pg-traj-actions">
          <button
            className="pg-traj-action"
            aria-pressed={collapsedTurns.size > 0}
            title={allTurnsCollapsed ? '展开所有轮次' : '收起所有轮次'}
            onClick={toggleAllTurns}
          >
            <span className="pg-traj-glyph">{allTurnsCollapsed ? '⊞' : '⊟'}</span> 轮次
          </button>
          <button
            className="pg-traj-action"
            aria-pressed={allAssistantsCollapsed}
            title={allAssistantsCollapsed ? '展开所有调用' : '收起所有调用'}
            onClick={toggleAllAssistants}
          >
            <span className="pg-traj-glyph">{allAssistantsCollapsed ? '⊞' : '⊟'}</span> 调用
          </button>
        </div>
        <div className="pg-traj-searchbox">
          <Icon name="search" size={11} />
          <input
            className="pg-traj-search-input"
            type="search"
            placeholder="搜索"
            aria-label="搜索轨迹"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <TrajectoryTimeline rows={flatRows} selectedIndex={selectedIndex} onSelect={setSelectedIndex} />

      <div className="pg-traj-table">
        {visibleTurns.map((t) => {
          turnNo += 1;
          const collapsed = collapsedTurns.has(t.turn);
          const first = t.rows[0]!;
          return (
            <div key={t.turn} className="pg-traj-turn">
              <div className="pg-traj-turnhead">
                <span className="pg-traj-rail" aria-hidden="true" />
                <button
                  className="pg-traj-turnlabel"
                  title={collapsed ? '展开本轮' : '收起本轮'}
                  onClick={() =>
                    setCollapsedTurns((prev) => {
                      const next = new Set(prev);
                      if (next.has(t.turn)) next.delete(t.turn);
                      else next.add(t.turn);
                      return next;
                    })
                  }
                >
                  <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={12} />#{turnNo}
                </button>
                <KindTag kind={KIND_OF[first.kind]} />
                <span className="pg-traj-preview" title={first.text}>
                  {first.text}
                </span>
              </div>
              {!collapsed &&
                t.rows.slice(1).map((r) => (
                  <Row
                    key={r.id}
                    row={r}
                    selected={selectedIndex !== null && flatIndexOf.get(r.id) === selectedIndex}
                    collapsedAssistants={collapsedAssistants}
                    onToggleAssistant={setCollapsedAssistants}
                  />
                ))}
            </div>
          );
        })}
        {visibleTurns.length === 0 && (
          <div className="pg-traj-empty">
            {loaded ? (terms.length ? '无匹配条目' : '暂无轨迹') : '加载中…'}
          </div>
        )}
      </div>
    </div>
  );
}

function Row({
  row,
  selected,
  collapsedAssistants,
  onToggleAssistant,
}: {
  row: TrajRow;
  selected?: boolean;
  collapsedAssistants: ReadonlySet<string>;
  onToggleAssistant: (fn: (prev: ReadonlySet<string>) => ReadonlySet<string>) => void;
}) {
  const kind = KIND_OF[row.kind];
  const isAssistant = row.kind === 'assistant';
  const collapsed = isAssistant && collapsedAssistants.has(row.id);
  const isTool = kind === 'tool' || kind === 'subtool';

  return (
    <div className="pg-traj-row" data-kind={kind} data-selected={selected || undefined}>
      <span className="pg-traj-kinds">
        <KindTag kind={kind} />
      </span>
      <span className={`pg-traj-content${isTool ? ' pg-traj-mono' : ''}`}>
        {isAssistant && row.expandable ? (
          <button
            className="pg-traj-foldbtn"
            aria-expanded={!collapsed}
            onClick={() =>
              onToggleAssistant((prev) => {
                const next = new Set(prev);
                if (next.has(row.id)) next.delete(row.id);
                else next.add(row.id);
                return next;
              })
            }
          >
            <Icon name={collapsed ? 'chevron-right' : 'chevron-down'} size={11} />
            <span className="pg-traj-ellipsis" title={row.text}>
              {row.text || '(空)'}
            </span>
          </button>
        ) : row.expandable && row.detail ? (
          <details className="pg-traj-details">
            <summary title={row.text}>{row.text || '(空)'}</summary>
            <pre className="pg-traj-detail-body">{row.detail}</pre>
          </details>
        ) : (
          <span className="pg-traj-ellipsis" title={row.detail ?? row.text}>
            {row.text || '(空)'}
            {row.running ? ' …' : ''}
          </span>
        )}
      </span>
    </div>
  );
}

/** DSH `.kindTag`：19px / r4 / 10px / weight 650 / letter-spacing .035em；配色按角色。 */
function KindTag({ kind }: { kind: LedgerKind }) {
  return (
    <span className={`pg-kindtag pg-kind-${kind}`} data-role-kind={kind} title={KIND_LABEL[kind]}>
      <span className="pg-kindtag-icon" aria-hidden="true">
        <Icon name={KIND_ICON[kind]} size={11} />
      </span>
      <span className="pg-kindtag-label">{KIND_LABEL[kind]}</span>
    </span>
  );
}
