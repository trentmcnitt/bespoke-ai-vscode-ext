import { Preset } from './types';
import { CustomPreset } from '../../types';

const BUILT_IN_PRESETS: Preset[] = [
  {
    id: 'anthropic-haiku',
    displayName: 'Haiku 4.5',
    description: 'Fast, low cost',
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
    description: 'Best quality',
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
    description: 'Cheapest option',
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
    description: 'Fast, competitive pricing',
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
    description: 'Free, runs locally',
    provider: 'ollama',
    modelId: 'qwen2.5-coder',
    baseUrl: 'http://localhost:11434/v1',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
  },
];

let customPresets: Preset[] = [];

/** Slugify a display name into a custom preset ID. */
export function slugify(name: string): string {
  return `custom-${name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`;
}

/**
 * Register custom presets from user settings.
 * Converts CustomPreset objects into full Preset objects and merges them
 * with built-in presets. Custom presets with IDs that conflict with
 * built-in presets are skipped.
 */
export function registerCustomPresets(customs: CustomPreset[]): void {
  const builtInIds = new Set(BUILT_IN_PRESETS.map((p) => p.id));
  customPresets = customs
    .filter((c) => c.name && c.provider && c.modelId)
    .map((c) => {
      const id = slugify(c.name);
      const provider = c.provider === 'openai-compat' ? 'openai' : c.provider;
      const promptStrategy =
        c.provider === 'anthropic' ? 'prefill-extraction' : 'instruction-extraction';

      const preset: Preset = {
        id,
        displayName: c.name,
        description: 'custom',
        provider: provider as Preset['provider'],
        modelId: c.modelId,
        maxTokens: c.maxTokens ?? 200,
        temperature: c.temperature ?? 0.2,
        promptStrategy,
      };

      if (c.baseUrl) preset.baseUrl = c.baseUrl;
      if (c.apiKeyEnvVar) preset.apiKeyEnvVar = c.apiKeyEnvVar;

      // Anthropic features
      if (provider === 'anthropic') {
        preset.features = { promptCaching: true, prefill: true };
      }

      return preset;
    })
    .filter((p) => !builtInIds.has(p.id));
}

/** Get all available presets (built-in + custom). */
export function getAllPresets(): Preset[] {
  return [...BUILT_IN_PRESETS, ...customPresets];
}

/** Find a preset by ID. Searches built-in presets first, then custom. */
export function getPreset(id: string): Preset | undefined {
  return BUILT_IN_PRESETS.find((p) => p.id === id) ?? customPresets.find((p) => p.id === id);
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
