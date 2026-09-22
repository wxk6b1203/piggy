import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useMessages } from '@/stores/messages';

const TAB = 'tab-1';
const fixtures = join(import.meta.dirname, '../../../../packages/pi-protocol/fixtures');
const fixture = (name: string): any => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

function resetStore() {
  useMessages.setState({ tabs: {} });
}

describe('messagesStore v2（per-tab，docs/03 §3.2 / 04 §3）', () => {
  beforeEach(resetStore);

  it('message_end → append（user/assistant/toolResult 各归位）', () => {
    const s = useMessages.getState();
    s.ensure(TAB);
    s.applyCommit(TAB, fixture('event_message_end_user.json'));
    s.applyCommit(TAB, fixture('event_message_end_assistant_toolcall.json'));
    s.applyCommit(TAB, fixture('event_message_end_toolresult.json'));
    const tab = useMessages.getState().tabs[TAB]!;
    expect(tab.ids.length).toBe(3);
    expect(tab.byId[tab.ids[0]!]!.role).toBe('user');
    expect(tab.byId[tab.ids[1]!]!.role).toBe('assistant');
    expect(tab.byId[tab.ids[2]!]!.role).toBe('toolResult');
  });

  it('system 消息跳过；重复 message_end（同 role+timestamp）去重', () => {
    const s = useMessages.getState();
    s.ensure(TAB);
    s.applyCommit(TAB, fixture('event_message_end_system.json'));
    expect(useMessages.getState().tabs[TAB]!.ids.length).toBe(0);
    s.applyCommit(TAB, fixture('event_message_end_user.json'));
    s.applyCommit(TAB, fixture('event_message_end_user.json'));
    expect(useMessages.getState().tabs[TAB]!.ids.length).toBe(1);
  });

  it('多 tab 隔离：tab A 的消息不进 tab B', () => {
    const s = useMessages.getState();
    s.ensure(TAB);
    s.ensure('tab-2');
    s.applyCommit(TAB, fixture('event_message_end_user.json'));
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
    s.applyCommit(TAB, fixture('event_message_end_user.json'));
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
    s.applyCommit(TAB, fixture('event_message_end_user.json'));
    s.remove(TAB);
    expect(useMessages.getState().tabs[TAB]).toBeUndefined();
  });
});
