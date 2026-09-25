/**
 * 从 pi 源码生成 Piggy 的提供商目录（`src-tauri/src/provider/catalog_generated.rs`）。
 *
 * 为什么要有这个脚本：pi 的 RPC **没有**「列出所有提供商」这条命令
 * （`packages/coding-agent/src/modes/rpc/rpc-types.ts` 的 RpcCommand 联合里
 * 只有 set_model / cycle_model / get_available_models，后者的
 * `getAvailableSnapshot()` 只返回**已配置可用**的模型）。而配置页恰恰需要
 * 展示"还没配置的那些"。所以目录必须在编译期固化，而固化的数据必须**来自 pi
 * 自己的源码**，不能靠人肉抄写或猜测——抄错一个 id，用户就会写出一个 pi 认不出的
 * provider（本项目真实踩过同类静默失效：auth.json 的字段名写成 api_key）。
 *
 * 取四处事实（每处都是 pi 的单一真相来源）：
 *   - `types.ts` 的 `KnownProvider` 联合   → 合法 provider id 全集；
 *   - `providers/all.ts` 的 builtinProviders() → id 与实现文件的对应 + 顺序；
 *   - `providers/<x>.ts` 的 createProvider({...}) → name / baseUrl / api；
 *   - `env-api-keys.ts` 的 envMap + 特例分支   → 该 provider 读哪个环境变量。
 *
 * 用法：
 *   node scripts/gen-provider-catalog.mjs <pi 源码根>            # 写文件
 *   node scripts/gen-provider-catalog.mjs <pi 源码根> --check     # 只比对，不写（CI/复核用）
 * 例：node scripts/gen-provider-catalog.mjs /Users/wxk/Documents/Project/pi
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, '../src-tauri/src/provider/catalog_generated.rs');

const piRoot = process.argv[2];
const checkOnly = process.argv.includes('--check');
if (!piRoot) {
  console.error('用法: node scripts/gen-provider-catalog.mjs <pi 源码根> [--check]');
  process.exit(2);
}
const ai = join(piRoot, 'packages/ai/src');
for (const p of ['types.ts', 'env-api-keys.ts', 'providers/all.ts']) {
  if (!existsSync(join(ai, p))) {
    console.error(`找不到 ${join(ai, p)}——第二个参数要指向 pi 仓库根目录`);
    process.exit(2);
  }
}

/* ---------- 1. KnownProvider 联合 → 合法 id 全集（保持源码顺序） ---------- */
const typesTs = readFileSync(join(ai, 'types.ts'), 'utf8');
const unionBody = /export type KnownProvider =([\s\S]*?);/.exec(typesTs)?.[1] ?? '';
const knownProviders = [...unionBody.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (knownProviders.length < 20) throw new Error('KnownProvider 解析失败');

/* ---------- 2. providers/all.ts → 顺序 + id↔文件 ---------- */
const allTs = readFileSync(join(ai, 'providers/all.ts'), 'utf8');
const imports = new Map(); // factoryName -> 相对文件名
for (const m of allTs.matchAll(/import \{ (\w+) \} from "\.\/([\w.-]+)\.ts"/g)) {
  imports.set(m[1], m[2]);
}
const order = [];
for (const m of allTs.matchAll(/^\t+(\w+)\(\),$/gm)) {
  const file = imports.get(m[1]);
  if (file) order.push(file);
}
if (order.length < 20) throw new Error('builtinProviders() 解析失败');

/* ---------- 3. api/*.lazy.ts → 工厂名 → 协议 id（协议 id 就是文件名） ---------- */
const apiDir = join(ai, 'api');
const apiOfFactory = new Map();
for (const f of readdirSync(apiDir)) {
  const mm = /^([\w-]+)\.lazy\.ts$/.exec(f);
  if (!mm) continue;
  const body = readFileSync(join(apiDir, f), 'utf8');
  const fn = /export const (\w+) = /.exec(body)?.[1];
  if (fn) apiOfFactory.set(fn, mm[1]);
}

/* ---------- 4. env-api-keys.ts → provider → 环境变量 ---------- */
const envTs = readFileSync(join(ai, 'env-api-keys.ts'), 'utf8');
const envMap = new Map();
const mapBody = /const envMap: Record<string, string> = \{([\s\S]*?)\n\t\};/.exec(envTs)?.[1] ?? '';
// 键有时带引号（"ant-ling"）有时不带（openai）——两种都要认，否则会静默漏掉一半
for (const m of mapBody.matchAll(/"?([\w-]+)"?:\s*"(\w+)"/g)) envMap.set(m[1], m[2]);
// 特例分支（不查 envMap，写在函数体里；里面用的是常量名，要解开）
const consts = new Map();
for (const m of envTs.matchAll(/^const (\w+_ENV) = "(\w+)";$/gm)) consts.set(m[1], m[2]);
for (const m of envTs.matchAll(/^export const (\w+_ENV) = "(\w+)";$/gm)) consts.set(m[1], m[2]);
const special = new Map();
for (const m of envTs.matchAll(/if \(provider === "([\w-]+)"\) \{\s*return \[([^\]]*)\];/g)) {
  const vars = [...m[2].matchAll(/(?:"(\w+)"|(\w+))/g)]
    .map((x) => x[1] ?? consts.get(x[2]))
    .filter(Boolean);
  if (vars.length) special.set(m[1], vars);
}
if (envMap.size < 20) throw new Error('envMap 解析失败');

/* ---------- 组装 ---------- */
// 少数提供商不是用 `createProvider({...})` 字面量构造的（radius 是动态网关），
// 源码里读不到 name/api 就在这里显式列出，并注明出处——不做猜测。
const MANUAL = {
  radius: { name: 'Radius', api: 'pi-messages' }, // providers/radius.ts:23-25,34（options.name ?? "Radius" / piMessagesApi()）
};
const rows = [];
for (const file of order) {
  const src = readFileSync(join(ai, 'providers', `${file}.ts`), 'utf8');
  const body = /createProvider(?:<[^>]*>)?\(\{([\s\S]*?)\n\t\}\);/.exec(src)?.[1] ?? src;
  const id = /(?:^|\s)id:\s*"([^"]+)"/.exec(body)?.[1] ?? file;
  const manual = MANUAL[id] ?? {};
  const name = /(?:^|\s)name:\s*"([^"]+)"/.exec(body)?.[1] ?? manual.name ?? id;
  const baseUrl = /(?:^|\s)baseUrl:\s*"([^"]+)"/.exec(body)?.[1] ?? '';
  // `api:` 有三种写法：单协议 `api: xApi(),`、多协议映射 `api: { "a": xApi(), … }`、
  // 包装 `api: cloudflareStreams(openAICompletionsApi())`。多协议映射的键就是协议 id
  // （最可靠），其余从工厂函数名反查 api/*.lazy.ts 的文件名。
  const apiExpr = /(?:^|\s)api:\s*(\{[\s\S]*?\n\t\t\}|[^\n]*)/.exec(body)?.[1] ?? '';
  const apis = [];
  for (const m of apiExpr.matchAll(/"([a-z][\w-]+)":/g)) apis.push(m[1]);
  for (const m of apiExpr.matchAll(/(\w+Api)\(/g)) {
    const a = apiOfFactory.get(m[1]);
    if (a) apis.push(a);
  }
  // 多协议提供商（fireworks/openrouter/opencode…）的 `api` 只是 models.json 里的默认值，
  // 取哪个当默认会影响「获取可用模型」打的列举端点：OpenAI 系在 `{base}/models`，
  // Anthropic 系在 `{root}/v1/models`。前者最通用，所以按下面的优先级挑默认值，
  // 并把 pi 声明的全部协议留给界面当选项。
  const PREFER = ['openai-completions', 'openai-responses', 'anthropic-messages'];
  const uniq = [...new Set(apis)];
  const api = PREFER.find((p) => uniq.includes(p)) ?? uniq[0] ?? manual.api ?? '';
  const envAll = special.get(id) ?? (envMap.has(id) ? [envMap.get(id)] : []);
  // anthropic 一个分支列了三个变量；pi 取密钥时会跳过 ANTHROPIC_AUTH_TOKEN
  // （env-api-keys.ts getEnvApiKey：`envKeys.find(k => k !== ANTHROPIC_AUTH_TOKEN_ENV)`），
  // 所以展示/探测都用 *_API_KEY 那个，别把 Bearer token 当成 API key。
  const envVar = envAll.find((v) => v.endsWith('_API_KEY')) ?? envAll[0] ?? '';
  rows.push({ id, name, baseUrl, api, envVar, envAll, apis: uniq });
}
// KnownProvider 里有、builtinProviders() 里没有的（纯动态提供商，如 radius）
const have = new Set(rows.map((r) => r.id));
for (const id of knownProviders) {
  if (have.has(id)) continue;
  const envAll = envMap.has(id) ? [envMap.get(id)] : [];
  rows.push({ id, name: MANUAL[id]?.name ?? id, baseUrl: '', api: MANUAL[id]?.api ?? '', envVar: envAll[0] ?? '', envAll, apis: [] });
}

/* ---------- 1b. KnownApi 联合 → 合法协议 id 全集 ---------- */
const knownApis = [...(/export type KnownApi =([\s\S]*?);/.exec(typesTs)?.[1] ?? '').matchAll(/"([^"]+)"/g)].map((m) => m[1]);
if (knownApis.length < 5) throw new Error('KnownApi 解析失败');

const dup = rows.map((r) => r.id).filter((id, i) => rows.findIndex((r) => r.id === id) !== i);
if (dup.length) throw new Error(`id 重复：${dup.join(', ')}`);

const piVersion = (() => {
  try {
    return readFileSync(join(piRoot, 'packages/coding-agent/package.json'), 'utf8').match(/"version":\s*"([^"]+)"/)?.[1] ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();
let piCommit = 'unknown';
try {
  piCommit = execFileSync('git', ['-C', piRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  /* 不是 git 仓库就留 unknown：这只是溯源信息，不该让生成失败 */
}

const rstr = (s) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const body = rows
  .map(
    (r) =>
      `    C { id: ${rstr(r.id)}, name: ${rstr(r.name)}, base_url: ${rstr(r.baseUrl)}, api: ${rstr(r.api)}, ` +
      `env_var: ${rstr(r.envVar)}, apis: &[${r.apis.map(rstr).join(', ')}] },`,
  )
  .join('\n');

const out = `// @generated by apps/desktop/scripts/gen-provider-catalog.mjs —— 请勿手改，改脚本后重跑。
//
// 数据来源：pi v${piVersion}（git ${piCommit}）
//   packages/ai/src/types.ts            KnownProvider 联合（合法 id 全集）
//   packages/ai/src/providers/all.ts    builtinProviders()（顺序 + id↔实现文件）
//   packages/ai/src/providers/*.ts      createProvider({ id, name, baseUrl, api })
//   packages/ai/src/env-api-keys.ts     envMap / 特例分支（该 provider 读哪个环境变量）
//
// 字段含义与"空值代表什么"见 catalog.rs；这里只陈述 pi 源码里写了什么，
// 不替 pi 做任何推断（没写 baseUrl 就是空串，不猜）。
//
// 重新生成：node apps/desktop/scripts/gen-provider-catalog.mjs <pi 源码根>

use super::CatalogEntry as C;

/// pi ${piVersion} 的提供商目录，${rows.length} 条，顺序 = \`builtinProviders()\` 的顺序。
pub const CATALOG: &[C] = &[
${body}
];

/// pi 认识的 API 协议（\`types.ts\` 的 \`KnownApi\`），${knownApis.length} 条。
/// pi 的 \`Api\` 类型是 \`KnownApi | (string & {})\` —— 自定义协议字符串也合法，
/// 所以这只是"界面默认给哪些选项"，不是白名单。
pub const KNOWN_APIS: &[&str] = &[${knownApis.map(rstr).join(', ')}];
`;

if (checkOnly) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  // 只比对数据行：头部的版本/git 号会随本地仓库状态变化，不参与比对
  const dataLines = (s) => s.split('\n').filter((l) => l.trimStart().startsWith('C {')).join('\n');
  if (dataLines(current) !== dataLines(out)) {
    console.error('❌ 目录与 pi 源码不一致（--check）');
    process.exit(1);
  }
  console.log(`✅ 目录一致（${rows.length} 条）`);
} else {
  writeFileSync(OUT, out);
  console.log(`已写出 ${OUT}（${rows.length} 条，pi ${piVersion} git ${piCommit}）`);
}
