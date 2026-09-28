import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useMessages } from '@/stores/messages';

const TAB = 'tab-1';
const fixtures = join(import.meta.dirname, '../../../../packages/pi-protocol/fixtures');
const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(fixtures, name), 'utf8')) as Record<string, unknown>;

function resetStore() {
  useMessages.setState({ tabs: {} });
}

describe('messagesStore v2（per-tab，docs/03 §3.2 / 04 §3）', () => {
  beforeEach(resetStore);

  it('message_end → append（user/assistant/toolResult 各归位）', () => {
    const s = useMessages.getState();
    s.ensure(TAB);
    s.applyCommit(TAB, fixture('event_message_end_user.json') as never);
    s.applyCommit(TAB, fixture('event_message_end_assistant_toolcall.json') as never);
    s.applyCommit(TAB, fixture('event_message_end_toolresult.json') as never);
    const tab = useMessages.getState().tabs[TAB]!;
    expect(tab.ids.length).toBe(3);
    expect(tab.byId[tab.ids[0]!]!.role).toBe('user');
    expect(tab.byId[tab.ids[1]!]!.role).toBe('assistant');
    expect(tab.byId[tab.ids[2]!]!.role).toBe('toolResult');
  });

  it('换窗期间（hasNewer）不把新消息塞进窗口；回到尾部后照常追加', () => {
    const s = useMessages.getState();
    s.hydratePage(
      TAB,
      [{ role: 'user', message: { role: 'user', content: '很久以前那一轮', timestamp: 1 }, offset: 500 }] as never[],
      { cursor: 500, hasMore: true, hasNewer: true },
    );
    const live = { type: 'message_end', message: { role: 'assistant', content: '刚说完的一句', timestamp: 99 } };
    s.applyCommit(TAB, live as never);
    // 窗口在看几轮之前的历史：把新消息追加进来会插在**错误的上下文**里
    expect(useMessages.getState().tabs[TAB]!.ids).toHaveLength(1);

    // 回到最新（尾部那一页，hasNewer=false）之后，实时消息照旧追加
    s.hydratePage(
      TAB,
      [{ role: 'user', message: { role: 'user', content: '最新那一轮', timestamp: 2 }, offset: 900 }] as never[],
      { cursor: 900, hasMore: true, hasNewer: false },
    );
    s.applyCommit(TAB, live as never);
    expect(useMessages.getState().tabs[TAB]!.ids).toHaveLength(2);
  });

  it('system 消息跳过；重复 message_end（同 role+timestamp）去重', () => {
    const s = useMessages.getState();
    s.ensure(TAB);
    s.applyCommit(TAB, fixture('event_message_end_system.json') as never);
    expect(useMessages.getState().tabs[TAB]!.ids.length).toBe(0);
    s.applyCommit(TAB, fixture('event_message_end_user.json') as never);
    s.applyCommit(TAB, fixture('event_message_end_user.json') as never);
    expect(useMessages.getState().tabs[TAB]!.ids.length).toBe(1);
  });

  it('多 tab 隔离：tab A 的消息不进 tab B', () => {
    const s = useMessages.getState();
    s.ensure(TAB);
    s.ensure('tab-2');
    s.applyCommit(TAB, fixture('event_message_end_user.json') as never);
    expect(useMessages.getState().tabs['tab-2']!.ids.length).toBe(0);
    expect(useMessages.getState().tabs[TAB]!.ids.length).toBe(1);
  });

  it('agent_start/settled 驱动 per-tab streaming；queue_update 驱动队列', () => {
    const s = useMessages.getState();
    s.ensure(TAB);
    s.applyCommit(TAB, { type: 'agent_start' });
    expect(useMessages.getState().tabs[TAB]!.streaming).toBe(true);
    s.applyCommit(TAB, { type: 'queue_update', steering: ['focus'], followUp: ['then'] });
    expect(useMessages.getState().tabs[TAB]!.queue.steering).toEqual(['focus']);
    s.applyCommit(TAB, { type: 'agent_settled' });
    expect(useMessages.getState().tabs[TAB]!.streaming).toBe(false);
  });

  it('piggy:resync 合并未见条目、跳过已知（timestamp 去重）', () => {
    const s = useMessages.getState();
    s.ensure(TAB);
    s.applyCommit(TAB, fixture('event_message_end_user.json') as never);
    const userMsg = fixture('event_message_end_user.json').message;
    s.applyCommit(TAB, {
      type: 'piggy:resync',
      entries: [
        { type: 'message', id: 'e1', parentId: null, message: userMsg },
        {
          type: 'message',
          id: 'e2',
          parentId: 'e1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], timestamp: 1790005475999 },
        },
        { type: 'context_edit', id: 'e3', parentId: 'e2', targetId: 'e1', replacement: null }, // 非 message 条目忽略
      ],
      leafId: 'e3',
    });
    const tab = useMessages.getState().tabs[TAB]!;
    expect(tab.ids.length).toBe(2);
    expect(tab.byId[tab.ids[1]!]!.role).toBe('assistant');
  });

  it('remove 清空该 tab', () => {
    const s = useMessages.getState();
    s.ensure(TAB);
    s.applyCommit(TAB, fixture('event_message_end_user.json') as never);
    s.remove(TAB);
    expect(useMessages.getState().tabs[TAB]).toBeUndefined();
  });
});
