import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ClaudeCodeProvider, WARMUP_PREFIX, WARMUP_SUFFIX } from '../../providers/claude-code';
import { extractCompletion, buildFillMessage } from '../../providers/prompt-strategy';
import type { UsageLedger } from '../../utils/usage-ledger';
import {
  makeConfig,
  makeProseContext,
  makeCodeContext,
  makeLogger,
  makeFakeStream,
  consumeIterable,
  FakeStream,
  expectIsolatedQueryOptions,
} from '../helpers';

/** Build a realistic warmup response that passes validation. */
function makeWarmupResponse(): string {
  return '<COMPLETION>four</COMPLETION>';
}

// Mock the SDK dynamic import
const mockQueryFn = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (...args: unknown[]) => mockQueryFn(...args),
  };
});

/** Track all active fake streams so afterEach can release them */
const activeFakeStreams: FakeStream[] = [];

/** Create a fake stream with the default warmup response, tracked for cleanup */
function createFakeStream(completionTexts: string | string[], warmupResponse?: string): FakeStream {
  return makeFakeStream(completionTexts, warmupResponse ?? makeWarmupResponse(), activeFakeStreams);
}

describe('ClaudeCodeProvider', () => {
  let activeProvider: ClaudeCodeProvider | null = null;

  beforeEach(() => {
    mockQueryFn.mockReset();
  });

  afterEach(() => {
    activeProvider?.dispose();
    activeProvider = null;
    // Terminate all fake streams to prevent hanging promises
    for (const s of activeFakeStreams) {
      s.terminate();
    }
    activeFakeStreams.length = 0;
  });

  describe('activation', () => {
    it('loads SDK and reports available after activation', async () => {
      const fakeStream0 = createFakeStream('');

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream0);
        return fakeStream0.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      activeProvider = provider;
      await provider.activate('/test/workspace');

      expect(provider.isAvailable()).toBe(true);
    });

    it('reports unavailable before activation', () => {
      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      expect(provider.isAvailable()).toBe(false);
    });

    it('isolates the slot session from the host Claude Code configuration', async () => {
      const fakeStream0 = createFakeStream('');
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream0);
        return fakeStream0.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      activeProvider = provider;
      await provider.activate('/test/workspace');

      expectIsolatedQueryOptions(mockQueryFn.mock.calls[0][0].options);
    });
  });

  describe('getCompletion', () => {
    it('returns null when not activated (queryFn is null)', async () => {
      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });
  });

  describe('dispose', () => {
    it('marks slots as dead', () => {
      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      // Should not throw
      provider.dispose();
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('warmup validation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries once on warmup failure then recovers', async () => {
      const goodWarmup = makeWarmupResponse();
      const proseCtx = makeProseContext();
      const validCompletion = '<COMPLETION> went home.</COMPLETION>';
      const badWarmup = '<COMPLETION>garbage response</COMPLETION>';

      // Attempt 1: slot 0 gets bad warmup → handleWarmupFailure kills all, schedules retry
      // Attempt 2 (retry): slot 0 gets good warmup → pool recovers
      const streams = [
        createFakeStream([validCompletion], badWarmup), // attempt 1 slot 0
        createFakeStream([validCompletion], goodWarmup), // attempt 2 slot 0
      ];

      let callCount = 0;
      const errorLogs: string[] = [];
      const infoLogs: string[] = [];
      const logger = makeLogger();
      logger.error = (msg: string) => {
        errorLogs.push(msg);
      };
      logger.info = (msg: string) => {
        infoLogs.push(msg);
      };

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const stream = streams[callCount];
        callCount++;
        consumeIterable(prompt, stream);
        return stream.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), logger);
      activeProvider = provider;
      await provider.activate('/test/workspace');

      // First attempt failed — error logged, retry scheduled
      expect(errorLogs.some((m) => m.includes('warmup failed on slot'))).toBe(true);
      expect(infoLogs.some((m) => m.includes('retrying'))).toBe(true);

      // Advance timer to trigger the retry setTimeout
      await vi.advanceTimersByTimeAsync(0);

      // After retry, pool should be available
      const result = await provider.getCompletion(proseCtx, new AbortController().signal);
      expect(result).not.toBeNull();
      expect(result).toContain('went home.');
    });

    it('disables pool after two consecutive warmup failures', async () => {
      const badWarmup = '<COMPLETION>garbage response</COMPLETION>';

      // All attempts return bad warmups (1 slot: attempt + retry = 2)
      const streams = [
        createFakeStream([], badWarmup), // attempt 1 slot 0 (fails)
        createFakeStream([], badWarmup), // attempt 2 slot 0 (fails again)
      ];

      let callCount = 0;
      const errorLogs: string[] = [];
      let poolDegraded = false;
      const logger = makeLogger();
      logger.error = (msg: string) => {
        errorLogs.push(msg);
      };

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const stream = streams[callCount];
        callCount++;
        consumeIterable(prompt, stream);
        return stream.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), logger);
      activeProvider = provider;
      provider.onPoolDegraded = () => {
        poolDegraded = true;
      };
      await provider.activate('/test/workspace');

      // Advance timer to trigger the retry
      await vi.advanceTimersByTimeAsync(0);

      // Second failure should have fired the callback
      expect(poolDegraded).toBe(true);
      expect(errorLogs.some((m) => m.includes('autocomplete disabled'))).toBe(true);
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('restart', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('recovers pool after degradation', async () => {
      const badWarmup = '<COMPLETION>garbage response</COMPLETION>';
      const goodWarmup = makeWarmupResponse();
      const proseCtx = makeProseContext();
      const validCompletion = '<COMPLETION> went home.</COMPLETION>';

      // First: warmup fails → pool degrades (1 slot: attempt + retry = 2)
      // Then: restart with good warmup → pool recovers (1 slot)
      const streams = [
        createFakeStream([], badWarmup), // attempt 1 slot 0
        createFakeStream([], badWarmup), // retry slot 0
        createFakeStream([validCompletion], goodWarmup), // restart slot 0
      ];

      let callCount = 0;
      let poolDegraded = false;

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const stream = streams[callCount];
        callCount++;
        consumeIterable(prompt, stream);
        return stream.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      activeProvider = provider;
      provider.onPoolDegraded = () => {
        poolDegraded = true;
      };
      await provider.activate('/test/workspace');

      // Advance to trigger retry
      await vi.advanceTimersByTimeAsync(0);

      // Pool should be degraded
      expect(poolDegraded).toBe(true);
      expect(provider.isAvailable()).toBe(false);

      // Restart should recover
      await provider.restart();

      expect(provider.isAvailable()).toBe(true);
      const result = await provider.getCompletion(proseCtx, new AbortController().signal);
      expect(result).not.toBeNull();
      expect(result).toContain('went home.');
    });
  });

  describe('recycleAll', () => {
    it('reinitializes all slots with fresh sessions', async () => {
      const proseCtx = makeProseContext();
      const completion1 = '<COMPLETION> ran away.</COMPLETION>';
      const completion2 = '<COMPLETION> came back.</COMPLETION>';

      // Initial activation stream (1 slot) + post-recycle stream (1 slot)
      const streams = [
        createFakeStream([completion1]), // init slot 0
        createFakeStream([completion2]), // recycled slot 0
      ];

      let callCount = 0;
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const stream = streams[callCount];
        callCount++;
        consumeIterable(prompt, stream);
        return stream.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      activeProvider = provider;
      await provider.activate('/test/workspace');

      // Get a completion before recycle
      const result1 = await provider.getCompletion(proseCtx, new AbortController().signal);
      expect(result1).toContain('ran away.');

      // Recycle and verify new sessions are used
      await provider.recycleAll();
      expect(provider.isAvailable()).toBe(true);

      const result2 = await provider.getCompletion(proseCtx, new AbortController().signal);
      expect(result2).toContain('came back.');
    });
  });

  describe('stale consumer guard', () => {
    it('stale consumer does not trigger extra recycleSlot after recycleAll', async () => {
      const completion = '<COMPLETION> went home.</COMPLETION>';

      // Initial activation stream (1) + recycleAll stream (1) = 2 total
      const streams = [
        createFakeStream([completion]), // init slot 0
        createFakeStream([completion]), // recycled slot 0
      ];

      let callCount = 0;
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const stream = streams[callCount];
        callCount++;
        consumeIterable(prompt, stream);
        return stream.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      activeProvider = provider;
      await provider.activate('/test/workspace');

      // Activation used 1 stream
      expect(callCount).toBe(1);

      // Recycle — old consumers will finalize asynchronously
      await provider.recycleAll();

      // Allow microtasks to settle (stale consumers' finally blocks run)
      await new Promise((r) => setTimeout(r, 50));

      // Should be exactly 2: 1 activation + 1 recycle. No extra spawns from stale consumers.
      expect(callCount).toBe(2);
    });
  });

  describe('rapid-recycle circuit breaker', () => {
    it('marks slot dead after rapid consecutive recycles', async () => {
      const errorLogs: string[] = [];
      const logger = makeLogger();
      logger.error = (msg: string) => {
        errorLogs.push(msg);
      };

      // Each stream: passes warmup, then immediately ends (done: true after
      // warmup). This triggers consumeStream's finally → recycleSlot, which
      // spawns another initSlot → consumeStream cycle. With Date.now mocked
      // to a constant, all recycles appear instant and the breaker fires.
      let poolDegraded = false;

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const fake = createFakeStream([]);
        // Terminate immediately after warmup — the stream ends, triggering recycleSlot
        consumeIterable(prompt, fake);
        setTimeout(() => fake.terminate(), 0);
        return fake.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), logger, 1);
      activeProvider = provider;
      provider.onPoolDegraded = () => {
        poolDegraded = true;
      };

      // Stub Date.now to a constant so all recycles appear rapid
      vi.spyOn(Date, 'now').mockReturnValue(1000);

      await provider.activate('/test/workspace');

      // Allow the recycle chain to run: recycleSlot → setTimeout(0) → initSlot →
      // warmup → stream ends → recycleSlot → ... Each cycle involves real timeouts
      // and async microtasks. Wait long enough for the chain to hit the limit.
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }

      expect(poolDegraded).toBe(true);
      expect(errorLogs.some((m) => m.includes('circuit breaker'))).toBe(true);

      vi.restoreAllMocks();
    });
  });

  describe('single-waiter queue', () => {
    it('dispose cancels pending waiter', async () => {
      // Waiter cancellation on dispose is tested here.
      // Full concurrent waiter behavior is validated by API integration tests.
      const fakeStream0 = createFakeStream(['result1']);

      let callCount = 0;
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const stream = fakeStream0;
        callCount++;
        consumeIterable(prompt, stream);
        return stream.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      activeProvider = provider;
      await provider.activate('/test/workspace');

      // Make the single slot busy
      const p1 = provider.getCompletion(makeProseContext(), new AbortController().signal);

      // Second request enters waiter path (slot busy)
      const p2 = provider.getCompletion(makeCodeContext(), new AbortController().signal);

      // Dispose cancels the waiter and resolves in-flight deliverResult promises
      provider.dispose();
      activeProvider = null;

      const [result1, result2] = await Promise.all([p1, p2]);
      expect(result1).toBeNull();
      expect(result2).toBeNull();
    });
  });
});

describe('extractCompletion', () => {
  it('extracts content between <COMPLETION> tags', () => {
    expect(extractCompletion('<COMPLETION>hello</COMPLETION>')).toBe('hello');
  });

  it('preserves leading whitespace inside tags', () => {
    expect(extractCompletion('<COMPLETION>\n  return a + b;</COMPLETION>')).toBe(
      '\n  return a + b;',
    );
  });

  it('falls back to raw text when no tags found', () => {
    expect(extractCompletion('just raw text')).toBe('just raw text');
  });

  it('falls back when only opening tag present', () => {
    expect(extractCompletion('<COMPLETION>hello')).toBe('<COMPLETION>hello');
  });

  it('falls back when only closing tag present', () => {
    expect(extractCompletion('hello</COMPLETION>')).toBe('hello</COMPLETION>');
  });

  it('falls back when close appears before open', () => {
    expect(extractCompletion('</COMPLETION>text<COMPLETION>')).toBe(
      '</COMPLETION>text<COMPLETION>',
    );
  });

  it('returns empty string for empty COMPLETION tags', () => {
    expect(extractCompletion('<COMPLETION></COMPLETION>')).toBe('');
  });

  it('ignores text outside COMPLETION tags', () => {
    expect(extractCompletion('thinking... <COMPLETION>result</COMPLETION> done')).toBe('result');
  });
});

describe('buildFillMessage', () => {
  it('builds message with document tags and fill marker', () => {
    const prefix = 'Hello world, this is some text';
    const suffix = ' and more content.';
    const message = buildFillMessage(prefix, suffix, 'markdown');

    expect(message).toContain('<document language="markdown">');
    expect(message).toContain('{{FILL_HERE}}');
    expect(message).toContain('</document>');
    expect(message).toContain('Fill the {{FILL_HERE}} marker.');
  });

  it('includes suffix after fill marker', () => {
    const prefix = 'The quick brown fox jumps over';
    const suffix = ' the lazy dog.';
    const message = buildFillMessage(prefix, suffix);

    expect(message).toContain('{{FILL_HERE}} the lazy dog.');
  });

  it('handles empty suffix', () => {
    const prefix = 'Some text here';
    const message = buildFillMessage(prefix, '');

    expect(message).toContain('{{FILL_HERE}}\n</document>');
  });

  it('handles whitespace-only suffix', () => {
    const prefix = 'Some text here';
    const message = buildFillMessage(prefix, '   ');

    // Whitespace-only suffix is trimmed, so treated as no suffix
    expect(message).toContain('{{FILL_HERE}}\n</document>');
  });

  it('defaults to plaintext language', () => {
    const message = buildFillMessage('hello', '');
    expect(message).toContain('<document language="plaintext">');
  });

  it('uses provided language ID', () => {
    const message = buildFillMessage('hello', '', 'typescript');
    expect(message).toContain('<document language="typescript">');
  });

  it('places prefix before fill marker and suffix after', () => {
    const prefix = 'before cursor';
    const suffix = ' after cursor';
    const message = buildFillMessage(prefix, suffix);

    expect(message).toContain('before cursor{{FILL_HERE}} after cursor');
  });
});

describe('ClaudeCodeProvider — generation detail', () => {
  let provider: ClaudeCodeProvider | null = null;
  afterEach(() => {
    provider?.dispose();
    provider = null;
  });

  /** Scripted SDK stream: assistant + result per turn, with a cumulative total_cost_usd. */
  function scriptedQuery(turns: Array<{ text: string; cumulativeCost?: number; stop?: string }>) {
    mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      async function* gen() {
        const it = prompt[Symbol.asyncIterator]();
        await it.next(); // warmup message
        yield {
          type: 'assistant',
          message: { model: 'claude-sonnet-4-5', stop_reason: 'end_turn' },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: '<COMPLETION>four</COMPLETION>',
          total_cost_usd: 0.01,
          usage: { input_tokens: 2, output_tokens: 3 },
        };
        for (const turn of turns) {
          if ((await it.next()).done) return;
          yield {
            type: 'assistant',
            message: { model: 'claude-sonnet-4-5', stop_reason: turn.stop },
          };
          yield {
            type: 'result',
            subtype: 'success',
            result: turn.text,
            ...(turn.cumulativeCost !== undefined ? { total_cost_usd: turn.cumulativeCost } : {}),
            duration_api_ms: 321,
            usage: {
              input_tokens: 2,
              output_tokens: 5,
              cache_read_input_tokens: 700,
              cache_creation_input_tokens: 30,
            },
          };
        }
        await it.next();
      }
      return gen();
    });
  }

  it('reports per-turn cost (SDK total is cumulative), usage, stop reason, and content', async () => {
    scriptedQuery([
      { text: '<COMPLETION> went home.</COMPLETION>', cumulativeCost: 0.03, stop: 'end_turn' },
      { text: '<COMPLETION> and slept.</COMPLETION>', cumulativeCost: 0.045, stop: 'max_tokens' },
    ]);
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();
    const ctx = makeProseContext({ prefix: 'She', suffix: '' });

    const first = await provider.getCompletionWithDetail(ctx, new AbortController().signal, {
      captureContent: true,
    });
    expect(first.text).toBe(' went home.');
    expect(first.detail).toMatchObject({
      providerName: 'anthropic',
      requestModel: 'sonnet',
      responseModel: 'claude-sonnet-4-5',
      inputTokens: 2,
      outputTokens: 5,
      cacheReadTokens: 700,
      cacheWriteTokens: 30,
      durationApiMs: 321,
      finishReason: 'end_turn',
      content: {
        userMessage: buildFillMessage('She', '', ctx.languageId),
        rawOutput: '<COMPLETION> went home.</COMPLETION>',
        extracted: ' went home.',
      },
    });
    expect(first.detail?.costUsd).toBeCloseTo(0.02, 10);
    expect(first.detail?.waitMs).toBeGreaterThanOrEqual(0);
    expect(first.detail?.content?.systemPrompt).toBeTruthy();

    const second = await provider.getCompletionWithDetail(ctx, new AbortController().signal);
    expect(second.detail?.costUsd).toBeCloseTo(0.015, 10);
    expect(second.detail?.finishReason).toBe('max_tokens');
    expect(second.detail?.content).toBeUndefined();
  });

  it('leaves cost unset when the SDK reports none (never a fabricated 0)', async () => {
    scriptedQuery([{ text: '<COMPLETION> x</COMPLETION>' }]);
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();
    const res = await provider.getCompletionWithDetail(
      makeProseContext({ prefix: 'a' }),
      new AbortController().signal,
    );
    expect(res.detail?.outputTokens).toBe(5);
    expect(res.detail?.costUsd).toBeUndefined();
  });

  it('reports sdk_unavailable before activation', async () => {
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    const res = await provider.getCompletionWithDetail(
      makeProseContext(),
      new AbortController().signal,
    );
    expect(res).toMatchObject({ text: null, detail: { errorType: 'sdk_unavailable' } });
  });
});

describe('ClaudeCodeProvider — per-turn cost and API time in the ledger', () => {
  let provider: ClaudeCodeProvider | null = null;
  afterEach(() => {
    provider?.dispose();
    provider = null;
  });

  type Turn = { text: string; cost?: number; apiMs?: number };

  /**
   * Each query() call is one SDK session. The SDK reports `total_cost_usd` and
   * `duration_api_ms` cumulatively within a session; the first entry is the warmup.
   */
  function scriptSessions(sessions: Turn[][]) {
    let n = 0;
    mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      const turns = sessions[n++] ?? [];
      async function* gen() {
        const it = prompt[Symbol.asyncIterator]();
        for (const turn of turns) {
          if ((await it.next()).done) return;
          yield { type: 'assistant', message: { model: 'claude-sonnet-4-5' } };
          yield {
            type: 'result',
            subtype: 'success',
            result: turn.text,
            duration_ms: 100,
            ...(turn.cost !== undefined ? { total_cost_usd: turn.cost } : {}),
            ...(turn.apiMs !== undefined ? { duration_api_ms: turn.apiMs } : {}),
            session_id: `sess-${n}`,
            usage: { input_tokens: 1, output_tokens: 1 },
          };
        }
        await it.next();
      }
      return gen();
    });
  }

  const warmup = (cost?: number, apiMs?: number): Turn => ({
    text: '<COMPLETION>four</COMPLETION>',
    cost,
    apiMs,
  });

  function makeLedgerSpy() {
    const record = vi.fn();
    return {
      ledger: { record } as unknown as UsageLedger,
      rows: () => record.mock.calls.map((c) => c[0]),
    };
  }

  it('records per-turn deltas (not session totals) for warmup and completion rows, and sums them in pool stats', async () => {
    scriptSessions([
      [
        warmup(0.01, 900),
        { text: '<COMPLETION> a</COMPLETION>', cost: 0.03, apiMs: 3000 },
        { text: '<COMPLETION> b</COMPLETION>', cost: 0.06, apiMs: 5000 },
      ],
    ]);
    const { ledger, rows } = makeLedgerSpy();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    provider.setLedger(ledger);
    await provider.activate();
    const ctx = makeProseContext({ prefix: 'x', suffix: '' });
    await provider.getCompletion(ctx, new AbortController().signal);
    await provider.getCompletion(ctx, new AbortController().signal);

    const byRow = rows()
      .filter((r) => r.source === 'warmup' || r.source === 'completion')
      .map((r) => [r.source, r.costUsd, r.durationApiMs]);
    expect(byRow).toHaveLength(3);
    expect(byRow[0]).toEqual(['warmup', 0.01, 900]);
    expect(byRow[1][0]).toBe('completion');
    expect(byRow[1][1]).toBeCloseTo(0.02, 10);
    expect(byRow[1][2]).toBe(2100);
    expect(byRow[2][1]).toBeCloseTo(0.03, 10);
    expect(byRow[2][2]).toBe(2000);
    // Pool stats count served requests only (warmup excluded): 0.02 + 0.03.
    expect(provider.getStats().totalCostUsd).toBeCloseTo(0.05, 10);
  });

  it('a new session (recycle) starts its deltas from zero again', async () => {
    scriptSessions([
      [warmup(0.01, 900), { text: '<COMPLETION> a</COMPLETION>', cost: 0.06, apiMs: 5000 }],
      // New session after recycle: its totals restart below the old session's.
      [warmup(0.004, 400), { text: '<COMPLETION> b</COMPLETION>', cost: 0.024, apiMs: 1400 }],
    ]);
    const { ledger, rows } = makeLedgerSpy();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    provider.setLedger(ledger);
    await provider.activate();
    const ctx = makeProseContext({ prefix: 'x', suffix: '' });
    await provider.getCompletion(ctx, new AbortController().signal);
    await provider.recycleAll();
    await provider.getCompletion(ctx, new AbortController().signal);

    const r = rows()
      .filter((row) => row.source === 'warmup' || row.source === 'completion')
      .map((row) => [row.source, row.costUsd, row.durationApiMs]);
    expect(r).toHaveLength(4);
    expect(r[2]).toEqual(['warmup', 0.004, 400]);
    // Exact values: a missed reset would give max(0, 0.004 - 0.06) = 0, not 0.004.
    expect(r[3][0]).toBe('completion');
    expect(r[3][1]).toBeCloseTo(0.02, 10);
    expect(r[3][2]).toBe(1000);
    expect(provider.getStats().totalCostUsd).toBeCloseTo(0.07, 10);
  });

  it('without an SDK-reported cost or API time, rows carry 0 cost and no per-turn trace cost', async () => {
    scriptSessions([[warmup(), { text: '<COMPLETION> a</COMPLETION>' }]]);
    const { ledger, rows } = makeLedgerSpy();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    provider.setLedger(ledger);
    await provider.activate();
    const res = await provider.getCompletionWithDetail(
      makeProseContext({ prefix: 'x' }),
      new AbortController().signal,
    );
    const completion = rows().find((row) => row.source === 'completion');
    expect(completion?.costUsd).toBe(0);
    expect(completion?.durationApiMs).toBe(0);
    expect(res.detail?.costUsd).toBeUndefined();
  });
});

describe('ClaudeCodeProvider — why a request got no result', () => {
  let provider: ClaudeCodeProvider | null = null;
  afterEach(() => {
    provider?.dispose();
    provider = null;
  });

  /**
   * SDK mock whose completion results are released by the test. Each spawned session
   * answers warmup with `ctl.warmup`, then waits for `ctl.respond()` / `ctl.fail()` /
   * `ctl.end()` for every message pushed to it. A null `ctl.warmup` makes the session
   * end before answering warmup (the CLI exiting cleanly without output).
   */
  function controlledQuery() {
    const END = {};
    const ctl = {
      warmup: '<COMPLETION>four</COMPLETION>' as string | object[] | null,
      spawns: 0,
      pending: null as null | { resolve: (m: object) => void; reject: (e: Error) => void },
      respond(message: object) {
        const p = ctl.pending;
        ctl.pending = null;
        p?.resolve(message);
      },
      fail(err: Error) {
        const p = ctl.pending;
        ctl.pending = null;
        p?.reject(err);
      },
      /** Wakes a session idle between requests, so end() works there too. */
      idle: null as null | (() => void),
      /** End the session's stream cleanly (no result, no error), as a CLI exiting would. */
      end() {
        if (ctl.pending) ctl.respond(END);
        else {
          const wake = ctl.idle;
          ctl.idle = null;
          wake?.();
        }
      },
    };
    mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
      ctl.spawns++;
      const warmup = ctl.warmup;
      async function* gen() {
        const it = prompt[Symbol.asyncIterator]();
        await it.next(); // warmup message
        if (warmup === null) return;
        if (Array.isArray(warmup)) yield* warmup;
        else yield { type: 'result', subtype: 'success', result: warmup };
        for (;;) {
          const next = await Promise.race([
            it.next(),
            new Promise<typeof END>((r) => (ctl.idle = () => r(END))),
          ]);
          if (next === END || (next as IteratorResult<unknown>).done) return;
          const message = await new Promise<object>((resolve, reject) => {
            ctl.pending = { resolve, reject };
          });
          if (message === END) return;
          // An array is several stream messages for one request (e.g. assistant + result).
          if (Array.isArray(message)) yield* message;
          else yield message;
        }
      }
      return gen();
    });
    return ctl;
  }

  /** Resolve with `promise`, or 'still waiting' if it has not settled within `ms`. */
  function within<T>(promise: Promise<T>, ms = 200): Promise<T | 'still waiting'> {
    return Promise.race([
      promise,
      new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), ms)),
    ]);
  }

  const signal = () => new AbortController().signal;
  const settle = () => new Promise((r) => setTimeout(r, 10));

  it('a request superseded by a newer one is aborted, with no error type', async () => {
    const ctl = controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const holding = provider.getCompletionWithDetail(makeProseContext(), signal());
    const superseded = provider.getCompletionWithDetail(makeProseContext(), signal());
    const latest = provider.getCompletionWithDetail(makeProseContext(), signal());

    const s = await superseded;
    expect(s.text).toBeNull();
    expect(s.detail?.aborted).toBe(true);
    expect(s.detail?.errorType).toBeUndefined();

    await settle();
    ctl.respond({ type: 'result', subtype: 'success', result: '<COMPLETION> one</COMPLETION>' });
    expect((await holding).text).toBe(' one');
    await settle();
    ctl.respond({ type: 'result', subtype: 'success', result: '<COMPLETION> two</COMPLETION>' });
    expect((await latest).text).toBe(' two');
  });

  it('a pool recycle ends both the holding and the waiting request as pool_recycled', async () => {
    controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const holding = provider.getCompletionWithDetail(makeProseContext(), signal());
    const waiting = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    await provider.recycleAll();

    for (const res of [await holding, await waiting]) {
      expect(res.text).toBeNull();
      expect(res.detail?.errorType).toBe('pool_recycled');
      expect(res.detail?.aborted).toBeUndefined();
    }
    expect(provider.isAvailable()).toBe(true);
  });

  it('a warmup failure ends the waiting request as pool_warmup_failed; once degraded, slot_unavailable', async () => {
    const ctl = controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    ctl.warmup = '<COMPLETION>garbage</COMPLETION>';
    const recycling = provider.recycleAll();
    // The slot is re-initializing, so this request waits for it.
    const waiting = provider.getCompletionWithDetail(makeProseContext(), signal());
    const res = await waiting;
    expect(res.text).toBeNull();
    expect(res.detail?.errorType).toBe('pool_warmup_failed');
    await recycling;

    // The retry fails too, and the pool gives up.
    for (let i = 0; i < 10 && provider.isAvailable(); i++) await settle();
    expect(provider.isAvailable()).toBe(false);
    const after = await provider.getCompletionWithDetail(makeProseContext(), signal());
    expect(after.detail?.errorType).toBe('slot_unavailable');
  });

  it('a stream error while the request holds the slot is slot_stream_error, not empty', async () => {
    const ctl = controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const holding = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    ctl.fail(new Error('subprocess exited'));
    const res = await holding;
    expect(res.text).toBeNull();
    expect(res.detail?.errorType).toBe('slot_stream_error');
  });

  it('a session that ends cleanly while the request holds the slot is slot_stream_ended, not a hang', async () => {
    const ctl = controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const holding = provider.getCompletionWithDetail(makeProseContext(), signal());
    const waiting = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    ctl.end();

    // Before the fix recycleSlot() dropped the result callback: this never settled.
    const res = await within(holding);
    expect(res).not.toBe('still waiting');
    if (res === 'still waiting') return;
    expect(res.text).toBeNull();
    expect(res.detail?.errorType).toBe('slot_stream_ended');
    expect(res.detail?.aborted).toBeUndefined();

    // The slot respawns and serves the request parked behind the lost one.
    await settle();
    expect(ctl.spawns).toBe(2);
    ctl.respond({ type: 'result', subtype: 'success', result: '<COMPLETION> next</COMPLETION>' });
    const next = await within(waiting);
    expect(next).not.toBe('still waiting');
    if (next === 'still waiting') return;
    expect(next.text).toBe(' next');
  });

  it('an idle session ending after an answer does not leak a stale failure into the next request', async () => {
    const ctl = controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const first = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    ctl.respond({ type: 'result', subtype: 'success', result: '<COMPLETION> one</COMPLETION>' });
    expect((await first).text).toBe(' one');

    // The CLI exits while idle: the reused slot's result promise is settled and the
    // slot respawns; the next request goes to the fresh session.
    await settle();
    ctl.end();
    await settle();
    expect(ctl.spawns).toBe(2);
    const second = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    ctl.respond({ type: 'result', subtype: 'success', result: '<COMPLETION> two</COMPLETION>' });
    const res = await within(second);
    expect(res).not.toBe('still waiting');
    if (res === 'still waiting') return;
    expect(res.text).toBe(' two');
    expect(res.detail?.errorType).toBeUndefined();
  });

  it('a session that ends before answering warmup fails warmup at once, not after the 30 s timeout', async () => {
    const ctl = controlledQuery();
    ctl.warmup = null;
    const degraded: string[] = [];
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    provider.onPoolDegraded = (reason) => degraded.push(reason);

    // Before the fix activate() waited out WARMUP_TIMEOUT_MS while the recycle
    // respawned the slot behind its back.
    expect(await within(provider.activate())).not.toBe('still waiting');
    for (let i = 0; i < 20 && degraded.length === 0; i++) await settle();

    // The warmup-failure path: one retry, then degraded. Not a respawn loop.
    expect(degraded).toEqual(['warmup failed after retry']);
    expect(ctl.spawns).toBe(2);
    expect(provider.isAvailable()).toBe(false);
  });

  it('a non-success CLI result is an error with the subtype, not empty', async () => {
    const ctl = controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const holding = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    ctl.respond({ type: 'result', subtype: 'error_during_execution' });
    const res = await holding;
    expect(res.text).toBeNull();
    expect(res.detail?.errorType).toBe('cli_error_during_execution');
  });

  // Claude Code answers some requests itself instead of calling the model — e.g. when
  // the subscription hits its usage limit it returns "You've hit your session limit ·
  // resets 6:50pm". That arrives as an assistant message with model "<synthetic>" and a
  // success result carrying the notice. It must never become ghost text.
  it('a Claude Code notice (synthetic reply) is an error, never ghost text', async () => {
    const ctl = controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const notice = "You've hit your session limit · resets 6:50pm (America/Chicago)";
    const holding = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    ctl.respond([
      {
        type: 'assistant',
        message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [] },
      },
      { type: 'result', subtype: 'success', result: notice, total_cost_usd: 0 },
    ]);
    const res = await holding;
    expect(res.text).toBeNull();
    expect(res.detail?.errorType).toBe('cli_usage_limit');
  });

  it('a usage-limit notice at warmup pauses the pool with the notice, without retrying', async () => {
    const ctl = controlledQuery();
    const notice = "You've hit your session limit · resets 6:50pm (America/Chicago)";
    ctl.warmup = [
      {
        type: 'assistant',
        message: { model: '<synthetic>', stop_reason: 'stop_sequence', content: [] },
      },
      { type: 'result', subtype: 'success', result: notice },
    ];
    const degraded: string[] = [];
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    provider.onPoolDegraded = (reason) => degraded.push(reason);

    await within(provider.activate());
    for (let i = 0; i < 20 && degraded.length === 0; i++) await settle();

    expect(degraded).toEqual([`usage limit reached: ${notice}`]);
    expect(ctl.spawns).toBe(1); // no retry — it can't succeed until the limit resets
    expect(provider.isAvailable()).toBe(false);
  });

  it('a result flagged is_error is an error even with text', async () => {
    const ctl = controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const holding = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    ctl.respond({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 500' });
    const res = await holding;
    expect(res.text).toBeNull();
    expect(res.detail?.errorType).toBe('cli_notice');
  });

  it('a normal model reply is unaffected by the notice check', async () => {
    const ctl = controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const holding = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    ctl.respond([
      {
        type: 'assistant',
        message: { model: 'claude-sonnet-5', stop_reason: 'end_turn', content: [] },
      },
      { type: 'result', subtype: 'success', result: '<COMPLETION> the limit is fine</COMPLETION>' },
    ]);
    const res = await holding;
    expect(res.text).toBe(' the limit is fine');
    expect(res.detail?.errorType).toBeUndefined();
  });

  it('a success result with no text is still empty (the model answered)', async () => {
    const ctl = controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const holding = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    ctl.respond({ type: 'result', subtype: 'success', result: '' });
    const res = await holding;
    expect(res.text).toBeNull();
    expect(res.detail?.errorType).toBeUndefined();
    expect(res.detail?.aborted).toBeUndefined();
  });

  it('dispose (shutdown) ends holding and waiting requests as aborted', async () => {
    controlledQuery();
    provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await provider.activate();

    const holding = provider.getCompletionWithDetail(makeProseContext(), signal());
    const waiting = provider.getCompletionWithDetail(makeProseContext(), signal());
    await settle();
    provider.dispose();
    provider = null;

    for (const res of [await holding, await waiting]) {
      expect(res.text).toBeNull();
      expect(res.detail?.aborted).toBe(true);
      expect(res.detail?.errorType).toBeUndefined();
    }
  });

  describe('when the rapid-recycle circuit breaker kills every slot', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    /**
     * Activate, park a request behind a busy slot, then crash the slot's session
     * as the fifth rapid recycle, which trips the breaker (RAPID_RECYCLE_LIMIT = 5).
     * The first four are set directly: driving them through real crashes needs a
     * request in flight for each, which adds nothing to what is tested here.
     */
    async function tripBreaker(ctl: ReturnType<typeof controlledQuery>) {
      const p = new ClaudeCodeProvider(makeConfig(), makeLogger());
      provider = p;
      const degraded: string[] = [];
      p.onPoolDegraded = (reason) => degraded.push(reason);
      await p.activate();

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const holding = p.getCompletionWithDetail(makeProseContext(), signal());
      const waiting = p.getCompletionWithDetail(makeProseContext(), signal());
      await settle();
      const slot = (
        p as unknown as { slots: { rapidRecycleCount: number; lastRecycleTime: number }[] }
      ).slots[0];
      slot.rapidRecycleCount = 4;
      slot.lastRecycleTime = now;
      ctl.fail(new Error('subprocess exited'));
      return { p, holding, waiting, degraded };
    }

    it('reports unavailable and fails the parked request at once with pool_circuit_open', async () => {
      const ctl = controlledQuery();
      const { p, holding, waiting, degraded } = await tripBreaker(ctl);

      expect((await holding).detail?.errorType).toBe('slot_stream_error');
      // Before the fix the parked request was never woken: nothing frees a dead slot.
      const res = await Promise.race([
        waiting,
        new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), 200)),
      ]);
      expect(res).not.toBe('still waiting');
      if (res === 'still waiting') return;
      expect(res.text).toBeNull();
      expect(res.detail?.errorType).toBe('pool_circuit_open');
      expect(res.detail?.aborted).toBeUndefined();

      expect(degraded).toEqual(['circuit breaker: all slots dead after rapid recycles']);
      expect(p.isAvailable()).toBe(false);
      expect(p.getStats().available).toBe(false);
    });

    it('a session ending cleanly as the fifth rapid recycle ends the held request as slot_stream_ended', async () => {
      const ctl = controlledQuery();
      const p = new ClaudeCodeProvider(makeConfig(), makeLogger());
      provider = p;
      await p.activate();

      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const holding = p.getCompletionWithDetail(makeProseContext(), signal());
      await settle();
      const slot = (
        p as unknown as { slots: { rapidRecycleCount: number; lastRecycleTime: number }[] }
      ).slots[0];
      slot.rapidRecycleCount = 4;
      slot.lastRecycleTime = now;
      ctl.end();

      // The breaker branch of recycleSlot() dropped the callback too.
      const res = await within(holding);
      expect(res).not.toBe('still waiting');
      if (res === 'still waiting') return;
      expect(res.detail?.errorType).toBe('slot_stream_ended');
      expect(p.isAvailable()).toBe(false);
    });

    it('a request arriving while open resolves immediately instead of waiting', async () => {
      const ctl = controlledQuery();
      const { p, waiting } = await tripBreaker(ctl);
      await waiting;

      const res = await p.getCompletionWithDetail(makeProseContext(), signal());
      expect(res.text).toBeNull();
      expect(res.detail?.errorType).toBe('pool_circuit_open');
      expect((p as unknown as { pendingWaiter: unknown }).pendingWaiter).toBeNull();
    });

    it('restart (Restart Pools) closes the breaker and the pool serves again', async () => {
      const ctl = controlledQuery();
      const { p, waiting } = await tripBreaker(ctl);
      await waiting;
      vi.restoreAllMocks();

      await p.restart();
      expect(p.isAvailable()).toBe(true);
      const next = p.getCompletionWithDetail(makeProseContext(), signal());
      await settle();
      ctl.respond({ type: 'result', subtype: 'success', result: '<COMPLETION> back</COMPLETION>' });
      expect((await next).text).toBe(' back');
    });

    it('recycleAll (a model or custom-instructions change) also closes it', async () => {
      const ctl = controlledQuery();
      const { p, waiting } = await tripBreaker(ctl);
      await waiting;
      vi.restoreAllMocks();

      await p.recycleAll();
      expect(p.isAvailable()).toBe(true);
    });
  });

  it('a request after dispose is aborted, not sdk_unavailable', async () => {
    controlledQuery();
    const disposed = new ClaudeCodeProvider(makeConfig(), makeLogger());
    await disposed.activate();
    disposed.dispose();

    const res = await disposed.getCompletionWithDetail(makeProseContext(), signal());
    expect(res.text).toBeNull();
    expect(res.detail?.aborted).toBe(true);
    expect(res.detail?.errorType).toBeUndefined();
  });
});
