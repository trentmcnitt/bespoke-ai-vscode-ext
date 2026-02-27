import { Preset } from './types';

const BUILT_IN_PRESETS: Preset[] = [
  {
    id: 'anthropic-haiku',
    displayName: 'Haiku 4.5',
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'prefill-extraction',
    features: { promptCaching: true, prefill: true },
    pricing: { inputPerMTok: 0.8, outputPerMTok: 4.0, cacheReadPerMTok: 0.08 },
  },
  {
    id: 'anthropic-sonnet',
    displayName: 'Sonnet 4.5',
    provider: 'anthropic',
    modelId: 'claude-sonnet-4-5-20250929',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'prefill-extraction',
    features: { promptCaching: true, prefill: true },
    pricing: { inputPerMTok: 3.0, outputPerMTok: 15.0, cacheReadPerMTok: 0.3 },
  },
  {
    id: 'openai-gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  },
  {
    id: 'xai-grok',
    displayName: 'Grok',
    provider: 'xai',
    modelId: 'grok-3-fast',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnvVar: 'XAI_API_KEY',
    maxTokens: 200,
    temperature: 0.3,
    promptStrategy: 'instruction-extraction',
    pricing: { inputPerMTok: 0.6, outputPerMTok: 2.4 },
  },
  {
    id: 'ollama-default',
    displayName: 'Ollama (local)',
    provider: 'ollama',
    modelId: 'qwen2.5-coder',
    baseUrl: 'http://localhost:11434/v1',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
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
export const DEFAULT_PRESET_ID = 'anthropic-haiku';

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

/** Get all built-in preset IDs. */
export function getBuiltInPresetIds(): string[] {
  return BUILT_IN_PRESETS.map((p) => p.id);
}
