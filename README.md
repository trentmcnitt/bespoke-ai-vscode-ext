# Bespoke AI

A VS Code / VSCodium extension that provides inline ghost-text completions for both prose and code, powered by the Claude Code CLI.

## Why This Exists

Most AI coding assistants are built for code. They treat prose as an afterthought — if they handle it at all. This extension is built for writers who also code. The primary use case is natural prose continuation in markdown and plaintext files, with code completion as a full peer feature rather than the sole focus.

The extension auto-detects whether you're writing prose or code and adjusts its behavior accordingly.

## How It Works

### Three Modes

| Mode      | Activates for                                        | Strategy                                                         |
| --------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| **Prose** | `markdown`, `plaintext`, `latex`, `restructuredtext` | Continuation-style prompting. Match voice, style, and format.    |
| **Code**  | All recognized programming languages                 | Fill-in-the-middle with prefix + suffix context. Language-aware. |
| **Auto**  | Default                                              | Auto-selects prose or code based on `document.languageId`.       |

The mode is auto-detected but can be overridden via settings or the status bar menu. Unrecognized languages default to prose.

### Backend

**Claude Code** — via `@anthropic-ai/claude-agent-sdk`. The extension spawns Claude Code subprocesses and reuses them across multiple completions (1-slot pool, up to 8 completions per slot before recycling). Uses a `>>>CURSOR<<<` marker approach with `<completion_start>` anchoring. Same prompt structure for prose and code — the model infers the content type.

Requires the `claude` CLI to be installed. No API key needed (uses Claude Code subscription).

### Request Lifecycle

```
User types
  → VS Code fires InlineCompletionItemProvider
  → Detect mode (prose/code)
  → Extract prefix + suffix from document
  → Check LRU cache (50 entries, 5min TTL)
  → Debounce (1000ms base, adaptive back-off on dismissals)
  → Acquire a slot from the session pool
  → Build prompt with >>>CURSOR<<< marker
  → Get completion from Claude Code
  → Post-process (strip echoed prefix, trim suffix overlap)
  → Cache result → return InlineCompletionItem
```

## Configuration

All settings are under `bespokeAI.*` in VS Code/VSCodium settings.

### General

| Setting      | Type                               | Default  | Description                               |
| ------------ | ---------------------------------- | -------- | ----------------------------------------- |
| `enabled`    | boolean                            | `true`   | Master on/off toggle                      |
| `mode`       | `"auto"` \| `"prose"` \| `"code"`  | `"auto"` | Completion mode (auto-detects by default) |
| `debounceMs` | number                             | `8000`   | Delay before triggering a completion      |
| `logLevel`   | `"info"` \| `"debug"` \| `"trace"` | `"info"` | Logging verbosity in the Output channel   |

### Claude Code

| Setting             | Type     | Default                       | Description                              |
| ------------------- | -------- | ----------------------------- | ---------------------------------------- |
| `claudeCode.model`  | string   | `"haiku"`                     | Active model (e.g., haiku, sonnet, opus) |
| `claudeCode.models` | string[] | `["haiku", "sonnet", "opus"]` | Available models catalog                 |

### Prose Mode

| Setting              | Type     | Default                     | Description                               |
| -------------------- | -------- | --------------------------- | ----------------------------------------- |
| `prose.contextChars` | number   | `2000`                      | Prefix context window (characters)        |
| `prose.suffixChars`  | number   | `2500`                      | Suffix context window (characters)        |
| `prose.fileTypes`    | string[] | `["markdown", "plaintext"]` | Additional language IDs to treat as prose |

### Code Mode

| Setting             | Type   | Default | Description                        |
| ------------------- | ------ | ------- | ---------------------------------- |
| `code.contextChars` | number | `4000`  | Prefix context window (characters) |
| `code.suffixChars`  | number | `2500`  | Suffix context window (characters) |

## Commands & Keybindings

| Command                               | Keybinding | Description                         |
| ------------------------------------- | ---------- | ----------------------------------- |
| `Bespoke AI: Trigger Completion`      | `Ctrl+L`   | Manually trigger a completion       |
| `Bespoke AI: Toggle Enabled`          | —          | Toggle the extension on/off         |
| `Bespoke AI: Cycle Mode`              | —          | Cycle through auto → prose → code   |
| `Bespoke AI: Clear Completion Cache`  | —          | Clear the LRU cache                 |
| `Bespoke AI: Show Menu`               | —          | Status bar menu (click status bar)  |
| `Bespoke AI: Generate Commit Message` | —          | AI-generated commit message via SCM |

## Setup

### Prerequisites

- Node.js 18+
- VS Code or VSCodium 1.85+
- `claude` CLI installed (Claude Code subscription)

### Install & Build

```sh
npm install
npm run compile
```

### Development

```sh
npm run watch    # esbuild watch mode
# Press F5 in VS Code to launch Extension Development Host
```

### Package & Install

```sh
npm run install-ext    # Compile, package VSIX, install into VSCodium
```

### Quality Checks

```sh
npm run check          # Lint + type-check
npm run test:unit      # Unit tests
npm run test:api       # API integration tests (needs claude CLI)
npm run test:quality   # LLM-as-judge quality tests (needs claude CLI)
```

## Key Design Decisions

**Prose-first defaults.** Unrecognized language IDs fall back to prose mode, not code. This reflects the primary use case.

**Single backend.** Claude Code is the sole provider. Direct API providers (Anthropic, Ollama) were removed to simplify the architecture. See `API_RETURN_NOTES.md` for context on this decision and notes on potentially restoring them.

**Session reuse.** Each Claude Code subprocess serves up to 8 completions before recycling via a 1-slot pool.

**No streaming.** Ghost text must be returned as a complete string. The VS Code inline completion API doesn't support incremental rendering.

**LRU cache with TTL.** Prevents redundant API calls when the user's cursor returns to a previously-completed position. 50 entries, 5-minute TTL.
