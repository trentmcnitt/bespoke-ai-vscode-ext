# Changelog

## 0.8.6 — Subprocess Stderr Capture

- **Stderr capture:** CLI subprocess stderr output is now captured and logged, so when the Claude Code process exits with an error, the actual reason (auth failure, missing dependency, etc.) appears in the Output panel instead of just "process exited with code 1." (#2)
- **Success-path warnings:** Stderr warnings from healthy subprocesses (deprecation notices, etc.) are logged at debug level on slot recycle instead of being silently discarded.
- **Bounded buffer:** Stderr accumulation is capped at 100 chunks per slot to prevent unbounded memory growth.

## 0.8.5 — Better Diagnostics and CI

- **Specific error messages:** Pool degradation notifications now explain _why_ autocomplete is unavailable — warmup failure, circuit breaker, or authentication — instead of always suggesting "run `claude` in your terminal." (#2)
- **Warmup timeout:** CLI subprocesses that produce no output within 30 seconds are now detected and reported, instead of hanging silently.
- **Open Log button:** The error notification now offers "Open Log" instead of "Open Terminal," making it easier to diagnose issues.
- **Restart flow fix:** "Restart Pools" from the error notification now properly resets the status bar state.
- **CI pipeline:** Added GitHub Actions workflow (lint, type-check, format, unit tests) with branch protection on main.

## 0.8.4 — Circuit Breaker Feedback and Pool Recovery

- **Circuit breaker status bar:** When the API circuit breaker opens after repeated failures, the status bar now shows "Setup needed" with a retry option. Recovers automatically when requests succeed again or the cooldown expires.
- **Pool recovery:** Recycling degraded pools now falls back to a full restart instead of silently no-oping. The "Restart Pools" command and CLI auth restart both reset the status bar to "ready" on success.
- **API welcome message:** A one-time info message greets new API-mode users with their active preset name and a shortcut to settings.
- **Custom preset validation:** Invalid or conflicting custom presets now log warnings explaining why they were skipped (missing fields, ID conflicts with built-ins).
- **Safer adapter creation:** `createAdapter()` failures in both API providers are now caught and logged instead of throwing unhandled errors.
- **Auto-select preserves explicit choice:** When the user has explicitly set `bespokeAI.api.preset`, auto-selection no longer overwrites their choice — it only activates when no preset is configured.
- **Consistent CLI activation:** Re-enabling the extension or switching to Claude Code backend now uses the same preflight activation path as initial startup.

## 0.8.3 — Auto-Select Available Preset

- **Auto-select preset:** When the active API preset is unavailable (e.g., missing API key), the extension now automatically selects the first available preset — prioritizing custom presets, then built-in Ollama presets. This fixes the "Setup needed" nag loop for users who define a custom preset without also setting `bespokeAI.api.preset`. (#1)
- **README fix:** Corrected the "Getting Started" section to accurately describe the API mode setup flow.

## 0.8.2 — Native Ollama Adapter

- **Native Ollama API adapter:** Ollama models now use the native `/api/chat` endpoint instead of the OpenAI-compatible `/v1/chat/completions`. This fixes thinking/reasoning models (like Qwen 3.5) that burned their entire token budget on reasoning and returned empty completions via the OpenAI-compat layer.
- **New preset:** `ollama-qwen35-9b` for Qwen 3.5 9B.
- **Thinking disabled by default:** The adapter sends `think: false` to ensure fast, direct completions. Override with `extraBody: { think: true }` in a custom preset if needed.
- **Backward compatible:** Existing Ollama presets and custom presets with `/v1` base URLs continue to work — the adapter strips the `/v1` suffix automatically.

## 0.8.0 — API Backend

- **API backend:** The extension now works without a Claude subscription. Set `bespokeAI.backend` to `"api"` and provide an API key (via environment variable or `~/.creds/api-keys.env`) to use Anthropic, OpenAI, xAI, Google Gemini, OpenRouter, or local Ollama models for completions, commit messages, and suggest-edits.
- **13 built-in presets:** `anthropic-haiku`, `anthropic-sonnet`, `openai-gpt-4o-mini`, `openai-gpt-4.1-nano`, `xai-grok`, `xai-grok-code`, `xai-grok-4`, `google-gemini-flash`, `openrouter-haiku`, `openrouter-gpt-4.1-nano`, `ollama-default`, `ollama-qwen3-4b`, `ollama-qwen3-8b`. Switch via the status bar menu or `bespokeAI.api.preset`.
- **Code override:** New `bespokeAI.codeOverride.backend` and `bespokeAI.codeOverride.model` settings let you route code completions to a different backend/model than prose (e.g., Claude Code CLI for writing, xAI Grok for code).
- **Secure API key management:** "Enter API Key" command stores keys in the OS keychain via VS Code SecretStorage, with graceful fallback to environment variables and `~/.creds/api-keys.env`.
- **Custom model wizard:** "Add Custom Model" command provides a guided setup flow for adding custom API presets.
- **Extra API passthrough:** Custom presets support `extraBody` and `extraHeaders` for provider-specific API configuration (e.g., OpenRouter `transforms`, `provider` routing).
- **Shared prompt strategy:** Extracted a unified prompt module (`prompt-strategy.ts`) shared by both backends. Three extraction strategies (tag, prefill, instruction) handle differences between model providers while keeping prompts consistent.
- **Backend router:** New `BackendRouter` transparently routes completions and commands to the active backend. Commit messages and suggest-edits work in both CLI and API modes.
- **Context menu scoping:** Explain, Fix, and Do commands are hidden when the API backend is active (they require Claude Code CLI).
- **Circuit breaker:** API providers include a circuit breaker — 5 consecutive failures pauses requests for 30 seconds, then auto-recovers.
- **Default preset changed:** Default API preset is now `xai-grok` (was `anthropic-haiku`).
- **Default CLI model changed:** Default Claude Code model is now `sonnet` (was `haiku`).

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
