<p align="center">
  <img src="images/icon.png" alt="Bespoke AI" width="128">
</p>

<h1 align="center">Bespoke AI</h1>

<p align="center">
  <strong>AI autocomplete for prose and code in VS Code — powered by your Claude subscription or API key</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=trentmcnitt.bespoke-ai"><img src="https://img.shields.io/visual-studio-marketplace/v/trentmcnitt.bespoke-ai" alt="VS Code Marketplace"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

> **Early release** — Please bear with the rough edges. 👷 Expect occasional bugs and fluctuating (or poor) quality in some scenarios. [Open an issue](https://github.com/trentmcnitt/bespoke-ai-vscode-ext/issues) if you run into any problems.

**💻 macOS, Linux, and Windows** — Also works in VSCodium.

**🖊️ Writing, not just code** — Inline completions for prompts, journals, notes, docs, and code. Matches your voice and style in prose; language-aware in code.

**🔑 Subscription or API key** — Use your Claude subscription through Claude Code (no per-token costs), or bring your own API key from xAI, OpenAI, Anthropic, Google, OpenRouter, or Ollama.

**✨ One-click commit messages** — Hit the sparkle button in Source Control to generate a commit message from your staged diffs.

**✏️ Suggest edits** — One-command typo, grammar, and bug fixes for visible text.

**🔧 Context menu** — Right-click to Explain, Fix, or Do custom actions on selected text. *(Requires Claude Code backend.)*

### Screenshots

**Writing** — autocompleting a prompt to Claude:

<img src="images/demo-writing.png" alt="Writing completion demo" width="700">

**Code** — filling in a function body:

<img src="images/demo-code.jpg" alt="Code completion demo" width="700">

**Commit messages** — the sparkle button in Source Control:

<img src="images/source-control.png" alt="Commit message sparkle button" width="400">

## 🚀 Getting Started

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=trentmcnitt.bespoke-ai) (search for "Bespoke AI")
2. On first launch, the extension detects whether you have the Claude Code CLI — if not, it offers to help you set it up or switch to **API key** mode
3. Start typing — completions appear as gray suggestion text after a ~2-second pause

That's it. For Claude Code CLI, the extension walks you through setup. For API mode, set `bespokeAI.backend` to `api` and choose a model from the status bar menu. Details for each path below.

<details>
<summary><strong>Claude subscription</strong> — no per-token costs, uses your existing Claude Pro/Team/Enterprise plan</summary>

1. [Install Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup): `curl -fsSL https://claude.ai/install.sh | bash` (macOS/Linux) or `npm install -g @anthropic-ai/claude-code` (any platform)
2. Run `claude` in your terminal and follow the login prompts
3. Reload VS Code — the extension detects the CLI automatically

The default model is Sonnet — best balance of quality and speed. Switch models anytime via the status bar menu.

</details>

<details>
<summary><strong>API key</strong> — pay per token with xAI, OpenAI, Anthropic, Google, OpenRouter, or Ollama</summary>

1. Choose **"Use an API key instead"** when prompted (or set `bespokeAI.backend` to `api` in settings)
2. Run **Bespoke AI: Enter API Key** from the Command Palette (`Ctrl/Cmd+Shift+P`) to store your key securely

The default model is [Grok 4.1 Fast](https://console.x.ai/) by xAI — fast, affordable, and high quality. Change models anytime via the status bar menu. See [Available Models](#available-models) for the full list.

</details>

### Triggering Completions

Completions appear automatically after a ~2-second pause (the `relaxed` preset). Press **Alt+Enter** to trigger one instantly at any time.

> If `Alt+Enter` doesn't work, another keybinding is likely intercepting it. Open Keyboard Shortcuts (`Ctrl/Cmd+K Ctrl/Cmd+S`), search for `alt+enter`, and rebind any conflicts — **Inline Chat** is the most common one.

Change trigger behavior via the status bar menu: `relaxed` (~2s), `eager` (~800ms), or `on-demand` (Alt+Enter only).

### Modes

| Mode | Activates for | Strategy |
|------|---------------|----------|
| **Writing** | `markdown`, `plaintext`, `latex`, `restructuredtext`, and others | Continuation-style. Matches voice, style, and format. |
| **Code** | All recognized programming languages | Uses code before and after your cursor, language-aware. |
| **Auto** *(default)* | — | Selects Writing or Code based on file type. |

Override via settings or the status bar menu.

## 💡 Why This Exists

I tried every open-source AI autocomplete extension I could find. Most handled code fine but fell apart with prose — breaking paragraphs mid-thought, injecting code syntax into journal entries, producing gibberish outside of source files. Nothing came close to Copilot for non-code text.

So I built my own. And since I was already paying for a Claude subscription, I realized I could wire it up to use Claude Code instead of raw API calls — getting frontier model completions (Haiku, Sonnet, even Opus) at no additional per-request cost. Built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), it took extensive prompt engineering, but the result handles writing just as well as code.

*The Claude Code backend uses your existing subscription (Pro, Team, or Enterprise). Heavy use may be subject to Anthropic's rate limits. The API backend uses standard per-token pricing from your chosen provider.*

## 🧩 Available Models

The API backend includes presets for popular providers. Change the active preset via the status bar menu or the `bespokeAI.api.preset` setting.

| Preset | Provider | Model |
|--------|----------|-------|
| `xai-grok` *(default)* | [xAI](https://console.x.ai/) | grok-4-1-fast-non-reasoning |
| `xai-grok-code` | [xAI](https://console.x.ai/) | grok-code-fast-1 |
| `xai-grok-4` | [xAI](https://console.x.ai/) | grok-4-0709 |
| `anthropic-haiku` | [Anthropic](https://console.anthropic.com/) | claude-haiku-4-5 |
| `anthropic-sonnet` | [Anthropic](https://console.anthropic.com/) | claude-sonnet-4-5 |
| `openai-gpt-4.1-nano` | [OpenAI](https://platform.openai.com/) | gpt-4.1-nano |
| `openai-gpt-4o-mini` | [OpenAI](https://platform.openai.com/) | gpt-4o-mini |
| `google-gemini-flash` | [Google](https://aistudio.google.com/) | gemini-2.5-flash |
| `openrouter-haiku` | [OpenRouter](https://openrouter.ai/) | anthropic/claude-haiku-4.5 |
| `openrouter-gpt-4.1-nano` | [OpenRouter](https://openrouter.ai/) | openai/gpt-4.1-nano |
| `ollama-default` | [Ollama](https://ollama.com/) *(local, free)* | qwen2.5-coder:7b |
| `ollama-qwen3-4b` | [Ollama](https://ollama.com/) *(local, free)* | qwen3:4b |
| `ollama-qwen3-8b` | [Ollama](https://ollama.com/) *(local, free)* | qwen3:8b |

**API keys:** Store keys via the **Enter API Key** command (Command Palette → "Enter API Key"). Keys are saved in your OS keychain. As a fallback, the extension also checks environment variables and `~/.creds/api-keys.env`:

xAI → `XAI_API_KEY` · Anthropic → `ANTHROPIC_API_KEY` · OpenAI → `OPENAI_API_KEY` · Google → `GEMINI_API_KEY` · OpenRouter → `OPENROUTER_API_KEY` · Ollama → no key needed

**Custom models:** Run **Bespoke AI: Add Custom Model** from the Command Palette for a guided setup wizard. Any OpenAI-compatible endpoint works (LM Studio, Together, Mistral, etc.), plus Anthropic, Google, and OpenRouter. You can also add presets manually:

```json
"bespokeAI.api.customPresets": [
  { "name": "My Llama", "provider": "openai-compat", "modelId": "llama3.2", "baseUrl": "http://localhost:1234/v1" }
]
```

## ⚙️ Configuration

All settings live under `bespokeAI.*` in VS Code settings.

<details>
<summary><strong>General</strong></summary>

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Master on/off toggle |
| `mode` | `"auto"` | Completion mode (auto-detects) |
| `triggerPreset` | `"relaxed"` | Trigger preset: `relaxed` (~2s), `eager` (~800ms), `on-demand` (Alt+Enter only) |
| `debounceMs` | `2000` | Override the debounce delay from your trigger preset |
| `logLevel` | `"info"` | Logging verbosity in Output channel |

</details>

<details>
<summary><strong>Backend</strong></summary>

| Setting | Default | Description |
|---------|---------|-------------|
| `backend` | `"claude-code"` | Active backend: `claude-code` (CLI) or `api` (HTTP) |
| `api.preset` | `"xai-grok"` | Active API model (dropdown in settings, or status bar menu) |

</details>

<details>
<summary><strong>Model (Claude Code backend)</strong></summary>

| Setting | Default | Description |
|---------|---------|-------------|
| `claudeCode.model` | `"sonnet"` | Active model (sonnet, haiku, opus, etc.) |
| `claudeCode.models` | `["haiku", "sonnet", "opus"]` | Available models catalog |

</details>

<details>
<summary><strong>Context Windows</strong></summary>

| Setting | Default | Description |
|---------|---------|-------------|
| `prose.contextChars` | `2500` | Prefix context (characters) for writing |
| `prose.suffixChars` | `2000` | Suffix context (characters) for writing |
| `prose.fileTypes` | `[]` | Additional language IDs to treat as writing |
| `code.contextChars` | `2500` | Prefix context (characters) for code |
| `code.suffixChars` | `2000` | Suffix context (characters) for code |

</details>

<details>
<summary><strong>Code Override</strong></summary>

Route code completions to a different backend or model than prose. For example, use Claude Code CLI for writing and an xAI preset for code — or vice versa.

| Setting | Default | Description |
|---------|---------|-------------|
| `codeOverride.backend` | `""` | Backend for code files: `claude-code`, `api`, or empty (use global default) |
| `codeOverride.model` | `""` | Model for code files. CLI: model name (e.g. `haiku`). API: preset ID (e.g. `xai-grok-code`). Empty = default. |

</details>

<details>
<summary><strong>Context Menu Permissions</strong></summary>

| Setting | Default | Description |
|---------|---------|-------------|
| `contextMenu.permissionMode` | `"default"` | Permission mode for Explain, Fix, Do |

Options:

- **`default`** — Ask before every action (safest)
- **`acceptEdits`** — Auto-approve file reads and edits
- **`bypassPermissions`** — Skip all permission checks (use with caution)

</details>

## 📋 Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| `Trigger Completion` | `Alt+Enter` | Manually trigger a completion |
| `Toggle Enabled` | — | Toggle the extension on/off |
| `Cycle Mode` | — | Cycle through auto → prose → code |
| `Clear Completion Cache` | — | Clear the LRU cache |
| `Show Menu` | — | Status bar menu |
| `Generate Commit Message` | — | AI commit message from staged diffs |
| `Suggest Edits` | — | Fix typos/grammar/bugs in visible text |
| `Explain` / `Fix` / `Do` | — | Context menu actions on selected text |
| `Enter API Key` | — | Store an API key in the OS keychain |
| `Remove API Key` | — | Remove a stored API key |
| `Add Custom Model` | — | Guided wizard to add a custom API model |
| `Remove Custom Model` | — | Remove a custom API model |
| `Restart Pools` | — | Restart Claude Code subprocesses |

<details>
<summary><strong>Architecture</strong></summary>

```
User types → Mode detection → Context extraction → LRU cache check
  → Debounce → Backend Router → Claude Code CLI or API → Cleanup → Ghost text
```

A **backend router** dispatches requests to the active backend. The **Claude Code CLI** backend uses the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) and manages subprocesses through a shared pool server — multiple VS Code windows share subprocesses via IPC (Unix sockets on macOS/Linux, named pipes on Windows). The **API** backend makes direct HTTP calls to Anthropic, OpenAI-compatible (OpenAI, Google Gemini, xAI, OpenRouter), or local Ollama endpoints.

All backends share the same prompt strategy (`{{FILL_HERE}}` marker, `<COMPLETION>` tags) with backend-specific extraction (prefill for Anthropic API, preamble stripping for OpenAI-compat).

**Key design decisions:**

| Decision | Rationale |
|----------|-----------|
| Writing-first defaults | Unrecognized languages fall back to writing, not code |
| Dual backend | Claude Code CLI for subscribers, API for key-based access |
| Shared prompts | Same system prompt across all backends — only extraction differs |
| No streaming | VS Code's inline completion API requires complete strings |
| LRU cache (50 entries) | 5-minute TTL prevents redundant calls when revisiting positions |
| Session reuse (CLI) | One subprocess serves many requests — avoids cold-start per call |

</details>

## 🔍 Troubleshooting

**Completions not appearing?**

- Check the status bar — is it showing "AI Off"? Click to re-enable.
- If it shows "Setup needed", the Claude Code CLI may not be installed or authenticated.
- Check if trigger preset is "on-demand" — in that mode, press `Alt+Enter` to trigger.
- Open the Output panel ("Bespoke AI") and check for errors.
- Run the "Bespoke AI: Restart Pools" command from the Command Palette.

**"Claude Code CLI not found"?**

- Install Claude Code: `curl -fsSL https://claude.ai/install.sh | bash` (macOS/Linux) or `npm install -g @anthropic-ai/claude-code` (any platform)
- Restart VS Code after installation.

**"Authentication required"?**

- Run `claude` in your terminal and follow the login prompts.
- Ensure you have an active Claude subscription (Pro, Team, or Enterprise).

**Windows: Explain/Fix/Do commands garbled?**

- Context menu commands use bash-style shell escaping. On Windows with PowerShell or cmd.exe, text containing `$`, backticks, or special characters may not pass through correctly.
- Workaround: set your VS Code terminal to Git Bash or WSL.

**Still not working?**

- Check for orphaned processes:
  - macOS/Linux: `pkill -f "claude.*dangerously-skip-permissions"`
  - Windows: Use Task Manager to end `node.exe` processes running Claude
- Check for a stale lockfile at `~/.bespokeai/pool.lock` and remove it.
- Disable and re-enable the extension.

## 🔒 Privacy

Bespoke AI sends the text surrounding your cursor (prefix and suffix context) to the configured backend for completion. Commit message generation sends your staged diff, and suggest edits sends the visible editor content. No other files or data are transmitted. When using the Claude Code CLI backend, requests go through your local Claude Code installation. When using the API backend, requests go directly to your chosen provider's API endpoint. All API keys are stored in your OS keychain via VS Code SecretStorage.

## 🛠️ Development

```sh
npm install && npm run compile    # Build
npm run watch                     # Watch mode (F5 to launch dev host)
npm run check                     # Lint + type-check
npm run test:unit                 # Unit tests
npm run test:quality              # LLM-as-judge quality tests
```

### Tested Models

These are the models the quality test suite runs against. Contributors should test prompt changes against at least one model per extraction strategy (e.g., CLI sonnet, GPT-4.1 Nano, xAI Grok).

| # | Backend | Preset ID | Model |
|---|---------|-----------|-------|
| 1 | CLI | *(default)* | sonnet |
| 2 | CLI | — | haiku |
| 3 | API | `xai-grok` | grok-4-1-fast-non-reasoning |
| 4 | API | `xai-grok-code` | grok-code-fast-1 |
| 5 | API | `anthropic-haiku` | claude-haiku-4-5-20251001 |
| 6 | API | `anthropic-sonnet` | claude-sonnet-4-5-20250929 |
| 7 | API | `openai-gpt-4.1-nano` | gpt-4.1-nano |
| 8 | API | `google-gemini-flash` | gemini-2.5-flash |
| 9 | API | `ollama-default` | qwen2.5-coder:7b |

Coverage: all 3 extraction strategies, 6 providers, 3 cost tiers, code-specialized model, local option. See `CLAUDE.md` for testing commands.

## 🤝 Contributing

Contributions welcome — fork the repo, create a branch, and open a pull request.

- Run `npm run check` before submitting (must pass)
- See `CLAUDE.md` for architecture details, testing workflows, and coding conventions
- [Open an issue](https://github.com/trentmcnitt/bespoke-ai-vscode-ext/issues) for bugs or feature ideas

## 👤 Author

Built by [Trent McNitt](https://mcnitt.io) — AI developer specializing in agent development, prompt engineering, and full-stack applications.

[Available for contract work →](https://mcnitt.io)
