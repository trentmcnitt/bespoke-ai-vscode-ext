import { describe, it, expect } from 'vitest';
import { applyProfile } from '../../utils/profile';
import { makeConfig } from '../helpers';

describe('applyProfile', () => {
  it('overrides backend', () => {
    const base = makeConfig();
    const result = applyProfile(base, { backend: 'ollama' });
    expect(result.backend).toBe('ollama');
  });

  it('overrides nested anthropic model', () => {
    const base = makeConfig();
    const result = applyProfile(base, { anthropic: { model: 'claude-sonnet-4-20250514' } });
    expect(result.anthropic.model).toBe('claude-sonnet-4-20250514');
  });

  it('preserves apiKey from base config (security guard)', () => {
    const base = makeConfig({
      anthropic: { apiKey: 'secret-key', model: 'claude-haiku-4-5-20251001', useCaching: false },
    });
    const result = applyProfile(base, { anthropic: { model: 'claude-sonnet-4-20250514' } });
    expect(result.anthropic.apiKey).toBe('secret-key');
  });

  it('does not allow profile to inject apiKey', () => {
    const base = makeConfig({
      anthropic: { apiKey: 'real-key', model: 'claude-haiku-4-5-20251001', useCaching: false },
    });
    // ProfileOverrides type excludes apiKey, but test the runtime guard with a cast
    const malicious = {
      anthropic: { apiKey: 'injected-key', model: 'x' },
    } as unknown as Parameters<typeof applyProfile>[1];
    const result = applyProfile(base, malicious);
    expect(result.anthropic.apiKey).toBe('real-key');
  });

  it('merges prose settings partially', () => {
    const base = makeConfig();
    const result = applyProfile(base, { prose: { temperature: 0.3 } });
    expect(result.prose.temperature).toBe(0.3);
    expect(result.prose.maxTokens).toBe(base.prose.maxTokens);
  });

  it('merges code settings partially', () => {
    const base = makeConfig();
    const result = applyProfile(base, { code: { maxTokens: 512 } });
    expect(result.code.maxTokens).toBe(512);
    expect(result.code.temperature).toBe(base.code.temperature);
  });

  it('leaves base unchanged with empty profile', () => {
    const base = makeConfig();
    const result = applyProfile(base, {});
    expect(result).toEqual(base);
  });

  it('overrides mode and debounceMs', () => {
    const base = makeConfig();
    const result = applyProfile(base, { mode: 'code', debounceMs: 500 });
    expect(result.mode).toBe('code');
    expect(result.debounceMs).toBe(500);
  });

  it('overrides ollama settings', () => {
    const base = makeConfig();
    const result = applyProfile(base, { ollama: { model: 'llama3:8b', raw: false } });
    expect(result.ollama.model).toBe('llama3:8b');
    expect(result.ollama.raw).toBe(false);
    expect(result.ollama.endpoint).toBe(base.ollama.endpoint);
  });

  it('overrides claudeCode model', () => {
    const base = makeConfig();
    const result = applyProfile(base, { claudeCode: { model: 'sonnet' } });
    expect(result.claudeCode.model).toBe('sonnet');
    expect(result.claudeCode.models).toEqual(base.claudeCode.models);
  });

  it('overrides backend to claude-code', () => {
    const base = makeConfig();
    const result = applyProfile(base, { backend: 'claude-code' });
    expect(result.backend).toBe('claude-code');
  });
});
