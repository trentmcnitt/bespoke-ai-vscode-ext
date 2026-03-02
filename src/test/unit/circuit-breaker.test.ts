import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CircuitBreaker } from '../../utils/circuit-breaker';
import { makeLogger } from '../helpers';

describe('CircuitBreaker', () => {
  const THRESHOLD = 5;
  const COOLDOWN_MS = 30_000;
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = new CircuitBreaker(THRESHOLD, COOLDOWN_MS, makeLogger(), 'test');
  });

  it('starts closed', () => {
    expect(breaker.isOpen()).toBe(false);
  });

  it('stays closed below failure threshold', () => {
    for (let i = 0; i < THRESHOLD - 1; i++) {
      breaker.recordFailure();
    }
    expect(breaker.isOpen()).toBe(false);
  });

  it('opens after reaching the failure threshold', () => {
    for (let i = 0; i < THRESHOLD; i++) {
      breaker.recordFailure();
    }
    expect(breaker.isOpen()).toBe(true);
  });

  it('auto-recovers after cooldown period', () => {
    for (let i = 0; i < THRESHOLD; i++) {
      breaker.recordFailure();
    }
    expect(breaker.isOpen()).toBe(true);

    vi.advanceTimersByTime(COOLDOWN_MS + 1);
    expect(breaker.isOpen()).toBe(false);
  });

  it('stays open during cooldown period', () => {
    for (let i = 0; i < THRESHOLD; i++) {
      breaker.recordFailure();
    }
    vi.advanceTimersByTime(COOLDOWN_MS - 1);
    expect(breaker.isOpen()).toBe(true);
  });

  it('recordSuccess resets consecutive failure count', () => {
    for (let i = 0; i < THRESHOLD - 1; i++) {
      breaker.recordFailure();
    }
    breaker.recordSuccess();
    // After reset, need full threshold again to open
    for (let i = 0; i < THRESHOLD - 1; i++) {
      breaker.recordFailure();
    }
    expect(breaker.isOpen()).toBe(false);
  });

  it('reset clears all state', () => {
    for (let i = 0; i < THRESHOLD; i++) {
      breaker.recordFailure();
    }
    expect(breaker.isOpen()).toBe(true);

    breaker.reset();
    expect(breaker.isOpen()).toBe(false);
  });

  it('consecutive failures reset on interleaved success', () => {
    // 3 failures, 1 success, then 3 more failures — should not open (total < threshold)
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
  });
});
