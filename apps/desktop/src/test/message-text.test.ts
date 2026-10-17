// @vitest-environment node
/**
 * 一条消息的纯文本（`lib/messageText.ts`，2026-10-17 把 7 份实现合并成一份）。
 *
 * 合并前这 7 处**没有任何单测** —— 它们只是"看起来一样"，而拼接符其实已经分叉
 * （多数 `''`、预览那两处 `'\n'`）。这里钉住口径本身：
 *   ① 裸字符串原样返回（pi 早期形状）；
 *   ② 只取 `type === 'text'` 的块，思考/工具调用/图片都不算"文本"；
 *   ③ 拼接符由调用方决定（助手正文 `''`，刻度梯预览/会话轮廓 `'\n'`）；
 *   ④ 坏形状（null / 数字 / 对象）一律空串，不猜、不 JSON.stringify。
 */
import { describe, expect, it } from 'vitest';
import { textOfContent } from '@/lib/messageText';

describe('textOfContent（消息纯文本的统一口径）', () => {
  it('裸字符串原样返回', () => {
    expect(textOfContent('你好')).toBe('你好');
  });

  it('只取 text 块：思考、工具调用、图片都不算', () => {
    const content = [
      { type: 'thinking', thinking: '先想想' },
      { type: 'text', text: '第一段' },
      { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls' } },
      { type: 'text', text: '第二段' },
      { type: 'image', data: 'AAA', mimeType: 'image/png' },
    ];
    expect(textOfContent(content)).toBe('第一段第二段');
  });

  it('拼接符由调用方定（预览要"一段一行"）', () => {
    const content = [
      { type: 'text', text: '一' },
      { type: 'text', text: '二' },
    ];
    expect(textOfContent(content, '\n')).toBe('一\n二');
  });

  it('坏形状一律空串（不猜、不序列化）', () => {
    expect(textOfContent(null)).toBe('');
    expect(textOfContent(undefined)).toBe('');
    expect(textOfContent(42)).toBe('');
    expect(textOfContent({ type: 'text', text: '块不是数组' })).toBe('');
    expect(textOfContent([{ type: 'text' }, { type: 'text', text: 7 }, null])).toBe('');
  });
});
