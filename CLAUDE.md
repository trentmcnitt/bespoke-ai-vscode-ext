# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Bespoke AI is a personal AI toolkit for VS Code, currently providing inline completions (ghost text) for prose and code. Two backends: Anthropic Claude (cloud) and Ollama (local). Auto-detects prose vs code completion mode based on `document.languageId`. The extension works identically in both VS Code and VSCodium.

## Commands

```bash
npm run compile        # Build once (esbuild → dist/extension.js)
npm run watch          # Build in watch mode (F5 development)
npm run check          # Lint + type-check (run before committing)
npm run lint           # ESLint only
npm run test           # Alias for test:unit
npm run test:unit      # Vitest unit tests (src/test/unit/)
npm run test:unit:watch  # Vitest watch mode
npm run test:api       # API integration tests (src/test/api/, needs live backends)
npm run test:quality   # LLM-as-judge completion quality tests (needs Anthropic key)
npm run benchmark      # Parameter sweep benchmarking (needs Anthropic key)
```

Run a single test file: `npx vitest run src/test/unit/cache.test.ts`

Pressing F5 in VS Code launches the Extension Development Host using the `npm:watch` build task.

esbuild bundles `src/extension.ts` into `dist/extension.js` (CommonJS, targeting Node.js 18). The build marks the `vscode` module as external because the VS Code host provides it at runtime. The only runtime dependency is `@anthropic-ai/sdk`.

## Architecture

### Request flow

User types → VS Code calls `provideInlineCompletionItems` → detect mode → extract document context → check LRU (Least Recently Used) cache → debounce (300ms) → call provider (which builds the prompt internally and post-processes the result) → cache result → return `InlineCompletionItem`.

### Error handling

Providers catch abort errors and return `null`; all other errors propagate to `CompletionProvider`, which logs them via the `Logger` and returns `null`. The extension does not surface runtime completion errors to the user, though configuration issues (e.g., missing API key) show a one-time warning at activation. **Follow this same pattern for new code.**

### Logging

The `Logger` class (`src/utils/logger.ts`) wraps a VS Code `OutputChannel` ("Bespoke AI"). Created in `activate()` and injected into `CompletionProvider`, `ProviderRouter`, and both providers. The `bespokeAI.logLevel` setting controls verbosity:

| Level | What gets logged |
|-------|-----------------|
| `info` (default) | Lifecycle: activation, config changes, profile switches |
| `debug` | Per-request metadata: mode, backend, char counts, model params, token usage |
| `trace` | Full payloads: complete prefix, suffix, system, user message, prefill |
| `error` | Failures (always logged regardless of level) |

Use `logger.info()` for lifecycle events, `logger.debug()` for per-request metadata, `logger.trace()` for full payloads, and `logger.error()` for failures. The output channel is visible in the VS Code Output panel.

### Components

Key components, listed in request-flow order:

- `src/extension.ts` — Activation entry point. Loads config from VS Code's `bespokeAI.*` settings. Creates the `Logger`, all components, and registers the inline completion provider, status bar, and seven commands: `trigger` (`Ctrl+L`), `toggleEnabled`, `cycleMode` (cycles auto → prose → code → auto), `clearCache`, `selectProfile` (QuickPick UI for switching profiles), `showMenu` (unified status bar menu), and `generateCommitMessage` (generates a commit message via Claude Code CLI). Watches for config changes and propagates via `updateConfig()`. On profile switch, auto-clears the completion cache. Manages a request spinner in the status bar while completions are in-flight.

- `src/commit-message.ts` — Generates commit messages via the Claude Code CLI (`claude -p`). Accesses VS Code's built-in Git extension to read diffs, auto-detects staged vs unstaged changes (prompts if both exist), spawns `claude` as a child process with the diff piped to stdin, and writes the result into the SCM commit message input box. Standalone module — independent of the inline completion pipeline. Exports `buildCommitPrompt()` and `parseCommitMessage()` as pure functions for unit testing.

- `src/completion-provider.ts` — Orchestrator implementing `vscode.InlineCompletionItemProvider`. Coordinates mode detection → context extraction → cache lookup → debounce → provider call → cache write. Accepts a `Logger` via its constructor for centralized logging. Exposes `clearCache()` for manual or profile-switch cache clearing and `setRequestCallbacks()` for spinner integration. The debouncer manages `AbortSignal` lifecycle for cancelling in-flight requests.

- `src/mode-detector.ts` — Maps `languageId` to `'prose' | 'code'`. Priority: (1) user override via `bespokeAI.mode` when set to `prose` or `code`, (2) custom language IDs in `prose.fileTypes`, (3) built-in language sets. Unknown languages default to prose because the primary use case is writing.

- `src/prompt-builder.ts` — Constructs `BuiltPrompt` per mode. Each provider instantiates its own `PromptBuilder` and calls it internally. Prose uses continuation-style prompting with assistant prefill (seeding the assistant response with the last 4 words so the model continues naturally). Code uses FIM (Fill-in-the-Middle) with prefix/suffix and filename/language context.

- `src/providers/anthropic.ts` — Claude API via `@anthropic-ai/sdk`. Supports assistant prefill and Anthropic's prompt caching feature (marks prompt prefixes with `cache_control` so the API reuses them across requests, reducing cost). Accepts a `Logger` for debug/trace logging of requests and responses (model params, token usage, full payloads at trace level).

- `src/providers/ollama.ts` — Calls Ollama's `/api/generate` endpoint using Node.js built-in `fetch()`. Uses raw mode (`raw: true`) to bypass Ollama's chat template for base/completion models, but automatically switches to non-raw mode for code completions with a suffix so Ollama can apply native FIM (Fill-in-the-Middle) tokens. Accepts a `Logger` for debug/trace logging.

- `src/providers/provider-router.ts` — Holds both provider instances, returns the active one based on `config.backend`. Accepts a `Logger` as 2nd param and passes it to both providers. "Backend" is the user-facing config choice; "provider" is the code abstraction that implements the `CompletionProvider` interface.

- `src/utils/post-process.ts` — Applies a shared post-processing pipeline to all provider output before caching. Trims prefix overlap (when the model echoes the current line fragment, e.g., doubled bullet markers), trims suffix overlap (when the completion's tail duplicates the document's suffix), and returns `null` for empty results.

- `src/utils/debouncer.ts` — Promise-based debounce that responds to two cancellation layers: the VS Code `CancellationToken` cancels the debounce wait, and the `AbortSignal` aborts in-flight HTTP requests.

- `src/utils/cache.ts` — LRU cache with 50 entries and 5-minute TTL (time-to-live). Cache key is built from the mode, the last 500 characters of prefix, and the first 200 characters of suffix. URI is intentionally excluded — see Known Limitations.

- `src/utils/context-builder.ts` — Extracts prefix/suffix from `TextDocument` + `Position`. Both `prefixChars` and `suffixChars` are configurable via `prose.contextChars`/`prose.suffixChars` and `code.contextChars`/`code.suffixChars` settings. Uses `path.basename()` for cross-platform filename.

- `src/utils/logger.ts` — See Logging above.

- `src/utils/model-name.ts` — `shortenModelName()` pure function. Shortens model IDs for status bar display (e.g., `claude-haiku-4-5-20251001` → `haiku-4.5`). Strips `claude-` prefix, date suffixes, and converts version separators.

- `src/utils/profile.ts` — `applyProfile()` pure function. Deep-merges a `ProfileOverrides` object over a base `ExtensionConfig`. The API key always comes from the base config (security guard against profile injection).

### Types

All shared types live in `src/types.ts`. The key interface is `CompletionProvider`, which both provider implementations (Anthropic and Ollama) conform to — see that file for the current shape. `ProfileOverrides` defines the subset of `ExtensionConfig` that profiles can override (excludes `enabled`, `apiKey`, and `activeProfile`). `ExtensionConfig` defines the same fields as the `bespokeAI.*` settings in `package.json` — when modifying either, update both to keep them in sync. Both `anthropic` and `ollama` sub-objects include a `models` array (informational catalog of available models) and a `model` string (the active model).

## Adding a New Setting

Adding or modifying a VS Code setting requires coordinated changes to:

| Step | File | What to change |
|------|------|----------------|
| 1 | `package.json` | Add to `contributes.configuration` |
| 2 | `src/types.ts` | Add field to `ExtensionConfig` |
| 3 | `src/extension.ts` | Read it in `loadConfig()` |
| 4 | `src/test/helpers.ts` | Add default value in `DEFAULT_CONFIG` |
| 5 | (varies) | Wire the new field into the component that needs it |
| 6 | `src/types.ts` | If profile-overridable: add to `ProfileOverrides` |
| 7 | `package.json` | If profile-overridable: add to `profiles` → `additionalProperties` schema |

If the setting should take effect without restarting VS Code, also propagate the new value through `CompletionProvider.updateConfig()` and/or `ProviderRouter.updateConfig()`.

## Testing

### Running all tests

When asked to "run tests" (without further qualification), run the full test suite. API and quality tests require `ANTHROPIC_API_KEY` in the environment (source it from `~/.creds/api-keys.env` if not already set). Without it, those suites skip silently. After the run, report any skipped suites and why.

```bash
npm run check && npm run test:unit && npm run test:api && npm run test:quality
```

After `test:quality` completes, it prints Layer 2 instructions to stdout. Follow those instructions — Layer 1 only generates completions; Layer 2 (your evaluation) is the actual quality test. Do not stop after Layer 1.

### Unit tests

Unit tests use Vitest with `globals: true`. Test helpers in `src/test/helpers.ts` provide `makeConfig()` (config factory), `makeLogger()` (no-op mock Logger for tests that construct providers), `loadApiKey()` (reads `ANTHROPIC_API_KEY` from the environment), `makeProseContext()` and `makeCodeContext()` (factory functions for `CompletionContext` with sensible defaults), and `createMockToken()` (mock `CancellationToken` with a `cancel()` trigger).

Debouncer and cache tests use `vi.useFakeTimers()`. For debouncer tests, use `vi.advanceTimersByTimeAsync()` (not `vi.advanceTimersByTime()`) to ensure microtasks flush correctly.

Context-builder tests (`context-builder.test.ts`) use a minimal mock `TextDocument` with `getText()`, `offsetAt()`, `languageId`, and `fileName`. Post-process tests (`post-process.test.ts`) test the shared post-processing pipeline (fence stripping, newline removal, stop boundary enforcement).

### API integration tests

API integration tests (`src/test/api/`) make real HTTP calls. They use `describe.skipIf()` to skip when backends aren't available (no API key, Ollama not running). The Anthropic test reads `ANTHROPIC_API_KEY` from the environment (run with `ANTHROPIC_API_KEY=sk-ant-... npm run test:api`). The Ollama test checks for model availability via `/api/tags` before running. The API test config (`vitest.api.config.ts`) sets a 30-second timeout.

### Quality Tests (LLM-as-Judge)

Quality tests (`src/test/quality/`) evaluate whether completions are actually good, not just structurally valid. Quality tests always use the Anthropic backend; to test Ollama quality, use the benchmark system with an Ollama config. This uses a two-layer validation pattern:

**Layer 1 (automated, `npm run test:quality`):** Generates real completions for every scenario and saves them to `test-results/quality-{timestamp}/`. Each scenario gets a directory with `input.json`, `completion.txt`, `requirements.json`, and `metadata.json`. Layer 1 only checks that the provider didn't throw — it does not judge quality. The `test-results/latest` symlink always points to the most recent run. The `summary.json` file records which model was used.

**Layer 2 (Claude Code in-session, after Layer 1):** You are the evaluator. The Layer 1 test runner prints step-by-step instructions to stdout — follow them. The short version: read the validator prompt (`src/test/quality/validator-prompt.md`), evaluate every scenario's `completion.txt` against it, write a `validation.md` per scenario and an overall `layer2-summary.md`. Validate every scenario — do not spot-check. Use background agents to parallelize if there are many scenarios. If a scenario's completion is null, mark it as a Layer 2 failure.

**Testing different models:** By default, quality tests use the model from `makeConfig()` (currently `claude-haiku-4-5-20251001`). To test a different model:

```bash
QUALITY_TEST_MODEL=claude-sonnet-4-20250514 npm run test:quality
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
- Profiles cannot override `apiKey`, `enabled`, or `activeProfile` (security and UX guards)
- The status bar shows the shortened model name (e.g., `haiku-4.5`) and the tooltip includes the profile name when active

**Example config:**
```json
"bespokeAI.profiles": {
  "haiku-fast": {
    "anthropic": { "model": "claude-haiku-4-5-20251001" },
    "prose": { "temperature": 0.7, "maxTokens": 80 }
  },
  "sonnet-quality": {
    "anthropic": { "model": "claude-sonnet-4-20250514" },
    "prose": { "temperature": 0.5, "maxTokens": 200 }
  },
  "local-ollama": {
    "backend": "ollama",
    "ollama": { "model": "qwen2.5:3b" }
  }
}
```

## Benchmarking

Benchmarking is **separate from the test suite** — it's a fully automated experimentation system for running quality scenarios across multiple config variations, scoring them with an LLM judge, accumulating results over time, and generating statistical comparison reports. Source lives in `src/benchmark/`, output in `test-results/benchmarks/` (gitignored).

One command runs the full pipeline — generation, automated judging, aggregation, ledger write, and report generation:

```bash
npm run benchmark
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `BENCHMARK_CONFIGS` | (all) | Comma-separated config labels to run |
| `BENCHMARK_K` | `3` | Generations per scenario (statistical replication) |
| `BENCHMARK_J` | `3` | Independent judges per generation |
| `BENCHMARK_JUDGE_MODEL` | `claude-sonnet-4-20250514` | Model used for automated judging |
| `BENCHMARK_CONCURRENCY` | `5` | Max concurrent judge API calls |

### Examples

```bash
# Quick smoke test (1 gen, 1 judge, single config)
BENCHMARK_K=1 BENCHMARK_J=1 BENCHMARK_CONFIGS=haiku-baseline npm run benchmark

# Full statistical run (3 gens × 3 judges = 9 evaluations per scenario)
BENCHMARK_K=3 BENCHMARK_J=3 BENCHMARK_CONFIGS=haiku-baseline,haiku-temp0.5 npm run benchmark

# Run all configs with default K/J
npm run benchmark
```

### Output structure

```
test-results/benchmarks/run-{timestamp}/{config}/{scenario}/
  input.json, requirements.json          (once per scenario)
  generation-{k}/
    completion.txt, metadata.json        (per generation)
    judgment-{j}.json                    (per judge)
  aggregation.json                       (per scenario)
```

### Primary metric: accept rate

The primary quality signal is **accept rate** — the percentage of judgments where the automated judge determines a reasonable user would press Tab to accept the ghost text without editing it. The comparison report sorts configs by accept rate.

### Adding new configs

Edit `src/benchmark/configs.ts` and add a `BenchmarkConfig` to the `BENCHMARK_CONFIGS` array. Each config needs a label, description, and partial `ExtensionConfig` overrides.

### Ledger

The ledger (`test-results/benchmarks/ledger.json`, version 2) is append-only. Multiple runs with the same model/config are expected — you build up data over time. The comparison report (`test-results/benchmarks/comparison-report.md`) is regenerated from ledger data after each run.

### Key files

- `src/benchmark/types.ts` — Benchmark-specific types (GenerationResult, JudgmentFileResult, ScenarioAggregation, etc.)
- `src/benchmark/configs.ts` — Named config presets + env var filtering
- `src/benchmark/runner.ts` — Full automated pipeline (generation → judging → aggregation → ledger → report)
- `src/benchmark/judge.ts` — Automated evaluator using Claude as judge (reads validator-prompt.md)
- `src/benchmark/ledger.ts` — Ledger read/write/update utilities
- `src/benchmark/reporter.ts` — Comparison report with accept rates, pairwise sign tests, failure modes

## Fixing Autocomplete Issues

When an autocomplete bug is observed (e.g., doubled text, wrong formatting, unwanted content):

**Strongly prefer prompt engineering over post-processing.** Adjust the system prompt, prefill, stop sequences, or provider configuration first. Post-processing (algorithmic trimming/transformation in `post-process.ts`) is a last resort, not a parallel option.

**Why post-processing is risky:** Algorithmic text manipulation that looks correct for the observed failure case often silently breaks completions in other contexts, producing unpredictable ghost text the user didn't ask for. Edge cases compound — each post-processing step interacts with every other step and with every possible completion the model might produce. The result is brittle behavior that's hard to diagnose because the user sees ghost text that doesn't match what the model actually returned.

**If post-processing seems necessary:**

1. **Discuss with the user first** — explain the specific problem, why prompt engineering can't solve it, and what the proposed transformation does. Do not add post-processing without explicit approval.
2. **The transformation must be provably safe** — it should only activate when the input is *always* wrong (a true invariant violation), never when the input *might* be correct. If there's any ambiguity about whether the text is a duplicate vs. legitimate content, don't strip it.
3. **Guard aggressively** — use tight preconditions (length limits, exact-match only, mode checks) so the transformation applies to the narrowest possible set of inputs. Broad pattern matching or fuzzy heuristics are not acceptable.
4. **Test both activation and no-op cases** — every post-processing step needs tests that verify it fires when expected *and* tests that verify it leaves correct completions untouched across a range of realistic inputs.
5. **Document the rationale in code** — each step in `post-process.ts` should have a comment explaining what problem it solves, why it's safe, and what its preconditions are.
6. **Remove workarounds when root causes are fixed** — if the underlying issue is resolved at the prompt or provider level (e.g., adding prefill to a backend that lacked it), remove the corresponding post-processing step. Stale workarounds accumulate risk.

## Known Limitations

These are accepted trade-offs. Do not attempt to fix them unless explicitly asked.

- The Anthropic API rejects stop sequences that are purely whitespace, so `src/utils/post-process.ts` enforces `\n\n` stop boundaries in post-processing instead.
- Ollama discards the system prompt in raw mode — only `userMessage` is sent.
- Cache keys do not include the document URI, so identical prefix/suffix text in different files can return a cached completion that was generated for a different file.
- The cache is auto-cleared on profile switch, but not on individual setting changes. It may serve completions generated with previous settings until they expire (5-minute TTL) or are evicted. Use the "Bespoke AI: Clear Completion Cache" command to manually clear it.
- The extension does not validate config values, so it passes invalid settings through to providers unchecked.
- Tests use top-level `await`, which is incompatible with the `commonjs` module setting in `tsconfig.json`. To avoid build errors, `tsconfig.json` excludes `src/test/`. This does not affect test execution because Vitest uses its own TypeScript transformer independent of `tsconfig.json`.

## Future Direction

Bespoke AI is evolving from a single-purpose inline completion extension into a broader personal AI toolkit. Planned capabilities beyond inline completions (do not implement unless explicitly asked):

- **Autocomplete via Claude Code** — Explore using a Claude Code subscription as the completion backend (instead of direct Anthropic API calls), potentially via the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) for richer integration. This would let users leverage their existing Claude Code subscription rather than managing a separate API key. See `docs/claude-code-latency-research.md` for feasibility analysis.
