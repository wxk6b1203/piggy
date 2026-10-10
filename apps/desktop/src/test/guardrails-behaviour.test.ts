// @vitest-environment node
/**
 * 随包分发的 pi-guardrails（`src-tauri/resources/pi-plugins/pi-guardrails/`）的**真实行为**测试。
 *
 * 为什么必须有这个文件：
 *   - 它是**覆盖型**插件 —— 用 pi 的公开 API 把内置 `write`（`atomicWrite: "write+edit"` 档还有
 *     `edit`）重新注册一遍，把「写前观察校验」塞进 `withFileMutationQueue` 临界区。
 *     它坏掉的样子**不是报错，而是静默失去护栏**：
 *     工具照常能写，提示词还在宣称"未读就写会被拦"。这种失效只有对着真源码跑真文件系统才看得见。
 *   - 确定性、不花模型调用、不联网、不需要本机装 pi：用 esbuild 把**随包源码**
 *     （`index.ts` + `src/*.ts`，含相对 import 的解析）打成一份自包含 ESM，再用 `data:` URL 加载；
 *     所有文件操作都在 `mkdtemp` 出来的临时目录里做，每个用例一套全新目录 + 全新插件实例。
 *
 * ── 组装方式，以及两处必须讲清楚的偏差 ────────────────────────────────────────
 *
 * 1. **宿主 API 用替身**（`HOST_API_STANDIN`）。
 *    需求里的方案是「`packages: "external"` + data: URL」——那条路能证明 type-only import 被抹掉，
 *    但**光靠它加载不起来**：`src/guard-atomic.ts:59` 有一句值导入
 *    `import { createEditToolDefinition, createWriteToolDefinition } from "@earendil-works/pi-coding-agent"`，
 *    而 data: URL 模块**解析不了裸包名**（实测 `ERR_UNSUPPORTED_RESOLVE_REQUEST`），
 *    随包目录里也没有 node_modules。所以这里用一个 esbuild 内联插件把**这一个**包名换成
 *    本文件里的替身，它只复刻 pi 公开的 `operations` 接缝
 *    （`createWriteToolDefinition` / `createEditToolDefinition` / `withFileMutationQueue`，
 *    调用顺序照 pi 的 `dist/core/tools/{write,edit,file-mutation-queue}.js`：正文本机对照的是
 *    1.1.0，插件 vendor 时声明的是 `>=0.87.1` —— 这两版在这个接缝上的顺序一致）。
 *    **被断言的所有判定逻辑 100% 是插件的真源码**（guard-write / guard-atomic / observation / publish）。
 *    （顺带：esbuild 的同步 API 不接受 plugins，所以下面用异步 `build()` 而非 `buildSync()`。）
 *    ⚠️ 这条替身**测不到**的事：pi 自己那份 `write`/`edit` 实现变了（接缝顺序、锁的粒度）
 *    而插件没跟着改 —— 那要真机探针（`scripts/pi-plugin-probe.mjs` 一类）才看得见。
 *    本文件钉的是**插件自己的判定**：拦不拦、按什么理由拦、放行之后文件有没有被写对。
 *
 * 2. **纠正一条写在需求里的错误前提**：`@earendil-works/pi-coding-agent` 不是"只能 import type"。
 *    它是 pi 扩展的**宿主虚拟模块**：pi 的加载器给 jiti 配了 alias
 *    （`dist/core/extensions/loader.js:62-70`，`"@earendil-works/pi-coding-agent": piCodingAgentEntry`），
 *    上游 package.json 也把它声明为 peerDependency；guard-atomic 必须拿到**真的**
 *    `createWriteToolDefinition` 才能重建内置工具 —— 改成 `import type` 插件直接不能用。
 *    仓库里已有同口径的规矩：`plugin-contract.test.ts` 的 `VIRTUAL` 集合把它算作虚拟模块。
 *    所以纪律被写成**可执行的两条**：
 *      a. 源码里除「宿主的这一个虚拟模块」「`node:` 内置模块」「相对路径」外，**不许出现任何其它依赖**
 *         （目标机器上没有 node_modules）；
 *      b. 用 esbuild 产物做**机械**判定：残留的裸导入必须恰好只有这一个包，且它的值导入面
 *         必须恰好是那两个工厂函数 —— 这同时证明了其余 import 都是 type-only（被 esbuild 抹掉）。
 *    若哪天有人真的把护栏的值导入删成 `import type`，第 7 条用例会红，而不是悄悄放行。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
/* 路径从 `src/test/` 数：`src/test/../../` = `apps/desktop/`（少一层会落到 `apps/` 上）。 */
const DIR = join(HERE, '..', '..', 'src-tauri', 'resources', 'pi-plugins', 'pi-guardrails');
const ENTRY = join(DIR, 'index.ts');
/** 宿主（pi）注入的虚拟模块名 —— 唯一允许出现的裸包名。 */
const HOST_API_PACKAGE = '@earendil-works/pi-coding-agent';
/** 插件在锁内重建内置工具时用到的公开接缝（pi 的 `operations`）—— 值导入只许是这两个。 */
const HOST_API_VALUE_EXPORTS = ['createEditToolDefinition', 'createWriteToolDefinition'];

/* ── esbuild：从 vite 的依赖树里解析（apps/desktop 没有直接声明 esbuild）───────────
   用 `createRequire` 而不是 `import 'esbuild'`：这样既不新增依赖，也不会让 tsc 去
   找一个不存在于本包 dependencies 里的包（`types` 只收 vite/client）。 */
const require_ = createRequire(import.meta.url);
const esbuild = require_(createRequire(require_.resolve('vite/package.json')).resolve('esbuild')) as {
  build(options: Record<string, unknown>): Promise<{ outputFiles?: Array<{ text?: string }> }>;
};

/* ══════════════════════════════════════════════════════════════════════════════
   pi 宿主 API 替身（只有这个替身；插件的判定逻辑一行都没有抄）
   ══════════════════════════════════════════════════════════════════════════════ */
const HOST_API_STANDIN = `
import { access as fsAccess, mkdir as fsMkdir, readFile as fsReadFile, realpath, writeFile as fsWriteFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

// pi 的 dist/core/tools/file-mutation-queue.js 的算法：同一路径串行，不同路径并行。
const queues = new Map();
let registrationQueue = Promise.resolve();
function isMissingPathError(e) {
  return typeof e === 'object' && e !== null && 'code' in e && (e.code === 'ENOENT' || e.code === 'ENOTDIR');
}
async function queueKey(filePath) {
  const resolved = resolve(filePath);
  try { return await realpath(resolved); } catch (e) { if (isMissingPathError(e)) return resolved; throw e; }
}
export async function withFileMutationQueue(filePath, fn) {
  const registration = registrationQueue.then(async () => {
    const key = await queueKey(filePath);
    const current = queues.get(key) ?? Promise.resolve();
    let release;
    const next = new Promise((res) => { release = res; });
    const chained = current.then(() => next);
    queues.set(key, chained);
    return { key: key, current: current, chained: chained, release: release };
  });
  registrationQueue = registration.then(() => undefined, () => undefined);
  const r = await registration;
  await r.current;
  try { return await fn(); }
  finally {
    r.release();
    if (queues.get(r.key) === r.chained) queues.delete(r.key);
  }
}

// pi 的 dist/core/tools/path-utils.js: resolveToCwd
export function resolveToCwd(filePath, cwd) {
  let p = filePath;
  if (p === '~') p = homedir();
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2));
  return isAbsolute(p) ? normalize(p) : resolve(cwd, p);
}

const defaultWriteOps = {
  writeFile: (path, content) => fsWriteFile(path, content, 'utf-8'),
  mkdir: (dir) => fsMkdir(dir, { recursive: true }).then(() => {}),
};
const defaultEditOps = {
  access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
  readFile: (path) => fsReadFile(path),
  writeFile: (path, content) => fsWriteFile(path, content, 'utf-8'),
};

// pi 的 dist/core/tools/write.js: mkdir → writeFile，两者都在 withFileMutationQueue 内。
export function createWriteToolDefinition(cwd, options) {
  const ops = (options && options.operations) || defaultWriteOps;
  return {
    name: 'write',
    label: 'write',
    description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const absolutePath = resolveToCwd(params.path, (ctx && ctx.cwd) || cwd);
      return withFileMutationQueue(absolutePath, async () => {
        if (signal && signal.aborted) throw new Error('Operation aborted');
        await ops.mkdir(dirname(absolutePath));
        if (signal && signal.aborted) throw new Error('Operation aborted');
        await ops.writeFile(absolutePath, params.content);
        if (signal && signal.aborted) throw new Error('Operation aborted');
        return { content: [{ type: 'text', text: 'Successfully wrote to ' + params.path }], details: undefined };
      });
    },
  };
}

// pi 的 dist/core/tools/edit.js: access → readFile → 文本替换 → writeFile（同一把锁内）。
export function createEditToolDefinition(cwd, options) {
  const ops = (options && options.operations) || defaultEditOps;
  return {
    name: 'edit',
    label: 'edit',
    description: 'Edit a single file using exact text replacement.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, edits: { type: 'array', items: { type: 'object' } } },
      required: ['path', 'edits'],
    },
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      if (!input || !Array.isArray(input.edits) || input.edits.length === 0) {
        throw new Error('Edit tool input is invalid. edits must contain at least one replacement.');
      }
      const absolutePath = resolveToCwd(input.path, (ctx && ctx.cwd) || cwd);
      return withFileMutationQueue(absolutePath, async () => {
        if (signal && signal.aborted) throw new Error('Operation aborted');
        try {
          await ops.access(absolutePath);
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? error.code : String(error);
          throw new Error('Could not edit file: ' + input.path + '. Error code: ' + code + '.');
        }
        const buffer = await ops.readFile(absolutePath);
        let next = buffer.toString('utf-8');
        for (const e of input.edits) {
          const at = next.indexOf(e.oldText);
          if (at === -1) throw new Error('The text to replace (' + e.oldText + ') was not found in the file.');
          if (next.indexOf(e.oldText, at + 1) !== -1) {
            throw new Error('The text to replace (' + e.oldText + ') is not unique in the file.');
          }
          next = next.slice(0, at) + e.newText + next.slice(at + e.oldText.length);
        }
        await ops.writeFile(absolutePath, next);
        return { content: [{ type: 'text', text: 'Successfully edited ' + input.path }], details: undefined };
      });
    },
  };
}
`;

/* ── 打包：entryPoints=index.ts，bundle，ESM，裸包一律 external ─────────────────── */
async function bundleSource(withHostStandIn: boolean): Promise<string> {
  const options: Record<string, unknown> = {
    entryPoints: [ENTRY],
    absWorkingDir: DIR,
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    /* 必须 external：随包目录没有 node_modules，esbuild 不能去解析它们。
       副作用是**残留的裸导入就是源码里的值导入**，第 7 条用例正靠这一点做机械判定。 */
    packages: 'external',
    logLevel: 'silent',
    charset: 'utf8',
  };
  if (withHostStandIn) {
    options.plugins = [
      {
        name: 'pi-host-api-stand-in',
        setup(build: {
          onResolve(o: { filter: RegExp }, cb: () => { path: string; namespace: string }): void;
          onLoad(o: { filter: RegExp; namespace: string }, cb: () => { contents: string; loader: string }): void;
        }): void {
          build.onResolve({ filter: /^@earendil-works\/pi-coding-agent$/ }, () => ({
            path: 'pi-host-api',
            namespace: 'piggy-standin',
          }));
          build.onLoad({ filter: /.*/, namespace: 'piggy-standin' }, () => ({
            contents: HOST_API_STANDIN,
            loader: 'js',
          }));
        },
      },
    ];
  }
  const result = await esbuild.build(options);
  const code = result.outputFiles?.[0]?.text;
  if (typeof code !== 'string' || code.length === 0) {
    /* 静默跳过是这个仓库最忌讳的失效方式：解析不了就红，并说清为什么。 */
    throw new Error('esbuild 没有产出代码（bundle 失败）。这条测试不允许被跳过。');
  }
  return code;
}

const dataUrl = (code: string): string => `data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`;

interface HostApi {
  createWriteToolDefinition(cwd: string, options?: unknown): RegisteredTool;
  createEditToolDefinition(cwd: string, options?: unknown): RegisteredTool;
}

interface ObservationRow {
  key: string;
  exists: boolean;
}

interface PluginInstance {
  config: { atomicWrite: string; enforceObservation: boolean };
  observations(): ObservationRow[];
}

interface CasOutcome {
  kind: 'ok' | 'blocked';
  code?: string;
  reason?: string;
}

interface PluginModule {
  default(pi: unknown, rawConfig?: unknown): PluginInstance;
  ObservationStore: new () => { observe(key: string, stamp: { exists: boolean; stamp: string }): void };
  DEFAULT_CONFIG: Record<string, unknown>;
  evidenceTest: {
    casCheck(
      key: string,
      rawPath: string,
      deps: Record<string, unknown>,
      opts: { allowCreate: boolean; tool: 'write' | 'edit' },
    ): Promise<CasOutcome>;
  };
}

let pluginModule: Promise<PluginModule> | undefined;
let hostApiModule: Promise<HostApi> | undefined;

/** 加载**随包源码**（含相对 import 的解析），缓存一次。 */
function loadPlugin(): Promise<PluginModule> {
  pluginModule ??= (async () => {
    const code = await bundleSource(true);
    const mod = (await import(dataUrl(code))) as PluginModule;
    if (typeof mod.default !== 'function') {
      throw new Error('随包 index.ts 的默认导出不是函数 —— 插件加载失败，测试不能静默跳过');
    }
    return mod;
  })();
  return pluginModule;
}

/** 替身模块本身（当作 pi 的**内置**工具用：插件没覆盖的工具，pi 走的就是这条路径）。 */
function loadHostApi(): Promise<HostApi> {
  hostApiModule ??= import(dataUrl(HOST_API_STANDIN)) as Promise<HostApi>;
  return hostApiModule;
}

/* ══════════════════════════════════════════════════════════════════════════════
   mock ExtensionAPI + 事件驱动（形状照上游 test/smoke.mjs 的 makeMockPi / emit）
   ══════════════════════════════════════════════════════════════════════════════ */
type Handler = (event: unknown, ctx: TestCtx) => unknown;

interface RegisteredTool {
  name: string;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: TestCtx,
  ): Promise<{ content?: Array<{ type: string; text?: string }> }>;
}

interface MockPi {
  handlers: Map<string, Handler[]>;
  tools: Map<string, RegisteredTool>;
  sent: unknown[];
  noopCalls: string[];
}

interface TestCtx {
  cwd: string;
  hasUI: boolean;
}

function makeMockPi(): MockPi {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, RegisteredTool>();
  const sent: unknown[] = [];
  const noopCalls: string[] = [];
  return { handlers, tools, sent, noopCalls };
}

/** 交给插件的 ExtensionAPI 门面（只实现插件真的会调的那几个，其余留痕免得静默）。 */
function makeExtensionApi(mock: MockPi, entryPath: string): unknown {
  const noop = (name: string) => () => {
    mock.noopCalls.push(name);
  };
  return {
    on(event: string, handler: Handler) {
      const list = mock.handlers.get(event) ?? [];
      list.push(handler);
      mock.handlers.set(event, list);
      /* 真实 pi 的 on() 返回退订函数；插件若用了它，这里也得能跑。 */
      return () => {
        const now = mock.handlers.get(event) ?? [];
        mock.handlers.set(
          event,
          now.filter((h) => h !== handler),
        );
      };
    },
    registerTool(definition: RegisteredTool) {
      mock.tools.set(definition.name, definition);
    },
    getAllTools() {
      return [...mock.tools.values()].map((t) => ({
        name: t.name,
        description: '',
        parameters: {},
        promptGuidelines: [],
        /* 形状照 pi 的 source-info：扩展工具的 path 是加载入口（本仓库里就是插件 index.ts） */
        sourceInfo: { path: entryPath, source: 'extension' },
      }));
    },
    sendMessage(message: unknown, options?: unknown) {
      mock.sent.push({ message, options });
    },
    sendUserMessage: noop('sendUserMessage'),
    appendEntry: noop('appendEntry'),
    registerCommand: noop('registerCommand'),
    registerShortcut: noop('registerShortcut'),
    registerFlag: noop('registerFlag'),
  };
}

/* ── 每个用例一个独立临时目录 ────────────────────────────────────────────────────
   cwd 必须 realpath 过：macOS 的 tmpdir() 是 /var/...（真身 /private/var/...），
   插件的路径规范化会 realpath，两边不一致会被误判成"未读"。 */
const tempDirs: string[] = [];

afterEach(() => {
  const base = realpathSync(tmpdir());
  for (const dir of tempDirs.splice(0)) {
    /* 只删我们自己 mkdtemp 出来、且在系统临时目录下的路径。 */
    if (!dir.startsWith(base + sep)) throw new Error(`拒绝删除非临时目录：${dir}`);
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  dir: string;
  ctx: TestCtx;
  pi: MockPi;
  instance: PluginInstance;
}

/** 全新临时目录 + 全新插件实例（观察表不跨用例串味）。 */
async function fresh(rawConfig?: Record<string, unknown>): Promise<Fixture> {
  const mod = await loadPlugin();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'piggy-guardrails-')));
  tempDirs.push(dir);
  const ctx: TestCtx = { cwd: dir, hasUI: false };
  const pi = makeMockPi();
  const instance = mod.default(makeExtensionApi(pi, ENTRY), rawConfig);
  return { dir, ctx, pi, instance };
}

/** 触发某事件的所有 handler，返回**最后一个非 undefined** 的结果（与上游 emit 同口径）。 */
async function emit(
  pi: MockPi,
  event: string,
  payload: unknown,
  ctx: TestCtx,
): Promise<{ block?: boolean; reason?: string } | undefined> {
  let result: { block?: boolean; reason?: string } | undefined;
  for (const handler of pi.handlers.get(event) ?? []) {
    const r = (await handler(payload, ctx)) as { block?: boolean; reason?: string } | undefined;
    if (r !== undefined) result = r;
  }
  return result;
}

/** 模拟一次 read 的 tool_result（观察表的唯一数据来源）。 */
async function doRead(pi: MockPi, ctx: TestCtx, path: string): Promise<void> {
  await emit(
    pi,
    'tool_result',
    {
      type: 'tool_result',
      toolName: 'read',
      toolCallId: `read-${path}`,
      input: { path },
      content: [{ type: 'text', text: 'content' }],
      isError: false,
      details: undefined,
    },
    ctx,
  );
}

type ToolOutcome =
  | { kind: 'hook-blocked'; reason: string }
  | { kind: 'ran'; impl: 'plugin' | 'builtin'; text?: string }
  | { kind: 'threw'; impl: 'plugin' | 'builtin'; error: string };

/**
 * 按 pi 的 runner 语义跑一次工具调用：先 `tool_call` 钩子，被 block 就不执行工具；
 * 否则执行**插件注册的那份定义**（覆盖成功）或 pi 的内置定义（没被覆盖）。
 */
async function callTool(
  fixture: Fixture,
  toolName: 'write' | 'edit',
  input: Record<string, unknown>,
): Promise<ToolOutcome> {
  const { pi, ctx } = fixture;
  const hook = await emit(
    pi,
    'tool_call',
    { type: 'tool_call', toolName, toolCallId: `call-${toolName}`, input },
    ctx,
  );
  if (hook?.block === true) return { kind: 'hook-blocked', reason: hook.reason ?? '' };

  const registered = pi.tools.get(toolName);
  const impl: 'plugin' | 'builtin' = registered ? 'plugin' : 'builtin';
  const hostApi = await loadHostApi();
  const tool =
    registered ??
    (toolName === 'write'
      ? hostApi.createWriteToolDefinition(ctx.cwd)
      : hostApi.createEditToolDefinition(ctx.cwd));
  try {
    const result = await tool.execute(`call-${toolName}`, input, undefined, undefined, ctx);
    return { kind: 'ran', impl, text: result.content?.[0]?.text };
  } catch (err) {
    return { kind: 'threw', impl, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   契约（每条一个 it；名字即契约本身）
   ══════════════════════════════════════════════════════════════════════════════ */
describe('随包 pi-guardrails 的写前校验契约（真源码 + 真文件系统）', () => {
  it('契约 1：edit 一个「已存在但没读过」的文件 → 拦下，reason 含 file has not been read', async () => {
    /* 为什么重要：这是整个护栏存在的理由。"没看过就改"是把模型的想象当成文件的事实，
       而它的失效方式不是报错 —— 是文件被静默改掉、模型和用户都不知道。 */
    const f = await fresh();
    writeFileSync(join(f.dir, 'a.txt'), 'hello\n');

    const r = await callTool(f, 'edit', { path: 'a.txt', edits: [{ oldText: 'hello', newText: 'bye' }] });

    expect(
      r.kind,
      '未读就改必须被拦下。默认档（atomicWrite="write"）下 edit 没被原子层覆盖，' +
        '所以这道闸在 hook 层；若这里是 threw 或 ran，说明默认档或两层分工变了 —— 请按新档位重读这条契约',
    ).toBe('hook-blocked');
    expect(r.kind === 'hook-blocked' ? r.reason : '').toMatch(/file has not been read/);
    expect(r.kind === 'hook-blocked' ? r.reason : '', '拦截文案必须给出可执行的修复动作').toMatch(
      /read the file, then retry/,
    );
    expect(readFileSync(join(f.dir, 'a.txt'), 'utf8'), '被拦下时文件一个字节都不能动').toBe('hello\n');
  });

  it('契约 2：write 一个「不存在」的文件 → 放行（创建新文件不受罚）', async () => {
    /* 为什么重要：拦截的权威在（锁内的）原子层，hook 层对 write 一律放行。
       若哪天 hook 层又开始对"无观察记录"下判断，模型写新文件就得先撞一次墙 ——
       这是刻意的契约变更（README 有记），不能悄悄退回去。 */
    const f = await fresh();

    const hook = await emit(
      f.pi,
      'tool_call',
      { type: 'tool_call', toolName: 'write', toolCallId: 'w1', input: { path: 'new.txt', content: 'hi\n' } },
      f.ctx,
    );
    expect(hook, 'hook 层必须放行：判断"文件是否存在"要 stat，而只有原子层能在锁内做这件事').toBeUndefined();

    const r = await callTool(f, 'write', { path: 'new.txt', content: 'brand new\n' });
    expect(r.kind, `创建新文件不该出错：${r.kind === 'threw' ? r.error : ''}`).toBe('ran');
    expect(r.kind === 'ran' ? r.impl : '', '走的是插件注册的覆盖版 write').toBe('plugin');
    expect(readFileSync(join(f.dir, 'new.txt'), 'utf8'), '文件要真的被创建').toBe('brand new\n');
  });

  it('契约 3：edit 一个「不存在」的文件 → 拦下，且不会把它创建出来', async () => {
    /* 为什么重要：edit 是"精确替换"，对不存在的文件没有任何东西可替换。
       若它被当作创建路径放行，模型会以为自己改的是某个已存在的文件（认知与事实不符）。 */
    const f = await fresh();
    const target = join(f.dir, 'nope.txt');

    const r = await callTool(f, 'edit', { path: 'nope.txt', edits: [{ oldText: 'a', newText: 'b' }] });
    expect(r.kind, 'edit 不存在的文件必须被拦下').toBe('hook-blocked');
    expect(r.kind === 'hook-blocked' ? r.reason : '').toMatch(/file has not been read|not found/);
    expect(existsSync(target), 'edit 绝不创建文件').toBe(false);

    /* 再往下钉一层：**锁内**的原子层自己也拒绝"确认缺席 → edit"。
       这里直接驱动它导出的测试接缝（index.ts 的 `evidenceTest`），
       观察表先按 evidence.ts 的做法记一条 absent（读不存在的文件的真实后果）。 */
    const mod = await loadPlugin();
    const store = new mod.ObservationStore();
    store.observe(target, { exists: false, stamp: 'absent' });
    const deps = {
      store,
      config: { ...mod.DEFAULT_CONFIG, atomicWrite: 'write+edit' },
      cwd: () => f.dir,
      allowResolver: async () => [],
      debug: () => {},
    };
    const asEdit = await mod.evidenceTest.casCheck(target, target, deps, { allowCreate: false, tool: 'edit' });
    expect(asEdit.kind, 'edit 意图对"确认缺席"必须拒绝').toBe('blocked');
    expect(asEdit.code, '理由码与 DSH 的 FS_NOT_FOUND 对齐').toBe('FS_NOT_FOUND');
    const asWrite = await mod.evidenceTest.casCheck(target, target, deps, { allowCreate: true, tool: 'write' });
    expect(asWrite.kind, '同一状态下的 write 意图允许创建（只有 write 走创建路径）').toBe('ok');
  });

  it('契约 4：先成功 read（记下观察）→ 之后 edit 同一文件 → 放行', async () => {
    /* 为什么重要：护栏必须是"可解开"的，否则它只会把模型推向 bash。
       这条同时钉住 read 的观察来源：证据层的 `tool_result`（不是 `tool_call`）。 */
    const f = await fresh();
    writeFileSync(join(f.dir, 'c.txt'), 'hello\n');

    const before = await callTool(f, 'edit', { path: 'c.txt', edits: [{ oldText: 'hello', newText: 'x' }] });
    expect(before.kind, '读之前必须先拦一次 —— 否则"放行"证明不了是 read 解开的').toBe('hook-blocked');

    await doRead(f.pi, f.ctx, 'c.txt');

    const after = await callTool(f, 'edit', { path: 'c.txt', edits: [{ oldText: 'hello', newText: 'goodbye' }] });
    expect(after.kind, `读过之后必须放行：${after.kind === 'threw' ? after.error : ''}`).toBe('ran');
    expect(
      after.kind === 'ran' ? after.impl : '',
      '默认档 atomicWrite="write"：edit 由 hook 层放行后走的是 pi 内置 edit（护栏是写前那道闸）。' +
        '若这里变成 plugin，说明默认档改成了 write+edit —— 那是另一套语义，请重读契约',
    ).toBe('builtin');
    expect(readFileSync(join(f.dir, 'c.txt'), 'utf8'), '放行之后要真的改成功').toBe('goodbye\n');
  });

  it('契约 5：read 工具本身、缺 path 的调用、非文件工具 → 一概不干预', async () => {
    /* 为什么重要：护栏越权（拦住只读工具或拦住参数非法的调用）会让 pi 自己的
       schema 校验/只读路径失效。缺 path 时插件必须让位，而不是按"未知路径"处理。 */
    const f = await fresh();
    writeFileSync(join(f.dir, 'd.txt'), 'x\n');

    const cases: Array<[string, Record<string, unknown>]> = [
      ['read', { path: 'd.txt' }],
      ['edit', {}],
      ['write', {}],
      ['bash', { command: 'cat d.txt' }],
      ['grep', { pattern: 'x' }],
    ];
    for (const [toolName, input] of cases) {
      const r = await emit(
        f.pi,
        'tool_call',
        { type: 'tool_call', toolName, toolCallId: `t-${toolName}`, input },
        f.ctx,
      );
      expect(r, `${toolName} 不该被写前校验拦住`).toBeUndefined();
    }
    /* 只读工具也不该把观察表写脏：观察只从 read 的 tool_result 来。 */
    expect(f.instance.observations(), '没有 read 就不该有任何观察记录').toEqual([]);
    /* 也不该往会话里插消息（护栏只该在"空响应兜底 / 连击提醒"时说话，写前校验不该说话）。 */
    expect(f.pi.sent, '写前校验不该发任何提醒消息').toEqual([]);
    expect(f.pi.noopCalls, '写前校验不该碰其它宿主 API').toEqual([]);
  });

  it('补充契约：write 一个「已存在但没读过」的文件 → hook 放行，锁内必须拦下', async () => {
    /* 为什么重要：这是契约 2 的**反面**，也是两层分工之间唯一的那道缝。
       hook 层对 write 一律放行（契约 2），于是"已存在但从未读过"只剩原子层这一道关。
       原子层若因为"hook 放行了"就跟着放行，write 会静默覆盖一个模型没看过的文件 ——
       正是这个插件要防的头号事故，而且不会有任何报错。 */
    const f = await fresh();
    writeFileSync(join(f.dir, 'precious.txt'), 'important\n');

    const hook = await emit(
      f.pi,
      'tool_call',
      {
        type: 'tool_call',
        toolName: 'write',
        toolCallId: 'w2',
        input: { path: 'precious.txt', content: 'clobbered\n' },
      },
      f.ctx,
    );
    expect(hook, 'hook 层不放行就说明契约 2 的前提变了').toBeUndefined();

    const r = await callTool(f, 'write', { path: 'precious.txt', content: 'clobbered\n' });
    expect(r.kind, 'hook 放行 ≠ 放行：原子层必须自己 stat 一次并在锁内拒绝').toBe('threw');
    expect(r.kind === 'threw' ? r.error : '').toMatch(/file has not been read/);
    expect(r.kind === 'threw' ? r.error : '', '理由码便于诊断').toMatch(/FS_NOT_OBSERVED/);
    expect(readFileSync(join(f.dir, 'precious.txt'), 'utf8'), '文件不能被覆盖').toBe('important\n');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════
   随包纪律（目标机器上很可能没有 node/npm）与注册（覆盖型插件最危险的失效）
   ══════════════════════════════════════════════════════════════════════════════ */
describe('随包 pi-guardrails 的随包纪律与注册', () => {
  it('纪律：只许依赖宿主虚拟模块 / node: 内置模块 / 相对路径（这个目录里没有 node_modules）', async () => {
    /* 为什么重要：这个目录是**最终产物**，会原样落到用户机器上。多一个裸包名就意味着
       目标机器上要有 node_modules；而 pi 只给扩展 alias 了它自己的那个包。 */
    const sources = [
      'index.ts',
      ...readdirSync(join(DIR, 'src'))
        .filter((n) => n.endsWith('.ts'))
        .sort()
        .map((n) => `src/${n}`),
    ];
    /* index.ts + src/ 下 9 个模块。数量对不上说明路径算错了（少扫一层就会漏掉全部 src）。 */
    expect(sources.length, '源文件数量不对，路径可能算错了').toBeGreaterThanOrEqual(10);

    let scanned = 0;
    for (const rel of sources) {
      const text = readFileSync(join(DIR, rel), 'utf8');
      /* 两种形态都要扫：`... from 'x'`（含 `export ... from`）与副作用导入 `import 'x'`。 */
      const specs = [
        ...[...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? ''),
        ...[...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1] ?? ''),
      ];
      scanned += specs.length;
      for (const spec of specs) {
        const ok =
          spec.startsWith('./') ||
          spec.startsWith('../') ||
          spec.startsWith('node:') ||
          spec === HOST_API_PACKAGE;
        expect(ok, `${rel}: 不允许的依赖 ${spec}（随包目录没有 node_modules，pi 只 alias 了 ${HOST_API_PACKAGE}）`).toBe(
          true,
        );
      }
    }
    /* 别让"扫了个寂寞"变成绿：一篇都没扫到就等于这条闸门不存在。
       （注意 src/config.ts 确实一个 import 都没有，所以判据放在总数上。） */
    expect(scanned, '一个 import/export 都没扫到 → 路径或正则算错了，这条闸门等于没跑').toBeGreaterThan(20);

    /* 机械判定（比正则可信）：`packages: "external"` 下，esbuild 产物里**残留的裸导入
       就是源码里的值导入** —— type-only import 会被抹掉。 */
    const raw = await bundleSource(false);
    const bare = [...raw.matchAll(/from\s*["']([^"']+)["']/g)]
      .map((m) => m[1] ?? '')
      .filter((s) => !s.startsWith('.') && !s.startsWith('node:'));
    expect(bare, '除宿主虚拟模块外的裸导入都会在目标机器上加载失败').toEqual([HOST_API_PACKAGE]);

    /* 值导入的"面"也钉死：只许用 pi 公开的两个工具工厂（锁内 CAS 的接缝）。
       要扩大这个面就得先改这条断言 —— 那是一次**写下来的**决定，而不是顺手加 import。 */
    const named = [...raw.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']@earendil-works\/pi-coding-agent["']/g)]
      .flatMap((m) => (m[1] ?? '').split(','))
      .map((s) => s.trim().replace(/^type\s+/, ''))
      .filter((s) => s.length > 0)
      .sort();
    expect(named, `值导入面变了：请确认真的需要这些宿主内部实现（当前：${HOST_API_VALUE_EXPORTS.join(', ')}）`).toEqual(
      [...HOST_API_VALUE_EXPORTS].sort(),
    );
  });

  it('注册：确实覆盖了内置工具，且清单的 allowlist:false 与之配套（注册失败＝静默失去护栏）', async () => {
    /* 为什么重要：pi 对同名扩展工具是"后注册者静默胜出"，注册失败时 pi 会**静默**回落到
       内置工具 —— 护栏看起来装了，其实一行都没跑。另外 `allowlist:false` 是权限档位的边界：
       把覆盖型插件并进限制档位的白名单，等于让"仅可查看"档凭空获得写权限。 */
    const std = await fresh();
    expect([...std.pi.tools.keys()].sort(), '默认档 atomicWrite="write"：只覆盖 write（edit 由 hook 层管）').toEqual([
      'write',
    ]);

    const both = await fresh({ atomicWrite: 'write+edit' });
    expect([...both.pi.tools.keys()].sort(), 'write+edit 档：两个内置工具都要覆盖').toEqual(['edit', 'write']);
    for (const tool of both.pi.tools.values()) {
      expect(typeof tool.execute, `${tool.name} 注册进来了却没有 execute`).toBe('function');
    }

    /* 插件自己会在首个回合核对注册归属，发现被顶替就把 atomicWrite 降级为 "off"
       （hook 层随即恢复 v1 检查）。这里确认自检**没有**误伤自己。
       事件形状照 pi：`before_agent_start` 带 `systemPromptOptions.sections`（prompt.ts 会写这里）。
       注意本文件的加载方式让 `import.meta.url` 成了 data: URL，guard-atomic 的 SELF_ROOT 因此
       算不出来，归属判定走的是 "sibling"（同包另一份实例）而不是生产环境的 "ours" —— 两者都
       等价于"可信"，所以这里断言的是**没有降级**这件事本身。 */
    const before = both.instance.config.atomicWrite;
    const promptSections: Record<string, unknown> = {};
    await emit(both.pi, 'before_agent_start', { type: 'before_agent_start', systemPromptOptions: { sections: promptSections } }, both.ctx);
    expect(both.instance.config.atomicWrite, '自检把护栏降级了 → 等于静默失去锁内 CAS').toBe(before);
    /* 提示词里宣称的护栏必须真的存在（插件自己的注释：降级后提示词仍在撒谎是最危险的形态）。 */
    expect(String(promptSections.guardrails ?? ''), '护栏没写进系统提示词').toMatch(/read-before-write|before writing/i);

    const manifest = JSON.parse(readFileSync(join(DIR, 'piggy-plugin.json'), 'utf8')) as {
      tools: string[];
      allowlist: boolean;
    };
    const builtins = new Set(['read', 'write', 'edit', 'bash', 'powershell', 'grep', 'find', 'ls']);
    expect([...manifest.tools].sort(), '清单申报的工具名').toEqual(['edit', 'write']);
    for (const name of manifest.tools) {
      expect(builtins.has(name), `${name} 不是 pi 内置工具名：申报一个不存在的名字等于骗模型`).toBe(true);
    }
    expect(
      manifest.allowlist,
      '申报了内置工具名就必须 allowlist:false —— 否则限制档位的白名单里会多出写权限',
    ).toBe(false);
  });
});
