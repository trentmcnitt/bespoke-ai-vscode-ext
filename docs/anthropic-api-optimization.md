# Anthropic API Optimization for Inline Completions

**Research date:** 2026-01-29
**SDK version tested against:** `@anthropic-ai/sdk` v0.39.0
**Current implementation:** Single `cache_control` breakpoint on the system prompt

---

## Table of Contents

1. [Multi-Breakpoint Caching Strategy](#1-multi-breakpoint-caching-strategy)
2. [Cache TTL Options](#2-cache-ttl-options)
3. [Minimum Cacheable Length](#3-minimum-cacheable-length)
4. [Token Ordering for Cache Hits](#4-token-ordering-for-cache-hits)
5. [Extended Thinking Interaction](#5-extended-thinking-interaction)
6. [Streaming for Perceived Latency](#6-streaming-for-perceived-latency)
7. [Beta Headers and Features](#7-beta-headers-and-features)
8. [Content Block Types](#8-content-block-types)
9. [Batch API](#9-batch-api)
10. [Token Counting](#10-token-counting)
11. [Model-Specific Optimizations](#11-model-specific-optimizations)
12. [Rate Limit Management](#12-rate-limit-management)
13. [Cost Calculations](#13-cost-calculations)
14. [Specific Recommendations for Bespoke AI](#14-specific-recommendations-for-bespoke-ai)

---

## 1. Multi-Breakpoint Caching Strategy

### Key Finding: Up to 4 cache breakpoints are supported

You can place `cache_control: { type: 'ephemeral' }` on up to 4 content blocks. Cache breakpoints themselves add zero cost -- you only pay for actual cache writes and reads.

**Cache hierarchy order:** `tools` -> `system` -> `messages`

Each level builds on the previous. Changing content at one level invalidates that level and all subsequent levels.

### How Automatic Prefix Checking Works

The system uses **backward sequential checking** from each explicit breakpoint:

1. Cache keys are **cumulative** -- the hash for each block includes all preceding blocks.
2. The system checks up to **20 blocks backward** from each explicit `cache_control` breakpoint.
3. It finds the **longest matching prefix** automatically.

This means a single breakpoint at the end of your static content often suffices -- the system will find the longest cached prefix up to 20 blocks back.

### Current Implementation (Single Breakpoint)

```typescript
// Current: only the system prompt is cached
const systemContent: Anthropic.TextBlockParam = {
  type: 'text',
  text: prompt.system,
  cache_control: { type: 'ephemeral' },
};
```

### Proposed Implementation (Dual Breakpoint)

For inline completions, the optimal strategy is **2 breakpoints**:

1. **System prompt** (static per mode) -- cached with `cache_control`
2. **User message** (changes every keystroke) -- cached with `cache_control`

The system prompt is small (~100-200 chars) and will not meet the minimum cacheable length on its own (see Section 3). The user message (2000-4000 chars) is more likely to meet the threshold, and the automatic backward checking means the system prompt will be included in the cached prefix when both are present.

```typescript
// Proposed: cache both system and user message blocks
const systemContent: Anthropic.TextBlockParam = {
  type: 'text',
  text: prompt.system,
  cache_control: { type: 'ephemeral' },
};

// The user message content block, with cache_control
const userContent: Anthropic.TextBlockParam = {
  type: 'text',
  text: prompt.userMessage,
  cache_control: { type: 'ephemeral' },
};

const messages: Anthropic.MessageParam[] = [
  { role: 'user', content: [userContent] },
];

if (prompt.assistantPrefill) {
  messages.push({ role: 'assistant', content: prompt.assistantPrefill });
}

const response = await this.client.messages.create(
  {
    model: this.config.anthropic.model,
    max_tokens: prompt.maxTokens,
    temperature: prompt.temperature,
    stop_sequences: prompt.stopSequences.filter(s => /\S/.test(s)),
    system: [systemContent],
    messages,
  },
  { signal },
);
```

### Why This Helps for Inline Completions

When the user types a character, the prefix grows by ~1 character. The system prompt remains identical. With the user message also marked as a cache breakpoint:

- **First keystroke after 5+ min idle:** Cache miss on both blocks. Cache write for system + user message prefix.
- **Subsequent keystroke (prefix changed by 1 char):** Cache miss on user message (it changed), but the system prompt prefix is automatically found via backward checking from the user message breakpoint. The system prompt tokens are read from cache; only the user message tokens incur a cache write.
- **Same prefix re-requested (e.g., pause then re-trigger):** Full cache hit on both blocks.

**Important caveat:** For the extension's typical prompt sizes (system ~50-100 tokens, user message ~500-1000 tokens), the total is likely **below the minimum cacheable length** for Haiku 4.5 (4096 tokens). See Section 3 for details. Caching only helps when the prefix exceeds these minimums.

---

## 2. Cache TTL Options

### Two TTL Options Available

| TTL | Syntax | Write Cost Multiplier | Read Cost | Refresh Behavior |
|-----|--------|----------------------|-----------|-----------------|
| 5 minutes (default) | `{ type: 'ephemeral' }` or `{ type: 'ephemeral', ttl: '5m' }` | 1.25x base input | 0.1x base input | Free refresh on each use |
| 1 hour | `{ type: 'ephemeral', ttl: '1h' }` | 2.0x base input | 0.1x base input | Free refresh on each use |

### When to Use Each

**5-minute TTL (recommended for inline completions):**
- User is actively typing, so requests occur frequently (every 300ms debounce)
- Cache is continuously refreshed at no cost during active use
- 1.25x write cost is cheaper than 2.0x

**1-hour TTL:**
- Useful if the extension had a feature where the user goes idle for >5 minutes between completions
- Not recommended for the active typing use case

### Mixing TTLs

You can mix TTLs in the same request, but longer TTLs must come before shorter ones:

```typescript
// Valid: 1h system prompt, 5m user message
system: [
  {
    type: 'text',
    text: '...',
    cache_control: { type: 'ephemeral', ttl: '1h' }, // longer TTL first
  },
],
messages: [
  {
    role: 'user',
    content: [{
      type: 'text',
      text: '...',
      cache_control: { type: 'ephemeral', ttl: '5m' }, // shorter TTL second
    }],
  },
],
```

This is an advanced pattern for cases where the system prompt might go stale (user stops typing for 6 minutes) but the user message content could still benefit from 1-hour caching of the system portion. Given the inline completion use case with continuous typing, the standard 5-minute TTL is sufficient.

---

## 3. Minimum Cacheable Length

### Per-Model Minimum Token Counts

| Model | Minimum Cacheable Tokens |
|-------|-------------------------|
| Claude Opus 4.5 | 4,096 tokens |
| Claude Opus 4.1, Opus 4, Sonnet 4.5, Sonnet 4, Sonnet 3.7 | 1,024 tokens |
| Claude Haiku 4.5 | 4,096 tokens |
| Claude Haiku 3.5, Haiku 3 | 2,048 tokens |

### Impact on Bespoke AI

This is the **most critical finding** for the extension:

- **System prompt alone:** ~50-100 tokens (PROSE_SYSTEM is ~80 tokens, CODE_SYSTEM_BASE + filename is ~90 tokens). This is **far below** all minimums. The current system-only caching is effectively doing nothing for most requests.
- **System + user message combined:** ~500-1500 tokens at typical context sizes (2000-4000 chars of prefix). Since ~4 chars = ~1 token, a 2000-char prefix is ~500 tokens. Combined with system = ~600 tokens. Still **below the 1024 minimum** for Sonnet and **well below the 4096 minimum** for Haiku 4.5 and Opus 4.5.
- **To reliably reach 1024 tokens (Sonnet):** Need ~4000 chars of context.
- **To reliably reach 4096 tokens (Haiku 4.5):** Need ~16,000 chars of context.

**Recommendation:** Increase the default `contextChars` settings so the prefix is large enough to benefit from caching:
- For Sonnet: `contextChars >= 4000` (current default may already suffice)
- For Haiku 4.5: `contextChars >= 16000` to benefit from caching, which means expanding `prose.contextChars` and `code.contextChars` significantly

Alternatively, pad the system prompt with additional useful context (e.g., writing style examples, code conventions) to push the total token count above the threshold.

If the total token count is below the minimum, the request is processed normally without caching -- no error occurs, but no cost savings either. You can verify this by checking `cache_creation_input_tokens` and `cache_read_input_tokens` in the response `usage` object.

---

## 4. Token Ordering for Cache Hits

### Principle: Static Content First, Dynamic Content Last

Caching is prefix-based. The system caches everything from the beginning of the prompt up to the breakpoint. Any change earlier in the prompt invalidates the entire cache for that breakpoint and all subsequent ones.

**Cache evaluation order:** `tools` -> `system` -> `messages`

### Can We Put Suffix Before Prefix?

The idea of putting the (more stable) suffix before the (always-changing) prefix in the user message is theoretically sound for caching purposes, but **not recommended** because:

1. It would confuse the model about the document structure.
2. The user message changes entirely every keystroke regardless of ordering.
3. The real win is caching the system prompt, which is already first.

### Optimal Structure for Inline Completions

```
[system prompt: STATIC, cached]  ->  [user message: prefix+suffix, DYNAMIC]
```

The system prompt is already in the ideal position (first). The user message is inherently dynamic. There is no practical reordering that improves cache hits for keystroke-by-keystroke completions.

### Advanced: Splitting the User Message

For code completions with FIM (Fill-in-the-Middle), you could theoretically split the user message into two content blocks:

```typescript
// Hypothetical: cache the suffix separately since it changes less often
const messages: Anthropic.MessageParam[] = [
  {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `File context and suffix:\n${context.suffix}`,
        cache_control: { type: 'ephemeral' }, // Suffix changes less often
      },
      {
        type: 'text',
        text: `Code before cursor:\n${context.prefix}`,
        // No cache_control -- this changes every keystroke
      },
    ],
  },
];
```

**However**, this approach has issues:
- The suffix must come before the prefix in the content array for caching to help, which rearranges the prompt unnaturally.
- The total token count of the suffix alone likely won't meet the minimum cacheable threshold.
- The model may produce worse completions with an unnatural prompt ordering.

**Verdict:** Not worth the quality tradeoff. Keep the natural ordering.

---

## 5. Extended Thinking Interaction

### Disable Extended Thinking for Inline Completions

Extended thinking is irrelevant for inline completions and would dramatically increase latency and cost:

- Minimum thinking budget: 1,024 tokens (all billed as output tokens)
- Thinking tokens are billed at the **output token rate** (5x-15x more expensive than input)
- Adds seconds of latency for internal reasoning

**The extension does not use extended thinking, and should not.** For completeness, here is how to explicitly disable it:

```typescript
const response = await this.client.messages.create({
  model: this.config.anthropic.model,
  max_tokens: prompt.maxTokens,
  thinking: { type: 'disabled' },  // Explicitly disable
  // ... rest of params
});
```

Passing `thinking: { type: 'disabled' }` is optional -- thinking is disabled by default when the parameter is omitted. However, explicitly disabling it documents the intent.

### Cache Invalidation from Thinking

Changes to thinking parameters (enable/disable, budget) invalidate the **messages** portion of the cache but not tools or system. Since the extension never enables thinking, this is not a concern.

---

## 6. Streaming for Perceived Latency

### Recommendation: Use Streaming for Inline Completions

For ghost text completions, streaming is likely **not beneficial** because:

1. **Inline completions are all-or-nothing:** VS Code's `InlineCompletionItem` expects the complete text. You cannot progressively show ghost text as tokens arrive.
2. **Streaming adds overhead:** SSE parsing, connection management, and the SDK creates additional objects.
3. **TTFT benefit is wasted:** The user does not see anything until the full completion is returned.

**Current non-streaming approach is correct:**

```typescript
// This is the right approach for inline completions
const response = await this.client.messages.create({ ... }, { signal });
```

### When Streaming Would Help

If the extension adds a **chat panel** or **commit message generation** feature in the future, streaming would improve perceived latency for those interactive UIs:

```typescript
// For future chat/interactive features only
const stream = this.client.messages.stream({
  model: this.config.anthropic.model,
  max_tokens: prompt.maxTokens,
  system: [systemContent],
  messages,
});

for await (const event of stream) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    // Update UI progressively
    onChunk(event.delta.text);
  }
}
```

### Streaming and Cache Metrics

When streaming, cache performance metrics are available in the `message_start` event rather than the final response:

```typescript
stream.on('message', (message) => {
  console.log(message.usage.cache_read_input_tokens);
  console.log(message.usage.cache_creation_input_tokens);
});
```

---

## 7. Beta Headers and Features

### No Relevant Beta Features for Inline Completions

As of January 2026, the prompt caching feature is **generally available** (GA). It no longer requires the beta prefix:

```typescript
// CORRECT: GA API
client.messages.create({ ... });

// WRONG: Old beta API (will error)
// client.beta.promptCaching.messages.create({ ... });
```

### Potentially Relevant Beta: 1M Context Window

For Claude Sonnet 4 and Sonnet 4.5, a 1M token context window is available via beta header `context-1m-2025-08-07`. This is **not relevant** for inline completions (our context is tiny by comparison), but could be useful for future features processing entire codebases.

### Effort Parameter (Not a Beta, but New)

Anthropic introduced an `effort` parameter with Claude Opus 4.5 that affects thinking, text responses, and function calls. It defaults to `high` and can be set to `medium` or `low` to reduce latency:

```typescript
// Potential latency reduction for completions
const response = await this.client.messages.create({
  model: 'claude-opus-4-5',
  max_tokens: prompt.maxTokens,
  // Note: Check SDK support -- this may require a newer SDK version
  // or passing via extra body params
  system: [systemContent],
  messages,
});
```

**Status:** Needs further investigation for SDK v0.39.0 compatibility. This is primarily useful if the extension is configured with Opus models (unlikely for inline completions due to cost/latency).

---

## 8. Content Block Types

### Relevant Block Types for Inline Completions

Only `text` blocks are relevant for our use case:

```typescript
// System: text block with cache_control
const systemContent: Anthropic.TextBlockParam = {
  type: 'text',
  text: prompt.system,
  cache_control: { type: 'ephemeral' },
};

// User message: text block (optionally with cache_control)
const userContent: Anthropic.TextBlockParam = {
  type: 'text',
  text: prompt.userMessage,
};
```

### Not Relevant for This Use Case

- `tool_use` / `tool_result`: For tool-calling workflows (future commit message feature could use this)
- `image`: For vision features (not applicable)
- `document`: For PDF/document analysis (not applicable)
- `search_result`: For web search tool (not applicable)
- `thinking`: Extended thinking blocks (explicitly not wanted)

---

## 9. Batch API

### Relevant for Future Non-Realtime Features

The Batch API offers a **flat 50% discount** on all token costs and is ideal for non-time-sensitive operations.

| Model | Standard Input | Batch Input | Standard Output | Batch Output |
|-------|---------------|-------------|-----------------|-------------|
| Haiku 4.5 | $1/MTok | $0.50/MTok | $5/MTok | $2.50/MTok |
| Sonnet 4.5 | $3/MTok | $1.50/MTok | $15/MTok | $7.50/MTok |

### Use Case: Commit Message Generation

The planned commit message generation feature (from CLAUDE.md's Future Direction) would be a perfect candidate:

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

// Create a batch for processing multiple diffs
const batch = await client.messages.batches.create({
  requests: [
    {
      custom_id: 'commit-msg-1',
      params: {
        model: 'claude-haiku-4-5',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `Generate a concise commit message for this diff:\n\n${diff}`,
        }],
      },
    },
  ],
});

// Poll for results (async, can take up to 24 hours but usually minutes)
const results = await client.messages.batches.results(batch.id);
for await (const entry of results) {
  if (entry.result.type === 'succeeded') {
    console.log(entry.result.message.content);
  }
}
```

### Not Suitable for Inline Completions

Batch API is asynchronous and not suitable for real-time ghost text. Responses can take minutes to hours.

### Caching + Batch API

You can combine prompt caching with the Batch API, but cache hits are best-effort since batch requests process in arbitrary order. The 1-hour TTL improves hit rates for batch workloads.

---

## 10. Token Counting

### API Endpoint

```
POST /v1/messages/count_tokens
```

### SDK Usage

```typescript
const count = await client.messages.countTokens({
  model: 'claude-haiku-4-5',
  system: [{ type: 'text', text: prompt.system }],
  messages: [{ role: 'user', content: prompt.userMessage }],
});

console.log(count.input_tokens); // Exact token count
```

### Use Cases for Inline Completions

1. **Determine if caching will work:** Pre-check if the prompt meets the minimum cacheable token count for the selected model:

```typescript
// Check if prompt is large enough to benefit from caching
async function shouldEnableCaching(
  client: Anthropic,
  model: string,
  systemText: string,
  userMessage: string,
): Promise<boolean> {
  const minimums: Record<string, number> = {
    'claude-haiku-4-5': 4096,
    'claude-sonnet-4-5': 1024,
    'claude-sonnet-4': 1024,
    'claude-opus-4-5': 4096,
    // Add others as needed
  };

  const minTokens = minimums[model] ?? 1024;

  const count = await client.messages.countTokens({
    model,
    system: [{ type: 'text', text: systemText }],
    messages: [{ role: 'user', content: userMessage }],
  });

  return count.input_tokens >= minTokens;
}
```

2. **Budget monitoring:** Track token consumption over time.
3. **Context window optimization:** Ensure the prefix + suffix fit comfortably.

### Cost Warning

The `countTokens` endpoint itself makes an API call. **Do not call it on every keystroke.** It adds latency and is subject to rate limits. Use it for:
- One-time calibration at startup
- Periodic monitoring
- Development/debugging

### Approximation Alternative

For rough estimates without an API call, use ~4 characters per token. This is accurate enough for deciding whether to enable caching.

---

## 11. Model-Specific Optimizations

### Claude Haiku 4.5 (Default for Bespoke AI)

- **Fastest model:** 4-5x faster than Sonnet 4.5
- **Cheapest:** $1/MTok input, $5/MTok output
- **Minimum cacheable tokens:** 4,096 (highest -- problematic for our use case)
- **Cache-aware ITPM:** Only uncached input tokens count toward rate limits
- **Extended thinking available** but should NOT be used for completions
- **Recommendation:** Best choice for inline completions due to speed. Caching only helps with large context windows (16K+ chars).

### Claude Sonnet 4.5

- **Balanced performance:** Slower than Haiku but higher quality
- **Minimum cacheable tokens:** 1,024 (more achievable)
- **Best for:** Users who want higher quality and have sufficient context (4K+ chars)
- **Recommendation:** Good alternative when users prioritize quality over speed. Caching is more likely to be effective.

### Claude Opus 4.5

- **Highest capability:** But also highest latency
- **Minimum cacheable tokens:** 4,096
- **Cost:** $5/MTok input, $25/MTok output
- **Recommendation:** Not recommended for inline completions due to latency (4-8s typical). Could be offered as a profile option for users who want maximum quality and can tolerate delay.

### Rate Limit Comparison (Tier 4)

| Model | RPM | ITPM | OTPM |
|-------|-----|------|------|
| Haiku 4.5 | 4,000 | 4,000,000 | 800,000 |
| Sonnet 4.x | 4,000 | 2,000,000 | 400,000 |
| Opus 4.x | 4,000 | 2,000,000 | 400,000 |

Haiku 4.5 has 2x the token throughput of Sonnet/Opus, making it even more suitable for high-frequency autocomplete requests.

---

## 12. Rate Limit Management

### How Rate Limits Work

Anthropic uses a **token bucket algorithm** -- capacity continuously replenishes up to the maximum, rather than resetting at fixed intervals. Three dimensions:

1. **RPM** (Requests Per Minute)
2. **ITPM** (Input Tokens Per Minute) -- only **uncached** tokens count for most models
3. **OTPM** (Output Tokens Per Minute)

### Critical: Cached Tokens and Rate Limits

For Haiku 4.5, Sonnet 4.x, and Opus 4.x: **cached read tokens do NOT count toward ITPM.**

This means effective throughput with caching can be dramatically higher:

```
Example: 2,000,000 ITPM limit + 80% cache hit rate
Effective throughput: 10,000,000 total input tokens/min
(2M uncached + 8M cached, where cached tokens are free of rate limits)
```

This is a strong reason to maximize cache hit rates even when the direct cost savings are modest.

### Response Headers to Monitor

```typescript
// Key headers returned with every response
const headers = {
  'retry-after': 'seconds to wait on 429',
  'anthropic-ratelimit-requests-remaining': 'RPM headroom',
  'anthropic-ratelimit-input-tokens-remaining': 'ITPM headroom',
  'anthropic-ratelimit-output-tokens-remaining': 'OTPM headroom',
  'anthropic-ratelimit-requests-reset': 'RFC 3339 timestamp',
};
```

### Recommended 429 Handling for Autocomplete

The current implementation catches `APIError` and returns `null`. This is correct, but can be enhanced:

```typescript
// Enhanced error handling with rate limit awareness
if (err instanceof Anthropic.APIError) {
  if (err.status === 429) {
    // Rate limited -- suppress silently for autocomplete (don't spam user)
    // Optionally extract retry-after for adaptive debouncing
    const retryAfter = err.headers?.['retry-after'];
    if (retryAfter) {
      this.logger.debug(`Rate limited, retry after ${retryAfter}s`);
      // Could increase debounce interval temporarily
    }
    return null;
  }
  if (err.status === 529) {
    // Server overloaded -- not our fault, transient
    this.logger.debug('Anthropic server overloaded (529), will retry on next keystroke');
    return null;
  }
  this.logger.error(`Anthropic API error: ${err.status} ${err.message}`);
  return null;
}
```

### Best Practices for Autocomplete

1. **Do NOT implement retry with backoff for autocomplete.** The user's next keystroke will naturally trigger a new request. Retrying the stale request wastes tokens on an outdated prefix.

2. **Adaptive debouncing:** If rate limits are being hit, temporarily increase the debounce interval:
   ```typescript
   // Pseudocode for adaptive debounce
   let debounceMs = 300; // default
   if (rateLimitedRecently) {
     debounceMs = Math.min(debounceMs * 2, 2000); // back off up to 2s
   }
   ```

3. **Reduce `max_tokens` for OTPM limits:** If hitting output token limits, reduce `max_tokens` to be closer to expected output size. For inline completions, 50-150 tokens is usually sufficient.

4. **Ramp up gradually:** Avoid burst patterns when the extension first activates. The API has acceleration limits that can trigger 429s even within overall rate limits.

---

## 13. Cost Calculations

### Baseline: No Caching (Current Effective State)

With the system prompt below the minimum cacheable token count, caching has no effect. All tokens are billed as standard input:

| Model | Typical Request (800 input tokens, 50 output tokens) | Cost per Request |
|-------|-----------------------------------------------------|-----------------|
| Haiku 4.5 | 800 * $1/MTok + 50 * $5/MTok | $0.001050 |
| Sonnet 4.5 | 800 * $3/MTok + 50 * $15/MTok | $0.003150 |

**Cost per 1000 completions:**
- Haiku 4.5: **$1.05**
- Sonnet 4.5: **$3.15**

### With Effective Caching (Larger Context, Meeting Minimums)

Assuming 2000 input tokens total, 80% cache hit rate:

**Cache hit request (80% of requests):**
| Model | Cached Read (2000 tokens) | Output (50 tokens) | Cost |
|-------|--------------------------|--------------------|----|
| Haiku 4.5 | 2000 * $0.10/MTok | 50 * $5/MTok | $0.000450 |
| Sonnet 4.5 | 2000 * $0.30/MTok | 50 * $15/MTok | $0.001350 |

**Cache write request (20% of requests):**
| Model | Cache Write (2000 tokens) | Output (50 tokens) | Cost |
|-------|--------------------------|--------------------|----|
| Haiku 4.5 | 2000 * $1.25/MTok | 50 * $5/MTok | $0.002750 |
| Sonnet 4.5 | 2000 * $3.75/MTok | 50 * $15/MTok | $0.008250 |

**Weighted average per request:**
- Haiku 4.5: 0.8 * $0.000450 + 0.2 * $0.002750 = **$0.000910** (13% savings vs no caching)
- Sonnet 4.5: 0.8 * $0.001350 + 0.2 * $0.008250 = **$0.002730** (13% savings)

**With 95% cache hit rate (sustained typing):**
- Haiku 4.5: 0.95 * $0.000450 + 0.05 * $0.002750 = **$0.000565** (46% savings)
- Sonnet 4.5: 0.95 * $0.001350 + 0.05 * $0.008250 = **$0.001695** (46% savings)

### The Real Win: Rate Limit Throughput

Even when dollar savings are modest, cached tokens do not count toward ITPM rate limits. With 95% cache hit rate, effective throughput increases by **20x** for cached content.

### Batch API Savings for Future Features

| Feature | Standard Cost (Haiku 4.5, 2000 input + 200 output) | Batch Cost | Savings |
|---------|---------------------------------------------------|-----------|---------|
| Commit messages | $0.003 per message | $0.0015 per message | 50% |

---

## 14. Specific Recommendations for Bespoke AI

### Priority 1: Fix the Minimum Token Threshold Issue

The current single-breakpoint caching on the system prompt (~80 tokens) is **below the minimum for all models**. Options:

**Option A: Increase default context sizes**
- Set `prose.contextChars` default to at least 5000 (ensures ~1250 tokens, enough for Sonnet)
- Set `code.contextChars` default to at least 5000
- For Haiku 4.5, ~16000 chars are needed (may not always be available)

**Option B: Pad the system prompt with useful context**
- Add style/convention examples to push system prompt above 4096 tokens
- Not recommended -- wastes tokens when caching fails

**Option C: Smart caching toggle**
- Check total input token count (approximate: `text.length / 4`)
- Only add `cache_control` when the total exceeds the model's minimum
- Log when caching is skipped so the user knows

```typescript
// Recommended: smart caching based on estimated token count
const estimatedTokens = Math.ceil(
  (prompt.system.length + prompt.userMessage.length) / 4
);

const minimumCacheableTokens = model.includes('haiku-4-5') || model.includes('opus-4-5')
  ? 4096
  : 1024;

const useCaching = this.config.anthropic.useCaching && estimatedTokens >= minimumCacheableTokens;

if (useCaching) {
  (systemContent as any).cache_control = { type: 'ephemeral' };
}
```

### Priority 2: Add Cache Performance Logging

The current logging reads `cache_read_input_tokens` and `cache_creation_input_tokens` -- this is good. Enhance it to calculate and log the effective savings:

```typescript
if (response.usage) {
  const usage = response.usage as any;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const uncached = usage.input_tokens ?? 0;

  const totalInput = cacheRead + cacheWrite + uncached;
  const cacheHitRate = totalInput > 0 ? (cacheRead / totalInput * 100).toFixed(1) : '0.0';

  this.logger.debug(
    `Anthropic usage: input=${uncached} output=${usage.output_tokens} ` +
    `cache_read=${cacheRead} cache_write=${cacheWrite} ` +
    `hit_rate=${cacheHitRate}% stop=${response.stop_reason}`
  );
}
```

### Priority 3: Differentiate 429 vs 529 Errors

Currently all API errors are logged the same way. Distinguish rate limits (user's responsibility) from server overload (transient):

```typescript
if (err instanceof Anthropic.APIError) {
  if (err.status === 429) {
    this.logger.debug(`Rate limited: ${err.message}`);
  } else if (err.status === 529) {
    this.logger.debug(`Server overloaded (529), transient`);
  } else {
    this.logger.error(`Anthropic API error: ${err.status} ${err.message}`);
  }
  return null;
}
```

### Priority 4: Do Not Add Streaming

The current non-streaming `messages.create()` approach is correct for inline completions. VS Code's `InlineCompletionItem` requires the complete text upfront.

### Priority 5: Do Not Enable Extended Thinking

Extended thinking adds latency and cost with no benefit for short completions. The current approach of omitting the `thinking` parameter (defaults to disabled) is correct.

### Priority 6: Consider Token Counting for Development

Add a development/debug utility that uses `client.messages.countTokens()` to verify assumptions about prompt sizes:

```typescript
// Debug utility -- not for production per-request use
async debugTokenCount(): Promise<void> {
  if (!this.client) return;
  const count = await this.client.messages.countTokens({
    model: this.config.anthropic.model,
    system: [{ type: 'text', text: PROSE_SYSTEM }],
    messages: [{ role: 'user', content: 'Sample text...' }],
  });
  this.logger.info(`Token count for current prompt structure: ${count.input_tokens}`);
}
```

### Summary Table

| Optimization | Impact | Effort | Recommendation |
|-------------|--------|--------|---------------|
| Fix minimum token threshold | High (enable caching to work) | Low | Do first |
| Smart caching toggle by model | Medium (avoid wasted cache writes) | Low | Do second |
| Enhanced cache performance logging | Low (observability) | Low | Do third |
| Differentiate 429/529 errors | Low (better debugging) | Low | Do fourth |
| Increase default context sizes | Medium (more cache hits) | Low | Consider |
| Streaming | None for inline completions | N/A | Do not do |
| Extended thinking | Negative (adds cost/latency) | N/A | Do not do |
| Batch API | High for future features | Medium | When commit msg feature ships |
| 1-hour TTL | Low for active typing | Low | Not needed yet |
| Multiple breakpoints | Low (given prompt sizes) | Medium | Not needed yet |

---

## Sources

- [Prompt Caching - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Pricing - Claude API Docs](https://platform.claude.com/docs/en/about-claude/pricing)
- [Rate Limits - Claude API Docs](https://platform.claude.com/docs/en/api/rate-limits)
- [Count Tokens API Reference](https://platform.claude.com/docs/en/api/messages-count-tokens)
- [Reducing Latency - Claude API Docs](https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-latency)
- [Streaming Messages - Claude API Docs](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Models Overview - Claude API Docs](https://platform.claude.com/docs/en/about-claude/models/overview)
- [Anthropic SDK TypeScript - GitHub](https://github.com/anthropics/anthropic-sdk-typescript)
