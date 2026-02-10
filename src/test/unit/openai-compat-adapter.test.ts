import { describe, it, expect } from 'vitest';
import { OpenAICompatAdapter } from '../../providers/api/adapters/openai-compat';
import { Preset } from '../../providers/api/types';

const openaiPreset: Preset = {
  id: 'test-openai',
  displayName: 'Test',
  provider: 'openai',
  modelId: 'gpt-4o-mini',
  apiKeyEnvVar: 'OPENAI_API_KEY',
  maxTokens: 200,
  temperature: 0.2,
};

const xaiPreset: Preset = {
  id: 'test-xai',
  displayName: 'Test xAI',
  provider: 'xai',
  modelId: 'grok-4-1-fast',
  baseUrl: 'https://api.x.ai/v1',
  apiKeyEnvVar: 'XAI_API_KEY',
  maxTokens: 200,
  temperature: 0.3,
};

const ollamaPreset: Preset = {
  id: 'test-ollama',
  displayName: 'Test Ollama',
  provider: 'ollama',
  modelId: 'qwen2.5-coder',
  baseUrl: 'http://localhost:11434/v1',
  maxTokens: 200,
  temperature: 0.2,
};

const noKeyPreset: Preset = {
  ...openaiPreset,
  id: 'test-no-key',
  apiKeyEnvVar: 'NONEXISTENT_OPENAI_KEY_FOR_TESTING',
};

describe('OpenAICompatAdapter', () => {
  describe('isConfigured', () => {
    it('returns false when API key env var is not set', () => {
      const adapter = new OpenAICompatAdapter(noKeyPreset);
      expect(adapter.isConfigured()).toBe(false);
    });

    it('returns true for Ollama (no key needed)', () => {
      const adapter = new OpenAICompatAdapter(ollamaPreset);
      expect(adapter.isConfigured()).toBe(true);
    });

    it('returns the correct providerId for OpenAI', () => {
      const adapter = new OpenAICompatAdapter(openaiPreset);
      expect(adapter.providerId).toBe('openai');
    });

    it('returns the correct providerId for xAI', () => {
      const adapter = new OpenAICompatAdapter(xaiPreset);
      expect(adapter.providerId).toBe('xai');
    });

    it('returns the correct providerId for Ollama', () => {
      const adapter = new OpenAICompatAdapter(ollamaPreset);
      expect(adapter.providerId).toBe('ollama');
    });
  });

  describe('dispose', () => {
    it('cleans up without error', () => {
      const adapter = new OpenAICompatAdapter(openaiPreset);
      expect(() => adapter.dispose()).not.toThrow();
    });
  });

  describe('complete', () => {
    it('throws when API key is not available (non-Ollama)', async () => {
      const adapter = new OpenAICompatAdapter(noKeyPreset);
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
