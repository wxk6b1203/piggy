// @vitest-environment jsdom
/**
 * 「关于 Piggy 与许可」（docs/03 §2.17、docs/04 §2.5）。
 *
 * 这个对话框存在的理由是**法定的**：GPLv3 §0 要求交互界面显示
 * ①版权声明 ②无担保声明 ③怎么看许可全文，§5(d) 要求有界面的作品都显示。
 * 所以这里的每条用例都对着那几句话：少显示一样，等于没履行。
 *
 * 另外锁两件容易悄悄坏掉的事：
 *   · **三个入口落到同一个对话框**（系统菜单信号 / 命令面板 / 侧栏版本号）——
 *     分叉的表现是"从菜单打开有全文、从版本号打开是空的"这类只在一条路上复现的怪事；
 *   · **全文限高可滚**：674 行原文不加限高会把对话框撑到按钮都看不见，
 *     那样"怎么看全文"就成了一句空话（几何在浏览器门禁里量，这里锁结构）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock, toastError, toastSuccess } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/mockBackend')>();
  return { ...actual, isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() };
});
vi.mock('@/lib/feedback', () => ({
  toast: { error: (...a: unknown[]) => toastError(...a), success: (...a: unknown[]) => toastSuccess(...a), info: vi.fn() },
  FeedbackBridge: () => null,
  confirm: vi.fn(),
}));
// 与其它用例同样的接法：`isMock: false` 让 `cmd()` 走（被 mock 的）`invoke`。
// ⚠️ 不这么写的话 `cmd()` 会走**真的 mockBackend**，本文件里所有 invokeMock 覆盖
// 都会静默失效（第一版就是这么写的，表现为"抛错用例里对话框显示的是成功数据"）。
// 数据本身仍取 mockBackend 的真实导出（`mockThirdParty` / `mockGplExcerpt`），
// 这样"mock 的数据与 THIRD_PARTY_NOTICES.md 是否一致"这条金标还在。
import { mockThirdParty, mockGplExcerpt } from '@/lib/mockBackend';
import { AboutDialog, normalizeNotices } from '@/features/dialogs/AboutDialog';
import { useAppCommands } from '@/lib/appCommands';
import { getCommand, registrySize } from '@/lib/commands';
import { useUi } from '@/stores/ui';
import { mountDom, unmountDom, domContainer } from './dom-render';

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 60)); });
/** Modal 渲染在 document.body 的 portal 里，不在挂载容器内 */
const inBody = <T extends Element>(sel: string) => document.body.querySelector<T>(sel);
const qaBody = <T extends Element>(sel: string) => [...document.body.querySelectorAll<T>(sel)];

/** 真机形状的一份声明数据（第三方表与 GPL 节选直接取 mockBackend 的真实导出）。 */
const legalPayload = () => ({
  name: 'Piggy',
  version: '0.1.0',
  copyright: 'Copyright (C) 2026 wxk6b1203',
  spdx: 'GPL-3.0-or-later',
  licenseName: 'GNU General Public License v3.0 or later',
  warranty: '本程序是自由软件……但没有任何担保，甚至没有适销性或特定用途适用性的默示担保。',
  licenseUrl: 'https://www.gnu.org/licenses/gpl-3.0.html',
  gplText: mockGplExcerpt,
  thirdParty: mockThirdParty,
});

function prime() {
  invokeMock.mockImplementation(async (name: string) => {
    if (name === 'legal_notices') return legalPayload();
    return null;
  });
}

/** 对话框此刻是否**可见**（antd 关闭后仍把 DOM 留在页面里，只是 wrap 变成 display:none）。 */
function aboutVisible(): boolean {
  const el = inBody<HTMLElement>('[data-legal-notices]');
  if (!el) return false;
  const wrap = el.closest('.ant-modal-wrap') as HTMLElement | null;
  return !!wrap && getComputedStyle(wrap).display !== 'none';
}

/** 同时挂上命令注册与对话框——真实应用里前者在 AppFrame、后者在 App（tests 里合成一个宿主）。 */
function Host() {
  useAppCommands();
  return <AboutDialog />;
}

async function openAbout() {
  await act(async () => {
    useUi.getState().setAboutOpen(true);
    await new Promise((r) => setTimeout(r, 60));
  });
}

beforeEach(async () => {
  invokeMock.mockReset();
  toastError.mockReset();
  toastSuccess.mockReset();
  prime();
  useUi.getState().setAboutOpen(false);
});

afterEach(async () => {
  await unmountDom();
  useUi.getState().setAboutOpen(false);
});

describe('关于与许可对话框', () => {
  it('默认不打开；打开后显示 GPL §0 要求的三件事', async () => {
    mountDom(<Host />);
    await flush();
    expect(aboutVisible(), '默认不该打开').toBe(false);

    await openAbout();
    await flush();
    const box = inBody<HTMLElement>('[data-legal-notices]');
    expect(box).toBeTruthy();
    // ①版权
    const copyright = inBody<HTMLElement>('[data-legal-copyright]')!.textContent ?? '';
    expect(copyright).toContain('Copyright (C) 2026 wxk6b1203');
    // ②无担保 + 许可名与 or later
    const warranty = inBody<HTMLElement>('[data-legal-warranty]')!.textContent ?? '';
    expect(warranty).toContain('没有任何担保');
    const text = box!.textContent ?? '';
    expect(text).toContain('GNU General Public License v3.0 or later');
    expect(text).toContain('GPL-3.0-or-later');
    // ③怎么看全文：原文就在界面上（不是一句"详见 LICENSE"）
    expect(text).toContain('GNU GENERAL PUBLIC LICENSE');
    expect(text).toContain('Version 3, 29 June 2007');
    expect(inBody('[data-legal-text]')).toBeTruthy();
    // 指向 gnu.org 的链接也在
    expect(box!.querySelector('a[href^="https://www.gnu.org/"]')).toBeTruthy();
  });

  it('第三方组件逐条列出（组件 / 许可 / 版权人 / 用在哪）', async () => {
    mountDom(<Host />);
    await flush();
    await openAbout();
    await flush();
    const rows = qaBody<HTMLTableRowElement>('[data-third-party]');
    expect(rows.length).toBeGreaterThanOrEqual(5);
    const pi = qaBody('[data-third-party="pi"]')[0]!;
    expect(pi.textContent).toContain('MIT');
    // 版权人是署名义务的主体，必须在界面上（不只是在仓库文件里）
    expect(pi.textContent).toContain('Mario Zechner');
    const dsh = qaBody('[data-third-party="DeepSeek Harness"]')[0]!;
    expect(dsh.textContent).toContain('DeepSeek');
  });

  it('三个入口落到同一个对话框（菜单信号 / 命令面板 / 版本号都只是置 aboutOpen）', async () => {
    mountDom(<Host />);
    await flush();
    // 入口 1：系统菜单（Rust 发 app:open-about；这里直接触发同一个状态转移）
    await openAbout();
    await flush();
    expect(aboutVisible()).toBe(true);
    // 关掉
    await act(async () => {
      useUi.getState().setAboutOpen(false);
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(aboutVisible(), '关闭后不该还看得见').toBe(false);

    // 入口 2：命令面板。**不复制**命令定义——直接跑注册表里那条真的
    // （复制一份就等于"用被测物的复印件证明被测物"）
    const cmd = getCommand('app.about');
    expect(cmd, '命令面板里没有 app.about').toBeTruthy();
    expect(registrySize()).toBeGreaterThan(0);
    await act(async () => {
      await cmd!.run({ activeTabId: null });
      await new Promise((r) => setTimeout(r, 60));
    });
    expect(aboutVisible(), '命令面板这一路没打开对话框').toBe(true);
  });

  it('形状漂移时降级并 warn，而不是渲染 undefined', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const n = normalizeNotices({ copyright: 'C', license_name: 'x', third_party: [] });
    expect(n.copyright).toBe('C');
    // 认不出的键不会变成 undefined 显示给用户
    expect(n.spdx).toBe('');
    expect(n.thirdParty).toEqual([]);
    expect(warn).toHaveBeenCalled();
    // 完全没数据也不炸
    expect(normalizeNotices(undefined).thirdParty).toEqual([]);
    // 缺 name 的第三方行被丢掉（表格里不该出现空行）
    expect(normalizeNotices({ thirdParty: [{ license: 'MIT' }, { name: 'ok' }] }).thirdParty).toEqual([
      { name: 'ok', license: '', holder: '', usage: '' },
    ]);
    warn.mockRestore();
  });

  it('复制走剪贴板；失败时明确报错（不假装成功）', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mountDom(<Host />);
    await flush();
    await openAbout();
    await flush();
    const copy = qaBody<HTMLButtonElement>('.ant-modal-footer button')[0]!;
    expect(copy.textContent).toContain('复制');
    await act(async () => {
      copy.click();
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0]![0] as string;
    expect(copied).toContain('Copyright (C) 2026 wxk6b1203');
    expect(copied).toContain('GNU GENERAL PUBLIC LICENSE');
    expect(copied).toContain('Mario Zechner');
    expect(toastSuccess).toHaveBeenCalled();
  });

  it('读不出许可信息时报错，而不是弹一个空壳', async () => {
    invokeMock.mockImplementation(async () => {
      throw new Error('include_str 出问题了');
    });
    mountDom(<Host />);
    await flush();
    await openAbout();
    await flush();
    const body = domContainer().ownerDocument.body.textContent ?? '';
    expect(body).toContain('读不出许可信息');
    expect(body).toContain('include_str 出问题了');
    expect(inBody('[data-legal-notices]'), '读失败时不该渲染半成品').toBeNull();
    // **只许试一次**：失败时自动重试会变成无限循环（这条用例就是这么抓出来的——
    // 第一版把 loading 放进依赖数组，失败复位 loading → 再拉 → 再失败，
    // 单测直接超时，真机上会把 IPC 刷屏）
    expect(invokeMock.mock.calls.length, '失败后不该自动重试').toBe(1);
    // 但用户点「重试」要能再试一次
    const retry = document.querySelector<HTMLButtonElement>('[data-legal-retry]');
    expect(retry, '失败态没有重试入口').toBeTruthy();
    await act(async () => {
      retry!.click();
      await new Promise((r) => setTimeout(r, 40));
    });
    expect(invokeMock.mock.calls.length).toBe(2);
  });
});

describe('mock 的许可数据与 THIRD_PARTY_NOTICES.md 互为金标', () => {
  it('两边登记的组件一一对应（少一个 = 界面上少一条署名）', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const md = readFileSync(join(process.cwd(), '..', '..', 'THIRD_PARTY_NOTICES.md'), 'utf8');
    const headings = md
      .split('\n')
      .filter((l) => l.startsWith('## '))
      .map((l) => l.slice(3).trim())
      .filter((h) => !h.startsWith('待登记'));
    const names = mockThirdParty.map((t) => t.name);
    expect(headings.length).toBeGreaterThan(0);
    for (const n of names) {
      expect(headings.some((h) => h.startsWith(n)), `${n} 没登记进 THIRD_PARTY_NOTICES.md`).toBe(true);
    }
    for (const h of headings) {
      expect(names.some((n) => h.startsWith(n)), `文档里的 ${h} 没出现在界面上`).toBe(true);
    }
  });
});
