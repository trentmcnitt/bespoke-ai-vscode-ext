# Changelog

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
