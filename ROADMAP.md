# Roadmap

Feature roadmap for Bespoke AI. Informed by the competitive landscape analysis in `FEATURE_MAP.md`.

## At a Glance

| Feature                     | Status    |
| --------------------------- | --------- |
| inline completions          | **Now**   |
| Global usage ledger         | Planned   |
| Custom instructions file    | Planned   |
| Open-tab context            | Planned   |
| Snooze suggestions          | Planned   |
| Partial accept analytics    | Planned   |
| Stream-time filtering       | Exploring |
| Generator reuse             | Exploring |
| LSP-based context           | Exploring |
| Persistent cache            | Exploring |
| Session self-correction     | Exploring |
| FIM template library        | Exploring |
| NES / next edit suggestions | Deferred  |
| Chat (sidebar / inline)     | Deferred  |
| Agent mode                  | Deferred  |
| Code review                 | Deferred  |
| Terminal integration        | Deferred  |
| Vision / image input        | Deferred  |
| Workspace indexing / RAG    | Deferred  |
| MCP support                 | Deferred  |
| Code actions / lightbulb    | Deferred  |
| Rename suggestions          | Deferred  |
| Test generation             | Deferred  |

---

## Current Focus: Solid Inline Completions

The immediate priority is making the core autocomplete experience reliable and polished before adding new features. This means working through edge cases in the Claude Code provider, tuning prompts, and improving context quality.

---

## Planned

Features we intend to implement, roughly ordered by priority.

### Custom Instructions File

Read a project-level markdown file and inject its contents into the system prompt for all completion requests. Every major tool has this now (Copilot, Cursor, Windsurf, Continue, Cline).

- Look for `.bespokeai/instructions.md` in the workspace root (or a configurable path)
- Read at activation, watch for changes via `vscode.workspace.createFileSystemWatcher`
- Append contents to the system prompt in all three providers
- Keep it simple: one file, always-on. No glob-matching or activation modes.

**Reference:** Cline's `.clinerules` is the simplest implementation to study.

### Open-Tab Context

Include content from neighboring open files in the completion prompt. Copilot saw a 5% acceptance rate improvement from this.

- Use `vscode.window.tabGroups.all` to enumerate open tabs
- Filter to code/text files (`TabInputText` with `file` or `vscode-remote` scheme)
- Prioritize: same directory > same language > recently edited
- Take first 200-500 lines per file, cap at 3-5 files total
- Run in parallel with existing context gathering, never block the completion
- Complements the existing context oracle (oracle analyzes imports/types, this provides raw neighboring content)

**Reference:** Continue.dev's `extensions/vscode/src/util/ideUtils.ts` for tab enumeration.

### Snooze Suggestions

Temporarily disable completions with auto-re-enable. A small quality-of-life feature.

- Add a "Snooze" option to the status bar menu (5-minute increments)
- Set a timer that re-enables completions when it expires
- Show remaining snooze time in the status bar tooltip

### Partial Accept Analytics

VS Code handles word-by-word acceptance automatically, but we could track it.

- Implement `handleDidPartiallyAcceptCompletionItem()` on the completion provider
- Log partial accepts at debug level
- Track in UsageTracker for acceptance pattern analysis

---

## Exploring

Features we're interested in but need more investigation before committing.

### Global Usage Ledger (Cross-Project)

Persistent, cross-project record of every Claude Code API call — total calls, input/output tokens, and cost estimates. The Claude Code backend is being used for rapid-fire autocomplete, which is not how it was designed. We need visibility into actual consumption across all projects.

**Current state:**

- `UsageTracker` is session-scoped and in-memory — resets on VS Code restart, tracks per-project only
- Tracks completion counts and input/output character counts (no token-level data from Claude Code SDK)
- The Claude Code provider's `consumeStream` only reads `result`-type messages; other SDK stream messages (which may carry usage data) are silently ignored

**What's needed:**

- A persistent store (file-based, e.g., JSON or SQLite in `~/.bespokeai/usage-ledger.json`) that accumulates across projects and sessions
- Each entry: timestamp, project (workspace root), backend, model, call count, input/output tokens, estimated cost
- A read command or dashboard — could be a VS Code command that shows a summary, or just a CLI-readable file
- Aggregation views: daily totals, per-project breakdown, per-model breakdown, running monthly total

**Token tracking challenge for Claude Code:**

- The Agent SDK spawns `claude` as a subprocess. The `result`-type messages include the completion text but it's unclear whether the stream also emits messages with token counts.
- Need to investigate what other message types the SDK stream emits (currently all non-`result` messages are ignored in `consumeStream`). There may be `usage` or `system` messages with token data.
- If the SDK doesn't provide token counts, alternatives: (a) estimate from character count using a rough chars-per-token ratio, (b) inspect the `claude` CLI's own usage reporting, (c) count calls only and skip token granularity for this backend.
- Claude Code subscription is flat-rate, so cost estimation is less relevant here than for the Anthropic API — but call volume still matters for rate limiting and fair use.

**Storage location:**

- `~/.bespokeai/usage-ledger.json` (or similar) — global, outside any project
- Append-only with periodic compaction (roll daily entries into summaries after N days)
- Must handle concurrent writes from multiple VS Code windows

### Stream-Time Filtering

Stop generation early at suffix overlap or repetition instead of waiting for the full response. Saves tokens and latency.

- Currently, post-processing runs after the full response is received
- Stream-time filtering would operate on the raw stream, character-by-character
- Key transforms: stop at suffix match, stop at line repetition, stop at function boundaries
- Only applicable to streaming backends — Claude Code delivers complete results, so this is deferred until API providers are restored. See `API_RETURN_NOTES.md`.
- Risk: Continue.dev's stream transforms are a major source of their bugs (premature truncation, #3994)

**Reference:** Continue.dev's `core/autocomplete/filtering/streamTransforms/`.

### Generator Reuse

Reuse an in-flight LLM stream when the user types characters that match the beginning of an already-streaming completion.

- When a new request arrives and the previous stream's output starts with the new prefix, continue consuming that stream instead of cancelling
- Reduces redundant API calls for rapid typing that gets past the debouncer
- Only applicable to streaming backends — Claude Code's subprocess model doesn't support this. Deferred until API providers are restored. See `API_RETURN_NOTES.md`.
- Trade-off: 300ms debounce already prevents most double-triggers, limiting the benefit

**Reference:** Continue.dev's `core/autocomplete/generation/CompletionStreamer.ts`.

### LSP-Based Context

Query VS Code's language server for type definitions and function signatures near the cursor.

- Use `vscode.executeDefinitionProvider` on imported symbols
- Extract type signatures, feed into completion prompt
- Must be non-blocking: `Promise.race()` with 50-100ms timeout
- Cache results aggressively (symbols don't change often)
- Note: Continue.dev built this then **disabled it** due to performance issues
- Our context oracle already serves a similar purpose via agent-based analysis. Evaluate whether LSP adds enough value on top.

**Reference:** Continue.dev's `extensions/vscode/src/autocomplete/lsp.ts`.

### Persistent Cache

SQLite-backed LRU cache that survives editor restarts. Currently our cache is in-memory with 5-min TTL.

- Would improve the experience after restarting VS Code (warm cache immediately)
- Need to evaluate whether stale completions from a previous session are actually useful
- The 5-min TTL exists for a reason — code changes fast

### Session Self-Correction (Claude Code)

Since the Claude Code backend reuses the same session for up to 24 completions per slot, we have a conversational channel where we can provide corrective feedback when the model drifts from the expected format. The model already sees its own prior responses in context — a targeted correction message could steer it back on track.

**Detectable failure modes (signals already exist in the code):**

- No `<output>` tags in response — `extractOutput()` falls back to raw text
- Completion start mismatch — `stripCompletionStart()` returns null
- Commentary or meta-text outside `<output>` tags (e.g., "Sure, here's the completion:")
- Refusal or hedging instead of completing

**Possible approach:**

- After delivering a result, inspect the raw response for format violations
- If a violation is detected, push a corrective message into the channel before the next real request (e.g., "Your last response included text outside `<output>` tags. Only output `<output>` tags.")
- Keep corrections minimal — one sentence, no examples. The system prompt already has the full spec.
- Track correction count per slot. If corrections exceed a threshold, recycle the slot early (the model may be stuck in a bad pattern)

**Open questions:**

- Does this actually help? The model sees the system prompt on every turn. If it drifted, a correction might just add noise. Need to measure whether corrected slots produce better subsequent completions vs. uncorrected slots.
- How often do format violations actually occur in practice? If it's rare enough, the added complexity may not be worth it. Need trace-level data from real usage to quantify.
- Could a correction message itself confuse the model, causing it to produce meta-responses ("I understand, I'll only output tags") instead of completions?
- Does the correction consume a turn from the 50-turn maxTurns budget? If so, frequent corrections reduce the effective slot lifetime.
- Is early slot recycling a better strategy than correction? If the model drifted, a fresh session with a clean context might outperform a corrected one.

### FIM Template Library

Model-specific FIM prompt templates for optimal completion quality across different local models. Only relevant if API providers (especially Ollama) are restored. See `API_RETURN_NOTES.md`.

**Reference:** Continue.dev's `core/autocomplete/templating/AutocompleteTemplate.ts` (13+ model families).

---

## Deferred

Features we've evaluated and decided not to pursue for now. Documented here so we don't re-investigate them.

### Next Edit Suggestions (NES)

Predict where the user will edit next and suggest changes at locations outside the cursor (e.g., fixing typos elsewhere in the file).

**Why deferred:**

- Requires a custom RL-trained model — the general-purpose models we use aren't designed for this
- Only 4 products have shipped it (Copilot, Cursor, JetBrains AI, Google Gemini), all with dedicated model teams
- Continue.dev's experimental NES is acknowledged as buggy, works with only 2 models, users report ~1 suggestion per 10 minutes
- The VS Code API for rendering ghost text at non-cursor positions exists but is non-trivial to use correctly
- Zed's open-source Zeta model is worth monitoring — if edit prediction models become widely available, revisit this

### Chat (Sidebar / Inline)

A conversational AI panel for explaining code, refactoring, answering questions.

**Why deferred:**

- Significant UI work (webview panel, React app, conversation state management, streaming rendering)
- The market is saturated — Cline, Roo Code, Copilot Chat, Cursor, and dozens of others already do this well
- Users who want chat already have it via Cline, Claude Code CLI, or similar tools
- Bespoke AI's identity is inline completions, not a general AI assistant

### Agent Mode

Autonomous multi-step coding: read files, edit code, run terminal commands, iterate on failures.

**Why deferred:**

- Massive implementation scope (tool orchestration, terminal integration, sandboxing, iteration loops)
- Completely saturated market — Cline (57K stars), Cursor, Codex, Copilot coding agent, etc.
- Users who want agent mode already have dedicated tools for it
- Orthogonal to our core value proposition (inline completions)

### Code Review

AI-powered analysis of diffs with inline comments and fix suggestions.

**Why deferred:**

- Specialized feature with dedicated competitors (Qodo, Bito, Copilot review)
- Requires diff analysis, inline comment rendering, GitHub/GitLab integration
- Separate product category from inline completions

### Terminal Integration

Inline suggestions or AI chat in the integrated terminal.

**Why deferred:**

- Medium-high effort with unclear benefit for our use case
- Copilot and Amazon Q have this, but it's a secondary feature for both
- The commit message generator already covers the main terminal-adjacent use case

### Vision / Image Input

Process screenshots, diagrams, or mockups for context-aware code generation.

**Why deferred:**

- Requires multimodal model integration and image processing pipeline
- Only useful for chat/agent workflows, not inline completions
- A few products have this (Copilot, Cursor, Tabnine) but it's niche

### Workspace Indexing / RAG

Embed the full codebase into a vector store for semantic retrieval.

**Why deferred:**

- Significant infrastructure (embedding pipeline, vector store, chunking strategy, index maintenance)
- Open-tab context + context oracle should cover most context needs without embeddings
- If needed later, Tabby and Twinny have open-source implementations to reference

### MCP Support

Model Context Protocol integration for extensible tool access.

**Why deferred:**

- Primarily useful for agent/chat workflows, not inline completions
- Would add dependency complexity for unclear benefit to our use case
- Can revisit if we add chat features

### Code Actions / Lightbulb Fixes

Register a `CodeActionProvider` to offer AI-powered quick fixes in the lightbulb menu.

**Why deferred:**

- Interesting feature but separate from inline completion quality
- Would need a fast, low-latency path to the LLM (lightbulb should feel instant)
- Copilot and JetBrains AI have this; Roo Code is the main open-source reference
- Revisit after core autocomplete is solid

### Rename Suggestions

AI-powered name suggestions when pressing F2 to rename a symbol.

**Why deferred:**

- Niche feature — Copilot is the only tool that does this
- Low impact relative to effort
- Requires a `RenameProvider` integration

### Test Generation

Dedicated command to generate unit tests for selected code.

**Why deferred:**

- Chat/agent feature rather than inline completion feature
- Users who need this already have Cline, Copilot, or dedicated test tools
- Could be a future command if we add a lightweight command palette

### Fork Continue.dev

Evaluated as a potential base instead of building from scratch. See `FEATURE_MAP.md` [Continue.dev Fork Analysis](FEATURE_MAP.md#continuedev-fork-analysis) for the full evaluation.

**Why deferred:** Massive codebase, persistent autocomplete quality issues, model-specific post-processing hacks. Better to selectively borrow ideas than to fork.
