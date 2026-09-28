/**
 * Request features that some Claude models reject.
 *
 * Newer Claude models return HTTP 400 for things the API presets used to send
 * on every request: an assistant prefill (the last message is from the
 * assistant), a non-default `temperature`, and — per model — a particular way of
 * turning thinking off. A preset that sends any of these to a model that rejects
 * it fails every request, so presets for Anthropic models take their prompt
 * strategy and request features from this table.
 *
 * Sources: Claude API docs, checked 2026-09-28 —
 * https://platform.claude.com/docs/en/models/overview ("Every Claude model ID is a
 * pinned snapshot"), https://platform.claude.com/docs/en/models/sonnet-5/migration-guide
 * (Sonnet 5: prefill and sampling parameters 400; adaptive thinking on by default,
 * `thinking: {type: "disabled"}` turns it off),
 * https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5
 * (Sonnet 5.5: "a request that sends thinking: {type: \"disabled\"} returns a 400";
 * the lowest setting is `thinking: {type: "between_tools"}`, accepted at low/medium/high
 * effort; sampling parameters 400), and the per-model tables in the Claude API skill
 * (prefill removed on the 4.6-and-later family; sampling removed on Opus 4.7+, Sonnet 5,
 * Fable and Mythos; thinking always on — cannot be turned off — on Opus 5.5, Fable, Mythos).
 *
 * Why thinking is turned off where possible: thinking tokens count against the presets'
 * 200-token `max_tokens`, and a model that thinks first can spend the whole budget and
 * return no text (3 of 51 scenarios on Sonnet 5, evals/2026-09-28-sonnet-preset.md).
 *
 * Matching is by exact model id (after normalisation), not prefix: `claude-sonnet-5-5`
 * is a different model from `claude-sonnet-5` and rejects what Sonnet 5 needs. Ids not
 * in the table are classified by version: pre-4.6 models (Haiku 4.5, Sonnet/Opus 4.5 and
 * older, Claude 3.x) keep the original behaviour (prefill and temperature allowed); any
 * other Claude id — including models released after this table — gets the modern safe
 * shape: no prefill, no sampling parameters, and no `thinking` field. That shape is
 * accepted by every model since Claude 4.6, so a new model works (possibly thinking
 * first) instead of failing every request until this table is updated.
 */
export interface AnthropicModelCapabilities {
  /** The model accepts a final assistant message (prefill). */
  prefill: boolean;
  /** The model accepts `temperature` / `top_p` / `top_k`. */
  sampling: boolean;
  /**
   * How to turn thinking off, for a model that thinks by default and accepts it:
   * `"disabled"` (Sonnet 5, Opus 5) or `"between_tools"` (Sonnet 5.5). `null` means
   * send no `thinking` field (the model does not think unless asked, or thinking
   * cannot be turned off).
   */
  thinkingOff: 'disabled' | 'between_tools' | null;
}

const MODERN: AnthropicModelCapabilities = { prefill: false, sampling: false, thinkingOff: null };
const LEGACY: AnthropicModelCapabilities = { prefill: true, sampling: true, thinkingOff: null };

/** Known models since Claude 4.6, by exact normalised id. */
const KNOWN: Record<string, AnthropicModelCapabilities> = {
  'claude-sonnet-5-5': { ...MODERN, thinkingOff: 'between_tools' },
  'claude-sonnet-5': { ...MODERN, thinkingOff: 'disabled' },
  'claude-opus-5-5': MODERN, // thinking always on
  'claude-opus-5': { ...MODERN, thinkingOff: 'disabled' },
  'claude-opus-4-8': MODERN, // no thinking unless asked
  'claude-opus-4-7': MODERN,
  'claude-fable-5-1': MODERN, // thinking always on
  'claude-fable-5': MODERN,
  'claude-mythos-5-1': MODERN,
  'claude-mythos-5': MODERN,
  'claude-opus-4-6': { ...MODERN, sampling: true },
  'claude-sonnet-4-6': { ...MODERN, sampling: true },
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

/**
 * True for models from before the 4.6 generation, which accept prefill and sampling:
 * Claude 3.x (`claude-3-5-sonnet-…`), and `claude-<family>-<major>[-<minor>][-<date>]`
 * with version below 4.6 (e.g. `claude-haiku-4-5-20251001`, `claude-sonnet-4-20250514`).
 */
function isPreModernId(id: string): boolean {
  if (/^claude-(instant|[12])(-|$)/.test(id) || /^claude-3(-|$)/.test(id)) return true;
  const m = /^claude-[a-z]+-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  return major < 4 || (major === 4 && minor < 6);
}

export function anthropicModelCapabilities(modelId: string): AnthropicModelCapabilities {
  const id = normalizeAnthropicModelId(modelId);
  const caps = KNOWN[id] ?? (isPreModernId(id) ? LEGACY : MODERN);
  return { ...caps };
}
