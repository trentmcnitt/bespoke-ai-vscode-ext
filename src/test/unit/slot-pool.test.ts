import { describe, it, expect } from 'vitest';
import { isCreditBalanceError } from '../../providers/slot-pool';

describe('isCreditBalanceError', () => {
  it('matches the Anthropic pay-per-token billing error', () => {
    expect(isCreditBalanceError('Credit balance is too low')).toBe(true);
  });

  it('matches case-insensitively and when embedded in a longer message', () => {
    expect(isCreditBalanceError('Error: your credit balance is too low to continue')).toBe(true);
    expect(isCreditBalanceError('CREDIT BALANCE IS TOO LOW')).toBe(true);
  });

  it('does not match unrelated warmup content', () => {
    expect(isCreditBalanceError('OK')).toBe(false);
    expect(isCreditBalanceError('The user has a healthy credit balance.')).toBe(false);
    expect(isCreditBalanceError('balance is too low')).toBe(false);
    expect(isCreditBalanceError('')).toBe(false);
  });
});
