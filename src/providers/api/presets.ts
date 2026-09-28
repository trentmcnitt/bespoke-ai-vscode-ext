import { Preset } from './types';
import { CustomPreset } from '../../types';
import { resolveApiKey } from '../../utils/api-key-store';
import { anthropicModelCapabilities } from './model-capabilities';

/** True when the preset's model is a Claude model (direct API or OpenRouter `anthropic/…`). */
export function isAnthropicModel(provider: string, modelId: string): boolean {
  return (
    provider === 'anthropic' || (provider === 'openrouter' && modelId.startsWith('anthropic/'))
  );
}

/**
 * Set a Claude-model preset's prompt strategy and request features from the
 * model's capabilities (`model-capabilities.ts`). A model that accepts a
 * prefill uses `prefill-extraction`; one that rejects it uses
 * `tag-extraction`, the CLI backend's strategy, which sends no assistant
 * message. `features.sampling` is false when the model rejects `temperature`.
 * Prompt caching stays on for the direct Anthropic API. Non-Claude presets are
 * returned unchanged.
 */
export function withAnthropicCapabilities(preset: Preset): Preset {
  if (!isAnthropicModel(preset.provider, preset.modelId)) return preset;
  const caps = anthropicModelCapabilities(preset.modelId);
  const features: NonNullable<Preset['features']> = { ...preset.features, prefill: caps.prefill };
  if (preset.provider === 'anthropic') features.promptCaching = true;
  if (caps.sampling) delete features.sampling;
  else features.sampling = false;
  // Only the Anthropic adapter sends `thinking`; OpenRouter uses its own
  // `reasoning` field (set through extraBody), so it is not set there.
  if (caps.thinkingOff && preset.provider === 'anthropic') features.thinkingOff = caps.thinkingOff;
  else delete features.thinkingOff;
  return {
    ...preset,
    promptStrategy: caps.prefill ? 'prefill-extraction' : 'tag-extraction',
    features,
  };
}

const BUILT_IN_PRESET_DEFS: Preset[] = [
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
    displayName: 'Sonnet 5',
    description: 'Best quality',
    provider: 'anthropic',
    modelId: 'claude-sonnet-5',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 200,
    temperature: 0.2, // not sent: Sonnet 5 rejects sampling parameters
    // Sonnet 5 rejects an assistant prefill, so this preset uses the CLI's
    // tag extraction (withAnthropicCapabilities would set the same).
    promptStrategy: 'tag-extraction',
    // Sonnet 5 thinks by default; with a 200-token cap that can leave no text.
    features: { promptCaching: true, prefill: false, sampling: false, thinkingOff: 'disabled' },
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
  {
    id: 'ollama-default',
    displayName: 'Ollama (Qwen Coder 7B)',
    description: 'Local, free',
    provider: 'ollama',
    modelId: 'qwen2.5-coder:7b',
    baseUrl: 'http://localhost:11434',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
  },
  {
    id: 'ollama-qwen3-4b',
    displayName: 'Ollama (Qwen3 4B)',
    description: 'Local, free, general',
    provider: 'ollama',
    modelId: 'qwen3:4b',
    baseUrl: 'http://localhost:11434',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
  },
  {
    id: 'ollama-qwen3-8b',
    displayName: 'Ollama (Qwen3 8B)',
    description: 'Local, free, general',
    provider: 'ollama',
    modelId: 'qwen3:8b',
    baseUrl: 'http://localhost:11434',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
  },
  {
    id: 'ollama-qwen35-9b',
    displayName: 'Ollama (Qwen3.5 9B)',
    description: 'Local, free, general',
    provider: 'ollama',
    modelId: 'qwen3.5:9b',
    baseUrl: 'http://localhost:11434',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
  },
];

const BUILT_IN_PRESETS: Preset[] = BUILT_IN_PRESET_DEFS.map(withAnthropicCapabilities);

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
export function registerCustomPresets(customs: CustomPreset[]): string[] {
  const warnings: string[] = [];
  const builtInIds = new Set(BUILT_IN_PRESETS.map((p) => p.id));
  customPresets = customs
    .filter((c, i) => {
      if (!c.name || !c.provider || !c.modelId) {
        const label = c.name || `index ${i}`;
        const missing = !c.name ? 'name' : !c.provider ? 'provider' : 'modelId';
        warnings.push(`Custom preset "${label}" skipped: missing ${missing}`);
        return false;
      }
      return true;
    })
    .map((c) => {
      const id = slugify(c.name);
      const provider =
        c.provider === 'openai-compat' ? 'openai' : (c.provider as Preset['provider']);
      const preset: Preset = {
        id,
        displayName: c.name,
        description: 'custom',
        provider: provider as Preset['provider'],
        modelId: c.modelId,
        maxTokens: c.maxTokens ?? 200,
        temperature: c.temperature ?? 0.2,
        promptStrategy: 'instruction-extraction',
      };

      // Auto-populate baseUrl for providers that require non-default endpoints
      if (c.baseUrl) {
        preset.baseUrl = c.baseUrl;
      } else if (provider === 'google') {
        preset.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';
      } else if (provider === 'openrouter') {
        preset.baseUrl = 'https://openrouter.ai/api/v1';
      } else if (provider === 'ollama') {
        preset.baseUrl = 'http://localhost:11434';
      }
      if (c.apiKeyEnvVar) {
        preset.apiKeyEnvVar = c.apiKeyEnvVar;
      } else if (provider === 'anthropic') {
        preset.apiKeyEnvVar = 'ANTHROPIC_API_KEY';
      } else if (provider === 'google') {
        preset.apiKeyEnvVar = 'GEMINI_API_KEY';
      } else if (provider === 'openai') {
        preset.apiKeyEnvVar = 'OPENAI_API_KEY';
      } else if (provider === 'xai') {
        preset.apiKeyEnvVar = 'XAI_API_KEY';
      } else if (provider === 'openrouter') {
        preset.apiKeyEnvVar = 'OPENROUTER_API_KEY';
      }

      if (c.extraBody) preset.extraBody = c.extraBody;
      if (c.extraHeaders) preset.extraHeaders = c.extraHeaders;

      // Claude models (direct API, or OpenRouter `anthropic/…`): strategy,
      // prefill, sampling and (direct API) prompt caching come from the model.
      return withAnthropicCapabilities(preset);
    })
    .filter((p) => {
      if (builtInIds.has(p.id)) {
        warnings.push(
          `Custom preset "${p.displayName}" skipped: ID "${p.id}" conflicts with built-in preset`,
        );
        return false;
      }
      return true;
    });
  return warnings;
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
export const DEFAULT_PRESET_ID = 'xai-grok';

/** Get all built-in preset IDs. */
export function getBuiltInPresetIds(): string[] {
  return BUILT_IN_PRESETS.map((p) => p.id);
}

/** Check if a preset is available (no API key needed, or key is present). */
export function isPresetAvailable(preset: Preset): boolean {
  if (!preset.apiKeyEnvVar) return true;
  return !!resolveApiKey(preset.apiKeyEnvVar);
}

/** Find the first available preset, prioritizing custom presets over built-in. */
export function findFirstAvailablePreset(excludeId?: string): Preset | undefined {
  const all = [...customPresets, ...BUILT_IN_PRESETS];
  return all.find((p) => p.id !== excludeId && isPresetAvailable(p));
}
