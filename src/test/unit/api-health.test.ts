import { describe, it, expect } from 'vitest';
import { classifyApiConnectionError, describeApiConnectionError } from '../../utils/api-health';

describe('classifyApiConnectionError', () => {
  it('classifies Anthropic credit-balance errors as billing', () => {
    expect(
      classifyApiConnectionError(
        'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing.',
      ),
    ).toBe('billing');
  });

  it('classifies OpenAI insufficient_quota errors as billing', () => {
    expect(
      classifyApiConnectionError('429 You exceeded your current quota (insufficient_quota).'),
    ).toBe('billing');
  });

  it('classifies generic "insufficient credits" as billing', () => {
    expect(classifyApiConnectionError('Error: insufficient credits')).toBe('billing');
  });

  it('classifies Anthropic invalid key errors as auth', () => {
    expect(
      classifyApiConnectionError(
        '401 {"type":"authentication_error","message":"invalid x-api-key"}',
      ),
    ).toBe('auth');
  });

  it('classifies OpenAI incorrect-key errors as auth', () => {
    expect(classifyApiConnectionError('Incorrect API key provided: sk-xxx.')).toBe('auth');
  });

  it('classifies network/timeout errors as transient', () => {
    expect(classifyApiConnectionError('The operation was aborted due to timeout')).toBe(
      'transient',
    );
    expect(classifyApiConnectionError('fetch failed: ECONNREFUSED')).toBe('transient');
    expect(classifyApiConnectionError('500 Internal Server Error')).toBe('transient');
  });

  it('treats empty/unknown errors as transient', () => {
    expect(classifyApiConnectionError('')).toBe('transient');
    expect(classifyApiConnectionError('something weird happened')).toBe('transient');
  });

  it('prefers billing over auth when both signals present', () => {
    // A 402 with an "unauthorized"-ish word: billing is the higher-signal cause.
    expect(
      classifyApiConnectionError('402 payment required — credit balance too low, access denied'),
    ).toBe('billing');
  });
});

describe('describeApiConnectionError', () => {
  it('produces billing-specific guidance and includes the raw provider text', () => {
    const { message, detail } = describeApiConnectionError(
      'xAI Grok',
      'billing',
      'Your credit balance is too low',
    );
    expect(message).toContain('xAI Grok');
    expect(message).toMatch(/credit/i);
    expect(detail).toContain('Your credit balance is too low');
  });

  it('produces auth-specific guidance', () => {
    const { message, detail } = describeApiConnectionError(
      'Anthropic Haiku',
      'auth',
      'invalid x-api-key',
    );
    expect(message).toMatch(/key/i);
    expect(detail).toMatch(/valid key|invalid|unauthorized/i);
  });

  it('produces generic guidance for transient failures', () => {
    const { message } = describeApiConnectionError('Ollama', 'transient', 'ECONNREFUSED');
    expect(message).toContain('Ollama');
  });

  it('collapses whitespace and truncates very long provider errors', () => {
    const long = 'x'.repeat(500);
    const { detail } = describeApiConnectionError('Preset', 'billing', long);
    // 200-char snippet cap + ellipsis, embedded in the detail sentence.
    expect(detail).toContain('…');
    expect(detail.length).toBeLessThan(400);
  });

  it('omits the "Provider said" clause when the raw error is empty', () => {
    const { detail } = describeApiConnectionError('Preset', 'billing', '');
    expect(detail).not.toContain('Provider said');
  });
});
