import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Debouncer } from '../../utils/debouncer';
import { createMockToken } from '../helpers';

describe('Debouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('basic debounce', () => {
    it('returns AbortSignal after delay completes', async () => {
      const debouncer = new Debouncer(1000);
      const token = createMockToken();

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(1000);
      const signal = await promise;

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
      debouncer.dispose();
    });

    it('does not resolve before delay', async () => {
      const debouncer = new Debouncer(1000);
      const token = createMockToken();

      let resolved = false;
      debouncer.debounce(token as any).then(() => {
        resolved = true;
      });

      vi.advanceTimersByTime(999);
      await vi.advanceTimersByTimeAsync(0); // flush microtasks
      expect(resolved).toBe(false);

      vi.advanceTimersByTime(1);
      await vi.advanceTimersByTimeAsync(0); // flush microtasks
      expect(resolved).toBe(true);
      debouncer.dispose();
    });
  });

  describe('cancellation', () => {
    it('returns null when token is cancelled during debounce', async () => {
      const debouncer = new Debouncer(1000);
      const token = createMockToken();

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(100);
      token.cancel();
      const signal = await promise;

      expect(signal).toBeNull();
      debouncer.dispose();
    });

    it('returns null when token is already cancelled', async () => {
      const debouncer = new Debouncer(1000);
      const token = createMockToken();
      token.cancel(); // pre-cancel

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(1000);
      const signal = await promise;

      // Should be null because token was already cancelled
      expect(signal).toBeNull();
      debouncer.dispose();
    });
  });

  describe('sequential debounce calls', () => {
    it('clears previous timer when called again', async () => {
      const debouncer = new Debouncer(1000);
      const token1 = createMockToken();
      const token2 = createMockToken();

      // Start first debounce
      const promise1 = debouncer.debounce(token1 as any);
      vi.advanceTimersByTime(100);

      // Start second debounce — clears first timer
      const promise2 = debouncer.debounce(token2 as any);
      vi.advanceTimersByTime(1000);

      const signal2 = await promise2;
      expect(signal2).toBeInstanceOf(AbortSignal);
      expect(signal2!.aborted).toBe(false);

      debouncer.dispose();
    });

    it('aborts previous HTTP request when new debounce starts', async () => {
      const debouncer = new Debouncer(1000);
      const token1 = createMockToken();
      const token2 = createMockToken();

      // Complete first debounce to get a signal
      const promise1 = debouncer.debounce(token1 as any);
      vi.advanceTimersByTime(1000);
      const signal1 = await promise1;

      // Start second debounce — should abort signal1
      const promise2 = debouncer.debounce(token2 as any);
      vi.advanceTimersByTime(1000);
      await promise2;

      expect(signal1!.aborted).toBe(true);

      debouncer.dispose();
    });
  });

  describe('abortCurrent', () => {
    it('aborts the current signal', async () => {
      const debouncer = new Debouncer(1000);
      const token = createMockToken();

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(1000);
      const signal = await promise;

      expect(signal!.aborted).toBe(false);
      debouncer.abortCurrent();
      expect(signal!.aborted).toBe(true);

      debouncer.dispose();
    });
  });

  describe('setDelay', () => {
    it('changes the debounce delay for subsequent calls', async () => {
      const debouncer = new Debouncer(1000);
      debouncer.setDelay(100);
      const token = createMockToken();

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(100);
      const signal = await promise;

      expect(signal).toBeInstanceOf(AbortSignal);
      debouncer.dispose();
    });
  });

  describe('dispose', () => {
    it('cleans up timers and aborts current signal', async () => {
      const debouncer = new Debouncer(1000);
      const token = createMockToken();

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(1000);
      const signal = await promise;

      debouncer.dispose();
      expect(signal!.aborted).toBe(true);
    });
  });

  describe('adaptive back-off', () => {
    it('returns base delay with zero dismissals', () => {
      const debouncer = new Debouncer(1000);
      expect(debouncer.getCurrentDelay()).toBe(1000);
    });

    it('increases delay after recordDismissal()', () => {
      const debouncer = new Debouncer(1000);
      debouncer.recordDismissal();
      expect(debouncer.getCurrentDelay()).toBeGreaterThan(1000);
    });

    it('follows the exponential formula for known dismissal counts', () => {
      const debouncer = new Debouncer(1000);

      // Verify monotonically increasing delays and known boundary values
      const delays: number[] = [];
      for (let i = 0; i <= 8; i++) {
        delays.push(debouncer.getCurrentDelay());
        debouncer.recordDismissal();
      }

      // Boundaries
      expect(delays[0]).toBe(1000);
      expect(delays[8]).toBe(30000);

      // Monotonically increasing
      for (let i = 1; i < delays.length; i++) {
        expect(delays[i]).toBeGreaterThan(delays[i - 1]);
      }

      // Midpoint (4 dismissals) should be sqrt(30)*1000 ≈ 5477
      expect(delays[4]).toBeGreaterThan(5400);
      expect(delays[4]).toBeLessThan(5550);
    });

    it('caps at MAX_BACKOFF_MS (30000) after 8 dismissals', () => {
      const debouncer = new Debouncer(1000);
      for (let i = 0; i < 10; i++) {
        debouncer.recordDismissal();
      }
      expect(debouncer.getCurrentDelay()).toBe(30000);
    });

    it('resets to base delay after resetBackoff()', () => {
      const debouncer = new Debouncer(1000);
      debouncer.recordDismissal();
      debouncer.recordDismissal();
      debouncer.recordDismissal();
      expect(debouncer.getCurrentDelay()).toBeGreaterThan(1000);

      debouncer.resetBackoff();
      expect(debouncer.getCurrentDelay()).toBe(1000);
      expect(debouncer.currentDismissalCount).toBe(0);
    });

    it('scales with a different base delay', () => {
      const debouncer = new Debouncer(500);
      expect(debouncer.getCurrentDelay()).toBe(500);

      // After 8 dismissals, still caps at 30000
      for (let i = 0; i < 8; i++) {
        debouncer.recordDismissal();
      }
      expect(debouncer.getCurrentDelay()).toBe(30000);
    });

    it('uses back-off delay in debounce()', async () => {
      const debouncer = new Debouncer(1000);

      // Add 1 dismissal → ~1534ms
      debouncer.recordDismissal();
      const effectiveDelay = debouncer.getCurrentDelay();

      const token = createMockToken();
      let resolved = false;
      debouncer.debounce(token as any).then(() => {
        resolved = true;
      });

      // Not resolved at base delay
      vi.advanceTimersByTime(1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      // Resolved at effective delay
      vi.advanceTimersByTime(effectiveDelay - 1000);
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);

      debouncer.dispose();
    });

    it('does not increment beyond MAX_DISMISSALS', () => {
      const debouncer = new Debouncer(1000);
      for (let i = 0; i < 20; i++) {
        debouncer.recordDismissal();
      }
      expect(debouncer.currentDismissalCount).toBe(8);
      expect(debouncer.getCurrentDelay()).toBe(30000);
    });
  });
});
