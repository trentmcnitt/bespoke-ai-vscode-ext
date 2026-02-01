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
      tracker.record('anthropic', 'claude-haiku-4-5-20251001');
      tracker.record('anthropic', 'claude-haiku-4-5-20251001');
      expect(tracker.getSnapshot().totalToday).toBe(2);
    });

    it('resets at midnight boundary', () => {
      const tracker = new UsageTracker();

      // Set time to 23:59:00 today
      const beforeMidnight = new Date();
      beforeMidnight.setHours(23, 59, 0, 0);
      vi.setSystemTime(beforeMidnight);

      tracker.record('anthropic', 'claude-haiku-4-5-20251001');
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
        tracker.record('anthropic', 'claude-haiku-4-5-20251001');
      }

      // 10 requests in 5-min window → 2.0/min
      expect(tracker.getSnapshot().ratePerMinute).toBe(2);
    });

    it('old events fall out of rate window', () => {
      const tracker = new UsageTracker(60_000); // 1-minute window
      vi.setSystemTime(new Date('2025-06-15T12:00:00'));

      tracker.record('anthropic', 'claude-haiku-4-5-20251001');
      tracker.record('anthropic', 'claude-haiku-4-5-20251001');
      tracker.record('anthropic', 'claude-haiku-4-5-20251001');

      // 3 requests in 1-min window → 3.0/min
      expect(tracker.getSnapshot().ratePerMinute).toBe(3);

      // Advance 2 minutes — all events outside window
      vi.advanceTimersByTime(2 * 60_000);
      expect(tracker.getSnapshot().ratePerMinute).toBe(0);
    });
  });

  describe('byBackend', () => {
    it('tracks per-backend counts', () => {
      const tracker = new UsageTracker();
      tracker.record('anthropic', 'claude-haiku-4-5-20251001');
      tracker.record('anthropic', 'claude-haiku-4-5-20251001');
      tracker.record('ollama', 'qwen2.5:3b');
      tracker.record('claude-code', 'haiku');
      tracker.record('claude-code', 'haiku');
      tracker.record('claude-code', 'haiku');

      const snap = tracker.getSnapshot();
      expect(snap.byBackend.anthropic).toBe(2);
      expect(snap.byBackend.ollama).toBe(1);
      expect(snap.byBackend['claude-code']).toBe(3);
    });

    it('omits backends with zero requests', () => {
      const tracker = new UsageTracker();
      tracker.record('anthropic', 'claude-haiku-4-5-20251001');

      const snap = tracker.getSnapshot();
      expect(snap.byBackend.anthropic).toBe(1);
      expect(snap.byBackend.ollama).toBeUndefined();
    });
  });

  describe('byModel', () => {
    it('tracks per-model counts', () => {
      const tracker = new UsageTracker();
      tracker.record('anthropic', 'claude-haiku-4-5-20251001');
      tracker.record('anthropic', 'claude-haiku-4-5-20251001');
      tracker.record('anthropic', 'claude-sonnet-4-20250514');
      tracker.record('ollama', 'qwen2.5:3b');

      const snap = tracker.getSnapshot();
      expect(snap.byModel['claude-haiku-4-5-20251001']).toBe(2);
      expect(snap.byModel['claude-sonnet-4-20250514']).toBe(1);
      expect(snap.byModel['qwen2.5:3b']).toBe(1);
    });
  });

  describe('isBurst', () => {
    it('is false below threshold', () => {
      const tracker = new UsageTracker(60_000, 10); // 1-min window, threshold 10
      vi.setSystemTime(new Date('2025-06-15T12:00:00'));

      for (let i = 0; i < 9; i++) {
        tracker.record('anthropic', 'model');
      }
      expect(tracker.getSnapshot().isBurst).toBe(false);
    });

    it('triggers at threshold', () => {
      const tracker = new UsageTracker(60_000, 10); // 1-min window, threshold 10
      vi.setSystemTime(new Date('2025-06-15T12:00:00'));

      for (let i = 0; i < 10; i++) {
        tracker.record('anthropic', 'model');
      }
      expect(tracker.getSnapshot().isBurst).toBe(true);
    });

    it('triggers above threshold', () => {
      const tracker = new UsageTracker(60_000, 10); // 1-min window, threshold 10
      vi.setSystemTime(new Date('2025-06-15T12:00:00'));

      for (let i = 0; i < 15; i++) {
        tracker.record('anthropic', 'model');
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
      // Errors are counted separately — the request itself is tracked via record()
      tracker.recordError();
      tracker.recordError();

      const snap = tracker.getSnapshot();
      expect(snap.errors).toBe(2);
      // Errors don't add to totalToday — that happens via the normal record() path
      expect(snap.totalToday).toBe(0);
    });
  });

  describe('token tracking', () => {
    it('accumulates token counts', () => {
      const tracker = new UsageTracker();
      tracker.recordTokens('claude-haiku-4-5-20251001', 100, 50, 200, 0);
      tracker.recordTokens('claude-haiku-4-5-20251001', 150, 30, 0, 100);

      const snap = tracker.getSnapshot();
      expect(snap.tokens.input).toBe(250);
      expect(snap.tokens.output).toBe(80);
      expect(snap.tokens.cacheRead).toBe(200);
      expect(snap.tokens.cacheWrite).toBe(100);
    });
  });

  describe('cost estimation', () => {
    it('estimates cost for haiku model', () => {
      const tracker = new UsageTracker();
      // 1M input tokens at $0.80/MTok = $0.80
      tracker.recordTokens('claude-haiku-4-5-20251001', 1_000_000, 0, 0, 0);

      const snap = tracker.getSnapshot();
      expect(snap.estimatedCostUsd).toBe(0.8);
    });

    it('estimates cost for output tokens', () => {
      const tracker = new UsageTracker();
      // 1M output tokens at $4.00/MTok = $4.00
      tracker.recordTokens('claude-haiku-4-5-20251001', 0, 1_000_000, 0, 0);

      const snap = tracker.getSnapshot();
      expect(snap.estimatedCostUsd).toBe(4);
    });

    it('estimates cost for cache read tokens', () => {
      const tracker = new UsageTracker();
      // 1M cache read tokens at $0.08/MTok = $0.08
      tracker.recordTokens('claude-haiku-4-5-20251001', 0, 0, 1_000_000, 0);

      const snap = tracker.getSnapshot();
      expect(snap.estimatedCostUsd).toBe(0.08);
    });

    it('uses sonnet pricing for sonnet models', () => {
      const tracker = new UsageTracker();
      // 1M input tokens at $3.00/MTok = $3.00
      tracker.recordTokens('claude-sonnet-4-20250514', 1_000_000, 0, 0, 0);

      const snap = tracker.getSnapshot();
      expect(snap.estimatedCostUsd).toBe(3);
    });

    it('falls back to haiku pricing for unknown models', () => {
      const tracker = new UsageTracker();
      // 1M input tokens at $0.80/MTok (haiku fallback) = $0.80
      tracker.recordTokens('unknown-model', 1_000_000, 0, 0, 0);

      const snap = tracker.getSnapshot();
      expect(snap.estimatedCostUsd).toBe(0.8);
    });

    it('accumulates cost across multiple calls', () => {
      const tracker = new UsageTracker();
      // 100K input at haiku rate: $0.08
      tracker.recordTokens('claude-haiku-4-5-20251001', 100_000, 0, 0, 0);
      // 10K output at haiku rate: $0.04
      tracker.recordTokens('claude-haiku-4-5-20251001', 0, 10_000, 0, 0);

      const snap = tracker.getSnapshot();
      expect(snap.estimatedCostUsd).toBe(0.12);
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
      tracker.record('anthropic', 'claude-haiku-4-5-20251001');
      tracker.record('ollama', 'qwen2.5:3b');
      tracker.recordCacheHit();
      tracker.recordCacheMiss();
      tracker.recordError();
      tracker.recordTokens('claude-haiku-4-5-20251001', 100, 50, 200, 0);
      tracker.reset();

      const snap = tracker.getSnapshot();
      expect(snap.totalToday).toBe(0);
      expect(snap.ratePerMinute).toBe(0);
      expect(snap.byBackend).toEqual({});
      expect(snap.byModel).toEqual({});
      expect(snap.isBurst).toBe(false);
      expect(snap.cacheHits).toBe(0);
      expect(snap.cacheMisses).toBe(0);
      expect(snap.cacheHitRate).toBe(0);
      expect(snap.errors).toBe(0);
      expect(snap.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(snap.estimatedCostUsd).toBe(0);
    });
  });
});
