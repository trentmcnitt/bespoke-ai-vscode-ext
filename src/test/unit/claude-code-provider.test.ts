import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ClaudeCodeProvider,
  extractCompletion,
  buildFillMessage,
  WARMUP_PREFIX,
  WARMUP_SUFFIX,
} from '../../providers/claude-code';
import {
  makeConfig,
  makeProseContext,
  makeCodeContext,
  makeLogger,
  makeFakeStream,
  consumeIterable,
  FakeStream,
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
