import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { useMessages } from '@/stores/messages';
import type { AgentMessage } from '@piggy/pi-protocol';

const fixtures = join(import.meta.dirname, '../../../../packages/pi-protocol/fixtures');
const fixture = (name: string): any => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

function resetStore() {
  useMessages.setState({
    byId: {},
    ids: [],
    streaming: false,
    queue: { steering: [], followUp: [] },
    toolRuns: {},
    banner: null,
    hydrated: false,
  });
}

describe('messagesStore（docs/03 §3.2 / 04 §3）', () => {
  it('message_end → append（user/assistant/toolResult 各归位）', () => {
    resetStore();
    const s = useMessages.getState();
    s.applyCommit(fixture('event_message_end_user.json'));
    s.applyCommit(fixture('event_message_end_assistant_toolcall.json'));
    s.applyCommit(fixture('event_message_end_toolresult.json'));
    const st = useMessages.getState();
    expect(st.ids.length).toBe(3);
    expect(st.byId[st.ids[0]!]!.role).toBe('user');
    expect(st.byId[st.ids[1]!]!.role).toBe('assistant');
    expect(st.byId[st.ids[2]!]!.role).toBe('toolResult');
  });

  it('system 消息跳过；重复 message_end（同 role+timestamp）去重', () => {
    resetStore();
    const s = useMessages.getState();
    s.applyCommit(fixture('event_message_end_system.json'));
    expect(useMessages.getState().ids.length).toBe(0);
    s.applyCommit(fixture('event_message_end_user.json'));
    s.applyCommit(fixture('event_message_end_user.json')); // 重复投递
    expect(useMessages.getState().ids.length).toBe(1);
  });

  it('agent_start/settled 驱动 streaming；queue_update 驱动队列', () => {
    resetStore();
    const s = useMessages.getState();
    s.applyCommit({ type: 'agent_start' });
    expect(useMessages.getState().streaming).toBe(true);
    s.applyCommit({ type: 'queue_update', steering: ['focus'], followUp: ['then'] });
    expect(useMessages.getState().queue.steering).toEqual(['focus']);
    s.applyCommit({ type: 'agent_settled' });
    expect(useMessages.getState().streaming).toBe(false);
  });

  it('piggy:resync 合并未见条目、跳过已知（timestamp 去重）', () => {
    resetStore();
    const s = useMessages.getState();
    s.applyCommit(fixture('event_message_end_user.json'));
    const userMsg: AgentMessage = fixture('event_message_end_user.json').message;
    s.applyCommit({
      type: 'piggy:resync',
      entries: [
        { type: 'message', id: 'e1', parentId: null, message: userMsg }, // 已知
        {
          type: 'message',
          id: 'e2',
          parentId: 'e1',
          message: { role: 'assistant', content: [{ type: 'text', text: 'recovered' }], timestamp: 1790005475999 },
        },
      ],
      leafId: 'e2',
    });
    const st = useMessages.getState();
    expect(st.ids.length).toBe(2);
    expect(st.byId[st.ids[1]!]!.role).toBe('assistant');
  });

  it('tool_execution_start/end 更新 toolRuns', () => {
    resetStore();
    const s = useMessages.getState();
    s.applyCommit(fixture('event_tool_execution_start.json'));
    s.applyCommit(fixture('event_tool_execution_end.json'));
    const runs = useMessages.getState().toolRuns;
    const key = Object.keys(runs)[0]!;
    expect(runs[key]!.running).toBe(false);
  });
});
