# API Return Notes

Reference document for restoring direct API provider support (Anthropic, Ollama) if needed in the future.

## Why We Removed API Providers

- **Subscription model vs per-token billing.** Claude Code runs on a subscription, eliminating per-request cost anxiety and the need for usage tracking, cost estimation, and billing guards.
- **Single-backend simplicity.** Removing three providers, a router, a prompt builder, and an oracle subsystem significantly reduced complexity — fewer moving parts, fewer test surfaces, faster iteration.
- **Code never fully refined.** The Anthropic and Ollama providers worked but had rough edges (streaming not implemented, stop sequence filtering workarounds, raw mode quirks). Rather than polish code we weren't actively using, we removed it cleanly.

## API-Only Capabilities to Implement If Returning

These features were either partially implemented or identified as valuable but never built:

- **Streaming responses** — Stream completions token-by-token for lower perceived latency. The Anthropic SDK supports streaming natively; Ollama supports it via chunked responses.
- **Stop sequences** — Fine-grained control over where completions end. The Anthropic API rejects whitespace-only stop sequences (a known limitation we worked around).
- **Prompt caching (Anthropic)** — Mark system prompt blocks with `cache_control: ephemeral` so the API reuses them across requests. Significant cost reduction for repeated completions.
- **Assistant prefill** — Seed the assistant response with the last few words of the user's text so the model continues naturally. Critical for prose quality.
- **FIM tokens (Ollama)** — Native fill-in-the-middle support via Ollama's `suffix` parameter. Ollama applies model-specific FIM tokens automatically when a suffix is provided.
- **Fine-grained token control** — Per-request `max_tokens`, `temperature`, and `stop_sequences` sent directly to the API. Claude Code abstracts these away.
- **Partial acceptance analytics** — Track which completions users accept, reject, or partially accept for quality feedback loops.
- **Stream time filtering** — Discard completions that arrive after the user has already typed past the insertion point.

## Open-Source References to Study

Before rebuilding API providers, study how established projects handle the same problems:

- **Cody (Sourcegraph)** — Multi-provider completion engine with streaming, context window management, and partial acceptance. Well-documented prompt caching strategy.
- **Continue** — VS Code extension supporting multiple LLM backends. Good reference for provider abstraction patterns and FIM implementation.
- **llm-vscode (HuggingFace)** — Lightweight completion extension. Clean FIM token handling for code models.
- **Supermaven** — Fast completion engine. Interesting approach to stream time filtering and latency optimization.

## Architecture Notes for Restoration

1. **Re-establish `ProviderRouter`** — Central dispatch that holds all provider instances and returns the active one based on config. Accepts a `Logger` and passes it to all providers.
2. **Restore `PromptBuilder`** — Constructs `BuiltPrompt` objects per mode (prose/code) for API backends. Claude Code builds its own prompts and does not use `PromptBuilder`.
3. **Keep Claude Code as first-class** — Don't tack it on as an afterthought. It should remain the default backend with its own prompt construction path.
4. **Restore `CompletionProvider` interface compliance** — All providers implement `getCompletion(context, signal)` and `isAvailable()`.
5. **Restore `Backend` type** — `type Backend = 'anthropic' | 'ollama' | 'claude-code'` in `types.ts`, plus the `backend` field in `ExtensionConfig`.
6. **Restore oracle subsystem** — `src/oracle/` with `ContextOracle`, `ContextBriefStore`, `BriefFormatter`, and oracle-specific types. Injects context briefs into the Anthropic provider's system prompt.

## Cost and Latency Considerations

- **Prompt caching** is essential for Anthropic API cost management. Without it, the system prompt is re-processed on every request. With caching, repeated requests reuse the cached prompt prefix at 10% of the input token cost.
- **Stream time filtering** prevents stale completions from appearing after the user has moved on. Critical for perceived responsiveness.
- **Claude Code subscription** eliminates per-token costs but introduces latency from the SDK session model. API calls can be faster for simple completions.
- **When API makes sense** — High-volume usage where subscription limits matter, need for streaming, need for fine-grained model parameter control, or when running against local models via Ollama.

## Git History

The full implementation of all removed components is preserved in git history. The removal commit is the reference point for restoring any specific component.
