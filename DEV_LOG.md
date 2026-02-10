# Development Log

Reverse chronological. Most recent entry first.

---

## 02-09-26

### Multi-provider API autocomplete backend

Added a direct-API autocomplete backend alongside the existing Claude Code CLI backend. Motivation: Claude Code's chat-based subprocess can't use assistant prefill (pre-seeding the model's response with the cursor anchor), so the model often fails to continue from the right place. Direct API calls fix this and unlock provider-specific features like prompt caching and streaming.

**Architecture:**

A `BackendRouter` implements `CompletionProvider` and delegates to either the existing `PoolClient` (Claude Code) or a new `ApiCompletionProvider` (direct API). The router slots into the existing `CompletionProvider` orchestrator — cache, debounce, mode detection are all unchanged.

Three SDK adapters cover five providers:

- `AnthropicAdapter` (`@anthropic-ai/sdk`) — Anthropic models, prompt caching, assistant prefill
- `OpenAICompatAdapter` (`openai` package) — OpenAI, xAI/Grok, Ollama (local)
- `GeminiAdapter` (`@google/genai`) — Google Gemini models, context caching

**Presets** define model ID, provider, generation params (temperature, max_tokens), feature flags (caching, prefill), and pricing for cost tracking. Built-in presets are bundled in `src/providers/api/presets.ts`. Switching presets via the status bar enables A/B testing between models or settings.

**Key design decisions:**

1. **Direct SDKs over Vercel AI SDK** — Vercel's abstraction doesn't fully expose provider-specific features (Anthropic prompt caching, Gemini context caching). Three thin adapters give us full control with minimal code.

2. **Commands stay on Claude Code** — Commit message, suggest-edits, and expand commands work fine with the Claude Code backend and benefit from longer context. Only inline completions get the API backend.

3. **Separate debounce** — API mode uses 400ms (vs 8000ms for Claude Code) because API roundtrips are much faster than subprocess communication.

4. **Cost transparency** — Every API call records tokens, cost, duration, and model to the UsageLedger. Test runs also track total cost and per-scenario latency.

**Phase 1 (this commit):** Anthropic adapter + end-to-end wiring. OpenAI-compat and Gemini adapters are stubbed out for Phase 2/3.

---

## 02-01-26

### Reusable Claude Code slot pool

Refactored the Claude Code provider from disposable slots (kill + respawn after every completion) to reusable slots (one subprocess handles up to 24 completions before recycling).

**Before:** Each completion acquired a slot → pushed a message → awaited the result → recycled the slot (closed the channel, killed the subprocess, spawned a fresh one). The `AbortSignal` was raced against the result promise via `raceAbort()`.

**After:** The `consumeStream` loop continues after delivering a result — it resets the result promise, marks the slot `available`, and waits for the next message. A slot recycles only after 24 completions (warmup=1, maxTurns=50, leaves headroom) or on stream error. The `raceAbort` helper is deleted entirely.

**Key design decisions:**

1. **Single-waiter queue** replaces the 100ms polling loop. A `pendingWaiter` field holds one waiting request. When a new request arrives and both slots are busy, it cancels the previous waiter (`resolve(null)`) and registers itself. Slots notify the waiter immediately when they become available (via `notifyWaiter()`).

2. **Committed in-flight requests** — once `acquireSlot()` returns a slot index, the request awaits `slot.resultPromise` unconditionally. The `AbortSignal` parameter is kept (interface requirement) but ignored. This eliminates the abort race that could leave a slot in an inconsistent state.

3. **Slot states simplified** — removed `recycling` state, renamed `ready` → `available`. States: `initializing → available → busy → available → ... → recycleSlot → initializing`.

**Why not abort?** With reusable slots, aborting mid-request is unsafe: the subprocess is still processing the message and will produce a result that needs to be consumed before the slot can be reused. Ignoring the result would desync the stream. The cost of waiting for a committed result is low (sub-second) and avoids the complexity of stream resynchronization.

---

## 01-31-26

### Claude Code prompt overhaul: examples, marker rename, and engine mode

Major prompt engineering session to improve Claude Code completion quality. Added new examples, renamed the fill marker, and restructured guidance.

**Marker rename: `>>>HOLE_TO_FILL<<<` → `>>>GAP_TO_FILL<<<`**

The word "hole" implied something that _must_ be filled. "Gap" better conveys that the space might need bridging with substantial content, minimal content, or nothing at all depending on context.

**Why not a self-closing XML tag like `<fill/>`?**

Tested earlier — self-closing tags like `<fill/>` caused Claude Code to output matching closing patterns like `</filled>` or `</fill>` in completions. The model treated it as an XML structure to complete rather than a marker to replace. The `>>>MARKER<<<` format avoids this by being visually distinct from XML.

**New examples added (8 total, up from 4):**

| #   | Pattern                   | Teaches                                  |
| --- | ------------------------- | ---------------------------------------- |
| 1   | Bullet list (`- `)        | Don't repeat marker                      |
| 2   | JSON object               | Indentation + raw code                   |
| 3   | Function body             | Indentation + code                       |
| 4   | Mid-word (`quic`)         | Complete partial word                    |
| 5   | Prose bridging            | Short phrase fill between prefix/suffix  |
| 6   | After heading             | Start prose, not structure               |
| 7   | Numbered list (`3. `)     | Don't repeat marker                      |
| 8   | Before structured content | Brief lead-in, don't duplicate/elaborate |

**New prompt structure:**

1. Examples section with clear "What you receive" / "What you should output" format
2. Engine mode transition: "The examples are complete. From now on, act as the gap-filling engine — no more examples, just raw output."
3. Length guidance: "Use judgment to decide how much to output: from a single character (completing a partial word) to several sentences (when substantial content is needed). When in doubt, prefer brevity."
4. Tightened rules with back-references to examples

**Rules (updated):**

- Always wrap in `<output>` tags
- No code fences, commentary, or meta-text
- Never repeat structural markers (see example 1)
- Don't duplicate/elaborate on suffix content (see example 8)
- Not a chat — tool pipeline

**Regressions fixed:**

- List marker echo (`- - **content**`) — fixed via Example 1 + explicit rule
- JSON markdown fencing (``` wrapping) — fixed via "no code fences" rule

**New regression captured:**

- Partial date continuation — user types `0` to start `01-31-26`, model should continue with `1-31-26` but sometimes inserts full date. Added as regression test for tracking.

---

## 01-30-26

### Claude Code provider: TEXT_TO_FILL prompt rewrite

Replaced the Claude Code provider's anchor echo strategy with a `${TEXT_TO_FILL}` placeholder approach. The old approach instructed the model to echo the current line as an anchor, then `trimPrefixOverlap` stripped the echo — fragile and indirect. The new approach wraps the document in `<incomplete_text>` tags with a `${TEXT_TO_FILL}` placeholder at the cursor position. The model fills the hole directly.

**What changed:**

- `src/providers/claude-code.ts` — New system prompt with `${TEXT_TO_FILL}` example. Removed `extractAnchor()` function. Removed `PromptBuilder` dependency (reads `maxTokens`/`temperature` directly from mode config). Message assembly now wraps `prefix + ${TEXT_TO_FILL} + suffix` in `<incomplete_text>` tags — same format for prose and code. Passes `undefined` for prefix in `postProcessCompletion()` to skip `trimPrefixOverlap`.
- `src/scripts/dump-prompts.ts` — Updated to reflect new prompt format, removed `extractAnchor` import.
- `src/test/unit/anchor.test.ts` — Deleted (tested the removed `extractAnchor` function).
- `src/test/api/anchor-echo.test.ts` — Rewritten as TEXT_TO_FILL adherence test. Verifies the model fills the placeholder without echoing prefix or suffix text.
- `CLAUDE.md` — Added Claude Code provider entry, updated prompt-builder description.

**Test results:** 226 unit tests passing, lint + type-check clean. TEXT_TO_FILL adherence API test: 6/6 scenarios clean (no prefix echo, no suffix echo). Completions are contextually appropriate across prose continuation, bullet lists, code FIM, heading continuation, and short input scenarios.

---

## 01-28-26 (late evening)

### API research and provider fixes

Deep-dived into both the Anthropic SDK and Ollama API to ensure correct, token-efficient usage. Two research agents ran in parallel. Full findings documented in:

- `docs/anthropic-sdk-reference.md` — prefill behavior, stop sequence constraints, caching limits, timeout config, error classes
- `docs/ollama-api-reference.md` — raw vs templated mode, FIM via suffix param, keep_alive, KV cache reuse, endpoint selection

**Code changes based on research:**

- **Anthropic:** Removed dead prefill stripping logic (API doesn't echo prefill). Set client timeout to 30s (was 10min default). Added `\n\n` post-processing trim (Anthropic drops whitespace-only stop sequences). Added `APIUserAbortError` catch.
- **Ollama:** Redesigned raw mode usage — prose uses `raw: true` (continuation), code FIM uses `raw: false` with `suffix` param (Ollama handles model-specific FIM tokens). Added `keep_alive: "30m"`. System prompt now sent in non-raw mode.
- **Types/prompt-builder:** Added `suffix` to `BuiltPrompt` for providers with native FIM support.

**Test results:** 64 unit tests passing (+3 new), 4 API tests passing (Anthropic), 4 skipped (Ollama — no local model). `npm run check` clean.

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

- `extension.ts` — Entry point. Loads config from VS Code settings, wires up the inline completion provider, status bar, and three commands (trigger, toggle, cycle mode).
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
