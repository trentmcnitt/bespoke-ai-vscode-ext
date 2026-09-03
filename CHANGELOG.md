# Changelog

## 0.8.13 — Security follow-ups

- **Custom instructions are sanitized before use:** `bespokeAI.customInstructions` is workspace-settable by design (per-project rules), so the value may come from a repository. It is now normalized at the point it enters the prompt — line endings unified, control characters and Unicode bidirectional overrides removed, and the text capped at 2000 characters (the setting description says so). Real-world instructions are a sentence or two, so this changes nothing for normal use; it bounds what a stray value can do to the prompt.
- **One-time review of custom presets already in your settings:** before 0.8.12 a repository could add a custom API preset through workspace settings, and two code paths copied that into your User settings — where the 0.8.12 scope fix does not reach. On first start, the extension now looks once at the custom presets in your User settings and, only if any send requests off this machine, read an unusual environment variable, or add request headers, shows what it found and offers to remove them. **Keeping everything is the default** — a remote Ollama box looks the same as anything suspicious here, so nothing is removed unless you choose it. If you remove a preset that was selected, the selection is reset rather than left dangling.
- **Commit-message diffs are bounded:** the diff sent to generate a commit message was unbounded; it is now capped at 60,000 characters, cut at a line boundary with a marker so the model knows it is partial. The diff is the largest single piece of workspace content the extension sends off-machine, and a commit message never needed more than this.
- **Fix — Suggest Edits preview matched the wrong content for some file names:** the diff preview keyed its virtual documents through `Uri.parse`, which treats `?` and `#` in a file name as query/fragment and percent-decodes `%xx`. For such files the "corrected" pane rendered empty while Apply wrote the real text. The key is now set verbatim.

## 0.8.12 — Custom Instructions

- **Security — settings that select a backend, model, or CLI permission mode are now user-level only:** `bespokeAI.backend`, `bespokeAI.api.customPresets`, `bespokeAI.claudeCode.models`, `bespokeAI.codeOverride.backend`, `bespokeAI.codeOverride.model`, and `bespokeAI.contextMenu.permissionMode` can no longer be set from a folder's `.vscode/settings.json` or a `.code-workspace` file. These settings choose where completion requests are sent and how the CLI is invoked, so a project should not be able to change them just by being opened. `bespokeAI.api.customPresets` uses `machine` scope, so it remains settable in **remote** user settings for SSH and dev-container work (e.g. a local Ollama endpoint on the remote host); the rest use `application` scope, matching `bespokeAI.api.preset` and `bespokeAI.claudeCode.model`, which were already user-level. **If you set any of these in a workspace or folder settings file, move them to your User settings — the workspace value no longer applies.**
- **Security — the context-menu permission mode is now a fixed lookup, never interpolated:** Explain/Fix/Do build a `claude` command line, and the permission-mode flag was previously built by interpolating the configured value into that string. VS Code enforces a setting's declared `enum` in the Settings editor only — `getConfiguration().get()` returns whatever text is in `settings.json` — so a hand-written value could reach the shell. The flag is now selected from a fixed three-entry table and the setting is validated when config is loaded, so only the three intended flag strings can ever be emitted. Reported privately by an external user; thank you.
- **Auto-selected API presets are no longer written to your settings:** when the configured preset is unavailable (missing key) the extension falls back to an available one. That fallback now applies for the session only and is re-derived on next start, instead of being persisted to your User settings as though you had chosen it.

- **Steer completions with your own standing instructions:** A new **Bespoke AI: Custom Instructions** setting (`bespokeAI.customInstructions`) lets you add persistent rules that are appended to every inline-completion prompt — e.g. `Follow MISRA C rules`, `Avoid dynamic memory allocation`, `Prefer const over let`, or `Use British English spellings`. It applies to both backends (Claude Code CLI and Direct API) and is scoped to inline completions only (it does not affect commit-message or Suggest Edits commands). Your instructions steer the content but never override the core completion rules (output format, continuing your text rather than replying to it) — verified with adversarial evaluation across the reference models. Set it from the status-bar menu (**Custom Instructions**) or Settings; use Workspace scope for per-project rules. The extension does **not** read your project's `CLAUDE.md` for completions — this lightweight setting is the efficient equivalent, without adding a large file to every keystroke's cost. (#20)

- **Slot-wait visibility for speed diagnosis:** On the Claude Code CLI backend, a completion request can stall waiting for the pool — the single CLI session is busy, or recycling after its 8-completion reuse limit — and that wait was previously indistinguishable from slow inference in the logs. The debug log now emits a `waited Nms for a slot` line when a request waits more than 100ms, and the usage ledger records a `waitMs` field per completion, so speed reports can separate "pool was busy/recycling" from "model was slow". (#22)
- **Pinpoint stray auth env vars inside VS Code itself:** A follow-up report on #14 showed the "credit balance too low" failure recurring with **no** `ANTHROPIC_API_KEY` in the system environment — the variable was present only inside VS Code's extension host process (which all extensions share, and any of them can modify at runtime), so the spawned CLI kept billing an empty API account while the user's terminal showed the variable unset. The startup diagnostics now log which CLI auth vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`) are present in the extension host's own environment (names only, never values), and when this is the cause the error notification says so directly — including the restart-VS-Code fix and the likely another-extension culprit — instead of pointing at the system environment. (#14)

## 0.8.11 — API Backend Health Check

- **Proactive connectivity check for the Direct API backend:** The Claude Code CLI backend already verifies itself at startup (warmup + credit-balance detection), but the API backend only checked that a key was _configured_ — so switching to Direct API with an out-of-credit or invalid key showed "ready" and then failed silently, with no ghost text and no explanation. The extension now sends one quick test request whenever the API backend becomes active (activation, backend switch, model change, or after saving a key). If the account is out of credit or the key is rejected, it surfaces a clear notification and a "Setup needed" status right away, with a one-click "Enter API Key" / "Test Connection" recovery action. Transient failures (network blips, rate limits, 5xx) are logged but don't flip the status, so they can't wedge the UI with a false alarm. (#14)

## 0.8.10 — Windows PATH Shim Fix

- **Fix — CLI failed to start when `where claude` found the extensionless npm shim (Windows):** After the 0.8.8 native-resolution work, a Windows user still hit "The CLI subprocess failed to initialize" with the log showing the executable resolved to `C:\...\nodejs\claude` (no extension). `where claude` surfaces the npm-installed **Unix shim** — a bash script with no extension — ahead of the `claude.cmd`/`claude.ps1` shims. The extension (and the SDK) classified the extensionless file as a native binary and spawned it directly, which fails on Windows with `ENOENT` because Windows cannot execute an extensionless script. The PATH resolver now requires an executable extension (`.exe`/`.com`) on Windows, so it skips the shim and falls back to the bundled `cli.js` run via Node. (#17)

## 0.8.9 — Credit-Balance Error Detection

- **Actionable message for API billing failures:** When the Claude Code CLI authenticates against a pay-per-token API account with no credit balance (typically a stray `ANTHROPIC_API_KEY` overriding a subscription login), warmup used to fail with a generic "autocomplete unavailable" notice. The extension now recognizes the CLI's "Credit balance is too low" reply, skips the futile retry, and shows a message explaining that Claude Code is billing an empty API account — with instructions to log in with your subscription and remove any `ANTHROPIC_API_KEY`. The status bar menu offers a one-click "Open Terminal" to run `claude`.

## 0.8.8 — Native CLI Resolution (Windows startup fix)

- **Fix — completions failed to start when `node` was not on PATH (Windows):** The extension handed the SDK its bundled `cli.js`, which the SDK runs as `node cli.js` — requiring `node` on the extension host's PATH. On Windows (especially with the native Claude installer) that PATH is often missing `node`, so warmup failed. This is now fixed on two fronts: (1) the extension resolves a **native** Claude binary first (`~/.local/bin/claude(.exe)`, checked on disk, then a native binary on PATH) and spawns it directly — no `node` needed; (2) when it falls back to the bundled `cli.js`, it runs it with **VS Code's own bundled Node** (Electron via `process.execPath` + `ELECTRON_RUN_AS_NODE=1`, the pattern vscode-languageclient uses) instead of a system `node`, guaranteeing Node 18+ regardless of PATH. Either path resolves the startup failure. (#2)
- **Corrupted CLI config detected:** A missing or corrupted `~/.claude.json` (e.g. a UTF-8 BOM) makes the CLI emit a plain-text error the SDK can't parse. The extension now recognizes this, skips the futile warmup retry, and shows an actionable message telling you to delete the file.
- **Diagnostics accuracy:** The auto-diagnostics now probe the actual resolved executable — the native binary directly, or the bundled `cli.js` via the same VS Code Node used to spawn it — instead of bare `node`/`claude`, so the log reflects how completions are really invoked rather than reporting tools as missing due to the same PATH gap.
- **Sonnet 5:** The `anthropic-sonnet` API preset now uses Claude Sonnet 5 (`claude-sonnet-5`), released since the last update. The Claude Code CLI backend already tracks the latest Sonnet via the `sonnet` alias.
- **Model versions in the UI:** For the Claude Code backend, the status bar, menus, and logs now show which model version a CLI alias actually resolved to (e.g. `opus` → "Opus 4.8") instead of the bare alias. The version is read from the CLI's own responses, so it is always accurate — aliases display as-is until the first response arrives.

## 0.8.7 — Automatic CLI Diagnostics on Warmup Failure

- **Auto-diagnostics:** When the CLI subprocess fails to start after both warmup attempts, the extension now automatically runs `node --version`, `claude --version`, and `claude auth status` and logs the results. A single log dump now captures everything needed to debug startup failures without asking users to run commands manually. (#2)

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
