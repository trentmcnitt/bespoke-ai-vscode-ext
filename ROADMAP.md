# Roadmap

Feature roadmap for Bespoke AI. Informed by the competitive landscape analysis in `FEATURE_MAP.md`.

## At a Glance

| Feature | Status |
|---------|--------|
| Solid inline completions | **Now** |
| Custom instructions file | Planned |
| Open-tab context | Planned |
| Snooze suggestions | Planned |
| Partial accept analytics | Planned |
| Stream-time filtering | Exploring |
| Generator reuse | Exploring |
| LSP-based context | Exploring |
| Persistent cache | Exploring |
| FIM template library | Exploring |
| NES / next edit suggestions | Deferred |
| Chat (sidebar / inline) | Deferred |
| Agent mode | Deferred |
| Code review | Deferred |
| Terminal integration | Deferred |
| Vision / image input | Deferred |
| Workspace indexing / RAG | Deferred |
| MCP support | Deferred |
| Code actions / lightbulb | Deferred |
| Rename suggestions | Deferred |
| Test generation | Deferred |
| Fork Continue.dev | Deferred |

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

### Stream-Time Filtering

Stop generation early at suffix overlap or repetition instead of waiting for the full response. Saves tokens and latency.

- Currently, post-processing runs after the full response is received
- Stream-time filtering would operate on the raw stream, character-by-character
- Key transforms: stop at suffix match, stop at line repetition, stop at function boundaries
- Only applicable to streaming backends (Anthropic API, Ollama). Claude Code delivers complete results.
- Risk: Continue.dev's stream transforms are a major source of their bugs (premature truncation, #3994)

**Reference:** Continue.dev's `core/autocomplete/filtering/streamTransforms/`.

### Generator Reuse

Reuse an in-flight LLM stream when the user types characters that match the beginning of an already-streaming completion.

- When a new request arrives and the previous stream's output starts with the new prefix, continue consuming that stream instead of cancelling
- Reduces redundant API calls for rapid typing that gets past the debouncer
- Only applicable to streaming backends (Anthropic, Ollama). Claude Code's subprocess model doesn't support this well.
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

### FIM Template Library

Expand Ollama backend with model-specific FIM prompt templates for optimal completion quality across different local models.

- Currently Ollama uses native FIM mode for code (model applies its own tokens) and raw mode for prose
- A template library would let us format FIM prompts correctly for models that don't have native FIM support
- Only matters if we want to support a wider range of local models

**Reference:** Continue.dev's `core/autocomplete/templating/AutocompleteTemplate.ts` (13+ model families).

---

## Deferred Indefinitely

Features we've evaluated and decided not to pursue. Documented here so we don't re-investigate them.

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

Evaluated as a potential base instead of building from scratch.

**Why deferred:**
- Massive codebase (hundreds of files, 49KB god-file, 50+ IDE interface methods)
- Their autocomplete has persistent quality issues (token limits, lag, display failures)
- Model-specific post-processing hacks (Codestral, Qwen3, Granite, Gemma workarounds) — the pattern we explicitly avoid
- Stripping to autocomplete-only would be weeks of work with ongoing maintenance burden
- Our codebase (~20 files) is more focused, maintainable, and already handles the same core problems
- Better to selectively study and borrow ideas than to fork
