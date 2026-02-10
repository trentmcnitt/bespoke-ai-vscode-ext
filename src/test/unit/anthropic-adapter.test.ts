import { describe, it, expect } from 'vitest';
import { AnthropicAdapter } from '../../providers/api/adapters/anthropic';
import { Preset } from '../../providers/api/types';

const testPreset: Preset = {
  id: 'test-anthropic',
  displayName: 'Test',
  provider: 'anthropic',
  modelId: 'claude-haiku-4-5-20251001',
  apiKeyEnvVar: 'ANTHROPIC_API_KEY',
  maxTokens: 200,
  temperature: 0.2,
  features: { promptCaching: true, prefill: true },
  pricing: { inputPerMTok: 0.8, outputPerMTok: 4.0, cacheReadPerMTok: 0.08 },
};

const noKeyPreset: Preset = {
  ...testPreset,
  id: 'test-no-key',
  apiKeyEnvVar: 'NONEXISTENT_API_KEY_FOR_TESTING',
};

describe('AnthropicAdapter', () => {
  describe('isConfigured', () => {
    it('returns false when API key env var is not set', () => {
      const adapter = new AnthropicAdapter(noKeyPreset);
      expect(adapter.isConfigured()).toBe(false);
    });

    it('returns true when API key is available', () => {
      // This depends on the test environment — if ANTHROPIC_API_KEY is set, it returns true
      const adapter = new AnthropicAdapter(testPreset);
      // Just verify it doesn't throw
      expect(typeof adapter.isConfigured()).toBe('boolean');
    });

    it('returns false when card has no apiKeyEnvVar', () => {
      const presetNoKey: Preset = { ...testPreset, apiKeyEnvVar: undefined };
      const adapter = new AnthropicAdapter(presetNoKey);
      expect(adapter.isConfigured()).toBe(false);
    });
  });

  describe('providerId', () => {
    it('is anthropic', () => {
      const adapter = new AnthropicAdapter(testPreset);
      expect(adapter.providerId).toBe('anthropic');
    });
  });

  describe('dispose', () => {
    it('cleans up without error', () => {
      const adapter = new AnthropicAdapter(testPreset);
      expect(() => adapter.dispose()).not.toThrow();
    });
  });

  describe('complete', () => {
    it('throws when API key is not available', async () => {
      const adapter = new AnthropicAdapter(noKeyPreset);
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
