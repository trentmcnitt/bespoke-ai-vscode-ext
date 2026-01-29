# Claude Code CLI Reference

> Comprehensive reference for using Claude Code as a child process from VS Code extensions or other programmatic contexts. Research date: 2026-01-29. Claude Code version at time of research: v2.1.x.

## Table of Contents

- [Overview](#overview)
- [Execution Modes](#execution-modes)
- [Complete Flag Reference](#complete-flag-reference)
- [Output Formats](#output-formats)
- [Input Formats](#input-formats)
- [System Prompt Behavior](#system-prompt-behavior)
- [Tool Configuration](#tool-configuration)
- [Session Persistence](#session-persistence)
- [Cost and Token Usage](#cost-and-token-usage)
- [Permission Modes](#permission-modes)
- [The Agent SDK (Programmatic API)](#the-agent-sdk-programmatic-api)
- [Common Invocation Patterns](#common-invocation-patterns)
- [Source Documentation](#source-documentation)

---

## Overview

Claude Code (`claude`) is Anthropic's agentic coding tool. It can be used interactively in a terminal or non-interactively via the `-p` (print) flag for scripting and automation. The `-p` mode is what you use when spawning it as a child process.

The CLI is installed via npm (`@anthropic-ai/claude-code`) or system package managers. The underlying agent loop, tools, and context management are also available as a library via the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`).

---

## Execution Modes

| Mode | Invocation | Behavior |
|------|-----------|----------|
| **Interactive** | `claude` | Opens a REPL session in the terminal |
| **Interactive with prompt** | `claude "query"` | Opens REPL with an initial prompt |
| **Print (SDK/headless)** | `claude -p "query"` | Executes, prints response, exits |
| **Piped** | `cat file \| claude -p "query"` | Reads stdin, processes, exits |
| **Continue** | `claude -c` | Resumes the most recent conversation |
| **Resume** | `claude -r <session-id>` | Resumes a specific session |

Print mode (`-p`) is the mode relevant for spawning as a child process. It runs non-interactively: it executes the prompt, produces output, and exits.

---

## Complete Flag Reference

### Core Flags

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `-p`, `--print` | Non-interactive mode: print response and exit | N/A (defines the mode) | Off | Required for child process usage |
| `-c`, `--continue` | Continue the most recent conversation in the current directory | Interactive + Print | Off | |
| `-r`, `--resume [value]` | Resume a session by ID or name, or show picker | Interactive + Print | None | |
| `--session-id` | Use a specific session ID (must be valid UUID) | Interactive + Print | Auto-generated | |
| `--fork-session` | When resuming, create new session instead of reusing original | With `--resume`/`--continue` | Off | |
| `-v`, `--version` | Print version number | N/A | | |
| `-h`, `--help` | Display help | N/A | | |
| `-d`, `--debug [filter]` | Enable debug mode with optional category filter | Interactive + Print | Off | Filter examples: `"api,hooks"`, `"!statsig,!file"` |
| `--debug-file` | Write debug logs to a specific file path | Interactive + Print | None | |
| `--verbose` | Enable verbose logging (full turn-by-turn output) | Interactive + Print | Off | |

### Model Configuration

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--model` | Set the model for the session | Interactive + Print | Account default (typically `claude-sonnet-4-5-20250929`) | Accepts aliases: `sonnet`, `opus`, or full model names |
| `--fallback-model` | Automatic fallback model when primary is overloaded | Print only | None | |
| `--betas` | Beta headers to include in API requests | Interactive + Print | None | API key users only. Example: `interleaved-thinking` |

### System Prompt Flags

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--system-prompt` | **Replace** the entire default system prompt | Interactive + Print | Full Claude Code system prompt | Removes ALL default instructions. Blank slate. |
| `--system-prompt-file` | **Replace** with contents from a file | Print only | None | Mutually exclusive with `--system-prompt` |
| `--append-system-prompt` | **Append** text to the default system prompt | Interactive + Print | None | Safest option: preserves default behavior |
| `--append-system-prompt-file` | **Append** file contents to default prompt | Print only | None | Can combine with either replacement flag |

### Tool Configuration

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--tools` | Restrict available built-in tools | Interactive + Print | All tools (`"default"`) | Use `""` to disable all tools. Use `"Bash,Edit,Read"` for specific tools |
| `--allowedTools`, `--allowed-tools` | Tools that execute without permission prompts | Interactive + Print | None | Uses permission rule syntax with prefix matching |
| `--disallowedTools`, `--disallowed-tools` | Tools removed from model context entirely | Interactive + Print | None | Tools are completely unavailable, not just blocked |

### Output Configuration

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--output-format` | Output format: `text`, `json`, `stream-json` | Print only | `text` | |
| `--json-schema` | JSON Schema for structured output validation | Print only | None | Requires `--output-format json`. Result in `structured_output` field |
| `--include-partial-messages` | Include partial streaming events | Print only + `stream-json` | Off | Requires `--output-format stream-json` |

### Input Configuration

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--input-format` | Input format: `text` or `stream-json` | Print only | `text` | `stream-json` enables long-lived stdin conversations |
| `--replay-user-messages` | Re-emit user messages from stdin | `stream-json` only | Off | |

### Budget and Limits

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--max-turns` | Limit number of agentic turns | Print only | No limit | Exits with error when limit reached |
| `--max-budget-usd` | Maximum dollar spend before stopping | Print only | No limit | |

### Session and Persistence

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--no-session-persistence` | Do not save session to disk | Print only | Sessions saved | Prevents resume/continue later |

### Permission and Security

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--permission-mode` | Permission mode for the session | Interactive + Print | `default` | Options: `default`, `acceptEdits`, `bypassPermissions`, `plan`, `delegate`, `dontAsk` |
| `--dangerously-skip-permissions` | Bypass all permission checks | Interactive + Print | Off | Use with extreme caution |
| `--allow-dangerously-skip-permissions` | Enable bypassing as an option (without activating) | Interactive + Print | Off | Composable with `--permission-mode` |
| `--permission-prompt-tool` | MCP tool for handling permission prompts in non-interactive mode | Print | None | |

### Directory and Environment

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--add-dir` | Additional directories for tool access | Interactive + Print | None | Validates each path exists |
| `--setting-sources` | Comma-separated setting sources to load | Interactive + Print | All sources | Options: `user`, `project`, `local` |
| `--settings` | Path to settings JSON file or JSON string | Interactive + Print | None | |

### MCP (Model Context Protocol)

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--mcp-config` | Load MCP servers from JSON files or strings | Interactive + Print | None | Space-separated |
| `--strict-mcp-config` | Only use MCP servers from `--mcp-config` | Interactive + Print | Off | Ignores all other MCP configurations |

### Agent and Plugin Configuration

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--agent` | Specify agent for the session | Interactive + Print | Default | Overrides the `agent` setting |
| `--agents` | Define custom subagents via JSON | Interactive + Print | None | See [Agents JSON Format](#agents-json-format) |
| `--plugin-dir` | Load plugins from directories | Interactive + Print | None | Repeatable |
| `--disable-slash-commands` | Disable all skills and slash commands | Interactive + Print | Off | |

### Chrome and IDE Integration

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--chrome` | Enable Chrome browser integration | Interactive + Print | Off | |
| `--no-chrome` | Disable Chrome integration | Interactive + Print | Off | |
| `--ide` | Connect to IDE on startup | Interactive | Off | Only if exactly one valid IDE available |

### Initialization

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--init` | Run setup hooks, then start interactive mode | Interactive | Off | |
| `--init-only` | Run setup hooks, then exit | N/A | Off | |
| `--maintenance` | Run setup hooks with maintenance trigger, then exit | N/A | Off | |

### Remote/Web Sessions

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--remote` | Create a web session on claude.ai | N/A | Off | |
| `--teleport` | Resume a web session in local terminal | N/A | Off | |

### Additional

| Flag | Description | Modes | Default | Notes |
|------|-------------|-------|---------|-------|
| `--file` | File resources to download at startup | Interactive + Print | None | |

---

## Output Formats

### `text` (default)

Plain text output. The response body is written directly to stdout.

```bash
claude -p "What is 2+2?"
# Output: 2 + 2 = 4
```

### `json`

Structured JSON with metadata. The response is a single JSON object.

```bash
claude -p "What is 2+2?" --output-format json
```

Key fields in the JSON response:

| Field | Type | Description |
|-------|------|-------------|
| `result` | `string` | The text response |
| `session_id` | `string` | Session UUID for resuming |
| `is_error` | `boolean` | Whether an error occurred |
| `num_turns` | `number` | Number of agentic turns taken |
| `duration_ms` | `number` | Total wall-clock duration |
| `duration_api_ms` | `number` | API call duration |
| `total_cost_usd` | `number` | Total cost in USD |
| `usage` | `object` | Token usage: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens` |
| `modelUsage` | `object` | Per-model usage breakdown |
| `structured_output` | `any` | Present when `--json-schema` is used |

Example extraction with `jq`:

```bash
# Get just the text result
claude -p "Summarize this" --output-format json | jq -r '.result'

# Get the session ID for later resumption
claude -p "Start review" --output-format json | jq -r '.session_id'

# Get structured output
claude -p "List functions" --output-format json \
  --json-schema '{"type":"object","properties":{"fns":{"type":"array","items":{"type":"string"}}}}' \
  | jq '.structured_output'
```

### `stream-json`

Newline-delimited JSON (NDJSON). Each line is a complete JSON object representing a message in the conversation. This enables real-time streaming of the response.

```bash
claude -p "Explain recursion" --output-format stream-json
```

Message types in the stream:

| `type` | Description |
|--------|-------------|
| `system` (subtype: `init`) | First message. Contains `session_id`, `tools`, `model`, `permissionMode`, `mcp_servers` |
| `assistant` | Claude's response messages. Contains `message` with Anthropic API message format |
| `user` | User input messages (relevant for multi-turn) |
| `stream_event` | Partial streaming events (only with `--include-partial-messages`) |
| `system` (subtype: `compact_boundary`) | Conversation compaction occurred |
| `result` | Final message. Contains `result` text, `total_cost_usd`, `usage`, `duration_ms`, `num_turns` |

Result subtypes:

| `subtype` | Description |
|-----------|-------------|
| `success` | Normal completion |
| `error_max_turns` | Hit `--max-turns` limit |
| `error_during_execution` | Runtime error |
| `error_max_budget_usd` | Hit `--max-budget-usd` limit |
| `error_max_structured_output_retries` | Schema validation exhausted retries |

---

## Input Formats

### `text` (default)

The prompt is provided as a CLI argument or piped via stdin.

```bash
# As argument
claude -p "query"

# Piped
echo "query" | claude -p

# File piped
cat code.py | claude -p "review this code"
```

### `stream-json`

Enables a long-lived stdin conversation. You write NDJSON messages to stdin and read NDJSON from stdout. This is the mechanism for multi-turn programmatic conversations without the SDK library.

```bash
claude -p --input-format stream-json --output-format stream-json
```

Input messages follow the `SDKUserMessage` format:

```json
{"type":"user","message":{"role":"user","content":"Hello"}}
```

This is primarily useful for building interactive integrations. For most child-process use cases, simple `text` input is sufficient.

---

## System Prompt Behavior

Understanding the system prompt is critical for cost control and behavior customization.

### Default Behavior (no flags)

When you run `claude -p "query"` with no system prompt flags:

1. The **full Claude Code system prompt** is loaded (~15,000-20,000+ tokens depending on active configuration)
2. This includes: tool usage instructions, code style guidelines, response formatting rules, security instructions, and environment context
3. **CLAUDE.md files are loaded** from the project directory and user home (`~/.claude/CLAUDE.md`) as the first user message
4. **All built-in tools** are available (20+ tools including Bash, Read, Write, Edit, Glob, Grep, WebFetch, WebSearch, Task, etc.)
5. Tool descriptions add significant token overhead (individual descriptions range from 121-2,251 tokens)

### `--system-prompt "custom text"`

**Replaces** the entire default system prompt with your custom text. This is a blank slate:

- All default Claude Code instructions are removed
- Tool descriptions for enabled tools are still included (tool descriptions are separate from the system prompt)
- CLAUDE.md files may still be loaded depending on setting sources
- You lose: code style guidelines, response formatting, safety instructions, environment context

```bash
claude -p --system-prompt "You are a commit message generator. Output only the commit message, nothing else." "Generate a commit for these changes"
```

### `--append-system-prompt "additional text"`

**Appends** your text to the end of the default system prompt. The safest option:

- All default capabilities are preserved
- Your instructions are added at the end
- CLAUDE.md files are still loaded
- Full tool access remains

```bash
claude -p --append-system-prompt "Always respond in JSON format" "List the files"
```

### `--system-prompt-file` and `--append-system-prompt-file`

File-based equivalents of the above. Print mode only. Useful for version-controlled prompts.

```bash
claude -p --system-prompt-file ./my-prompt.txt "query"
claude -p --append-system-prompt-file ./extra-rules.txt "query"
```

### Combining flags

- `--system-prompt` and `--system-prompt-file` are **mutually exclusive**
- The append flags can be used **together** with either replacement flag
- Example: `--system-prompt "base" --append-system-prompt "extra"` works

### CLAUDE.md Loading

CLAUDE.md is injected as the first user message, not as part of the system prompt itself. The content is loaded from:

- `./CLAUDE.md` or `./.claude/CLAUDE.md` (project-level)
- `~/.claude/CLAUDE.md` (user-level, loaded for all projects)
- Additional directories specified via `--add-dir`

To suppress CLAUDE.md loading via the CLI: use `--setting-sources` with only the sources you want (omitting `project` prevents project CLAUDE.md loading). However, the CLI does not have a straightforward way to fully suppress CLAUDE.md loading in print mode the way the SDK does.

In the **Agent SDK**, CLAUDE.md is only loaded when you explicitly set `settingSources: ['project']`. The SDK defaults to loading no filesystem settings at all.

---

## Tool Configuration

### Available Built-in Tools

Claude Code includes 20+ built-in tools:

| Tool | Description |
|------|-------------|
| `Read` | Read files (text, images, PDFs, notebooks) |
| `Write` | Create/overwrite files |
| `Edit` | Precise string replacements in files |
| `Bash` | Execute shell commands |
| `Glob` | File pattern matching |
| `Grep` | Search file contents with regex |
| `WebFetch` | Fetch and process web content |
| `WebSearch` | Search the web |
| `Task` | Spawn subagent for complex tasks |
| `TodoWrite` | Manage task lists |
| `NotebookEdit` | Edit Jupyter notebooks |
| `AskUserQuestion` | Ask user clarifying questions |
| `KillBash` | Kill background shell processes |
| `BashOutput` | Read output from background shells |
| `ListMcpResources` | List MCP resources |
| `ReadMcpResource` | Read MCP resources |
| `ExitPlanMode` | Exit planning mode |
| `ToolSearch` | Discover deferred tools on-demand |
| Computer (Chrome) | Browser automation (when Chrome enabled) |

### `--tools` Flag

Controls which tools are **available** to the model:

```bash
# All tools (default)
claude -p --tools "default" "query"

# Specific tools only
claude -p --tools "Bash,Read,Grep" "query"

# Disable ALL tools (minimal mode, text generation only)
claude -p --tools "" "query"
```

When you pass `--tools ""`:
- No built-in tool descriptions are sent to the model
- The model cannot perform any actions (no file I/O, no commands)
- This significantly reduces token overhead
- Claude behaves as a pure text-generation assistant

### `--allowedTools` Flag

Controls which tools **auto-execute without permission prompts**. This does NOT restrict which tools are available; it controls the permission behavior:

```bash
# Auto-approve specific tools
claude -p --allowedTools "Read,Grep,Glob" "query"

# With prefix matching (note the space before *)
claude -p --allowedTools "Bash(git diff *)" "Bash(git log *)" "Read" "query"
```

Permission rule syntax supports:
- Exact tool names: `"Read"`, `"Edit"`, `"Bash"`
- Prefix matching: `"Bash(git diff *)"` (matches any command starting with `git diff `)
- The space before `*` is important: `Bash(git diff*)` would also match `git diff-index`

### `--disallowedTools` Flag

Completely removes tools from the model's context:

```bash
# Prevent web access
claude -p --disallowedTools "WebFetch,WebSearch" "query"
```

### Interaction Between Flags

- `--tools` defines the **pool** of available tools
- `--allowedTools` defines which of those tools auto-execute
- `--disallowedTools` removes tools from the pool entirely
- `--disallowedTools` takes precedence over `--allowedTools`

### Cost Implications

Each enabled tool adds its description to the system context. To minimize token usage:
1. Use `--tools "Read,Grep,Glob"` to restrict to only needed tools
2. Use `--tools ""` for pure text generation (maximum savings)
3. Avoid loading unnecessary MCP servers

---

## Session Persistence

### Default Behavior

By default, Claude Code saves session data to disk so conversations can be resumed later.

**Storage location:** `~/.claude/projects/`

Each project gets a subdirectory named by path (separators replaced with hyphens):
- `/Users/trent/working_dir/myproject` becomes `~/.claude/projects/-Users-trent-working_dir-myproject/`
- Inside: `.jsonl` files named by session UUID containing the full conversation transcript

### What Gets Saved

- Complete conversation history
- Tool invocations and results
- File contexts and permissions
- Working directory state

### `--no-session-persistence`

Prevents the session from being saved to disk:

```bash
claude -p --no-session-persistence "query"
```

Use this when:
- Running ephemeral tasks that do not need to be resumed
- Processing sensitive data you do not want on disk
- Running in CI/CD where persistence is unnecessary
- Spawning many parallel processes (reduces filesystem I/O)

Without this flag, even `-p` mode saves sessions, allowing later `--continue` or `--resume`.

### Resuming Sessions

```bash
# Continue most recent in this directory
claude -p --continue "follow-up query"

# Resume specific session
claude -p --resume "session-uuid" "follow-up query"

# Capture session ID for later resumption
session_id=$(claude -p "Start analysis" --output-format json | jq -r '.session_id')
claude -p --resume "$session_id" "Continue analysis"
```

---

## Cost and Token Usage

### Where Tokens Go

A simple `claude -p "say hello"` uses approximately:

| Component | Approximate Tokens | Notes |
|-----------|-------------------|-------|
| System prompt (core) | ~269 base | Grows significantly with conditional sections |
| Tool descriptions | ~5,000-15,000 | Depends on number of enabled tools |
| CLAUDE.md content | Variable | Injected as first user message |
| MCP server tool definitions | Variable | Each server adds definitions (e.g., Jira ~17K tokens) |
| Dynamic context (reminders, etc.) | ~1,000-3,000 | Environment-dependent |
| **Total system overhead** | **~15,000-20,000+** | Before your prompt even starts |

The ~33K cache tokens observed from a simple "say hello" is consistent with the full system prompt + tool descriptions + CLAUDE.md loading. Anthropic's prompt caching helps: after the first request, subsequent requests read from cache rather than re-processing the system prompt.

### Minimizing Cost

**For pure text generation (no tools needed):**
```bash
claude -p --tools "" --no-session-persistence --system-prompt "You are a helpful assistant." "query"
```
This eliminates: tool descriptions, default system prompt overhead, and session I/O.

**For limited tool access:**
```bash
claude -p --tools "Read,Grep" --no-session-persistence "query"
```

**Key cost levers:**
1. `--tools ""` -- Eliminates all tool description tokens
2. `--system-prompt "minimal"` -- Replaces the large default system prompt
3. `--no-session-persistence` -- Eliminates disk I/O (not token savings, but latency savings)
4. `--max-turns 1` -- Prevents multi-step agentic loops
5. `--max-budget-usd 0.50` -- Hard cost cap

### Cache Behavior

Claude Code uses Anthropic's prompt caching. The system prompt and tool descriptions are marked with `cache_control`, so:
- First request: full token input cost (cache write)
- Subsequent requests (within cache TTL): reduced cost via cache reads
- Cache tokens show up as `cache_creation_input_tokens` and `cache_read_input_tokens` in usage

---

## Permission Modes

| Mode | Behavior |
|------|----------|
| `default` | Standard: prompts for each tool use |
| `acceptEdits` | Auto-accepts file edits, prompts for other tools |
| `bypassPermissions` | Skips all permission checks (requires `--dangerously-skip-permissions` or `--allow-dangerously-skip-permissions`) |
| `plan` | Planning mode: no execution, generates plan only |
| `delegate` | Delegates permission decisions |
| `dontAsk` | Does not ask for permissions; skips tools that would require permission |

For child process usage, you typically want either:
- `--allowedTools "specific,tools"` with default permission mode (most control)
- `--dangerously-skip-permissions` (when running in a sandbox/container)

---

## The Agent SDK (Programmatic API)

The **Claude Agent SDK** (formerly "Claude Code SDK") provides a proper programmatic interface for building with Claude Code's capabilities. It is the recommended approach for production integrations over spawning CLI processes.

### Package Names

| Package | Purpose | Install |
|---------|---------|---------|
| `@anthropic-ai/claude-code` | The CLI tool itself | `npm install -g @anthropic-ai/claude-code` |
| `@anthropic-ai/claude-agent-sdk` | TypeScript SDK for programmatic use | `npm install @anthropic-ai/claude-agent-sdk` |
| `claude-agent-sdk` | Python SDK | `pip install claude-agent-sdk` |

### TypeScript SDK Usage

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Basic usage
for await (const message of query({
  prompt: "Find and fix the bug in auth.py",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  if ("result" in message) console.log(message.result);
}
```

### Key `query()` Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prompt` | `string \| AsyncIterable<SDKUserMessage>` | Required | The input prompt or streaming messages |
| `allowedTools` | `string[]` | All tools | Tools allowed without prompting |
| `disallowedTools` | `string[]` | `[]` | Tools completely removed |
| `tools` | `string[] \| { type: 'preset', preset: 'claude_code' }` | `undefined` | Tool configuration |
| `systemPrompt` | `string \| { type: 'preset', preset: 'claude_code', append?: string }` | Minimal prompt | System prompt config |
| `settingSources` | `('user' \| 'project' \| 'local')[]` | `[]` (none) | Which filesystem settings to load |
| `model` | `string` | CLI default | Model to use |
| `maxTurns` | `number` | `undefined` | Max conversation turns |
| `maxBudgetUsd` | `number` | `undefined` | Cost limit |
| `permissionMode` | `PermissionMode` | `'default'` | Permission behavior |
| `cwd` | `string` | `process.cwd()` | Working directory |
| `resume` | `string` | `undefined` | Session ID to resume |
| `mcpServers` | `Record<string, McpServerConfig>` | `{}` | MCP server configs |
| `agents` | `Record<string, AgentDefinition>` | `undefined` | Custom subagents |
| `canUseTool` | `CanUseTool` | `undefined` | Custom permission callback |
| `hooks` | Hook config | `{}` | Lifecycle hook callbacks |
| `abortController` | `AbortController` | `new AbortController()` | Cancellation control |
| `includePartialMessages` | `boolean` | `false` | Stream partial messages |
| `env` | `Record<string, string>` | `process.env` | Environment variables |
| `outputFormat` | `{ type: 'json_schema', schema: JSONSchema }` | `undefined` | Structured output schema |

### SDK vs CLI Key Differences

| Aspect | CLI (`claude -p`) | Agent SDK (`query()`) |
|--------|-------------------|----------------------|
| **Default system prompt** | Full Claude Code prompt | **Minimal prompt** (tool instructions only) |
| **CLAUDE.md loading** | Automatic | Only with `settingSources: ['project']` |
| **Tool availability** | All tools by default | All tools by default |
| **Session persistence** | On by default | Managed programmatically |
| **Permission handling** | CLI prompts or flags | Callback function (`canUseTool`) |
| **Output** | stdout text/json | Typed async generator of `SDKMessage` objects |
| **Multi-turn** | Via `--continue`/`--resume` | Via `resume` option or streaming input |

### SDK Message Types

The `query()` function returns an `AsyncGenerator<SDKMessage>`. Message types:

- `SDKSystemMessage` (`type: 'system'`, `subtype: 'init'`) -- Session initialization with metadata
- `SDKAssistantMessage` (`type: 'assistant'`) -- Claude's responses
- `SDKUserMessage` (`type: 'user'`) -- User messages (in multi-turn)
- `SDKPartialAssistantMessage` (`type: 'stream_event'`) -- Streaming chunks (when enabled)
- `SDKResultMessage` (`type: 'result'`) -- Final result with cost, usage, duration
- `SDKCompactBoundaryMessage` (`type: 'system'`, `subtype: 'compact_boundary'`) -- Compaction events

### SDK Result Message Structure

```typescript
{
  type: 'result',
  subtype: 'success',
  session_id: string,
  duration_ms: number,
  duration_api_ms: number,
  is_error: boolean,
  num_turns: number,
  result: string,           // The text response
  total_cost_usd: number,
  usage: {
    input_tokens: number,
    output_tokens: number,
    cache_creation_input_tokens: number,
    cache_read_input_tokens: number
  },
  modelUsage: {
    [modelName: string]: {
      inputTokens: number,
      outputTokens: number,
      cacheReadInputTokens: number,
      cacheCreationInputTokens: number,
      webSearchRequests: number,
      costUSD: number,
      contextWindow: number
    }
  },
  structured_output?: unknown  // When using outputFormat
}
```

### SDK Minimal Example for Text Generation

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

// Minimal overhead: no tools, no CLAUDE.md, custom system prompt
for await (const message of query({
  prompt: "Generate a commit message for: added user authentication",
  options: {
    systemPrompt: "You are a commit message generator. Output only the commit message.",
    tools: [],           // No tools
    // settingSources omitted = no CLAUDE.md loading
    maxTurns: 1,
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true
  }
})) {
  if (message.type === "result" && message.subtype === "success") {
    console.log(message.result);
  }
}
```

---

## Common Invocation Patterns

### Simple text generation (minimal overhead)

```bash
claude -p --tools "" --system-prompt "You are a helpful assistant." \
  --no-session-persistence "What is the capital of France?"
```

### Code review with limited tools

```bash
claude -p --tools "Read,Grep,Glob" \
  --allowedTools "Read,Grep,Glob" \
  --no-session-persistence \
  --append-system-prompt "Focus on security vulnerabilities." \
  "Review the authentication module"
```

### Commit message generation

```bash
git diff --staged | claude -p --tools "" \
  --system-prompt "Generate a concise git commit message for these changes. Output only the message." \
  --no-session-persistence --max-turns 1
```

### Structured output

```bash
claude -p --output-format json \
  --json-schema '{"type":"object","properties":{"summary":{"type":"string"},"issues":{"type":"array","items":{"type":"string"}}},"required":["summary","issues"]}' \
  "Analyze this codebase for common issues"
```

### Multi-turn conversation

```bash
# First turn
session_id=$(claude -p "Start analyzing the auth module" \
  --output-format json | jq -r '.session_id')

# Follow-up turns
claude -p --resume "$session_id" "Now check for SQL injection"
claude -p --resume "$session_id" "Generate a summary"
```

### CI/CD with cost and turn limits

```bash
claude -p "Review this PR for issues" \
  --max-turns 5 \
  --max-budget-usd 1.00 \
  --allowedTools "Read,Grep,Glob" \
  --output-format json \
  --no-session-persistence
```

### Custom subagents

```bash
claude -p --agents '{
  "reviewer": {
    "description": "Code review specialist",
    "prompt": "You review code for bugs and security issues.",
    "tools": ["Read", "Grep", "Glob"],
    "model": "sonnet"
  }
}' "Use the reviewer agent to check auth.py"
```

---

## Agents JSON Format

The `--agents` flag accepts a JSON object:

```json
{
  "agent-name": {
    "description": "When to use this agent (required)",
    "prompt": "System prompt for the agent (required)",
    "tools": ["Read", "Edit", "Bash"],
    "model": "sonnet"
  }
}
```

| Field | Required | Type | Description |
|-------|----------|------|-------------|
| `description` | Yes | `string` | Natural language description of when to invoke |
| `prompt` | Yes | `string` | The agent's system prompt |
| `tools` | No | `string[]` | Specific tools (inherits all if omitted) |
| `model` | No | `'sonnet' \| 'opus' \| 'haiku' \| 'inherit'` | Model override (defaults to `inherit`) |

---

## Source Documentation

### Official Anthropic Documentation

- [CLI Reference](https://code.claude.com/docs/en/cli-reference) -- Complete CLI flags and commands
- [Run Claude Code Programmatically (Headless)](https://code.claude.com/docs/en/headless) -- Print mode and automation
- [Agent SDK Overview](https://platform.claude.com/docs/en/agent-sdk/overview) -- SDK architecture and capabilities
- [Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) -- Full TypeScript API types and functions
- [Modifying System Prompts](https://platform.claude.com/docs/en/agent-sdk/modifying-system-prompts) -- System prompt customization guide
- [Claude Code Settings](https://code.claude.com/docs/en/settings) -- Configuration and permission settings
- [Claude Code Changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) -- Version history

### NPM Packages

- [@anthropic-ai/claude-code](https://www.npmjs.com/package/@anthropic-ai/claude-code) -- CLI package (v2.1.12 at time of research)
- [@anthropic-ai/claude-agent-sdk](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) -- TypeScript SDK

### Community Resources

- [Claude Code System Prompts](https://github.com/Piebald-AI/claude-code-system-prompts) -- Extracted system prompt components and token counts
- [Claude Code GitHub](https://github.com/anthropics/claude-code) -- Official repository and issues
- [Claude Agent SDK TypeScript](https://github.com/anthropics/claude-agent-sdk-typescript) -- SDK source and changelog

---

## Appendix: Behavioral Notes

### Extended Thinking

Claude Code uses extended thinking by default. This is not directly controllable via CLI flags, but the SDK exposes `maxThinkingTokens` as an option. The thinking tokens contribute to total token usage and cost.

### Model Defaults

- The default model depends on your account/subscription (typically Claude Sonnet 4.5 for most users)
- The `--model` flag accepts aliases (`sonnet`, `opus`, `haiku`) or full model IDs
- Each subagent can override the model independently

### Rate Limits and Overload

- Use `--fallback-model` (print mode only) to automatically switch models when the primary is overloaded
- Example: `claude -p --fallback-model haiku "query"` falls back to Haiku if Sonnet is overloaded

### Prompt Caching Across Requests

When spawning multiple `claude -p` processes:
- Each process establishes its own API connection
- Anthropic's server-side prompt caching may still benefit subsequent requests if the system prompt is identical
- The cache TTL is managed by Anthropic's servers (typically 5 minutes)
- Using `--no-session-persistence` does not affect prompt caching (which is API-level, not filesystem-level)

### Process Exit Codes

- `0` -- Success
- Non-zero -- Error occurred (including `--max-turns` exceeded)

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | API key for authentication |
| `CLAUDE_CODE_USE_BEDROCK` | Set to `1` for Amazon Bedrock |
| `CLAUDE_CODE_USE_VERTEX` | Set to `1` for Google Vertex AI |
| `CLAUDE_CODE_USE_FOUNDRY` | Set to `1` for Microsoft Foundry |
