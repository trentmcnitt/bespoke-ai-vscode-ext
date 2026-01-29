# Oracle Prototype Dev Log

**Started:** 2026-01-29
**Goal:** Use the Claude Agent SDK to gather rich project context in the background, then inject it into the direct-API completion path for higher-quality autocomplete.

---

## Architecture

```
Background (async, Agent SDK)                    Foreground (sync, direct API)
┌──────────────────────────────────┐   brief    ┌──────────────────────────┐
│ File open/save/switch triggers   │──────────→ │ Anthropic provider reads │
│ oracle analysis via Agent SDK    │            │ brief, prepends to       │
│ → reads imports, types, patterns │            │ system prompt as cached  │
│ → outputs structured ContextBrief│            │ prefix block             │
└──────────────────────────────────┘            └──────────────────────────┘
```

The oracle runs in the background on file events. The completion path (foreground) reads the cached brief and injects it into the system prompt. The user never waits on the oracle — completions are unaffected by oracle latency. But faster analysis means fresher briefs.

---

## Implementation Status

### Completed
- **4 new files:** `src/oracle/types.ts`, `context-brief-store.ts`, `brief-formatter.ts`, `context-oracle.ts`
- **6 modified files:** `src/types.ts`, `package.json`, `esbuild.js`, `extension.ts`, `provider-router.ts`, `anthropic.ts`, plus `profile.ts` and `test/helpers.ts`
- **Unit tests:** 15 tests (7 store, 8 formatter), all passing
- **Smoke test:** `src/test/oracle-smoke.ts` — end-to-end SDK → JSON → brief formatting
- **Latency benchmark:** `src/test/oracle-latency.ts` — profiles cold vs warm timing
- Build clean, type-check clean, 182/182 unit tests pass

### Key Design Decisions
- Uses `query()` API (not V2 sessions) — sessions don't support tool/prompt restrictions
- Dynamic `import('@anthropic-ai/claude-agent-sdk')` so extension loads without SDK
- Tightened analysis prompt: "file content is below, do NOT re-read it, limit to 3 tool calls"
- Flexible `parseResponse()` handles both exact schema matches and model's natural key variants
- Brief injected as separate system block with independent `cache_control` for prompt caching

---

## Latency Findings

### Benchmark Data (haiku model, 2026-01-29)

**Test 1: Independent `query()` calls** — each spawns a fresh `claude` subprocess

| File | Wall ms | SDK ms | API ms | Turns | Tools |
|------|---------|--------|--------|-------|-------|
| cache.ts | 11,079 | 9,362 | 19,813 | 1 | 0 |
| post-process.ts | 13,224 | 11,549 | 24,880 | 3 | 2 |
| mode-detector.ts | 11,529 | 9,940 | 23,223 | 2 | 1 |

**Test 2: Resume session** — no speedup, still spawns new process

| File | Wall ms | SDK ms | API ms | Turns | Tools |
|------|---------|--------|--------|-------|-------|
| cache.ts (initial) | 9,670 | 7,881 | 19,181 | 1 | 0 |
| post-process.ts (resumed) | 10,194 | 8,592 | 18,822 | 2 | 1 |
| mode-detector.ts (resumed) | 13,160 | 11,548 | 25,887 | 2 | 1 |

**Test 3: Minimal overhead** — no tools, no session persistence

| Run | Wall ms | SDK ms | API ms |
|-----|---------|--------|--------|
| 1 | 5,548 | 3,822 | 7,001 |
| 2 | 5,339 | 3,672 | 7,538 |
| 3 | 5,795 | 4,014 | 7,933 |

**Test 4: V2 session API** — hung on initialization, never produced init message

### Key Takeaways

1. **The `query()` floor is ~5.5s** with haiku, no tools. This is pure process spawn + one API call.
2. **Each `query()` spawns a new `claude` subprocess.** There is no process reuse between calls.
3. **Resume doesn't help.** It loads conversation history from disk but still spawns a new process.
4. **V2 sessions hung on init** in our test. Even if they worked, `SDKSessionOptions` only accepts `model` + process config — not `tools`, `systemPrompt`, `permissionMode`, etc.
5. **Tool calls add ~3-5s each** (extra API round-trip per turn).
6. **An interactive Claude Code terminal responds in ~2s** for simple prompts — the process is already warm there. The 5.5s floor is spawn overhead.

### Where the Time Goes (per `query()` call)

| Phase | ~Time | Notes |
|-------|-------|-------|
| Node.js process spawn | ~1.7s | Wall minus SDK time |
| SDK init (module loading, config) | ~2-3s | SDK time minus API time... but API > SDK in measurements, suggesting API time is cumulative |
| API round-trip (1 turn) | ~2-3s | Model inference + network |
| Additional turns (tool calls) | ~3-5s each | Read/Grep/Glob execution + API round-trip |

---

## What Hasn't Been Tested Yet

### Streaming Input Mode (Most Promising)

The earlier research doc (`docs/claude-code-latency-research.md`) identifies **streaming input** as the path to ~2-3s warm latency. This uses `query()` with an `AsyncIterable<SDKUserMessage>` as the prompt. The process stays alive between messages.

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

async function* messageStream() {
  yield makeUserMessage('warmup prompt');
  // ... wait for next file event ...
  yield makeUserMessage('analyze this file...');
  // ... process stays alive ...
  yield makeUserMessage('analyze another file...');
}

const stream = query({
  prompt: messageStream(),
  options: {
    model: 'haiku',
    tools: ['Read', 'Grep', 'Glob'],
    systemPrompt: ORACLE_SYSTEM_PROMPT,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 15,
  },
});
```

**Why this might work:**
- `query()` accepts `AsyncIterable<SDKUserMessage>` (confirmed in SDK types)
- `Options` supports all our config: `tools`, `systemPrompt`, `permissionMode`, `cwd`, `settingSources`
- The process stays alive as long as the async iterable hasn't closed
- Research doc cites ~2-3s for subsequent messages (77% faster than cold)
- Known bug: if the prompt stream closes before Claude finishes, hooks may not fire (issue #9705)

**Key questions to answer:**
1. Does the streaming input pattern actually keep the process warm between messages?
2. Can we yield messages on-demand (triggered by file events) through the async iterable?
3. What's the actual warm latency for an analysis prompt (not just a trivial prompt)?
4. How do we handle the async generator lifecycle in the extension (open at activation, close on deactivate)?
5. Does `maxTurns` apply per-message or globally? (If globally, the session would eventually hit the limit.)

### V2 Session API — Deeper Investigation

The session hung in our test, but we may have been draining the stream incorrectly. Questions:
- Does `stream()` block until `send()` is called?
- Do we need to call `send()` before `stream()`, or is the first `stream()` the init?
- Is the hang a bug in our test code or an SDK issue?

Note: Even if sessions work, `SDKSessionOptions` is very limited. The control protocol (`SDKControlInitializeRequest`) does include `systemPrompt`, `agents`, and `hooks` — but it's unclear if the SDK exposes this to session users.

### Other Optimizations Not Yet Explored
- `outputFormat: { type: 'json_schema', schema: ... }` — structured output could eliminate JSON parsing failures and reduce retries
- `maxThinkingTokens: 0` or lower — reduce thinking overhead (currently 1024)
- `persistSession: false` on `query()` — our minimal test showed ~5.5s even with this, but worth confirming on the streaming path
- Different `tools` configurations — is `[]` (no tools) + inline file content faster than giving Read/Grep/Glob?
- `betas: ['context-1m-2025-08-07']` — larger context window, could include more file content inline to avoid tool calls entirely

---

## Bugs & Fixes Log

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| Empty responses from V2 session streaming | Looked for wrong event types (`text`, `content_block_delta`) | Use `message.type === 'result' && message.subtype === 'success'` → `message.result` |
| Model ignoring JSON schema | Model returns valid JSON but with own preferred key names | Flexible `parseResponse()` with extract functions checking multiple key variants |
| `Cannot find module 'vscode'` in smoke test | Smoke test imported `context-oracle.ts` which imports `vscode` | Extract logic directly in smoke test |
| 30-40s latency (V2 sessions) | `SDKSessionOptions` ignores `allowedTools`, `systemPrompt`, etc. — loaded all 18 tools with default prompt | Rewrote to use `query()` API which supports all options |
| `error_max_turns` with `query()` | Model burned all turns on unnecessary tool calls (Glob `**/*.ts`, reading package.json) | Tightened prompt: "file content is below, do NOT re-read it, limit to 3 tool calls"; bumped `maxTurns: 15` |
| V2 session hung on init | Unknown — session.stream() never yielded init message | Needs deeper investigation (may be test code issue or SDK bug) |

---

## Streaming Input + Inference Tuning (2026-01-29, session 2)

### Streaming Input Results

Streaming input mode (`query()` with `AsyncIterable<SDKUserMessage>`) keeps the process alive between messages. This eliminates the ~5.5s spawn overhead on subsequent queries.

**Streaming with original settings** (haiku, tools=['Read','Grep','Glob'], maxThinkingTokens=1024):

| Query | Wall ms | Notes |
|-------|---------|-------|
| Warmup (cold) | 5,887 | Includes process spawn |
| cache.ts (warm) | 9,212 | Full analysis |
| post-process.ts (warm) | 9,410 | 1 tool call |
| mode-detector.ts (warm) | 6,797 | No tool calls |
| debouncer.ts (warm) | 8,836 | No tool calls |
| Trivial prompt (warm) | 1,308 | ~1s proves process is warm |
| Trivial prompt (warm) | 1,107 | |
| Trivial prompt (warm) | 775 | |

**Key finding:** Trivial prompts are ~1s on warm process. Analysis prompts are 7-9s. The bottleneck shifted from process spawn to model inference.

### Inference Tuning Results

Tested different configurations to reduce model inference time (all using independent `query()` on cache.ts, so include ~5.5s spawn):

| Config | Wall ms | Δ from baseline | Key change |
|--------|---------|-----------------|------------|
| A: Baseline (thinking=1024, tools) | 9,623 | - | - |
| B: No thinking (maxThinkingTokens=0) | 6,408 | **-3,215ms** | Biggest single win |
| C: No tools + no thinking | 5,253 | -4,370ms | Saves ~0.5s more |
| D: Minimal prompt + no tools + no thinking | 4,024 | -5,599ms | Shorter prompt + less output |
| E: Structured output (json_schema) | 8,869 | -754ms | Actually slower (2 turns) |

**Key findings:**
- `maxThinkingTokens: 0` is the biggest win: **-3.2s**
- Removing tool definitions saves ~0.5s (fewer tokens in system prompt)
- Shorter prompt + schema saves more (less for model to process)
- `outputFormat: json_schema` is counterproductive — triggers an extra turn

### Optimized Streaming: Combined Results

Streaming input + no thinking + no tools + compact prompt (haiku):

| Query | Wall ms |
|-------|---------|
| Warmup (cold start) | **2,175** |
| cache.ts | 3,765 |
| post-process.ts | 3,058 |
| mode-detector.ts | 4,414 |
| debouncer.ts | 4,329 |
| context-builder.ts | **2,952** |
| prompt-builder.ts | 6,187 (largest file) |

**Cold start: 2.2s. Average warm analysis: 4.1s. Best: 2.95s.**
100% valid JSON (6/6). Output scales with file complexity (prompt-builder.ts is largest → 6.2s).

### Comparison: Before vs After

| Metric | Independent query() | Streaming + optimized | Improvement |
|--------|--------------------|-----------------------|-------------|
| Cold start | ~5.5s | **2.2s** | 60% faster |
| Warm analysis (avg) | ~10-13s | **4.1s** | 60-70% faster |
| Warm analysis (best) | ~9.7s | **2.95s** | 70% faster |
| Valid JSON rate | variable | **100%** | Reliable |

### Implementation Pattern

The streaming input uses an async iterable as the prompt source:

```typescript
function createMessageChannel() {
  // Returns { iterable, push(msg), close() }
  // push() yields a SDKUserMessage into the async iterable
  // The query() process stays alive until close() is called
}

const channel = createMessageChannel();
channel.push('warmup prompt');

const stream = query({
  prompt: channel.iterable,
  options: {
    model: 'haiku',
    tools: [],                    // No tools — inline all context
    maxThinkingTokens: 0,         // No thinking — biggest latency win
    systemPrompt: COMPACT_PROMPT, // Minimal system prompt
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    settingSources: [],
    persistSession: false,
    maxTurns: 50,
  },
});

// Background consumer drains the stream
// channel.push(analysisPrompt) sends new file for analysis
// channel.close() ends the session
```

**Tradeoff:** No tools means the oracle can't Read imported files for type signatures. All analysis is based on the inline file content only. For most files this is sufficient — imports are visible, patterns are visible, and the model can infer type signatures from usage. For deeper analysis (resolving external type signatures), we'd need tools back (+0.5s overhead for tool defs, plus 3-5s per tool call round-trip).

---

## Ultra-Fast Autocomplete via Claude Code (2026-01-29, session 3)

### Pivoting from "background oracle" to "direct autocomplete"

The earlier sessions focused on using Claude Code as a background analysis engine that produces structured JSON context briefs (~4s per analysis). But the real question is: **can Claude Code itself be the autocomplete engine?** If we can get sub-1-second completions on a warm process, there's no need for a separate analysis layer — Claude Code IS the completion provider.

### Autocomplete Speed Benchmark

Tested raw completion speed: streaming input, haiku, no thinking, no tools, minimal system prompt. The prompt is just the code prefix (what the user has typed so far).

**Test 1: Varying system prompts** (all warm, tiny prefix: `function add(a, b) { return `)

| System Prompt | Wall ms | Output | Notes |
|---------------|---------|--------|-------|
| Minimal ("Continue the code") | 964ms | `a + b;\n}` (with markdown fences) | Fences are a problem |
| None | 1,857ms | 491 chars, verbose explanation | Way too much output |
| FIM ("Output ONLY the code that comes next") | **597ms** | `a + b;\n}` (clean, no fences) | **Winner** |

**Key finding:** The system prompt matters enormously. "No system prompt" produces verbose chat-style output (500+ chars, 1.8s). The FIM prompt produces tight raw code (8 chars, 597ms). **Output token count directly drives latency.**

**Test 2: FIM prompt, varying prefix sizes**

| Prefix | Wall ms | Output chars | Output |
|--------|---------|-------------|--------|
| Tiny (2 lines) | **597ms** | 8 | `a + b;\n}` |
| Small (15 lines) | **681ms** | 62 | Completes function body |
| Medium (55 lines) | **1,454ms** | 220 | Continues class implementation |

**Test 3: Prefix + suffix (fill-in-the-middle)**

| Scenario | Wall ms | Output |
|----------|---------|--------|
| Small prefix + suffix | 1,162ms | `parsed.value ?? 0,` |
| Medium prefix + suffix | **603ms** | `fn();` |

The suffix gives the model a clear stop point — it generates fewer tokens, which means lower latency.

**Test 4: Consistency (same tiny prefix, 5 runs)**

| Run | Wall ms |
|-----|---------|
| 1 | 646 |
| 2 | 688 |
| 3 | 1,027 |
| 4 | 1,175 |
| 5 | 983 |
| **avg** | **904** |
| **p50** | **983** |

### Why Sub-1s Now vs 4s Before

The earlier 4s numbers were for **structured JSON analysis** — asking the model to read a whole file and produce a ~1500 character JSON object with imports, types, patterns, symbols, and a project summary. That's a lot of output tokens, and output tokens are the primary driver of latency.

The autocomplete path asks for **just the next few tokens of code**. A typical completion is 5-60 characters. Fewer output tokens = proportionally less time.

| Factor | Analysis (4s) | Autocomplete (<1s) |
|--------|---------------|--------------------|
| Task | Structured JSON extraction | Continue code at cursor |
| Output size | ~1500 chars | ~5-60 chars |
| System prompt | Long schema description | One sentence |
| Input | Full file content | Prefix (+ optional suffix) |
| Process | Warm (streaming) | Warm (streaming) |
| Tools | None | None |
| Thinking | Off | Off |

### Performance Profile

| Phase | Time | Notes |
|-------|------|-------|
| Cold start (process spawn) | ~2.5s | Paid once at extension activation |
| Warm completion (tiny) | ~600-900ms | 5-30 output chars |
| Warm completion (medium) | ~1.0-1.5s | 60-220 output chars |
| Warm completion (FIM with suffix) | ~600-1.2s | Suffix constrains output length |
| API/network variance | ±300ms | Observed jitter in consistency test |

---

## Next Steps

### Phase 1: Bare-bones Claude Code autocomplete
Build the simplest possible Claude Code completion provider:
- Streaming input keeps process warm (one long-lived `query()` per extension lifetime)
- FIM system prompt: "Output ONLY the code that comes next"
- Prefix-only or prefix+suffix input
- No tools, no thinking, no structured output
- Target: sub-1s warm completions

### Phase 2: Enhancements (after Phase 1 works end-to-end)
- Suffix context for smarter fill-in-the-middle
- Brief/context injection (the oracle work from sessions 1-2)
- Tuning: prompt wording, maxTokens cap, stop sequences
- Prose mode support
- Session lifecycle management (periodic restart for context accumulation)
