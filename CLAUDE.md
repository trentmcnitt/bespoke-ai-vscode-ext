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

**Request flow:** User types → `provideInlineCompletionItems` fires → debounce (300ms) → check LRU cache → build prompt for detected mode → call provider → post-process result → cache result → return `InlineCompletionItem`.

**Error handling:** Providers return `null` on failure; errors go to `console.error` (visible in the Extension Development Host's Developer Tools console). Runtime completion errors are not surfaced to the user, though configuration issues (e.g., missing API key) show a one-time warning at activation. Follow this same pattern for new code.

**Key components, listed in request-flow order:**

- `src/extension.ts` — Activation entry point. Loads config from VS Code's `aiProseCompletion.*` settings (falls back to `ANTHROPIC_API_KEY` in `~/.creds/api-keys.env` for the API key). Creates all components and registers the inline completion provider, status bar, and three commands: `trigger` (`Ctrl+L`), `toggleEnabled`, and `cycleMode` (cycles auto → prose → code → auto). Watches for config changes and propagates via `updateConfig()`.

- `src/completion-provider.ts` — Orchestrator implementing `vscode.InlineCompletionItemProvider`. Coordinates mode detection → context extraction → cache lookup → debounce → provider call → cache write. Aborts the previous `AbortController` and creates a new one for each request.

- `src/mode-detector.ts` — Maps `languageId` to `'prose' | 'code'`. The `aiProseCompletion.mode` setting overrides auto-detection when set to `prose` or `code`. Unknown languages default to prose because the primary use case is writing.

- `src/prompt-builder.ts` — Constructs `BuiltPrompt` per mode. Prose uses continuation-style prompting with assistant prefill (seeding the assistant response with the last 4 words so the model continues naturally). Code uses FIM (Fill-in-the-Middle) with prefix/suffix and filename/language context.

- `src/providers/anthropic.ts` — Claude API via `@anthropic-ai/sdk`. Supports assistant prefill (pre-populating the start of the assistant's response to guide continuation) and Anthropic's prompt caching feature (marks prompt prefixes with `cache_control` so the API reuses them across requests, reducing cost).

- `src/providers/ollama.ts` — Calls Ollama's `/api/generate` endpoint using Node.js built-in `fetch()`. The raw flag (`raw: true`) bypasses Ollama's chat template for base/completion models.

- `src/providers/provider-router.ts` — Holds both provider instances, returns the active one based on `config.backend`. "Backend" is the user-facing config choice; "provider" is the code abstraction that implements the `CompletionProvider` interface.

- `src/utils/post-process.ts` — Shared post-processing pipeline applied to all provider output before caching. Strips markdown code fences, leading newlines, and enforces `\n\n` stop boundaries (some backends ignore whitespace-only stop sequences).

- `src/utils/debouncer.ts` — Promise-based debounce that responds to two cancellation layers: the VS Code `CancellationToken` cancels the debounce wait, and the `AbortSignal` aborts in-flight HTTP requests.

- `src/utils/cache.ts` — LRU (Least Recently Used) cache with 50 entries and 5-minute TTL (time-to-live). Cache key is built from the mode, the last 500 characters of prefix, and the first 200 characters of suffix. Note: URI is intentionally excluded — see Known Limitations.

- `src/utils/context-builder.ts` — Extracts prefix/suffix from `TextDocument` + `Position`. Uses `path.basename()` for cross-platform filename.

### Shared Types

All shared types live in `src/types.ts`. The key interface is `CompletionProvider`, which both provider implementations (Anthropic and Ollama) conform to — see that file for the current shape. `ExtensionConfig` defines the same fields as the `aiProseCompletion.*` settings in `package.json` — keep both in sync manually.

### Adding a New Setting

Adding or modifying a VS Code setting requires coordinated changes to:

| Step | File | What to change |
|------|------|----------------|
| 1 | `package.json` | Add to `contributes.configuration` |
| 2 | `src/types.ts` | Add field to `ExtensionConfig` |
| 3 | `src/extension.ts` | Read it in `loadConfig()` |
| 4 | Consuming component | Use the new config field |

If the setting should take effect without restarting VS Code, also update the `updateConfig()` chain: `CompletionProvider.updateConfig()` and/or `ProviderRouter.updateConfig()`.

## Testing

### Unit tests

Unit tests use Vitest with `globals: true`. Test helpers in `src/test/helpers.ts` provide `makeConfig()` (config factory) and `createMockToken()` (mock `CancellationToken` with a `cancel()` trigger).

Debouncer and cache tests use `vi.useFakeTimers()`. For debouncer tests, use `vi.advanceTimersByTimeAsync()` (not `vi.advanceTimersByTime()`) to ensure microtasks flush correctly.

### API integration tests

API integration tests (`src/test/api/`) make real HTTP calls. They use `describe.skipIf()` to skip when backends aren't available (no API key, Ollama not running). The Anthropic test reads the `ANTHROPIC_API_KEY` from `~/.creds/api-keys.env`. The Ollama test checks for model availability via `/api/tags` before running. The API test config (`vitest.api.config.ts`) sets a 30-second timeout.

### Quality Tests (LLM-as-Judge)

Quality tests (`src/test/quality/`) evaluate whether completions are actually good, not just structurally valid. This uses a two-layer validation pattern:

**Layer 1 (automated, `npm run test:quality`):** Generates real completions for every scenario and saves them to `test-results/quality-{timestamp}/`. Each scenario gets a directory with `input.json`, `completion.txt`, `requirements.json`, and `metadata.json`. Layer 1 only checks that the provider didn't throw — it does not judge quality. The `test-results/latest` symlink always points to the most recent run.

**Layer 2 (Claude Code in-session):** After Layer 1 completes, the test runner prints instructions to stdout. The Claude Code agent running the session reads each scenario's output files from `test-results/latest/` and evaluates the completion against the validator prompt (`src/test/quality/validator-prompt.md`). Save a `validation.md` file in each scenario directory and an overall `layer2-summary.md` in the run directory. If a scenario's `completion.txt` indicates a null result, mark it as a Layer 2 failure with a note that generation failed — do not skip it.

In-session evaluation incurs no additional API cost beyond the existing Claude Code subscription, and a frontier model is a stronger judge than the model generating the completions.

**Key files:**
- `src/test/quality/scenarios.ts` — Golden data: input contexts + quality requirements
- `src/test/quality/validator-prompt.md` — Evaluation criteria (scoring rubric, per-mode rules)
- `src/test/quality/judge.ts` — Type definitions for scenarios and judgments
- `test-results/` — Generated outputs (gitignored)

To add a new scenario, add a `TestScenario` object to the prose, code, or edge-case scenario array in `scenarios.ts` (choose based on the completion mode being tested). To adjust judging criteria, edit `validator-prompt.md`.

## Known Limitations

These are accepted limitations. Keep them in mind when working in affected areas.

- The Anthropic API rejects stop sequences that are purely whitespace, so `src/utils/post-process.ts` enforces `\n\n` stop boundaries in post-processing instead.
- Ollama discards the system prompt in raw mode — only `userMessage` is sent.
- Cache keys do not include the document URI, so identical prefix/suffix text in different files can produce a cache hit from the wrong file. This is accepted tech debt.
- The LRU cache is not cleared when config changes. Cached completions generated with previous settings may be served until they expire (5-minute TTL) or are evicted.
- The extension does not validate config values, so invalid settings pass through to providers unchecked.
- Tests use top-level `await`, which is incompatible with the `commonjs` module setting in `tsconfig.json`. To avoid build errors, `tsconfig.json` excludes `src/test/`. This is safe because Vitest handles its own TypeScript transformation.
