# pi 配置与扩展参考（源码级）

> **来源与可信度**：本文由子代理对 `/Users/wxk/Documents/Project/pi`（v0.87.1）逐文件阅读生成，
> 每条结论都带 `file:line`。其中对 Piggy 影响最大的几条（`auth.json` 字段名、release 资产命名、
> `--tools` 的过滤范围、扩展 `tool_call` 钩子能否阻止执行）已由我独立复核源码确认，
> 并在 `docs/17-pi-permissions-and-packaging.md` §3 记录了由此修掉的缺陷。
> 未复核的细节以「Uncertain」一节列出，请勿当契约使用。
>
> 用途：改 Piggy 里任何碰 `~/.pi/agent/*.json`、provider 环境变量、扩展发现或 RPC 命令的代码前，
> 先查这里，不要靠猜。


Scope: `/Users/wxk/Documents/Project/pi`, code on disk only. Paths are repo-relative.
`process.env` scan command used throughout:

```
grep -rn "process\.env" packages/*/src packages/session-backends/*/src | grep -v node_modules
```

Per-package counts: `coding-agent: 94`, `tui: 30`, `evals: 16`, `ai: 8`, `agent: 4`,
`durable: 4`, `session-backends: 0`, `chord: 0`, `client: 0`, `protocol: 0`, `server: 0`,
`telemetry: 0`.

---

## 1. Every environment variable pi reads

### 1.1 Dynamically-computed names (read this first)

`APP_NAME` and the config dir come from `package.json` `piConfig`, so the env var names
are computed, not literal:

```
packages/coding-agent/src/config.ts:500  const piConfigName: string | undefined = pkg.piConfig?.name;
packages/coding-agent/src/config.ts:502  export const APP_NAME: string = piConfigName || "pi";
packages/coding-agent/src/config.ts:504  export const CONFIG_DIR_NAME: string = pkg.piConfig?.configDir || ".pi";
packages/coding-agent/src/config.ts:508  export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
packages/coding-agent/src/config.ts:509  export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;
```

This checkout has `packages/coding-agent/package.json:6-8`: `"piConfig": { "configDir": ".pi" }`
and no `name`, so today `APP_NAME === "pi"` and the two names are
`PI_CODING_AGENT_DIR` / `PI_CODING_AGENT_SESSION_DIR`. A fork that sets
`piConfig.name = "tau"` reads `TAU_CODING_AGENT_DIR` / `TAU_CODING_AGENT_SESSION_DIR` instead.

### 1.2 Pi configuration variables

| Env var | file:line | What it does |
|---|---|---|
| `PI_CODING_AGENT_DIR` | def `config.ts:508`; read `config.ts:529` | Overrides the agent dir: `const envDir = process.env[ENV_AGENT_DIR]; if (envDir) return expandTildePath(envDir);` else `join(homedir(), CONFIG_DIR_NAME, "agent")` (`config.ts:533`). Also read in `cli/startup-ui.ts:135` (suppresses first-time setup), `evals/src/docker.ts:69`, `evals/src/harness.ts:83`. |
| `PI_CODING_AGENT_SESSION_DIR` | def `config.ts:509`; read `main.ts:675` | Session storage dir; lowest of the three session-dir sources — `main.ts:676-679`: `--session-dir` → env → `startupSettingsManager.getSessionDir()`. |
| `PI_PACKAGE_DIR` | `config.ts:391` | Overrides the package dir (`getPackageDir()`), for Nix/Guix store paths: `const envDir = process.env.PI_PACKAGE_DIR;` |
| `PI_OFFLINE` | `main.ts:569,571`; `version-check.ts:55`; `package-manager.ts:54`; `tools-manager.ts:15`; `model-runtime.ts:197`; `experimental/radius-auth.ts:36`; `modes/interactive/bug-report.ts:56`; `modes/interactive/interactive-mode.ts:1082,1197,1293` | Disables network activity. `main.ts:569-572` also seeds it from `--offline` and forces `PI_SKIP_VERSION_CHECK`: `const offlineMode = args.includes("--offline") \|\| isTruthyEnvFlag(process.env.PI_OFFLINE);` … `process.env.PI_OFFLINE = "1"; process.env.PI_SKIP_VERSION_CHECK = "1";`. Note mixed semantics: `model-runtime.ts:197` uses `process.env.PI_OFFLINE === undefined` and `radius-auth.ts:36` uses `!== undefined`, while `version-check.ts:55` uses a truthy/`return` check — so `PI_OFFLINE=0` still disables model-catalog/radius networking. |
| `PI_SKIP_VERSION_CHECK` | `utils/version-check.ts:98` | `if (process.env.PI_SKIP_VERSION_CHECK) return undefined;` — skips the pi.dev latest-version request. Set by `main.ts:572`. |
| `PI_EXPERIMENTAL` | `core/experimental.ts:2` | `return process.env.PI_EXPERIMENTAL === "1";` — gates experimental features. |
| `PI_TELEMETRY` | `core/telemetry.ts:10` | `telemetryEnv: string \| undefined = process.env.PI_TELEMETRY,` → `telemetry.ts:12` `return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();` |
| `PI_SHARE_VIEWER_URL` | `config.ts:519` | ``const baseUrl = process.env.PI_SHARE_VIEWER_URL \|\| DEFAULT_SHARE_VIEWER_URL;`` (default `https://pi.dev/session/`, `config.ts:515`) — `/share` base URL. |
| `PI_TIMING` | `core/timings.ts:6` | `const ENABLED = process.env.PI_TIMING === "1";` — startup timing instrumentation. |
| `PI_STARTUP_BENCHMARK` | `main.ts:914` | `const startupBenchmark = isTruthyEnvFlag(process.env.PI_STARTUP_BENCHMARK);`; `main.ts:916` errors unless interactive. |
| `PI_MANAGED_INSTALL_ROOT` | `package-manager-cli.ts:55` | `const configuredRoot = process.env.PI_MANAGED_INSTALL_ROOT?.trim();` — marks a managed install. |
| `PI_INSTALLER_API_BASE` | `package-manager-cli.ts:189` | `(process.env.PI_INSTALLER_API_BASE?.trim() \|\| DEFAULT_INSTALLER_API_BASE)` (default `https://pi.dev/api/installer/releases`, `package-manager-cli.ts:50`). |
| `PI_RADIUS_GATEWAY` | def `core/radius.ts:4`; read `radius.ts:8` | `return normalizeRadiusGatewayUrl(process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY);` |
| `PI_CACHE_RETENTION` | `ai/src/api/openai-responses.ts:62`, `pi-messages.ts:352`, `anthropic-messages.ts:64`, `bedrock-converse-stream.ts:819`, `openai-completions.ts:293`; `coding-agent/src/core/cache-warmer.ts:42` | `getProviderEnvValue("PI_CACHE_RETENTION", env) === "long"` — extended prompt caching. |
| `PI_HARDWARE_CURSOR` | `core/settings-manager.ts:1370` | `getShowHardwareCursor()`: `return this.settings.showHardwareCursor ?? process.env.PI_HARDWARE_CURSOR === "1";` (setting wins over env). |
| `PI_CLEAR_ON_SHRINK` | `core/settings-manager.ts:1240` | `getClearOnShrink()`: `return process.env.PI_CLEAR_ON_SHRINK === "1";` (used only when the setting is undefined, `settings-manager.ts:1237`). |
| `PI_OAUTH_CALLBACK_HOST` | `ai/src/auth/oauth/anthropic.ts:32`, `openai-codex.ts:45`, `openrouter.ts:26` | `getProviderEnvValue("PI_OAUTH_CALLBACK_HOST") \|\| "127.0.0.1"` — OAuth loopback bind host. |
| `PI_SERVER_DIR`, `PI_SERVER_ID` | def `experimental/server.ts:51,52`; read `server.ts:55`, `server.ts:530`, `server.ts:715`, `experimental/client-runtime.ts:86` | `resolveServerDirectory`: `directory ?? process.env[ENV_SERVER_DIR] ?? join(homedir(), ".pi", "server")`. |
| `PI_SESSION_WORKER_CONTROL_ADDRESS`, `PI_SESSION_WORKER_CONTROL_TOKEN`, `PI_SESSION_WORKER_SESSION_KEY_BASE64`, `PI_SESSION_WORKER_PEER_ID` | def `experimental/session-worker.ts:68-71`; read `session-worker.ts:344-348`, `529-530`, `795-796` | Internal session-worker handshake values. |
| `__PI_SESSION_WORKER_INITIAL_DEMAND_GRACE_MS`, `__PI_SESSION_WORKER_ORPHAN_DEMAND_GRACE_MS` | def `experimental/session-worker.ts:319-320` | Worker demand grace periods. |
| `__PI_INTERNAL_SPAWN` | def `experimental/process.ts:6`; read `process.ts:22` | `const role = process.env[INTERNAL_PROCESS_ENV];` — internal process role; deleted after read (`process.ts:31`). |
| `PI_EVAL_VARIANT`, `PI_EVAL_CONTAINER` | `evals/src/harness.ts:488`, `harness.ts:526` | Eval harness variant/container flags. |
| `AI_AGENT`, `PI_CODING_AGENT` | **written, not read** — `cli/setup.ts:6-7`, `rpc-entry.ts:7-8` | `process.env.PI_CODING_AGENT = "true"; process.env.AI_AGENT = "pi";` Process markers for child processes. |
| `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`, `PI_REASONING_LEVEL` | **written, not read** — `core/tools/bash.ts:178-192` | Session metadata injected into LLM-callable shell tools: `env.PI_SESSION_ID = ctx.sessionManager.getSessionId();` … `env.PI_REASONING_LEVEL = ctx.thinkingLevel;`. Deleted first (`bash.ts:178-182`) so nested pi processes do not inherit stale values. |

### 1.3 TUI variables (`packages/tui/src`)

| Env var | file:line | What it does |
|---|---|---|
| `PI_TUI_ESC_TIMEOUT` | `tui/src/terminal.ts:124` | `const configured = Number(env.PI_TUI_ESC_TIMEOUT);` — lone-ESC reassembly window; defaults 100 ms over SSH, else 10 ms (`terminal.ts:115-116`, `129-132`). |
| `PI_TUI_WRITE_LOG` | `tui/src/terminal.ts:150` | `const env = process.env.PI_TUI_WRITE_LOG \|\| "";` — raw terminal write log path/dir. |
| `PI_TUI_DEBUG` | `tui/src/tui-main-screen.ts:569` | `if (process.env.PI_TUI_DEBUG === "1") {` — debug output. |
| `PI_TUI_DEBUG_REDRAW` | `tui/src/tui-main-screen.ts:321` | `process.env.PI_TUI_DEBUG_REDRAW === "1" ? this.logDirectory : undefined` — redraw logging. |
| `PI_HYPERLINKS` | `tui/src/terminal-image.ts:140` | `parseBooleanCapabilityOverride(process.env.PI_HYPERLINKS)` — `1`/`0`/auto OSC-8 override. |
| `PI_IMAGE_PROTOCOL` | `tui/src/terminal-image.ts:144` | `process.env.PI_IMAGE_PROTOCOL?.toLowerCase()` — `kitty`/`iterm2`/`none`. |
| `PI_TRUE_COLOR` | `tui/src/terminal-image.ts:151` | `parseBooleanCapabilityOverride(process.env.PI_TRUE_COLOR)`. |

### 1.4 Ambient environment variables pi reads (not pi-specific)

Grouped; each is a real read I verified.

- `VISUAL`, `EDITOR` — `core/settings-manager.ts:991` (`const environmentEditor = process.env.VISUAL || process.env.EDITOR;`, falls back to `notepad`/`nano` at `:995`) and `modes/interactive/components/extension-editor.ts:59-60`.
- `HTTP_PROXY`, `HTTPS_PROXY` — `core/http-dispatcher.ts:48-49` (`process.env.HTTP_PROXY ??= proxy; process.env.HTTPS_PROXY ??= proxy;`), fed from the `httpProxy` setting at `main.ts:587`.
- Terminal/tmux/ssh/CI detection — `core/bug-report.ts:76-84` (`SHELL`, `TERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `COLORTERM`, `TMUX`, `SSH_CONNECTION`/`SSH_CLIENT`/`SSH_TTY`, `CI`); `modes/interactive/interactive-mode.ts:1215` (`TMUX`).
- Terminal capability detection — `tui/src/terminal-image.ts:70-109` (`TERM_PROGRAM`, `TERMINAL_EMULATOR`, `TERM`, `COLORTERM`, `TMUX`, `KITTY_WINDOW_ID`, `GHOSTTY_RESOURCES_DIR`, `WEZTERM_PANE`, `WARP_SESSION_ID`, `WARP_TERMINAL_SESSION_UUID`, `ITERM_SESSION_ID`, `WT_SESSION`); `tui/src/tui-alt-screen.ts:352-358,1004,1718` (`TERM`, `TMUX`, `ZELLIJ`, `STY`, `TERM_PROGRAM`, `WEZTERM_PANE`); `tui/src/keys.ts:717` (`WT_SESSION`, `SSH_*`); `tui/src/native-platform.ts:61` (`DISPLAY`); `tui/src/terminal.ts:38` (`TERM_PROGRAM === "Apple_Terminal"`).
- Size fallbacks — `tui/src/terminal.ts:482,486` (`COLUMNS`, `LINES`).
- Termux / WSL / Wayland — `tui/src/tui-main-screen.ts:110` and `coding-agent/src/utils/clipboard.ts:57` (`TERMUX_VERSION`); `core/footer-data-provider.ts:84` (`WSL_DISTRO_NAME`, `WSL_INTEROP`); `utils/wsl.ts:5` (`WSL_DISTRO_NAME`, `WSLENV`); `utils/clipboard-image.ts:22`, `utils/clipboard.ts:58-59` (`WAYLAND_DISPLAY`, `DISPLAY`).
- Terminal theme — `modes/interactive/theme/theme.ts:667-668` (`COLORFGBG`).
- Home / cwd display — `core/trust-manager.ts:186` (`process.env.HOME || homedir()`), `core/package-manager.ts:222`, `modes/interactive/components/footer.ts:116` (`HOME`, `USERPROFILE`), `components/tree-selector.ts:948`, `v4l`… Windows: `utils/shell.ts:79,83,221` (`ProgramFiles`, `ProgramFiles(x86)`, `SystemRoot`), `utils/tools-manager.ts:209` (`SystemRoot`, `WINDIR`), `agent/src/harness/env/nodejs.ts:213-215,265`, `durable/src/env/node.ts:213-215,265`.
- Child-process env passing / PATH — `utils/shell.ts:140-147` (`const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") ?? "PATH";` and `...process.env`), `experimental/process.ts:60`, `modes/rpc/rpc-client.ts:96`.
- `PNPM_HOME` — `config.ts:135`: `` `--config.global-bin-dir=${process.env.PNPM_HOME || dirname(dirname(match[1]))}` `` for the pnpm self-update path.
- Llama / Hugging Face — `extensions/llama/provider.ts:114,117` (`LLAMA_BASE_URL`), `provider.ts:141` (`LLAMA_API_KEY`), `extensions/llama/huggingface.ts:46-54` (`HF_TOKEN`, `HF_TOKEN_PATH`, `HF_HOME`, `XDG_CACHE_HOME`).

### 1.5 `NO_COLOR` — DOES NOT EXIST

```
$ grep -rn "NO_COLOR\|FORCE_COLOR" packages/*/src packages/session-backends/*/src | grep -v node_modules
(no output, exit 1)
$ grep -rn "NO_COLOR" packages/ --include=*.ts --include=*.md --include=*.json | grep -v node_modules
(no output)
```

Color handling goes through `chalk` with no pi-level `NO_COLOR`/`FORCE_COLOR` override.

---

## 2. Provider API key env vars (`packages/ai/src`)

### 2.1 Generic resolver (the fallback)

```
packages/ai/src/utils/provider-env.ts:45  export function getProviderEnvValue(name: string, env?: ProviderEnv): string | undefined {
packages/ai/src/utils/provider-env.ts:47  	env?.[name] ||
packages/ai/src/utils/provider-env.ts:48  	(typeof process !== "undefined" ? process.env[name] : undefined) ||
packages/ai/src/utils/provider-env.ts:49  	getBunSandboxEnvValue(name) ||
```

So the generic chain is: **credential-scoped `env` override → `process.env` → `/proc/self/environ` fallback** for Bun sandboxes (`provider-env.ts:15-39`). `ProviderEnv` is `Record<string, string>` and documented as taking precedence over `process.env` (`ai/src/types.ts:119-120`).

`defaultProviderAuthContext()` (`ai/src/auth/context.ts:23-28`) is the other generic read:
`const value = getProcessEnv()?.[name]; return typeof value === "string" && value.trim().length > 0 ? value : undefined;`

There is **no catch-all `PI_API_KEY` / `AI_API_KEY`** variable. Unknown/custom providers get keys only from `models.json` `apiKey`, a stored `auth.json` credential, or `--api-key`.

### 2.2 Provider id → env var

Two mechanisms. `envApiKeyAuth(name, envVars)` (`ai/src/auth/helpers.ts:9`) resolves
stored credential first, then the first set env var:
`helpers.ts:20-26` — `if (credential?.key) { ... }` / `const value = await ctx.env(envVar);` / `if (value) return { auth: { apiKey: value }, source: envVar };`

Per-provider call sites (each is the literal mapping):

| Provider id | Env var | file:line |
|---|---|---|
| `openai` | `OPENAI_API_KEY` | `ai/src/providers/openai.ts:11` |
| `anthropic` | `ANTHROPIC_API_KEY` (+ `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`) | `ai/src/env-api-keys.ts:29-31`; custom resolve `providers/anthropic.ts:24-37` |
| `google` | `GEMINI_API_KEY` | `ai/src/providers/google.ts:11` |
| `google-vertex` | `GOOGLE_CLOUD_API_KEY` (+ ADC) | `ai/src/providers/google-vertex.ts:71-72` |
| `azure-openai-responses` | `AZURE_OPENAI_API_KEY` | `ai/src/providers/azure-openai-responses.ts:10` |
| `github-copilot` | `COPILOT_GITHUB_TOKEN` | `ai/src/env-api-keys.ts:70`; `providers/github-copilot.ts:15` |
| `deepseek` | `DEEPSEEK_API_KEY` | `providers/deepseek.ts:11` |
| `groq` | `GROQ_API_KEY` | `providers/groq.ts:11` |
| `cerebras` | `CEREBRAS_API_KEY` | `providers/cerebras.ts:11` |
| `xai` | `XAI_API_KEY` | `providers/xai.ts:13` |
| `mistral` | `MISTRAL_API_KEY` | `providers/mistral.ts:11` |
| `nvidia` | `NVIDIA_API_KEY` | `providers/nvidia.ts:11` |
| `openrouter` | `OPENROUTER_API_KEY` | `providers/openrouter.ts:14`, `providers/openrouter-images.ts:12` |
| `vercel-ai-gateway` | `AI_GATEWAY_API_KEY` | `providers/vercel-ai-gateway.ts:11` |
| `zai` / `zai-coding-cn` | `ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY` | `providers/zai.ts:11`, `providers/zai-coding-cn.ts:11` |
| `minimax` / `minimax-cn` | `MINIMAX_API_KEY` / `MINIMAX_CN_API_KEY` | `providers/minimax.ts:11`, `providers/minimax-cn.ts:11` |
| `moonshotai` / `moonshotai-cn` | `MOONSHOT_API_KEY` | `providers/moonshotai.ts:11`, `providers/moonshotai-cn.ts:11` |
| `kimi-coding` | `KIMI_API_KEY` | `providers/kimi-coding.ts:13` |
| `meta` | `META_API_KEY` | `providers/meta.ts:13` |
| `huggingface` | `HF_TOKEN` | `providers/huggingface.ts:11` |
| `fireworks` | `FIREWORKS_API_KEY` | `providers/fireworks.ts:12` |
| `together` | `TOGETHER_API_KEY` | `providers/together.ts:11` |
| `baseten` | `BASETEN_API_KEY` | `providers/baseten.ts:11` |
| `opencode` / `opencode-go` | `OPENCODE_API_KEY` | `providers/opencode.ts:16`, `providers/opencode-go.ts:13` |
| `ant-ling` | `ANT_LING_API_KEY` | `providers/ant-ling.ts:11` |
| `xiaomi` | `XIAOMI_API_KEY` | `providers/xiaomi.ts:11` |
| `xiaomi-token-plan-{cn,ams,sgp}` | `XIAOMI_TOKEN_PLAN_{CN,AMS,SGP}_API_KEY` | `providers/xiaomi-token-plan-cn.ts:11`, `-ams.ts:11`, `-sgp.ts:11` |
| `qwen-token-plan` / `-cn` / `-individual` | `QWEN_TOKEN_PLAN_API_KEY` / `QWEN_TOKEN_PLAN_CN_API_KEY` / `QWEN_TOKEN_PLAN_API_KEY` | `providers/qwen-token-plan.ts:11`, `-cn.ts:11`, `-individual.ts:11` |
| `radius` | `RADIUS_API_KEY` | `providers/radius.ts:37` |
| `cloudflare-workers-ai`, `cloudflare-ai-gateway` | `CLOUDFLARE_API_KEY` (+ `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_GATEWAY_ID`) | `providers/cloudflare-auth.ts:4-6,37-40` |
| `amazon-bedrock` | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`+`AWS_SECRET_ACCESS_KEY`, `AWS_CONTAINER_CREDENTIALS_*`, `AWS_WEB_IDENTITY_TOKEN_FILE` | `providers/amazon-bedrock.ts:64-77` |
| `llama` (extension) | `LLAMA_BASE_URL`, `LLAMA_API_KEY` | `coding-agent/src/extensions/llama/provider.ts:114,141` |
| `faux` | none (keyless) | `providers/faux.ts:691` |

The same map also exists centrally as `getApiKeyEnvVars()`:

```
packages/ai/src/env-api-keys.ts:79  	const envMap: Record<string, string> = {
packages/ai/src/env-api-keys.ts:84  		openai: "OPENAI_API_KEY",
packages/ai/src/env-api-keys.ts:88  		google: "GEMINI_API_KEY",
packages/ai/src/env-api-keys.ts:119 	const envVar = envMap[provider];
packages/ai/src/env-api-keys.ts:120 	return envVar ? [envVar] : undefined;
```

`getEnvApiKey()` (`env-api-keys.ts:145-189`) is the legacy/generic entry point; for
`anthropic` it deliberately skips `ANTHROPIC_AUTH_TOKEN` because it must be sent as a
`Bearer` header (`env-api-keys.ts:150`). It is consumed by the compat layer:
`ai/src/compat.ts:229  const apiKey = getEnvApiKey(model.provider, options?.env);`

### 2.3 "authenticated" marker for ambient cloud creds

Both `google-vertex` and `amazon-bedrock` can report configured without a key:

```
packages/ai/src/env-api-keys.ts:164 			return "<authenticated>";
packages/ai/src/env-api-keys.ts:184 			return "<authenticated>";
```

`compat.ts:230` filters that marker out of request options.

### 2.4 Non-key provider env vars (also read from env)

`AWS_REGION`/`AWS_DEFAULT_REGION` (`ai/src/api/bedrock-converse-stream.ts:1178-1179`),
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_SESSION_TOKEN` (`:1185,1186,1190`),
`AWS_BEDROCK_SKIP_AUTH` (`:181`), `AWS_BEDROCK_FORCE_HTTP1` (`:227`),
`AWS_BEDROCK_FORCE_CACHE` (`:861`), `AWS_PROFILE` (`:162`);
`AZURE_OPENAI_API_VERSION` (`api/azure-openai-responses.ts:229`),
`AZURE_OPENAI_BASE_URL` (`:233`), `AZURE_OPENAI_RESOURCE_NAME` (`:234`),
`AZURE_OPENAI_DEPLOYMENT_NAME_MAP` (`:48`);
`GOOGLE_APPLICATION_CREDENTIALS`/`GOOGLE_CLOUD_PROJECT`/`GCLOUD_PROJECT`/`GOOGLE_CLOUD_LOCATION`
(`providers/google-vertex.ts:74,79,80`; `env-api-keys.ts:36,55,159-161`);
`KIMI_CODE_OAUTH_HOST`/`KIMI_OAUTH_HOST` (`auth/oauth/kimi-coding.ts:37`).

---

## 3. `auth.json`

### 3.1 Path

Default: `<agent-dir>/auth.json`, and the agent dir defaults to `~/.pi/agent`.

```
packages/coding-agent/src/config.ts:546 /** Get path to auth.json */
packages/coding-agent/src/config.ts:547 export function getAuthPath(): string {
packages/coding-agent/src/config.ts:548 	return join(getAgentDir(), "auth.json");
```

Runtime construction uses the literal join in several places:
`core/auth-storage.ts:347  static create(authPath: string = join(getAgentDir(), "auth.json")): AuthStorage {`,
`core/agent-session-services.ts:143  authPath: join(agentDir, "auth.json"),`,
`core/sdk.ts:180  const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;`.

### 3.2 Type / shape

```
packages/coding-agent/src/core/auth-storage.ts:17  type AuthStorageData = Record<string, Credential>;
packages/ai/src/auth/types.ts:17  export interface ApiKeyCredential {
packages/ai/src/auth/types.ts:18  	type: "api_key";
packages/ai/src/auth/types.ts:19  	key?: string;
packages/ai/src/auth/types.ts:20  	env?: ProviderEnv;
packages/ai/src/auth/types.ts:32  export interface OAuthCredential extends OAuthCredentials {
packages/ai/src/auth/types.ts:33  	type: "oauth";
packages/ai/src/auth/types.ts:36  /** One type-tagged credential per provider — the shape of today's auth.json. */
packages/ai/src/auth/types.ts:37  export type Credential = ApiKeyCredential | OAuthCredential;
```

`OAuthCredentials` (`ai/src/auth/types.ts:24-29`) is `{ refresh: string; access: string; expires: number; [key: string]: unknown }`.
So the file is `{ "<providerId>": {"type":"api_key","key":"…","env":{…}} | {"type":"oauth","refresh":"…","access":"…","expires":<ms>} }`.

### 3.3 Validation on read

```
packages/coding-agent/src/core/auth-storage.ts:233 			if (value.type === "api_key") {
packages/coding-agent/src/core/auth-storage.ts:242 			} else if (
packages/coding-agent/src/core/auth-storage.ts:243 				value.type === "oauth" &&
packages/coding-agent/src/core/auth-storage.ts:244 				typeof value.access === "string" &&
packages/coding-agent/src/core/auth-storage.ts:251 			throw new Error(`Invalid auth.json credential for provider "${providerId}"`);
```

### 3.4 Read path

- Async store: `AuthStorage.read()` → `readLatestData()` → `AuthStorageBackend.withLockAsync` → `reloadFromStorageAsync` (`auth-storage.ts:392-399`), then key resolution:
  `auth-storage.ts:446  return { ...credential, key: resolveConfigValue(credential.key, credential.env) };`
  (`resolveConfigValue` supports `$ENV_VAR` interpolation and leading `!command`, `resolve-config-value.ts:81,89,138-151`.)
- Bulk sync read: `auth-storage.ts:363-367  private parseStorageData(content: string | undefined): AuthStorageData`.
- Read-only/no-lock variant: `ReadOnlyAuthStorage.load()` at `auth-storage.ts:211-256`, which reads at `auth-storage.ts:216  parsed = JSON.parse(stripBom(readFileSync(this.authPath, "utf-8")));` and treats ENOENT as `{}` (`:218-220`).
- One-off sync helper: `auth-storage.ts:496-499  export function readStoredCredential(providerId, authPath: string = join(getAgentDir(), "auth.json"))`, reading at `:501`.
- Migration source read: `migrations.ts:23-25` (`auth.json`, `oauth.json`, `settings.json` in the agent dir).

### 3.5 Write path

```
packages/coding-agent/src/core/auth-storage.ts:25  const AUTH_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
packages/coding-agent/src/core/auth-storage.ts:64  		if (!existsSync(this.authPath)) {
packages/coding-agent/src/core/auth-storage.ts:65  			writeFileSync(this.authPath, "{}", AUTH_FILE_WRITE_OPTIONS);
packages/coding-agent/src/core/auth-storage.ts:103 			const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
packages/coding-agent/src/core/auth-storage.ts:106 				writeFileSync(this.authPath, next, AUTH_FILE_WRITE_OPTIONS);
```

Async write, `AuthStorage.modify` (the only mutation path):
`auth-storage.ts:465-467  const merged: AuthStorageData = { ...currentData, [provider]: next };` /
`return { result: next, next: JSON.stringify(merged, null, 2) };`
Parent dir is created `mode: 0o700` (`auth-storage.ts:56-61`). Locks use `proper-lockfile`
(`auth-storage.ts:76`). `delete()` writes the file minus the provider (`auth-storage.ts:473-482`).

Legacy migration writer: `migrations.ts:69  writeFileSync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });`
(skips when `auth.json` already exists, `migrations.ts:28`).

### 3.6 `pi login` / the auth CLI

**`pi login` does not exist as a CLI subcommand.** Grep evidence:

```
$ grep -c "login" packages/coding-agent/src/cli/args.ts
0
$ grep -rn '"login"' packages/coding-agent/src --include=*.ts
packages/coding-agent/src/experimental/micro/tui.ts:472:			"login",
packages/coding-agent/src/experimental/mini/tui/view.ts:493:			"login",
packages/coding-agent/src/core/model-runtime.ts:92:export type CredentialSynchronizationOperation = "login" | ...
packages/coding-agent/src/core/model-runtime.ts:688:			await this.synchronizeCredentialState(providerId, "login", credential, signal);
packages/coding-agent/src/core/slash-commands.ts:37:	{ name: "login", description: "Configure provider authentication", argumentHint: "<provider>" },
packages/coding-agent/src/modes/interactive/interactive-mode.ts:728:		const loginCommand = slashCommands.find((command) => command.name === "login");
packages/coding-agent/src/modes/interactive/interactive-mode.ts:5791:				"login",
packages/coding-agent/src/modes/interactive/interactive-mode.ts:5819:	private async showOAuthSelector(mode: "login" | "logout"): Promise<void> {
packages/coding-agent/src/modes/interactive/components/oauth-selector.ts:46:	private mode: "login" | "logout";
```

`login` is the interactive slash command `/login <provider>` (`slash-commands.ts:37`,
handled at `interactive-mode.ts:3171-3172`). It writes through
`ModelRuntime.login` (`core/model-runtime.ts:684-691`), which delegates to
`this.models.login(...)` (`model-runtime.ts:687`) and then the credential store:
`core/runtime-credentials.ts:44  return this.store.modify(providerId, fn, options);`
→ `AuthStorage.modify` → `FileAuthStorageBackend` → `writeFileSync(this.authPath, …)` at
`auth-storage.ts:106`. So `/login` writes `<agent-dir>/auth.json`.

`packages/coding-agent/src/cli/auth-command.ts` is **read-only** — it only parses and prints:
`auth-command.ts:19-21` usage strings, `auth-command.ts:48-96  parseAuthCommand`,
`auth-command.ts:120-126  getAuthCredential`. It performs no file I/O and contains no
`writeFileSync`/`auth.json` reference (`grep -n "auth.json\|writeFile" packages/coding-agent/src/cli/auth-command.ts` → no output). Its entry point is
`main.ts:132  async function runAuthCommand(args: string[]): Promise<boolean>`.

Separately, the standalone pi-ai CLI does write: `ai/src/cli.ts:8  const AUTH_FILE = "auth.json";`
— **cwd-relative**, not the agent dir — read at `:19-21`, written at
`:28  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), "utf-8");`, message at `:73`.

---

## 4. `models.json`

### 4.1 Path

```
packages/coding-agent/src/config.ts:541 /** Get path to models.json */
packages/coding-agent/src/config.ts:543 	return join(getAgentDir(), "models.json");
packages/coding-agent/src/core/model-runtime.ts:176 			options.modelsPath === null ? undefined : (options.modelsPath ?? join(getAgentDir(), "models.json"));
```

`options.modelsPath === null` disables it entirely (`model-runtime.ts:176`). SDK/agent-dir
variant: `core/sdk.ts:181  const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;`,
`core/agent-session-services.ts:144  modelsPath: join(agentDir, "models.json"),`.
**No project-local `models.json` is read** — only the agent dir (or an explicit `modelsPath`).

Related cache file: `model-runtime.ts:181  ? new FileModelsStore(options.modelsStorePath ?? join(dirname(modelsPath), "models-store.json"))`.

### 4.2 Schema — TypeBox, not zod

`zod` is not a dependency of any package (`grep -rn '"zod"' packages/*/package.json` → no output);
the schema is **typebox** (`packages/coding-agent/package.json:68  "typebox": "1.3.27"`), imported at
`model-config.ts:4  import { type Static, Type } from "typebox";`.

Top level:

```
packages/coding-agent/src/core/model-config.ts:242 const ModelsConfigSchema = Type.Object({
packages/coding-agent/src/core/model-config.ts:243 	providers: Type.Record(Type.String(), ProviderConfigSchema),
packages/coding-agent/src/core/model-config.ts:244 });
packages/coding-agent/src/core/model-config.ts:245 const validateModelsConfig = Compile(ModelsConfigSchema);
```

So the top-level has exactly one key: **`providers`** — `Record<string, ProviderConfigSchema>`
(required; there is no optional top-level key).

`ProviderConfigSchema` (`model-config.ts:229-240`): `name?`, `baseUrl?`, `apiKey?`, `api?`,
`oauth?: "radius"`, `headers?: Record<string,string>`, `compat?`, `authHeader?: boolean`,
`models?: ModelDefinition[]`, `modelOverrides?: Record<string, ModelOverride>`.

`ModelDefinitionSchema` (`model-config.ts:188-204`): required `id: string`; optional `name`,
`api`, `baseUrl`, `reasoning`, `thinkingLevelMap`, `input: ("text"|"image")[]`, `inputLimits`,
`cost`, `promptCache`, `contextWindow`, `maxTokens`, `samplingParams`, `headers`, `compat`.

`ModelOverrideSchema` (`model-config.ts:206-227`): no `id`/`api`/`baseUrl` — `name`, `reasoning`,
`thinkingLevelMap`, `input`, `inputLimits`, `cost`, `promptCache`, `contextWindow`, `maxTokens`,
`samplingParams`, `headers`, `compat`.

Exported types: `model-config.ts:247-250  export type ModelsJsonModel = Static<typeof ModelDefinitionSchema>;` … `type ModelsJson = Static<typeof ModelsConfigSchema>;`

### 4.3 Load / validate / errors

```
packages/coding-agent/src/core/model-config.ts:286 			content = await readFile(path, "utf-8");
packages/coding-agent/src/core/model-config.ts:297 			parsed = JSON.parse(stripJsonComments(stripBom(content)));
packages/coding-agent/src/core/model-config.ts:305 		if (!validateModelsConfig.Check(parsed)) {
packages/coding-agent/src/core/model-config.ts:311 			return new ModelConfig(new Map(), `Invalid models.json schema:\n${errors}\n\nFile: ${path}`);
```

Missing file → empty config (`model-config.ts:288`). **JSON comments are allowed**
(`stripJsonComments`, `:297`).

`apiKey` resolution at request time (with `$ENV` interpolation or `!command`):

```
packages/coding-agent/src/core/provider-composer.ts:388 			} else if (rawKey !== undefined) {
packages/coding-agent/src/core/provider-composer.ts:390 				const key = resolveConfigValueOrThrow(rawKey, `API key for provider "${providerId}"`, env);
packages/coding-agent/src/core/provider-composer.ts:393 					: { auth: { apiKey: key }, source: "configured API key" };
```

---

## 5. `settings.json`

Two files, same filename, one per scope:

```
packages/coding-agent/src/core/settings-manager.ts:237 		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
packages/coding-agent/src/core/settings-manager.ts:238 		this.projectSettingsPath = join(resolvedCwd, CONFIG_DIR_NAME, "settings.json");
packages/coding-agent/src/core/settings-manager.ts:363 			global: join(resolvedAgentDir, "settings.json"),
packages/coding-agent/src/core/settings-manager.ts:364 			project: join(resolvedCwd, CONFIG_DIR_NAME, "settings.json"),
```

- Global: `<agent-dir>/settings.json` → default `~/.pi/agent/settings.json`
  (also exposed as `getSettingsPath()`, `config.ts:551-554`).
- Project-local: `<cwd>/.pi/settings.json` (`CONFIG_DIR_NAME` = `.pi`, `config.ts:504`).

Each has its own lock and file. `withLock` picks by scope:
`settings-manager.ts:269  const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;`
and writes at `settings-manager.ts:289  writeFileSync(path, next, "utf-8");`. Writes are
field-scoped read-modify-write (`persistScopedSettings`, `settings-manager.ts:637-666`).

`Settings` is a plain TypeScript interface (not schema-validated on read):
`settings-manager.ts:110  export interface Settings {` … closing at `:163`. Unknown keys are
preserved, not rejected. Two fields are explicitly global-only:
`settings-manager.ts:128  defaultProjectTrust?: DefaultProjectTrust; // default: "ask"; global setting only` and
`settings-manager.ts:157  cacheWarming?: CacheWarmingMode; // default: "streaming"; global only because each refresh costs money`
(enforced by writing `this.globalSettings.*` in `setDefaultProjectTrust`, `:1037`, and
`setCacheWarmingMode`, `:961`).

Other agent-dir config files (same directory): `keybindings.json` (`core/keybindings.ts:380`),
`trust.json` (§6), `models.json` (§4), `auth.json` (§3), `SYSTEM.md`/`APPEND_SYSTEM.md` (§6),
plus `extensions/`, `skills/`, `prompts/`, `themes/` (`config.ts:536-574`).

---

## 6. Project-local config

### 6.1 `.pi/` project files

Base dir: `packages/coding-agent/src/core/package-manager.ts:931  const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);`

Filenames/dirs, with what each can override:

| Project path | Scope | file:line |
|---|---|---|
| `.pi/settings.json` | Project settings, deep-merged over global | `settings-manager.ts:238,364`; trust-gated at `settings-manager.ts:411-412` |
| `.pi/SYSTEM.md` | **Replaces** the system prompt for the project (wins over `<agent-dir>/SYSTEM.md`) | `resource-loader.ts:1028-1036` |
| `.pi/APPEND_SYSTEM.md` | Adds to the system prompt (wins over `<agent-dir>/APPEND_SYSTEM.md`) | `resource-loader.ts:1042-1051` |
| `.pi/extensions/` | Project extensions (auto-discovered) | `package-manager.ts:2392`, `2417-2425` |
| `.pi/skills/` | Project skills | `package-manager.ts:2393`, `2427-2434` |
| `.pi/prompts/` | Project prompt templates | `package-manager.ts:2394`, `2453-2460` |
| `.pi/themes/` | Project themes | `package-manager.ts:2395`, `2461-2467` |
| `.agents/skills/` in cwd **or any ancestor** | Project skills (trust-gated; the user-level `~/.agents/skills` is exempt) | `package-manager.ts:2397-2401`, `2438-2451` |
| `.pi/npm`, `.pi/git` | Project package install locations | `package-manager.ts:2031`, `2111` |

Trust gate on the trusted project files:

```
packages/coding-agent/src/core/package-manager.ts:2417 		if (projectTrusted) {
packages/coding-agent/src/core/package-manager.ts:2418 			// Project extensions from .pi/
packages/coding-agent/src/core/resource-loader.ts:1029 		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
```

### 6.2 Context files (AGENTS.md / CLAUDE.md) — NOT under `.pi/`

```
packages/coding-agent/src/core/resource-loader.ts:71  function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
packages/coding-agent/src/core/resource-loader.ts:72  	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
packages/coding-agent/src/core/resource-loader.ts:119 export function loadProjectContextFiles(options: {
packages/coding-agent/src/core/resource-loader.ts:129 	const globalContext = loadContextFileFromDir(resolvedAgentDir);
packages/coding-agent/src/core/resource-loader.ts:145 			ancestorContextFiles.unshift(contextFile);
```

Order: agent-dir context file first, then ancestors from the outermost directory down to
cwd (`loadProjectContextFiles`, `resource-loader.ts:119-157`). These are plain `AGENTS.*`/`CLAUDE.*`
files in the agent dir and in every ancestor of cwd — **not** in `.pi/`. First match per
directory wins (the `for` loop returns at `resource-loader.ts:80-83`). Context files do not
require trust — `loadProjectContextFiles` is called without a trust check
(`resource-loader.ts:518-521`); only `--no-context-files`/`noContextFiles` disables them
(`resource-loader.ts:516-517`, flag at `cli/args.ts:321`).

### 6.3 Project trust

Store path — a single JSON file with `{ "<canonical cwd>": true|false|null }`:

```
packages/coding-agent/src/core/trust-manager.ts:213 		this.trustPath = join(resolvePath(agentDir), "trust.json");
packages/coding-agent/src/core/trust-manager.ts:220 	getEntry(cwd: string): ProjectTrustStoreEntry | null {
packages/coding-agent/src/core/trust-manager.ts:47  		const value = data[currentDir];
```

Nearest-ancestor lookup (`trust-manager.ts:44-58`); values validated as true/false/null
(`trust-manager.ts:117-118`).

What triggers a trust prompt:

```
packages/coding-agent/src/core/trust-manager.ts:30  const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
packages/coding-agent/src/core/trust-manager.ts:31  	"settings.json",
packages/coding-agent/src/core/trust-manager.ts:32-37 	"extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md",
packages/coding-agent/src/core/trust-manager.ts:191 	if (TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => existsSync(join(configDir, entry)))) {
packages/coding-agent/src/core/trust-manager.ts:197 		if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
```

Note `settings.json` in that list is `<cwd>/.pi/settings.json` (configDir), not the global one.

Decision order in `resolveProjectTrusted` (`core/project-trust.ts:46-96`):
`--trust`/`--no-trust` override (`:47-49`) → no trust-requiring resources ⇒ trusted (`:50-52`)
→ extension `project_trust` event result (`:54-70`) → stored `trust.json` decision (`:72-75`)
→ `defaultProjectTrust` setting (`:77-84`) → interactive prompt (`:86-94`) → print/RPC
without UI returns `false` (`:87`). Default is `"ask"` (`:77`).

Startup wiring: `main.ts:586  const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });`
then `main.ts:735  const runtimeSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted });`
with `projectTrusted` computed at `main.ts:730-734`.

### 6.4 Untrusted project ⇒ project settings dropped

```
packages/coding-agent/src/core/settings-manager.ts:410 	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
packages/coding-agent/src/core/settings-manager.ts:411 		if (scope === "project" && !projectTrusted) {
packages/coding-agent/src/core/settings-manager.ts:412 			return {};
packages/coding-agent/src/core/settings-manager.ts:595 		throw new Error("Project is not trusted; refusing to write project settings");
```

### 6.5 Can project settings override global settings? Yes — deep merge, project wins

```
packages/coding-agent/src/core/settings-manager.ts:188 /** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
packages/coding-agent/src/core/settings-manager.ts:189 function deepMergeSettings(base: Settings, overrides: Settings): Settings {
packages/coding-agent/src/core/settings-manager.ts:190 	return deepMergeObjects(base as Record<string, unknown>, overrides as Record<string, unknown>) as Settings;
packages/coding-agent/src/core/settings-manager.ts:350 		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
```

Recomputed on load (`:350`), on trust change (`:526,536`), on reload (`:564`) and on save
(`:669,687`). Exceptions that stay global-only: `defaultProjectTrust` (`:1032  const value = this.globalSettings.defaultProjectTrust;`),
`cacheWarming` (`:956  const mode = this.globalSettings.cacheWarming;`),
`lastChangelogVersion` (`:719-720`), `defaultProvider`/`defaultModel` (`:742-752`).

Resource lists get the same ordering, with project entries resolved first so they win
collisions: `package-manager.ts:917  // Collect all packages with scope (project first so cwd resources win collisions)`
and `package-manager.ts:926  // Dedupe: project scope wins over global for same package identity`.

---

## 7. Precedence order

### 7.1 Settings values

The real order is **defaults (in getters) → global `settings.json` → project `.pi/settings.json` → in-process overrides (`applyOverrides`)**. There is **no env or CLI layer inside `SettingsManager`**; env vars and CLI flags are read at their point of use and usually beat settings.

1. **Defaults** live in the getters, e.g.
   `settings-manager.ts:942  return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;`
   `settings-manager.ts:1360  return mode && valid.includes(mode) ? mode : "default";`
2. **Global file** loaded first: `settings-manager.ts:380  const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");`
3. **Project file** loaded second and merged on top:
   `settings-manager.ts:381  const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);`
   `settings-manager.ts:350  this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);`
4. **Overrides** applied last (`applyOverrides`, the only caller is the `--theme`/`-t` flag):
   `settings-manager.ts:568  applyOverrides(overrides: Partial<Settings>): void {`
   `settings-manager.ts:569  	this.settings = deepMergeSettings(this.settings, overrides);`
   `main.ts:667  startupSettingsManager.applyOverrides({ theme: parsed.useTheme });`

### 7.2 Env vs settings — mixed, depends on the key

- Setting first, env as fallback: `settings-manager.ts:1237-1240` (`clearOnShrink`), `settings-manager.ts:1370` (`showHardwareCursor`), `settings-manager.ts:988-995` (`externalEditor`: `externalEditor` → `VISUAL`/`EDITOR` → `notepad`/`nano`).
- Env first, setting as fallback: `core/telemetry.ts:12  return telemetryEnv !== undefined ? isTruthyEnvFlag(telemetryEnv) : settingsManager.getEnableInstallTelemetry();`
- Env mutates the process env for HTTP: `main.ts:587  applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);` → `http-dispatcher.ts:48-49` uses `??=` so a pre-existing env var wins over the setting.

### 7.3 Env vs CLI — CLI wins

Session dir is the clearest documented chain:

```
packages/coding-agent/src/main.ts:675 	const envSessionDir = process.env[ENV_SESSION_DIR];
packages/coding-agent/src/main.ts:676 	const sessionDir =
packages/coding-agent/src/main.ts:677 		(parsed.sessionDir ? normalizePath(parsed.sessionDir) : undefined) ??
packages/coding-agent/src/main.ts:678 		(envSessionDir ? expandTildePath(envSessionDir) : undefined) ??
packages/coding-agent/src/main.ts:679 		startupSettingsManager.getSessionDir();
```

i.e. `--session-dir` > `PI_CODING_AGENT_SESSION_DIR` > `settings.sessionDir`. Piggy 侧实现见 03 §2.18（`pi_files::resolve_sessions_root`，只认绝对路径；
自定义值在 pi 那边是**叶子**目录 → 会话平铺在根下，扫描器两种布局都认）。Similarly
`--offline` OR `PI_OFFLINE` both enable offline (`main.ts:569`), and `--trust`/`--no-trust`
short-circuit trust resolution before the store and prompt (`project-trust.ts:47-49`,
wired at `main.ts:748  trustOverride: parsed.projectTrustOverride,`).

### 7.4 Credential precedence (separate from settings)

CLI runtime key → stored `auth.json` credential → `models.json` `apiKey` → provider env /
ambient cloud credentials. Code: `provider-composer.ts:382-396` (`input.credential` branch at
`:382`, `rawKey` from `models.json` at `:388`), `ai/src/auth/helpers.ts:20-26` (stored key
before `ctx.env`), `ai/src/env-api-keys.ts:176-185` (ambient AWS as last resort).
`RuntimeCredentials` overlays a non-persistent `--api-key` on top of the store
(`core/runtime-credentials.ts:26-27  return override ? { type: "api_key", key: override } : this.store.read(providerId, options);`).

### 7.5 配置页要用的两条"pi 不给"的事实（2026-09-24 复核）

这两条决定了 Piggy 的提供商目录必须是**自带**的（实现见 03 §2.12）：

1. **RPC 没有"列出所有提供商"这条命令。** `packages/coding-agent/src/modes/rpc/rpc-types.ts`
   的 `RpcCommand` 联合里与模型相关的只有 `set_model` / `cycle_model` / `get_available_models`；
   而最后一个走的是 `session.modelRuntime.getAvailableSnapshot()`（`rpc-mode.ts:490-493`），
   `model-runtime.ts:423-425` 返回的是 `this.snapshot.available` —— **只含已配置可用的模型**。
   所以"还没配置的提供商"从 RPC 拿不到。
2. **CLI 也只列可用的。** 本机实测：`pi --list-models` 只打印出了用户 models.json 里那两个
   自定义路由下的 3 个模型（`cc-switch-deep-seek/deepseek-flash`、`cc-switch-zhipu-glm/glm-5.3`…），
   pi 内置目录里那 40 来家一个都没出现。`pi auth check` 则必须显式给 `--provider`/`--model`，
   同样不能枚举。

补充一条**可用的**本地数据源：`models-store.json`（`core/models-store.ts:52` 默认
`join(getAgentDir(), "models-store.json")`，形状 `{ "<provider>": { models: Model[] } }`，
由 `pi update` 维护的远端目录缓存）。Piggy 的「获取可用模型」优先读它 —— 不联网就能拿到
模型 id / 名字 / 上下文窗口 / 输出上限，这正是 DSH `discovery.ts` "目录里有的就不上网问"的语义。

---

## 8. Extensions：四个来源、加载优先级与"停用"的真实语义

这一节服务于 Piggy 的插件页（03 §2.15、04 §2.3）。**pi 没有任何扩展管理 RPC**：
`modes/rpc/rpc-types.ts:20-74` 的 33 条命令里一条都不沾，未知类型直接 `Unknown command`
（本机实测 `{"type":"extension.list"}` → `success:false, error:"Unknown command"`）。
`pi list` 只列 settings 的 `packages[]`，**没有 `--json`**，也不含 `extensions[]` 与发现目录。

### 8.1 加载优先级（`core/package-manager.ts:176-192`）

| rank | 来源 | 基准目录 |
|---|---|---|
| 0 | 项目 `settings.json` 的 `extensions[]` | `<cwd>/.pi` |
| 1 | 项目发现目录 `<cwd>/.pi/extensions/` | `<cwd>/.pi` |
| 2 | 全局 `settings.json` 的 `extensions[]` | `<agentDir>` |
| 3 | 全局发现目录 `<agentDir>/extensions/` | `<agentDir>` |
| 4 | 包资源（`packages[]` 里的 npm/git/本地） | 各作用域的 `npm/`、`git/` |

同路径去重保留 rank 最小的一条（`package-manager.ts:2585-2593`）。
`-e/--extension` 的 CLI 路径排在全部之前。项目作用域**需要项目被信任**
（`settings-manager.ts:410-413`：未信任时项目 settings 整份返回 `{}`；信任记录在
`<agentDir>/trust.json`）。

### 8.2 什么算一个扩展（`core/extensions/loader.ts:657-744`）

只扫**一层**：直接文件 `.ts`/`.js`；子目录有 `package.json` 的 `pi.extensions[]` 就按它加载
（声明的入口全不存在时回落到 `index.ts`/`index.js`）；否则取 `index.ts`/`index.js`；
都不满足则跳过。模块必须 default 导出一个函数，否则
`Extension does not export a valid factory function`。

### 8.3 "停用"= 资源通配符，不是布尔开关（`package-manager.ts:707-780`）

| 写法 | 含义 | 匹配方式 |
|---|---|---|
| `path` | 声明一个资源 | 路径 |
| `!glob` | 排除 | minimatch（对 相对路径 / 文件名 / 绝对路径 取或） |
| `+path` | 强制包含（压过 `!`） | **精确**相等 |
| `-path` | 强制排除（压过 `+`） | **精确**相等 |

判定顺序固定为 `!` → `+` → `-`（`isEnabledByOverrides`，`package-manager.ts:712-728`）。
**每个来源只受自己那个作用域的规则影响**（`addAutoDiscoveredResources` 按作用域分别施加），
所以全局的 `-x` 关不掉项目发现目录里的同名文件。

包走另一套：`PackageSource` 的对象形式 `{source, autoload, extensions[], ...}`，
`autoload:false` 时只有被 `+` 规则命中的入口才加载
（`applyAutoloadDisabledPatterns`，`package-manager.ts:787-806`）。
`pi config` 那个 TUI 写的就是这些通配符（`config-selector.ts:542` 的 `-${pattern}`）。

### 8.4 落盘位置（`package-manager.ts:2025-2114`）

| 来源 | 全局 | 项目 |
|---|---|---|
| npm | `<agentDir>/npm/node_modules/<pkg>` | `<cwd>/.pi/npm/node_modules/<pkg>` |
| git | `<agentDir>/git/<host>/<owner>/<repo>` | `<cwd>/.pi/git/...` |
| 本地 | 不复制，直接在 settings 里记一条（相对**设置文件所在目录**的路径） | 同左 |
| `-e` 临时 | `<agentDir>/tmp/extensions/<prefix>/<sha256-8>` | — |

实测：`pi install /Users/…/pi-guardrails` 写进全局 settings.json 的是
`../../../../../Users/…/pi-guardrails`（相对 `~/.pi/agent`），不是绝对路径。

### 8.5 内置扩展

`src/extensions/index.ts` 的 `builtInExtensions` 目前只有 **`llama.cpp`**（`hidden: true`）。
它作为 inline factory 被**无条件**加载（`resource-loader.ts:559-567`），
`--no-extensions` 也关不掉（本机实测：`pi --mode rpc --no-extensions` 仍返回 `llama` 命令）。
**没有运行时枚举接口**，所以 Piggy 在编译期从源码固化
（`plugin/builtins_generated.rs`，生成脚本带 `--check`）。

### 8.6 冲突是致命的

两个扩展注册同名**工具**或 **flag** → 报错并 `process.exit(1)`，**所有模式**都是
（`resource-loader.ts:1064-1100` + `main.ts:896-906`）。同名**命令**不致命，
会被重命名成 `dup:1`/`dup:2`（`runner.ts:739-772`）。
运行期优先级：工具与 flag 先注册者赢，快捷键**后**注册者赢。

### 8.7 安全模型：没有

扩展在 pi 进程内以用户权限运行，能读文件、拿凭据、看会话；没有沙箱、没有签名、
没有安装前审批（`docs/security.md`、`docs/extensions.md:5`）。
`-a/--approve` 只管**项目信任**（目录级，存 `~/.pi/agent/trust.json`），不针对单个扩展。

---

## Uncertain

- **`PI_CODING_AGENT_SESSION_DIR` has no `getSessionsDir()` consumer.** `getSessionsDir()` (`config.ts:572-574`) ignores the env var; the override is applied only in `main.ts:675-679`. Embedders that call `SessionManager.create(cwd, getSessionsDir())` directly will not honour it.
- **`PI_OFFLINE` truthiness is inconsistent.** `model-runtime.ts:197` and `radius-auth.ts:36` test for definedness, others test truthiness (`version-check.ts:55`, `package-manager.ts:54`, `bug-report.ts:56`). `PI_OFFLINE=0` is therefore not uniformly "offline disabled". I did not find a single normalization point.
- **Project-local `models.json` / `auth.json` do not exist.** Only agent-dir (or explicit `modelsPath`/`authPath`) files are read (`model-runtime.ts:176`, `sdk.ts:180-181`). I found no `.pi/models.json` or `.pi/auth.json` handling.
- **`NO_COLOR` is absent** (grep shown in §1.5), so `NO_COLOR=1` has no effect unless chalk itself honours it; pi sets no chalk level.
- **Line counts drift**: `settings-manager.ts` is 1434 lines and I verified every cited line by reading it, but surrounding line numbers may shift after edits (`getClearOnShrink` opens at `:1235`, its env read is `:1240`).
- The standalone `pi-ai` CLI (`ai/src/cli.ts:8`) writes a **cwd-relative** `auth.json`, which is a different file from the coding agent's `<agent-dir>/auth.json`; I did not find code that reconciles the two.
