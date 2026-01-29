# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

A VS Code extension providing inline completions (ghost text) for prose and code. Two backends: Anthropic Claude (cloud) and Ollama (local). Auto-detects prose vs code completion mode based on `document.languageId`. The extension works identically in both VS Code and VSCodium.

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
```

Run a single test file: `npx vitest run src/test/unit/cache.test.ts`

Pressing F5 in VS Code launches the Extension Development Host using the `npm:watch` build task.

esbuild bundles `src/extension.ts` into `dist/extension.js` (CommonJS, targeting Node.js 18). The build marks the `vscode` module as external because the VS Code host provides it at runtime. The only runtime dependency is `@anthropic-ai/sdk`.

## Architecture

**Request flow:** User types → VS Code calls `provideInlineCompletionItems` → detect mode → extract document context → check LRU (Least Recently Used) cache → debounce (300ms) → call provider (which builds the prompt internally and post-processes the result) → cache result → return `InlineCompletionItem`.

**Error handling:** Providers catch abort errors and return `null`; all other errors propagate to `CompletionProvider`, which logs them via the `Logger` and returns `null`. The extension does not surface runtime completion errors to the user, though configuration issues (e.g., missing API key) show a one-time warning at activation. **Follow this same pattern for new code.**

**Logging:** The `Logger` class (`src/utils/logger.ts`) wraps a VS Code `OutputChannel` ("AI Prose Completion"). Created in `activate()` and injected into `CompletionProvider`, `ProviderRouter`, and both providers. The `aiProseCompletion.logLevel` setting controls verbosity:

| Level | Use |
|-------|-----|
| `info` (default) | Lifecycle: activation, config changes, profile switches |
| `debug` | Per-request metadata: mode, backend, char counts, model params, token usage |
| `trace` | Full payloads: complete prefix, suffix, system, user message, prefill |

Use `logger.info()` for lifecycle events, `logger.debug()` for per-request metadata, `logger.trace()` for full payloads, and `logger.error()` for failures. The output channel is visible in the VS Code Output panel.

**Key components, listed in request-flow order:**

- `src/extension.ts` — Activation entry point. Loads config from VS Code's `aiProseCompletion.*` settings (falls back to `ANTHROPIC_API_KEY` in `~/.creds/api-keys.env` for the API key). Creates the `Logger`, all components, and registers the inline completion provider, status bar, and six commands: `trigger` (`Ctrl+L`), `toggleEnabled`, `cycleMode` (cycles auto → prose → code → auto), `clearCache`, `selectProfile` (QuickPick UI for switching profiles), and `showMenu` (unified status bar menu). Watches for config changes and propagates via `updateConfig()`. On profile switch, auto-clears the completion cache. Manages a request spinner in the status bar while completions are in-flight.

- `src/completion-provider.ts` — Orchestrator implementing `vscode.InlineCompletionItemProvider`. Coordinates mode detection → context extraction → cache lookup → debounce → provider call → cache write. Accepts a `Logger` as 3rd constructor param for centralized logging. Exposes `clearCache()` for manual or profile-switch cache clearing and `setRequestCallbacks()` for spinner integration. The debouncer manages `AbortSignal` lifecycle for cancelling in-flight requests.

- `src/mode-detector.ts` — Maps `languageId` to `'prose' | 'code'`. The `aiProseCompletion.mode` setting overrides auto-detection when set to `prose` or `code`. Unknown languages default to prose because the primary use case is writing.

- `src/prompt-builder.ts` — Constructs `BuiltPrompt` per mode. Each provider instantiates its own `PromptBuilder` and calls it internally. Prose uses continuation-style prompting with assistant prefill (seeding the assistant response with the last 4 words so the model continues naturally). Code uses FIM (Fill-in-the-Middle) with prefix/suffix and filename/language context.

- `src/providers/anthropic.ts` — Claude API via `@anthropic-ai/sdk`. Supports assistant prefill and Anthropic's prompt caching feature (marks prompt prefixes with `cache_control` so the API reuses them across requests, reducing cost). Accepts a `Logger` for debug/trace logging of requests and responses (model params, token usage, full payloads at trace level).

- `src/providers/ollama.ts` — Calls Ollama's `/api/generate` endpoint using Node.js built-in `fetch()`. Uses raw mode (`raw: true`) to bypass Ollama's chat template for base/completion models, but automatically switches to non-raw mode for code completions with a suffix so Ollama can apply native FIM (Fill-in-the-Middle) tokens. Accepts a `Logger` for debug/trace logging.

- `src/providers/provider-router.ts` — Holds both provider instances, returns the active one based on `config.backend`. Accepts a `Logger` as 2nd param and passes it to both providers. "Backend" is the user-facing config choice; "provider" is the code abstraction that implements the `CompletionProvider` interface.

- `src/utils/post-process.ts` — Applies a shared post-processing pipeline to all provider output before caching. Strips markdown code fences, leading newlines, and enforces `\n\n` stop boundaries (see Known Limitations for why).

- `src/utils/debouncer.ts` — Promise-based debounce that responds to two cancellation layers: the VS Code `CancellationToken` cancels the debounce wait, and the `AbortSignal` aborts in-flight HTTP requests.

- `src/utils/cache.ts` — LRU cache with 50 entries and 5-minute TTL (time-to-live). Cache key is built from the mode, the last 500 characters of prefix, and the first 200 characters of suffix. URI is intentionally excluded — see Known Limitations.

- `src/utils/env.ts` — Reads the Anthropic API key from `~/.creds/api-keys.env`. Shared by both the extension activation (`src/extension.ts`) and test helpers (`src/test/helpers.ts`).

- `src/utils/context-builder.ts` — Extracts prefix/suffix from `TextDocument` + `Position`. Both `prefixChars` and `suffixChars` are configurable via `prose.contextChars`/`prose.suffixChars` and `code.contextChars`/`code.suffixChars` settings. Uses `path.basename()` for cross-platform filename.

- `src/utils/logger.ts` — `Logger` class wrapping `vscode.OutputChannel`. Provides `info()`, `debug()`, `trace()`, and `error()` methods with timestamps. Level-gated by `setLevel()`: trace shows all, debug shows debug+info+error, info shows only info+error. Created once in `activate()` and injected into `CompletionProvider` and both providers.

- `src/utils/model-name.ts` — `shortenModelName()` pure function. Shortens model IDs for status bar display (e.g., `claude-haiku-4-5-20251001` → `haiku-4.5`). Strips `claude-` prefix, date suffixes, and converts version separators.

- `src/utils/profile.ts` — `applyProfile()` pure function. Deep-merges a `ProfileOverrides` object over a base `ExtensionConfig`. The API key always comes from the base config (security guard against profile injection).

All shared types live in `src/types.ts`. The key interface is `CompletionProvider`, which both provider implementations (Anthropic and Ollama) conform to — see that file for the current shape. `ProfileOverrides` defines the subset of `ExtensionConfig` that profiles can override (excludes `enabled` and `apiKey`). `ExtensionConfig` defines the same fields as the `aiProseCompletion.*` settings in `package.json` — when modifying either, update both to keep them in sync.

## Adding a New Setting

Adding or modifying a VS Code setting requires coordinated changes to:

| Step | File | What to change |
|------|------|----------------|
| 1 | `package.json` | Add to `contributes.configuration` |
| 2 | `src/types.ts` | Add field to `ExtensionConfig` |
| 3 | `src/extension.ts` | Read it in `loadConfig()` |
| 4 | `src/test/helpers.ts` | Add default value in `makeConfig()` |
| 5 | (varies) | Use the new config field in the consuming component |

If the setting should take effect without restarting VS Code, also propagate the new value through `CompletionProvider.updateConfig()` and/or `ProviderRouter.updateConfig()`.

## Testing

### Running all tests

When asked to "run tests" (without further qualification), run the full test suite:

```bash
npm run check && npm run test:unit && npm run test:api && npm run test:quality
```

After `test:quality` completes, it prints Layer 2 instructions to stdout. Follow those instructions — Layer 1 only generates completions; Layer 2 (your evaluation) is the actual quality test. Do not stop after Layer 1.

### Unit tests

Unit tests use Vitest with `globals: true`. Test helpers in `src/test/helpers.ts` provide `makeConfig()` (config factory), `makeLogger()` (no-op mock Logger for tests that construct providers), and `createMockToken()` (mock `CancellationToken` with a `cancel()` trigger).

Debouncer and cache tests use `vi.useFakeTimers()`. For debouncer tests, use `vi.advanceTimersByTimeAsync()` (not `vi.advanceTimersByTime()`) to ensure microtasks flush correctly.

Context-builder tests (`context-builder.test.ts`) use a minimal mock `TextDocument` with `getText()`, `offsetAt()`, `languageId`, and `fileName`. Post-process tests (`post-process.test.ts`) test the shared post-processing pipeline (fence stripping, newline removal, stop boundary enforcement).

### API integration tests

API integration tests (`src/test/api/`) make real HTTP calls. They use `describe.skipIf()` to skip when backends aren't available (no API key, Ollama not running). The Anthropic test reads the `ANTHROPIC_API_KEY` from `~/.creds/api-keys.env`. The Ollama test checks for model availability via `/api/tags` before running. The API test config (`vitest.api.config.ts`) sets a 30-second timeout.

### Quality Tests (LLM-as-Judge)

Quality tests (`src/test/quality/`) evaluate whether completions are actually good, not just structurally valid. This uses a two-layer validation pattern:

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

## Profiles

Profiles are named config presets stored in `aiProseCompletion.profiles`. Each profile is a partial config that deep-merges over the base settings. The active profile is set via `aiProseCompletion.activeProfile` (empty string = no profile, use base settings).

**Commands:**
- `AI Prose: Show Menu` — Unified QuickPick menu (mode, profile, actions) — status bar click target
- `AI Prose: Select Profile` — QuickPick UI to switch profiles (or select "(none)" for base settings)
- `AI Prose: Clear Completion Cache` — manually clear the LRU cache

**Behavior:**
- Clicking the status bar opens the unified menu (mode selection, profile switching, toggle enable, clear cache)
- The status bar shows a `$(loading~spin)` spinner while a completion request is in-flight
- Switching profiles auto-clears the completion cache
- Profiles cannot override `apiKey` or `enabled` (security and UX guards)
- The status bar shows the shortened model name (e.g., `haiku-4.5`) and the tooltip includes the profile name when active

**Example config:**
```json
"aiProseCompletion.profiles": {
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

## Known Limitations

These are accepted trade-offs. Do not attempt to fix them unless explicitly asked.

- The Anthropic API rejects stop sequences that are purely whitespace, so `src/utils/post-process.ts` enforces `\n\n` stop boundaries in post-processing instead.
- Ollama discards the system prompt in raw mode — only `userMessage` is sent.
- Cache keys do not include the document URI, so identical prefix/suffix text in different files can return a cached completion that was generated for a different file.
- The cache is auto-cleared on profile switch, but not on individual setting changes. It may serve completions generated with previous settings until they expire (5-minute TTL) or are evicted. Use the "AI Prose: Clear Completion Cache" command to manually clear it.
- The extension does not validate config values, so it passes invalid settings through to providers unchecked.
- Tests use top-level `await`, which is incompatible with the `commonjs` module setting in `tsconfig.json`. To avoid build errors, `tsconfig.json` excludes `src/test/`. This does not affect test execution because Vitest uses its own TypeScript transformer independent of `tsconfig.json`.
