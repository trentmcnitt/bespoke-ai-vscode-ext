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
      const debouncer = new Debouncer(300);
      const token = createMockToken();

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(300);
      const signal = await promise;

      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal!.aborted).toBe(false);
      debouncer.dispose();
    });

    it('does not resolve before delay', async () => {
      const debouncer = new Debouncer(300);
      const token = createMockToken();

      let resolved = false;
      debouncer.debounce(token as any).then(() => {
        resolved = true;
      });

      vi.advanceTimersByTime(299);
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
      const debouncer = new Debouncer(300);
      const token = createMockToken();

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(100);
      token.cancel();
      const signal = await promise;

      expect(signal).toBeNull();
      debouncer.dispose();
    });

    it('returns null when token is already cancelled', async () => {
      const debouncer = new Debouncer(300);
      const token = createMockToken();
      token.cancel(); // pre-cancel

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(300);
      const signal = await promise;

      // Should be null because token was already cancelled
      expect(signal).toBeNull();
      debouncer.dispose();
    });
  });

  describe('sequential debounce calls', () => {
    it('clears previous timer when called again', async () => {
      const debouncer = new Debouncer(300);
      const token1 = createMockToken();
      const token2 = createMockToken();

      // Start first debounce
      const promise1 = debouncer.debounce(token1 as any);
      vi.advanceTimersByTime(100);

      // Start second debounce — clears first timer
      const promise2 = debouncer.debounce(token2 as any);
      vi.advanceTimersByTime(300);

      const signal2 = await promise2;
      expect(signal2).toBeInstanceOf(AbortSignal);
      expect(signal2!.aborted).toBe(false);

      debouncer.dispose();
    });

    it('aborts previous HTTP request when new debounce starts', async () => {
      const debouncer = new Debouncer(300);
      const token1 = createMockToken();
      const token2 = createMockToken();

      // Complete first debounce to get a signal
      const promise1 = debouncer.debounce(token1 as any);
      vi.advanceTimersByTime(300);
      const signal1 = await promise1;

      // Start second debounce — should abort signal1
      const promise2 = debouncer.debounce(token2 as any);
      vi.advanceTimersByTime(300);
      await promise2;

      expect(signal1!.aborted).toBe(true);

      debouncer.dispose();
    });
  });

  describe('abortCurrent', () => {
    it('aborts the current signal', async () => {
      const debouncer = new Debouncer(300);
      const token = createMockToken();

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(300);
      const signal = await promise;

      expect(signal!.aborted).toBe(false);
      debouncer.abortCurrent();
      expect(signal!.aborted).toBe(true);

      debouncer.dispose();
    });
  });

  describe('setDelay', () => {
    it('changes the debounce delay for subsequent calls', async () => {
      const debouncer = new Debouncer(300);
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
      const debouncer = new Debouncer(300);
      const token = createMockToken();

      const promise = debouncer.debounce(token as any);
      vi.advanceTimersByTime(300);
      const signal = await promise;

      debouncer.dispose();
      expect(signal!.aborted).toBe(true);
    });
  });
});
