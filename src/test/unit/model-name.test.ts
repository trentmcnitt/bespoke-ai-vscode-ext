import { describe, it, expect } from 'vitest';
import { shortenModelName } from '../../utils/model-name';

describe('shortenModelName', () => {
  it('strips claude- prefix and date suffix, converts version dots', () => {
    expect(shortenModelName('claude-haiku-4-5-20251001')).toBe('haiku-4.5');
  });

  it('strips claude- prefix and date suffix for single-version models', () => {
    expect(shortenModelName('claude-sonnet-4-20250514')).toBe('sonnet-4');
  });

  it('leaves Ollama model names unchanged', () => {
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
