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

  describe('getCurrentDelay (back-off disabled)', () => {
    it('returns base delay', () => {
      const debouncer = new Debouncer(1000);
      expect(debouncer.getCurrentDelay()).toBe(1000);
    });

    it('returns updated delay after setDelay', () => {
      const debouncer = new Debouncer(1000);
      debouncer.setDelay(5000);
      expect(debouncer.getCurrentDelay()).toBe(5000);
    });
  });

  describe('overrideDelayMs', () => {
    it('overrideDelayMs bypasses base delay', async () => {
      const debouncer = new Debouncer(8000);

      const token = createMockToken();
      let resolved = false;
      // Use overrideDelayMs to fire immediately
      debouncer.debounce(token as any, 0).then(() => {
        resolved = true;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);

      debouncer.dispose();
    });

    it('overrideDelayMs uses specified delay', async () => {
      const debouncer = new Debouncer(8000);

      const token = createMockToken();
      let resolved = false;
      debouncer.debounce(token as any, 100).then(() => {
        resolved = true;
      });

      // Should NOT be resolved before override delay
      vi.advanceTimersByTime(99);
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(false);

      // Should be resolved at override delay
      vi.advanceTimersByTime(1);
      await vi.advanceTimersByTimeAsync(0);
      expect(resolved).toBe(true);

      debouncer.dispose();
    });
  });

  // --- Adaptive back-off tests (commented out — back-off is disabled) ---
  // describe('adaptive back-off', () => {
  //   it('returns base delay with zero dismissals', () => { ... });
  //   it('increases delay after recordDismissal()', () => { ... });
  //   it('follows the exponential formula for known dismissal counts', () => { ... });
  //   it('caps at MAX_BACKOFF_MS after MAX_DISMISSALS dismissals', () => { ... });
  //   it('resets to base delay after resetBackoff()', () => { ... });
  //   it('scales with a different base delay', () => { ... });
  //   it('uses back-off delay in debounce()', () => { ... });
  //   it('does not increment beyond MAX_DISMISSALS', () => { ... });
  // });
});
