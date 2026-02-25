<p align="center">
  <img src="images/icon.png" alt="Bespoke AI" width="128">
</p>

<h1 align="center">Bespoke AI</h1>

<p align="center">
  <strong>Claude-powered AI autocomplete for VS Code on macOS — built on the Agent SDK</strong>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=trentmcnitt.bespoke-ai"><img src="https://img.shields.io/visual-studio-marketplace/v/trentmcnitt.bespoke-ai" alt="VS Code Marketplace"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

**🖊️ Writing + code** — Autocomplete that actually works for prompts, journals, notes, and docs. Not just another code completer.

**🚀 Frontier models, no API costs** — Opus, Sonnet, and Haiku on your existing Claude subscription. No per-token billing.

**🤖 AI-assisted prompt writing** — Use AI to help you write better prompts to AI.

### 🖼️ Screenshots

**Writing** — autocompleting a prompt to Claude:

<img src="images/demo-writing.png" alt="Writing completion demo" width="700">

**Code** — filling in a function body from the name and context:

<img src="images/demo-code.jpg" alt="Code completion demo" width="700">

## 💡 Why This Exists

I tried every open-source AI autocomplete extension I could find. None of them handled writing well — things like autocompleting prompts, journal entries, or documentation. They'd break paragraphs mid-thought, inject code syntax, or produce gibberish outside of source code files. Nothing came close to Copilot for non-code text.

So I decided to build my own. And since I was already paying for a Claude subscription, I realized I didn't need to pay for API calls at all — I could wire it up to use Claude Code instead of raw API calls. Built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), it took a lot of prompt engineering to get completions that felt natural — but the result is an extension that handles writing just as well as code.

### 🔑 No Per-Request API Costs

Most AI extensions charge per API call or push you toward cheaper models to keep costs down. Bespoke AI runs on Claude Code via the Agent SDK, which uses your existing Claude subscription (Pro, Team, or Enterprise). That means you get frontier model completions — Haiku, Sonnet, even Opus — at no additional cost per request.

## ✨ Features

- **🖊️ Writing completions** — Natural continuation that matches the tone and format of surrounding text. Works in markdown, plaintext, LaTeX, and more.
- **💻 Code completions** — Fill-in-the-middle with prefix + suffix context. Auto-detected by file type.
- **🧠 Mode detection** — Auto-switches between writing and code based on file type. Unknown languages default to writing.
- **📝 Commit messages** — Generate AI commit messages from staged diffs in the Source Control panel.
- **✏️ Suggest edits** — One-command typo, grammar, and bug fixes for visible text.
- **🔧 Context menu** — Right-click to Explain, Fix, or Do custom actions on selected text.

## 🚀 Getting Started

1. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=trentmcnitt.bespoke-ai) (search "Bespoke AI")
2. Install [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup):
   ```bash
   curl -fsSL https://claude.ai/install.sh | bash
   ```
3. Authenticate — run `claude` in your terminal and follow the login prompts
4. Have an active Claude subscription (Pro, Team, or Enterprise)
5. Start typing — completions appear as ghost text after a ~2 second pause

> **Tip:** Press `Ctrl+L` to trigger a completion immediately. Change the trigger preset via the status bar menu — choose between `relaxed` (~2s delay), `eager` (~800ms), or `on-demand` (Ctrl+L only).

> **Platform:** Tested on macOS. Linux should work but is untested. Windows is not currently supported.

### Modes

| Mode        | Activates for                                                    | Strategy                                                    |
| ----------- | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| **Writing** | `markdown`, `plaintext`, `latex`, `restructuredtext`, and others | Continuation-style prompting. Matches voice, style, format. |
| **Code**    | All recognized programming languages                             | Prefix + suffix context, language-aware.                    |
| **Auto**    | Default                                                          | Auto-selects based on file type.                            |

Auto mode is the default. Override via settings or the status bar menu. (Settings use `prose` internally — e.g., `bespokeAI.mode: "prose"`.)

## ⚙️ Configuration

All settings live under `bespokeAI.*` in VS Code settings.

<details>
<summary><strong>General</strong></summary>

| Setting         | Default     | Description                                                                  |
| --------------- | ----------- | ---------------------------------------------------------------------------- |
| `enabled`       | `true`      | Master on/off toggle                                                         |
| `mode`          | `"auto"`    | Completion mode (auto-detects)                                               |
| `triggerPreset` | `"relaxed"` | Trigger preset: `relaxed` (~2s), `eager` (~800ms), `on-demand` (Ctrl+L only) |
| `debounceMs`    | `2000`      | Override the debounce delay from your trigger preset                         |
| `logLevel`      | `"info"`    | Logging verbosity in Output channel                                          |

</details>

<details>
<summary><strong>Model</strong></summary>

| Setting             | Default                       | Description                              |
| ------------------- | ----------------------------- | ---------------------------------------- |
| `claudeCode.model`  | `"haiku"`                     | Active model (haiku, sonnet, opus, etc.) |
| `claudeCode.models` | `["haiku", "sonnet", "opus"]` | Available models catalog                 |

</details>

<details>
<summary><strong>Context Windows</strong></summary>

| Setting              | Default | Description                                 |
| -------------------- | ------- | ------------------------------------------- |
| `prose.contextChars` | `2500`  | Prefix context (characters) for writing     |
| `prose.suffixChars`  | `2000`  | Suffix context (characters) for writing     |
| `prose.fileTypes`    | `[]`    | Additional language IDs to treat as writing |
| `code.contextChars`  | `2500`  | Prefix context (characters) for code        |
| `code.suffixChars`   | `2000`  | Suffix context (characters) for code        |

</details>

<details>
<summary><strong>Context Menu Permissions</strong></summary>

| Setting                      | Default     | Description                          |
| ---------------------------- | ----------- | ------------------------------------ |
| `contextMenu.permissionMode` | `"default"` | Permission mode for Explain, Fix, Do |

Options:

- **`default`** — Ask before every action (safest)
- **`acceptEdits`** — Auto-approve file reads and edits
- **`bypassPermissions`** — Skip all permission checks (use with caution)

</details>

## 📋 Commands

| Command                   | Keybinding | Description                            |
| ------------------------- | ---------- | -------------------------------------- |
| `Trigger Completion`      | `Ctrl+L`   | Manually trigger a completion          |
| `Toggle Enabled`          | —          | Toggle the extension on/off            |
| `Cycle Mode`              | —          | Cycle through auto → writing → code    |
| `Clear Completion Cache`  | —          | Clear the LRU cache                    |
| `Show Menu`               | —          | Status bar menu                        |
| `Generate Commit Message` | —          | AI commit message from staged diffs    |
| `Suggest Edits`           | —          | Fix typos/grammar/bugs in visible text |
| `Explain` / `Fix` / `Do`  | —          | Context menu actions on selected text  |
| `Restart Pools`           | —          | Restart Claude Code subprocesses       |

> **Note:** Explain, Fix, and Do open a Claude Code CLI session in a terminal. Permission behavior is controlled by the `contextMenu.permissionMode` setting.

## 🏗️ Architecture

```
User types → Mode detection → Context extraction → LRU cache check
  → Debounce → Pool server → Agent SDK → Claude Code → Cleanup → Ghost text
```

Built on the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk), the extension manages Claude Code subprocesses through a **shared pool server** architecture. Multiple VS Code windows share a single set of subprocesses via Unix socket IPC. The first window becomes the leader (via lockfile); subsequent windows connect as clients. If the leader closes, clients automatically elect a new one.

Each subprocess serves up to 8 completions before recycling. A latest-request-wins queue ensures only the most recent request proceeds when the user is typing quickly.

**Key design decisions:**

| Decision               | Rationale                                                        |
| ---------------------- | ---------------------------------------------------------------- |
| Writing-first defaults | Unrecognized languages fall back to writing, not code            |
| Single backend         | Claude Code CLI only — simple architecture, subscription pricing |
| No streaming           | VS Code's inline completion API requires complete strings        |
| LRU cache (50 entries) | 5-minute TTL prevents redundant calls when revisiting positions  |
| Session reuse          | One subprocess serves many requests — avoids cold-start per call |

## 🔍 Troubleshooting

**Completions not appearing?**

- Check the status bar — is it showing "AI Off"? Click to re-enable.
- If it shows "Setup needed", the Claude Code CLI may not be installed or authenticated.
- Check if trigger preset is "on-demand" — in that mode, press `Ctrl+L` to trigger.
- Open the Output panel ("Bespoke AI") and check for errors.
- Run the "Bespoke AI: Restart Pools" command from the Command Palette.

**"Claude Code CLI not found"?**

- Install Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
- Restart VS Code after installation.

**"Authentication required"?**

- Run `claude` in your terminal and follow the login prompts.
- Ensure you have an active Claude subscription (Pro, Team, or Enterprise).

**Still not working?**

- Check for orphaned processes: `pkill -f "claude.*dangerously-skip-permissions"`
- Check for a stale lockfile at `~/.bespokeai/pool.lock` and remove it.
- Disable and re-enable the extension.

## 🛠️ Development

```sh
npm install && npm run compile    # Build
npm run watch                     # Watch mode (F5 to launch dev host)
npm run check                     # Lint + type-check
npm run test:unit                 # Unit tests
npm run test:quality              # LLM-as-judge quality tests
```

## 🗺️ Roadmap

- [ ] Linux support
- [ ] Windows support
- [ ] Custom instructions file
- [ ] Open-tab context

## 💬 Feedback

Bug reports, feature requests, and general feedback: **[feedback@mcnitt.io](mailto:feedback@mcnitt.io)**

## 👤 Author

Built by [Trent McNitt](https://github.com/trentmcnitt) — AI developer specializing in agent development, prompt engineering, and full-stack applications.

[Available for contract work on Upwork →](https://www.upwork.com/freelancers/~01e01437b5f36dc7e5)
