/**
 * Request features that some Claude models reject.
 *
 * Newer Claude models return HTTP 400 for two things the API presets used to
 * send on every request: an assistant prefill (the last message is from the
 * assistant) and a non-default `temperature`. A preset that sends either to
 * such a model fails every request, so presets for Anthropic models take
 * their prompt strategy and sampling from this table instead of assuming
 * Haiku 4.5 behaviour.
 *
 * Source: Claude API docs, checked 2026-09-28 —
 * https://platform.claude.com/docs/en/models/sonnet-5/migration-guide
 * ("Prefilling assistant messages returns a 400 error on Claude Sonnet 4.6 and
 * later models"; "Sampling parameters (temperature, top_p, top_k) set to a
 * non-default value return a 400 error on Claude Sonnet 5") and the per-model
 * tables in the Claude API skill (prefill removed on the 4.6-and-later family,
 * Opus 5, Fable 5 and Mythos 5; sampling parameters removed on Opus 4.7 and
 * later, Sonnet 5, Fable 5 and Mythos 5). Both Sonnet 5 rejections were also
 * observed directly (evals/2026-09-28-sonnet-preset.md).
 *
 * Models not listed (Haiku 4.5, Sonnet 4.5, Opus 4.5 and older, and ids this
 * table does not recognise) keep the previous behaviour: prefill and
 * temperature allowed.
 */
export interface AnthropicModelCapabilities {
  /** The model accepts a final assistant message (prefill). */
  prefill: boolean;
  /** The model accepts `temperature` / `top_p` / `top_k`. */
  sampling: boolean;
}

interface CapabilityRow {
  /** Normalised id prefix; matches the id itself or the id followed by `-…`. */
  prefix: string;
  caps: AnthropicModelCapabilities;
}

const NO_PREFILL_NO_SAMPLING: AnthropicModelCapabilities = { prefill: false, sampling: false };
const NO_PREFILL: AnthropicModelCapabilities = { prefill: false, sampling: true };

const ROWS: CapabilityRow[] = [
  { prefix: 'claude-sonnet-5', caps: NO_PREFILL_NO_SAMPLING },
  { prefix: 'claude-opus-5', caps: NO_PREFILL_NO_SAMPLING }, // also Opus 5.5 (claude-opus-5-5)
  { prefix: 'claude-opus-4-8', caps: NO_PREFILL_NO_SAMPLING },
  { prefix: 'claude-opus-4-7', caps: NO_PREFILL_NO_SAMPLING },
  { prefix: 'claude-fable', caps: NO_PREFILL_NO_SAMPLING },
  { prefix: 'claude-mythos', caps: NO_PREFILL_NO_SAMPLING },
  { prefix: 'claude-opus-4-6', caps: NO_PREFILL },
  { prefix: 'claude-sonnet-4-6', caps: NO_PREFILL },
];

const DEFAULT_CAPS: AnthropicModelCapabilities = { prefill: true, sampling: true };

/**
 * Normalise a model id across the direct API and OpenRouter:
 * `anthropic/claude-opus-4.6` → `claude-opus-4-6`.
 */
export function normalizeAnthropicModelId(modelId: string): string {
  return modelId
    .trim()
    .toLowerCase()
    .replace(/^anthropic\//, '')
    .replace(/\./g, '-');
}

export function anthropicModelCapabilities(modelId: string): AnthropicModelCapabilities {
  const id = normalizeAnthropicModelId(modelId);
  const row = ROWS.find((r) => id === r.prefix || id.startsWith(`${r.prefix}-`));
  return { ...(row?.caps ?? DEFAULT_CAPS) };
}
