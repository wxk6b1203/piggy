/**
 * 「打开方式」——**工作区目录**那一档（DSH `OpenInAppAction.tsx` + `ui-open-in-app` 的会话头部位）。
 *
 * 只负责三件事，渲染交给共用的 `OpenTargetButton`：
 * 1. 读宿主的白名单目录（`open_in_app_list`，页面级一次）；
 * 2. 记住上次用哪个应用（跨会话头部、跨重启；DSH 是一份持久化 store）；
 * 3. 把动作翻译成 `open_in_app_open(id, cwd)`。
 *
 * 什么时候**不**渲染：宿主没解析出任何应用（没装 / SSH 启动 / 非三平台）、或会话还没有工作目录
 * —— 与 DSH 逐条对齐（没有可得的东西时不留一个点了没反应的按钮）。
 *
 * 选择为什么用 `labelFor` 过滤：宿主有义务报"装了什么"，没有义务知道显示名；
 * 前端只渲染它能命名的 id，于是后端加了条目而词典没跟上时，菜单里不会冒出一个裸 id。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  OpenTargetButton,
  type OpenTargetApp,
  type OpenTargetOperation,
} from '@/features/common/OpenTargetButton';
import { getLang, t, type Lang } from '@/lib/i18n';
import {
  loadApps,
  loadIcon,
  onChoiceChange,
  openInApp,
  readChoice,
  writeChoice,
} from '@/lib/openInApp';

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

export function OpenInApp({ cwd }: { cwd?: string }) {
  const [available, setAvailable] = useState<string[] | null>(null);
  const [choice, setChoice] = useState<string>(() => readChoice());
  const [icons, setIcons] = useState<Record<string, string | null>>({});

  useEffect(() => {
    let alive = true;
    void loadApps().then((ids) => {
      if (alive) setAvailable(ids);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 别处（另一个会话头部 / 命令面板）改了选择 → 跟着变
  useEffect(() => onChoiceChange(setChoice), []);

  const named = useMemo(
    () => (available ?? []).filter((id) => labelFor(id) !== null),
    [available],
  );
  const key = named.join(',');

  // 菜单里每一项都要真图标 → 按需拉一遍（lib 里按 id 缓存，只拉一次）
  useEffect(() => {
    if (!key) return;
    let alive = true;
    void Promise.all(key.split(',').map(async (id) => [id, await loadIcon(id)] as const)).then(
      (pairs) => {
        if (alive) setIcons(Object.fromEntries(pairs));
      },
    );
    return () => {
      alive = false;
    };
  }, [key]);

  const apps: OpenTargetApp[] = named.map((id) => ({
    id,
    name: labelFor(id) ?? id,
    icon: icons[id] ?? null,
  }));
  const current = apps.find((a) => a.id === choice) ?? apps[0];
  if (current === undefined || !cwd) return null;

  const execute = async (operation: OpenTargetOperation): Promise<string | null> => {
    const id = operation.kind === 'application' ? operation.id : current.id;
    try {
      await openInApp(id, cwd);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error('[open-in-app] 打开失败', id, e);
      return `${t('open.error')}：${reason}`;
    }
    if (operation.kind === 'application') {
      setChoice(id);
      writeChoice(id);
    }
    return null;
  };

  return (
    <OpenTargetButton
      kind="directory"
      prominent
      applications={apps}
      defaultId={current.id}
      loading={available === null}
      // 命令面板的 `openin.pick` 发这个信号（M1 单组布局：同时只有一个会话头部在听）
      openSignal="open-in-app-picker"
      execute={execute}
    />
  );
}
