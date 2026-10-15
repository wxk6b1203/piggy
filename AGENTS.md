# AGENTS.md

Operating guide for coding agents working in this repository (repo root).

## Project overview

Piggy is the graphical cockpit for [`pi`](https://github.com/earendil-works/pi): a **Tauri 2** desktop app
(Rust host process + React 19 webview) that does **not** reimplement the agent. Each session tab owns a
real `pi --mode rpc` child process (JSONL over stdio); Piggy supervises, relays, renders and configures it.
Sessions and config are therefore interchangeable with the pi CLI — same `~/.pi/agent` files, so a session
started in the GUI can be resumed with `pi -c` and vice versa.

`docs/` is the design single source of truth (written in Chinese). Start with `docs/00` → `docs/01`;
before non-trivial changes skim `docs/15-handoff.md` §3, a 140+ item list of "learned the hard way" rules.

## Setup

- Node ≥ 20 (dev + CI use 24), pnpm 11.24.0 (`packageManager`), Rust stable with the Tauri 2 toolchain.
- `pnpm install` — pnpm workspace covering `apps/*` and `packages/*`.
- `pi` is an external runtime anchored at **1.2.0**; six anchors are reconciled by
  `node apps/desktop/scripts/check-pi-pin.mjs`. Discovery order: explicit path in settings → `PI_BIN`
  → bundled standalone (full SKU) → `PATH`.
- Optional: system Chrome for the browser gates; `pnpm exec playwright install chromium` for perf runs.

## Commands

Verified locally on macOS 2026-10-14: `pnpm build`, `pnpm test`, `pnpm test:rust`, `pnpm typecheck`, `pnpm lint`,
`cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, both CI static gates, single-test commands.
**Not executed here**: `pnpm install`, `pnpm dev`, `tauri dev`/`build` (both SKUs), `ui:startup`, `ui:debug`, `perf:lite`, `test:contract`.

| Purpose | Command |
|---|---|
| Install | `pnpm install` |
| Frontend only, mock IPC, http://localhost:5195 | `pnpm dev` |
| Real desktop app (starts Vite itself) | `pnpm tauri dev` |
| Build frontend (tsc + vite) | `pnpm build` |
| Package lite SKU (no bundled pi) | `pnpm tauri build` |
| Package full SKU (bundles pi) | `pnpm --filter @piggy/desktop exec node scripts/fetch-pi-standalone.mjs` then `pnpm tauri build --config src-tauri/tauri.full.conf.json` |
| All JS tests (protocol + bridge + frontend) | `pnpm test` |
| One frontend test file | `pnpm --filter @piggy/desktop exec vitest run src/test/markdown.test.tsx` |
| Bridge package only | `pnpm --filter piggy-bridge test` |
| Rust unit + fixtures + IPC contract | `pnpm test:rust` (= `cd apps/desktop/src-tauri && cargo test`) |
| One Rust test | `cd apps/desktop/src-tauri && cargo test --lib <name>` |
| Typecheck (apps/desktop + both packages) | `pnpm typecheck` |
| Lint (eslint, `--max-warnings 0`) | `pnpm lint` |
| Format Rust (rustfmt, 120 cols) | `pnpm fmt`; CI also runs `cargo fmt --check` |
| Rebuild the bridge artifact after editing `packages/piggy-bridge` | `pnpm build:bridge` |
| CI static gates | `node apps/desktop/scripts/check-pi-pin.mjs`, `node apps/desktop/scripts/vendor-plugin.mjs --check` |
| Browser gates (need `pnpm dev` running + Chrome) | `pnpm --filter @piggy/desktop ui:startup`, `pnpm --filter @piggy/desktop ui:debug -- --strict` |
| Perf smoke (S1/S3, budget-asserting) | `pnpm --filter @piggy/desktop perf:lite` (`perf` = full S1–S6) |
| Contract tests against real pi (C1–C16, burns tokens) | `pnpm test:contract` — needs pi on `PATH` and a configured provider |

## Architecture

```
apps/desktop/src/            React frontend (React 19 + Vite 7 + zustand/immer + antd 6 + dockview + Monaco)
  features/chat/             transcript renderer, Composer, preview scrollbar, trajectory — the core UI
  features/workspace/        dockview layout, sidebar, right bar, editor area, Fleet view
  features/settings/         providers / general / advanced / plugins pages
  stores/                    zustand stores: tabs, messages, trajectory, fleet, todo, stats, ui, dialogs, queue
  lib/                       ipc.ts (+ mockBackend for browser mode), paging, keymap, layoutLifecycle, coalesce glue
  test/                      most unit/component tests (co-located `*.test.ts(x)` next to sources also runs)
apps/desktop/src-tauri/      Rust host
  src/commands.rs            ~76 IPC commands; all registered in `lib.rs` `generate_handler!`
  src/pi/                    discovery, codec, process state machine, protocol passthrough, coalesce (≤60 Hz framing), permission
  src/sessions/              registry (tab ↔ worker, recycling/sleep), list, transcript (paged reads), title
  src/config/                paths, pi_files (auth/models/settings), app config
  src/provider/ src/plugin/ src/fleet.rs src/fs_guard.rs src/open_in_app/ src/pty.rs src/legal.rs
  resources/                 piggy-guard.js, piggy-bridge.js (generated), pi-plugins/, bundled pi (gitignored)
  tests/                     ipc_contract, fixtures_parse, path_separators, menu_smoke, contract (feature `contract`)
packages/pi-protocol/        TS types + zod schemas for the pi RPC protocol, mirrored by Rust-side fixtures
packages/piggy-bridge/       pi extension bridging pi-subagents into the GUI; built into src-tauri/resources/piggy-bridge.js
docs/                        design SSOT (00–18, Chinese) + screenshots
```

Data flow for one streaming turn: UI `invoke` → Rust command → worker stdin → stdout JSONL →
coalescer batches deltas into ≤60 Hz frames → `pi:frame` events drive transient DOM writes (no React state),
`message_end` → `pi:commit` → zustand structural commit. Treat `message_end.message` as authoritative.

Boundaries that matter:

- All LLM calls, tool execution and session persistence happen inside pi. Piggy only supervises, relays, renders, configures.
- One worker per tab; at most one worker per session file (registry enforces this — session files are append-only JSONL trees).
- Zero telemetry; API keys live only in `~/.pi/agent/auth.json` and are never read in cleartext by the frontend.
- Permission modes (仅可查看 / 工作区内修改 / 完全权限) = pi `--tools` whitelist + a `tool_call` guard extension
  (`resources/piggy-guard.js`); switching mode restarts the worker on the same session file.

## Conventions & gotchas

1. **`docs/` is the SSOT**: a behavior change must update the matching doc in the same change, and docs may
   not claim gates that never actually run. Docs, code comments and commit messages are **Chinese**;
   commits use `type(scope): 中文摘要` (e.g. `fix(pi): …`, `test(guard): …`).
2. **Prove every gate**: before trusting a new check, break the implementation and confirm it goes red.
   This repo's history contains several gates that silently passed forever (`pnpm lint`, `cargo fmt`, perf-lite).
3. **Never hand-edit generated files**: `src-tauri/resources/piggy-bridge.js`, `src-tauri/src/provider/catalog_generated.rs`,
   `src-tauri/src/plugin/builtins_generated.rs`, `src/features/common/codicon-names.ts`, `seti-icons.ts`,
   `vscode-theme-tokens.ts`. Regenerate via `pnpm build:bridge`, `gen-provider-catalog.mjs <pi-src>`,
   `gen-plugin-builtins.mjs <pi-src>`, `icons:gen`, `icons:seti`, `themes:sync`.
   Vendored plugins under `src-tauri/resources/pi-plugins/` are third-party copies locked by `vendor.json` sha256.
4. **Adding an IPC command touches four places**: Rust handler + `lib.rs` `generate_handler!`, the frontend
   `cmd('name')` call, a `mockBackend` handler (or an `ALLOWED_WITHOUT_HANDLER` entry), and `TAB_SCOPED` if it
   takes a `tabId`. `src/test/ipc-names.test.ts` and `ipc-mock-coverage.test.ts` enforce these statically —
   a mock more permissive than the real backend is treated as a bug (it hides real-machine failures).
5. **Rust ↔ JS wire shapes**: use `#[serde(rename_all = "camelCase")]`, wrap arrays in named objects
   (`{"messages": [...]}`), and `to_string_lossy()` any `PathBuf`/`OsString` before serializing.
   `tests/ipc_contract.rs` locks the shapes; frontend `cmd()` sends camelCase args.
6. **Paths**: never build paths by concatenating separators (Rust: `Path::join` only — enforced by
   `tests/path_separators.rs`); never `split('/')` on paths coming from Rust. In Rust strip the Windows
   `\\?\` verbatim prefix (`plain_path`) before passing paths to child processes — pi/node cannot load an
   extension directory carrying it and exits.
7. **Frontend red lines (eslint, `apps/desktop/eslint.config.js`)**: no `antd` inside `features/chat/**`;
   no React imports or state setters on the `pi:frame` path (`lib/tabEvents.ts`, `lib/ipc.ts`,
   `stores/messages.ts`, `lib/coalesce.ts`); no `setInterval` (bare or `window.`); no `dangerouslySetInnerHTML`.
   There is **no prettier** — eslint is the only JS/TS formatter-adjacent gate. Rust is rustfmt at 120 columns.
8. **`styles/tokens.css` and `features/common/monaco-setup.ts` are hand-mirrored** — Monaco's `defineTheme`
   cannot read CSS variables. Import Monaco via canonical specifiers (`monaco-editor/editor/editor.api`);
   deep `monaco-editor/esm/vs/...` imports break the Vite optimization.
9. **`tauri::Builder::setup` overwrites rather than appends** — all startup wiring must live in one closure;
   a second `.setup()` silently discards the first (tray, pi wiring, guards, watchers have been lost this way).
10. **UI gates are local-only**: `ui:startup` / `ui:debug --strict` need Chrome plus a running `pnpm dev`
    on :5195, and are not in CI. CI runs: frontend (typecheck, lint, vendor + pi-pin checks, tests, build),
    rust (`fmt --check`, `clippy --all-targets -- -D warnings`, `cargo test --lib --tests`), contract, perf-lite.
11. **Known flake**: `pnpm test` can exit 1 while the summary says `Test Files 70 passed / Tests 684 passed`,
    because a React 19 scheduler `setImmediate` callback runs after jsdom teardown ("window is not defined").
    Judge by the pass counts and rerun the reported file before suspecting a regression (docs/15 §4.3).
12. **Upgrading pi** means six anchors + regenerated snapshots + contract tests: `check-pi-pin.mjs` reconciles
    the anchors, `gen-*.mjs --check` verifies the generated Rust snapshots against pi sources, and
    `pnpm --filter piggy-bridge typecheck` is the one seam that fails silently if the pinned types drift.
13. **Verified failing on macOS at commit a8e8398** (2026-10-14): `cargo test --lib` fails
    `pi::process::tests::extension_args_never_carry_the_verbatim_prefix` — a Windows-shaped assertion without a
    platform guard (`\\?\…` is never `is_dir()` on Unix). Pre-existing, not caused by your change.
