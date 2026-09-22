import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  agentMessageSchema,
  assistantMessageEventSchema,
  frameSchema,
  getEntriesDataSchema,
  piEventSchema,
  rpcResponseSchema,
} from '../index';

const fixturesDir = join(import.meta.dirname, '..', '..', 'fixtures');

/**
 * Rust↔TS 契约对拍（docs/08 §5）：fixtures/ 下同一组 JSON，
 * Rust 侧（src-tauri/tests/fixtures_parse.rs）与本测试双向解析。
 * fixtures 来源：pi 0.86.1 实机抓取 + 少量合成。
 */
describe('fixtures 对拍', () => {
  const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.json'));

  it('fixture 集非空', () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  for (const f of files) {
    it(`parse ${f}`, () => {
      const raw = JSON.parse(readFileSync(join(fixturesDir, f), 'utf8'));
      if (raw.type === 'response') {
        rpcResponseSchema.parse(raw);
        return;
      }
      piEventSchema.parse(raw);
    });
  }
});

describe('协议 schema 行为', () => {
  it('message_end 的 message 可被 agentMessageSchema 解析（user/assistant/toolResult）', () => {
    for (const f of [
      'event_message_end_user.json',
      'event_message_end_assistant_text.json',
      'event_message_end_assistant_toolcall.json',
      'event_message_end_toolresult.json',
      'event_message_end_system.json',
    ]) {
      const raw = JSON.parse(readFileSync(join(fixturesDir, f), 'utf8'));
      expect(() => agentMessageSchema.parse(raw.message)).not.toThrow();
    }
  });

  it('未知事件类型透传不报错', () => {
    const parsed = piEventSchema.parse({ type: 'shiny_new_event_v2', payload: { a: 1 } });
    expect(parsed.type).toBe('shiny_new_event_v2');
  });

  it('未知内容块透传不报错', () => {
    const msg = agentMessageSchema.parse({
      role: 'assistant',
      content: [{ type: 'futureBlock', x: 42 }],
    });
    expect((msg.content as Array<{ type: string }>)[0]!.type).toBe('futureBlock');
  });

  it('assistantMessageEvent 各 delta 形态可解析', () => {
    for (const f of readdirSync(fixturesDir).filter((x) => x.startsWith('event_update_'))) {
      const raw = JSON.parse(readFileSync(join(fixturesDir, f), 'utf8'));
      assistantMessageEventSchema.parse(raw.assistantMessageEvent);
    }
  });

  it('合帧器 Frame 结构可解析', () => {
    frameSchema.parse({
      text: [{ contentIndex: 0, delta: 'hello' }],
      thinking: [{ contentIndex: 1, delta: 'hm' }],
      toolArgs: [{ contentIndex: 2, delta: '{"comm' }],
      signals: [{ type: 'toolcall_start', contentIndex: 2, id: 'c1', toolName: 'bash' }],
      usage: { totalTokens: 10, cost: { total: 0.01 } },
    });
  });

  it('get_entries data 结构可解析', () => {
    getEntriesDataSchema.parse({
      entries: [
        {
          type: 'message',
          id: 'e1',
          parentId: null,
          message: { role: 'user', content: 'hi' },
        },
      ],
      leafId: 'e1',
    });
  });
});
