# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**Dev Log:** `DEV_LOG.md` contains a reverse-chronological record of development decisions, design rationale, and lessons learned. Update it when making significant changes or discovering important behaviors (e.g., why certain approaches don't work).

**Roadmap:** `ROADMAP.md` tracks planned, exploring, and deferred features. `FEATURE_MAP.md` has the competitive landscape analysis and an open-source reference guide — check it before implementing a feature that may already exist in an open-source project.

**API Return Notes:** `API_RETURN_NOTES.md` documents why direct API providers (Anthropic, Ollama) were removed and what to consider if restoring them.

**Interpreting pasted content:** When the user pastes log files, error output, or other unusual text without explicit instructions, assume they want you to investigate what's wrong. Diagnose the issue, identify the root cause, and propose a fix.

## Overview

Bespoke AI is a personal AI toolkit for VS Code, currently providing inline completions (ghost text) for prose and code via the Claude Code CLI (subscription-based). Auto-detects prose vs code completion mode based on `document.languageId`. The extension works identically in both VS Code and VSCodium.

## Commands

```bash
npm run compile        # Build once (esbuild → dist/extension.js)
npm run watch          # Build in watch mode (F5 development)
npm run check          # Lint + type-check (run before committing)
npm run lint           # ESLint only
npm run test           # Alias for test:unit
npm run test:unit      # Vitest unit tests (src/test/unit/)
npm run test:unit:watch  # Vitest watch mode
npm run test:api       # API integration tests (src/test/api/, needs claude CLI)
npm run test:quality   # LLM-as-judge completion quality tests (needs claude CLI)
npm run benchmark      # Parameter sweep benchmarking (currently non-functional, needs rewrite)
npm run dump-prompts   # Dump exact prompt strings for Claude Code to prompt-dump.txt
npm run install-ext    # Compile, package VSIX, and install into VSCodium (all-in-one)
```

Run a single test file: `npx vitest run src/test/unit/cache.test.ts`

Pressing F5 in VS Code launches the Extension Development Host using the `npm:watch` build task.

esbuild bundles `src/extension.ts` into `dist/extension.js` (CommonJS, targeting Node.js 18). The build marks the `vscode` module as external because the VS Code host provides it at runtime. Runtime dependency: `@anthropic-ai/claude-agent-sdk` (optional, Claude Code backend). `@anthropic-ai/sdk` is a devDependency used only by the benchmark judge.

## Versioning and Installation

The version in `package.json` should be incremented with each development iteration before installing. To package and install:

```bash
npm run compile
vsce package --allow-missing-repository
codium --install-extension bespoke-ai-{version}.vsix   # or: code --install-extension
```

Increment the patch version (third number) by default for each install. For larger changes (new features, prompt rewrites, architectural shifts), ask whether to bump the minor version instead.

## Architecture

### Request flow

User types → VS Code calls `provideInlineCompletionItems` → detect mode → extract document context → check LRU (Least Recently Used) cache → debounce (300ms) → call Claude Code provider (builds prompt internally) → post-process result → cache result → return `InlineCompletionItem`.

### Error handling

The provider catches abort errors and returns `null`; all other errors propagate to `CompletionProvider`, which logs them via the `Logger` and returns `null`. The extension does not surface runtime completion errors to the user. **Follow this same pattern for new code.**

### Logging

The `Logger` class (`src/utils/logger.ts`) wraps a VS Code `OutputChannel` ("Bespoke AI"). The `activate()` function creates the Logger and injects it into `CompletionProvider` and `ClaudeCodeProvider`. The `bespokeAI.logLevel` setting controls verbosity:

| Level            | What gets logged                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `info` (default) | Lifecycle: activation, config changes, profile switches                                             |
| `debug`          | Per-request flow: start/end with timing, cache hits, request IDs                                    |
| `trace`          | Full content: prefix, suffix, messages sent, responses received                                     |
| (errors)         | Failures are always logged regardless of the selected level — `error` is not a selectable log level |

**Structured request logging:** Each completion request gets a 4-character hex ID (e.g., `#a7f3`) for log correlation. At debug level, requests show visual separators (`───`) and directional markers (`▶` start, `◀` end). At trace level, content blocks appear indented under the debug skeleton. Example:

```
───────────────────────────────────────────────────────────────────
[DEBUG 00:51:11.539] ▶ #a7f3 | code | claude-code | main.ts | 645+69 chars
[TRACE]   prefix:
          const x = 1;
          ⋮ (445 chars total)
          function foo() {
[TRACE]   → sent (764 chars):
          <incomplete_text>...</incomplete_text>
[DEBUG 00:51:12.374] ◀ #a7f3 | 835ms | 9 chars | slot=0
[TRACE]   ← raw:
          }
```

**Logger methods:**

- `info()`, `debug()`, `trace()`, `error()` — basic level-gated logging
- `requestStart(reqId, details)` — log request start with separator (debug+)
- `requestEnd(reqId, details)` — log request end with timing (debug+)
- `cacheHit(reqId, len)` — log cache hit (debug+)
- `traceBlock(label, content)` — indented content block with truncation (trace only)
- `traceInline(label, value)` — short inline trace value (trace only)

The output channel is visible in the VS Code Output panel.

### Components

Key components, listed in request-flow order:

- `src/extension.ts` — Activation entry point. Loads config from VS Code's `bespokeAI.*` settings. Creates the `Logger`, `ClaudeCodeProvider`, `CompletionProvider`, and registers the inline completion provider, status bar, and seven commands: `trigger` (`Ctrl+L`), `toggleEnabled`, `cycleMode` (cycles auto → prose → code → auto), `clearCache`, `selectProfile` (QuickPick UI for switching profiles), `showMenu` (unified status bar menu), and `generateCommitMessage` (generates a commit message via Claude Code CLI). Watches for config changes and propagates via `updateConfig()`. On profile switch, auto-clears the completion cache. Manages a request spinner in the status bar while completions are in-flight.

- `src/commit-message.ts` — Generates commit messages via the Claude Code CLI (`claude -p`). Accesses VS Code's built-in Git extension to read diffs, auto-detects staged vs unstaged changes (prompts if both exist), spawns `claude` as a child process with the diff piped to stdin, and writes the result into the SCM commit message input box. Standalone module — independent of the inline completion pipeline. Pure helper functions (`buildCommitPrompt()`, `getSystemPrompt()`, `parseCommitMessage()`) live in `src/utils/commit-message-utils.ts` for unit testing.

- `src/completion-provider.ts` — Orchestrator implementing `vscode.InlineCompletionItemProvider`. Coordinates mode detection → context extraction → cache lookup → debounce → provider call → cache write. Accepts a `Logger` and a `CompletionProvider` (the Claude Code provider) via its constructor. Exposes `clearCache()` for manual or profile-switch cache clearing and `setRequestCallbacks()` for status bar spinner integration. The debouncer manages `AbortSignal` lifecycle for cancelling in-flight requests. Records input/output character counts in the usage tracker.

- `src/mode-detector.ts` — Maps `languageId` to `'prose' | 'code'`. Priority: (1) user override via `bespokeAI.mode` when set to `prose` or `code`, (2) custom language IDs in `prose.fileTypes`, (3) built-in language sets. Unknown languages default to prose because the primary use case is writing.

- `src/providers/claude-code.ts` — Claude Code backend via `@anthropic-ai/claude-agent-sdk`. Uses a `>>>CURSOR<<<` marker approach: wraps the document prefix + marker + suffix in `<current_text>` tags with a `<completion_start>` anchor. The model fills the gap starting with the anchor text, wrapping its response in `<output>` tags. `extractOutput()` strips the tags, `stripCompletionStart()` removes the echoed anchor. The exported `buildFillMessage()` function is the single source of truth for message construction. Same prompt structure for prose and code — the model infers the content type. Manages a 2-slot reusable session pool: each slot handles up to 24 completions before recycling (one subprocess serves N requests). A single-waiter queue handles slot acquisition — when both slots are busy, only the most recent request waits (older waiters get `null`). The `AbortSignal` parameter is accepted for interface compatibility but ignored; once a slot is acquired, the request commits to the result unconditionally.

- `src/utils/post-process.ts` — Applies a shared post-processing pipeline to all provider output before caching. Trims prefix overlap (when the model echoes the current line fragment, e.g., doubled bullet markers), trims suffix overlap (when the completion's tail duplicates the document's suffix), and returns `null` for empty results.

- `src/utils/debouncer.ts` — Promise-based debounce that responds to two cancellation layers: the VS Code `CancellationToken` cancels the debounce wait, and the `AbortSignal` aborts in-flight HTTP requests.

- `src/utils/cache.ts` — LRU cache with 50 entries and 5-minute TTL (time-to-live). Cache key is built from the mode, the last 500 characters of prefix, and the first 200 characters of suffix. URI is intentionally excluded — see Known Limitations.

- `src/utils/context-builder.ts` — Extracts prefix/suffix from `TextDocument` + `Position`. Both `prefixChars` and `suffixChars` are configurable via `prose.contextChars`/`prose.suffixChars` and `code.contextChars`/`code.suffixChars` settings. Uses `path.basename()` for cross-platform filename.

- `src/utils/logger.ts` — See Logging above.

- `src/utils/model-name.ts` — `shortenModelName()` pure function. Shortens model IDs for status bar display (e.g., `claude-haiku-4-5-20251001` → `haiku-4.5`). Strips `claude-` prefix, date suffixes, and converts version separators.

- `src/utils/profile.ts` — `applyProfile()` pure function. Deep-merges a `ProfileOverrides` object over a base `ExtensionConfig`.

- `src/utils/usage-tracker.ts` — Tracks per-session completion counts, input/output character counts, cache hits/misses, errors, and burst detection. Used by the status bar to show usage stats.

- `src/utils/commit-message-utils.ts` — Pure helper functions for the commit message feature: `buildCommitPrompt()`, `getSystemPrompt()`, `parseCommitMessage()`. Separated from `src/commit-message.ts` for unit testing without VS Code dependencies.

- `src/scripts/dump-prompts.ts` — Utility script (`npm run dump-prompts`) that renders the exact prompt strings Claude Code sends to the model for prose and code modes. Writes to `prompt-dump.txt`. Supports filtering by mode via CLI args.

### Types

All shared types live in `src/types.ts`. The key interface is `CompletionProvider`, which the Claude Code provider implements — see that file for the current shape. `ProfileOverrides` defines the subset of `ExtensionConfig` that profiles can override (excludes `enabled` and `activeProfile`). `ExtensionConfig` defines the same fields as the `bespokeAI.*` settings in `package.json` — when modifying either, update both to keep them in sync. The `claudeCode` sub-object includes a `models` array (informational catalog of available models) and a `model` string (the active model).

## Adding a New Setting

Adding or modifying a VS Code setting requires coordinated changes to:

| Step | File                  | What to change                                                            |
| ---- | --------------------- | ------------------------------------------------------------------------- |
| 1    | `package.json`        | Add to `contributes.configuration`                                        |
| 2    | `src/types.ts`        | Add field to `ExtensionConfig`                                            |
| 3    | `src/extension.ts`    | Read it in `loadConfig()`                                                 |
| 4    | `src/test/helpers.ts` | Add default value in `DEFAULT_CONFIG`                                     |
| 5    | (varies)              | Wire the new field into the component that needs it                       |
| 6    | `src/types.ts`        | If profile-overridable: add to `ProfileOverrides`                         |
| 7    | `package.json`        | If profile-overridable: add to `profiles` → `additionalProperties` schema |

If the setting should take effect without restarting VS Code, also propagate the new value through `CompletionProvider.updateConfig()`.

## Testing

### Running all tests

When asked to "run tests" (without further qualification), run the full test suite. The Claude Code API tests and quality tests require the `@anthropic-ai/claude-agent-sdk` package and the `claude` CLI — no API key. Without required dependencies, suites skip silently. After the run, report any skipped suites and why.

```bash
npm run check && npm run test:unit && npm run test:api && npm run test:quality
```

After `test:quality` completes, it prints Layer 2 instructions to stdout. Follow those instructions — Layer 1 only generates completions; Layer 2 (your evaluation) is the actual quality test. Do not stop after Layer 1.

### Unit tests

Unit tests use Vitest with `globals: true`. Test helpers in `src/test/helpers.ts` provide `makeConfig()` (config factory), `makeLogger()` (no-op mock Logger for tests that construct providers), `makeCapturingLogger()` (logger that captures `traceBlock` calls for inspecting raw provider output), `loadApiKey()` (reads `ANTHROPIC_API_KEY` from the environment — used by benchmark judge), `makeProseContext()` and `makeCodeContext()` (factory functions for `CompletionContext` with sensible defaults), and `createMockToken()` (mock `CancellationToken` with a `cancel()` trigger).

Debouncer and cache tests use `vi.useFakeTimers()`. For debouncer tests, use `vi.advanceTimersByTimeAsync()` (not `vi.advanceTimersByTime()`) to ensure microtasks flush correctly.

Context-builder tests (`context-builder.test.ts`) use a minimal mock `TextDocument` with `getText()`, `offsetAt()`, `languageId`, and `fileName`. Post-process tests (`post-process.test.ts`) test the shared post-processing pipeline (prefix overlap trimming, suffix overlap trimming).

### API integration tests

API integration tests (`src/test/api/`) make real calls to the Claude Code CLI. They use `describe.skipIf()` to skip when the backend isn't available.

- **Claude Code** (`claude-code.test.ts`, `anchor-echo.test.ts`) — needs `@anthropic-ai/claude-agent-sdk` and the `claude` CLI; no API key

The API test config (`vitest.api.config.ts`) sets a 30-second timeout.

**Result output:** Tests that generate real completions persist their results to `test-results/api-{timestamp}/`, organized by suite (e.g., `claude-code/code.json`, `anchor-echo/prose-mid-sentence.json`). Each JSON file records the input context, completion text, duration, and timestamp. Per-suite summaries are written as `{suite}-summary.json`, and `test-results/latest-api` symlinks to the most recent run. All test files in a single `npm run test:api` invocation share one timestamped directory.

### Quality Tests (LLM-as-Judge)

Quality tests (`src/test/quality/`) evaluate whether completions are actually good, not just structurally valid. Quality tests use the Claude Code backend. This uses a two-layer validation pattern:

**Layer 1 (automated, `npm run test:quality`):** Generates real completions for every scenario and saves them to `test-results/quality-{timestamp}/`. Each scenario gets a directory with `input.json`, `completion.txt`, `raw-response.txt` (pre-post-processing model output), `requirements.json`, and `metadata.json`. Layer 1 only checks that the provider didn't throw — it does not judge quality. The `test-results/latest` symlink always points to the most recent run. The `summary.json` file records which model was used.

**Layer 2 (Claude Code in-session, after Layer 1):** You are the evaluator. The Layer 1 test runner prints step-by-step instructions to stdout — follow them. The short version: read the validator prompt (`src/test/quality/validator-prompt.md`), evaluate every scenario's `completion.txt` against it, write a `validation.md` per scenario and an overall `layer2-summary.md`. Validate every scenario — do not spot-check. Use background agents to parallelize if there are many scenarios. If a scenario's completion is null, mark it as a Layer 2 failure.

**Fabricated content is expected and acceptable.** Completions are predictions — the model will invent plausible content (names, dates, code, narrative). Judge whether fabricated content is contextually sensible, not whether it's factually accurate.

**Testing different models:** By default, quality tests use the model from `makeConfig()` (currently `haiku`). To test a different model:

```bash
QUALITY_TEST_MODEL=sonnet npm run test:quality
```

The model name is recorded in `summary.json` so results are traceable.

**Key files:**

- `src/test/quality/scenarios.ts` — Golden data: input contexts + quality requirements
- `src/test/quality/validator-prompt.md` — Evaluation criteria (scoring rubric, per-mode rules)
- `src/test/quality/judge.ts` — Type definitions for scenarios and judgments
- `test-results/` — Generated outputs (gitignored)

To add a new scenario, add a `TestScenario` object to the prose, code, or edge-case scenario array in `scenarios.ts` (choose based on the completion mode being tested). To adjust judging criteria, edit `validator-prompt.md`.

### Regression Scenarios

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

## Profiles

Profiles are named config presets stored in `bespokeAI.profiles`. Each profile is a partial config that deep-merges over the base settings. The active profile is set via `bespokeAI.activeProfile` (empty string = no profile, use base settings).

**Commands:**

- `Bespoke AI: Show Menu` — Unified QuickPick menu (mode, profile, actions) — status bar click target
- `Bespoke AI: Select Profile` — QuickPick UI to switch profiles (or select "(none)" for base settings)
- `Bespoke AI: Clear Completion Cache` — manually clear the LRU cache

**Behavior:**

- Clicking the status bar opens the unified menu (mode selection, profile switching, toggle enable, clear cache, open settings, open output log)
- The status bar shows a `$(loading~spin)` spinner while a completion request is in-flight
- Switching profiles auto-clears the completion cache
- Profiles cannot override `enabled` or `activeProfile` (UX guards)
- The status bar shows the shortened model name (e.g., `haiku`) and the tooltip includes the profile name when active

**Example config:**

```json
"bespokeAI.profiles": {
  "sonnet-quality": {
    "claudeCode": { "model": "sonnet" },
    "prose": { "temperature": 0.5, "maxTokens": 200 }
  },
  "opus-creative": {
    "claudeCode": { "model": "opus" },
    "prose": { "temperature": 0.9 }
  }
}
```

## Benchmarking

**Note:** The benchmark system is currently non-functional and needs a rewrite for the Claude Code backend. The benchmark runner (`src/benchmark/runner.ts`) and configs (`src/benchmark/configs.ts`) reference removed Anthropic/Ollama providers. The judge (`src/benchmark/judge.ts`) still works independently as it uses the Anthropic SDK directly.

Benchmarking is **separate from the test suite** — it's a fully automated experimentation system for running quality scenarios across multiple config variations, scoring them with an LLM judge, accumulating results over time, and generating statistical comparison reports. Source lives in `src/benchmark/`, output in `test-results/benchmarks/` (gitignored).

### Key files

- `src/benchmark/types.ts` — Benchmark-specific types (GenerationResult, JudgmentFileResult, ScenarioAggregation, etc.)
- `src/benchmark/configs.ts` — Named config presets + env var filtering (needs updating for Claude Code)
- `src/benchmark/runner.ts` — Full automated pipeline (needs rewrite for Claude Code)
- `src/benchmark/judge.ts` — Automated evaluator using Claude as judge (reads validator-prompt.md) — still functional
- `src/benchmark/ledger.ts` — Ledger read/write/update utilities — backend-agnostic
- `src/benchmark/reporter.ts` — Comparison report with accept rates, pairwise sign tests, failure modes — backend-agnostic

## Fixing Autocomplete Issues

When an autocomplete bug is observed (e.g., doubled text, wrong formatting, unwanted content):

**First, diagnose.** Set `bespokeAI.logLevel` to `trace` and reproduce the issue. The `[TRACE]` output shows the full prefix, suffix, system prompt, user message, and raw completion. Use this to determine whether the problem is in prompt construction, model output, or post-processing before attempting a fix.

**Strongly prefer prompt engineering over post-processing.** Adjust the system prompt, prefill, stop sequences, or provider configuration first. Post-processing (algorithmic trimming/transformation in `post-process.ts`) is a last resort, not a parallel option.

**Why post-processing is risky:** Algorithmic text manipulation that looks correct for the observed failure case often silently breaks completions in other contexts, producing unpredictable ghost text the user didn't ask for. Edge cases compound — each post-processing step interacts with every other step and with every possible completion the model might produce. The result is brittle behavior that's hard to diagnose because the user sees ghost text that doesn't match what the model actually returned.

**If post-processing seems necessary:**

1. **Discuss with the user first** — explain the specific problem, why prompt engineering can't solve it, and what the proposed transformation does. Do not add post-processing without explicit approval.
2. **The transformation must be provably safe** — it should only activate when the input is _always_ wrong (a true invariant violation), never when the input _might_ be correct. If there's any ambiguity about whether the text is a duplicate vs. legitimate content, don't strip it.
3. **Guard aggressively** — use tight preconditions (length limits, exact-match only, mode checks) so the transformation applies to the narrowest possible set of inputs. Broad pattern matching or fuzzy heuristics are not acceptable.
4. **Test both activation and no-op cases** — every post-processing step needs tests that verify it fires when expected _and_ tests that verify it leaves correct completions untouched across a range of realistic inputs.
5. **Document the rationale in code** — each step in `post-process.ts` should have a comment explaining what problem it solves, why it's safe, and what its preconditions are.
6. **Remove workarounds when root causes are fixed** — if the underlying issue is resolved at the prompt or provider level, remove the corresponding post-processing step. Stale workarounds accumulate risk.

## Known Limitations

These are accepted trade-offs. Do not attempt to fix them unless explicitly asked.

- Cache keys do not include the document URI, so identical prefix/suffix text in different files can return a cached completion that was generated for a different file.
- The cache is auto-cleared on profile switch, but not on individual setting changes. It may serve completions generated with previous settings until they expire (5-minute TTL) or are evicted. Use the "Bespoke AI: Clear Completion Cache" command to manually clear it.
- The extension does not validate config values, so it passes invalid settings through to the provider unchecked.
- Tests use top-level `await`, which is incompatible with the `commonjs` module setting in `tsconfig.json`. To avoid build errors, `tsconfig.json` excludes `src/test/`. This does not affect test execution because Vitest uses its own TypeScript transformer independent of `tsconfig.json`.

## Future Direction

Bespoke AI is a personal AI toolkit focused on inline completions. The Claude Code backend is the sole provider. Do not implement new capabilities beyond inline completions unless explicitly asked. See `API_RETURN_NOTES.md` for notes on potentially restoring direct API providers in the future.
