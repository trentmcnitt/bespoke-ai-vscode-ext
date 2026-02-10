import { describe, it, expect } from 'vitest';
import {
  getPreset,
  getAllPresets,
  getBuiltInPresetIds,
  calculateCost,
  DEFAULT_PRESET_ID,
} from '../../providers/api/presets';
import { Preset } from '../../providers/api/types';

describe('presets', () => {
  describe('built-in presets', () => {
    it('has a default preset', () => {
      const preset = getPreset(DEFAULT_PRESET_ID);
      expect(preset).toBeDefined();
      expect(preset!.id).toBe('anthropic-haiku-4-5');
      expect(preset!.provider).toBe('anthropic');
    });

    it('has multiple built-in presets', () => {
      const ids = getBuiltInPresetIds();
      expect(ids.length).toBeGreaterThanOrEqual(6);
      expect(ids).toContain('anthropic-haiku-4-5');
      expect(ids).toContain('anthropic-sonnet-4-5');
      expect(ids).toContain('openai-gpt-4o-mini');
      expect(ids).toContain('xai-grok-4-1-fast');
      expect(ids).toContain('ollama-default');
      expect(ids).toContain('gemini-flash');
    });

    it('getAllPresets returns all built-in presets', () => {
      const presets = getAllPresets();
      expect(presets.length).toBeGreaterThanOrEqual(6);
    });

    it('returns undefined for unknown preset ID', () => {
      expect(getPreset('nonexistent-preset')).toBeUndefined();
    });

    it('anthropic presets have prefill feature', () => {
      const haiku = getPreset('anthropic-haiku-4-5');
      expect(haiku?.features?.prefill).toBe(true);
      expect(haiku?.features?.promptCaching).toBe(true);
    });

    it('openai presets do not have prefill feature', () => {
      const gpt = getPreset('openai-gpt-4o-mini');
      expect(gpt?.features?.prefill).toBeUndefined();
    });

    it('ollama preset has no apiKeyEnvVar', () => {
      const ollama = getPreset('ollama-default');
      expect(ollama?.apiKeyEnvVar).toBeUndefined();
      expect(ollama?.baseUrl).toBe('http://localhost:11434/v1');
    });

    it('xai preset has custom baseUrl', () => {
      const xai = getPreset('xai-grok-4-1-fast');
      expect(xai?.baseUrl).toBe('https://api.x.ai/v1');
    });
  });

  describe('calculateCost', () => {
    const preset: Preset = {
      id: 'test',
      displayName: 'Test',
      provider: 'anthropic',
      modelId: 'test',
      maxTokens: 200,
      temperature: 0.2,
      pricing: {
        inputPerMTok: 1.0,
        outputPerMTok: 5.0,
        cacheReadPerMTok: 0.1,
      },
    };

    it('calculates cost from tokens', () => {
      const cost = calculateCost(preset, {
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 500,
      });
      // 1000/1M * 1.0 + 100/1M * 5.0 + 500/1M * 0.1
      // = 0.001 + 0.0005 + 0.00005
      expect(cost).toBeCloseTo(0.00155);
    });

    it('returns 0 when no pricing', () => {
      const noPricingPreset = { ...preset, pricing: undefined };
      expect(calculateCost(noPricingPreset, { inputTokens: 1000, outputTokens: 100 })).toBe(0);
    });

    it('handles zero tokens', () => {
      expect(calculateCost(preset, { inputTokens: 0, outputTokens: 0 })).toBe(0);
    });

    it('handles missing cache read tokens', () => {
      const cost = calculateCost(preset, { inputTokens: 1000, outputTokens: 100 });
      expect(cost).toBeCloseTo(0.0015);
    });
  });
});
