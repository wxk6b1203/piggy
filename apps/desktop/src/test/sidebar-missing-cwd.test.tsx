// @vitest-environment jsdom
/**
 * 侧栏「已删除的项目目录」汇总组（真机回归，docs/04 §1.5）。
 *
 * 现场（2026-09-28）：自定义 `sessionDir = …/tmp/session` 下，pi 自己把每次 `pi -p`
 * 的会话平铺写进同一个目录，侧栏一次多出 76 个"目录已不存在"的分组（每个 1 个会话），
 * 而它们都比真项目新 → 纯按时间排序会把 `/Users/wxk`、`1m-go-websockets` 挤到
 * 第 16、27 位，用户报「原来的会话没有了，多了一堆新的会话」。
 *
 * 这里锁三件事（视图模型那边另有纯函数测试）：
 *   ① 汇总组**默认收起**、且排在最后（真项目在它上面）；
 *   ② 点一下能展开，展开后能看到那些会话（会话文件没丢，也能导出）；
 *   ③ 汇总组里**不提供**"新建会话"（cwd 已不存在，tab_create 必然报错）。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...a: unknown[]) => invokeMock(...a) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock('@/lib/mockBackend', () => ({ isMock: false, mockInvoke: vi.fn(), mockOn: vi.fn() }));

import { SessionsSidebar } from '@/features/workspace/SessionsSidebar';
import { useSessions } from '@/stores/sessions';
import { mountDom, unmountDom, domContainer } from './dom-render';

const sess = (name: string, cwd: string, missing: boolean, created: number) => ({
  path: `${cwd}/${name}.jsonl`,
  file_name: `${name}.jsonl`,
  session_id: name,
  cwd,
  name: null,
  first_message: name,
  mtime_ms: created,
  created_ms: created,
  size: 10,
  cwd_missing: missing,
});

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockResolvedValue({});
  useSessions.setState({ groups: [], total: 0, loaded: true });
});
afterEach(async () => {
  await unmountDom();
});

describe('侧栏：已删除项目的会话汇总成一个收起的组', () => {
  const seed = () =>
    useSessions.setState({
      loaded: true,
      total: 4,
      groups: [
        // 真项目（更老）
        { cwd: '/Users/wxk', label: 'wxk', sessions: [sess('mine', '/Users/wxk', false, 1000)] },
        // 临时目录（更新，修复前会把上面那个挤下去）
        {
          cwd: '/private/tmp/case-1',
          label: 'case-1',
          sessions: [sess('junk1', '/private/tmp/case-1', true, 5000)],
        },
        {
          cwd: '/private/tmp/case-2',
          label: 'case-2',
          sessions: [sess('junk2', '/private/tmp/case-2', true, 4000)],
        },
        {
          cwd: '/private/tmp/case-3',
          label: 'case-3',
          sessions: [sess('junk3', '/private/tmp/case-3', true, 3000)],
        },
      ],
    });

  const groupLabels = () =>
    [...domContainer().querySelectorAll('.pg-group-label')].map((e) => (e.textContent ?? '').trim());
  const sessionTitles = () =>
    [...domContainer().querySelectorAll('.pg-session-title')].map((e) => (e.textContent ?? '').trim());

  it('真项目在最上面，汇总组在最后且默认收起', async () => {
    seed();
    mountDom(<SessionsSidebar />);
    await act(async () => {});

    expect(groupLabels()).toEqual(['wxk', '已删除的项目目录']);
    // 默认收起：只有真项目那个会话行可见，3 个"已删除"的会话都不铺开
    expect(sessionTitles()).toHaveLength(1);
    expect(sessionTitles()[0]).toContain('mine');
    // 计数告诉用户它们还在
    const bucket = domContainer().querySelector('.pg-group-missing')!;
    expect(bucket.querySelector('.pg-group-count')!.textContent).toBe('3');
    // 不能在里面新建会话（cwd 不存在）
    expect(bucket.querySelector('.pg-group-new')).toBeNull();
  });

  it('点开后能看到那些会话（没有丢，也能导出）', async () => {
    seed();
    mountDom(<SessionsSidebar />);
    await act(async () => {});

    const head = domContainer().querySelector<HTMLElement>('.pg-group-missing .pg-group-head')!;
    await act(async () => {
      head.click();
      await new Promise((r) => setTimeout(r, 50));
    });

    const titles = sessionTitles();
    expect(titles).toHaveLength(4); // 1 个真项目 + 3 个已删除项目的
    expect(titles.join(' ')).toContain('junk1');
    // 展开后有一句说明（"打开可能失败"而不是静默）
    expect(domContainer().textContent).toContain('目录已不存在');
  });

  it('展开后能一次性全部移入回收站（走和单条删除同一条 IPC）', async () => {
    seed();
    mountDom(<SessionsSidebar />);
    await act(async () => {});

    // 先展开
    const head = domContainer().querySelector<HTMLElement>('.pg-group-missing .pg-group-head')!;
    await act(async () => {
      head.click();
      await new Promise((r) => setTimeout(r, 50));
    });

    const bulk = domContainer().querySelector<HTMLElement>('[data-delete-missing]')!;
    expect(bulk.textContent).toContain('3'); // 组里 3 个
    await act(async () => {
      bulk.click();
      await new Promise((r) => setTimeout(r, 50));
    });

    // 确认弹窗（antd Modal.confirm）→ 点"全部删除"
    const okBtn = [...document.querySelectorAll<HTMLElement>('.ant-modal-confirm-btns button')].find(
      (b) => (b.textContent ?? '').includes('全部删除'),
    );
    expect(okBtn, '确认弹窗里要有「全部删除」').toBeTruthy();
    await act(async () => {
      okBtn!.click();
      await new Promise((r) => setTimeout(r, 100));
    });

    const deleted = invokeMock.mock.calls.filter((c) => c[0] === 'session_delete');
    expect(deleted).toHaveLength(3);
    expect(deleted.map((c) => (c[1] as { path: string }).path).sort()).toEqual([
      '/private/tmp/case-1/junk1.jsonl',
      '/private/tmp/case-2/junk2.jsonl',
      '/private/tmp/case-3/junk3.jsonl',
    ]);
    // 删完这一组就没了（removeLocal 会移掉整个空组）
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(domContainer().querySelector('.pg-group-missing')).toBeNull();
  });
});
