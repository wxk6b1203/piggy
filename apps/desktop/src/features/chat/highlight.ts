/**
 * 语法高亮基础设施（04 §5.2、05 §3.5/§5.5）：**语言表 / 别名 / 语言嗅探 / diff 行分类**。
 * 全部是纯函数与静态表，不碰 React —— 于是可以在 Node 里逐条真实 import 验证。
 *
 * ## 为什么语言表必须是**字面量**，不能是模板字符串
 *
 * 旧实现是 `import(`shiki/langs/${id}.mjs`)`。裸说明符 + 变量，Vite 的
 * dynamic-import-vars **不分析裸说明符**，这段代码被原样留在产物里；真浏览器执行
 * 抛 `TypeError: Failed to resolve module specifier 'shiki/langs/go.mjs'`。而调用点
 * 外面套着 `.catch(() => setHtml(null))` —— 异常被吞掉，静默降级成纯文本。
 *
 * 净效果：**高亮从来没有生效过，而且控制台一条错误都没有**。真机实测（用户正在跑的
 * dev server）：`hasShiki:false, spanCount:0`，`<pre>` 里就是纯文本。
 *
 * 所以这里逐个写死 `import('shiki/langs/x.mjs')`：Vite 静态可分析 → 每个语言一个独立
 * chunk，仍然是"按需下载、绝不全量打包"（初始包不含任何语法），但**真的能下载到**。
 * `src/test/codeblock.test.tsx` 里有一条源码门专门盯这个反模式，防止有人"顺手简化"回去。
 */

/* ------------------------------------------------------------------ 语言表 */

type Loader = () => Promise<unknown>;

/**
 * 覆盖写代码时会遇到的语言。这不是"支持列表"——不在表里的语言照样能显示，只是不高亮
 * （见 `resolveLangId`）。每项都是独立 chunk，加一个不会拖慢首屏。
 */
const LOADERS = {
  diff: () => import('shiki/langs/diff.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  shellsession: () => import('shiki/langs/shellsession.mjs'),
  console: () => import('shiki/langs/console.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  json5: () => import('shiki/langs/json5.mjs'),
  jsonl: () => import('shiki/langs/jsonl.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  csv: () => import('shiki/langs/csv.mjs'),
  log: () => import('shiki/langs/log.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  mdx: () => import('shiki/langs/mdx.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  regexp: () => import('shiki/langs/regexp.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
  cmake: () => import('shiki/langs/cmake.mjs'),
  nginx: () => import('shiki/langs/nginx.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  hcl: () => import('shiki/langs/hcl.mjs'),
  nix: () => import('shiki/langs/nix.mjs'),
  dotenv: () => import('shiki/langs/dotenv.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  sass: () => import('shiki/langs/sass.mjs'),
  stylus: () => import('shiki/langs/stylus.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  astro: () => import('shiki/langs/astro.mjs'),
  'vue-html': () => import('shiki/langs/vue-html.mjs'),
  'vue-directives': () => import('shiki/langs/vue-directives.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  pug: () => import('shiki/langs/pug.mjs'),
  handlebars: () => import('shiki/langs/handlebars.mjs'),
  liquid: () => import('shiki/langs/liquid.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  zig: () => import('shiki/langs/zig.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  groovy: () => import('shiki/langs/groovy.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  perl: () => import('shiki/langs/perl.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  julia: () => import('shiki/langs/julia.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  erlang: () => import('shiki/langs/erlang.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  clojure: () => import('shiki/langs/clojure.mjs'),
  ocaml: () => import('shiki/langs/ocaml.mjs'),
  scheme: () => import('shiki/langs/scheme.mjs'),
  lisp: () => import('shiki/langs/lisp.mjs'),
  fsharp: () => import('shiki/langs/fsharp.mjs'),
  nim: () => import('shiki/langs/nim.mjs'),
  viml: () => import('shiki/langs/viml.mjs'),
  awk: () => import('shiki/langs/awk.mjs'),
  protobuf: () => import('shiki/langs/protobuf.mjs'),
  tex: () => import('shiki/langs/tex.mjs'),
  matlab: () => import('shiki/langs/matlab.mjs'),
  asm: () => import('shiki/langs/asm.mjs'),
  wasm: () => import('shiki/langs/wasm.mjs'),
  solidity: () => import('shiki/langs/solidity.mjs'),
  'git-commit': () => import('shiki/langs/git-commit.mjs'),
  'git-rebase': () => import('shiki/langs/git-rebase.mjs'),
  'angular-html': () => import('shiki/langs/angular-html.mjs'),
  'angular-ts': () => import('shiki/langs/angular-ts.mjs'),
} satisfies Record<string, Loader>;

export type LangId = keyof typeof LOADERS;

/** 只用于测试与调试：语言表里到底有哪些 id。 */
export const LANG_IDS = Object.keys(LOADERS) as LangId[];

/** 取某个语言的模块加载器；未收录返回 undefined。 */
export function langLoader(id: string): Loader | undefined {
  return (LOADERS as Record<string, Loader>)[id];
}

/* --------------------------------------------------------------- 别名归一 */

/** 围栏上人类会写的写法 → 语言表里的规范 id（04 §5.2）。`''` = 明确不高亮。 */
const ALIASES: Record<string, LangId | ''> = {
  // 文本/数据
  yml: 'yaml',
  md: 'markdown',
  ndjson: 'jsonl',
  patch: 'diff',
  'git-diff': 'diff',
  // shell 家族：bash/sh/zsh 都是 shellscript 语法
  bash: 'shellscript',
  sh: 'shellscript',
  zsh: 'shellscript',
  ksh: 'shellscript',
  shell: 'shellscript',
  'shell-script': 'shellscript',
  terminal: 'shellsession',
  'sh-session': 'shellsession',
  // JS 家族
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  node: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  // 其他常见缩写
  py: 'python',
  python3: 'python',
  rb: 'ruby',
  rs: 'rust',
  golang: 'go',
  kt: 'kotlin',
  kts: 'kotlin',
  cs: 'csharp',
  'c#': 'csharp',
  'c++': 'cpp',
  cxx: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  objc: 'objective-c',
  'objective-c++': 'objective-c',
  ps1: 'powershell',
  pwsh: 'powershell',
  docker: 'dockerfile',
  containerfile: 'dockerfile',
  make: 'makefile',
  mk: 'makefile',
  tf: 'hcl',
  terraform: 'hcl',
  proto: 'protobuf',
  htm: 'html',
  xhtml: 'html',
  styl: 'stylus',
  hs: 'haskell',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  ml: 'ocaml',
  fs: 'fsharp',
  pl: 'perl',
  jl: 'julia',
  // 明确表示"不要高亮"
  text: '',
  txt: '',
  plain: '',
  plaintext: '',
  none: '',
  output: '',
};

/** normalize 的产物：'' 表示"确定不高亮"，null 表示"不认识这个语言"。 */
export type LangResolution =
  | { kind: 'lang'; id: LangId }
  | { kind: 'plain' }
  | { kind: 'unknown'; raw: string };

const FENCE_ID_RE = /^[a-z0-9+#._-]+$/i;

/**
 * 把围栏标签（或文件扩展名）归一成语言表 id。
 *
 * 三种结果分得很清楚，因为界面对它们的说法不一样：
 *  `lang`    已知 → 高亮；`plain` 明确要求不高亮；`unknown` 不认识 → 明说"未收录"。
 * 旧实现把 unknown 和"加载失败"都变成 `setHtml(null)`，用户看到的都是纯文本却
 * 不知道是哪种情况 —— 这正是"没有高亮"看起来像样式问题、实际是加载失败的原因。
 */
export function resolveLangId(raw: string): LangResolution {
  const s = (raw ?? '').trim().toLowerCase();
  if (!s || !FENCE_ID_RE.test(s)) return { kind: 'plain' };
  const alias = ALIASES[s];
  if (alias === '') return { kind: 'plain' };
  if (alias && langLoader(alias)) return { kind: 'lang', id: alias };
  if (langLoader(s)) return { kind: 'lang', id: s as LangId };
  return { kind: 'unknown', raw: s };
}

/* ------------------------------------------------------------------- diff */

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

const META_RE = /^(diff --git|diff --|index |new file|deleted file|old mode|new mode|similarity index|rename (from|to)|copy (from|to)|Binary files|GIT binary patch|\\)/;

/**
 * 逐行判定 unified diff 的语义（**"部分高亮"**：整块语法高亮之外，还要让增/删/块头
 * 一眼分得出来）。
 *
 * 顺序很关键：`+++`/`---` 是**文件头**不是增删行，必须先判掉，否则 `+++ b/x.go`
 * 会被当成"新增了一行 `++ b/x.go`"。
 */
export function diffLineKind(line: string): DiffLineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  if (META_RE.test(line)) return 'meta';
  return 'ctx';
}

const DIFF_GIT_RE = /^diff --git /m;
const DIFF_HUNK_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
const DIFF_HEADER_PAIR_RE = /^--- .+\n\+\+\+ /m;

/**
 * 这段文本是不是 unified diff。
 *
 * `git diff` 的输出没有任何元数据告诉我们是 diff（pi 的 toolResult 只给 toolName 和
 * 正文），所以只能看内容。三条判据都与**行首**锚定，避免把正文里随口提到的
 * "--- " 误判成 diff。
 */
export function looksLikeDiff(text: string): boolean {
  if (!text) return false;
  return DIFF_GIT_RE.test(text) || DIFF_HUNK_RE.test(text) || DIFF_HEADER_PAIR_RE.test(text);
}

/* ------------------------------------------------- 工具结果的语言嗅探 */

/** 跑命令类工具的 toolName（pi：`bash`；留几个别名以防换后端）。 */
const SHELL_TOOLS = new Set(['bash', 'shell', 'sh', 'zsh', 'execute', 'exec', 'run', 'terminal', 'command']);

export interface ToolLang {
  /** 传给 CodeBlock 的原始标签（'' = 不高亮）。 */
  lang: string;
  /** 判定依据，用于界面提示与测试断言；`none` 表示只能当纯文本。 */
  source: 'diff' | 'shell' | 'none';
}

/**
 * 猜工具结果该用什么语言高亮。
 *
 * 只有两条可靠依据，其余一律老实承认不知道：
 *  1. **内容像 diff** —— 任何工具都可能吐 diff（截图里就是 `bash` 跑 `git diff`）；
 *  2. **toolName 是跑命令的** —— 输出按 shell 语法上色。
 *
 * 已知缺口（不要假装覆盖了）：`read`/`write` 的结果体**不含路径**（真机取样确认：
 * toolResult 只有 `toolCallId/toolName/content/details/isError`），所以没法按文件
 * 扩展名选语言；历史会话里也没有 `tool_execution_start` 事件可以回填参数。
 * 与其猜错颜色，不如保持纯文本。
 */
export function inferToolLang(toolName: string | undefined, text: string): ToolLang {
  if (looksLikeDiff(text)) return { lang: 'diff', source: 'diff' };
  const n = (toolName ?? '').trim().toLowerCase();
  if (SHELL_TOOLS.has(n)) return { lang: 'shellscript', source: 'shell' };
  return { lang: '', source: 'none' };
}

/* ------------------------------------------------------------- 展示辅助 */

/**
 * 折叠阈值：超过这个行数就**默认折叠**（只留标题栏），点开才渲染。
 * 值是权衡出来的：一屏大约 20 行，翻倍再多一点，让"刚好一屏多点"的输出不至于
 * 一进来就被折起来。
 */
export const AUTO_COLLAPSE_LINES = 40;

/**
 * 单块渲染上限。超过就**显式截断并说明**（rule 21：绝不做用户够不到的静默截断），
 * 由用户点"显示全部"再放开。这个上限只为防病态 DOM，正常输出碰不到。
 */
export const MAX_RENDER_LINES = 4000;

/** 行数（末尾换行不算一行，`a\n` 与 `a` 都是 1 行）。 */
export function countLines(code: string): number {
  if (!code) return 0;
  return code.replace(/\n$/, '').split('\n').length;
}
