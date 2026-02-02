import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UsageTracker } from '../../utils/usage-tracker';

describe('UsageTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('record and totalToday', () => {
    it('increments count on record', () => {
      const tracker = new UsageTracker();
      tracker.record('haiku');
      tracker.record('haiku');
      expect(tracker.getSnapshot().totalToday).toBe(2);
    });

    it('resets at midnight boundary', () => {
      const tracker = new UsageTracker();

      // Set time to 23:59:00 today
      const beforeMidnight = new Date();
      beforeMidnight.setHours(23, 59, 0, 0);
      vi.setSystemTime(beforeMidnight);

      tracker.record('haiku');
      expect(tracker.getSnapshot().totalToday).toBe(1);

      // Advance past midnight
      vi.setSystemTime(new Date(beforeMidnight.getTime() + 2 * 60 * 1000));
      expect(tracker.getSnapshot().totalToday).toBe(0);
    });
  });

  describe('ratePerMinute', () => {
    it('computes rate over window', () => {
      // 5-minute window (default)
      const tracker = new UsageTracker();
      vi.setSystemTime(new Date('2025-06-15T12:00:00'));

      // Record 10 requests
      for (let i = 0; i < 10; i++) {
        tracker.record('haiku');
      }

      // 10 requests in 5-min window → 2.0/min
      expect(tracker.getSnapshot().ratePerMinute).toBe(2);
    });

    it('old events fall out of rate window', () => {
      const tracker = new UsageTracker(60_000); // 1-minute window
      vi.setSystemTime(new Date('2025-06-15T12:00:00'));

      tracker.record('haiku');
      tracker.record('haiku');
      tracker.record('haiku');

      // 3 requests in 1-min window → 3.0/min
      expect(tracker.getSnapshot().ratePerMinute).toBe(3);

      // Advance 2 minutes — all events outside window
      vi.advanceTimersByTime(2 * 60_000);
      expect(tracker.getSnapshot().ratePerMinute).toBe(0);
    });
  });

  describe('byModel', () => {
    it('tracks per-model counts', () => {
      const tracker = new UsageTracker();
      tracker.record('haiku');
      tracker.record('haiku');
      tracker.record('sonnet');
      tracker.record('opus');

      const snap = tracker.getSnapshot();
      expect(snap.byModel['haiku']).toBe(2);
      expect(snap.byModel['sonnet']).toBe(1);
      expect(snap.byModel['opus']).toBe(1);
    });
  });

  describe('isBurst', () => {
    it('is false below threshold', () => {
      const tracker = new UsageTracker(60_000, 10); // 1-min window, threshold 10
      vi.setSystemTime(new Date('2025-06-15T12:00:00'));

      for (let i = 0; i < 9; i++) {
        tracker.record('haiku');
      }
      expect(tracker.getSnapshot().isBurst).toBe(false);
    });

    it('triggers at threshold', () => {
      const tracker = new UsageTracker(60_000, 10); // 1-min window, threshold 10
      vi.setSystemTime(new Date('2025-06-15T12:00:00'));

      for (let i = 0; i < 10; i++) {
        tracker.record('haiku');
      }
      expect(tracker.getSnapshot().isBurst).toBe(true);
    });

    it('triggers above threshold', () => {
      const tracker = new UsageTracker(60_000, 10); // 1-min window, threshold 10
      vi.setSystemTime(new Date('2025-06-15T12:00:00'));

      for (let i = 0; i < 15; i++) {
        tracker.record('haiku');
      }
      expect(tracker.getSnapshot().isBurst).toBe(true);
    });
  });

  describe('cache tracking', () => {
    it('records cache hits and misses', () => {
      const tracker = new UsageTracker();
      tracker.recordCacheHit();
      tracker.recordCacheHit();
      tracker.recordCacheMiss();

      const snap = tracker.getSnapshot();
      expect(snap.cacheHits).toBe(2);
      expect(snap.cacheMisses).toBe(1);
    });

    it('computes cache hit rate', () => {
      const tracker = new UsageTracker();
      tracker.recordCacheHit();
      tracker.recordCacheHit();
      tracker.recordCacheMiss();
      tracker.recordCacheMiss();

      expect(tracker.getSnapshot().cacheHitRate).toBe(50);
    });

    it('returns 0 hit rate when no lookups', () => {
      const tracker = new UsageTracker();
      expect(tracker.getSnapshot().cacheHitRate).toBe(0);
    });
  });

  describe('error tracking', () => {
    it('records error count without double-counting requests', () => {
      const tracker = new UsageTracker();
      tracker.recordError();
      tracker.recordError();

      const snap = tracker.getSnapshot();
      expect(snap.errors).toBe(2);
      expect(snap.totalToday).toBe(0);
    });
  });

  describe('character tracking', () => {
    it('accumulates input and output characters', () => {
      const tracker = new UsageTracker();
      tracker.record('haiku', 500, 50);
      tracker.record('haiku', 1000, 100);

      const snap = tracker.getSnapshot();
      expect(snap.totalInputChars).toBe(1500);
      expect(snap.totalOutputChars).toBe(150);
    });

    it('handles record without character counts', () => {
      const tracker = new UsageTracker();
      tracker.record('haiku');

      const snap = tracker.getSnapshot();
      expect(snap.totalInputChars).toBe(0);
      expect(snap.totalOutputChars).toBe(0);
      expect(snap.totalToday).toBe(1);
    });
  });

  describe('sessionStartTime', () => {
    it('records construction time', () => {
      vi.setSystemTime(new Date('2025-06-15T12:00:00'));
      const tracker = new UsageTracker();
      expect(tracker.getSnapshot().sessionStartTime).toBe(
        new Date('2025-06-15T12:00:00').getTime(),
      );
    });
  });

  describe('reset', () => {
    it('clears everything', () => {
      const tracker = new UsageTracker();
      tracker.record('haiku', 500, 50);
      tracker.record('sonnet', 1000, 100);
      tracker.recordCacheHit();
      tracker.recordCacheMiss();
      tracker.recordError();
      tracker.reset();

      const snap = tracker.getSnapshot();
      expect(snap.totalToday).toBe(0);
      expect(snap.ratePerMinute).toBe(0);
      expect(snap.byModel).toEqual({});
      expect(snap.isBurst).toBe(false);
      expect(snap.cacheHits).toBe(0);
      expect(snap.cacheMisses).toBe(0);
      expect(snap.cacheHitRate).toBe(0);
      expect(snap.errors).toBe(0);
      expect(snap.totalInputChars).toBe(0);
      expect(snap.totalOutputChars).toBe(0);
    });
  });
});
