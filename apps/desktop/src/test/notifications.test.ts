// @vitest-environment jsdom
/**
 * 通知中心（2026-10-24 用户："拓展启动通知不需要了，右栏加通知栏目 + 未读点；
 * 点开通知就算已读"）。
 *
 * 两条必须钉住的行为：
 *  1. `notify` 不再走右下角 toast，而是进 store（历史留得住、后台 tab 也能看到）；
 *  2. 打开通知视图 = 全部已读（不在每条通知里再点一次）。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { unreadCount, useNotifications } from '@/stores/notifications';
import { handleFireAndForget } from '@/features/dialogs/DialogRouter';

const push = (id: string, message = 'hello') =>
  useNotifications.getState().push({ id, tabId: 't-1', level: 'info', message });

beforeEach(() => {
  useNotifications.setState({ items: [] });
});

describe('通知 store', () => {
  it('新的在前；未读数按 read 算', () => {
    push('n1', 'first');
    push('n2', 'second');
    const items = useNotifications.getState().items;
    expect(items.map((n) => n.message)).toEqual(['second', 'first']);
    expect(unreadCount(items)).toBe(2);

    useNotifications.getState().markAllRead();
    expect(unreadCount(useNotifications.getState().items)).toBe(0);
  });

  it('同一请求重复到达时替换，不堆两条', () => {
    push('n1', 'old');
    push('n1', 'new');
    const items = useNotifications.getState().items;
    expect(items).toHaveLength(1);
    expect(items[0]?.message).toBe('new');
  });

  it('空消息不落库；上限 100 条', () => {
    push('empty', '   ');
    expect(useNotifications.getState().items).toHaveLength(0);

    for (let i = 0; i < 105; i += 1) push(`n${i}`, `m${i}`);
    expect(useNotifications.getState().items).toHaveLength(100);
    expect(useNotifications.getState().items[0]?.message).toBe('m104');
  });
});

describe('handleFireAndForget(notify)', () => {
  it('notify 进通知中心，级别与 tab 来源都保留', () => {
    handleFireAndForget(
      { id: 'req-1', method: 'notify', message: '/init started — prompt: bundled', notifyType: 'warning' },
      't-9',
    );
    const [item] = useNotifications.getState().items;
    expect(item).toMatchObject({
      id: 't-9:req-1',
      tabId: 't-9',
      level: 'warning',
      message: '/init started — prompt: bundled',
      read: false,
    });
  });

  it('notifyType 映射到四种级别，未知值回 info', () => {
    handleFireAndForget({ id: 'e', method: 'notify', message: 'e', notifyType: 'error' }, 't');
    handleFireAndForget({ id: 'w', method: 'notify', message: 'w', notifyType: 'warning' }, 't');
    handleFireAndForget({ id: 's', method: 'notify', message: 's', notifyType: 'success' }, 't');
    handleFireAndForget({ id: 'i', method: 'notify', message: 'i', notifyType: 'other' }, 't');
    expect(useNotifications.getState().items.map((n) => n.level)).toEqual([
      'info',
      'success',
      'warning',
      'error',
    ]);
  });
});
