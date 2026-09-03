import { describe, it, expect } from 'vitest';
import { isCreditBalanceError, detectCliAuthEnvVars } from '../../providers/slot-pool';

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

describe('detectCliAuthEnvVars', () => {
  it('reports CLI auth vars present in the environment', () => {
    expect(detectCliAuthEnvVars({ ANTHROPIC_API_KEY: 'sk-ant-xxx' })).toEqual([
      'ANTHROPIC_API_KEY',
    ]);
    expect(
      detectCliAuthEnvVars({ ANTHROPIC_API_KEY: 'sk-ant-xxx', ANTHROPIC_AUTH_TOKEN: 'tok' }),
    ).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
    expect(detectCliAuthEnvVars({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' })).toEqual([
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]);
  });

  it('ignores unrelated and empty vars', () => {
    expect(detectCliAuthEnvVars({ PATH: '/usr/bin', OPENAI_API_KEY: 'sk-xxx' })).toEqual([]);
    expect(detectCliAuthEnvVars({ ANTHROPIC_API_KEY: '' })).toEqual([]);
    expect(detectCliAuthEnvVars({})).toEqual([]);
  });
});
