import { describe, it, expect } from 'vitest';
import { ProviderRouter } from '../../providers/provider-router';
import { makeConfig, makeLogger } from '../helpers';

describe('ProviderRouter', () => {
  it('returns anthropic provider when backend is anthropic', () => {
    const router = new ProviderRouter(makeConfig(), makeLogger());
    const provider = router.getProvider('anthropic');
    expect(provider).toBeDefined();
    expect(provider.getCompletion).toBeTypeOf('function');
  });

  it('returns ollama provider when backend is ollama', () => {
    const router = new ProviderRouter(makeConfig(), makeLogger());
    const provider = router.getProvider('ollama');
    expect(provider).toBeDefined();
    expect(provider.getCompletion).toBeTypeOf('function');
  });

  it('reports anthropic as available when API key is set', () => {
    const router = new ProviderRouter(makeConfig(), makeLogger());
    expect(router.isBackendAvailable('anthropic')).toBe(true);
  });

  it('reports anthropic as unavailable when API key is empty', () => {
    const config = makeConfig();
    config.anthropic.apiKey = '';
    const router = new ProviderRouter(config, makeLogger());
    expect(router.isBackendAvailable('anthropic')).toBe(false);
  });

  it('always reports ollama as available (checked at request time)', () => {
    const router = new ProviderRouter(makeConfig(), makeLogger());
    expect(router.isBackendAvailable('ollama')).toBe(true);
  });

  it('returns claude-code provider when backend is claude-code', () => {
    const router = new ProviderRouter(makeConfig(), makeLogger());
    const provider = router.getProvider('claude-code');
    expect(provider).toBeDefined();
    expect(provider.getCompletion).toBeTypeOf('function');
  });

  it('reports claude-code as unavailable before activation', () => {
    const router = new ProviderRouter(makeConfig(), makeLogger());
    expect(router.isBackendAvailable('claude-code')).toBe(false);
  });

  it('reports anthropic as unavailable when apiCallsEnabled is false', () => {
    const config = makeConfig();
    config.anthropic.apiCallsEnabled = false;
    const router = new ProviderRouter(config, makeLogger());
    expect(router.isBackendAvailable('anthropic')).toBe(false);
  });

  it('updates config on all providers', () => {
    const router = new ProviderRouter(makeConfig(), makeLogger());
    const newConfig = makeConfig();
    newConfig.anthropic.apiKey = '';
    router.updateConfig(newConfig);
    expect(router.isBackendAvailable('anthropic')).toBe(false);
  });

  it('dispose does not throw', () => {
    const router = new ProviderRouter(makeConfig(), makeLogger());
    expect(() => router.dispose()).not.toThrow();
  });
});
