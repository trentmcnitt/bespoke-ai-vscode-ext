import { describe, it, expect, afterEach } from 'vitest';
import {
  getAllPresets,
  getPreset,
  getBuiltInPresetIds,
  registerCustomPresets,
  DEFAULT_PRESET_ID,
} from '../../providers/api/presets';

describe('Presets', () => {
  describe('getAllPresets', () => {
    it('returns a non-empty array', () => {
      const presets = getAllPresets();
      expect(presets.length).toBeGreaterThan(0);
    });

    it('returns a copy (not a reference)', () => {
      const a = getAllPresets();
      const b = getAllPresets();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it('all presets have required fields', () => {
      for (const preset of getAllPresets()) {
        expect(preset.id).toBeTruthy();
        expect(preset.displayName).toBeTruthy();
        expect(preset.provider).toBeTruthy();
        expect(preset.modelId).toBeTruthy();
        expect(preset.maxTokens).toBeGreaterThan(0);
        expect(preset.temperature).toBeGreaterThanOrEqual(0);
        expect(preset.promptStrategy).toBeTruthy();
      }
    });

    it('all presets have valid promptStrategy values', () => {
      const validStrategies = ['tag-extraction', 'prefill-extraction', 'instruction-extraction'];
      for (const preset of getAllPresets()) {
        expect(validStrategies).toContain(preset.promptStrategy);
      }
    });
  });

  describe('getPreset', () => {
    it('finds a preset by ID', () => {
      const preset = getPreset('anthropic-haiku');
      expect(preset).toBeDefined();
      expect(preset?.displayName).toBe('Haiku 4.5');
    });

    it('returns undefined for unknown ID', () => {
      expect(getPreset('nonexistent')).toBeUndefined();
    });
  });

  describe('getBuiltInPresetIds', () => {
    it('returns array of string IDs', () => {
      const ids = getBuiltInPresetIds();
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(typeof id).toBe('string');
      }
    });

    it('IDs match getAllPresets', () => {
      const ids = getBuiltInPresetIds();
      const presetIds = getAllPresets().map((p) => p.id);
      expect(ids).toEqual(presetIds);
    });
  });

  describe('DEFAULT_PRESET_ID', () => {
    it('corresponds to a valid preset', () => {
      expect(getPreset(DEFAULT_PRESET_ID)).toBeDefined();
    });
  });

  describe('Anthropic presets use prefill strategy', () => {
    it('anthropic-haiku uses prefill-extraction', () => {
      expect(getPreset('anthropic-haiku')?.promptStrategy).toBe('prefill-extraction');
    });

    it('anthropic-sonnet uses prefill-extraction', () => {
      expect(getPreset('anthropic-sonnet')?.promptStrategy).toBe('prefill-extraction');
    });
  });

  describe('Non-Anthropic presets use instruction strategy', () => {
    it('openai-gpt-4o-mini uses instruction-extraction', () => {
      expect(getPreset('openai-gpt-4o-mini')?.promptStrategy).toBe('instruction-extraction');
    });

    it('xai-grok uses instruction-extraction', () => {
      expect(getPreset('xai-grok')?.promptStrategy).toBe('instruction-extraction');
    });
  });

  describe('OpenRouter built-in presets', () => {
    it('openrouter-haiku uses prefill-extraction (Anthropic model)', () => {
      const preset = getPreset('openrouter-haiku');
      expect(preset).toBeDefined();
      expect(preset?.promptStrategy).toBe('prefill-extraction');
      expect(preset?.features?.prefill).toBe(true);
    });

    it('openrouter-gpt-4.1-nano uses instruction-extraction (non-Anthropic model)', () => {
      const preset = getPreset('openrouter-gpt-4.1-nano');
      expect(preset).toBeDefined();
      expect(preset?.promptStrategy).toBe('instruction-extraction');
      expect(preset?.features).toBeUndefined();
    });

    it('both OpenRouter presets use the OpenRouter base URL', () => {
      expect(getPreset('openrouter-haiku')?.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(getPreset('openrouter-gpt-4.1-nano')?.baseUrl).toBe('https://openrouter.ai/api/v1');
    });
  });

  describe('registerCustomPresets', () => {
    afterEach(() => {
      registerCustomPresets([]);
    });

    it('OpenRouter + Anthropic model gets prefill-extraction', () => {
      registerCustomPresets([
        {
          name: 'OR Sonnet',
          provider: 'openrouter',
          modelId: 'anthropic/claude-sonnet-4-5-20250929',
        },
      ]);
      const preset = getPreset('custom-or-sonnet');
      expect(preset).toBeDefined();
      expect(preset?.promptStrategy).toBe('prefill-extraction');
      expect(preset?.features?.prefill).toBe(true);
    });

    it('OpenRouter + non-Anthropic model gets instruction-extraction', () => {
      registerCustomPresets([{ name: 'OR GPT', provider: 'openrouter', modelId: 'openai/gpt-4o' }]);
      const preset = getPreset('custom-or-gpt');
      expect(preset).toBeDefined();
      expect(preset?.promptStrategy).toBe('instruction-extraction');
      expect(preset?.features).toBeUndefined();
    });

    it('direct Anthropic custom preset gets caching + prefill', () => {
      registerCustomPresets([
        { name: 'My Haiku', provider: 'anthropic', modelId: 'claude-haiku-4-5-20251001' },
      ]);
      const preset = getPreset('custom-my-haiku');
      expect(preset).toBeDefined();
      expect(preset?.promptStrategy).toBe('prefill-extraction');
      expect(preset?.features?.promptCaching).toBe(true);
      expect(preset?.features?.prefill).toBe(true);
    });

    it('auto-populates baseUrl for OpenRouter custom presets', () => {
      registerCustomPresets([
        { name: 'OR Test', provider: 'openrouter', modelId: 'meta-llama/llama-3-8b' },
      ]);
      expect(getPreset('custom-or-test')?.baseUrl).toBe('https://openrouter.ai/api/v1');
    });

    it('auto-populates apiKeyEnvVar for OpenRouter custom presets', () => {
      registerCustomPresets([
        { name: 'OR Key', provider: 'openrouter', modelId: 'meta-llama/llama-3-8b' },
      ]);
      expect(getPreset('custom-or-key')?.apiKeyEnvVar).toBe('OPENROUTER_API_KEY');
    });

    it('user-provided apiKeyEnvVar overrides the default', () => {
      registerCustomPresets([
        {
          name: 'OR Custom Key',
          provider: 'openrouter',
          modelId: 'openai/gpt-4o',
          apiKeyEnvVar: 'MY_KEY',
        },
      ]);
      expect(getPreset('custom-or-custom-key')?.apiKeyEnvVar).toBe('MY_KEY');
    });

    it('custom presets appear in getAllPresets', () => {
      registerCustomPresets([
        { name: 'Test Model', provider: 'openai-compat', modelId: 'test-model' },
      ]);
      const all = getAllPresets();
      expect(all.find((p) => p.id === 'custom-test-model')).toBeDefined();
    });

    it('does not override built-in presets', () => {
      registerCustomPresets([
        { name: 'anthropic-haiku', provider: 'openai-compat', modelId: 'fake' },
      ]);
      // The slugified ID would be "custom-anthropic-haiku", not "anthropic-haiku",
      // so this doesn't conflict. But verify built-in is unchanged.
      expect(getPreset('anthropic-haiku')?.provider).toBe('anthropic');
    });

    it('passes through extraBody to preset', () => {
      registerCustomPresets([
        {
          name: 'With Extra Body',
          provider: 'openrouter',
          modelId: 'meta-llama/llama-3-8b',
          extraBody: { transforms: [], provider: { order: ['Together'] } },
        },
      ]);
      const preset = getPreset('custom-with-extra-body');
      expect(preset?.extraBody).toEqual({
        transforms: [],
        provider: { order: ['Together'] },
      });
    });

    it('passes through extraHeaders to preset', () => {
      registerCustomPresets([
        {
          name: 'With Extra Headers',
          provider: 'openai-compat',
          modelId: 'test-model',
          extraHeaders: { 'X-Custom-Header': 'value123' },
        },
      ]);
      const preset = getPreset('custom-with-extra-headers');
      expect(preset?.extraHeaders).toEqual({ 'X-Custom-Header': 'value123' });
    });

    it('omits extraBody/extraHeaders when not provided', () => {
      registerCustomPresets([
        { name: 'No Extras', provider: 'openai-compat', modelId: 'plain-model' },
      ]);
      const preset = getPreset('custom-no-extras');
      expect(preset?.extraBody).toBeUndefined();
      expect(preset?.extraHeaders).toBeUndefined();
    });
  });
});
