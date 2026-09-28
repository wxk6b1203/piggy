/**
 * 路径字符串处理（Windows 事故回归位）。
 *
 * 用户报的 Windows 症状之一是"路径反斜杠、斜杠错乱"。Rust 侧修的是**拼**路径
 * （`join` 字面量不许带分隔符，见 `src-tauri/tests/path_separators.rs`），
 * 这里守的是**认**路径：界面过去到处 `split('/')`，于是 Windows 上
 * `C:\Users\x\proj` 会被当成一段，项目分组标题/标签页标题直接显示整条路径。
 */
import { describe, expect, it } from 'vitest';
import { baseName, lastSeparator, splitPath } from '@/lib/paths';

describe('baseName（POSIX 与 Windows 路径都要认）', () => {
  it('POSIX 路径', () => {
    expect(baseName('/Users/x/proj')).toBe('proj');
    expect(baseName('a/b/c.txt')).toBe('c.txt');
    expect(baseName('single')).toBe('single');
  });

  it('Windows 路径（反斜杠）', () => {
    expect(baseName('C:\\Users\\x\\proj')).toBe('proj');
    expect(baseName('C:\\Users\\x\\proj\\main.ts')).toBe('main.ts');
    // 盘根：没有"最后一段"之外的语义，取盘符即可（不 panic、不返回整串）
    expect(baseName('C:\\')).toBe('C:');
  });

  it('混合分隔符（历史 bug 留下的产物）也要能取到末段', () => {
    expect(baseName('C:\\Users\\x\\.pi/agent\\sessions')).toBe('sessions');
  });

  it('UNC 路径与末尾分隔符', () => {
    expect(baseName('\\\\server\\share\\dir')).toBe('dir');
    expect(baseName('/a/b/')).toBe('b');
    expect(baseName('C:\\a\\b\\')).toBe('b');
    expect(baseName('')).toBe('');
    expect(baseName('/')).toBe('');
  });
});

describe('lastSeparator / splitPath', () => {
  it('最后分隔符取两种斜杠里更靠后的那个', () => {
    expect(lastSeparator('/a/b')).toBe(2);
    expect(lastSeparator('C:\\a\\b')).toBe(4);
    expect(lastSeparator('C:\\a/b')).toBe(4);
    expect(lastSeparator('none')).toBe(-1);
  });

  it('splitPath 目录部分保留末尾分隔符（界面要灰显）', () => {
    expect(splitPath('/a/b/c.txt')).toEqual({ dir: '/a/b/', name: 'c.txt' });
    expect(splitPath('C:\\a\\b\\c.txt')).toEqual({ dir: 'C:\\a\\b\\', name: 'c.txt' });
    expect(splitPath('c.txt')).toEqual({ dir: '', name: 'c.txt' });
    // 末尾分隔符先忽略：`/a/b/` 的末段是 `b`，它的目录是 `/a/`
    expect(splitPath('/a/b/')).toEqual({ dir: '/a/', name: 'b' });
  });
});

describe('会话分组标题（Windows 上过去会显示整条路径）', () => {
  it('POSIX 与 Windows 的 cwd 都只显示最后一段', async () => {
    const { groupLabel } = await import('@/stores/sessions');
    expect(groupLabel('/Users/x/proj')).toBe('proj');
    expect(groupLabel('C:\\Users\\x\\proj')).toBe('proj');
    // 取不到末段时不至于显示空标题（回退整串）
    expect(groupLabel('')).toBe('');
  });
});
