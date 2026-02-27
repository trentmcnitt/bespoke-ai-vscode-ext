import { describe, it, expect } from 'vitest';
import {
  getAllPresets,
  getPreset,
  getBuiltInPresetIds,
  calculateCost,
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

  describe('calculateCost', () => {
    it('calculates cost from pricing and usage', () => {
      const preset = getPreset('anthropic-haiku')!;
      const cost = calculateCost(preset, {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
      });
      // haiku: $0.8/M in + $4.0/M out = $4.8
      expect(cost).toBeCloseTo(4.8);
    });

    it('includes cache read cost when available', () => {
      const preset = getPreset('anthropic-haiku')!;
      const cost = calculateCost(preset, {
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
      });
      // $0.8/M in + $0.08/M cache = $0.88
      expect(cost).toBeCloseTo(0.88);
    });

    it('returns 0 when preset has no pricing', () => {
      const preset = getPreset('ollama-default')!;
      expect(calculateCost(preset, { inputTokens: 100, outputTokens: 100 })).toBe(0);
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

    it('ollama-default uses instruction-extraction', () => {
      expect(getPreset('ollama-default')?.promptStrategy).toBe('instruction-extraction');
    });
  });
});
