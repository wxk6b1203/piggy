/**
 * 「打开方式」的**共用**分裂胶囊（DSH `OpenTargetButton.tsx`）。
 *
 * 一个组件同时服务两种目标 —— 这正是 DSH 的做法，理由是两条路的交互**逐字相同**
 * （默认动作 + 应用菜单 + 每次动作各自反馈），差别只在数据来源：
 * - `kind="directory"`：**固定白名单目录**（编辑器/终端/Git GUI），数据来自 Rust `open_in_app_*`；
 * - `kind="file"`：**操作系统文件关联**（这个 .md 现在能由哪些应用打开），来自 Rust `open_path_*`。
 *
 * 两处与 DSH 的有意差异：
 * 1. `prominent`（会话头部那颗）**带应用名** —— 用户对这个位置的原话是「稍微显著一点」，
 *    纯图标在深色头部里太隐形；`compact`（预览头部）与 DSH 一样只有图标。
 * 2. DSH 把「显示文件位置」放在菜单 footer，这里当成最后一条普通菜单项 ——
 *    `Picker` 的 footer 不是 `role="option"`，键盘上下键走不到，放进去等于键盘不可达。
 *
 * 失败一律走 `toast`（DSH 的 `open-failure-toast`）：只闪一个红框等于没说为什么。
 */
import { useRef, useState } from 'react';
import { Icon } from '@/features/common/Icon';
import { Picker, type PickerItem } from '@/features/common/Picker';
import { toast } from '@/lib/feedback';
import { t, tf } from '@/lib/i18n';

/** 一个候选应用；`icon` 是 data URL（真图标抠不出来时是 null → 画通用方块）。 */
export interface OpenTargetApp {
  id: string;
  name: string;
  icon: string | null;
}

/** 一次动作：默认应用 / 指定应用 / 在文件管理器里显示。 */
export type OpenTargetOperation =
  | { kind: 'default' }
  | { kind: 'application'; id: string }
  | { kind: 'reveal' };

export interface OpenTargetButtonProps {
  kind: 'file' | 'directory';
  applications: readonly OpenTargetApp[];
  /** 选中的那个（目录 = 上次用过的；文件 = 系统默认）。 */
  defaultId?: string;
  /** 正在查（目录：读白名单；文件：查关联）。 */
  loading?: boolean;
  /** 查询**失败**（与"没有结果"不同：失败时菜单里要说明）。 */
  failed?: boolean;
  /** 会话头部那颗（图标 + 名字）；预览头部用 compact（只有图标）。 */
  prominent?: boolean;
  /** 展开菜单前刷新数据（文件关联可能在应用安装后变化）。 */
  onRefresh?: () => void;
  /**
   * 外部唤起信号（`windowEvents`）：命令面板的「打开方式」没有自己的按钮，
   * 靠发这个信号让这里展开真正的菜单（`Picker.openSignal`）。
   * 注意：**只有画了箭头才会有监听者** —— 只有一个候选时命令是无动作的。
   */
  openSignal?: string;
  /** 执行一次动作；返回**失败原因**（null = 成功）。 */
  execute: (operation: OpenTargetOperation) => Promise<string | null>;
}

/** 真图标；拿不到就画一个通用圆角方块（DSH 在图标 404 时也是这个方块）。 */
function AppIcon({ source, size }: { source: string | null; size: number }) {
  const [failed, setFailed] = useState(false);
  if (source === null || failed) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        className="pg-opentarget-glyph"
        aria-hidden="true"
        data-icon-kind="generic"
      >
        <rect x="3" y="3" width="18" height="18" rx="5" />
      </svg>
    );
  }
  return (
    <img
      src={source}
      width={size}
      height={size}
      className="pg-opentarget-img"
      alt=""
      aria-hidden="true"
      draggable={false}
      data-icon-kind="image"
      onError={() => setFailed(true)}
    />
  );
}

export function OpenTargetButton({
  kind,
  applications,
  defaultId,
  loading = false,
  failed = false,
  prominent = false,
  onRefresh,
  openSignal,
  execute,
}: OpenTargetButtonProps) {
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);

  const preferred = applications.find((a) => a.id === defaultId);
  const disabled = pending;
  // 只有"一件事可做"时不画箭头（DSH 同款判断：应用数 + 文件的揭示项）
  const hasMenu = loading || failed || applications.length + (kind === 'file' ? 1 : 0) > 1;
  // 文件还没有已知的默认应用时，主按钮 = 在文件管理器里显示（DSH 的 revealDefault）
  const revealDefault = kind === 'file' && preferred === undefined && !loading;
  const primaryLabel = revealDefault
    ? t('open.reveal')
    : preferred === undefined
      ? t('open.open')
      : tf('open.title', { app: preferred.name });

  const act = (operation: OpenTargetOperation) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    void execute(operation)
      .then((reason) => {
        if (reason !== null) toast.error(reason || t('open.error'));
      })
      .finally(() => {
        inFlight.current = false;
        setPending(false);
      });
  };

  const items: PickerItem[] = [
    ...applications.map((app) => ({
      id: `app:${app.id}`,
      label: app.id === defaultId ? tf('open.appDefault', { app: app.name }) : app.name,
      iconNode: <AppIcon source={app.icon} size={16} />,
    })),
    ...(failed ? [{ id: 'unavailable', label: t('open.appsError'), disabled: true }] : []),
    ...(kind === 'file'
      ? [
          {
            id: 'reveal',
            label: revealDefault ? tf('open.appDefault', { app: t('open.reveal') }) : t('open.reveal'),
            icon: 'folder-opened' as const,
          },
        ]
      : []),
  ];

  const icon =
    loading && preferred === undefined ? (
      <span
        className="pg-opentarget-skeleton"
        data-open-target-skeleton
        aria-hidden="true"
        style={{ width: prominent ? 18 : 13, height: prominent ? 18 : 13 }}
      />
    ) : revealDefault ? (
      <Icon name="folder-opened" size={prominent ? 18 : 13} />
    ) : (
      <AppIcon source={preferred?.icon ?? null} size={prominent ? 15 : 13} />
    );

  return (
    <div
      className="pg-opentarget-split"
      data-open-target={kind}
      data-size={prominent ? 'large' : 'compact'}
      data-state={pending ? 'busy' : 'idle'}
      role="group"
      aria-label={t('open.aria')}
    >
      <button
        type="button"
        className="pg-opentarget-main"
        data-open-target-main=""
        // 当前选中的是哪个（目录 = 上次用过的 id，文件 = 系统默认的处理器 id）——
        // 界面上看不出来，但门禁与排障都要读它
        data-open-target-id={defaultId ?? ''}
        title={primaryLabel}
        aria-label={primaryLabel}
        disabled={disabled}
        onClick={() => act(revealDefault ? { kind: 'reveal' } : { kind: 'default' })}
      >
        {icon}
        {prominent ? (
          <span className="pg-opentarget-name">
            {revealDefault ? t('open.reveal') : preferred?.name ?? t('open.open')}
          </span>
        ) : null}
      </button>
      {hasMenu ? (
        <Picker
          className="pg-opentarget-chevron"
          side="down"
          width={prominent ? 232 : 216}
          title={t('open.aria')}
          buttonTitle={t('open.more')}
          items={items}
          emptyText={t('open.none')}
          openSignal={openSignal}
          onOpenChange={(open) => {
            if (open) onRefresh?.();
          }}
          onPick={(id) => {
            if (id === 'reveal') act({ kind: 'reveal' });
            else if (id.startsWith('app:')) act({ kind: 'application', id: id.slice(4) });
          }}
        >
          <Icon name="chevron-down" size={prominent ? 12 : 10} />
        </Picker>
      ) : null}
    </div>
  );
}
