# Development Log

Reverse chronological. Most recent entry first.

---

## 01-28-26 (evening)

### Code review and critical bug fixes

Ran a two-pass code review (my contextual review + fresh-eyes subagent reviewer). The background reviewer found 25 issues ranging from critical bugs to minor polish items.

**Critical bugs fixed:**

1. **Missing `isAvailable()` method** — Added `isAvailable()` to the `CompletionProvider` interface (types.ts:14) and implemented it in `OllamaProvider` (ollama.ts:21-24). The `ProviderRouter` was calling this method but it wasn't part of the interface contract.

2. **Memory leak in debouncer** — The `onCancellationRequested` listener was never disposed (debouncer.ts:28-42). Fixed by storing the listener and calling `dispose()` in both resolution paths (timeout completes or cancellation fires).

3. **Dead code: 'universal' mode** — The `CompletionMode` type included `'universal'` but `ModeDetector` never returned it. Removed from type definition (types.ts:1), removed unused `buildUniversalPrompt()` method (prompt-builder.ts), and simplified switch statement. The README called it "Universal (auto)" which was confusing — renamed to just "Auto" for clarity.

4. **Cross-platform filename bug** — Used `split('/')` which fails on Windows (context-builder.ts:29). Changed to `path.basename()` for proper cross-platform support.

5. **Documentation accuracy** — README claimed "last 3-5 words" for Anthropic prefill but code uses exactly 4 words (`slice(-4)` in prompt-builder.ts:36). Updated README to say "last 4 words".

**Other findings not fixed (yet):**

The reviewer identified 20 additional issues including: Anthropic prefill stripping logic may be based on API misunderstanding, cache key collision potential, missing config validation, no cross-platform file permissions check for API key file, console.log instead of output channels, etc. These are documented for future work.

All fixes verified with `npm run check` — zero errors, zero warnings.

---

## 01-28-26 (afternoon)

### Initial build — full extension scaffolded and compiling

Built the entire extension from scratch based on a design plan developed in a prior Claude Code session. The plan laid out a VSCodium extension for inline ghost-text completions with three modes (prose, code, universal/auto-detect) and two backends (Anthropic Claude, Ollama).

**What got built (11 source files, compiles clean with zero TypeScript errors):**

- `extension.ts` — Entry point. Loads config (including API key fallback to `~/.creds/api-keys.env`), wires up the inline completion provider, status bar, and three commands (trigger, toggle, cycle mode).
- `types.ts` — Central type definitions: `CompletionMode`, `Backend`, `CompletionContext`, `CompletionProvider` interface, `BuiltPrompt`, `ExtensionConfig`.
- `completion-provider.ts` — The orchestrator. Implements `InlineCompletionItemProvider`. Runs the full chain: mode detection → context extraction → cache check → debounce → provider call → cache write → return.
- `mode-detector.ts` — Maps VS Code `languageId` to prose/code. Maintains sets of known code languages and prose languages. Unrecognized languages default to prose (intentional — primary use case is writing).
- `prompt-builder.ts` — Constructs mode-specific prompts. Prose mode uses continuation-style prompting with assistant prefill support. Code mode includes filename/language context and prefix+suffix framing. Universal mode falls back to a generic continuation prompt.
- `providers/anthropic.ts` — Claude API client using `@anthropic-ai/sdk`. Implements prefill (seeds assistant response with last few words to force continuation). Supports prompt caching via `cache_control: { type: "ephemeral" }`. Passes `AbortSignal` for cancellation.
- `providers/ollama.ts` — Ollama client using native `fetch`. Hits `/api/generate` with `raw: true` for base models. Passes `AbortSignal` for cancellation.
- `providers/provider-router.ts` — Thin router that holds both provider instances and returns the active one based on config.
- `utils/debouncer.ts` — Promise-based debounce that integrates with VS Code's `CancellationToken` and returns an `AbortSignal` for HTTP request cancellation. Clears previous timers and aborts in-flight requests on new keystrokes.
- `utils/cache.ts` — LRU cache with TTL (50 entries, 5min). Key is `mode + last 500 chars of prefix + first 200 chars of suffix`.
- `utils/context-builder.ts` — Extracts prefix/suffix from a `TextDocument` at a given position with configurable context window sizes.

Also set up: `package.json` with full configuration schema (all settings, commands, keybindings), `tsconfig.json`, `esbuild.js` build script, `.vscode/launch.json` for F5 debugging, `.vscode/tasks.json` for watch mode.

**What was NOT built:**

- No tests. No test framework installed, no test files.
- No linting. ESLint was referenced in `package.json` scripts but wasn't installed or configured. (Being fixed today.)
- No design document or dev log. The plan only existed in the conversation transcript. (This file and README.md fix that.)
- No CLAUDE.md project instructions file for future Claude Code sessions.

**Decisions made during implementation:**

- Used esbuild for bundling (fast, simple, standard for VS Code extensions).
- Anthropic SDK is the only runtime dependency. Ollama uses native `fetch`.
- Prompt caching applies `cache_control` to the system message array, which required a type assertion since the SDK types don't expose it cleanly on `TextBlockParam`.
- The debouncer creates a new `AbortController` per debounce cycle and aborts the previous one, ensuring only one HTTP request is in flight at a time.
