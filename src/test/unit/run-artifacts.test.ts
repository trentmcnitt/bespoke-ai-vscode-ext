import { describe, it, expect } from 'vitest';
import { attributeResult, attributeThrown, detailSummary } from '../quality/run-artifacts';
import { GenerationDetail, attachDetailToError } from '../../utils/trace';

const base: GenerationDetail = { providerName: 'anthropic', requestModel: 'claude-haiku-4-5' };

// The quality runner used to call getCompletion() and discard the detail, so a
// swallowed HTTP 429 was saved as an empty completion with `error: null`.
describe('quality runner — result attribution', () => {
  it('a completion is ok', () => {
    expect(attributeResult({ text: ' more', detail: base })).toEqual({ outcome: 'ok' });
  });

  it('a genuine empty (model replied, nothing usable) is empty with no error', () => {
    const r = attributeResult({
      text: null,
      detail: { ...base, outputTokens: 4, finishReason: 'end_turn' },
    });
    expect(r).toEqual({ outcome: 'empty' });
  });

  it.each(['429', '529', 'circuit_open'])(
    'a swallowed %s is an error, with a type and a non-null error string',
    (errorType) => {
      const r = attributeResult({ text: null, detail: { ...base, errorType } });
      expect(r.outcome).toBe('error');
      expect(r.errorType).toBe(errorType);
      expect(r.error).toContain(errorType);
    },
  );

  it('an aborted request (e.g. the 30s runner timeout) is aborted, not empty', () => {
    const r = attributeResult({ text: null, detail: { ...base, aborted: true } });
    expect(r.outcome).toBe('aborted');
    expect(r.error).toBeDefined();
  });

  it('a null with no detail at all is empty (nothing to attribute it to)', () => {
    expect(attributeResult({ text: null })).toEqual({ outcome: 'empty' });
  });

  it('a thrown error keeps its message and gets a type (attached detail wins)', () => {
    const plain = Object.assign(new Error('overloaded'), { status: 500 });
    expect(attributeThrown(plain)).toEqual({
      outcome: 'error',
      errorType: '500',
      error: 'overloaded',
    });
    const withDetail = new Error('pool');
    attachDetailToError(withDetail, { ...base, errorType: 'pool_error' });
    expect(attributeThrown(withDetail).errorType).toBe('pool_error');
  });

  it('detailSummary keeps numbers and finish reason, never content', () => {
    const s = detailSummary({
      ...base,
      outputTokens: 3,
      finishReason: 'end_turn',
      content: { systemPrompt: 'SECRET', userMessage: 'SECRET', rawOutput: 'SECRET' },
    });
    expect(s).toMatchObject({ outputTokens: 3, finishReason: 'end_turn' });
    expect(JSON.stringify(s)).not.toContain('SECRET');
    expect(detailSummary(undefined)).toBeNull();
  });
});
