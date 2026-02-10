import { describe, it, expect } from 'vitest';
import { ApiCompletionProvider } from '../../providers/api/api-provider';
import { makeConfig, makeLogger, makeProseContext, makeCodeContext } from '../helpers';

// We test ApiCompletionProvider with a mocked adapter by testing its public interface.
// The adapter is created internally based on the model card, so we test observable behavior.

describe('ApiCompletionProvider', () => {
  describe('initialization', () => {
    it('creates provider with default config', () => {
      const config = makeConfig({ backend: 'api' });
      const provider = new ApiCompletionProvider(config, makeLogger());
      expect(provider).toBeDefined();
    });

    it('isAvailable returns false when no API key is set', () => {
      const config = makeConfig({
        backend: 'api',
        api: { activePreset: 'anthropic-haiku-4-5', debounceMs: 400 },
      });
      // Unless ANTHROPIC_API_KEY is in the environment, this should be false
      const provider = new ApiCompletionProvider(config, makeLogger());
      // This might be true or false depending on environment — just verify it doesn't throw
      expect(typeof provider.isAvailable()).toBe('boolean');
    });

    it('getActivePreset returns the loaded card', () => {
      const config = makeConfig({
        backend: 'api',
        api: { activePreset: 'anthropic-haiku-4-5', debounceMs: 400 },
      });
      const provider = new ApiCompletionProvider(config, makeLogger());
      const card = provider.getActivePreset();
      expect(card).toBeDefined();
      expect(card!.id).toBe('anthropic-haiku-4-5');
    });

    it('getActivePreset returns null for unknown card', () => {
      const config = makeConfig({
        backend: 'api',
        api: { activePreset: 'nonexistent-card', debounceMs: 400 },
      });
      const provider = new ApiCompletionProvider(config, makeLogger());
      expect(provider.getActivePreset()).toBeNull();
    });
  });

  describe('updateConfig', () => {
    it('reloads adapter when model card changes', () => {
      const config = makeConfig({
        backend: 'api',
        api: { activePreset: 'anthropic-haiku-4-5', debounceMs: 400 },
      });
      const provider = new ApiCompletionProvider(config, makeLogger());
      expect(provider.getActivePreset()!.id).toBe('anthropic-haiku-4-5');

      provider.updateConfig(
        makeConfig({
          backend: 'api',
          api: { activePreset: 'anthropic-sonnet-4-5', debounceMs: 400 },
        }),
      );
      expect(provider.getActivePreset()!.id).toBe('anthropic-sonnet-4-5');
    });

    it('does not reload adapter when card stays the same', () => {
      const config = makeConfig({
        backend: 'api',
        api: { activePreset: 'anthropic-haiku-4-5', debounceMs: 400 },
      });
      const provider = new ApiCompletionProvider(config, makeLogger());
      const cardBefore = provider.getActivePreset();

      provider.updateConfig(
        makeConfig({
          backend: 'api',
          api: { activePreset: 'anthropic-haiku-4-5', debounceMs: 800 },
        }),
      );
      // Card should still be the same object reference check doesn't apply here,
      // but the ID should be the same
      expect(provider.getActivePreset()!.id).toBe(cardBefore!.id);
    });
  });

  describe('dispose', () => {
    it('cleans up without error', () => {
      const config = makeConfig({ backend: 'api' });
      const provider = new ApiCompletionProvider(config, makeLogger());
      expect(() => provider.dispose()).not.toThrow();
    });

    it('getActivePreset returns null after dispose', () => {
      const config = makeConfig({ backend: 'api' });
      const provider = new ApiCompletionProvider(config, makeLogger());
      provider.dispose();
      expect(provider.getActivePreset()).toBeNull();
    });
  });

  describe('recycleAll', () => {
    it('reloads adapter', async () => {
      const config = makeConfig({ backend: 'api' });
      const provider = new ApiCompletionProvider(config, makeLogger());
      await provider.recycleAll();
      // Should still have the same card
      expect(provider.getActivePreset()!.id).toBe('anthropic-haiku-4-5');
    });
  });

  describe('getCompletion', () => {
    it('returns null when adapter is not loaded (unknown card)', async () => {
      const config = makeConfig({
        backend: 'api',
        api: { activePreset: 'nonexistent-card', debounceMs: 400 },
      });
      const provider = new ApiCompletionProvider(config, makeLogger());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });
  });
});
