# Claude Code Latency Research

**Date:** 2026-01-29
**Context:** Bespoke AI VS Code extension exploring Claude Code as a backend for two use cases with different latency requirements.

## Executive Summary

Using Claude Code as a subprocess backend has fundamentally different latency profiles depending on the integration approach. The key finding is that **the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) with streaming input mode is the only viable path for low-latency use cases**, while the CLI (`claude -p`) is adequate for commit message generation but too slow for autocomplete.

| Approach | Cold Start | Warm Request | Viable For |
|----------|-----------|--------------|------------|
| `claude -p` (CLI spawn per request) | ~12s | ~12s (no reuse) | Commit messages (marginal) |
| Agent SDK `query()` single-mode | ~12s | ~12s (no reuse) | Commit messages (marginal) |
| Agent SDK streaming input mode | ~12s | ~2-3s | Commit messages (good) |
| Agent SDK V2 session `send()`/`stream()` | ~12s | ~2-3s | Commit messages (good) |
| Direct Anthropic API (`@anthropic-ai/sdk`) | 0ms spawn | 1-3s per request | Both use cases |
| Direct API + prompt caching | 0ms spawn | <1s for cached prefixes | Both use cases (best for autocomplete) |

**Recommendation:** Use the Agent SDK with streaming sessions for commit message generation (rich tool access, git integration). Continue using the direct Anthropic API for inline completions (sub-second latency requirement cannot be met by Claude Code).

---

## Table of Contents

1. [Latency Breakdown](#1-latency-breakdown)
2. [CLI-Level Optimizations](#2-cli-level-optimizations)
3. [Agent SDK Approaches](#3-agent-sdk-approaches)
4. [Long-Lived Process Patterns](#4-long-lived-process-patterns)
5. [Direct API Alternatives](#5-direct-api-alternatives)
6. [Architecture Patterns](#6-architecture-patterns)
7. [Recommendations](#7-recommendations)
8. [Sources](#8-sources)

---

## 1. Latency Breakdown

### Where Time Goes

Based on the Agent SDK issue #34 measurements and documentation analysis, the ~12s cold-start overhead breaks down roughly as:

| Phase | Estimated Time | Notes |
|-------|---------------|-------|
| Process spawn (Node.js boot) | ~1-2s | Node.js runtime initialization |
| SDK/CLI initialization | ~2-3s | Loading modules, parsing config |
| System prompt assembly | ~1-2s | Tool definitions (~12K tokens), CLAUDE.md loading |
| MCP server connections | ~1-3s | If configured; 0 if none |
| API round-trip (first request) | ~2-5s | Network latency + model inference |
| Response generation | Variable | Depends on model and output length |

**Key insight:** The ~12s overhead is dominated by process initialization, not API latency. The API round-trip itself is 1-3s for simple prompts. This means eliminating process spawn is the highest-impact optimization.

### Fixed vs. Per-Request Overhead

- **Fixed (per process):** Node.js boot, module loading, tool definition assembly, MCP setup
- **Per-request:** API round-trip, response generation, post-processing
- **Amortizable:** System prompt tokens (via Anthropic prompt caching), session context

---

## 2. CLI-Level Optimizations

### 2.1. `--system-prompt` (Replace Default Prompt)

**What it does:** Replaces Claude Code's entire default system prompt (~33K tokens) with a custom string. Tool definitions (~12K tokens) and one line ("You are a Claude agent...") are retained regardless.

**Latency impact:** Moderate. Reduces input tokens by ~20K, which saves on API processing time and cost. Does not affect process spawn overhead.

```bash
# Minimal system prompt for commit messages
claude -p "Generate a commit message for these staged changes" \
  --system-prompt "You are a Git commit message generator. Output only the commit message, nothing else." \
  --allowedTools "Bash(git diff *),Bash(git log *),Bash(git status *)" \
  --output-format text
```

**Pros:**
- Reduces token count by ~60% (from ~33K to ~12K base)
- Faster API processing, lower cost
- More focused behavior

**Cons:**
- Still ~12K tokens of tool definitions
- No impact on process spawn time
- Loses Claude Code's built-in coding guidelines

### 2.2. `--tools` (Restrict Available Tools)

**What it does:** Restricts which built-in tools are available. Use `""` to disable all tools, `"default"` for all, or specific tool names.

```bash
# Only git-related bash commands, no file editing
claude -p "Generate a commit message" \
  --tools "Bash,Read" \
  --allowedTools "Bash(git diff *),Bash(git log *),Bash(git status *)"
```

**Latency impact:** Low-to-moderate. Fewer tool definitions means fewer tokens in the system prompt, but the savings are modest compared to the full ~12K.

**Note:** `--tools ""` disables all tools entirely, which would prevent Claude from running `git diff` etc. For commit messages, you need at least `Bash` and potentially `Read`.

### 2.3. `--no-session-persistence`

**What it does:** Disables saving sessions to disk. Print mode only.

```bash
claude -p "Generate a commit message" --no-session-persistence
```

**Latency impact:** Negligible. Session persistence is a write-after-response operation. Disabling it may save a few milliseconds of file I/O but does not affect perceived latency.

### 2.4. `--setting-sources` (Skip Config Loading)

**What it does:** Controls which filesystem settings (CLAUDE.md, settings.json) are loaded. Using `--setting-sources ""` or omitting it skips all filesystem settings.

```bash
# Skip all CLAUDE.md and settings.json loading
claude -p "Generate a commit message" --setting-sources ""
```

**Latency impact:** Low. Saves file I/O for reading CLAUDE.md files and settings, but this is typically <100ms.

### 2.5. `--model` (Model Choice)

**What it does:** Selects the model. Haiku is significantly faster than Sonnet/Opus for response generation.

| Model | Typical Response Time | Quality |
|-------|----------------------|---------|
| `haiku` | ~1-2s | Good for structured tasks like commit messages |
| `sonnet` | ~2-4s | Better for nuanced completions |
| `opus` | ~4-8s | Best quality, highest latency |

**Latency impact:** High for response generation phase. Haiku can cut API time in half compared to Sonnet. For commit messages, Haiku quality is likely sufficient.

```bash
claude -p "Generate a commit message" --model haiku
```

### 2.6. Combined CLI Optimization

Maximum CLI optimization for commit messages:

```bash
claude -p "$(git diff --cached)" \
  --system-prompt "Generate a conventional commit message. Output only the message." \
  --tools "Bash" \
  --allowedTools "Bash(git *)" \
  --model haiku \
  --no-session-persistence \
  --setting-sources "" \
  --output-format text
```

**Expected latency:** ~10-12s (still dominated by process spawn). The CLI optimizations shave perhaps 1-2s off the total but cannot break the ~10s floor.

---

## 3. Agent SDK Approaches

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, formerly `@anthropic-ai/claude-code`) provides programmatic access to Claude Code's capabilities from TypeScript/Node.js.

### 3.1. Single-Mode `query()` (V1)

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

for await (const message of query({
  prompt: 'Generate a commit message for the staged changes',
  options: {
    model: 'haiku',
    allowedTools: ['Bash'],
    systemPrompt: 'Generate a conventional commit message. Output only the message.',
    settingSources: [],           // Skip CLAUDE.md loading
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    maxTurns: 3,
  }
})) {
  if (message.type === 'result') {
    console.log(message.result);
  }
}
```

**Latency:** ~12s per call. Each `query()` spawns a new process. This is confirmed as expected behavior by Anthropic (Agent SDK issue #34).

**Pros:**
- Clean API, no generator coordination
- Full tool access
- Structured output support

**Cons:**
- ~12s overhead per call (identical to CLI)
- No process reuse between calls

### 3.2. Streaming Input Mode (V1) -- Recommended for Sessions

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

async function* messageGenerator() {
  // First prompt
  yield {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: 'Generate a commit message for the staged changes'
    }
  };

  // ... later, another prompt on the same session
  await someCondition();

  yield {
    type: 'user' as const,
    message: {
      role: 'user' as const,
      content: 'Now summarize what changed'
    }
  };
}

for await (const message of query({
  prompt: messageGenerator(),
  options: {
    model: 'haiku',
    allowedTools: ['Bash'],
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  }
})) {
  if (message.type === 'result') {
    console.log(message.result);
  }
}
```

**Latency:**
- First message: ~12s (cold start)
- Subsequent messages: ~2-3s (77% faster, process stays alive)

**Pros:**
- Process stays alive between messages
- Subsequent requests are fast (~2-3s)
- Full hook and tool support
- Image attachment support

**Cons:**
- First request still ~12s
- Generator coordination is complex
- Known bug: if the prompt stream closes before Claude finishes, hooks may not fire (issue #9705)

### 3.3. V2 Session API (Preview) -- Simplest Multi-Turn

```typescript
import {
  unstable_v2_createSession,
  unstable_v2_resumeSession,
  type SDKMessage
} from '@anthropic-ai/claude-agent-sdk';

// Create session once (e.g., at extension activation)
const session = unstable_v2_createSession({
  model: 'haiku',
  // All V1 options are supported
});

// First use (~12s cold start)
await session.send('Generate a commit message for staged changes');
for await (const msg of session.stream()) {
  if (msg.type === 'result') {
    return msg.result;
  }
}

// Second use (~2-3s warm)
await session.send('Now create the commit with that message');
for await (const msg of session.stream()) {
  if (msg.type === 'result') {
    return msg.result;
  }
}

// Cleanup
session.close();
```

**Latency:** Same as streaming input mode (~12s cold, ~2-3s warm).

**Pros:**
- Simplest API (no async generators)
- `send()`/`stream()` pattern is natural
- Session resume across restarts via `unstable_v2_resumeSession()`
- Automatic cleanup with `await using`

**Cons:**
- Marked as "unstable preview" -- API may change
- Missing some V1 features (session forking, `interrupt()` method)
- Still ~12s cold start

---

## 4. Long-Lived Process Patterns

### 4.1. Warm Session Pool

Keep a pre-warmed Agent SDK session ready for use. Start the session at extension activation, absorb the cold-start cost, and serve requests from the warm session.

```typescript
// In extension.ts activate()
import { unstable_v2_createSession } from '@anthropic-ai/claude-agent-sdk';

class ClaudeCodeSessionManager {
  private session: SDKSession | null = null;
  private warming: Promise<void> | null = null;

  async warmUp() {
    this.warming = this._initSession();
    return this.warming;
  }

  private async _initSession() {
    this.session = unstable_v2_createSession({
      model: 'haiku',
      allowedTools: ['Bash', 'Read'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: ['project'],
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: 'Focus on git operations and commit message generation.'
      },
    });

    // Send a trivial prompt to force process initialization
    await this.session.send('Ready');
    for await (const msg of this.session.stream()) {
      // Drain the response
    }
  }

  async generateCommitMessage(diff: string): Promise<string> {
    if (this.warming) await this.warming;
    if (!this.session) throw new Error('Session not initialized');

    await this.session.send(
      `Generate a commit message for these changes:\n\n${diff}`
    );

    for await (const msg of this.session.stream()) {
      if (msg.type === 'result' && msg.subtype === 'success') {
        return msg.result;
      }
    }
    throw new Error('No result from session');
  }

  dispose() {
    this.session?.close();
  }
}
```

**Expected latency:**
- Extension activation: absorbs ~12s cold start (background)
- First commit message: ~2-3s (warm session)
- Subsequent: ~2-3s

**Pros:**
- Hides cold-start from user entirely
- Consistent ~2-3s latency
- Session accumulates context (knows the project)

**Cons:**
- Consumes resources while idle
- Session may expire or disconnect
- Need reconnection/recovery logic
- Memory overhead from keeping Node.js subprocess alive

### 4.2. CLI Stream-JSON Protocol

The CLI supports `--input-format stream-json` and `--output-format stream-json` for NDJSON-based streaming. This enables piping multiple prompts through a single process, but it is designed for pipeline chaining, not interactive sessions.

```bash
# Stream chaining (pipeline, not interactive)
echo '{"type":"user","message":{"role":"user","content":"Hello"}}' | \
  claude -p --input-format stream-json --output-format stream-json
```

**Latency impact:** The stream-json format itself does not reduce cold-start. It is useful for progressive output processing but does not keep a process alive for multiple independent requests.

**Verdict:** Not suitable for the session-reuse pattern. Use the Agent SDK instead.

### 4.3. Session Resumption (`--resume`, `--session-id`)

```bash
# First request
SESSION_ID=$(claude -p "Initial prompt" --output-format json | jq -r '.session_id')

# Subsequent requests reuse session context
claude -p "Follow-up prompt" --resume "$SESSION_ID"
```

**Latency impact:** Each `--resume` invocation still spawns a new process (~12s). The benefit is context continuity, not speed. The session history is loaded from disk, adding I/O overhead rather than reducing it.

**Verdict:** Useful for multi-step workflows (e.g., review then commit) but does not reduce latency.

---

## 5. Direct API Alternatives

### 5.1. Direct Anthropic API (Current Approach)

The extension already uses `@anthropic-ai/sdk` for inline completions. This remains the fastest option.

```typescript
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey });

// For commit messages
const response = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 300,
  system: 'Generate a conventional commit message. Output only the message.',
  messages: [{
    role: 'user',
    content: `Generate a commit message for:\n\n${diff}`
  }],
});
```

**Latency:** 1-3s (API round-trip + generation only, no process spawn).

**Pros:**
- No subprocess overhead
- Already integrated in the extension
- Full control over prompts and parameters
- Prompt caching support

**Cons:**
- No tool execution (can't run `git diff` through Claude)
- Must extract git context yourself before calling the API
- No access to Claude Code's system prompt or agent loop

### 5.2. Direct API + Prompt Caching for Commit Messages

```typescript
const response = await client.messages.create({
  model: 'claude-haiku-4-5-20251001',
  max_tokens: 300,
  system: [{
    type: 'text',
    text: COMMIT_MESSAGE_SYSTEM_PROMPT, // Your custom prompt
    cache_control: { type: 'ephemeral' }, // Cache for 5 min
  }],
  messages: [{
    role: 'user',
    content: `Staged diff:\n\`\`\`\n${diff}\n\`\`\`\n\nRecent commits:\n${recentLog}`
  }],
});
```

**Latency:** ~1-2s. The system prompt is cached after the first call, reducing subsequent input token processing.

**Pros:**
- Fastest option overall
- Up to 85% latency reduction on cached prefixes
- Up to 90% cost reduction on cached tokens
- Already understood architecture (same as completions)

**Cons:**
- Must gather git context in the extension (run `git diff`, `git log` via Node.js `child_process`)
- No agent loop -- single-shot only
- Cache expires after 5 minutes (or 1 hour with extended TTL)

### 5.3. Hybrid: Direct API for Generation, Extension Gathers Context

This is the most practical architecture for commit messages:

```typescript
import { execSync } from 'child_process';

async function generateCommitMessage(workspaceRoot: string): Promise<string> {
  // Gather context locally (fast, ~50ms)
  const diff = execSync('git diff --cached', { cwd: workspaceRoot }).toString();
  const log = execSync('git log --oneline -10', { cwd: workspaceRoot }).toString();
  const status = execSync('git status --short', { cwd: workspaceRoot }).toString();

  if (!diff.trim()) {
    throw new Error('No staged changes');
  }

  // Generate via direct API (fast, ~1-3s)
  const response = await anthropicClient.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    system: [{
      type: 'text',
      text: `You are a Git commit message generator. Generate a conventional commit message.
Follow these rules:
- Use conventional commit format (type(scope): description)
- Keep the subject line under 72 characters
- Add a body if the changes are complex
- Output only the commit message, no explanation`,
      cache_control: { type: 'ephemeral' },
    }],
    messages: [{
      role: 'user',
      content: `Recent commits for style reference:\n${log}\n\nStaged changes:\n\`\`\`\n${diff}\n\`\`\``,
    }],
  });

  return response.content[0].type === 'text' ? response.content[0].text : '';
}
```

**Latency:** ~1-3s total (50ms git + 1-3s API).

---

## 6. Architecture Patterns

### 6.1. Pattern Comparison for Commit Messages

| Pattern | Latency | Complexity | Tool Access | Cost |
|---------|---------|------------|-------------|------|
| CLI spawn per request | ~12s | Low | Full | High (process overhead + tokens) |
| Agent SDK warm session | ~2-3s | Medium | Full | Medium |
| Direct API + local git | ~1-3s | Low | None (gather locally) | Low |
| Direct API + prompt cache | ~1-2s | Low | None (gather locally) | Lowest |

### 6.2. Pattern Comparison for Autocomplete

| Pattern | Latency | Viable? | Notes |
|---------|---------|---------|-------|
| CLI spawn per keystroke | ~12s | No | Far too slow |
| Agent SDK warm session | ~2-3s | No | Still too slow for ghost text |
| Direct Anthropic API | ~1-3s | Marginal | Current approach, works with debouncing |
| Direct API + prompt cache | <1s | Yes | Best option, already implemented |

### 6.3. Pre-Warming Strategy

For commit message generation using the Agent SDK:

```
Extension activates
  |
  +---> Background: warm up Agent SDK session (~12s, non-blocking)
  |
User stages changes and requests commit message
  |
  +---> If session warm: use warm session (~2-3s)
  +---> If session cold: fall back to direct API (~1-3s)
  +---> Re-warm session in background
```

### 6.4. The "agentapi" Question

The term "agentapi" appears in the Bespoke AI CLAUDE.md future direction section. Based on research, this likely refers to the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), which is the official programmatic interface. There is no separate "agentapi" product. The Agent SDK is the programmatic equivalent of Claude Code, providing:

- The same tools, agent loop, and context management
- TypeScript and Python packages
- Streaming input mode for long-lived processes
- V2 preview with simplified session management

---

## 7. Recommendations

Ranked by impact and implementation complexity.

### For Commit Message Generation

**Recommendation 1 (Best): Direct Anthropic API with local git context gathering**
- **Impact:** High (1-3s latency, down from 12s)
- **Complexity:** Low (uses existing `@anthropic-ai/sdk` infrastructure)
- **Implementation:** Run `git diff --cached`, `git log`, etc. via `child_process.execSync()`, then call the Anthropic API directly with a focused system prompt and prompt caching.
- **Why not Agent SDK?** The 2-3s warm latency is acceptable, but the added complexity of session management, the ~12s cold start on first use, and the instability of the V2 API make it harder to justify when the direct API achieves 1-3s consistently with zero process management.

**Recommendation 2 (If tool access is essential): Agent SDK V2 session with pre-warming**
- **Impact:** Medium (2-3s warm, 12s cold absorbed at activation)
- **Complexity:** Medium (session lifecycle management, reconnection logic)
- **Implementation:** Create a session at extension activation, send a trivial prompt to warm it, then reuse for commit messages.
- **When to choose this:** Only if you need Claude to autonomously run git commands, analyze files, or make multi-step decisions (e.g., "look at the diff, check for related issues, then write a commit message").

### For Autocomplete / Inline Completions

**Recommendation: Continue using direct Anthropic API**
- **Impact:** Already optimal for this use case
- **Complexity:** Already implemented
- **Why:** No Claude Code integration path can achieve sub-500ms latency. The ~12s cold start and ~2-3s warm latency of the Agent SDK are fundamentally incompatible with ghost text UX. The direct API with prompt caching (already implemented) is the right architecture.
- **Future possibility:** If Anthropic introduces a true daemon mode or in-process SDK (no subprocess), revisit. The Agent SDK issue #34 proposed this but it was closed in favor of streaming input mode.

### Summary Matrix

| Use Case | Approach | Expected Latency | Priority |
|----------|----------|------------------|----------|
| Commit messages | Direct API + local git | 1-3s | Implement first |
| Commit messages (rich) | Agent SDK V2 warm session | 2-3s warm | Consider later |
| Autocomplete | Direct API (current) | 200-500ms cached | Already done |
| Autocomplete via Claude Code | Not viable | >2s minimum | Do not pursue |

---

## 8. Sources

### Official Documentation
- [Claude Code CLI Reference](https://code.claude.com/docs/en/cli-reference)
- [Run Claude Code Programmatically (Headless)](https://code.claude.com/docs/en/headless)
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview)
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript)
- [Agent SDK TypeScript V2 Preview](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview)
- [Agent SDK Streaming vs. Single Mode](https://platform.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Agent SDK Session Management](https://platform.claude.com/docs/en/agent-sdk/sessions)
- [Anthropic Prompt Caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- [Modifying System Prompts (Agent SDK)](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts)

### GitHub Issues and Repositories
- [Agent SDK ~12s overhead per query() call (Issue #34)](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34) -- Confirmed expected behavior; streaming input is the solution
- [Stream closes before Claude finishes (Issue #9705)](https://github.com/anthropics/claude-code/issues/9705) -- Known bug with streaming input mode
- [allowedTools option not working (Issue #19)](https://github.com/anthropics/claude-agent-sdk-typescript/issues/19)
- [V2 API interrupt without closing session (Issue #120)](https://github.com/anthropics/claude-agent-sdk-typescript/issues/120)
- [Claude Agent SDK TypeScript repo](https://github.com/anthropics/claude-agent-sdk-typescript)
- [@anthropic-ai/claude-agent-sdk on npm](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
- [@anthropic-ai/claude-code on npm](https://www.npmjs.com/package/@anthropic-ai/claude-code)

### Community and Analysis
- [Claude Code 1.0.60 Native Agent Architecture](https://hyperdev.matsuoka.com/p/claude-code-1060-the-native-agent) -- Native agent spawning improvements
- [Stream-JSON Chaining (claude-flow wiki)](https://github.com/ruvnet/claude-flow/wiki/Stream-Chaining)
- [Claude Code Performance Benchmarking (claude-flow wiki)](https://github.com/ruvnet/claude-flow/wiki/Performance-Benchmarking)
- [Claude Code Internals Part 6: Session State](https://kotrotsos.medium.com/claude-code-internals-part-6-session-state-management-e729f49c8bb9)
- [Claude Code Internals Part 7: SSE Stream Processing](https://kotrotsos.medium.com/claude-code-internals-part-7-sse-stream-processing-c620ae9d64a1)
- [Claude Agent SDK Guide (Promptfoo)](https://www.promptfoo.dev/docs/providers/claude-agent-sdk/)
- [What is --system-prompt in Claude Code (ClaudeLog)](https://claudelog.com/faqs/what-is-system-prompt-flag-in-claude-code/)
- [What is --allowedTools in Claude Code (ClaudeLog)](https://claudelog.com/faqs/what-is-allowed-tools-in-claude-code/)
- [Claude Code Best Practices (Anthropic)](https://www.anthropic.com/engineering/claude-code-best-practices)
- [Best Practices Using Claude Code SDK (Skywork)](https://skywork.ai/blog/best-practices-when-using-claude-code-sdk/)
- [Complete Guide to Claude Agent SDK (Nader Dabit)](https://nader.substack.com/p/the-complete-guide-to-building-agents)

### Key Findings from Sources
- `--system-prompt` replaces everything except tool definitions (~12K tokens) and one agent identity line ([ClaudeLog](https://claudelog.com/faqs/what-is-system-prompt-flag-in-claude-code/))
- Agent SDK `query()` has ~12s overhead per call, confirmed by Anthropic as expected behavior; streaming input is the official solution ([Issue #34](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34))
- Streaming input reduces subsequent requests from ~12s to ~2-3s ([Issue #34](https://github.com/anthropics/claude-agent-sdk-typescript/issues/34))
- The Agent SDK V2 `send()`/`stream()` API simplifies multi-turn sessions ([V2 Preview Docs](https://platform.claude.com/docs/en/agent-sdk/typescript-v2-preview))
- Prompt caching reduces latency by up to 85% and cost by up to 90% for long prompts ([Anthropic](https://www.anthropic.com/news/prompt-caching))
