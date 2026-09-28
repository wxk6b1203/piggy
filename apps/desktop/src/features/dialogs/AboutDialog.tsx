/**
 * 「关于 Piggy 与许可」（docs/03 §2.17、docs/04 §2.5）。
 *
 * ## 为什么要有这个对话框（而不是只放一个 LICENSE 文件）
 *
 * GPLv3 §0 给 "Appropriate Legal Notices" 下了定义：交互界面必须显示
 * ①版权声明 ②无担保声明 ③可以按本许可再分发 ④**怎么看许可全文**；
 * §5(d) 要求有交互界面的作品都显示它。用户拿到的是安装包、不是 git 仓库，
 * 所以这些必须出现在**界面上**。
 *
 * ## 为什么系统「关于」面板不够
 *
 * macOS 的关于面板是个信息框：能显示版权行与一小段 credits，塞不下 GPL 的 674 行原文。
 * 所以分工是——系统菜单负责"找得到"（App 菜单里「关于」正下方那条），
 * 这个对话框负责"看得全"（原文 + 第三方组件表）。
 *
 * ## 三个入口，一个动作（规矩 36）
 *
 * 系统菜单项（Rust 发 `app:open-about`）、命令面板、侧栏版本号——都只是把
 * `aboutOpen` 置真，界面只有这一处。分叉的表现会是"菜单打开的版本号和侧栏显示的不一样"
 * 这类只在某条路上复现的怪事。
 */
import { useCallback, useEffect, useState } from 'react';
import { Button, Modal } from 'antd';
import { cmd } from '@/lib/ipc';
import { toast } from '@/lib/feedback';
import { useUi } from '@/stores/ui';

/** 一条第三方组件（与 Rust `legal::ThirdParty` 的线格式一致）。 */
export interface ThirdPartyNotice {
  name: string;
  license: string;
  holder: string;
  usage: string;
}

/** `legal_notices` 的返回（**跨 IPC**，camelCase）。 */
export interface LegalNotices {
  name: string;
  version: string;
  copyright: string;
  /** SPDX：GPL-3.0-or-later */
  spdx: string;
  licenseName: string;
  /** 无担保声明（GPL §0 要求显示的三件事之一） */
  warranty: string;
  licenseUrl: string;
  /** GPLv3 全文（Rust 侧 `include_str!` 仓库根的 LICENSE，零漂移） */
  gplText: string;
  thirdParty: ThirdPartyNotice[];
}

/**
 * 归一化（规矩 28：IPC 形状在边界处校验）。
 *
 * 与标题生成那次事故同一条纪律：Rust 发 snake_case、前端读 camelCase 时**两边都不报错**，
 * 只会把 `undefined` 渲染出来。这里让缺字段退化成"少显示一块"，并且**吵**。
 */
export function normalizeNotices(raw: unknown): LegalNotices {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (k: string, fallback = ''): string => {
    const v = r[k];
    if (typeof v === 'string' && v !== '') return v;
    if (v !== undefined) console.warn(`[legal] 形状漂移：${k} 不是非空字符串`, v);
    return fallback;
  };
  const rows = Array.isArray(r.thirdParty) ? r.thirdParty : [];
  if (!Array.isArray(r.thirdParty)) {
    console.warn('[legal] 形状漂移：legal_notices 没有 thirdParty 数组', r);
  }
  const thirdParty: ThirdPartyNotice[] = rows.map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    return {
      name: String(o.name ?? ''),
      license: String(o.license ?? ''),
      holder: String(o.holder ?? ''),
      usage: String(o.usage ?? ''),
    };
  }).filter((x) => x.name !== '');
  return {
    name: str('name', 'Piggy'),
    version: str('version'),
    copyright: str('copyright'),
    spdx: str('spdx'),
    licenseName: str('licenseName', 'GNU General Public License v3.0 or later'),
    warranty: str('warranty'),
    licenseUrl: str('licenseUrl', 'https://www.gnu.org/licenses/gpl-3.0.html'),
    gplText: str('gplText'),
    thirdParty,
  };
}

export function AboutDialog() {
  const open = useUi((s) => s.aboutOpen);
  const setOpen = useUi((s) => s.setAboutOpen);
  const [info, setInfo] = useState<LegalNotices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  /** 这一次"打开"是否已经试过拉取。**不要**用 `loading` 当这个闸门——见下。 */
  const [attempted, setAttempted] = useState(false);

  /**
   * 按需拉取（35KB 的 GPL 全文没必要在启动时读进来）。
   *
   * ⚠️ 这里踩过一个**真的会把后端打爆**的坑：第一版把 `loading` 放进了依赖数组，
   * 靠 `if (!open || info || loading) return;` 兜住重入。于是**失败时**
   * `setLoading(false)`（finally 里）会重新满足条件 → 再拉一次 → 再失败 →
   * 无限重试，IPC 被自己刷屏（单测表现为超时，真机上就是转圈不停）。
   * 现在用一个显式的"这次打开试过了吗"闸门：失败就停在失败态，等用户关掉重开重试。
   */
  useEffect(() => {
    if (!open) {
      // 关掉 = 允许下次重开时重试（失败态不该把用户永久钉住）
      setAttempted(false);
      return;
    }
    if (attempted || info) return;
    setAttempted(true);
    setLoading(true);
    setError(null);
    void cmd<unknown>('legal_notices')
      .then((r) => setInfo(normalizeNotices(r)))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [open, attempted, info]);

  /** 失败后原地重试（不必关掉再打开）。 */
  const retry = useCallback(() => {
    setError(null);
    setAttempted(false);
  }, []);

  const copyAll = useCallback(async () => {
    if (!info) return;
    const text = [
      `${info.name} ${info.version}`,
      info.copyright,
      `${info.licenseName}（${info.spdx}）`,
      info.warranty,
      '',
      '第三方组件：',
      ...info.thirdParty.map((t) => `- ${t.name} · ${t.license} · ${t.holder} · ${t.usage}`),
      '',
      info.gplText,
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      toast.success('许可与第三方声明已复制');
    } catch (e) {
      // 剪贴板被拒（无权限/非安全上下文）时不能假装成功——用户会去粘贴然后发现是空的
      toast.error(`复制失败：${e}`);
    }
  }, [info]);

  return (
    <Modal
      open={open}
      title="关于 Piggy 与许可"
      onCancel={() => setOpen(false)}
      width={720}
      // 关闭即销毁：antd 默认把关闭的 Modal 留在 DOM 里，而**别的**对话框
      // （插件安装）是按 `[role="dialog"]` 找元素的——留着的这个会先被选中，
      // 于是那边拿到的是一个空壳（门禁当场红在插件页那一段）。顺带也不再把 35KB 全文
      // 一直挂在 DOM 上。
      destroyOnHidden
      // 正文自己滚。全文区已经限高，但"标题 + 无担保 + 6 行第三方表 + 全文区 + 脚注"
      // 加起来仍可能高过窗口（实测 1280×860 下是 879px），那样**底部按钮会被推到视口外**
      // ——而"怎么看全文"这句话就废了。
      styles={{ body: { maxHeight: '60vh', overflow: 'auto' } }}
      data-about-dialog
      footer={[
        <Button key="copy" onClick={() => void copyAll()} disabled={!info}>
          复制全部
        </Button>,
        <Button key="close" type="primary" onClick={() => setOpen(false)}>
          关闭
        </Button>,
      ]}
    >
      {error && (
        <p className="pg-plugin-error">
          读不出许可信息：{error}
          {' '}
          <Button type="link" size="small" onClick={retry} data-legal-retry>
            重试
          </Button>
        </p>
      )}
      {!info && !error && <p className="pg-fg-dim">{loading ? '正在读取…' : ''}</p>}
      {info && (
        <div className="pg-about" data-legal-notices>
          <p className="pg-about-head">
            <strong>{info.name}</strong>
            {info.version && <span className="pg-about-version">v{info.version}</span>}
          </p>
          {/* 版权行：GPL §0 要求显示的三件事之一 */}
          <p data-legal-copyright>{info.copyright}</p>
          <p>
            本程序按 <strong>{info.licenseName}</strong>（<code>{info.spdx}</code>）发布。
            {' '}
            <a href={info.licenseUrl} target="_blank" rel="noreferrer">
              查看许可原文（gnu.org）
            </a>
          </p>
          {/* 无担保声明：同一件事的第二件。用 warn 色是刻意的——它不是装饰 */}
          <p className="pg-runtime-warn" data-legal-warranty>
            {info.warranty}
          </p>

          <h4 className="pg-about-h">第三方组件</h4>
          <table className="pg-about-table" data-legal-thirdparty>
            <thead>
              <tr>
                <th>组件</th>
                <th>许可</th>
                <th>版权人</th>
                <th>用在哪</th>
              </tr>
            </thead>
            <tbody>
              {info.thirdParty.map((t) => (
                <tr key={t.name} data-third-party={t.name}>
                  <td>{t.name}</td>
                  <td>{t.license}</td>
                  <td className="pg-fg-dim">{t.holder}</td>
                  <td className="pg-fg-dim">{t.usage}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="pg-fg-dim pg-settings-note">
            完整登记（含取用方式与未尽事项）见仓库里的 <code>THIRD_PARTY_NOTICES.md</code>；
            full SKU 随安装包分发 pi，其 MIT 声明也在包内。
          </p>

          <h4 className="pg-about-h">GNU 通用公共许可证 第 3 版（全文）</h4>
          {/* 「怎么看许可全文」这件事在这里落地：原文就在界面上，不是一句"详见 LICENSE" */}
          <pre className="pg-about-license" data-legal-text>
            {info.gplText}
          </pre>
        </div>
      )}
    </Modal>
  );
}
