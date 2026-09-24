/**
 * 「打开方式」——**文件**那一档（DSH `OpenPathAction.tsx` + `OpenPathEmptyAction.tsx`：
 * 注入到文档预览的 actions / unpreviewable 两个位置）。
 *
 * 与目录那一档的区别不是外观（共用 `OpenTargetButton`），而是**数据来源**：
 * 目录用宿主白名单，文件用**操作系统的文件关联** —— 这个 .md 现在能由哪些应用打开，
 * 是系统说了算，不是一个写死的清单。因此：
 * - 主按钮默认 = 系统当前的默认应用；拿不到默认应用时退成「显示文件位置」（DSH `revealDefault`）；
 * - 菜单 = 全部已注册处理器（含真图标）+「显示文件位置」；
 * - 选某个处理器时，Rust 侧**先查一遍注册列表再启动**（前端传的字符串进不了执行面）。
 *
 * 桌面能力为 false（无头 Linux / SSH）→ 整个控件不渲染。
 */
import { useEffect, useState } from 'react';
import {
  OpenTargetButton,
  type OpenTargetApp,
  type OpenTargetOperation,
} from '@/features/common/OpenTargetButton';
import { t } from '@/lib/i18n';
import { loadDesktop, loadPathApplications, openPath, type PathApplication } from '@/lib/openInApp';

export function OpenPathAction({ path }: { path: string }) {
  const [desktop, setDesktop] = useState<boolean | null>(null);
  const [apps, setApps] = useState<PathApplication[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    void loadDesktop().then((ok) => {
      if (alive) setDesktop(ok);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (desktop !== true || !path) return;
    let alive = true;
    setLoading(true);
    void loadPathApplications(path).then((r) => {
      if (!alive) return;
      setApps(r.apps);
      setFailed(r.failed);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [desktop, path, nonce]);

  if (desktop !== true || !path) return null;

  const list: OpenTargetApp[] = apps.map((a) => ({ id: a.id, name: a.name, icon: a.icon }));
  // 系统标着"默认"的那个处理器；没有 → 主按钮变成「显示文件位置」
  const defaultId = apps.find((a) => a.default)?.id;

  const execute = async (operation: OpenTargetOperation): Promise<string | null> => {
    try {
      if (operation.kind === 'reveal') {
        await openPath(path, 'reveal');
      } else if (operation.kind === 'application') {
        await openPath(path, 'open', operation.id);
      } else if (defaultId === undefined) {
        await openPath(path, 'reveal');
      } else {
        await openPath(path, 'open', defaultId);
      }
      return null;
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      console.error('[open-path] 动作失败', path, operation, e);
      return `${operation.kind === 'reveal' ? t('open.revealError') : t('open.error')}：${reason}`;
    }
  };

  return (
    <OpenTargetButton
      kind="file"
      applications={list}
      defaultId={defaultId}
      loading={loading}
      failed={failed}
      onRefresh={() => setNonce((n) => n + 1)}
      execute={execute}
    />
  );
}
