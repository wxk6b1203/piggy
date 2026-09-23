/**
 * 预览语言表门禁（docs/10 §2.2）。
 *
 * 这条线的**病根**和聊天代码块是同一个（见 docs/15 规则 22、src/test/codeblock.test.tsx）：
 * Monaco 的 ESM 发行版一门语言都不带，而"语言没注册"的失败形态是**静默降级成纯文本**
 * —— 不抛错、不警告，界面上只是"语言条写着 markdown、正文一片白"。用户就是这么发现的。
 *
 * 所以在 Node 里能确定性判定的部分全部钉死：
 *   · 路径 → 语言 id 的识别（含大小写、点开头文件、无扩展名）；
 *   · 表里每个 id **都要有对应的加载器**，否则就是"识别得出、加载不了"的半死状态；
 *   · 每个 `import('monaco-editor/languages/definitions/<dir>/register')` 的
 *     **目录要真的在 node_modules 里**，而且该目录注册出来的 id 必须包含表里的键
 *     （`proto` ← protobuf、`c` ← cpp 这类"键与目录不同名"最容易写错，写错了只会静默回退）；
 *   · 扩展名取值与 **VS Code 自己的 extensions 表**一致（就是那些 register.js），
 *     只有 APPROX 里逐条注明理由的近似才放行。
 *
 * 真浏览器里的"到底上没上色"由 `scripts/ui-startup-check.mjs` 第 5 节断言
 * （jsdom 里没有 Monaco 的布局与 worker，在这里断言颜色只会假过）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_LANGS,
  EXT_LANG,
  FILE_LANG,
  LANG_LOADERS,
  langForPath,
} from '@/features/common/monaco-langs';

const SRC = join(process.cwd(), 'src');
const LANGS_SRC = join(SRC, 'features/common/monaco-langs.ts');

/** monaco 的语言定义目录（借包自己的 exports map 定位，不硬编码 pnpm store 路径）。 */
const DEFS_DIR = (() => {
  const req = createRequire(import.meta.url);
  return resolvePath(dirname(req.resolve('monaco-editor/languages/definitions/markdown/register')), '..');
})();

/** 去注释：注释里**故意**写着反模式原文当说明，不剥掉门会咬自己的说明文字。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** 从源码里抠出 `语言id: () => import('monaco-editor/languages/definitions/<dir>/register')`。 */
function loaderEntries(): { id: string; dir: string }[] {
  const text = stripComments(readFileSync(LANGS_SRC, 'utf8'));
  const re =
    /(?:^|[{,\s])(?:'([^']+)'|([A-Za-z_$][\w$]*))\s*:\s*\(\)\s*=>\s*import\('monaco-editor\/languages\/definitions\/([a-z0-9-]+)\/register'\)/g;
  const out: { id: string; dir: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push({ id: m[1] ?? m[2]!, dir: m[3]! });
  return out;
}

/** 某个定义目录注册出来的语言（一个目录可能注册多门：cpp → c+cpp、systemverilog → sv+verilog）。 */
function definition(dir: string): { ids: string[]; exts: string[]; files: string[] }[] {
  const text = readFileSync(join(DEFS_DIR, dir, 'register.js'), 'utf8');
  const out: { ids: string[]; exts: string[]; files: string[] }[] = [];
  for (const block of text.matchAll(/registerLanguage\(\{([\s\S]*?)\n\}\);/g)) {
    const body = block[1]!;
    const grab = (key: string) => {
      const arr = new RegExp(`${key}:\\s*\\[([\\s\\S]*?)\\]`).exec(body);
      return arr ? [...arr[1]!.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]!) : [];
    };
    out.push({
      ids: [...body.matchAll(/id:\s*"([^"]+)"/g)].map((x) => x[1]!),
      exts: grab('extensions'),
      files: grab('filenames'),
    });
  }
  return out;
}

/**
 * 刻意偏离 VS Code 表的近似映射：VS Code 里没有这门语言，但落到纯文本太亏。
 * 键 = 扩展名，值 = 理由。**加进来要写理由**，不然就退回"照抄 VS Code"。
 */
const APPROX: Record<string, string> = {
  toml: 'VS Code 无 TOML 语法；ini 的 [节]/key=value/# 注释与 TOML 高度重合',
  conf: '同上（nginx/my.cnf/sshd_config 之类多为 ini 形态）',
  cfg: '同上',
  zsh: 'VS Code 的 shell 定义只声明 .sh/.bash；zsh 与 bash 同一族',
  ino: 'Arduino 草图 = C++；VS Code 的 cpp 定义未声明 .ino',
  plist: 'macOS 属性列表通常是 XML；VS Code 的 xml 定义未声明 .plist',
};

describe('预览语言表：路径识别', () => {
  it('常见文件按扩展名识别', () => {
    const cases: [string, string][] = [
      ['/Users/mock/proj/main.go', 'go'],
      ['/Users/mock/proj/README.md', 'markdown'],
      ['/a/b/index.tsx', 'typescript'],
      ['/a/b/app.mjs', 'javascript'],
      ['/a/b/pkg.json', 'json'],
      ['/a/b/conf.yml', 'yaml'],
      ['/a/b/Cargo.toml', 'ini'],
      ['/a/b/query.sql', 'sql'],
      ['/a/b/run.sh', 'shell'],
      ['/a/b/Dockerfile', 'dockerfile'],
      ['/a/b/Dockerfile.dev', 'plaintext'], // VS Code 也只认整名 Dockerfile
      ['/a/b/Makefile', 'plaintext'], // monaco 没有 makefile 语法
      ['/a/b/.gitignore', 'plaintext'], // 点开头 ≠ 扩展名
      ['/a/b/LICENSE', 'plaintext'],
      ['/a/b/archive.tar.gz', 'plaintext'],
    ];
    for (const [p, want] of cases) expect([p, langForPath(p)]).toEqual([p, want]);
  });

  it('大小写不敏感（扩展名与整文件名都是）', () => {
    expect(langForPath('/a/README.MD')).toBe('markdown');
    expect(langForPath('/a/Main.GO')).toBe('go');
    expect(langForPath('/a/DOCKERFILE')).toBe('dockerfile');
  });

  it('无扩展名的整文件名表（Dockerfile / Gemfile / .editorconfig）', () => {
    expect(langForPath('/a/Gemfile')).toBe('ruby');
    expect(langForPath('/a/.editorconfig')).toBe('ini');
    expect(Object.keys(FILE_LANG).length).toBeGreaterThan(0);
  });
});

describe('预览语言表：与 monaco 实际定义对齐', () => {
  it('每个加载器的目录都真实存在，且注册出来的 id 含表里的键', () => {
    const entries = loaderEntries();
    // 源码里必须每个 id 一条；对不上说明正则失配或表被改成了别的写法
    expect(entries.length).toBe(Object.keys(LANG_LOADERS).length);
    for (const { id, dir } of entries) {
      const file = join(DEFS_DIR, dir, 'register.js');
      expect([dir, existsSync(file)]).toEqual([dir, true]);
      const ids = definition(dir).flatMap((d) => d.ids);
      expect([id, ids.length > 0]).toEqual([id, true]);
      expect([id, dir, ids.includes(id)]).toEqual([id, dir, true]);
    }
  });

  it('表里每个 id 都能加载（没有"识别得出、加载不了"的半死状态）', () => {
    const missing = [...new Set(Object.values(EXT_LANG))].filter(
      (id) => !BUILTIN_LANGS.has(id) && !(id in LANG_LOADERS),
    );
    expect(missing).toEqual([]);
  });

  it('扩展名取值与 VS Code 的 extensions 表一致', () => {
    const byId = new Map<string, { exts: string[]; files: string[] }>();
    for (const dir of readdirSync(DEFS_DIR)) {
      if (!statSync(join(DEFS_DIR, dir)).isDirectory()) continue;
      if (!existsSync(join(DEFS_DIR, dir, 'register.js'))) continue;
      for (const d of definition(dir)) {
        for (const id of d.ids) byId.set(id, { exts: d.exts, files: d.files });
      }
    }
    const offenders: string[] = [];
    for (const [ext, id] of Object.entries(EXT_LANG)) {
      if (APPROX[ext]) continue;
      if (BUILTIN_LANGS.has(id)) continue; // json 在 language/json 里，不在 definitions/
      const vs = byId.get(id);
      if (!vs) {
        offenders.push(`${ext} → ${id}：definitions/ 里没有这门语言`);
        continue;
      }
      if (!vs.exts.includes(`.${ext}`)) {
        offenders.push(`${ext} → ${id}：VS Code 的 ${id} 只认 ${vs.exts.join(' ')}`);
      }
    }
    // 整文件名表同理（大小写不敏感，与 langForPath 的匹配方式一致）
    for (const [name, id] of Object.entries(FILE_LANG)) {
      const vs = byId.get(id);
      const files = (vs?.files ?? []).map((f) => f.toLowerCase());
      if (!files.includes(name)) offenders.push(`${name} → ${id}：VS Code 的 filenames 是 ${files.join(' ')}`);
    }
    expect(offenders).toEqual([]);
  });

  it('近似映射必须逐条写明理由（防止悄悄夹带私货）', () => {
    for (const [ext, why] of Object.entries(APPROX)) {
      expect([ext, why.trim().length > 0]).toEqual([ext, true]);
      expect([ext, ext in EXT_LANG]).toEqual([ext, true]);
    }
  });
});

describe('预览语言表：红线', () => {
  it('不许出现 Monaco 全语言注册（docs/10 §2.2）', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(p)) out.push(p);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      const text = stripComments(readFileSync(file, 'utf8'));
      // `import '...'`（副作用导入）也要拦：它既没有 from 也没有括号，
      // 只写 `(?:from|import\()` 会漏掉这一种 —— 实测漏过（反证跑出来的）。
      const re =
        /(?:from|import)\s*\(?\s*['"]monaco-editor\/(?:basic-languages|languages\/register\.all)/;
      if (re.test(text)) offenders.push(file.replace(`${SRC}/`, ''));
    }
    expect(offenders).toEqual([]);
  });
});
