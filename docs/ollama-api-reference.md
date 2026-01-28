# Ollama API Reference

Reference for using the Ollama HTTP API in this extension. Covers `/api/generate` (our primary endpoint), raw mode vs templated mode, FIM support, performance tuning, and error handling.

Last verified: 01-28-26 against Ollama with Qwen2.5-Coder models.

---

## How to Access the Docs

**Official documentation:**
- API docs (GitHub): https://github.com/ollama/ollama/blob/main/docs/api.md
- API docs (site): https://docs.ollama.com/api/generate
- Error handling: https://docs.ollama.com/api/errors
- FAQ: https://docs.ollama.com/faq
- Model library: https://ollama.com/library

**Best tools for reviewing:**
- `WebFetch` against the GitHub raw docs works well: `https://github.com/ollama/ollama/blob/main/docs/api.md`
- The official site docs at `docs.ollama.com` are the same content in a nicer format.
- For model-specific template details (FIM tokens, etc.), check the model page on `ollama.com/library/{model}` or use `ollama show {model} --template` locally.
- Context7 has Ollama docs available but the GitHub source is more complete for API details.
- For FIM specifics, the GitHub issues are the best source: https://github.com/ollama/ollama/issues/3869 (original FIM feature request, closed/completed).

**Supplementary resources:**
- DeepWiki for ollama-js FIM: https://deepwiki.com/ollama/ollama-js/5.4-fill-in-middle-generation
- KV cache quantization: https://smcleod.net/2024/12/bringing-k/v-context-quantisation-to-ollama/
- Ollama VS Code integrations: https://docs.ollama.com/integrations/vscode

---

## Endpoint Selection

| Endpoint | Purpose | Used in Extension |
|---|---|---|
| `POST /api/generate` | Text generation / completion / FIM | Yes (primary) |
| `POST /api/chat` | Conversational multi-turn with roles | No (future chat panel) |
| `GET /api/tags` | List available models | Yes (availability check in tests) |
| `POST /api/show` | Model details / template inspection | No (useful for debugging) |
| `GET /` or `GET /api/version` | Health check | No (could add) |

**Use `/api/generate` for inline completions.** It supports `raw` mode, the `suffix` parameter for FIM, and direct text continuation. `/api/chat` is for conversational features and does not support FIM.

---

## `/api/generate` Parameters

### Core Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `model` | string | Yes | -- | Model name (e.g., `qwen2.5:3b`) |
| `prompt` | string | No | -- | Input text (prefix for FIM) |
| `suffix` | string | No | -- | Text after cursor (for FIM). Ollama inserts via `{{ .Suffix }}` in the model template |
| `system` | string | No | -- | System message. Overrides Modelfile SYSTEM. **Ignored when `raw: true`** |
| `template` | string | No | -- | Custom Go template. Overrides Modelfile TEMPLATE. **Ignored when `raw: true`** |
| `raw` | boolean | No | `false` | Send prompt directly, bypass all template processing |
| `stream` | boolean | No | `true` | Stream response as NDJSON |
| `keep_alive` | string/number | No | `"5m"` | How long to keep model loaded after request |
| `format` | string/object | No | -- | `"json"` or a JSON schema for structured output |
| `images` | array | No | -- | Base64-encoded images for multimodal models |

### `options` Object

```json
{
  "options": {
    "num_predict": 128,
    "temperature": 0.2,
    "top_k": 40,
    "top_p": 0.9,
    "min_p": 0.0,
    "seed": 42,
    "num_ctx": 2048,
    "stop": ["\n\n", "<|endoftext|>"],
    "repeat_penalty": 1.1
  }
}
```

**`num_predict` (max tokens):**
- Default: `-1` (generate until stop token or EOS, capped at `10 * num_ctx`)
- `-2` = fill entire context window
- Always set explicitly for inline completions (64-256 range)

**`num_ctx` (context window):**
- Default: 2048
- Larger = more memory. Exceeding it causes reprocessing (slow)

**`stop` (stop sequences):**
- Array of strings. Generation halts at first match.
- Stop sequence is NOT included in output.
- Unlike Anthropic, `"\n\n"` works fine here.

---

## Raw Mode vs Templated Mode

This is the most important distinction for this extension.

### `raw: true`

Sends the `prompt` string byte-for-byte to the model. No template, no special tokens, no formatting.

**Ignores:** `system`, `template`, `suffix` parameters (all silently dropped).

**Use for:**
- Base/completion models that have no chat template
- Prose continuation where you want the model to directly continue text
- Manual FIM when you construct the special tokens yourself

```json
{
  "model": "qwen2.5:3b",
  "prompt": "The quick brown fox jumped over the",
  "raw": true,
  "stream": false,
  "options": { "num_predict": 100 }
}
```

### `raw: false` (default)

Ollama wraps your prompt using the model's built-in template. Template variables:
- `{{ .System }}` -- system message
- `{{ .Prompt }}` -- user prompt
- `{{ .Suffix }}` -- suffix for FIM (if template supports it)

**Use for:**
- Code FIM with the `suffix` parameter (Ollama handles model-specific FIM tokens)
- Instruct/chat models where you want proper instruction framing
- Any case where you want `system` or `suffix` to take effect

```json
{
  "model": "qwen2.5-coder:3b",
  "prompt": "def fibonacci(n):\n    ",
  "suffix": "    return result\n",
  "system": "Complete the code at the cursor position.",
  "stream": false,
  "options": { "num_predict": 128, "temperature": 0.2 }
}
```

### How This Extension Uses Both Modes

| Scenario | `raw` | Why |
|---|---|---|
| Prose continuation | `true` | Direct text continuation, no chat template interference |
| Code with suffix (FIM) | `false` | Ollama handles FIM token formatting per-model |
| Code without suffix | User's `raw` setting | Follows config default |

---

## Fill-in-Middle (FIM)

FIM lets the model generate text that bridges a prefix and suffix -- the core of cursor-position code completion.

### How Ollama Handles FIM

1. You send `prompt` (prefix) and `suffix` (text after cursor)
2. Ollama checks the model's template for `{{ .Suffix }}`
3. If present, the template wraps the prompt with model-specific FIM tokens
4. The model generates the infill

### Qwen2.5-Coder FIM Tokens

The template automatically formats as:
```
<|fim_prefix|>{prompt}<|fim_suffix|>{suffix}<|fim_middle|>
```

Other token types:
- `<|fim_pad|>` -- padding
- `<|repo_name|>` -- repository context
- `<|file_sep|>` -- file separator
- `<|endoftext|>` -- end of text

### Models with FIM Support

Models whose template includes `{{ .Suffix }}`:
- `qwen2.5-coder` (all sizes, base and instruct)
- `codellama` (uses `<PRE>`, `<SUF>`, `<MID>` tokens)
- `starcoder2`
- `deepseek-coder-v2`
- `codegemma`

If a model's template lacks `{{ .Suffix }}`, the `suffix` parameter is silently ignored.

**Check a model's template:** `ollama show {model} --template`

### Important: Do NOT Use `raw: true` with `suffix`

`raw: true` ignores the `suffix` parameter entirely. Either:
- Use `raw: false` and let Ollama handle FIM formatting (recommended)
- Use `raw: true` and manually embed FIM tokens in the `prompt` string (fragile, model-specific)

---

## Response Format

### Non-Streaming (`stream: false`)

```json
{
  "model": "qwen2.5-coder:3b",
  "created_at": "2024-01-01T00:00:00Z",
  "response": "if n <= 1:\n        return n\n    a, b = 0, 1",
  "done": true,
  "done_reason": "stop",
  "total_duration": 1234567890,
  "load_duration": 234567890,
  "prompt_eval_count": 25,
  "prompt_eval_duration": 345678901,
  "eval_count": 42,
  "eval_duration": 456789012
}
```

- `done_reason`: `"stop"` (hit stop sequence or EOS) or `"length"` (hit `num_predict`)
- All durations are in **nanoseconds**
- Tokens/sec: `eval_count / eval_duration * 1e9`

### Streaming (`stream: true`)

NDJSON, one JSON object per line:
```json
{"model":"...","response":"if","done":false}
{"model":"...","response":" n","done":false}
{"model":"...","response":"","done":true,"done_reason":"stop","total_duration":...}
```

Final chunk has `done: true` with timing metrics. Intermediate chunks have the token(s) in `response`.

**For this extension:** We use `stream: false`. VS Code's `InlineCompletionItemProvider` needs a complete string.

---

## Error Handling

### HTTP Status Codes

| Code | Meaning |
|---|---|
| 200 | Success |
| 400 | Invalid parameters / malformed JSON |
| 404 | Model not found (not pulled) |
| 429 | Rate limit exceeded |
| 500 | Internal server error |

### Error Response

```json
{"error": "model 'nonexistent:latest' not found, try pulling it first"}
```

### Common Failure Scenarios

**Server not running:**
- `fetch` throws `ECONNREFUSED` -- no HTTP response at all
- Handle as a network error, return null

**Model not pulled:**
- HTTP 404 with `{"error": "model '...' not found, try pulling it first"}`

**Request aborted:**
- Client closes connection via `AbortController.abort()`
- Ollama stops generation immediately, handles gracefully server-side
- KV cache from the partial generation is preserved for reuse

**Streaming errors:**
- Mid-stream errors appear as `{"error": "..."}` in the NDJSON stream
- HTTP status is still 200 -- must check each chunk for `error` field

---

## Performance Optimization

### `keep_alive`

Controls how long the model stays loaded in GPU/CPU memory after a request.

| Value | Behavior |
|---|---|
| `"5m"` (default) | Unload after 5 minutes idle |
| `"30m"` | Keep loaded 30 minutes |
| `"-1"` | Keep loaded indefinitely (until Ollama restarts) |
| `"0"` | Unload immediately after response |

**In this extension:** We send `keep_alive: "30m"` on every request. Model loading takes 5-15 seconds; keeping it loaded eliminates this latency entirely during active editing sessions.

### KV Cache Reuse

Ollama (via llama.cpp) automatically caches the KV state for recent prompts:
- Consecutive requests sharing a **common prefix** reuse the cached KV state for those tokens
- Prompt evaluation is nearly instant for the shared prefix portion
- Cache persists as long as the model is loaded (`keep_alive`)
- This means editing in the same file with a stable prefix is very fast

### Recommended Environment Variables for Users

```bash
OLLAMA_KEEP_ALIVE=-1          # Never unload models
OLLAMA_FLASH_ATTENTION=1       # Enable Flash Attention
OLLAMA_KV_CACHE_TYPE=q8_0      # Reduce KV cache memory ~50%
OLLAMA_NUM_PARALLEL=1          # Single-user optimization (VS Code extension)
```

---

## `/api/chat` Endpoint (Not Currently Used)

For future chat panel features. Key differences from `/api/generate`:

| Feature | `/api/generate` | `/api/chat` |
|---|---|---|
| Input | Single `prompt` string | `messages` array with roles |
| FIM | Yes (`suffix` param) | No |
| `raw` mode | Yes | No |
| Tool calling | No | Yes |
| System prompt | `system` param | `role: "system"` message |

```json
{
  "model": "qwen2.5-coder:3b",
  "messages": [
    { "role": "system", "content": "You are a code assistant." },
    { "role": "user", "content": "Explain this function..." }
  ],
  "stream": false
}
```

Response uses `message.content` instead of `response`:
```json
{
  "message": { "role": "assistant", "content": "This function..." },
  "done": true
}
```
