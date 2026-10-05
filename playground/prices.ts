/**
 * Playground-only price table, used to estimate a run's cost for the bench and
 * the daily spend cap. The extension itself never uses price tables.
 * USD per 1M tokens, standard tier, checked 2026-09-28 on each provider's page:
 *   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
 *   OpenAI     https://developers.openai.com/api/docs/pricing
 *   xAI        https://docs.x.ai/docs/models and /developers/migration/may-15-retirement
 *   Google     https://ai.google.dev/gemini-api/docs/pricing
 * xAI retired grok-4-1-fast-non-reasoning and grok-code-fast-1 on 2026-05-15; requests
 * to those ids are served by grok-4.3 and grok-build-0.1, priced here at those rows.
 * A model not listed gets no estimate and is refused for live typing (see spend.ts).
 */
import type { GenerationDetail } from '../src/utils/trace';
import type { CostEstimate } from './bench';

interface Price {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

const CHECKED = '2026-09-28';

const PRICES: Record<string, Price & { source: string }> = {
  'claude-haiku-4-5-20251001': {
    input: 1,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    output: 5,
    source: 'anthropic',
  },
  'claude-sonnet-5': { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10, source: 'anthropic' },
  'gpt-4.1-nano': { input: 0.1, cacheRead: 0.025, cacheWrite: 0, output: 0.4, source: 'openai' },
  'gpt-4o-mini': { input: 0.15, cacheRead: 0.075, cacheWrite: 0, output: 0.6, source: 'openai' },
  'grok-4.3': { input: 1.25, cacheRead: 0.2, cacheWrite: 0, output: 2.5, source: 'xai' },
  'grok-4-1-fast-non-reasoning': {
    input: 1.25,
    cacheRead: 0.2,
    cacheWrite: 0,
    output: 2.5,
    source: 'xai (grok-4.3)',
  },
  'grok-code-fast-1': {
    input: 1,
    cacheRead: 0.2,
    cacheWrite: 0,
    output: 2,
    source: 'xai (grok-build-0.1)',
  },
  'gemini-2.5-flash': { input: 0.3, cacheRead: 0.03, cacheWrite: 0, output: 2.5, source: 'google' },
};

export function hasPrice(modelId: string): boolean {
  return modelId in PRICES;
}

/** Estimated cost of one call from its token counts; undefined when unpriced or no usage. */
export function estimateCost(
  modelId: string,
  d: GenerationDetail | undefined,
): CostEstimate | undefined {
  const p = PRICES[modelId];
  if (!p || !d || (d.inputTokens === undefined && d.outputTokens === undefined)) return undefined;
  const usd =
    ((d.inputTokens ?? 0) * p.input +
      (d.cacheReadTokens ?? 0) * p.cacheRead +
      (d.cacheWriteTokens ?? 0) * p.cacheWrite +
      (d.outputTokens ?? 0) * p.output) /
    1_000_000;
  return { usd, basis: `${p.source} price table ${CHECKED}` };
}
