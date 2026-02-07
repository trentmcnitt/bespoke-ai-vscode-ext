# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository. Update this file when adding or removing components, changing workflows, or modifying the architecture — keep it in sync with the codebase.

**Related docs:**

- `DEV_LOG.md` — Reverse-chronological development decisions and lessons learned. Update it when making significant changes or discovering important behaviors.
- `ROADMAP.md` — Tracks planned, exploratory, and deferred features.
- `FEATURE_MAP.md` — Competitive landscape analysis and open-source reference guide. Check it before implementing a feature that may already exist in an open-source project.
- `API_RETURN_NOTES.md` — Why direct API providers (Anthropic, Ollama) were removed and what to consider if restoring them.
- `docs/` — Research and reference documents (CLI reference, latency research, prompt templates, etc.). Consult when working on the Claude Code backend or prompt engineering.

## Overview

Bespoke AI is a personal AI toolkit for VS Code that provides inline completions (ghost text — the gray preview text shown before accepting) for prose and code, a commit message generator, a suggest-edits command (fixes typos/grammar/bugs in visible text), an expand command (guided multi-suggestion inline completions via right-click or Ctrl+Shift+L), and context menu commands (Explain, Fix, Alternatives, Condense, Chat). It uses the Claude Code CLI, which requires a Claude subscription. Auto-detects prose vs code completion mode based on `document.languageId`. The extension works identically in both VS Code and VSCodium.

The Claude Code backend is the sole provider. Do not implement new capabilities beyond inline completions, commit messages, suggest-edits, expand, and context menu commands unless explicitly asked.

## Policies and Guidelines

**Interpreting pasted content:** When the user pastes log output, error messages, or other unaccompanied diagnostic content, assume they want you to investigate the issue. Diagnose, identify the root cause, and propose a fix.

**Error handling pattern:** The backend catches abort errors and returns `null`; all other errors propagate to the completion orchestrator, which logs them via the `Logger`. Completion errors are shown to the user via `showErrorMessage`, rate-limited to one toast per 60 seconds. New code should follow this same pattern.

**Pre-commit gate:** Run `npm run check` before creating any commit. Only proceed if it passes.

**Version control:** This project uses GitHub. Use `gh` for repository operations. Work directly on `main` unless asked to create a branch.

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
npm run test:api         # API integration tests (src/test/api/, needs claude CLI)
npm run test:quality     # LLM-as-judge completion quality tests (needs claude CLI)
npm run dump-prompts     # Dump exact prompt strings for Claude Code to prompt-dump.txt
npm run install-ext      # Compile, package VSIX, and install into VSCodium
```

Run a single test file: `npx vitest run src/test/unit/cache.test.ts`

**Pre-commit hooks:** Husky and lint-staged are configured to auto-format staged files on commit via Prettier. The hooks run automatically — no manual setup needed beyond `npm install`.

### Build System

Pressing F5 in VS Code launches the Extension Development Host using the `npm:watch` build task.

esbuild bundles `src/extension.ts` into `dist/extension.js` (CommonJS, targeting Node.js 18). The build marks the `vscode` module as external because the VS Code host provides it at runtime. Optional dependency: `@anthropic-ai/claude-agent-sdk` (Claude Code backend). `@anthropic-ai/sdk` is a devDependency used only by the benchmark judge.

### Versioning and Installation

Increment the version in `package.json` with each development iteration before installing. To package and install:

```bash
npm run compile
vsce package --allow-missing-repository
codium --install-extension bespoke-ai.vsix   # or: code --install-extension
```

The `npm run install-ext` script runs compile, package, and install but does not bump the version — increment it manually first.

Increment the patch version (third number) by default for each install. For larger changes (new features, prompt rewrites, architectural shifts), ask whether to bump the minor version instead.

## Adding a New Setting

Adding or modifying a VS Code setting requires coordinated changes to:

| Step | File                        | What to change                                                                        |
| ---- | --------------------------- | ------------------------------------------------------------------------------------- |
| 1    | `package.json`              | Add to `contributes.configuration`                                                    |
| 2    | `src/types.ts`              | Add field to `ExtensionConfig`                                                        |
| 3    | `src/extension.ts`          | Read it in `loadConfig()`                                                             |
| 4    | `src/test/helpers.ts`       | Add default value in `DEFAULT_CONFIG`                                                 |
| 5    | (varies)                    | Use the new field in the relevant component(s)                                        |
| 6    | (varies)                    | If it should apply without restart: propagate via `CompletionProvider.updateConfig()` |
| 7    | `src/pool-server/client.ts` | If the setting affects pool behavior: propagate via `PoolClient.updateConfig()`       |

## Architecture

### Request Flow

**Inline completions:** User types → VS Code calls `provideInlineCompletionItems` → detect mode → extract document context → check LRU cache (returns immediately on hit) → debounce (batches rapid keystrokes; 8000ms default, zero-delay for explicit `Invoke` trigger) → `PoolClient.getCompletion()` → (local fast path if this window is the server, or Unix socket IPC to the `PoolServer`) → `ClaudeCodeProvider` builds prompt and calls Claude Code CLI → post-process result → cache result → return `InlineCompletionItem`.

**Commit message / Suggest edits:** Command invoked → `PoolClient.sendCommand()` → (local or socket) → `PoolServer` → `CommandPool.sendPrompt()` → result returned to caller.

### Pool Server

The pool server is a shared-process architecture that allows multiple VS Code windows to share a single set of Claude Code subprocesses.

**Leader election:** The first VS Code window to start tries to connect to an existing server at `~/.bespokeai/pool.sock`. If none exists, it acquires a lockfile (`~/.bespokeai/pool.lock`) using atomic `wx` file creation to prevent races, then starts a `PoolServer` listening on the Unix socket. Subsequent windows connect as clients. If the server window closes, clients detect the disconnection and race to become the new server (takeover with exponential back-off).

**IPC protocol:** Newline-delimited JSON messages over the Unix domain socket. Request types: `completion`, `command`, `config-update`, `recycle`, `status`, `warmup`, `dispose`, `client-hello`. Server pushes events (`server-shutting-down`, `pool-degraded`) to all connected clients.

**Local fast path:** When the `PoolClient` is also the server (leader), requests bypass the socket entirely and call `PoolServer` methods directly — zero serialization overhead.

**Key files:**

- `src/pool-server/client.ts` — `PoolClient` class. Implements `CompletionProvider` interface. Leader election, socket connection, reconnection with retry, takeover on server loss.
- `src/pool-server/server.ts` — `PoolServer` class. Manages `ClaudeCodeProvider` and `CommandPool` instances, handles IPC requests, lockfile utilities.
- `src/pool-server/protocol.ts` — IPC message type definitions, serialization/parsing helpers.
- `src/pool-server/index.ts` — Re-exports for external consumers.

### Logging

The `Logger` class (`src/utils/logger.ts`) wraps a VS Code `OutputChannel` ("Bespoke AI"). The `activate()` function creates the Logger and passes it to `PoolClient` and `CompletionProvider`. The `bespokeAI.logLevel` setting controls verbosity:

| Level               | What gets logged                                                 |
| ------------------- | ---------------------------------------------------------------- |
| `info` (default)    | Lifecycle: activation, config changes                            |
| `debug`             | Per-request flow: start/end with timing, cache hits, request IDs |
| `trace`             | Full content: prefix, suffix, messages sent, responses received  |
| `error` (always on) | Failures are always logged regardless of the selected level      |

Each completion request gets a 4-character hex ID (e.g., `#a7f3`) for log correlation. At debug level, requests show visual separators (`───`) and directional markers (`▶` for request start, `◀` for response end). At trace level, content blocks appear indented under the debug-level log lines. Example:

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

### Module Reference

#### Core Pipeline

- `src/extension.ts` — Activation entry point. Loads config, creates Logger/PoolClient/CompletionProvider, registers the inline completion provider, status bar, and commands. Watches for config changes and propagates via `updateConfig()`.

- `src/completion-provider.ts` — Orchestrator implementing `vscode.InlineCompletionItemProvider`. Coordinates mode detection → context extraction → cache lookup → debounce → backend call → cache write. Explicit triggers (`InlineCompletionTriggerKind.Invoke`, fired by Ctrl+L or the command palette) use zero-delay debounce for instant response. Its constructor accepts a `Logger` and a backend implementing the `CompletionProvider` interface (currently `PoolClient`). Exposes `clearCache()` and `setRequestCallbacks()`.

- `src/pool-server/` — Global pool server architecture. See [Pool Server](#pool-server) above. `PoolClient` implements `CompletionProvider` and routes requests to the shared `PoolServer` (local or over Unix socket IPC).

- `src/providers/slot-pool.ts` — Abstract base class for SDK session pools. A "slot" is a reusable Claude Code subprocess session. Manages slot lifecycle: init (spawn subprocess) → warmup (validate with a test prompt) → consume (handle user requests) → reuse (serve another request on the same subprocess) → recycle (terminate old subprocess and spawn a new one when `maxRequests` is reached). Also provides: circuit breaker (stops requests after repeated failures), generation guards (prevent stale responses from previous request cycles from being returned), single-waiter queue (only the most recent caller waits for a busy slot; older waiters get `null`), warmup retry, and `recycleAll`/`restart`/`dispose`. Subclassed by `ClaudeCodeProvider` and `CommandPool`.

- `src/providers/claude-code.ts` — Claude Code backend via `@anthropic-ai/claude-agent-sdk`. Extends `SlotPool` for 1-slot inline completion pool.
  - **Prompt structure:** Uses a `>>>CURSOR<<<` marker approach — wraps document prefix + marker + suffix in `<current_text>` tags with a `<completion_start>` anchor. `extractOutput()` strips tags, `stripCompletionStart()` removes the echoed anchor. `buildFillMessage()` is the single source of truth for message construction. Same prompt for prose and code.
  - **Slot pool:** Manages a 1-slot reusable session pool. Each slot handles up to 8 completions before recycling (one subprocess serves N requests).
  - **Queue behavior:** A latest-request-wins queue handles slot acquisition — when the slot is busy, only the most recent request waits (older waiters get `null`). The `AbortSignal` parameter is accepted for interface compatibility but ignored; once a slot is acquired, the request runs to completion regardless of cancellation signals.

- `src/providers/command-pool.ts` — 1-slot pre-warmed pool for on-demand commands (commit message, suggest edits). Extends `SlotPool` with a generic system prompt; task-specific instructions are folded into each user message. Each slot handles up to 24 requests before recycling. The `sendPrompt()` method supports optional timeout and cancellation.

#### Standalone Commands

- `src/commit-message.ts` — Generates commit messages via the `PoolClient`. Reads diffs from VS Code's built-in Git extension, sends them through `PoolClient.sendCommand()` to the command pool, and writes the result into the Source Control panel's commit message input box. Independent of the inline completion pipeline. Pure helpers live in `src/utils/commit-message-utils.ts`.

- `src/suggest-edit.ts` — On-demand "Suggest Edits" command via the `PoolClient`. Captures visible editor text, sends it through `PoolClient.sendCommand()` for typo/grammar/bug fixes, and applies corrections via `WorkspaceEdit`. Independent of the inline completion pipeline. Pure helpers live in `src/utils/suggest-edit-utils.ts`.

- `src/commands/context-menu.ts` — Context menu commands (Explain, Fix, Alternatives, Condense, Chat). Opens a Claude CLI terminal in a split view and sends the command with the selected file and line range. Does not use the pool server — launches a standalone Claude CLI process.

- `src/commands/expand.ts` — Expand command (Ctrl+Shift+L or right-click). Generates 1–3 inline suggestions the user can cycle through (Alt+]/[) and accept with Tab. Two modes: Continue (no selection, smarter continuation from cursor) and Expand (with selection, transforms/expands selected text). Optionally guided via input box. Uses `PoolClient.sendCommand()` to the command pool, parses `<suggestion>` tags, and injects results into `CompletionProvider` for native inline suggest rendering. Pure helpers live in `src/utils/expand-utils.ts`.

#### Detection and Context

- `src/mode-detector.ts` — Maps `languageId` to `'prose' | 'code'`. Priority: (1) user override via `bespokeAI.mode`, (2) custom language IDs in `prose.fileTypes`, (3) built-in language sets. Unknown languages default to prose.

- `src/utils/context-builder.ts` — Extracts prefix/suffix from `TextDocument` + `Position`. Context sizes configurable via `prose.contextChars`/`code.contextChars` settings.

#### Utilities

- `src/utils/expand-utils.ts` — Pure helpers for the expand command. `buildExpandPrompt()` constructs the prompt with document context and optional guidance. `parseSuggestions()` extracts `<suggestion>` tag content from model responses.

- `src/utils/post-process.ts` — Shared post-processing pipeline applied before caching. Trims prefix overlap (doubled line fragments), trims suffix overlap (duplicated tails), returns `null` for empty results.

- `src/utils/debouncer.ts` — Promise-based debounce with two cancellation layers: `CancellationToken` cancels the wait, `AbortSignal` aborts in-flight requests. `debounce()` accepts an optional `overrideDelayMs` (used by explicit triggers with `0` for instant response).

- `src/utils/cache.ts` — LRU cache with 50 entries and 5-minute TTL (time-to-live). Key built from mode + last 500 prefix chars + first 200 suffix chars.

- `src/utils/message-channel.ts` — Async message channel utility used by the Claude Code backend for inter-process communication.

- `src/utils/model-name.ts` — `shortenModelName()` pure function for status bar display (e.g., `claude-haiku-4-5-20251001` → `haiku-4.5`).

- `src/utils/workspace.ts` — `getWorkspaceRoot()` utility for resolving the workspace folder path. Used by extension.ts for project-relative operations.

- `src/utils/usage-tracker.ts` — Tracks per-session completion counts, character counts, cache hits/misses, errors, and burst detection.

- `src/utils/usage-ledger.ts` — Persistent JSONL (JSON Lines, one JSON object per line) ledger at `~/.bespokeai/usage-ledger.jsonl`. Records every Claude Code interaction (completions, warmups, startups, commit messages, suggest-edits, expand) with SDK metadata (tokens, cost, duration). Append-only with size-based rotation (1MB threshold) and auto-purge of archives older than 1 month. `getSummary()` reads the active file and returns aggregated stats by period (today/week/month), model, source, and project. Concurrent-safe — multiple VS Code windows can append to the same file.

- `src/utils/logger.ts` — `Logger` class wrapping VS Code `OutputChannel`. See [Logging](#logging).

- `src/scripts/dump-prompts.ts` — Utility script (`npm run dump-prompts`) that renders exact prompt strings for prose and code modes.

#### Types

All shared types live in `src/types.ts`. The key interface is `CompletionProvider`, which `PoolClient` implements (and which `ClaudeCodeProvider` also implements within the pool server). `ExtensionConfig` mirrors the `bespokeAI.*` settings in `package.json`. When you change one, update the other to keep them in sync. The `claudeCode` sub-object includes a `models` array (informational catalog) and a `model` string (the active model).

Additional type definitions: `src/types/git.d.ts` provides type definitions for VS Code's built-in Git extension API, used by the commit message feature.

## Debugging and Fixing Issues

### Debugging Completion Issues

When an autocomplete bug is observed (e.g., doubled text, wrong formatting, unwanted content):

**First, diagnose.** Set `bespokeAI.logLevel` to `trace` and reproduce the issue. If the user provides trace output directly, use that for diagnosis rather than asking them to reproduce. The `[TRACE]` output shows the full prefix, suffix, system prompt, user message, and raw completion. Use this to determine whether the problem is in prompt construction, model output, post-processing, or pool/IPC communication before attempting a fix.

| Symptom source                                    | Action                                                      |
| ------------------------------------------------- | ----------------------------------------------------------- |
| Prompt construction (model receives wrong input)  | Fix in `buildFillMessage()` or the system prompt            |
| Model output (correct input, wrong response)      | Adjust prompt or system prompt                              |
| Pool/IPC (message corruption, timeout, reconnect) | Debug `PoolClient`/`PoolServer` communication               |
| Post-processing                                   | Review `post-process.ts` pipeline (last resort — see below) |

**Strongly prefer prompt engineering over post-processing.** Adjust the system prompt, `<completion_start>` anchor, or backend configuration first. Post-processing (algorithmic trimming/transformation in `post-process.ts`) is a last resort, not an alternative to try alongside prompt fixes.

**Why post-processing is risky:** Algorithmic text manipulation that looks correct for the observed failure case often silently breaks completions in other contexts, producing unpredictable ghost text the user didn't ask for. Edge cases compound — each post-processing step interacts with every other step and with every possible completion the model might produce. The result is brittle behavior that's hard to diagnose because the user sees ghost text that doesn't match what the model actually returned.

**If post-processing seems necessary:**

1. **Discuss with the user first** — explain the specific problem, why prompt engineering can't solve it, and what the proposed transformation does. Do not add post-processing without explicit approval.
2. **The transformation must be provably safe** — it should only activate when the input is _always_ wrong (a true invariant violation), never when the input _might_ be correct. If there's any ambiguity about whether the text is a duplicate vs. legitimate content, don't strip it.
3. **Guard aggressively** — use tight preconditions (length limits, exact-match only, mode checks) so the transformation applies to the narrowest possible set of inputs. Broad pattern matching or fuzzy heuristics are not acceptable.
4. **Test both activation and no-op cases** — every post-processing step needs tests that verify it fires when expected _and_ tests that verify it leaves correct completions untouched across a range of realistic inputs.
5. **Document the rationale in code** — each step in `post-process.ts` should have a comment explaining what problem it solves, why it's safe, and what its preconditions are.
6. **Remove workarounds when root causes are fixed** — if the underlying issue is resolved at the prompt or backend level, remove the corresponding post-processing step. Stale workarounds accumulate risk.

When fixing a completion bug, consider also adding the failing case as a regression scenario (see Regression Scenarios) so it is covered by future quality test runs.

### Debugging Commit Message, Suggest-Edit, and Expand Issues

These commands use the `CommandPool` (via `PoolClient.sendCommand()`). Diagnosis approach:

1. Check `[DEBUG]` logs for "Commit message", "Suggest edit", or "Expand" entries — they show diff size, prompt size, and timing.
2. Check `[TRACE]` logs for the full prompt and raw response.
3. If the command pool is not ready, check whether the pool server is running and the command slot is in a healthy state (use the status bar menu → Pool Status).
4. For parse failures in suggest-edit, check the raw response format against the expected `<corrected>` tag structure in `suggest-edit-utils.ts`. For expand, check for `<suggestion>` tags in the raw response.

## Known Limitations

These are accepted trade-offs. Do not attempt to fix them unless explicitly asked.

- Cache keys do not include the document URI, so identical prefix/suffix text in different files can return a cached completion that was generated for a different file.
- The cache does not clear automatically on individual setting changes. Until entries expire (5-minute TTL, time-to-live) or are evicted, cached completions may reflect previous settings. Use the "Bespoke AI: Clear Completion Cache" command to manually clear it.
- The extension does not validate config values. Invalid settings pass through to the backend without checking.
- Tests use top-level `await`, which is incompatible with the `commonjs` module setting in `tsconfig.json`. To avoid build errors, `tsconfig.json` excludes `src/test/` and `src/benchmark/`. Vitest uses its own TypeScript transformer, so this does not affect test execution.
- **Subprocess cleanup:** The extension relies on `channel.close()` and SDK behavior to terminate Claude Code subprocesses. It does not track subprocess PIDs and cannot force-kill orphaned processes. If VS Code crashes or is force-killed (e.g., `kill -9`), subprocesses may remain until they timeout or are manually cleaned with: `pkill -f "claude.*dangerously-skip-permissions"`

## Testing

### Running All Tests

When asked to "run tests" (without further qualification), run the full test suite:

```bash
npm run check && npm run test:unit && npm run test:api && npm run test:quality
```

The Claude Code API tests and quality tests require the `@anthropic-ai/claude-agent-sdk` package and the `claude` CLI — no API key. Suites that lack required dependencies skip without error. After the run, report any skipped suites and why.

**`test:quality` is a two-step process.** Running `npm run test:quality` is only Layer 1 (generation). You must then perform Layer 2 (evaluation) by following the instructions printed to stdout. Do not report quality tests as complete until Layer 2 is done. If all quality scenarios are skipped (e.g., SDK not available), Layer 2 is not applicable — report the skip reason and stop.

After Layer 2 evaluation, report the results to the user. Do not attempt fixes unless asked.

### Unit Tests

Unit tests use Vitest with `globals: true`. Test helpers in `src/test/helpers.ts` provide:

- `makeConfig()` — config factory with sensible defaults
- `makeLogger()` / `makeCapturingLogger()` — no-op mock Logger / captures `traceBlock` calls for inspecting raw output
- `makeProseContext()` / `makeCodeContext()` — factory functions for `CompletionContext`
- `makeDocument()` — creates mock `TextDocument` for unit tests
- `createMockToken()` — mock `CancellationToken` with a `cancel()` trigger
- `makeLedger()` — creates a `UsageLedger` backed by a temp directory
- `getTestModel()` — returns test model with `TEST_MODEL` env var precedence
- `makeFakeStream()` / `FakeStream` — creates fake async iterable streams for SDK testing
- `assertWarmupValid()` / `assertModelMatch()` — validation helpers for warmup responses and model matching
- `consumeIterable()` — helper to consume async iterables in background
- `loadApiKey()` — reads `ANTHROPIC_API_KEY` from the environment

Debouncer and cache tests use `vi.useFakeTimers()`. For debouncer tests, use `vi.advanceTimersByTimeAsync()` (not `vi.advanceTimersByTime()`) to ensure microtasks flush correctly.

### API Integration Tests

API integration tests (`src/test/api/`) make real calls to the Claude Code CLI. They use `describe.skipIf()` to skip when the backend isn't available. The API test config (`vitest.api.config.ts`) sets a 30-second timeout.

**Result output:** Tests persist results to `test-results/api-{timestamp}/`, organized by suite. Each JSON file records input context, completion text, duration, and timestamp. `test-results/latest-api` symlinks to the most recent run.

### Quality Tests (LLM-as-Judge)

Quality tests (`src/test/quality/`) evaluate whether completions are actually good, not just structurally valid. They use the Claude Code backend and follow a two-layer validation pattern:

**Layer 1 (automated, `npm run test:quality`):** Generates real completions for every scenario and saves them to `test-results/quality-{timestamp}/`. Each scenario gets a directory with `input.json`, `completion.txt`, `raw-response.txt` (pre-post-processing model output), `requirements.json`, and `metadata.json`. Layer 1 only checks that the backend didn't throw — it does not judge quality. The `test-results/latest` symlink always points to the most recent run.

**Layer 2 (Claude Code in-session, after Layer 1):** You are the evaluator. The Layer 1 test runner prints step-by-step instructions to stdout — follow them. The short version: read the validator prompt (`src/test/quality/validator-prompt.md`), evaluate every scenario's `completion.txt` against it, write a `validation.md` in each scenario's directory and an overall `layer2-summary.md` at the run root. Validate every scenario — do not skip any. Use the Task tool with multiple parallel agents to speed up evaluation if there are many scenarios. If a scenario's completion is null, mark it as a Layer 2 failure.

**Fabricated content is expected and acceptable.** Completions are predictions — the model will invent plausible content (names, dates, code, narrative). Judge whether fabricated content is contextually sensible, not whether it's factually accurate.

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

#### Regression Scenarios

Regression scenarios (`src/test/quality/regression-scenarios.ts`) capture real-world completion failures observed during use. They run alongside the standard quality scenarios via `npm run test:quality` and flow through the same Layer 1 + Layer 2 pipeline.

Each `RegressionScenario` extends `TestScenario` with:

- `observedModel` — which model/backend produced the failure
- `observedDate` — when the issue was observed
- `regression_notes` — what went wrong, guiding the Layer 2 judge on what to watch for

**Adding a new regression case:**

1. Copy the **exact** prefix and suffix from the trace log verbatim — no truncation, no paraphrasing, no edits. The `[TRACE]` lines show the full userMessage and suffix. The goal is to reproduce the exact conditions that caused the failure.
2. Add a `RegressionScenario` to the array in `regression-scenarios.ts`
3. Document the failure in `regression_notes` and set `quality_notes` to tell the judge what constitutes a fix
4. Tag with the `observedModel` and `observedDate`

## Benchmarking (Non-Functional)

The benchmark system (`src/benchmark/`) is currently non-functional and needs a rewrite for the Claude Code backend. The runner and configs still reference the removed Anthropic/Ollama providers. The judge (`src/benchmark/judge.ts`) still works independently as it uses the Anthropic SDK directly. If asked to run benchmarks, explain the situation and ask whether the user wants to proceed with a rewrite.
