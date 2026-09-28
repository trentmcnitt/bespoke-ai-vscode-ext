import { describe, it, expect } from 'vitest';
import {
  commandFailureType,
  commandUnavailableMessage,
  describeCommandFailure,
} from '../../utils/command-failure';

describe('commandFailureType', () => {
  it('is null for a reply, a cancellation, or a bare null', () => {
    expect(commandFailureType({ text: 'ok', meta: null })).toBeNull();
    expect(commandFailureType({ text: null, meta: null, aborted: true })).toBeNull();
    expect(
      commandFailureType({ text: null, meta: null, detail: { aborted: true, errorType: '429' } }),
    ).toBeNull();
    expect(commandFailureType({ text: null, meta: null })).toBeNull();
  });

  it('returns the pool errorType, or the API detail errorType', () => {
    expect(commandFailureType({ text: null, meta: null, errorType: 'pool_recycled' })).toBe(
      'pool_recycled',
    );
    expect(commandFailureType({ text: null, meta: null, detail: { errorType: '529' } })).toBe(
      '529',
    );
  });
});

describe('describeCommandFailure', () => {
  it.each([
    ['pool_recycled', 'restarted'],
    ['pool_warmup_failed', 'failed to start'],
    ['slot_stream_error', 'session failed'],
    ['slot_stream_ended', 'exited before answering'],
    ['slot_unavailable', 'Restart Pools'],
    ['pool_circuit_open', 'crashing repeatedly'],
    ['pool_error', 'did not respond'],
    ['429', 'rate limit'],
    ['529', 'overloaded'],
    ['connection_refused', 'Ollama'],
  ])('%s names the cause', (type, phrase) => {
    expect(describeCommandFailure(type)).toContain(phrase);
  });

  it('explains a Claude Code usage-limit notice instead of the raw type', () => {
    expect(describeCommandFailure('cli_usage_limit')).toMatch(/usage limit/);
    expect(describeCommandFailure('cli_notice')).toMatch(/notice instead of an answer/);
  });

  it('says a command timed out instead of showing the raw type', () => {
    expect(describeCommandFailure('timeout')).toMatch(/did not answer in time/);
  });

  it('surfaces the CLI result subtype', () => {
    expect(describeCommandFailure('cli_error_max_turns')).toBe(
      'Claude Code returned an error (error_max_turns).',
    );
  });

  it('falls back to the raw type for anything unknown', () => {
    expect(describeCommandFailure('something_new')).toBe('the request failed (something_new).');
  });
});

describe('commandUnavailableMessage', () => {
  it('keeps the pool message on the Claude Code backend', () => {
    expect(commandUnavailableMessage('claude-code', null)).toBe(
      'Command pool not ready. Try again in a moment.',
    );
  });

  it('names a missing API key and the command to enter one', () => {
    expect(
      commandUnavailableMessage('api', {
        kind: 'no_key',
        presetId: 'xai-grok',
        displayName: 'Grok 4.1 Fast',
      }),
    ).toBe('No API key for Grok 4.1 Fast. Run "Bespoke AI: Enter API Key".');
  });

  it('says the API is paused and when it retries (rounded up to whole seconds)', () => {
    const reason = { presetId: 'x', displayName: 'X', kind: 'breaker_open' as const };
    expect(commandUnavailableMessage('api', { ...reason, retryInMs: 12_300 })).toBe(
      'Paused after repeated API errors — retrying in 13 s.',
    );
    expect(commandUnavailableMessage('api', { ...reason, retryInMs: 5 })).toContain('in 1 s');
  });

  it('names an unknown preset', () => {
    expect(commandUnavailableMessage('api', { kind: 'no_preset', presetId: 'gone' })).toBe(
      'API preset "gone" is not available. Check the bespokeAI.api.preset setting.',
    );
  });

  it('names a preset that could not be loaded', () => {
    expect(
      commandUnavailableMessage('api', { kind: 'adapter_failed', presetId: 'p', displayName: 'P' }),
    ).toContain('API preset "P" could not be loaded');
  });

  it('falls back to a generic API message with no reason', () => {
    expect(commandUnavailableMessage('api', null)).toBe(
      'API backend not ready. Try again in a moment.',
    );
  });
});
