/**
 * 权限守卫扩展的真实测试（测的就是 `tauri.conf.json` 会打进包的那个文件本身）。
 *
 * 为什么值得单独写：守卫是「工作区内修改」档**唯一**的边界执行点——
 * pi 的 write/edit 自身不做工作区检查，档位文案是否诚实全押在这个文件上。
 * 因此这里不测 mock，直接 import 生产文件。
 */
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PIGGY_GUARDED_TOOLS,
  canonicalize,
  checkWrite,
  guardRoots,
  isInside,
  default as piggyGuard,
} from '../../src-tauri/resources/piggy-guard.js';

let root: string;
let workspace: string;
let outside: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'piggy-guard-'));
  workspace = join(root, 'work');
  outside = join(root, 'outside');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(workspace, 'a.txt'), 'a');
  writeFileSync(join(outside, 'secret.txt'), 's');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/* ⚠️ **这个文件里的两组用例是 POSIX 专属的**（2026-10-09 加闸门）。
 *
 * 被测的 `piggy-guard.js` 是「工作区内修改」档唯一的边界执行点，而它**只在 pi 进程里跑**
 * ——pi 的宿主是 macOS/Linux，Windows 上 piggy 走的是 pi 的 Windows 发行版，
 * 那份进程里的 `node:path` 就是 POSIX 语义。所以"守卫在 Windows 上跑"这件事不存在，
 * 下面两组断言搬到 Windows 上必然不成立，而且是**两种不同的原因**：
 *
 *   ① `isInside` 组喂的是 `/work`、`/work/a.txt` 这种 POSIX 字面量，而守卫按
 *      `path.sep` 做前缀比较（`target.startsWith(root + sep)`）——Windows 上 sep 是 `\`，
 *      于是 `isInside('/work/a.txt', '/work')` 是 false。**守卫是对的，用例不可移植**。
 *   ② 符号链接那两条要 `symlinkSync`，Windows 上普通进程建符号链接报
 *      `EPERM: operation not permitted`（要开发者模式或管理员）。是环境限制，不是产品问题。
 *
 * 闸门写成**可见的 skip**而不是删掉：macOS/Linux 上覆盖一点不少，
 * 而 Windows 上跑全量时它会明说自己跳过了哪几条、为什么 —— 比"红着让人肉记住"诚实。
 */
const posixOnly = describe.skipIf(process.platform === 'win32');

posixOnly('isInside —— 前缀比较必须按路径段，不能按字符', () => {
  it('接受根目录本身与其中的路径', () => {
    expect(isInside('/work', '/work')).toBe(true);
    expect(isInside('/work/a.txt', '/work')).toBe(true);
    expect(isInside('/work/deep/nested/x.ts', '/work')).toBe(true);
  });

  it('拒绝同前缀但不同目录的兄弟路径（经典 startsWith 陷阱）', () => {
    // 裸 startsWith('/work') 会把这两个放进去 —— 必须挡住
    expect(isInside('/work-other/x', '/work')).toBe(false);
    expect(isInside('/workspace/x', '/work')).toBe(false);
    expect(isInside('/work2', '/work')).toBe(false);
  });

  it('拒绝父目录与相邻目录', () => {
    expect(isInside('/etc/passwd', '/work')).toBe(false);
    expect(isInside('/wor', '/work')).toBe(false);
  });

  it('根目录以分隔符结尾时不产生双分隔符误判', () => {
    expect(isInside(`/work${sep}a`, `/work${sep}`)).toBe(true);
  });
});

posixOnly('canonicalize —— 必须穿透符号链接，否则链接能骗过前缀比较', () => {
  /* 符号链接**建在这里**，不靠别的 describe 顺手建。
     原来 `escape` 只在上一条用例里建过，而那条一旦被闸门跳掉，
     后面那条"拦截经符号链接逃逸"就会因为**链接不存在**而通过 ——
     也就是说它会变成一条永远绿、什么都没验的用例（比红更糟）。 */
  beforeAll(() => {
    symlinkSync(outside, join(workspace, 'escape'), 'dir');
  });
  it('解析已存在的路径为 realpath（macOS 上 /var 本身是 /private/var 的链接）', () => {
    const target = join(workspace, 'a.txt');
    const got = canonicalize(target);
    expect(got).toBe(realpathSync(target));
    // 本机 tmpdir 经 /var → /private/var：恰好证明"字面路径 ≠ 真实路径"，
    // 而白名单比较必须发生在规整之后
    if (tmpdir().startsWith('/var/')) {
      expect(got.startsWith('/private/var/')).toBe(true);
      expect(got).not.toBe(target);
    }
  });

  it('目标不存在（新建文件）时也给出可比较的绝对路径', () => {
    const ghost = join(workspace, 'not-yet', 'deep', 'new.ts');
    const got = canonicalize(ghost);
    expect(got.endsWith(join('not-yet', 'deep', 'new.ts'))).toBe(true);
    expect(isInside(got, canonicalize(workspace))).toBe(true);
  });

  it('把经符号链接指向外部的路径解析成真实位置', () => {
    const link = join(workspace, 'escape');
    // 关键：如果只做字符串前缀判断，workspace/escape/secret.txt 会"看起来"在工作区内
    const viaLink = canonicalize(join(link, 'secret.txt'));
    expect(isInside(viaLink, canonicalize(workspace))).toBe(false);
    expect(isInside(viaLink, canonicalize(outside))).toBe(true);
  });
});

describe('guardRoots —— 策略缺失必须 fail-closed', () => {
  it('缺失或为空时返回 null（而不是空数组"放行一切"）', () => {
    expect(guardRoots({})).toBeNull();
    expect(guardRoots({ PIGGY_GUARD_ROOTS: '' })).toBeNull();
    expect(guardRoots({ PIGGY_GUARD_ROOTS: '   ' })).toBeNull();
    expect(guardRoots({ PIGGY_GUARD_ROOTS: `${delimiter}${delimiter}` })).toBeNull();
  });

  it('按路径分隔符解析多个根并去除空白', () => {
    // 注意：分隔符是 path.delimiter（POSIX 为 ':'），不是 path.sep
    const roots = guardRoots({ PIGGY_GUARD_ROOTS: ` ${workspace} ${delimiter}${outside} ` });
    expect(roots).toHaveLength(2);
    expect(roots?.[0]).toBe(canonicalize(workspace));
    expect(roots?.[1]).toBe(canonicalize(outside));
  });
});

describe('checkWrite —— 放行与拦截的完整判定', () => {
  const rootsOf = () => guardRoots({ PIGGY_GUARD_ROOTS: workspace });

  it('工作区内的相对与绝对路径都放行', () => {
    const roots = rootsOf();
    expect(checkWrite({ toolName: 'write', input: { path: 'a.txt' } }, roots, workspace)).toBeUndefined();
    expect(
      checkWrite({ toolName: 'write', input: { path: join(workspace, 'sub/b.ts') } }, roots, workspace),
    ).toBeUndefined();
    expect(
      checkWrite({ toolName: 'edit', input: { path: './a.txt' } }, roots, workspace),
    ).toBeUndefined();
  });

  it('拦截工作区外的绝对路径', () => {
    const v = checkWrite(
      { toolName: 'write', input: { path: join(outside, 'x.ts') } },
      rootsOf(),
      workspace,
    );
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('工作区之外');
  });

  it('拦截用 .. 爬出工作区的相对路径', () => {
    const v = checkWrite({ toolName: 'write', input: { path: '../outside/x.ts' } }, rootsOf(), workspace);
    expect(v?.block).toBe(true);
  });

  /* 这一条要 `symlinkSync`（链接由上面那组的 `beforeAll` 建好）——
     所以同样加 POSIX 闸门。**闸门必须是 `it.skipIf`，不能复用上面那个 `posixOnly`**：
     它是 `describe.skipIf`，包一个只有裸 `expect` 的块会得到一个**没有任何 `it` 的空 suite**
     —— vitest 直接判这个文件失败（2026-10-09 实测：macOS/Linux 上 `Test Files 1 failed`），
     而在 Windows 上它退化成静默 skip，那 4 条断言**一次都不跑**（比红更糟）。
     闸门的效果一样是"可见的跳过"，但这次跳过的是**用例**而不是容器。 */
  it.skipIf(process.platform === 'win32')('拦截经符号链接逃逸的路径', () => {
    const v = checkWrite(
      { toolName: 'write', input: { path: 'escape/secret.txt' } },
      rootsOf(),
      workspace,
    );
    expect(v?.block).toBe(true);
  });

  it('拦截 /etc 这类系统路径', () => {
    expect(checkWrite({ toolName: 'write', input: { path: '/etc/hosts' } }, rootsOf(), workspace)?.block).toBe(
      true,
    );
  });

  it('放行与本次写无关的工具（只拦守卫清单里的）', () => {
    const roots = rootsOf();
    for (const toolName of ['read', 'grep', 'find', 'ls', 'bash']) {
      expect(checkWrite({ toolName, input: { path: '/etc/hosts' } }, roots, workspace)).toBeUndefined();
    }
  });

  it('守卫清单只含写工具，不含任何只读或 shell 工具', () => {
    expect([...PIGGY_GUARDED_TOOLS].sort()).toEqual(['edit', 'write']);
  });

  it('path 缺失/非字符串/空白时拒绝（不因为拿不到参数就放行）', () => {
    const roots = rootsOf();
    for (const input of [{}, { path: '' }, { path: '   ' }, { path: 42 }, { path: null }]) {
      const v = checkWrite({ toolName: 'write', input }, roots, workspace);
      expect(v?.block, `input=${JSON.stringify(input)} 应被拒绝`).toBe(true);
    }
  });

  it('白名单为 null（策略丢失）时拒绝一切写入', () => {
    const v = checkWrite({ toolName: 'write', input: { path: 'a.txt' } }, null, workspace);
    expect(v?.block).toBe(true);
    expect(v?.reason).toContain('PIGGY_GUARD_ROOTS');
  });
});

describe('扩展入口', () => {
  it('注册 tool_call 钩子，且钩子对越界写入返回 block', async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = {
      on: vi.fn((event: string, handler: (e: unknown) => unknown) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      }),
    };
    process.env.PIGGY_GUARD_ROOTS = workspace;
    try {
      piggyGuard(pi);
      expect(pi.on).toHaveBeenCalledWith('tool_call', expect.any(Function));
      const handler = handlers.get('tool_call');
      expect(handler).toBeTypeOf('function');

      // 工作区内 → 放行
      await expect(handler!({ toolName: 'write', input: { path: 'a.txt' } })).resolves.toBeUndefined();
      // 工作区外 → 拦截
      const blocked = (await handler!({
        toolName: 'write',
        input: { path: join(outside, 'x.ts') },
      })) as { block?: boolean };
      expect(blocked?.block).toBe(true);
    } finally {
      delete process.env.PIGGY_GUARD_ROOTS;
    }
  });

  it('环境变量缺失时入口告警，且钩子仍然拒绝写入', async () => {
    const handlers = new Map<string, (event: unknown) => unknown>();
    const pi = {
      on: (_e: string, h: (x: unknown) => unknown) => {
        handlers.set('tool_call', h);
        return () => handlers.delete('tool_call');
      },
    };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.PIGGY_GUARD_ROOTS;
    try {
      piggyGuard(pi);
      expect(errSpy).toHaveBeenCalled();
      const v = (await handlers.get('tool_call')!({
        toolName: 'write',
        input: { path: 'a.txt' },
      })) as { block?: boolean };
      expect(v?.block).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });
});
