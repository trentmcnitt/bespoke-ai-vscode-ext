import { describe, it, expect } from 'vitest';
import { ProviderRouter } from '../../providers/provider-router';
import { makeConfig } from '../helpers';

describe('ProviderRouter', () => {
  it('returns anthropic provider when backend is anthropic', () => {
    const router = new ProviderRouter(makeConfig());
    const provider = router.getProvider('anthropic');
    expect(provider).toBeDefined();
    expect(provider.getCompletion).toBeTypeOf('function');
  });

  it('returns ollama provider when backend is ollama', () => {
    const router = new ProviderRouter(makeConfig());
    const provider = router.getProvider('ollama');
    expect(provider).toBeDefined();
    expect(provider.getCompletion).toBeTypeOf('function');
  });

  it('reports anthropic as available when API key is set', () => {
    const router = new ProviderRouter(makeConfig());
    expect(router.isBackendAvailable('anthropic')).toBe(true);
  });

  it('reports anthropic as unavailable when API key is empty', () => {
    const config = makeConfig();
    config.anthropic.apiKey = '';
    const router = new ProviderRouter(config);
    expect(router.isBackendAvailable('anthropic')).toBe(false);
  });

  it('always reports ollama as available (checked at request time)', () => {
    const router = new ProviderRouter(makeConfig());
    expect(router.isBackendAvailable('ollama')).toBe(true);
  });

  it('updates config on both providers', () => {
    const router = new ProviderRouter(makeConfig());
    const newConfig = makeConfig();
    newConfig.anthropic.apiKey = '';
    router.updateConfig(newConfig);
    expect(router.isBackendAvailable('anthropic')).toBe(false);
  });
});
