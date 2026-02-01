# Bespoke AI

A VSCodium/VS Code extension that provides inline ghost-text completions for both prose and code, powered by Anthropic Claude or Ollama.

## Why This Exists

Most AI coding assistants are built for code. They treat prose as an afterthought — if they handle it at all. This extension is built for writers who also code. The primary use case is natural prose continuation in markdown and plaintext files, with code completion as a full peer feature rather than the sole focus.

The extension auto-detects whether you're writing prose or code and adjusts its prompting strategy accordingly. It supports two backends from day one: Anthropic Claude (cloud, high quality) and Ollama (local, private, free).

## How It Works

### Three Modes

| Mode      | Activates for                                        | Strategy                                                                                                             |
| --------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Prose** | `markdown`, `plaintext`, `latex`, `restructuredtext` | Continuation-style prompting. "Continue this text naturally." Uses Anthropic prefill to force seamless continuation. |
| **Code**  | All recognized programming languages                 | FIM-style with prefix + suffix context. Language-aware (filename, language ID in system prompt).                     |
| **Auto**  | Default                                              | Auto-selects prose or code based on `document.languageId`. Unrecognized languages default to prose.                  |

The mode is auto-detected but can be overridden via settings or by clicking the status bar item to cycle through `auto → prose → code → auto`.

### Two Backends

**Anthropic Claude** — Cloud API via `@anthropic-ai/sdk`. Features:

- Assistant prefill for prose mode (forces natural continuation by seeding the response with the last 4 words of your text)
- Prompt caching headers sent (`cache_control: { type: "ephemeral" }`), though caching likely does not activate — Anthropic requires 1,024+ token cached prefix and our system prompts are ~50 tokens. See `docs/anthropic-sdk-reference.md`.
- Default model: `claude-haiku-4-5-20251001`

**Ollama** — Local inference via HTTP API. Features:

- Prose uses raw mode (`raw: true`) for direct text continuation; code FIM uses templated mode with native `suffix` parameter
- No SDK dependency — uses native `fetch`
- Default model: `qwen2.5:3b`

### Request Lifecycle

```
User types
  → VS Code fires InlineCompletionItemProvider
  → Previous CancellationToken is cancelled
  → Debounce timer starts (300ms default)
  → Timer fires → check cancellation
  → Abort any in-flight HTTP request
  → Check LRU cache (50 entries, 5min TTL)
  → Build prompt (mode-specific)
  → Call backend provider
  → Check cancellation again
  → Cache result → return InlineCompletionItem
```

This chain ensures rapid typing doesn't pile up stale requests.

## Project Structure

```
src/
  extension.ts                  Entry point: activate, config, status bar, commands
  types.ts                      Shared interfaces (CompletionMode, Backend, etc.)
  completion-provider.ts        InlineCompletionItemProvider orchestrator
  mode-detector.ts              Maps languageId → prose/code
  prompt-builder.ts             Constructs prompts per mode
  providers/
    anthropic.ts                Claude API client with prefill + caching
    ollama.ts                   Ollama HTTP client with raw + FIM modes
    provider-router.ts          Selects backend based on config
  utils/
    debouncer.ts                Promise-based debounce with CancellationToken + AbortSignal
    cache.ts                    LRU cache with TTL
    context-builder.ts          Extracts prefix/suffix from TextDocument
```

## Configuration

All settings are under `bespokeAI.*` in VS Code/VSCodium settings.

### General

| Setting      | Type                              | Default       | Description                               |
| ------------ | --------------------------------- | ------------- | ----------------------------------------- |
| `enabled`    | boolean                           | `true`        | Master on/off toggle                      |
| `backend`    | `"anthropic"` \| `"ollama"`       | `"anthropic"` | Which backend to use                      |
| `mode`       | `"auto"` \| `"prose"` \| `"code"` | `"auto"`      | Completion mode (auto-detects by default) |
| `debounceMs` | number                            | `300`         | Delay before triggering a completion      |

### Anthropic

| Setting                | Type     | Default                              | Description                                             |
| ---------------------- | -------- | ------------------------------------ | ------------------------------------------------------- |
| `anthropic.apiKey`     | string   | `""`                                 | Anthropic API key for Claude completions                |
| `anthropic.model`      | string   | `"claude-haiku-4-5-20251001"`        | Model ID. See `anthropic.models` for available options. |
| `anthropic.models`     | string[] | `["claude-haiku-4-5-20251001", ...]` | Available Anthropic models                              |
| `anthropic.useCaching` | boolean  | `true`                               | Enable prompt caching                                   |

### Ollama

| Setting           | Type     | Default                    | Description                                            |
| ----------------- | -------- | -------------------------- | ------------------------------------------------------ |
| `ollama.endpoint` | string   | `"http://localhost:11434"` | Ollama API URL                                         |
| `ollama.model`    | string   | `"qwen2.5:3b"`             | Model name. See `ollama.models` for available options. |
| `ollama.models`   | string[] | `["qwen2.5:3b", ...]`      | Available Ollama models                                |
| `ollama.raw`      | boolean  | `true`                     | Use raw mode (no chat template)                        |

### Prose Mode

| Setting               | Type     | Default                     | Description                               |
| --------------------- | -------- | --------------------------- | ----------------------------------------- |
| `prose.maxTokens`     | number   | `100`                       | Max tokens per completion                 |
| `prose.temperature`   | number   | `0.7`                       | Sampling temperature                      |
| `prose.stopSequences` | string[] | `["\n\n", "---", "##"]`     | Stop sequences                            |
| `prose.contextChars`  | number   | `2000`                      | Prefix context window                     |
| `prose.fileTypes`     | string[] | `["markdown", "plaintext"]` | Additional language IDs to treat as prose |

### Code Mode

| Setting              | Type     | Default    | Description               |
| -------------------- | -------- | ---------- | ------------------------- |
| `code.maxTokens`     | number   | `256`      | Max tokens per completion |
| `code.temperature`   | number   | `0.2`      | Sampling temperature      |
| `code.stopSequences` | string[] | `["\n\n"]` | Stop sequences            |
| `code.contextChars`  | number   | `4000`     | Prefix context window     |

## Commands & Keybindings

| Command                          | Keybinding       | Description                       |
| -------------------------------- | ---------------- | --------------------------------- |
| `Bespoke AI: Trigger Completion` | `Ctrl+L`         | Manually trigger a completion     |
| `Bespoke AI: Toggle Enabled`     | —                | Toggle the extension on/off       |
| `Bespoke AI: Cycle Mode`         | Click status bar | Cycle through auto → prose → code |

## Setup

### Prerequisites

- Node.js 18+
- VSCodium or VS Code 1.85+
- For Anthropic: an API key
- For Ollama: Ollama running locally with a model pulled

### Install & Build

```sh
npm install
npm run compile
```

### Development

```sh
npm run watch    # esbuild watch mode
# Press F5 in VSCodium/VS Code to launch Extension Development Host
```

### Quality Checks

```sh
npm run check    # Runs lint + type-check
npm run lint     # ESLint only
```

### Testing

1. Open a `.md` file — should get prose-style completions
2. Open a `.ts` or `.py` file — should get code-style completions
3. Check status bar shows mode + backend
4. Click status bar to cycle modes
5. `Ctrl+L` to manually trigger
6. Change `backend` setting to switch between Anthropic and Ollama

## Key Design Decisions

**Prose-first defaults.** Unrecognized language IDs fall back to prose mode, not code. This reflects the primary use case.

**Prefill for prose.** Anthropic's assistant prefill feature seeds the response with the last few words of the user's text, which forces the model to continue naturally instead of paraphrasing or commenting on the text.

**Smart raw mode for Ollama.** Prose mode uses `raw: true` to bypass the chat template — essential for base/completion models doing direct text continuation. Code mode with a suffix uses `raw: false` so Ollama can apply its model-specific FIM template (e.g., Qwen2.5's `<|fim_prefix|>`/`<|fim_suffix|>`/`<|fim_middle|>` tokens) via the native `suffix` parameter.

**No streaming.** Ghost text must be returned as a complete string. Streaming would require incremental rendering, which the VS Code inline completion API doesn't support natively.

**LRU cache with TTL.** Prevents redundant API calls when the user's cursor returns to a previously-completed position. 50 entries, 5-minute TTL.

## Known Issues

Identified during code review and API research (01-28-26). To be addressed in future work.

- **Cache key collisions.** The LRU cache keys on the last 500 chars of prefix + first 200 of suffix. Two different cursor positions with the same surrounding text will collide. Consider adding document URI or offset to the key.
- **No config validation.** Negative `debounceMs`, out-of-range `temperature`, zero `maxTokens`, etc. are not caught. Invalid values pass through to the providers.
- **Console logging instead of output channel.** Errors go to `console.error`, which lands in the developer console most users never open. Should use a `vscode.OutputChannel` for visibility.
- **Non-null assertions in config loading.** `loadConfig()` uses `!` on every `ws.get()` call even though the default parameter guarantees non-null. Noise, not a bug.
- **Status bar doesn't reflect backend availability.** If no Anthropic API key is configured, the status bar still shows "Claude" with no warning indicator.
- **Prompt caching may not activate.** Anthropic requires a minimum of 1,024 tokens in the cached prefix for caching to take effect. Our system prompts are short (~50 tokens), so the `cache_control` header is sent but caching likely never engages. Needs a longer cacheable prefix or should be disabled to avoid confusion.

### Resolved Issues (01-28-26)

- ~~Anthropic prefill stripping~~ — Confirmed the API does NOT echo prefill back. Removed the dead stripping logic that could corrupt output.
- ~~Ollama raw mode discards system prompts~~ — Ollama now uses `raw: false` with the `system` and `suffix` params for code FIM. Raw mode is only used for prose (simple continuation with base models).
- ~~Ollama `raw: false` path is incomplete~~ — Non-raw path now properly sends `system` and `suffix` params to `/api/generate`, which Ollama handles with model-specific templates.

## Future Enhancements

- Token usage tracking / daily budget enforcement
- Predictive pre-caching (prefetch next completion after acceptance)
- Partial acceptance (accept first word with Ctrl+Right, first line with Shift+Tab)
- OpenAI-compatible API provider (covers LM Studio, OpenRouter, etc.)
- Adaptive debounce (shorter delay after accepting a completion)
- Per-workspace mode/backend overrides

## Vision: Text Actions — AI-Powered Reading & Writing Toolkit

Beyond inline completions, Bespoke AI aims to become a full AI toolkit for working with text in VS Code. The core idea: **select text → right-click → pick an AI action → get a result**. This works in the editor, the terminal, and anywhere VS Code supports context menus.

The architecture is an **Action Registry** — each action is an ID, a prompt template, and an output mode. The infrastructure makes adding new actions trivial once the plumbing exists.

### Output Modes

| Mode                                       | Use case                                        |
| ------------------------------------------ | ----------------------------------------------- |
| **Side panel** (Webview, renders Markdown) | Explanations, summaries, analysis               |
| **Inline replace** (with undo)             | Rephrase, fix errors, expand                    |
| **Diff preview** (accept/reject)           | Rewrites where you want to compare before/after |
| **New document tab**                       | Long outputs like outlines, document digests    |
| **Notification/hover**                     | Short answers, quick definitions                |

### Selection Actions (Right-Click Menu)

- **Explain** — plain-language explanation of selected text (jargon, technical, legal, etc.)
- **Rephrase** — with sub-options: simpler, more formal, more concise, more detailed, custom
- **Check for Errors** — grammar, spelling, and semantic/logical issues beyond what spell-check catches
- **Summarize Selection** — condense a passage to key points
- **Expand** — flesh out a brief note or outline bullet into full prose
- **Define / Look Up** — terms, acronyms, jargon
- **Simplify** — rewrite at a lower reading level (great for dense academic/legal docs)
- **Formalize** — casual notes → professional prose
- **Translate** — to/from any language
- **Ask About Selection** — free-form question about the highlighted text (catch-all)
- **Counter-Argument** — "What would someone argue against this?"
- **Extract Action Items** — pull tasks/TODOs from meeting notes, emails, etc.

### Dictation Cleanup

- **Fix Dictation** — purpose-built for voice-to-text artifacts: wrong homophones, missing punctuation, run-on sentences, dropped words. Different from generic grammar check — understands dictation-specific errors.

### Whole-Document Actions

- **Summarize Document** — executive summary + key points
- **Document Digest** — side panel with summary, section-by-section breakdown, click to navigate
- **Check Consistency** — find contradictions, repeated points, tone shifts, terminology inconsistencies
- **Suggest Structure** — propose headings and organization for unstructured text
- **Generate Table of Contents** — from existing headings or AI-suggested
- **Extract Key Facts / Entities** — people, dates, numbers, decisions, organizations
- **Generate Questions** — "What does this document leave unanswered?" or study/review questions
- **Assess Reading Level** — Flesch-Kincaid style analysis with plain-language interpretation
- **Fact-Check Flags** — highlight claims that should be verified (flags, doesn't verify)
- **Bias / Tone Analysis** — flag potentially biased language or framing issues

### Markdown-Specific Tools

- **Fix / Clean Formatting** — repair broken links, inconsistent headings, malformed tables (especially for docs pulled from other sources)
- **Smart Paste** — detect pasted format (HTML, plain text, messy Markdown) and convert to clean Markdown
- **Generate Mermaid Diagram** — from text descriptions of processes, relationships, timelines
- **Table Operations** — AI-powered sort, summarize, add computed columns
- **Link Enhancer** — suggest links for referenced concepts, check for broken references

### Writing Assistance

- **Continue Writing** — explicit longer-form generation beyond inline ghost text
- **Suggest Transitions** — between paragraphs or sections
- **Outline from Prompt** — describe a topic, get a structured outline
- **Template Generation** — "I need a project proposal" → structured template with guidance
- **Style Match** — read surrounding document and ensure new text matches tone/terminology

### Advanced / Power Features

- **Document Q&A** — chat-like interface in side panel; ask questions about the open document
- **Multi-Document Synthesis** — select multiple files, find common themes, contradictions, or produce a unified summary
- **Compare Documents** — AI-powered diff: not line-by-line, but "what changed and why it matters"
- **Semantic Search** — find passages by meaning, not just keyword ("where does the author discuss budget implications?")
- **Create Flashcards / Study Notes** — from selection or whole document
- **Meeting Notes Pipeline** — raw notes → structured format → extracted action items
- **Writing Metrics** — live word count, reading level, sentence complexity, passive voice %
