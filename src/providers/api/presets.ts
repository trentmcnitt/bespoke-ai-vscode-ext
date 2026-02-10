import { Preset } from './types';

const BUILT_IN_PRESETS: Preset[] = [
  {
    id: 'anthropic-haiku-4-5',
    displayName: 'Haiku 4.5',
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    features: { promptCaching: true, prefill: true },
    pricing: { inputPerMTok: 0.8, outputPerMTok: 4.0, cacheReadPerMTok: 0.08 },
    notes:
      'Best all-around choice for inline completions. Fast (~300-600ms), cheap, and supports ' +
      'assistant prefill (the model continues from the last ~40 chars of your prefix, so it ' +
      'always starts at the right place). Prompt caching makes repeated completions in the ' +
      'same file extremely cheap. Temperature 0.2 gives consistent results; raise to 0.4-0.5 ' +
      'for more creative prose.',
  },
  {
    id: 'anthropic-sonnet-4-5',
    displayName: 'Sonnet 4.5',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5-20250929',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    features: { promptCaching: true, prefill: true },
    pricing: { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheReadPerMTok: 0.3 },
    notes:
      'Higher quality than Haiku but ~3-4x more expensive and slightly slower (~500-1000ms). ' +
      'Use when completion quality matters more than cost/speed — e.g., complex code logic, ' +
      'nuanced prose, or tricky bridging between existing content. Same prefill and caching ' +
      'benefits as Haiku.',
  },
  {
    id: 'openai-gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
    notes:
      'Very cheap and fast. No prefill support, so the model must be explicitly told to ' +
      'output only continuation text. May occasionally produce chatty responses despite ' +
      'instructions. Good for cost-sensitive use cases or A/B testing against Anthropic models.',
  },
  {
    id: 'xai-grok-4-1-fast',
    displayName: 'Grok 4.1 Fast',
    provider: 'xai',
    modelId: 'grok-4-1-fast',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnvVar: 'XAI_API_KEY',
    maxTokens: 200,
    temperature: 0.3,
    pricing: { inputPerMTok: 0.6, outputPerMTok: 2.4 },
    notes:
      'Fast and capable. Uses the OpenAI-compatible API at api.x.ai. Temperature 0.3 works ' +
      'well — Grok tends to be more creative/verbose at lower temperatures than you might ' +
      'expect. Strong at code completion. No prefill support, so completions rely entirely ' +
      'on the system prompt for formatting discipline. If you see preambles, the post-processor ' +
      'strips them automatically.',
  },
  {
    id: 'ollama-default',
    displayName: 'Ollama (local)',
    provider: 'ollama',
    modelId: 'qwen2.5-coder',
    baseUrl: 'http://localhost:11434/v1',
    maxTokens: 200,
    temperature: 0.2,
    notes:
      'Runs entirely local — no API key needed, no data leaves your machine. Requires Ollama ' +
      'to be running (`ollama serve`) with the model pulled (`ollama pull qwen2.5-coder`). ' +
      'Quality depends on your hardware and model size. The 7B model is fast on Apple Silicon; ' +
      'try qwen2.5-coder:14b for better quality if you have 16GB+ RAM. Latency is typically ' +
      '200-800ms depending on model size and hardware.',
  },
  {
    id: 'gemini-flash',
    displayName: 'Gemini Flash',
    provider: 'gemini',
    modelId: 'gemini-2.0-flash',
    apiKeyEnvVar: 'GOOGLE_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    features: { contextCaching: true },
    pricing: { inputPerMTok: 0.075, outputPerMTok: 0.3 },
    notes:
      'Extremely cheap and fast. Context caching can further reduce costs for repeated ' +
      'completions in the same file. Quality is generally good for code; prose completions ' +
      'may be less nuanced than Anthropic models. Free tier available with rate limits.',
  },
];

/** Get all available presets. */
export function getAllPresets(): Preset[] {
  return [...BUILT_IN_PRESETS];
}

/** Find a preset by ID. Returns undefined if not found. */
export function getPreset(id: string): Preset | undefined {
  return BUILT_IN_PRESETS.find((p) => p.id === id);
}

/** The default preset ID. */
export const DEFAULT_PRESET_ID = 'anthropic-haiku-4-5';

/** Calculate cost in USD from token usage and preset pricing. */
export function calculateCost(
  preset: Preset,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
): number {
  if (!preset.pricing) return 0;

  const inputCost = (usage.inputTokens / 1_000_000) * preset.pricing.inputPerMTok;
  const outputCost = (usage.outputTokens / 1_000_000) * preset.pricing.outputPerMTok;
  const cacheCost =
    usage.cacheReadTokens && preset.pricing.cacheReadPerMTok
      ? (usage.cacheReadTokens / 1_000_000) * preset.pricing.cacheReadPerMTok
      : 0;

  return inputCost + outputCost + cacheCost;
}

/** Get all built-in preset IDs (for settings enum). */
export function getBuiltInPresetIds(): string[] {
  return BUILT_IN_PRESETS.map((p) => p.id);
}
