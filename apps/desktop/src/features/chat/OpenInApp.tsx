/**
 * 「打开方式」分裂胶囊（DSH `ui-open-in-app` 的会话头部按钮，docs/12 §2225）。
 *
 * 形状照搬 DSH：`div.split > button.main + button.chevron`，
 * 主按钮 = 上次用过的那个应用（图标 + 名字），箭头 = 本机全部可用应用。
 * 一处**故意**的偏离：DSH 的主按钮只有图标，这里带上了应用名 ——
 * 用户对这个位置的要求是「稍微显著一点」，纯图标在 Piggy 的深色头部里太隐形。
 *
 * 什么时候不渲染（与 DSH 逐条对齐）：
 * - 宿主没解析出任何应用（没装 / SSH 启动 / 非 macOS+Windows+Linux）；
 * - 会话还没有工作目录（没有目录就没有"打开什么"）。
 *
 * 主按钮点击 = 直接打开；菜单里选中某项 = 记住它 + 立刻打开（DSH 同样先 choose 再 launch）。
 */
import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/features/common/Icon';
import { Picker, type PickerItem } from '@/features/common/Picker';
import { getLang, t, tf, type Lang } from '@/lib/i18n';
import { loadApps, loadIcon, openInApp, readChoice, writeChoice } from '@/lib/openInApp';

/**
 * 产品名（DSH 词典里 zh/en **逐字相同**的那些键）。
 * 这些是厂商名，不是文案：翻译它们只会让人认不出是哪个应用。
 */
const PRODUCT_NAMES: Record<string, string> = {
  cursor: 'Cursor',
  vscode: 'VS Code',
  vscodeinsiders: 'VS Code Insiders',
  windsurf: 'Windsurf',
  zed: 'Zed',
  sublimetext: 'Sublime Text',
  xcode: 'Xcode',
  androidstudio: 'Android Studio',
  intellij: 'IntelliJ IDEA',
  pycharm: 'PyCharm',
  webstorm: 'WebStorm',
  phpstorm: 'PhpStorm',
  goland: 'GoLand',
  rider: 'Rider',
  rustrover: 'RustRover',
  fork: 'Fork',
  sourcetree: 'Sourcetree',
  github: 'GitHub Desktop',
  tower: 'Tower',
  gitkraken: 'GitKraken',
  smartgit: 'SmartGit',
  sublimemerge: 'Sublime Merge',
  ghostty: 'Ghostty',
  warp: 'Warp',
  iterm: 'iTerm2',
  kitty: 'kitty',
  windowsterminal: 'Windows Terminal',
  gitbash: 'Git Bash',
  gnometerminal: 'GNOME Terminal',
  konsole: 'Konsole',
};

/** 这四个随语言变（DSH 的 zh 词典同样只覆盖这四个）。 */
const LOCALIZED: Record<string, Record<Lang, string>> = {
  finder: { 'zh-CN': '访达', 'en-US': 'Finder' },
  explorer: { 'zh-CN': '文件资源管理器', 'en-US': 'File Explorer' },
  filemanager: { 'zh-CN': '文件管理器', 'en-US': 'Files' },
  terminal: { 'zh-CN': '终端', 'en-US': 'Terminal' },
};

/**
 * 一个 id 的显示名。
 * **宿主多出来的 id 一律返回 null**（前端只渲染它能命名的应用）：
 * 后端加了条目而词典没跟上时，菜单里不会冒出一个裸 id。
 */
export function labelFor(id: string): string | null {
  const localized = LOCALIZED[id];
  if (localized) return localized[getLang()] ?? localized['zh-CN'];
  return PRODUCT_NAMES[id] ?? null;
}

/** 快速启动基本都在这个时长内返回，所以"忙"态不该闪一下（DSH 同款 250ms）。 */
const BUSY_DRESS_DELAY_MS = 250;
/** 失败态自己复位的时间。 */
const ERROR_RESET_MS = 2000;

/** 已判定"没有图标"的应用：图标 404 只拉一次，不是每次开菜单都拉。 */
const noIcon = new Set<string>();

function AppIcon({ id, size }: { id: string; size: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!noIcon.has(id)) {
      void loadIcon(id).then((u) => {
        if (!alive) return;
        if (u === null) noIcon.add(id);
        else setUrl(u);
      });
    }
    return () => {
      alive = false;
    };
  }, [id]);
  if (url === null) {
    // 通用图标（DSH 在图标 404 时画的同一个圆角方块）
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        className="pg-openin-glyph"
        aria-hidden="true"
        data-app-icon={id}
        data-icon-kind="generic"
      >
        <rect x="3" y="3" width="18" height="18" rx="5" />
      </svg>
    );
  }
  return (
    <img
      src={url}
      width={size}
      height={size}
      className="pg-openin-img"
      alt=""
      aria-hidden="true"
      draggable={false}
      data-app-icon={id}
      data-icon-kind="image"
    />
  );
}

export function OpenInApp({ cwd }: { cwd?: string }) {
  const [available, setAvailable] = useState<string[] | null>(null);
  const [choice, setChoice] = useState<string>(() => readChoice());
  const [phase, setPhase] = useState<'idle' | 'busy' | 'error'>('idle');
  const inFlight = useRef(false);
  const busyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void loadApps().then((ids) => {
      if (alive) setAvailable(ids);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () => () => {
      clearTimeout(busyTimer.current);
      clearTimeout(errorTimer.current);
    },
    [],
  );

  // 只保留能命名的 id（词典是前端的，宿主没义务知道显示名）
  const apps = (available ?? []).filter((id) => labelFor(id) !== null);
  const current = apps.find((id) => id === choice) ?? apps[0];

  const launch = (id: string) => {
    if (inFlight.current || !cwd) return;
    inFlight.current = true;
    clearTimeout(errorTimer.current);
    clearTimeout(busyTimer.current);
    busyTimer.current = setTimeout(() => setPhase('busy'), BUSY_DRESS_DELAY_MS);
    openInApp(id, cwd).then(
      () => {
        inFlight.current = false;
        clearTimeout(busyTimer.current);
        setPhase('idle');
      },
      (e: unknown) => {
        inFlight.current = false;
        clearTimeout(busyTimer.current);
        setPhase('error');
        console.error('[open-in-app] 打开失败', id, e);
        clearTimeout(errorTimer.current);
        errorTimer.current = setTimeout(() => setPhase('idle'), ERROR_RESET_MS);
      },
    );
  };

  if (current === undefined || !cwd) return null;

  const currentLabel = labelFor(current) ?? current;
  const buttonTitle = phase === 'error' ? t('open.error') : tf('open.title', { app: currentLabel });

  const items: PickerItem[] = apps.map((id) => ({
    id,
    label: labelFor(id) ?? id,
    iconNode: <AppIcon id={id} size={16} />,
    active: id === current,
  }));

  return (
    <div className="pg-openin-split" data-phase={phase} role="group" aria-label={t('open.aria')}>
      <button
        type="button"
        className="pg-openin-main"
        data-open-in-app="main"
        data-app={current}
        title={buttonTitle}
        aria-label={buttonTitle}
        disabled={phase === 'busy'}
        onClick={() => launch(current)}
      >
        <AppIcon id={current} size={15} />
        <span className="pg-openin-name">{currentLabel}</span>
      </button>
      <Picker
        className="pg-openin-chevron"
        side="down"
        width={232}
        title={t('open.aria')}
        buttonTitle={t('open.menu')}
        items={items}
        emptyText={t('open.none')}
        onPick={(id) => {
          if (inFlight.current) return;
          setChoice(id);
          writeChoice(id);
          launch(id);
        }}
      >
        <Icon name="chevron-down" size={12} />
      </Picker>
    </div>
  );
}
