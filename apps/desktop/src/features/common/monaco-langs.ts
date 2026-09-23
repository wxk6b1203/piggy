/**
 * 预览语言表（docs/10 §2.2）：**路径 → Monaco 语言 id** + **语言定义的按需加载器**。
 *
 * 为什么需要这张表：Monaco 的 ESM 发行版**一门语言都不带**，`editor.api` 只有核心编辑器。
 * 在补上这张表之前，`monaco-setup.ts` 只静态引了 json，于是除 `.json` 外的所有文件都是纯文本
 * —— 用户截图里 `README.md` 一行都不上色，而头部语言条还理直气壮地写着 `markdown`。
 *
 * 三条纪律（都由测试兜底，见 `src/test/preview-lang.test.ts`）：
 *
 *  ① `import()` 的说明符**必须是字符串字面量**。裸说明符 + 模板变量在 Vite 里不会被解析，
 *     而且**构建期连一条 warning 都不给**，要到运行期才抛
 *     `Failed to resolve module specifier` —— 聊天代码块的高亮就是这样静默死了很久
 *     （docs/15 规则 22）。这里每门语言一个真字面量，Vite 才会为它切**独立 chunk**，
 *     只有真的打开该语言的文件时才下载；没打开的语言一个字节都不下。
 *
 *  ② 禁 `basic-languages/monaco.contribution` / `languages/register.all`（一次注册 84 门），
 *     docs/08 §4 / docs/10 §2.2 的红线，由 lint 强制（apps/desktop/eslint.config.js）。
 *
 *  ③ 表里的 id 必须与 monaco 的**定义目录**对得上。多数同名，少数不是（值是目录名）：
 *     `proto` ← protobuf、`sol` ← solidity、`coffeescript` ← coffee、`c` ← cpp。
 *     写错了不会报错、只会**静默退回纯文本**，所以测试直接对着 node_modules 里的
 *     定义目录核 id 与扩展名（`src/test/preview-lang.test.ts`）。
 *
 * 范围：常见语言 55 门（含 go/rust/python/ts/md/json/yaml/toml/sql/sh/dockerfile 这些
 * 会话里真会打开的东西）。**没列到的语言 = 纯文本，这就是全部代价**；要加一门，
 * 往下面两张表各加一行即可，不需要动别的地方。
 */

/** 没有独立定义的语言：`plaintext` 是 Monaco 核心自带的兜底，`json` 由 monaco-setup 静态注册
 * （JSON 用的是带 worker 的语言服务，见 §3.3 的 schema 校验，不走 definitions/）。 */
export const BUILTIN_LANGS = new Set(['plaintext', 'json']);

/**
 * 语言 id → 加载器。**每个 `import()` 都是字面量**（纪律 ①），别改成变量。
 * 值里的路径是 monaco 的**定义目录名**，与键（语言 id）不必同名，见纪律 ③。
 */
export const LANG_LOADERS: Record<string, () => Promise<unknown>> = {
  // —— Web / 前端 ——
  typescript: () => import('monaco-editor/languages/definitions/typescript/register'),
  javascript: () => import('monaco-editor/languages/definitions/javascript/register'),
  coffeescript: () => import('monaco-editor/languages/definitions/coffee/register'),
  html: () => import('monaco-editor/languages/definitions/html/register'),
  css: () => import('monaco-editor/languages/definitions/css/register'),
  scss: () => import('monaco-editor/languages/definitions/scss/register'),
  less: () => import('monaco-editor/languages/definitions/less/register'),
  // —— 模板 ——
  handlebars: () => import('monaco-editor/languages/definitions/handlebars/register'),
  twig: () => import('monaco-editor/languages/definitions/twig/register'),
  pug: () => import('monaco-editor/languages/definitions/pug/register'),
  liquid: () => import('monaco-editor/languages/definitions/liquid/register'),
  // —— 文档 / 配置 ——
  markdown: () => import('monaco-editor/languages/definitions/markdown/register'),
  mdx: () => import('monaco-editor/languages/definitions/mdx/register'),
  yaml: () => import('monaco-editor/languages/definitions/yaml/register'),
  ini: () => import('monaco-editor/languages/definitions/ini/register'),
  xml: () => import('monaco-editor/languages/definitions/xml/register'),
  restructuredtext: () => import('monaco-editor/languages/definitions/restructuredtext/register'),
  // —— 后端 ——
  python: () => import('monaco-editor/languages/definitions/python/register'),
  go: () => import('monaco-editor/languages/definitions/go/register'),
  rust: () => import('monaco-editor/languages/definitions/rust/register'),
  java: () => import('monaco-editor/languages/definitions/java/register'),
  c: () => import('monaco-editor/languages/definitions/cpp/register'),
  cpp: () => import('monaco-editor/languages/definitions/cpp/register'),
  csharp: () => import('monaco-editor/languages/definitions/csharp/register'),
  php: () => import('monaco-editor/languages/definitions/php/register'),
  ruby: () => import('monaco-editor/languages/definitions/ruby/register'),
  kotlin: () => import('monaco-editor/languages/definitions/kotlin/register'),
  swift: () => import('monaco-editor/languages/definitions/swift/register'),
  scala: () => import('monaco-editor/languages/definitions/scala/register'),
  dart: () => import('monaco-editor/languages/definitions/dart/register'),
  // —— 函数式 / 科研 ——
  lua: () => import('monaco-editor/languages/definitions/lua/register'),
  perl: () => import('monaco-editor/languages/definitions/perl/register'),
  r: () => import('monaco-editor/languages/definitions/r/register'),
  julia: () => import('monaco-editor/languages/definitions/julia/register'),
  elixir: () => import('monaco-editor/languages/definitions/elixir/register'),
  clojure: () => import('monaco-editor/languages/definitions/clojure/register'),
  fsharp: () => import('monaco-editor/languages/definitions/fsharp/register'),
  scheme: () => import('monaco-editor/languages/definitions/scheme/register'),
  // —— 数据 / 接口 ——
  sql: () => import('monaco-editor/languages/definitions/sql/register'),
  graphql: () => import('monaco-editor/languages/definitions/graphql/register'),
  proto: () => import('monaco-editor/languages/definitions/protobuf/register'),
  redis: () => import('monaco-editor/languages/definitions/redis/register'),
  // —— 运维 / 底层 ——
  shell: () => import('monaco-editor/languages/definitions/shell/register'),
  powershell: () => import('monaco-editor/languages/definitions/powershell/register'),
  bat: () => import('monaco-editor/languages/definitions/bat/register'),
  dockerfile: () => import('monaco-editor/languages/definitions/dockerfile/register'),
  hcl: () => import('monaco-editor/languages/definitions/hcl/register'),
  wgsl: () => import('monaco-editor/languages/definitions/wgsl/register'),
  systemverilog: () => import('monaco-editor/languages/definitions/systemverilog/register'),
  // —— 其它常见 ——
  pascal: () => import('monaco-editor/languages/definitions/pascal/register'),
  vb: () => import('monaco-editor/languages/definitions/vb/register'),
  'objective-c': () => import('monaco-editor/languages/definitions/objective-c/register'),
  sol: () => import('monaco-editor/languages/definitions/solidity/register'),
  tcl: () => import('monaco-editor/languages/definitions/tcl/register'),
  typespec: () => import('monaco-editor/languages/definitions/typespec/register'),
};

/**
 * 扩展名（小写、不含点）→ 语言 id。
 *
 * 取值**抄 VS Code 自己的 `extensions` 表**（就是上面那些定义目录里的 register.js），
 * 不做"我觉得更合适"的发挥 —— 两边不一致时测试会红。少数刻意近似（VS Code 里没有对应
 * 语言，但落在纯文本太亏）标了 `≈`，测试对它们放行。
 */
export const EXT_LANG: Record<string, string> = {
  // Web / 前端
  ts: 'typescript', tsx: 'typescript', cts: 'typescript', mts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', es6: 'javascript',
  coffee: 'coffeescript',
  html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'scss', less: 'less',
  // 模板
  handlebars: 'handlebars', hbs: 'handlebars',
  twig: 'twig', pug: 'pug', jade: 'pug', liquid: 'liquid',
  // 文档 / 配置
  json: 'json', // 由 monaco-setup 静态注册（带 worker 的 JSON 语言服务），不在这张加载表里
  md: 'markdown', markdown: 'markdown', mdown: 'markdown', mkd: 'markdown',
  mdx: 'mdx',
  yaml: 'yaml', yml: 'yaml',
  ini: 'ini', properties: 'ini', gitconfig: 'ini',
  toml: 'ini', // ≈ VS Code 无 TOML 语法；ini 的 [节]/key=value/# 注释与之高度重合
  conf: 'ini', cfg: 'ini', // ≈ 同上（nginx/my.cnf 之类大多是 ini 形态）
  xml: 'xml', xsd: 'xml', dtd: 'xml', svg: 'xml', plist: 'xml',
  csproj: 'xml', props: 'xml', targets: 'xml', xaml: 'xml', config: 'xml',
  rst: 'restructuredtext',
  // 后端
  py: 'python', pyw: 'python', rpy: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ino: 'cpp',
  cs: 'csharp', csx: 'csharp',
  php: 'php', phtml: 'php', php4: 'php', php5: 'php',
  rb: 'ruby', gemspec: 'ruby',
  kt: 'kotlin', kts: 'kotlin',
  swift: 'swift',
  scala: 'scala', sc: 'scala', sbt: 'scala',
  dart: 'dart',
  // 函数式 / 科研
  lua: 'lua',
  pl: 'perl', pm: 'perl',
  r: 'r', rmd: 'r',
  jl: 'julia',
  ex: 'elixir', exs: 'elixir',
  clj: 'clojure', cljs: 'clojure', cljc: 'clojure', edn: 'clojure',
  fs: 'fsharp', fsi: 'fsharp', fsx: 'fsharp', ml: 'fsharp', mli: 'fsharp',
  scm: 'scheme', ss: 'scheme', rkt: 'scheme',
  // 数据 / 接口
  sql: 'sql',
  graphql: 'graphql', gql: 'graphql',
  proto: 'proto',
  redis: 'redis',
  // 运维 / 底层
  sh: 'shell', bash: 'shell',
  zsh: 'shell', // ≈ VS Code 的 shell 定义只声明 .sh/.bash；zsh 语法是同一族
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  bat: 'bat', cmd: 'bat',
  dockerfile: 'dockerfile',
  tf: 'hcl', tfvars: 'hcl', hcl: 'hcl',
  wgsl: 'wgsl',
  sv: 'systemverilog', svh: 'systemverilog',
  // 其它常见
  pas: 'pascal', p: 'pascal',
  vb: 'vb',
  m: 'objective-c',
  sol: 'sol',
  tcl: 'tcl',
  tsp: 'typespec',
};

/**
 * 无扩展名（或点开头）的**整文件名** → 语言 id。键一律小写匹配。
 * 同样抄 VS Code 的 `filenames` 表（dockerfile/ini/ruby/javascript 四门有这张表）。
 */
export const FILE_LANG: Record<string, string> = {
  dockerfile: 'dockerfile',
  '.gitattributes': 'ini', '.gitconfig': 'ini', '.editorconfig': 'ini',
  gemfile: 'ruby', rakefile: 'ruby',
  jakefile: 'javascript',
};

const PLAINTEXT = 'plaintext';

/** 路径 → Monaco 语言 id。认不出 = `plaintext`（不加载任何语言 chunk）。 */
export function langForPath(path: string): string {
  const cut = path.lastIndexOf('/');
  const base = (cut < 0 ? path : path.slice(cut + 1)).toLowerCase();
  const byName = FILE_LANG[base];
  if (byName) return byName;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return PLAINTEXT; // 无扩展名，或 .gitignore 这类点开头文件
  return EXT_LANG[base.slice(dot + 1)] ?? PLAINTEXT;
}

/** 该语言是否需要现加载定义（`plaintext`/`json` 不用）。 */
export function needsLoad(langId: string): boolean {
  return !BUILTIN_LANGS.has(langId) && langId in LANG_LOADERS;
}
