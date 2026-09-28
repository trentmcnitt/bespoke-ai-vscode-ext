import { describe, it, expect, vi, afterEach } from 'vitest';
import { linkAbortSignal } from '../../utils/abort';

describe('linkAbortSignal', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts on timeout and reports timedOut', () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const linked = linkAbortSignal(caller.signal, 1000);
    vi.advanceTimersByTime(999);
    expect(linked.signal.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut()).toBe(true);
    // A later cancel does not relabel it.
    caller.abort();
    expect(linked.timedOut()).toBe(true);
    linked.dispose();
  });

  it('aborts when the caller aborts, clears the timer, and is not a timeout', () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const linked = linkAbortSignal(caller.signal, 1000);
    caller.abort();
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(linked.timedOut()).toBe(false);
  });

  it('is aborted at once for an already-aborted caller, with no timer', () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    caller.abort();
    const linked = linkAbortSignal(caller.signal, 1000);
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('works without a caller signal', () => {
    vi.useFakeTimers();
    const linked = linkAbortSignal(undefined, 50);
    vi.advanceTimersByTime(50);
    expect(linked.signal.aborted).toBe(true);
    expect(linked.timedOut()).toBe(true);
  });

  it('dispose clears the timer and the listener on the caller signal', () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, 'removeEventListener');
    const linked = linkAbortSignal(caller.signal, 1000);
    linked.dispose();
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    caller.abort();
    expect(linked.signal.aborted).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(linked.signal.aborted).toBe(false);
  });
});
