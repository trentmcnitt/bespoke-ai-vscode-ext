import { describe, it, expect } from 'vitest';
import { commandFailureType, describeCommandFailure } from '../../utils/command-failure';

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

  it('surfaces the CLI result subtype', () => {
    expect(describeCommandFailure('cli_error_max_turns')).toBe(
      'Claude Code returned an error (error_max_turns).',
    );
  });

  it('falls back to the raw type for anything unknown', () => {
    expect(describeCommandFailure('something_new')).toBe('the request failed (something_new).');
  });
});
