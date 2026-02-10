import { describe, it, expect } from 'vitest';
import { GeminiAdapter } from '../../providers/api/adapters/gemini';
import { Preset } from '../../providers/api/types';

const geminiPreset: Preset = {
  id: 'test-gemini',
  displayName: 'Test Gemini',
  provider: 'gemini',
  modelId: 'gemini-2.0-flash',
  apiKeyEnvVar: 'GEMINI_API_KEY',
  maxTokens: 200,
  temperature: 0.2,
  features: { contextCaching: true },
};

const noKeyPreset: Preset = {
  ...geminiPreset,
  id: 'test-no-key',
  apiKeyEnvVar: 'NONEXISTENT_GEMINI_KEY_FOR_TESTING',
};

describe('GeminiAdapter', () => {
  describe('isConfigured', () => {
    it('returns false when API key env var is not set', () => {
      const adapter = new GeminiAdapter(noKeyPreset);
      expect(adapter.isConfigured()).toBe(false);
    });

    it('returns false when card has no apiKeyEnvVar', () => {
      const presetNoKey: Preset = { ...geminiPreset, apiKeyEnvVar: undefined };
      const adapter = new GeminiAdapter(presetNoKey);
      expect(adapter.isConfigured()).toBe(false);
    });
  });

  describe('providerId', () => {
    it('is gemini', () => {
      const adapter = new GeminiAdapter(geminiPreset);
      expect(adapter.providerId).toBe('gemini');
    });
  });

  describe('dispose', () => {
    it('cleans up without error', () => {
      const adapter = new GeminiAdapter(geminiPreset);
      expect(() => adapter.dispose()).not.toThrow();
    });
  });

  describe('complete', () => {
    it('throws when API key is not available', async () => {
      const adapter = new GeminiAdapter(noKeyPreset);
      await expect(
        adapter.complete('system prompt', [{ role: 'user', content: 'test' }], {
          signal: new AbortController().signal,
          maxTokens: 100,
          temperature: 0.2,
        }),
      ).rejects.toThrow(/API key not found/);
    });
  });
});
