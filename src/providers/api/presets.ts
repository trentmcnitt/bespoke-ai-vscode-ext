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
  },
  {
    id: 'openai-gpt-4.1-nano',
    displayName: 'GPT-4.1 Nano',
    description: 'Fastest, lowest cost',
    provider: 'openai',
    modelId: 'gpt-4.1-nano',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
  },
  {
    id: 'openai-gpt-4o-mini',
    displayName: 'GPT-4o Mini',
    description: 'Balanced cost/quality',
    provider: 'openai',
    modelId: 'gpt-4o-mini',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
  },
  {
    id: 'google-gemini-flash',
    displayName: 'Gemini 2.5 Flash',
    description: 'Very fast, very cheap',
    provider: 'google',
    modelId: 'gemini-2.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyEnvVar: 'GEMINI_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
  },
  {
    id: 'xai-grok',
    displayName: 'Grok 4.1 Fast',
    description: 'Fast, non-reasoning',
    provider: 'xai',
    modelId: 'grok-4-1-fast-non-reasoning',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnvVar: 'XAI_API_KEY',
    maxTokens: 200,
    temperature: 0.3,
    promptStrategy: 'instruction-extraction',
  },
  {
    id: 'xai-grok-code',
    displayName: 'Grok Code Fast',
    description: 'Coding-optimized',
    provider: 'xai',
    modelId: 'grok-code-fast-1',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnvVar: 'XAI_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
  },
  {
    id: 'xai-grok-4',
    displayName: 'Grok 4',
    description: 'Full capability',
    provider: 'xai',
    modelId: 'grok-4-0709',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnvVar: 'XAI_API_KEY',
    maxTokens: 200,
    temperature: 0.3,
    promptStrategy: 'instruction-extraction',
  },
  {
    id: 'openrouter-haiku',
    displayName: 'Haiku (OpenRouter)',
    description: 'Fast, low cost',
    provider: 'openrouter',
    modelId: 'anthropic/claude-haiku-4.5',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'prefill-extraction',
    features: { prefill: true },
    extraBody: { reasoning: { enabled: false } },
  },
  {
    id: 'openrouter-gpt-4.1-nano',
    displayName: 'GPT-4.1 Nano (OpenRouter)',
    description: 'Fastest, lowest cost',
    provider: 'openrouter',
    modelId: 'openai/gpt-4.1-nano',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
    extraBody: { reasoning: { enabled: false } },
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
      const provider =
        c.provider === 'openai-compat' ? 'openai' : (c.provider as Preset['provider']);
      const isAnthropicModel =
        c.provider === 'anthropic' ||
        (c.provider === 'openrouter' && c.modelId.startsWith('anthropic/'));
      const promptStrategy = isAnthropicModel ? 'prefill-extraction' : 'instruction-extraction';

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

      // Auto-populate baseUrl for providers that require non-default endpoints
      if (c.baseUrl) {
        preset.baseUrl = c.baseUrl;
      } else if (provider === 'google') {
        preset.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';
      } else if (provider === 'openrouter') {
        preset.baseUrl = 'https://openrouter.ai/api/v1';
      } else if (provider === 'ollama') {
        preset.baseUrl = 'http://localhost:11434/v1';
      }
      if (c.apiKeyEnvVar) {
        preset.apiKeyEnvVar = c.apiKeyEnvVar;
      } else if (provider === 'openrouter') {
        preset.apiKeyEnvVar = 'OPENROUTER_API_KEY';
      }

      // Anthropic features (direct API gets caching + prefill; OpenRouter gets prefill only)
      if (provider === 'anthropic') {
        preset.features = { promptCaching: true, prefill: true };
      } else if (isAnthropicModel) {
        preset.features = { prefill: true };
      }

      if (c.extraBody) preset.extraBody = c.extraBody;
      if (c.extraHeaders) preset.extraHeaders = c.extraHeaders;

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

/** Get all built-in preset IDs. */
export function getBuiltInPresetIds(): string[] {
  return BUILT_IN_PRESETS.map((p) => p.id);
}
