import { describe, it, expect } from 'vitest';
import {
  anthropicModelCapabilities,
  normalizeAnthropicModelId,
} from '../../providers/api/model-capabilities';

describe('anthropicModelCapabilities', () => {
  it.each([
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-fable-5-1',
    'claude-mythos-5-1',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-opus-4.7',
  ])('%s: no prefill, no sampling parameters', (id) => {
    expect(anthropicModelCapabilities(id)).toMatchObject({ prefill: false, sampling: false });
  });

  it.each(['claude-sonnet-5', 'claude-opus-5', 'anthropic/claude-sonnet-5'])(
    '%s: thinks by default, so thinking is disabled',
    (id) => {
      expect(anthropicModelCapabilities(id).disableThinking).toBe(true);
    },
  );

  it.each([
    'claude-opus-5-5', // rejects thinking: disabled
    'claude-fable-5-1', // rejects thinking: disabled
    'claude-opus-4-8', // no thinking unless asked
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ])('%s: thinking field is not sent', (id) => {
    expect(anthropicModelCapabilities(id).disableThinking).toBe(false);
  });

  it.each(['claude-opus-4-6', 'claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6'])(
    '%s: no prefill, sampling parameters allowed',
    (id) => {
      expect(anthropicModelCapabilities(id)).toEqual({
        prefill: false,
        sampling: true,
        disableThinking: false,
      });
    },
  );

  it.each([
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-5',
    'anthropic/claude-haiku-4.5',
    'claude-sonnet-4-5-20250929',
    'claude-opus-4-5',
    'claude-3-5-sonnet-latest',
    'claude-something-new',
  ])('%s: unknown or older model keeps prefill and sampling', (id) => {
    expect(anthropicModelCapabilities(id)).toEqual({
      prefill: true,
      sampling: true,
      disableThinking: false,
    });
  });

  it('does not match a longer version number that shares a prefix', () => {
    // `claude-opus-4-6` must not claim a hypothetical `claude-opus-4-60`.
    expect(anthropicModelCapabilities('claude-opus-4-60')).toEqual({
      prefill: true,
      sampling: true,
      disableThinking: false,
    });
  });

  it('returns a fresh object each call', () => {
    const a = anthropicModelCapabilities('claude-sonnet-5');
    a.prefill = true;
    expect(anthropicModelCapabilities('claude-sonnet-5').prefill).toBe(false);
  });

  it('normalises OpenRouter ids', () => {
    expect(normalizeAnthropicModelId(' Anthropic/Claude-Opus-4.6 ')).toBe('claude-opus-4-6');
  });
});
