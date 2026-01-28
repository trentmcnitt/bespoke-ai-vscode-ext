# Anthropic SDK Reference

Reference for using the Anthropic TypeScript SDK (`@anthropic-ai/sdk`) in this extension. Covers the behaviors, constraints, and gotchas specific to inline completion use cases.

Last verified: 01-28-26 against SDK v0.39.x and Claude Haiku 4.5.

---

## How to Access the Docs

**Official documentation:**
- Anthropic Docs (platform): https://platform.claude.com/docs/en/
- API Reference: https://docs.anthropic.com/en/api/messages
- TypeScript SDK repo: https://github.com/anthropics/anthropic-sdk-typescript

**Best tools for reviewing:**
- Context7 works well for the SDK. Use library ID `/anthropics/anthropic-sdk-typescript` with `query-docs`.
- The SDK README on GitHub (`README.md`, `helpers.md`, `api.md`) is comprehensive and up-to-date.
- For API behavior (not SDK-specific), `WebFetch` against `https://platform.claude.com/docs/en/build-with-claude/...` paths works reliably.
- The API changelog is at https://docs.anthropic.com/en/api/changelog -- check when behaviors seem to have changed.

**Key doc pages for this extension:**
- Prefill: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prefill-claudes-response
- Prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Messages API: https://docs.anthropic.com/en/api/messages
- Messages examples (prefill): https://docs.anthropic.com/en/api/messages-examples

---

## Prefill Behavior

The assistant prefill feature seeds the model's response by providing the beginning of the assistant message. This forces the model to continue from that point rather than starting fresh.

**The API response does NOT include the prefill text.** It returns only the continuation after the prefill.

Example:
```typescript
messages: [
  { role: "user", content: "Continue this text naturally." },
  { role: "assistant", content: "the lazy dog" }  // prefill
]
// Response: " jumped over the fence and ran into the woods."
// NOT: "the lazy dog jumped over the fence..."
```

**Constraints:**
- Prefill content must not end with trailing whitespace. `"the lazy dog "` (trailing space) causes a 400 error.
- The response may start with a space (natural token boundary). Do not strip it -- it's part of the intended output.

**In this extension:** We use prefill for prose mode, seeding the assistant with the last 4 words of the user's text. Since the API doesn't echo prefill back, no stripping is needed -- just return the response as-is.

---

## Stop Sequences

**Every stop sequence must contain at least one non-whitespace character.**

The API rejects with a 400 error:
- `"\n"`, `"\n\n"`, `" "`, `"\t"` -- all whitespace-only

The API accepts:
- `"---"`, `"##"`, `"\n\nHuman:"` -- contain non-whitespace chars

**Implication for this extension:** Our default prose stop sequences include `"\n\n"`, which Anthropic will always reject. We filter them out before sending:

```typescript
stop_sequences: prompt.stopSequences.filter(s => /\S/.test(s))
```

To still respect paragraph breaks, we post-process the response by truncating at the first `\n\n`:

```typescript
const idx = result.indexOf('\n\n');
return idx >= 0 ? result.slice(0, idx) : result;
```

---

## Prompt Caching

System prompts can be cached to avoid re-processing on every request within a 5-minute window.

**How it works:**
- Add `cache_control: { type: "ephemeral" }` to the system content block.
- System must be passed as an array of content blocks (not a plain string).
- No beta header required (was removed in late 2024).

```typescript
const systemContent = {
  type: 'text',
  text: prompt.system,
  cache_control: { type: 'ephemeral' },  // SDK types need a cast for this
};

await client.messages.create({
  system: [systemContent],
  // ...
});
```

**Key constraints:**
| Detail | Value |
|---|---|
| Minimum cached prefix | 1,024 tokens (Haiku/Sonnet) |
| Cache TTL | 5 minutes (1 hour with `anthropic-beta: extended-cache-ttl-2025-04-11`) |
| Cache write cost | 1.25x base input price |
| Cache read cost | 0.1x base input price |
| Processing order | Tools > System > Messages |

**For this extension:** Our system prompts are ~50 tokens, well under the 1,024 minimum. Caching likely never activates. The `cache_control` header is harmless but ineffective unless we significantly enrich the system prompt. This is documented as a known issue.

---

## Client Configuration

```typescript
const client = new Anthropic({
  apiKey: 'sk-ant-...',
  timeout: 30_000,    // 30s (default is 10 MINUTES)
  maxRetries: 2,      // default; retries on 429, 5xx, connection errors
});
```

**Timeout:** The SDK default is 10 minutes. For longer `max_tokens` values without streaming, it calculates a dynamic timeout: `(60 * 60 * maxTokens) / 128_000` (min 10 min, max 60 min). For inline completions where we want sub-second responses, 30 seconds is appropriate.

**Auto-retry:** The SDK automatically retries on:
- Connection errors
- HTTP 408 (Request Timeout)
- HTTP 409 (Conflict)
- HTTP 429 (Rate Limit)
- HTTP 5xx (Server errors, including 529 overloaded)

Retry uses exponential backoff. Default is 2 retries. For inline completions this is fine -- the user's typing will cancel stale requests anyway.

---

## AbortSignal / Cancellation

Pass `signal` as a request option:

```typescript
const response = await client.messages.create(
  { model, max_tokens, system, messages },
  { signal }  // AbortSignal from AbortController
);
```

**Behavior:**
- Aborts the underlying fetch request immediately.
- Throws `Anthropic.APIUserAbortError` (a subclass of `APIError`).
- For streams, also works via `stream.abort()` or `break` from a `for await` loop.

**In this extension:** The debouncer creates an `AbortController` per cycle and passes the signal through. On new keystrokes, the previous controller is aborted, canceling the in-flight request.

---

## Error Classes

The SDK provides typed error subclasses for granular handling:

| HTTP Status | Error Class | Typical Cause |
|---|---|---|
| 400 | `BadRequestError` | Invalid params (bad stop sequence, trailing whitespace in prefill) |
| 401 | `AuthenticationError` | Invalid or missing API key |
| 403 | `PermissionDeniedError` | Key lacks permissions |
| 404 | `NotFoundError` | Invalid model name |
| 422 | `UnprocessableEntityError` | Semantically invalid request |
| 429 | `RateLimitError` | Rate limit or overloaded |
| >= 500 | `InternalServerError` | Server error (includes 529 overloaded) |
| N/A | `APIConnectionError` | Network failure, DNS, timeout |
| N/A | `APIUserAbortError` | Request aborted via signal |

All are subclasses of `Anthropic.APIError` and can be imported from the SDK:

```typescript
import Anthropic from '@anthropic-ai/sdk';

if (err instanceof Anthropic.APIUserAbortError) { /* cancelled */ }
if (err instanceof Anthropic.RateLimitError) { /* back off */ }
if (err instanceof Anthropic.AuthenticationError) { /* bad key */ }
```

---

## Model Selection

**Claude Haiku 4.5 (`claude-haiku-4-5-20251001`) is correct for inline completions.**

| Factor | Haiku 4.5 | Sonnet 4.5 |
|---|---|---|
| Speed | ~4-5x faster | Baseline |
| TTFT | ~0.36s | ~0.64s |
| Cost (input / output per 1M) | $1 / $5 | $3 / $15 |
| Coding quality | ~90% of Sonnet | Baseline |

Latency matters most for ghost text suggestions. Haiku's sub-400ms TTFT keeps the experience responsive.

---

## Streaming (Not Currently Used)

The extension uses non-streaming mode because VS Code's `InlineCompletionItemProvider` expects a complete string. For reference, the SDK supports two streaming approaches:

**`messages.stream()` -- higher-level helper:**
```typescript
const stream = client.messages.stream({ model, max_tokens, messages });
for await (const event of stream) {
  if (event.type === 'text') { /* event.text */ }
}
```

**`messages.create({ stream: true })` -- lower-level, less memory:**
```typescript
const response = await client.messages.create({ ..., stream: true });
for await (const event of response) {
  if (event.type === 'content_block_delta') { /* event.delta.text */ }
}
```

Streaming would only be useful if we add a chat panel feature in the future.

---

## Token Efficiency Notes

- **Prefill** provides immediate context cheaply (last 4 words, ~4 tokens).
- **Context window limits** (2000 chars prose, 4000 chars code) keep input tokens reasonable.
- **System prompts** should stay concise -- every token counts at completion-trigger frequency.
- **Prompt caching** would help if the system prompt crosses 1,024 tokens. Currently ours doesn't.
- **`max_tokens`** is set low (100 prose, 256 code) to keep responses short and fast.
