/** i18n 测试（M4）：词典完整性 + 回退语义 + 切换通知 */
import { describe, expect, it } from 'vitest';
import { DICT, getLang, setLang, t, type DictKey } from '@/lib/i18n';
import { windowEvents } from '@/lib/windowEvents';

describe('i18n（M4）', () => {
  it('zh-CN 与 en-US 键集合完全一致', () => {
    const zh = Object.keys(DICT['zh-CN']).sort();
    const en = Object.keys(DICT['en-US']).sort();
    expect(en).toEqual(zh);
  });

  it('t()：当前语言命中；未知 key 回落为 key 本身', () => {
    setLang('zh-CN');
    expect(t('app.newSession')).toBe('新会话');
    expect(t('nonexistent.key')).toBe('nonexistent.key');
    setLang('en-US');
    expect(t('app.newSession')).toBe('New Session');
    expect(t('nonexistent.key')).toBe('nonexistent.key');
  });

  it('setLang 触发 lang-changed 事件且持久化', () => {
    let fired = 0;
    const off = windowEvents.on('lang-changed', () => {
      fired += 1;
    });
    setLang('en-US');
    off();
    expect(fired).toBe(1);
    expect(getLang()).toBe('en-US');
    setLang('zh-CN');
  });

  it('词典键是合法 DictKey 类型抽样', () => {
    const sample: DictKey = 'palette.placeholder';
    expect(typeof DICT['zh-CN'][sample]).toBe('string');
  });
});
