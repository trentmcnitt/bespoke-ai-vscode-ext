import { describe, it, expect } from 'vitest';
import { displayModelName, shortenModelName } from '../../utils/model-name';

describe('shortenModelName', () => {
  it('strips claude- prefix and date suffix, converts version dots', () => {
    expect(shortenModelName('claude-haiku-4-5-20251001')).toBe('haiku-4.5');
  });

  it('strips claude- prefix and date suffix for single-version models', () => {
    expect(shortenModelName('claude-sonnet-4-20250514')).toBe('sonnet-4');
  });

  it('leaves non-Claude model names unchanged', () => {
    expect(shortenModelName('qwen2.5:3b')).toBe('qwen2.5:3b');
  });

  it('handles model without date suffix', () => {
    expect(shortenModelName('claude-haiku-4-5')).toBe('haiku-4.5');
  });

  it('handles opus model with version', () => {
    expect(shortenModelName('claude-opus-4-5-20251101')).toBe('opus-4.5');
  });

  it('handles unknown model format', () => {
    expect(shortenModelName('my-custom-model')).toBe('my-custom-model');
  });
});

describe('displayModelName', () => {
  it('formats a dated model ID with major.minor version', () => {
    expect(displayModelName('claude-opus-4-8-20250915')).toBe('Opus 4.8');
    expect(displayModelName('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5');
    expect(displayModelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
  });

  it('formats an undated alias-style ID', () => {
    expect(displayModelName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(displayModelName('claude-haiku-4-5')).toBe('Haiku 4.5');
  });

  it('formats a major-only dated ID', () => {
    expect(displayModelName('claude-sonnet-4-20250514')).toBe('Sonnet 4');
  });

  it('returns null for IDs outside the Claude naming pattern', () => {
    expect(displayModelName('qwen2.5:3b')).toBeNull();
    expect(displayModelName('my-custom-model')).toBeNull();
    expect(displayModelName('sonnet')).toBeNull();
    expect(displayModelName('claude-3-5-haiku-20241022')).toBeNull();
  });
});
