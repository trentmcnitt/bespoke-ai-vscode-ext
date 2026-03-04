# CLAUDE.md

This file contains instructions and reference material for Claude Code (claude.ai/code) when working with this repository. Update this file when adding or removing components, changing workflows, or modifying the architecture — see [Updating This File](#updating-this-file) for the checklist. Keep it in sync with the codebase.

**Related docs:**

- `DEV_LOG.md` — Reverse-chronological development decisions and lessons learned. Update it when making significant changes or discovering important behaviors.
- `FEATURE_MAP.md` — Competitive landscape analysis and open-source reference guide. Check it before implementing a feature that may already exist in an open-source project.
- `README.md` — Public-facing project documentation for the VS Code marketplace.
- `CHANGELOG.md` — Release history and version notes.
- `docs/` — Research and reference documents. Key files:
  - `docs/autocomplete-approach.md` — Autocomplete philosophy, prompt design, and testing strategy
  - `docs/claude-code-cli-reference.md` — CLI flags and usage
  - `docs/prompt-template-research.md` — Prompt engineering patterns
  - (see directory for full listing)

## Overview

Bespoke AI is a personal AI toolkit for VS Code (works identically in VSCodium). It provides:

- **Inline completions** — ghost text (the gray preview text shown before accepting) for prose and code
- **Commit message generation** — from staged diffs
- **Suggest edits** — fixes typos, grammar, and bugs in visible text
- **Context menu commands** — Explain, Fix, Do

Auto-detects prose vs code completion mode based on `document.languageId`.

Supports two backends: **Claude Code CLI** (via `@anthropic-ai/claude-agent-sdk`, requires a Claude subscription) and **direct API** (via Anthropic, OpenAI, Google Gemini, xAI, OpenRouter, or Ollama — requires an API key). The `bespokeAI.backend` setting controls which is active. Context menu commands (Explain, Fix, Do) require the Claude Code CLI backend.

## Working Rules

**Feature scope:** Do not implement new capabilities beyond inline completions, commit messages, Suggest Edits, and context menu commands (Explain, Fix, Do) unless explicitly asked. Do not fix items listed under [Known Limitations](#known-limitations) or introduce post-processing without explicit approval.

**Interpreting pasted content:** When the user pastes log output, error messages, or other diagnostic content without an explicit instruction, assume they want you to investigate the issue. Diagnose, identify the root cause, and propose a fix. If the diagnosed issue matches a [Known Limitation](#known-limitations), explain the trade-off rather than proposing a fix.

**Error handling pattern:** `ClaudeCodeProvider` and `CommandPool` catch abort errors and return `null`; all other errors propagate to the completion orchestrator, which logs them via the `Logger`. The orchestrator shows errors to the user via `showErrorMessage`, rate-limited to one notification per 60 seconds. New code should follow this same pattern.

**Pre-commit gate:** Run `npm run check` before creating any commit. Only proceed if it passes.

**Version control:** This project uses GitHub. Use `gh` for repository operations. Work on the current branch. Do not create feature branches unless asked.

**Strongly prefer prompt engineering over post-processing.** Post-processing is a last resort. See [Adding Post-Processing](#adding-post-processing) for the required protocol when prompt engineering cannot solve the problem.

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
npm run test:api         # Integration tests (src/test/api/). See Testing section for env vars.
npm run test:quality     # LLM-as-judge completion quality tests (see Testing for env vars)
npm run test:quality:compare  # A/B/N prompt variant comparison (needs PROMPT_VARIANTS env var)
npm run dump-prompts     # Dump exact prompt strings for Claude Code to prompt-dump.txt
npm run install-ext      # Compile, package VSIX, and install into VSCodium
```

Run a single test file: `npx vitest run src/test/unit/cache.test.ts`

**Pre-commit hooks:** Husky and lint-staged are configured to auto-format staged files on commit via Prettier. The hooks run automatically — no manual setup needed beyond `npm install`.

### Build System

Pressing F5 in VS Code launches the Extension Development Host using the `npm:watch` build task.

esbuild bundles `src/extension.ts` into `dist/extension.js` (CommonJS, targeting Node.js 18). Externals: `vscode` (provided by VS Code runtime), `@anthropic-ai/claude-agent-sdk` (has native binaries, shipped in VSIX via `.vscodeignore`). The API SDKs (`@anthropic-ai/sdk`, `openai`) are bundled by esbuild so they work without runtime module resolution. `@anthropic-ai/claude-agent-sdk` is an optional dependency (Claude Code backend only).

### Versioning and Installation

`npm run install-ext` compiles, packages a VSIX, and installs into VSCodium. To install into VS Code instead:

```bash
npm run compile && vsce package -o bespoke-ai.vsix && code --install-extension bespoke-ai.vsix
```

Do not increment the version in `package.json` unless explicitly asked.

## Architecture

### Request Flow and Routing

```
CompletionProvider (orchestrator — cache, debounce, mode detection)
  ↓
BackendRouter (routes to active backend based on config.backend)
  ├── claude-code: PoolClient → PoolServer → ClaudeCodeProvider + CommandPool
  └── api: ApiCompletionProvider / ApiCommandProvider → Adapters → HTTP APIs
```

**Inline completions (Claude Code backend):** User types → VS Code calls `provideInlineCompletionItems` → detect mode → extract document context → check LRU (Least Recently Used) cache (returns immediately on hit) → debounce (2000ms default, zero-delay for explicit `Invoke` trigger) → `BackendRouter.getCompletion()` → `PoolClient.getCompletion()` → (local fast path or IPC to `PoolServer`) → `ClaudeCodeProvider` builds prompt and calls Claude Code CLI → post-process result → cache result → return `InlineCompletionItem`.

**Inline completions (API backend):** Same orchestrator flow → `BackendRouter.getCompletion()` → `ApiCompletionProvider.getCompletion()` → selects `PromptStrategy` from preset → builds prompt via shared `buildFillMessage()` → adapter makes HTTP call → extracts completion via strategy → post-process → cache → return.

**Commit message / Suggest edits (Claude Code):** Command invoked → `BackendRouter.sendCommand()` → `PoolClient.sendCommand()` → `PoolServer` → `CommandPool.sendPrompt()` → result returned.

**Commit message / Suggest edits (API):** Command invoked → `BackendRouter.sendCommand()` → `ApiCommandProvider.sendPrompt()` → adapter HTTP call → result returned.

**Trigger presets:** The `bespokeAI.triggerPreset` setting controls when completions appear: `relaxed` (~2s debounce, default), `eager` (~800ms), or `on-demand` (Alt+Enter only). The preset resolves to `triggerMode` and `debounceMs` at config-load time via `TRIGGER_PRESET_DEFAULTS` in `types.ts`. Users can override the preset's debounce by setting `bespokeAI.debounceMs` explicitly. Backward compatibility: if a user has `triggerMode: "manual"` set but no preset, the config resolver defaults to the `on-demand` preset.

**Code override:** `bespokeAI.codeOverride.backend` and `bespokeAI.codeOverride.model` route code completions to a different backend/model than prose. When empty (the default), both use the same backend.

### Pool Server

The pool server is a shared-process architecture that allows multiple VS Code windows to share a single set of Claude Code subprocesses.

**Leader election:** The first VS Code window to start tries to connect to an existing server via IPC (Unix socket at `~/.bespokeai/pool.sock` on macOS/Linux, named pipe on Windows). If none exists, it acquires a lockfile (`~/.bespokeai/pool.lock`) using atomic `wx` (write-exclusive, fail-if-exists) file creation to prevent races, then starts a `PoolServer` listening on the IPC endpoint. All subsequent windows connect as clients. If the server window closes, clients detect the disconnection and race to become the new server (takeover with exponential back-off).

**IPC protocol:** Newline-delimited JSON messages over the IPC channel (Unix socket or named pipe). Request types: `completion`, `command`, `config-update`, `recycle`, `status`, `warmup`, `dispose`, `client-hello`. Server pushes events (`server-shutting-down`, `pool-degraded`) to all connected clients.

**Local fast path:** When the `PoolClient` is also the server (leader), requests bypass the socket entirely and call `PoolServer` methods directly — zero serialization overhead.

### Module Reference

File paths relative to `src/`. Read source files for full API surface; the Notes column captures only non-obvious behavior.

#### Core Pipeline

| File | Role | Notes |
|------|------|-------|
| `extension.ts` | Activation entry point; config, status bar, commands | Status bar: 4 states (initializing/ready/setup-needed/disabled). Sets `bespokeAI.cliAvailable` context for menu visibility |
| `completion-provider.ts` | Inline completion orchestrator (cache, debounce, mode, backend call) | Explicit triggers (Alt+Enter) bypass debounce with zero-delay |
| `pool-server/client.ts` | IPC client + leader election | Local fast path when client is also the server (leader) |
| `pool-server/server.ts` | IPC server, manages ClaudeCodeProvider + CommandPool | Lockfile at `~/.bespokeai/pool.lock` |
| `pool-server/protocol.ts` | IPC message types and serialization | Newline-delimited JSON |
| `pool-server/ipc-path.ts` | Platform-aware IPC path (`pool.sock` / named pipe) | |
| `providers/slot-pool.ts` | Abstract base for CLI session pools | Has its own circuit breaker (separate from `utils/circuit-breaker.ts`). Latest-request-wins queue; generation guards (monotonic counters tracking the latest request) discard stale responses |
| `providers/prompt-strategy.ts` | Shared prompts: `SYSTEM_PROMPT`, `buildFillMessage()`, `extractCompletion()` | 3 strategies: `tagExtraction` (CLI), `prefillExtraction` (Anthropic API), `instructionExtraction` (OpenAI-compat) |
| `providers/backend-router.ts` | Routes between CLI and API backends | Also handles code override routing via `resolveEffectiveBackend(mode)` |
| `providers/claude-code.ts` | Claude Code CLI backend (extends SlotPool, 1 slot) | `AbortSignal` accepted but **ignored** after slot acquisition |
| `providers/command-pool.ts` | CLI command pool for commit message / suggest-edit (1 slot) | Task-specific instructions go in user message, not system prompt |

#### API Backend

| File | Role | Notes |
|------|------|-------|
| `providers/api/presets.ts` | Preset registry (built-in + custom) | Default: `xai-grok`. Custom presets auto-detect Anthropic models via OpenRouter for prefill strategy |
| `providers/api/types.ts` | `Preset`, `ApiAdapter`, `ApiAdapterResult` interfaces | |
| `providers/api/api-provider.ts` | `ApiCompletionProvider` — inline completions via API | Uses shared `CircuitBreaker` from `utils/` |
| `providers/api/api-command-provider.ts` | `ApiCommandProvider` — commit message / suggest-edit via API | Uses shared `CircuitBreaker` from `utils/` |
| `providers/api/adapters/anthropic.ts` | Anthropic SDK adapter (bundled) | Supports prefill, prompt caching, `extraBody`/`extraHeaders` passthrough |
| `providers/api/adapters/openai-compat.ts` | OpenAI-compat adapter (OpenAI, Gemini, xAI, OpenRouter) | xAI: cache affinity header |
| `providers/api/adapters/ollama.ts` | Native Ollama API adapter (fetch-based) | Always sends `think: false`; strips `/v1` from legacy baseUrls |
| `providers/api/adapters/index.ts` | Adapter factory: `createAdapter(preset)` | |

#### Commands and Utilities

| File | Role | Notes |
|------|------|-------|
| `commit-message.ts` | Commit message generation via BackendRouter | Pure helpers in `utils/commit-message-utils.ts` |
| `suggest-edit.ts` | Suggest-edit command via BackendRouter | Pure helpers in `utils/suggest-edit-utils.ts` |
| `commands/context-menu.ts` | Explain/Fix/Do — launches standalone Claude CLI | Pure helpers in `commands/context-menu-utils.ts`. Does **not** use pool server |
| `mode-detector.ts` | `languageId` → `prose` or `code` | Unknown languages default to prose |
| `utils/context-builder.ts` | Extracts prefix/suffix from document + position | Delegates to `truncation.ts` for boundary-snapped truncation (prefix to line boundaries, suffix to word boundaries) |
| `utils/post-process.ts` | Trims prefix/suffix overlap before caching | |
| `utils/api-key-store.ts` | API key resolution: SecretStorage → env → `~/.creds/api-keys.env` | Keys eagerly loaded into memory so `resolveApiKey()` stays synchronous |
| `utils/circuit-breaker.ts` | Consecutive-failure circuit breaker for API providers | Distinct from SlotPool's built-in breaker |
| `utils/cache.ts` | LRU completion cache | |
| `utils/usage-ledger.ts` | Persistent JSONL ledger at `~/.bespokeai/usage-ledger.jsonl` | Concurrent-safe across multiple VS Code windows |
| `utils/debouncer.ts` | Promise-based debounce with `CancellationToken` + `AbortSignal` | |
| `utils/logger.ts` | Logger wrapping VS Code OutputChannel | See [Log Format and Levels](#log-format-and-levels) |
| `types.ts` | `CompletionProvider`, `ExtensionConfig`, `CustomPreset`, `TriggerPreset` | `ExtensionConfig` mirrors `bespokeAI.*` in `package.json` — keep in sync |
| `types/git.d.ts` | Type defs for VS Code's built-in Git extension API | |

Omitted from table (simple/trivial): `pool-server/index.ts` and `providers/api/index.ts` (re-exports), `utils/message-channel.ts`, `utils/model-name.ts`, `utils/workspace.ts`, `utils/usage-tracker.ts`, `utils/truncation.ts`, `scripts/dump-prompts.ts`.

## Development Recipes

### Adding a New Setting

Adding or modifying a VS Code setting requires coordinated changes. Steps 1–5 are always required. Steps 6–7 apply only when the setting needs live propagation (applying without restart).

| #   | File                        | What to change                                                                        |
| --- | --------------------------- | ------------------------------------------------------------------------------------- |
| 1   | `package.json`              | Add to `contributes.configuration`                                                    |
| 2   | `src/types.ts`              | Add field to `ExtensionConfig`                                                        |
| 3   | `src/extension.ts`          | Read it in `loadConfig()`                                                             |
| 4   | `src/test/helpers.ts`       | Add default value in `DEFAULT_CONFIG`                                                 |
| 5   | (varies)                    | Use the new field in the relevant component(s)                                        |
| 6   | (varies)                    | If it should apply without restart: propagate via the orchestrator's `updateConfig()` |
| 7   | `src/pool-server/client.ts` | If the setting affects pool behavior: propagate via `PoolClient.updateConfig()`       |

### Adding a Regression Scenario

Regression scenarios (`src/test/quality/regression-scenarios.ts`) capture real-world completion failures observed during use. They run alongside the standard quality scenarios via `npm run test:quality` and flow through the same Layer 1 + Layer 2 pipeline.

Each `RegressionScenario` extends `TestScenario` with:

- `observedModel` — which model/backend produced the failure
- `observedDate` — when the issue was observed
- `regression_notes` — what went wrong, guiding the Layer 2 judge on what to watch for

**Steps:**

1. Copy the prefix and suffix from the trace log **verbatim** — no truncation, no paraphrasing, no edits. Use the raw `[TRACE]   prefix:` and `[TRACE]   suffix:` blocks, not the composed `→ sent` userMessage block (which wraps prefix/suffix in XML tags added by `buildFillMessage()`). The goal is to reproduce the exact conditions that caused the failure.
2. Add a `RegressionScenario` to the array in `regression-scenarios.ts`
3. Document the failure in `regression_notes` and set `quality_notes` to tell the judge what constitutes a fix
4. Tag with the `observedModel` and `observedDate`

### Changing the System Prompt

1. Edit `SYSTEM_PROMPT` in `src/providers/prompt-strategy.ts`.
2. Run `npm run dump-prompts` to inspect the rendered prompt.
3. Run `npx tsx src/test/quality/rapid-test.ts` for a quick smoke test (~30s).
4. Run quality tests against the reference model set — at minimum CLI sonnet, `openai-gpt-4.1-nano`, and `xai-grok`:
   ```bash
   npm run test:quality
   TEST_BACKEND=api TEST_API_PRESET=openai-gpt-4.1-nano npm run test:quality
   TEST_BACKEND=api TEST_API_PRESET=xai-grok npm run test:quality
   ```
5. Complete Layer 2 evaluation for each run.
6. Compare pass rates to the previous baseline. Report regressions before merging.

### Adding Post-Processing

Adjust the system prompt, examples, or backend configuration first. Post-processing (algorithmic trimming/transformation in `post-process.ts`) is a last resort, not an alternative to try alongside prompt fixes. Algorithmic text manipulation that looks correct for the observed failure case often silently breaks completions in other contexts, producing ghost text the user does not expect.

Fixing bugs in existing post-processing follows normal debugging workflow. The protocol below applies to **adding new** post-processing steps. If prompt engineering cannot solve the problem and the user approves adding post-processing:

1. **Discuss with the user first** — explain the specific problem, why prompt engineering can't solve it, and what the proposed transformation does.
2. **The transformation must be provably safe** — it should only activate when the pattern is always erroneous (never legitimate content), not when it might be correct.
3. **Guard aggressively** — use tight preconditions (length limits, exact-match only, mode checks) so the transformation applies to the narrowest possible set of inputs.
4. **Test both activation and no-op cases** — every post-processing step needs tests that verify it fires when expected _and_ tests that verify it leaves correct completions untouched across a range of realistic inputs.
5. **Document the rationale in code** — each step in `post-process.ts` should have a comment explaining what problem it solves, why it's safe, and what its preconditions are.
6. **Remove workarounds when root causes are fixed** — if the underlying issue is resolved at the prompt or backend level, remove the corresponding post-processing step.

### Updating This File

When making codebase changes, update the corresponding CLAUDE.md sections:

| Change type          | CLAUDE.md section to update                      |
| -------------------- | ------------------------------------------------ |
| New source file      | Module Reference tables                          |
| New setting          | "Adding a New Setting" table if workflow changes |
| New command          | Overview feature list and Module Reference       |
| New test category    | Testing section                                  |
| Architecture change  | Architecture and Request Flow                    |
| New known limitation | Known Limitations                                |
| New npm script       | Build and Scripts                                |

## Debugging

### Log Format and Levels

The `Logger` class (`src/utils/logger.ts`) wraps a VS Code `OutputChannel` ("Bespoke AI"). The `activate()` function creates the Logger and passes it to `PoolClient` and `CompletionProvider`. The `bespokeAI.logLevel` setting controls verbosity:

| Level            | What gets logged                                                 |
| ---------------- | ---------------------------------------------------------------- |
| `info` (default) | Lifecycle: activation, config changes                            |
| `debug`          | Per-request flow: start/end with timing, cache hits, request IDs |
| `trace`          | Full content: prefix, suffix, messages sent, responses received  |
| `error`          | All errors and failures (always logged regardless of level)      |

Each completion request gets a 4-character hex ID (e.g., `#a7f3`) for log correlation. At debug level, requests show visual separators (`───`) and directional markers (`▶` for request start, `◀` for response end). At trace level, content blocks appear indented under the debug-level log lines.

Example:

```
───────────────────────────────────────────────────────────────────
[DEBUG 00:51:11.539] ▶ #a7f3 | code | main.ts | 645+69 chars
[TRACE]   prefix:
          const x = 1;
          ⋮ (445 chars total)
          function foo() {
[TRACE]   → sent (764 chars):
          <document>...</document>
[DEBUG 00:51:12.374] ◀ #a7f3 | 835ms | 9 chars | slot=0
[TRACE]   ← raw:
          }
```

The output channel is visible in the VS Code Output panel.

### Debugging Completion Issues

When an autocomplete bug is observed (e.g., doubled text, wrong formatting, unwanted content):

**First, diagnose.** Set `bespokeAI.logLevel` to `trace` and reproduce the issue. If the user provides trace output directly, use that for diagnosis rather than asking them to reproduce. The `[TRACE]` output shows the full prefix, suffix, system prompt, user message, and raw completion. Use this to determine whether the problem is in prompt construction, model output, post-processing, or pool/IPC communication before attempting a fix.

| Symptom source                                    | Action                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------- |
| Prompt construction (model receives wrong input)  | Fix `buildFillMessage()` in `prompt-strategy.ts`                             |
| Model output (correct input, wrong response)      | Adjust system prompt or model parameters                                     |
| Pool/IPC (message corruption, timeout, reconnect) | Debug `PoolClient`/`PoolServer` communication                                |
| Post-processing                                   | Review `post-process.ts` (last resort — see [Working Rules](#working-rules)) |

When fixing a completion bug, consider also adding the failing case as a regression scenario (see [Adding a Regression Scenario](#adding-a-regression-scenario)) so it is covered by future quality test runs.

When debugging code-mode completions, check whether `bespokeAI.codeOverride.backend` or `bespokeAI.codeOverride.model` is set — code completions may route to a different backend than prose. See [Known Limitations](#known-limitations) for the cross-backend restriction.

### Debugging Command Issues

Commit message and suggest-edit commands route through `BackendRouter.sendCommand()` — in Claude Code mode this delegates to `PoolClient.sendCommand()` / `CommandPool`, in API mode to `ApiCommandProvider.sendPrompt()`. Diagnosis approach:

1. Check `[DEBUG]` logs for "Commit message" or "Suggest edit" entries — they show diff size, prompt size, and timing.
2. Check `[TRACE]` logs for the full prompt and raw response.
3. If the command pool is not ready, check whether the pool server is running and the command slot is in a healthy state (use the status bar menu → Pool Status).
4. For parse failures in suggest-edit, check the raw response format against the expected `<corrected>` tag structure in `suggest-edit-utils.ts`.

### Troubleshooting: Completions Not Working

If completions stop working entirely:

1. Check status bar — is it showing "AI Off"? Toggle enabled via the status bar menu. If it shows "Setup needed", the CLI may be missing or unauthenticated.
2. Check if `bespokeAI.triggerPreset` is set to `on-demand` — in that mode, completions only appear on explicit Alt+Enter invocation.
3. Open Output panel ("Bespoke AI") — check for errors.
4. Run the "Bespoke AI: Restart Pools" command.
5. If still broken: check for orphaned processes. On macOS/Linux: `pkill -f "claude.*dangerously-skip-permissions"`. On Windows: use Task Manager to end `node.exe` processes running Claude.
6. If still broken: check for a stale lockfile at `~/.bespokeai/pool.lock` and remove it.
7. If still broken: disable and re-enable the extension.

## Testing

### Test Environment Variables

All test runners share these env vars:

| Variable          | Description                                                    |
| ----------------- | -------------------------------------------------------------- |
| `TEST_BACKEND`    | `claude-code` (default) or `api`                               |
| `TEST_API_PRESET` | Preset ID for API backend (default: `anthropic-haiku`)         |
| `TEST_MODEL`      | Override Claude Code CLI model (default: `sonnet`)             |
| `PROMPT_VARIANTS` | Comma-separated variant IDs for comparison runner              |
| `COMPARE_FILTER`  | Filter comparison by mode: `prose`, `code`, or `all`           |

Backward-compatible aliases: `QUALITY_TEST_MODEL` → `TEST_MODEL`, `PROMPT_VARIANT` → `PROMPT_VARIANTS`.

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
npm run check && npm run test:unit && npm run test:api && npm run test:quality
```

If any suite fails, report the failure and stop (the `&&` chaining enforces this). The Claude Code tests require the `@anthropic-ai/claude-agent-sdk` package and the `claude` CLI. Quality tests default to Claude Code CLI but also support API backends via `TEST_BACKEND`/`TEST_API_PRESET` env vars. Suites that lack required dependencies skip without error. After the run, report any skipped suites and why.

**`test:quality` is a two-step process:**

| Step    | Action                     | What it does                                     | Done when                              |
| ------- | -------------------------- | ------------------------------------------------ | -------------------------------------- |
| Layer 1 | `npm run test:quality`     | Generates completions, saves to `test-results/`  | All scenarios produce output (or skip) |
| Layer 2 | Follow steps in Quality Tests section | Evaluate each `completion.txt` against validator | `layer2-summary.md` written            |
| Skip    | Report skip reason         | If all scenarios skipped (e.g., no SDK)          | Layer 2 does not apply                 |

**Do not report quality tests as complete until Layer 2 is done.** See [Quality Tests (LLM-as-Judge)](#quality-tests-llm-as-judge) for the full Layer 2 workflow. After evaluation, report results to the user. Do not attempt fixes unless asked.

### Unit Tests

Unit tests use Vitest with `globals: true`. Test helpers in `src/test/helpers.ts` provide config factories (`makeConfig`), mock loggers (`makeLogger`, `makeCapturingLogger`), context factories (`makeProseContext`, `makeCodeContext`), mock documents, and fake streams. See the file for the full API.

Debouncer and cache tests use `vi.useFakeTimers()`. For debouncer tests, use `vi.advanceTimersByTimeAsync()` (not `vi.advanceTimersByTime()`) to ensure microtasks flush correctly.

### Integration Tests

Integration tests (`src/test/api/`) make real calls to external services. 30-second timeout. Tests skip via `describe.skipIf()` when the required backend isn't available.

```bash
npm run test:api                                           # Claude Code CLI (default)
TEST_BACKEND=api TEST_API_PRESET=xai-grok npm run test:api # API backend
```

`createTestProvider()` in `src/test/helpers.ts` reads the env vars and returns the appropriate provider. Returns `null` when unavailable, causing tests to skip.

**Test suites:** `shared-scenarios.test.ts` (backend-agnostic: prose, code, no fences, no leading newlines), `claude-code.test.ts` (activation, warmup, slot reuse, abort, dispose), `api-adapters.test.ts` (raw HTTP adapter calls per provider), `content-validation.test.ts` (output quality checks), `slot-endurance.test.ts` (multi-request slot lifecycle), `anchor-echo.test.ts` (anchor document echo detection).

Results persist to `test-results/api-{timestamp}/`. `test-results/latest-api` symlinks to the most recent run.

### Quality Tests (LLM-as-Judge)

Quality tests (`src/test/quality/`) evaluate whether completions are actually good, not just structurally valid. Backend-agnostic.

```bash
npm run test:quality                                                    # Claude Code CLI (default)
TEST_BACKEND=api TEST_API_PRESET=xai-grok-code npm run test:quality     # API backend
```

**Layer 1 (automated):** Generates completions for every scenario, saves to `test-results/quality-{timestamp}-{backend}/` (`test-results/latest` symlinks to the most recent run). Only checks that the backend produced output without errors.

**Layer 2 (Claude Code in-session):**

1. Read `src/test/quality/validator-prompt.md` for the evaluation rubric.
2. For every scenario in the run folder, evaluate `completion.txt` against the rubric and write `validation.md`. Validate every scenario — do not skip any. Null completions are failures.
3. Write `layer2-summary.md` at the run root summarizing pass/fail counts.
4. Use the Task tool with parallel agents to speed up evaluation.

**Fabricated content is expected.** The model invents plausible content (names, dates, code). Judge contextual sensibility, not factual accuracy.

**Scenario design:** Each scenario declares a `saturation` field (how full the context window should be, 0.0–1.0); the runner applies the same truncation logic used in production. See `docs/autocomplete-approach.md` Section 5. Standard scenarios are in `src/test/quality/scenarios.ts`; category-specific scenarios are in `src/test/quality/scenarios/` (browse the directory for the current set). Verify character counts with `npx tsx src/test/quality/measure-scenarios.ts`.

To add a scenario, add a `TestScenario` to `scenarios.ts` (for standard scenarios) or to a file in the `scenarios/` directory (for category-specific scenarios). To adjust judging criteria, edit `validator-prompt.md`.

**Key files:** `scenarios.ts` (standard), `regression-scenarios.ts` (captured failures), `validator-prompt.md` (rubric), `judge.ts` (types).

**Reference model set:** Test prompt changes against at least one model per extraction strategy (tag, prefill, instruction — see `prompt-strategy.ts`). Minimum set: CLI sonnet, `openai-gpt-4.1-nano`, `xai-grok`. Full list in `README.md` under "Tested Models".

### Rapid Code Quality Test

Standalone script for fast prompt iteration. Runs 7 cherry-picked code scenarios with objective pass/fail criteria (tag leaks, marker leaks, null completions, excessive length, assistant preamble). No subjective judgment — completes in ~30 seconds.

```bash
npx tsx src/test/quality/rapid-test.ts                      # default: xai-grok
npx tsx src/test/quality/rapid-test.ts openai-gpt-4.1-nano  # specific preset
```

### Prompt Variant Comparison

A/B/N tool for testing prompt variants against the full scenario suite. Uses the same scenarios and truncation as the quality runner.

```bash
PROMPT_VARIANTS=current npm run test:quality:compare
```

**Available variants:** `current` (production baseline, imports from `src/providers/claude-code.ts`). To add a variant, add a `PromptVariant` to `src/test/quality/prompt-variants.ts` and register it in the `PROMPT_VARIANTS` record. Each variant defines `systemPrompt`, `buildMessage()`, `extractCompletion()`, `buildWarmupMessage()`, and `validateWarmup()`.

Results go to `test-results/compare-{timestamp}/`. `test-results/latest-compare` symlinks to the most recent run.

## Known Limitations

These are deliberate trade-offs. Do not attempt to fix them unless explicitly asked.

- Cache keys do not include the document URI, so identical prefix/suffix text in different files can return a cached completion that was generated for a different file.
- The cache does not clear automatically on individual setting changes. Until entries expire (5-minute TTL) or are evicted, cached completions may reflect previous settings. Use the "Bespoke AI: Clear Completion Cache" command to manually clear it.
- The extension does not validate config values. Invalid settings pass through to the backend as-is.
- Tests use top-level `await`, which is incompatible with the `commonjs` module setting in `tsconfig.json`. To avoid build errors, `tsconfig.json` excludes `src/test/`. Vitest uses its own TypeScript transformer, so this does not affect test execution.
- **Context menu commands (Explain, Fix, Do) are CLI-only.** They launch standalone Claude CLI processes, not the pool server. Hidden via `bespokeAI.cliAvailable` when backend is API. They do not check `bespokeAI.enabled` — they work even when inline completions are disabled.
- **Context menu shell escaping (Windows):** `escapeForDoubleQuotes()` in `context-menu-utils.ts` uses bash/zsh escaping rules. On Windows with PowerShell or cmd.exe, context menu commands (Explain, Fix, Do) may produce incorrect escaping unless the VS Code terminal uses a bash-compatible shell (Git Bash, WSL).
- **Subprocess cleanup:** The extension relies on `channel.close()` and SDK behavior to terminate Claude Code subprocesses. It does not track subprocess PIDs and cannot force-kill orphaned processes. If someone force-kills VS Code (e.g., `kill -9`), subprocesses may survive until they timeout or are manually cleaned. On macOS/Linux: `pkill -f "claude.*dangerously-skip-permissions"`. On Windows: use Task Manager to end `node.exe` processes running Claude.
- **Code override cross-backend:** `bespokeAI.codeOverride.backend` set to `claude-code` only works when the primary backend is also `claude-code`. The pool server only starts when the primary backend is `claude-code`, so code completions routed via the override will silently fail. The reverse (primary `claude-code`, code override to `api`) works because the API provider initializes regardless.
