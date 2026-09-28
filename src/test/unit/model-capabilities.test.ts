import { describe, it, expect } from 'vitest';
import {
  anthropicModelCapabilities,
  normalizeAnthropicModelId,
} from '../../providers/api/model-capabilities';

describe('anthropicModelCapabilities', () => {
  it.each([
    'claude-sonnet-5-5',
    'claude-sonnet-5',
    'claude-opus-5',
    'claude-opus-5-5',
    'claude-opus-4-8',
    'claude-opus-4-7',
    'claude-fable-5',
    'claude-fable-5-1',
    'claude-mythos-5-1',
    'anthropic/claude-sonnet-5',
    'anthropic/claude-sonnet-5.5',
    'anthropic/claude-opus-4.7',
  ])('%s: no prefill, no sampling parameters', (id) => {
    expect(anthropicModelCapabilities(id)).toMatchObject({ prefill: false, sampling: false });
  });

  it.each(['claude-sonnet-5', 'claude-opus-5', 'anthropic/claude-sonnet-5'])(
    '%s: thinks by default and accepts thinking: disabled',
    (id) => {
      expect(anthropicModelCapabilities(id).thinkingOff).toBe('disabled');
    },
  );

  // Sonnet 5.5 400s on thinking: disabled; its lowest setting is between_tools.
  // Before exact matching, claude-sonnet-5-5 matched the claude-sonnet-5 prefix and
  // was sent `disabled`, which fails every request.
  it.each(['claude-sonnet-5-5', 'anthropic/claude-sonnet-5.5'])(
    '%s: turns thinking off with between_tools, never disabled',
    (id) => {
      expect(anthropicModelCapabilities(id).thinkingOff).toBe('between_tools');
    },
  );

  it.each([
    'claude-opus-5-5', // thinking always on: disabled is a 400
    'claude-fable-5-1', // thinking always on
    'claude-opus-4-8', // no thinking unless asked
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ])('%s: thinking field is not sent', (id) => {
    expect(anthropicModelCapabilities(id).thinkingOff).toBeNull();
  });

  it.each(['claude-opus-4-6', 'claude-sonnet-4-6', 'anthropic/claude-sonnet-4.6'])(
    '%s: no prefill, sampling parameters allowed',
    (id) => {
      expect(anthropicModelCapabilities(id)).toEqual({
        prefill: false,
        sampling: true,
        thinkingOff: null,
      });
    },
  );

  it.each([
    'claude-haiku-4-5-20251001',
    'claude-haiku-4-5',
    'anthropic/claude-haiku-4.5',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-20250514',
    'claude-opus-4-5',
    'claude-opus-4-1-20250805',
    'claude-3-5-sonnet-latest',
    'claude-3-haiku-20240307',
  ])('%s: pre-4.6 model keeps prefill and sampling', (id) => {
    expect(anthropicModelCapabilities(id)).toEqual({
      prefill: true,
      sampling: true,
      thinkingOff: null,
    });
  });

  // A model released after this table was written must not fail every request:
  // it gets the shape every model since Claude 4.6 accepts.
  it.each([
    'claude-sonnet-6',
    'claude-opus-6-5',
    'claude-fable-6',
    'claude-haiku-5',
    'claude-opus-4-60', // shares a prefix with claude-opus-4-6 but is a different id
    'anthropic/claude-sonnet-6',
    'claude-something-new',
  ])('%s: unknown newer model gets the safe modern shape', (id) => {
    expect(anthropicModelCapabilities(id)).toEqual({
      prefill: false,
      sampling: false,
      thinkingOff: null,
    });
  });

  it('matches exact ids, not prefixes', () => {
    // A dated or suffixed variant of a modern id is not assumed to share its caps.
    expect(anthropicModelCapabilities('claude-sonnet-5-5').thinkingOff).toBe('between_tools');
    expect(anthropicModelCapabilities('claude-sonnet-5').thinkingOff).toBe('disabled');
    expect(anthropicModelCapabilities('claude-sonnet-5-preview').thinkingOff).toBeNull();
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
