import { describe, it, expect } from 'vitest';
import { applyProfile } from '../../utils/profile';
import { makeConfig } from '../helpers';

describe('applyProfile', () => {
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

  it('overrides claudeCode model', () => {
    const base = makeConfig();
    const result = applyProfile(base, { claudeCode: { model: 'sonnet' } });
    expect(result.claudeCode.model).toBe('sonnet');
    expect(result.claudeCode.models).toEqual(base.claudeCode.models);
  });

  it('overrides logLevel', () => {
    const base = makeConfig();
    const result = applyProfile(base, { logLevel: 'trace' });
    expect(result.logLevel).toBe('trace');
  });
});
