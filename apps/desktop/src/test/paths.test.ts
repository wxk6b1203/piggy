/**
 * 路径字符串处理（Windows 事故回归位）。
 *
 * 用户报的 Windows 症状之一是"路径反斜杠、斜杠错乱"。Rust 侧修的是**拼**路径
 * （`join` 字面量不许带分隔符，见 `src-tauri/tests/path_separators.rs`），
 * 这里守的是**认**路径：界面过去到处 `split('/')`，于是 Windows 上
 * `C:\Users\x\proj` 会被当成一段，项目分组标题/标签页标题直接显示整条路径。
 */
import { describe, expect, it } from 'vitest';
import { PATH_DISPLAY_MAX, abbreviatePath, baseName, lastSeparator, resolveAgainst, splitPath } from '@/lib/paths';

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

/** 把工具参数里的相对路径解析成绝对路径（预览面板要绝对路径才读得到文件）。 */
describe('resolveAgainst', () => {
  it('相对路径接在会话 cwd 后面（多余的 ./ 与重复分隔符都收掉）', () => {
    expect(resolveAgainst('/Users/x/proj', 'src/a.ts')).toBe('/Users/x/proj/src/a.ts');
    expect(resolveAgainst('/Users/x/proj/', './src/a.ts')).toBe('/Users/x/proj/src/a.ts');
    expect(resolveAgainst('C:\\Users\\x\\proj', 'src\\a.ts')).toBe('C:\\Users\\x\\proj\\src\\a.ts');
  });

  it('绝对路径原样返回（POSIX / Windows 盘符 / UNC）', () => {
    expect(resolveAgainst('/Users/x/proj', '/tmp/a.py')).toBe('/tmp/a.py');
    expect(resolveAgainst('C:\\p', 'D:\\other\\a.ts')).toBe('D:\\other\\a.ts');
    expect(resolveAgainst('/p', '\\\\server\\share\\a.ts')).toBe('\\\\server\\share\\a.ts');
  });

  it('没有 cwd 时原样返回（预览会老实报读不到，不编一个路径）', () => {
    expect(resolveAgainst(null, 'src/a.ts')).toBe('src/a.ts');
    expect(resolveAgainst('', 'src/a.ts')).toBe('src/a.ts');
  });
});

/**
 * 界面里显示长路径（设置 › 通用 ›「内置插件」那张卡的目录）。
 *
 * 为什么不用 CSS 的 `text-overflow: ellipsis`：那是**尾巴**省略，留下的正好是最没信息量的
 * 前缀，而"是哪个目录"在末尾。这里断言的是**两端都要留**，且**短路径不许动**。
 */
describe('abbreviatePath', () => {
  const long = '/Users/wxk/Documents/Project/piggy/apps/desktop/src-tauri/target/debug/resources/pi-plugins/pi-guardrails';

  it('短路径原样返回（不为统一而掐掉看得清的东西）', () => {
    expect(abbreviatePath('/a/b/pi-todo')).toBe('/a/b/pi-todo');
    const exact = 'x'.repeat(PATH_DISPLAY_MAX);
    expect(abbreviatePath(exact)).toBe(exact);
  });

  it('超长路径掐中间：开头（从哪来）与结尾（是哪个目录）都留着', () => {
    const out = abbreviatePath(long);
    expect(out.length, '折完仍然超长').toBeLessThanOrEqual(PATH_DISPLAY_MAX);
    expect(out.startsWith('/Users/wxk/'), '开头留着才知道是仓库源码树还是打包产物').toBe(true);
    expect(out.endsWith('pi-guardrails'), '末尾留着才知道是哪个插件').toBe(true);
    expect(out).toContain('…');
    // 中间那段（这里是最长的）被吃掉了
    expect(out).not.toContain('target/debug');
  });

  it('Windows 路径同样处理（分隔符不影响，纯按字符数算）', () => {
    const win = 'C:\\Users\\wxk\\Documents\\Project\\piggy\\apps\\desktop\\src-tauri\\resources\\pi-plugins\\pi-todo';
    const out = abbreviatePath(win);
    expect(out.length).toBeLessThanOrEqual(PATH_DISPLAY_MAX);
    expect(out.startsWith('C:\\Users\\wxk')).toBe(true);
    expect(out.endsWith('pi-todo')).toBe(true);
  });

  it('任意上限都守得住（结果永不超上限；极小的上限退化成只留省略号）', () => {
    // max=10 → 预算 9 全给尾巴，于是只剩省略号 + 最后 9 个字符
    expect(abbreviatePath(long, 10)).toBe(`…${long.slice(-9)}`);
    // 不变式：任何 max 下都不超长（尾巴预算必须跟着 max 缩放）
    for (const m of [1, 2, 3, 5, 10, 28, 40, PATH_DISPLAY_MAX]) {
      expect(abbreviatePath(long, m).length, `max=${m} 时超了`).toBeLessThanOrEqual(Math.max(m, 1));
    }
    // 上限小到 1 才退化成只剩省略号；3 还能留两个字符的尾巴
    expect(abbreviatePath(long, 1)).toBe('…');
    expect(abbreviatePath(long, 3)).toBe(`…${long.slice(-2)}`);
  });
});
