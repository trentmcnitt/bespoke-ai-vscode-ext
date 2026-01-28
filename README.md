# AI Prose Completion

A VSCodium/VS Code extension that provides inline ghost-text completions for both prose and code, powered by Anthropic Claude or Ollama.

## Why This Exists

Most AI coding assistants are built for code. They treat prose as an afterthought — if they handle it at all. This extension is built for writers who also code. The primary use case is natural prose continuation in markdown and plaintext files, with code completion as a full peer feature rather than the sole focus.

The extension auto-detects whether you're writing prose or code and adjusts its prompting strategy accordingly. It supports two backends from day one: Anthropic Claude (cloud, high quality) and Ollama (local, private, free).

## How It Works

### Three Modes

| Mode | Activates for | Strategy |
|---|---|---|
| **Prose** | `markdown`, `plaintext`, `latex`, `restructuredtext` | Continuation-style prompting. "Continue this text naturally." Uses Anthropic prefill to force seamless continuation. |
| **Code** | All recognized programming languages | FIM-style with prefix + suffix context. Language-aware (filename, language ID in system prompt). |
| **Auto** | Default | Auto-selects prose or code based on `document.languageId`. Unrecognized languages default to prose. |

The mode is auto-detected but can be overridden via settings or by clicking the status bar item to cycle through `auto → prose → code → auto`.

### Two Backends

**Anthropic Claude** — Cloud API via `@anthropic-ai/sdk`. Features:
- Assistant prefill for prose mode (forces natural continuation by seeding the response with the last 4 words of your text)
- Prompt caching (`cache_control: { type: "ephemeral" }`) for ~90% cost reduction on repeated system prompts within a 5-minute window
- Default model: `claude-haiku-4-5-20241022`

**Ollama** — Local inference via HTTP API. Features:
- Raw mode (`raw: true`) bypasses the chat template, which is essential for base/completion models
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
  mode-detector.ts              Maps languageId → prose/code/universal
  prompt-builder.ts             Constructs prompts per mode
  providers/
    anthropic.ts                Claude API client with prefill + caching
    ollama.ts                   Ollama HTTP client with raw mode
    provider-router.ts          Selects backend based on config
  utils/
    debouncer.ts                Promise-based debounce with CancellationToken + AbortSignal
    cache.ts                    LRU cache with TTL
    context-builder.ts          Extracts prefix/suffix from TextDocument
```

## Configuration

All settings are under `aiProseCompletion.*` in VS Code/VSCodium settings.

### General

| Setting | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Master on/off toggle |
| `backend` | `"anthropic"` \| `"ollama"` | `"anthropic"` | Which backend to use |
| `mode` | `"auto"` \| `"prose"` \| `"code"` | `"auto"` | Completion mode (auto-detects by default) |
| `debounceMs` | number | `300` | Delay before triggering a completion |

### Anthropic

| Setting | Type | Default | Description |
|---|---|---|---|
| `anthropic.apiKey` | string | `""` | API key. Falls back to `~/.creds/api-keys.env` (`ANTHROPIC_API_KEY`) |
| `anthropic.model` | string | `"claude-haiku-4-5-20241022"` | Model ID |
| `anthropic.useCaching` | boolean | `true` | Enable prompt caching |

### Ollama

| Setting | Type | Default | Description |
|---|---|---|---|
| `ollama.endpoint` | string | `"http://localhost:11434"` | Ollama API URL |
| `ollama.model` | string | `"qwen2.5:3b"` | Model name |
| `ollama.raw` | boolean | `true` | Use raw mode (no chat template) |

### Prose Mode

| Setting | Type | Default | Description |
|---|---|---|---|
| `prose.maxTokens` | number | `100` | Max tokens per completion |
| `prose.temperature` | number | `0.7` | Sampling temperature |
| `prose.stopSequences` | string[] | `["\n\n", "---", "##"]` | Stop sequences |
| `prose.contextChars` | number | `2000` | Prefix context window |
| `prose.fileTypes` | string[] | `["markdown", "plaintext"]` | Additional language IDs to treat as prose |

### Code Mode

| Setting | Type | Default | Description |
|---|---|---|---|
| `code.maxTokens` | number | `256` | Max tokens per completion |
| `code.temperature` | number | `0.2` | Sampling temperature |
| `code.stopSequences` | string[] | `["\n\n"]` | Stop sequences |
| `code.contextChars` | number | `4000` | Prefix context window |

## Commands & Keybindings

| Command | Keybinding | Description |
|---|---|---|
| `AI Prose: Trigger Completion` | `Ctrl+L` | Manually trigger a completion |
| `AI Prose: Toggle Enabled` | — | Toggle the extension on/off |
| `AI Prose: Cycle Mode` | Click status bar | Cycle through auto → prose → code |

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

**Raw mode for Ollama.** Base/completion models (like `qwen2.5`) don't have a chat template. Sending `raw: true` bypasses template formatting and sends the prompt directly, which is necessary for completion-style inference.

**No streaming.** Ghost text must be returned as a complete string. Streaming would require incremental rendering, which the VS Code inline completion API doesn't support natively.

**LRU cache with TTL.** Prevents redundant API calls when the user's cursor returns to a previously-completed position. 50 entries, 5-minute TTL.

## Known Issues

Identified during code review (01-28-26). To be addressed in future work.

- **Anthropic prefill stripping may be unnecessary.** The API may not echo the prefill back in the response, in which case the stripping logic in `anthropic.ts` is a no-op. Needs testing against the live API to confirm behavior.
- **Cache key collisions.** The LRU cache keys on the last 500 chars of prefix + first 200 of suffix. Two different cursor positions with the same surrounding text will collide. Consider adding document URI or offset to the key.
- **Ollama raw mode discards system prompts.** When `raw: true`, only the user message is sent — the mode-specific system prompt is built but thrown away. This is intentional for base models but means Ollama completions lack instructional context.
- **No config validation.** Negative `debounceMs`, out-of-range `temperature`, zero `maxTokens`, etc. are not caught. Invalid values pass through to the providers.
- **Console logging instead of output channel.** Errors go to `console.error`, which lands in the developer console most users never open. Should use a `vscode.OutputChannel` for visibility.
- **Non-null assertions in config loading.** `loadConfig()` uses `!` on every `ws.get()` call even though the default parameter guarantees non-null. Noise, not a bug.
- **Status bar doesn't reflect backend availability.** If no Anthropic API key is configured, the status bar still shows "Claude" with no warning indicator.
- **Ollama `raw: false` path is incomplete.** The non-raw path concatenates system + user as plain text and sends it to `/api/generate`. For chat models, it should use `/api/chat` with structured messages instead.

## Future Enhancements

- Token usage tracking / daily budget enforcement
- Predictive pre-caching (prefetch next completion after acceptance)
- Partial acceptance (accept first word with Ctrl+Right, first line with Shift+Tab)
- OpenAI-compatible API provider (covers LM Studio, OpenRouter, etc.)
- Adaptive debounce (shorter delay after accepting a completion)
- Per-workspace mode/backend overrides
- Automated tests
