# CLAUDE.md

This file contains instructions and reference material for Claude Code (claude.ai/code) when working with this repository. Update this file when adding or removing components, changing workflows, or modifying the architecture — keep it in sync with the codebase.

**Related docs:**

- `DEV_LOG.md` — Reverse-chronological development decisions and lessons learned. Update it when making significant changes or discovering important behaviors.
- `ROADMAP.md` — Tracks planned, exploratory, and deferred features.
- `FEATURE_MAP.md` — Competitive landscape analysis and open-source reference guide. Check it before implementing a feature that may already exist in an open-source project.
- `docs/` — Research and reference documents. Key files:
  - `docs/autocomplete-approach.md` — Autocomplete philosophy, prompt design, and testing strategy
  - `docs/claude-code-cli-reference.md` — CLI flags and usage
  - `docs/prompt-template-research.md` — Prompt engineering patterns
  - `docs/anthropic-sdk-reference.md` — Anthropic SDK usage
  - (see directory for full listing)

## Overview

Bespoke AI is a personal AI toolkit for VS Code (works identically in VSCodium). It provides:

- **Inline completions** — ghost text (the gray preview text shown before accepting) for prose and code
- **Commit message generation** — from staged diffs
- **Suggest edits** — fixes typos, grammar, and bugs in visible text
- **Expand** — guided multi-suggestion inline completions via right-click or Ctrl+Shift+L
- **Context menu commands** — Explain, Fix, Alternatives, Condense, Chat

Auto-detects prose vs code completion mode based on `document.languageId`.

**Two backends for inline completions:**

- **Claude Code** (`bespokeAI.backend: "claude-code"`, default) — Uses the Claude Code CLI via `@anthropic-ai/claude-agent-sdk`. Requires a Claude subscription. Commands (commit message, suggest-edits, expand, context menu) always use this backend.
- **API** (`bespokeAI.backend: "api"`) — Direct API calls via vendor SDKs. Supports Anthropic (with assistant prefill — pre-seeding the model's response — and prompt caching), xAI/Grok and OpenAI (via OpenAI-compatible SDK), and Google Gemini. Requires vendor-specific API keys. Only used for inline completions — commands stay on Claude Code.

## Working Rules

**Feature scope:** Do not implement new capabilities beyond inline completions, commit messages, suggest-edits, expand, and context menu commands unless explicitly asked. Do not fix accepted limitations (see [Known Limitations](#known-limitations)) or introduce post-processing without explicit approval.

**Interpreting pasted content:** When the user pastes log output, error messages, or other unaccompanied diagnostic content, assume they want you to investigate the issue. Diagnose, identify the root cause, and propose a fix.

**Error handling pattern:** The backend catches abort errors and returns `null`; all other errors propagate to the completion orchestrator, which logs them via the `Logger`. The orchestrator shows errors to the user via `showErrorMessage`, rate-limited to one notification per 60 seconds. New code should follow this same pattern.

**Pre-commit gate:** Run `npm run check` before creating any commit. Only proceed if it passes.

**Version control:** This project uses GitHub. Use `gh` for repository operations. Work directly on `main` unless asked to create a branch.

**Strongly prefer prompt engineering over post-processing.** Adjust the system prompt, `<completion_start>` anchor, or backend configuration first. Post-processing (algorithmic trimming/transformation in `post-process.ts`) is a last resort, not an alternative to try alongside prompt fixes. Algorithmic text manipulation that looks correct for the observed failure case often silently breaks completions in other contexts, producing ghost text the user does not expect. If post-processing seems necessary:

1. **Discuss with the user first** — explain the specific problem, why prompt engineering can't solve it, and what the proposed transformation does.
2. **The transformation must be provably safe** — it should only activate when the pattern is always erroneous (never legitimate content), not when it might be correct.
3. **Guard aggressively** — use tight preconditions (length limits, exact-match only, mode checks) so the transformation applies to the narrowest possible set of inputs.
4. **Test both activation and no-op cases** — every post-processing step needs tests that verify it fires when expected _and_ tests that verify it leaves correct completions untouched across a range of realistic inputs.
5. **Document the rationale in code** — each step in `post-process.ts` should have a comment explaining what problem it solves, why it's safe, and what its preconditions are.
6. **Remove workarounds when root causes are fixed** — if the underlying issue is resolved at the prompt or backend level, remove the corresponding post-processing step.

The same caution and approval requirements apply to API-specific cleanup steps in `api-provider.ts` as to the shared `postProcessCompletion()` pipeline.

## Build and Scripts

```bash
npm run compile          # Build once (esbuild → dist/extension.js)
npm run watch            # Build in watch mode (F5 development)
npm run check            # Lint + type-check (run before committing)
npm run lint             # ESLint only
npm run format           # Prettier — format all source files
npm run format:check     # Prettier — check formatting without writing
npm run test             # Alias for test:unit
npm run test:unit        # Vitest unit tests (src/test/unit/)
npm run test:unit:watch  # Vitest watch mode
npm run test:api         # Claude Code integration tests (src/test/api/, needs claude CLI)
npm run test:api:providers  # API vendor integration tests (real API calls, needs API keys)
npm run test:quality     # LLM-as-judge completion quality tests (needs claude CLI)
npm run dump-prompts     # Dump exact prompt strings for Claude Code to prompt-dump.txt
npm run install-ext      # Compile, package VSIX, and install into VSCodium
```

Run a single test file: `npx vitest run src/test/unit/cache.test.ts`

**Pre-commit hooks:** Husky and lint-staged are configured to auto-format staged files on commit via Prettier. The hooks run automatically — no manual setup needed beyond `npm install`.

### Build System

Pressing F5 in VS Code launches the Extension Development Host using the `npm:watch` build task.

esbuild bundles `src/extension.ts` into `dist/extension.js` (CommonJS, targeting Node.js 18). Externals (provided at runtime or loaded dynamically): `vscode`, `@anthropic-ai/claude-agent-sdk`, `@google/genai`. Dependencies: `@anthropic-ai/sdk` (Anthropic API adapter), `openai` (OpenAI-compatible adapter for OpenAI/xAI/Ollama). Optional dependencies: `@anthropic-ai/claude-agent-sdk` (Claude Code backend), `@google/genai` (Gemini adapter).

### Versioning and Installation

Increment the version in `package.json` before running `npm run install-ext`. To package and install manually:

```bash
npm run compile
vsce package --allow-missing-repository
codium --install-extension bespoke-ai.vsix   # or: code --install-extension
```

The `npm run install-ext` script runs compile, package, and install into VSCodium but does not bump the version — increment it in `package.json` before running it. To install into VS Code instead, run the manual steps above with `code --install-extension`.

Increment the patch version (third number) by default for each install. For larger changes (new features, prompt rewrites, architectural shifts), ask whether to bump the minor version instead.

## Architecture

### Request Flow and Routing

```
CompletionProvider (orchestrator — cache, debounce, mode detection)
  ↓
BackendRouter (delegates based on config.backend)
  ├── PoolClient (Claude Code CLI backend)
  └── ApiCompletionProvider (direct API)
        ↓ loads active Preset → selects adapter
        ├── AnthropicAdapter    (@anthropic-ai/sdk)
        ├── OpenAICompatAdapter (openai — covers OpenAI, xAI, Ollama)
        └── GeminiAdapter       (@google/genai)
```

**Inline completions (Claude Code backend):** User types → VS Code calls `provideInlineCompletionItems` → detect mode → extract document context → check LRU (Least Recently Used) cache (returns immediately on hit) → debounce (8000ms default, zero-delay for explicit `Invoke` trigger) → `BackendRouter` → `PoolClient.getCompletion()` → (local fast path or Unix socket IPC to `PoolServer`) → `ClaudeCodeProvider` builds prompt and calls Claude Code CLI → post-process result → cache result → return `InlineCompletionItem`.

**Inline completions (API backend):** Same orchestration through cache and debounce (400ms default) → `BackendRouter` → `ApiCompletionProvider.getCompletion()` → loads active `Preset` → selects SDK adapter → `buildApiPrompt()` constructs messages (with prefill anchor for Anthropic, strong no-preamble instructions for others) → adapter calls vendor API → API-specific post-processing (strips `[CURSOR]` echoes, code fences, preambles) → shared `postProcessCompletion()` → record usage to ledger → cache result → return `InlineCompletionItem`.

**Commit message / Suggest edits / Expand:** Command invoked → `PoolClient.sendCommand()` → (local or socket) → `PoolServer` → `CommandPool.sendPrompt()` → result returned to caller. Commands always use the Claude Code backend regardless of the `backend` setting.

**Trigger mode:** The `bespokeAI.triggerMode` setting controls whether completions auto-fire on typing (`auto`, default) or require an explicit Ctrl+L trigger (`manual`). In `manual` mode, `provideInlineCompletionItems` returns empty for automatic triggers — only explicit invocations proceed.

**Debounce:** Each backend has its own debounce delay. `bespokeAI.debounceMs` (default 8000ms) controls the Claude Code backend. `bespokeAI.api.debounceMs` (default 400ms) controls the API backend. Explicit triggers (Ctrl+L) always use zero-delay regardless of backend.

The `BackendRouter` (`src/providers/backend-router.ts`) implements the `CompletionProvider` interface and delegates to either `PoolClient` (Claude Code) or `ApiCompletionProvider` (direct API) based on the `bespokeAI.backend` setting. It slots into the existing orchestrator with zero changes to `completion-provider.ts`. The orchestrator treats it as any other backend — cache, debounce, and mode detection are unchanged.

### Pool Server

The pool server is a shared-process architecture that allows multiple VS Code windows to share a single set of Claude Code subprocesses.

**Leader election:** The first VS Code window to start tries to connect to an existing server at `~/.bespokeai/pool.sock`. If none exists, it acquires a lockfile (`~/.bespokeai/pool.lock`) using atomic `wx` (write-exclusive, fail-if-exists) file creation to prevent races, then starts a `PoolServer` listening on the Unix socket. All subsequent windows connect as clients. If the server window closes, clients detect the disconnection and race to become the new server (takeover with exponential back-off).

**IPC protocol:** Newline-delimited JSON messages over the Unix domain socket. Request types: `completion`, `command`, `config-update`, `recycle`, `status`, `warmup`, `dispose`, `client-hello`. Server pushes events (`server-shutting-down`, `pool-degraded`) to all connected clients.

**Local fast path:** When the `PoolClient` is also the server (leader), requests bypass the socket entirely and call `PoolServer` methods directly — zero serialization overhead.

**Key files:**

- `src/pool-server/client.ts` — `PoolClient` class. Implements `CompletionProvider` interface. Leader election, socket connection, reconnection with retry, takeover on server loss.
- `src/pool-server/server.ts` — `PoolServer` class. Manages `ClaudeCodeProvider` and `CommandPool` instances, handles IPC requests, lockfile utilities.
- `src/pool-server/protocol.ts` — IPC message type definitions, serialization/parsing helpers.
- `src/pool-server/index.ts` — Re-exports for external consumers.

### Module Reference

#### Core Pipeline

- `src/extension.ts` — Activation entry point. Loads config, creates Logger/PoolClient/ApiCompletionProvider/BackendRouter/CompletionProvider, registers the inline completion provider, status bar, and commands. Watches for config changes and propagates via `updateConfig()`. The status bar menu allows switching between backends and presets.

- `src/completion-provider.ts` — Orchestrator implementing `vscode.InlineCompletionItemProvider`. Coordinates mode detection → context extraction → cache lookup → debounce → backend call → cache write. Explicit triggers (`InlineCompletionTriggerKind.Invoke`, fired by Ctrl+L or the command palette) use zero-delay debounce for instant response. Its constructor accepts a `Logger` and a backend implementing the `CompletionProvider` interface (currently `BackendRouter`). Debounce delay is backend-aware: 400ms for API, 8000ms for Claude Code. Exposes `clearCache()` and `setRequestCallbacks()`.

- `src/providers/backend-router.ts` — `BackendRouter` class. Implements `CompletionProvider` and delegates to `PoolClient` or `ApiCompletionProvider` based on `config.backend`. Falls back to Claude Code when the API provider is unavailable.

- `src/pool-server/` — Global pool server architecture. See [Pool Server](#pool-server) above. `PoolClient` implements `CompletionProvider` and routes requests to the shared `PoolServer` (local or over Unix socket IPC).

- `src/providers/slot-pool.ts` — Abstract base class for SDK session pools. A "slot" is a logical container that holds one Claude Code subprocess — the slot persists across subprocess recycling; the subprocess inside it is replaced. Manages slot lifecycle: init (spawn subprocess) → warmup (validate with a test prompt) → consume (handle user requests) → reuse (serve another request on the same subprocess) → recycle (terminate old subprocess and spawn a new one when `maxRequests` is reached). Also provides:
  - Circuit breaker — automatically stops sending requests after repeated consecutive failures
  - Generation guards — each request cycle gets a monotonically increasing number; responses from a previous generation are discarded
  - Single-waiter queue — only the most recent caller waits for a busy slot; older waiters get `null`
  - Warmup retry, `recycleAll`/`restart`/`dispose`

  Subclassed by `ClaudeCodeProvider` and `CommandPool`.

- `src/providers/claude-code.ts` — Claude Code backend via `@anthropic-ai/claude-agent-sdk`. Extends `SlotPool` for 1-slot inline completion pool.
  - **Prompt structure:** Uses a `>>>CURSOR<<<` marker approach — wraps document prefix + marker + suffix in `<current_text>` tags with a `<completion_start>` anchor. `extractOutput()` strips tags, `stripCompletionStart()` removes the echoed anchor. `buildFillMessage()` is the single source of truth for message construction. Same prompt for prose and code.
  - **Slot pool:** Manages a 1-slot reusable session pool. Each slot handles up to 8 completions before recycling (one subprocess serves N requests).
  - **Queue behavior:** A latest-request-wins queue handles slot acquisition — when the slot is busy, only the most recent request waits (older waiters get `null`). The `AbortSignal` parameter is accepted for interface compatibility but ignored; once a slot is acquired, the request executes fully regardless of cancellation signals.

- `src/providers/command-pool.ts` — 1-slot pre-warmed pool for on-demand commands (commit message, suggest edits). Extends `SlotPool` with a generic system prompt; task-specific instructions are folded into each user message. Each slot handles up to 24 requests before recycling. The `sendPrompt()` method supports optional timeout and cancellation.

#### API Provider (Direct API Backend)

- `src/providers/api/api-provider.ts` — `ApiCompletionProvider` class. Implements `CompletionProvider`. Loads a `Preset`, creates the appropriate SDK adapter, builds prompts via `buildApiPrompt()`, and runs API-specific post-processing (strips `[CURSOR]` echoes, code fences, chatty preambles) before the shared `postProcessCompletion()` pipeline. Records usage (tokens, cost, duration) to the `UsageLedger`.

- `src/providers/api/prompt-builder.ts` — Prompt construction for the API backend. Two strategies:
  - **With prefill** (Anthropic): Simpler system prompt. User message contains `<document>{prefix}[CURSOR]{suffix}</document>` + mode hint. Assistant message is pre-seeded with the last ~40 characters of the prefix (the "prefill anchor") so the model continues naturally from there.
  - **Without prefill** (OpenAI, xAI, Gemini, Ollama): Stronger "output ONLY continuation" system prompt. No assistant prefill. Mode hints guide code vs prose completion style.

- `src/providers/api/presets.ts` — Preset definitions. Built-in presets: `anthropic-haiku-4-5`, `anthropic-sonnet-4-5`, `openai-gpt-4o-mini`, `xai-grok-4-1-fast`, `ollama-default`, `gemini-flash`. Each preset specifies vendor, model ID, generation params (temperature, maxTokens), feature flags (`prefill`, `promptCaching`, `contextCaching`), pricing, and optional notes with per-model tips. `getPreset()` looks up by ID, `getAllPresets()` returns all available.

- `src/providers/api/types.ts` — Interfaces: `Preset`, `ApiAdapter`, `ApiAdapterResult`.

- `src/providers/api/adapters/anthropic.ts` — Anthropic SDK adapter. Prompt caching via `cache_control: { type: 'ephemeral' }` on system prompt. Passes prefill messages through. Rate limits (429/529) return `null` silently. Auth errors (401) throw descriptive message.

- `src/providers/api/adapters/openai-compat.ts` — OpenAI-compatible adapter. Covers OpenAI, xAI/Grok, and Ollama via configurable `baseURL` from preset. Ollama uses `'ollama'` as dummy API key. Connection errors (ECONNREFUSED) return `null` gracefully for Ollama-not-running scenarios.

- `src/providers/api/adapters/gemini.ts` — Google Gemini adapter via `@google/genai` (optional dependency). Maps `assistant` role to `model` for Gemini's API format. Handles both 401 and 403 for auth errors.

- `src/providers/api/index.ts` — Re-exports.

- `src/utils/api-key-store.ts` — Resolves API keys from environment variables or `~/.creds/api-keys.env`.

#### Standalone Commands

- `src/commit-message.ts` — Generates commit messages via the `PoolClient`. Reads diffs from VS Code's built-in Git extension, sends them through `PoolClient.sendCommand()` to the command pool, and writes the result into the Source Control panel's commit message input box. Independent of the inline completion pipeline. Pure helpers live in `src/utils/commit-message-utils.ts`.

- `src/suggest-edit.ts` — On-demand "Suggest Edits" command via the `PoolClient`. Captures visible editor text, sends it through `PoolClient.sendCommand()` for typo/grammar/bug fixes, and applies corrections via `WorkspaceEdit`. Independent of the inline completion pipeline. Pure helpers live in `src/utils/suggest-edit-utils.ts`.

- `src/commands/context-menu.ts` — Context menu commands (Explain, Fix, Alternatives, Condense, Chat). Opens a Claude CLI terminal in a split view and sends the command with the selected file and line range. Does not use the pool server — launches a standalone Claude CLI process. Pure helpers live in `src/commands/context-menu-utils.ts`.

- `src/commands/expand.ts` — Expand command (Ctrl+Shift+L or right-click). Generates 1–3 inline suggestions the user can cycle through (Alt+]/[) and accept with Tab. Two modes: Continue (no selection, smarter continuation from cursor) and Expand (with selection, transforms/expands selected text). Optionally guided via input box. Uses `PoolClient.sendCommand()` to the command pool, parses `<suggestion>` tags, and injects results into `CompletionProvider` for native inline suggest rendering. Pure helpers live in `src/utils/expand-utils.ts`.

#### Mode Detection and Context Extraction

- `src/mode-detector.ts` — Maps `languageId` to `'prose' | 'code'`. Priority: (1) user override via `bespokeAI.mode`, (2) custom language IDs in `prose.fileTypes`, (3) built-in language sets. Unknown languages default to prose.

- `src/utils/context-builder.ts` — Extracts prefix/suffix from `TextDocument` + `Position`. Context sizes configurable via `prose.contextChars`/`code.contextChars` settings. Delegates to `truncation.ts` for boundary-snapped truncation.

- `src/utils/truncation.ts` — Pure truncation functions (no vscode dependency). `truncatePrefix()` takes the last N chars and snaps forward to a newline boundary. `truncateSuffix()` takes the first N chars and snaps back to a word boundary. Used by both `context-builder.ts` (production) and the quality test runner.

#### Utilities

- `src/utils/post-process.ts` — Shared post-processing pipeline applied before caching. Trims prefix overlap (doubled line fragments), trims suffix overlap (duplicated tails), returns `null` for empty results.

- `src/utils/debouncer.ts` — Promise-based debounce with two cancellation layers: `CancellationToken` cancels the wait, `AbortSignal` aborts in-flight requests. `debounce()` accepts an optional `overrideDelayMs` (used by explicit triggers with `0` for instant response).

- `src/utils/cache.ts` — LRU cache with 50 entries and 5-minute TTL (time-to-live). Key built from mode + last 500 prefix chars + first 200 suffix chars.

- `src/utils/expand-utils.ts` — Pure helpers for the expand command. `buildExpandPrompt()` constructs the prompt with document context and optional guidance. `parseSuggestions()` extracts `<suggestion>` tag content from model responses.

- `src/utils/message-channel.ts` — Async message channel utility used by the Claude Code backend for inter-process communication.

- `src/utils/model-name.ts` — `shortenModelName()` pure function for status bar display (e.g., `claude-haiku-4-5-20251001` → `haiku-4.5`).

- `src/utils/workspace.ts` — `getWorkspaceRoot()` utility for resolving the workspace folder path.

- `src/utils/usage-tracker.ts` — Tracks per-session request counts, character counts, cache hits/misses, errors, and burst detection.

- `src/utils/usage-ledger.ts` — Persistent JSONL (JSON Lines, one JSON object per line) ledger at `~/.bespokeai/usage-ledger.jsonl`. Records every interaction (completions, warmups, startups, commit messages, suggest-edits, expand) with SDK metadata (tokens, cost, duration). API backend entries include `backend: 'api'` and per-request cost calculated from preset pricing. Append-only with size-based rotation (1MB threshold) and auto-purge of archives older than 1 month. `getSummary()` reads the active file and returns aggregated stats by period (today/week/month), model, source, and project. Concurrent-safe — multiple VS Code windows can append to the same file.

- `src/utils/logger.ts` — `Logger` class wrapping VS Code `OutputChannel`. See [Log Format and Levels](#log-format-and-levels).

- `src/scripts/dump-prompts.ts` — Utility script (`npm run dump-prompts`) that renders exact prompt strings for prose and code modes.

#### Types

All shared types live in `src/types.ts`. The key interface is `CompletionProvider`, which `PoolClient`, `BackendRouter`, and `ApiCompletionProvider` all implement. `ExtensionConfig` mirrors the `bespokeAI.*` settings in `package.json`. When you change one, update the other to keep them in sync. Key sub-objects: `claudeCode` (models array + active model), `api` (activePreset + debounceMs), and the top-level `backend` field (`'claude-code' | 'api'`).

API-specific types live in `src/providers/api/types.ts`: `Preset` (model configuration), `ApiAdapter` (SDK adapter interface), `ApiAdapterResult` (completion result with usage metrics).

Additional type definitions: `src/types/git.d.ts` provides type definitions for VS Code's built-in Git extension API, used by the commit message feature.

## Development Recipes

### Adding a New Setting

Adding or modifying a VS Code setting requires coordinated changes to:

| #   | File                        | What to change                                                                                                         |
| --- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| 1   | `package.json`              | Add to `contributes.configuration`                                                                                     |
| 2   | `src/types.ts`              | Add field to `ExtensionConfig`                                                                                         |
| 3   | `src/extension.ts`          | Read it in `loadConfig()`                                                                                              |
| 4   | `src/test/helpers.ts`       | Add default value in `DEFAULT_CONFIG`                                                                                  |
| 5   | (varies)                    | Use the new field in the relevant component(s)                                                                         |
| 6   | (varies)                    | If it should apply without restart: propagate via the orchestrator's `updateConfig()`                                  |
| 7   | `src/pool-server/client.ts` | If the setting affects pool behavior: propagate via `PoolClient.updateConfig()`                                        |
| 8   | (varies)                    | If the setting affects the API backend: ensure `BackendRouter`/`ApiCompletionProvider` receive it via `updateConfig()` |

### Adding a Regression Scenario

Regression scenarios (`src/test/quality/regression-scenarios.ts`) capture real-world completion failures observed during use. They run alongside the standard quality scenarios via `npm run test:quality` and flow through the same Layer 1 + Layer 2 pipeline.

Each `RegressionScenario` extends `TestScenario` with:

- `observedModel` — which model/backend produced the failure
- `observedDate` — when the issue was observed
- `regression_notes` — what went wrong, guiding the Layer 2 judge on what to watch for

**Steps:**

1. Copy the prefix and suffix from the trace log **verbatim** — no truncation, no paraphrasing, no edits. The `[TRACE]` lines show the full userMessage and suffix. The goal is to reproduce the exact conditions that caused the failure.
2. Add a `RegressionScenario` to the array in `regression-scenarios.ts`
3. Document the failure in `regression_notes` and set `quality_notes` to tell the judge what constitutes a fix
4. Tag with the `observedModel` and `observedDate`

### Updating This File

When making codebase changes, update the corresponding CLAUDE.md sections:

| Change type          | Update                                           |
| -------------------- | ------------------------------------------------ |
| New source file      | Module Reference                                 |
| New setting          | "Adding a New Setting" table if workflow changes |
| New command          | Overview feature list and Module Reference       |
| New test category    | Testing section                                  |
| Architecture change  | Architecture and Request Flow                    |
| New known limitation | Known Limitations                                |
| New npm script       | Build and Scripts                                |

## Debugging and Fixing Issues

### Log Format and Levels

The `Logger` class (`src/utils/logger.ts`) wraps a VS Code `OutputChannel` ("Bespoke AI"). The `activate()` function creates the Logger and passes it to `PoolClient` and `CompletionProvider`. The `bespokeAI.logLevel` setting controls verbosity:

| Level            | What gets logged                                                 |
| ---------------- | ---------------------------------------------------------------- |
| `info` (default) | Lifecycle: activation, config changes                            |
| `debug`          | Per-request flow: start/end with timing, cache hits, request IDs |
| `trace`          | Full content: prefix, suffix, messages sent, responses received  |
| `error`          | All errors and failures (always logged regardless of level)      |

Each completion request gets a 4-character hex ID (e.g., `#a7f3`) for log correlation. At debug level, requests show visual separators (`───`) and directional markers (`▶` for request start, `◀` for response end). At trace level, content blocks appear indented under the debug-level log lines.

**Identifying the backend from traces:** Claude Code traces show `→ sent` / `← raw` labels. API backend traces show `api →` / `api ←` labels. The `[DEBUG]` line includes `claude-code` or `api` in the backend field.

Example:

```
───────────────────────────────────────────────────────────────────
[DEBUG 00:51:11.539] ▶ #a7f3 | code | claude-code | main.ts | 645+69 chars
[TRACE]   prefix:
          const x = 1;
          ⋮ (445 chars total)
          function foo() {
[TRACE]   → sent (764 chars):
          <current_text>...</current_text>
[DEBUG 00:51:12.374] ◀ #a7f3 | 835ms | 9 chars | slot=0
[TRACE]   ← raw:
          }
```

The output channel is visible in the VS Code Output panel.

### Debugging Completion Issues

When an autocomplete bug is observed (e.g., doubled text, wrong formatting, unwanted content):

**First, diagnose.** Set `bespokeAI.logLevel` to `trace` and reproduce the issue. If the user provides trace output directly, use that for diagnosis rather than asking them to reproduce. Identify which backend generated the trace (see [Log Format and Levels](#log-format-and-levels)). The `[TRACE]` output shows the full prefix, suffix, system prompt, user message, and raw completion. Use this to determine whether the problem is in prompt construction, model output, post-processing, or pool/IPC communication before attempting a fix.

| Symptom source                                              | Action                                                                                               |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Prompt construction (model receives wrong input)            | Claude Code: fix `buildFillMessage()`. API: fix `buildApiPrompt()`                                   |
| Model output (correct input, wrong response)                | Adjust system prompt or preset params (temperature, maxTokens)                                       |
| Pool/IPC (message corruption, timeout, reconnect)           | Debug `PoolClient`/`PoolServer` communication                                                        |
| API adapter (unexpected errors, failed auth, rate limiting) | Check adapter error handling, API key, preset config                                                 |
| Post-processing                                             | Review `post-process.ts` or API-specific cleanup (last resort — see [Working Rules](#working-rules)) |

**API backend specifics:** The API backend has its own post-processing layer in `api-provider.ts` that runs before the shared `postProcessCompletion()`: `stripCursorAndSuffixEcho()` removes echoed `[CURSOR]` markers and suffix text, `stripCodeFences()` removes markdown wrapping, and `stripPreamble()` removes chatty "Here's..." lead-ins.

When fixing a completion bug, consider also adding the failing case as a regression scenario (see [Adding a Regression Scenario](#adding-a-regression-scenario)) so it is covered by future quality test runs.

### Debugging Command Issues

Commit message, suggest-edit, and expand commands use the `CommandPool` (via `PoolClient.sendCommand()`). Diagnosis approach:

1. Check `[DEBUG]` logs for "Commit message", "Suggest edit", or "Expand" entries — they show diff size, prompt size, and timing.
2. Check `[TRACE]` logs for the full prompt and raw response.
3. If the command pool is not ready, check whether the pool server is running and the command slot is in a healthy state (use the status bar menu → Pool Status).
4. For parse failures in suggest-edit, check the raw response format against the expected `<corrected>` tag structure in `suggest-edit-utils.ts`. For expand, check for `<suggestion>` tags in the raw response.

### Troubleshooting: Completions Not Working

If completions stop working entirely:

1. Check status bar — is it showing "AI Off"? Toggle enabled via the status bar menu.
2. Open Output panel ("Bespoke AI") — check for errors.
3. Run the "Bespoke AI: Restart Pools" command.
4. If still broken: check for orphaned processes with `pkill -f "claude.*dangerously-skip-permissions"`.
5. If still broken: check for a stale lockfile at `~/.bespokeai/pool.lock` and remove it.
6. If still broken: disable and re-enable the extension.

For the API backend specifically: verify the API key is set (in `process.env` or `~/.creds/api-keys.env`), check the preset configuration, and look for auth errors (401/403) in the output panel.

## Testing

### Testing Philosophy

Quality tests are our primary mechanism for validating that autocomplete works well in real-world conditions. There is no other systematic way to know — inline completions are subjective, context-dependent, and fail silently (the user just dismisses bad ghost text). Therefore, the quality of the AI is a function of two things:

1. **How comprehensive and realistic the test scenarios are.** Scenarios must cover the user's actual editing patterns — the documents they write, the cursor positions they edit from, the context window sizes they encounter. Tests that only cover easy cases (short prefix, no suffix) will pass while production use fails.
2. **How well autocomplete performs on those scenarios.** A high pass rate on realistic scenarios means the system works. A high pass rate on toy scenarios means nothing.

The two highest-priority use cases for test coverage are:

1. **Journal writing** (`journal.jnl.md` files) — the most common editing context. Personal dated entries, mixed topics, casual voice. Both prefix-only (continuing a thought) and mid-document (cursor between entries).
2. **Prompt writing** (Ctrl+G editor prompts to Claude) — writing instructions, requests, and questions to Claude Code. Usually prefix-only. The critical failure mode is the model answering the user's questions instead of continuing their message.

### Running All Tests

When asked to "run tests" (without further qualification), run the full test suite:

```bash
npm run check && npm run test:unit && npm run test:api && npm run test:api:providers && npm run test:quality
```

If any suite fails, report the failure and stop (the `&&` chaining enforces this). The Claude Code tests and quality tests require the `@anthropic-ai/claude-agent-sdk` package and the `claude` CLI — no API key. The API vendor tests require vendor-specific API keys (`ANTHROPIC_API_KEY`, `XAI_API_KEY`, `GOOGLE_API_KEY`). Suites that lack required dependencies or keys skip without error. After the run, report any skipped suites and why.

**`test:quality` is a two-step process:**

| Step    | Action                     | What it does                                     | Done when                              |
| ------- | -------------------------- | ------------------------------------------------ | -------------------------------------- |
| Layer 1 | `npm run test:quality`     | Generates completions, saves to `test-results/`  | All scenarios produce output (or skip) |
| Layer 2 | Follow stdout instructions | Evaluate each `completion.txt` against validator | `layer2-summary.md` written            |
| Skip    | Report skip reason         | If all scenarios skipped (e.g., no SDK)          | Layer 2 does not apply                 |

Do not report quality tests as complete until Layer 2 is done. After Layer 2 evaluation, report the results to the user. Do not attempt fixes unless asked.

### Unit Tests

Unit tests use Vitest with `globals: true`. Test helpers in `src/test/helpers.ts` provide config factories (`makeConfig`), mock loggers (`makeLogger`, `makeCapturingLogger`), context factories (`makeProseContext`, `makeCodeContext`), mock documents, and fake streams. See the file for the full API.

Debouncer and cache tests use `vi.useFakeTimers()`. For debouncer tests, use `vi.advanceTimersByTimeAsync()` (not `vi.advanceTimersByTime()`) to ensure microtasks flush correctly.

### Claude Code Integration Tests

Claude Code integration tests (`src/test/api/`) make real calls to the Claude Code CLI. They use `describe.skipIf()` to skip when the backend isn't available. The test config (`vitest.api.config.ts`) sets a 30-second timeout.

**Result output:** Tests persist results to `test-results/api-{timestamp}/`, organized by suite. Each JSON file records input context, completion text, duration, and timestamp. `test-results/latest-api` symlinks to the most recent run.

### API Vendor Integration Tests

API vendor tests (`src/test/api/api-provider.test.ts`) make real calls to vendor APIs (Anthropic, xAI/Grok, Gemini). Run with `npm run test:api:providers`. Each vendor suite uses `describe.skipIf()` to skip when the required API key isn't available or doesn't work (Gemini probes with a test request at module load).

**Required API keys** (in `process.env` or `~/.creds/api-keys.env`):

- `ANTHROPIC_API_KEY` — Anthropic tests
- `XAI_API_KEY` — xAI/Grok tests
- `GOOGLE_API_KEY` — Gemini tests (must have Generative AI API enabled)

The test config (`vitest.api-provider.config.ts`) uses 30-second timeout and sequential execution to avoid rate limits. Tests cover prose completion, code completion, suffix bridging (connecting completion text to existing suffix content), bullet continuation, edge cases (empty suffix, short prefix, code continuation), and preset hot-swap (switching the active preset without restarting).

### Quality Tests (LLM-as-Judge)

Quality tests (`src/test/quality/`) evaluate whether completions are actually good, not just structurally valid. They use the Claude Code backend and follow a two-layer validation pattern:

**Layer 1 (automated, `npm run test:quality`):** Generates real completions for every scenario and saves them to `test-results/quality-{timestamp}/`. Each scenario gets a directory with `input.json`, `completion.txt`, `raw-response.txt` (pre-post-processing model output), `requirements.json`, and `metadata.json`. Layer 1 only checks that the backend didn't throw — it does not judge quality. The `test-results/latest` symlink always points to the most recent run.

**Layer 2 (Claude Code in-session, after Layer 1):** You are the evaluator. The Layer 1 test runner prints step-by-step instructions to stdout — follow them. The short version: read the validator prompt (`src/test/quality/validator-prompt.md`), evaluate every scenario's `completion.txt` against it, write a `validation.md` in each scenario's directory and an overall `layer2-summary.md` at the run root. Validate every scenario — do not skip any. Use the Task tool with multiple parallel agents to speed up evaluation if there are many scenarios. If a scenario's completion is null, mark it as a Layer 2 failure.

**Fabricated content is expected and acceptable.** Completions are predictions — the model will invent plausible content (names, dates, code, narrative). Judge whether fabricated content is contextually sensible, not whether it's factually accurate.

**Scenario categories:**

- `scenarios.ts` — Standard prose, code, and edge case scenarios
- `regression-scenarios.ts` — Captured real-world completion failures
- `scenarios/prose-mid-document.ts` — Full-window mid-document prose editing (8 scenarios)
- `scenarios/prose-journal.ts` — Journal writing in `journal.jnl.md` format + meeting notes (12 scenarios)
- `scenarios/prose-bridging.ts` — Fill-in-the-middle bridging (6 scenarios)
- `scenarios/code-mid-file.ts` — Realistic mid-file code completion (6 scenarios)
- `scenarios/prose-prompt-writing.ts` — Prompt/message writing to Claude Code (6 scenarios)
- `scenarios/prose-full-window.ts` — Large anchor document prose scenarios (5 scenarios)
- `scenarios/code-full-window.ts` — Large anchor document code scenarios (3 scenarios)

**Scenario design:** Each scenario declares a `saturation` field (whether raw text exceeds the production context window) and the test runner applies production-equivalent truncation. For design principles (over-window content, saturation balance, anchor documents), see `docs/autocomplete-approach.md` Section 5. Verify character counts with `npx tsx src/test/quality/measure-scenarios.ts`.

**Testing different models:** By default, all integration and quality tests use the model from `makeConfig()` (currently `opus`). Override with `TEST_MODEL`:

```bash
TEST_MODEL=haiku npm run test:api       # API tests with haiku
TEST_MODEL=sonnet npm run test:quality   # quality tests with sonnet
```

`QUALITY_TEST_MODEL` is still supported as a backward-compatible alias but `TEST_MODEL` takes precedence. The model name is recorded in `summary.json` so results are traceable.

**Key files:**

- `src/test/quality/scenarios.ts` — Reference scenarios: input contexts and quality requirements
- `src/test/quality/validator-prompt.md` — Evaluation criteria (scoring rubric, per-mode rules)
- `src/test/quality/judge.ts` — Type definitions for scenarios and judgments
- `test-results/` — Generated outputs (gitignored)

To add a new scenario, add a `TestScenario` object to the prose, code, or edge-case scenario array in `scenarios.ts`. To adjust judging criteria, edit `validator-prompt.md`.

## Known Limitations

These are deliberate trade-offs. Do not attempt to fix them unless explicitly asked.

- Cache keys do not include the document URI, so identical prefix/suffix text in different files can return a cached completion that was generated for a different file.
- The cache does not clear automatically on individual setting changes. Until entries expire (5-minute TTL) or are evicted, cached completions may reflect previous settings. Use the "Bespoke AI: Clear Completion Cache" command to manually clear it.
- The extension does not validate config values. Invalid settings pass through to the backend as-is.
- Tests use top-level `await`, which is incompatible with the `commonjs` module setting in `tsconfig.json`. To avoid build errors, `tsconfig.json` excludes `src/test/` and `src/benchmark/`. Vitest uses its own TypeScript transformer, so this does not affect test execution.
- Context menu commands (Explain, Fix, Alternatives, Condense, Chat) do not check the `bespokeAI.enabled` setting because they launch standalone Claude CLI processes independent of the pool server. They work even when inline completions are disabled.
- **Subprocess cleanup:** The extension relies on `channel.close()` and SDK behavior to terminate Claude Code subprocesses. It does not track subprocess PIDs and cannot force-kill orphaned processes. If someone force-kills VS Code (e.g., `kill -9`), subprocesses may survive until they timeout or are manually cleaned with: `pkill -f "claude.*dangerously-skip-permissions"`
- **Benchmarking:** The benchmark system (`src/benchmark/`) is currently disabled and needs a rewrite. The runner and configs still reference removed providers. The judge (`src/benchmark/judge.ts`) still works independently as it uses the Anthropic SDK directly. If asked to run benchmarks, explain the situation and ask whether the user wants to proceed with a rewrite.
