# Changelog

## 0.8.0 — API Backend

- **API backend:** The extension now works without a Claude subscription. Set `bespokeAI.backend` to `"api"` and provide an API key (via environment variable or `~/.creds/api-keys.env`) to use Anthropic, OpenAI, xAI, or local Ollama models for completions, commit messages, and suggest-edits.
- **Built-in presets:** Five presets out of the box — `anthropic-haiku`, `anthropic-sonnet`, `openai-gpt-4o-mini`, `xai-grok`, `ollama-default`. Switch presets via the status bar menu or `bespokeAI.api.preset`.
- **Shared prompt strategy:** Extracted a unified prompt module (`prompt-strategy.ts`) shared by both backends. Three extraction strategies (tag, prefill, instruction) handle differences between model providers while keeping prompts consistent.
- **Backend router:** New `BackendRouter` transparently routes completions and commands to the active backend. Commit messages and suggest-edits work in both CLI and API modes.
- **Context menu scoping:** Explain, Fix, and Do commands are hidden when the API backend is active (they require Claude Code CLI).
- **Circuit breaker:** API providers include a circuit breaker — 5 consecutive failures pauses requests for 30 seconds, then auto-recovers.

## 0.7.1 — Launch Prep

- **GitHub Issues enabled** for bug reports and feature requests.
- **Marketplace listing improved:** Updated extension display name and description.
- **README:** Added Windows troubleshooting note for context menu commands, linked GitHub Issues in feedback section.
- **Removed internal planning docs** from the public repository.

## 0.7.0 — Windows Support

- **Windows support:** Platform-aware IPC using named pipes on Windows and Unix domain sockets on macOS/Linux. The pool server, lockfile, and client connection all work cross-platform.
- **Hardened `os.userInfo()` handling:** Graceful fallback when username lookup fails in restricted environments.
- **Centralized state directory:** All code now uses the shared `STATE_DIR` constant from `ipc-path.ts`.
- **Cleanup:** Removed wrapper indirection in pool server exports, simplified `ensureStateDir()`.

## 0.6.0 — Onboarding and First-Run Experience

- **Trigger presets:** New `triggerPreset` setting with three options — `relaxed` (~2s delay, new default), `eager` (~800ms), and `on-demand` (Alt+Enter only). Replaces the triggerMode/debounceMs combination for easier configuration. Custom `debounceMs` still works as an override.
- **Default model changed to Haiku:** Faster responses for a better out-of-box experience. Switch to Sonnet or Opus via the status bar menu.
- **Pre-flight checks:** Shows an error notification when Claude Code CLI is missing, with a link to the install guide. Warmup failures now suggest checking authentication.
- **Status bar states:** Shows "Starting..." during pool initialization and "Setup needed" if something goes wrong.
- **First-run welcome:** One-time notification with Alt+Enter shortcut reminder on first activation.
- **README improvements:** Added install command, authentication step, trigger preset docs, and troubleshooting section.

## 0.5.0 — Public Release

Initial public release on the VS Code Marketplace.

- Inline ghost-text completions for prose and code via Claude Code CLI
- Auto-detection of prose vs code mode based on file type
- Commit message generation from staged diffs
- Suggest Edits command for typo, grammar, and bug fixes
- Context menu commands: Explain, Fix, Do
- Configurable debounce, trigger mode (auto/manual), and model selection
- Shared pool server architecture for multi-window support
- LRU cache with 5-minute TTL for instant repeat completions
