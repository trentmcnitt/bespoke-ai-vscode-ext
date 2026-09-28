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
 * A third difference: Sonnet 5 and Opus 5 run adaptive thinking when the
 * request has no `thinking` field ("Adaptive thinking on by default … To turn
 * thinking off, pass thinking: {type: "disabled"}", same migration guide).
 * Thinking tokens count against `max_tokens`, and with the presets' 200-token
 * cap the model sometimes spent the whole budget thinking and returned no text
 * (3 of 51 scenarios, evals/2026-09-28-sonnet-preset.md), so the adapter turns
 * it off for these models. Opus 5.5 and Fable 5.x reject `disabled` (thinking
 * is always on there); Opus 4.6–4.8 and Sonnet 4.6 run without thinking when
 * the field is omitted. Neither group is sent the field.
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
  /**
   * The model thinks by default and accepts `thinking: {type: "disabled"}`;
   * the adapter sends it so thinking cannot use up the small `max_tokens`.
   */
  disableThinking: boolean;
}

interface CapabilityRow {
  /** Normalised id prefix; matches the id itself or the id followed by `-…`. */
  prefix: string;
  caps: AnthropicModelCapabilities;
}

const NO_PREFILL_NO_SAMPLING: AnthropicModelCapabilities = {
  prefill: false,
  sampling: false,
  disableThinking: false,
};
const NO_PREFILL_NO_SAMPLING_THINKS: AnthropicModelCapabilities = {
  prefill: false,
  sampling: false,
  disableThinking: true,
};
const NO_PREFILL: AnthropicModelCapabilities = {
  prefill: false,
  sampling: true,
  disableThinking: false,
};

// First match wins: `claude-opus-5-5` must come before `claude-opus-5`.
const ROWS: CapabilityRow[] = [
  { prefix: 'claude-sonnet-5', caps: NO_PREFILL_NO_SAMPLING_THINKS },
  { prefix: 'claude-opus-5-5', caps: NO_PREFILL_NO_SAMPLING },
  { prefix: 'claude-opus-5', caps: NO_PREFILL_NO_SAMPLING_THINKS },
  { prefix: 'claude-opus-4-8', caps: NO_PREFILL_NO_SAMPLING },
  { prefix: 'claude-opus-4-7', caps: NO_PREFILL_NO_SAMPLING },
  { prefix: 'claude-fable', caps: NO_PREFILL_NO_SAMPLING },
  { prefix: 'claude-mythos', caps: NO_PREFILL_NO_SAMPLING },
  { prefix: 'claude-opus-4-6', caps: NO_PREFILL },
  { prefix: 'claude-sonnet-4-6', caps: NO_PREFILL },
];

const DEFAULT_CAPS: AnthropicModelCapabilities = {
  prefill: true,
  sampling: true,
  disableThinking: false,
};

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
