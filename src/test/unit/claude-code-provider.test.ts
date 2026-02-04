import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ClaudeCodeProvider,
  extractOutput,
  extractCompletionStart,
  stripCompletionStart,
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
  const { completionStart } = buildFillMessage(WARMUP_PREFIX, WARMUP_SUFFIX);
  return `<output>${completionStart}four</output>`;
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
      const { completionStart: proseCS } = buildFillMessage(proseCtx.prefix, proseCtx.suffix);
      const validCompletion = `<output>${proseCS} went home.</output>`;
      const badWarmup = '<output>garbage response</output>';

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
      const badWarmup = '<output>garbage response</output>';

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
      const badWarmup = '<output>garbage response</output>';
      const goodWarmup = makeWarmupResponse();
      const proseCtx = makeProseContext();
      const { completionStart: proseCS } = buildFillMessage(proseCtx.prefix, proseCtx.suffix);
      const validCompletion = `<output>${proseCS} went home.</output>`;

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
      const { completionStart: proseCS } = buildFillMessage(proseCtx.prefix, proseCtx.suffix);
      const completion1 = `<output>${proseCS} ran away.</output>`;
      const completion2 = `<output>${proseCS} came back.</output>`;

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
      const proseCtx = makeProseContext();
      const { completionStart: proseCS } = buildFillMessage(proseCtx.prefix, proseCtx.suffix);
      const completion = `<output>${proseCS} went home.</output>`;

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

describe('extractOutput', () => {
  it('extracts content between <output> tags', () => {
    expect(extractOutput('<output>hello</output>')).toBe('hello');
  });

  it('preserves leading whitespace inside tags', () => {
    expect(extractOutput('<output>\n  return a + b;</output>')).toBe('\n  return a + b;');
  });

  it('falls back to raw text when no tags found', () => {
    expect(extractOutput('just raw text')).toBe('just raw text');
  });

  it('falls back when only opening tag present', () => {
    expect(extractOutput('<output>hello')).toBe('<output>hello');
  });

  it('falls back when only closing tag present', () => {
    expect(extractOutput('hello</output>')).toBe('hello</output>');
  });

  it('falls back when close appears before open', () => {
    expect(extractOutput('</output>text<output>')).toBe('</output>text<output>');
  });

  it('returns empty string for empty output tags', () => {
    expect(extractOutput('<output></output>')).toBe('');
  });

  it('ignores text outside output tags', () => {
    expect(extractOutput('thinking... <output>result</output> done')).toBe('result');
  });
});

describe('extractCompletionStart', () => {
  it('extracts last N characters from long prefix', () => {
    const prefix = 'The quick brown fox jumps over the lazy dog.';
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    // COMPLETION_START_LENGTH is 10, forward search snaps to word boundary
    // Leading whitespace is trimmed from completionStart and moved to truncatedPrefix
    expect(completionStart).toBe('lazy dog.');
    expect(truncatedPrefix).toBe('The quick brown fox jumps over the ');
    expect(truncatedPrefix + completionStart).toBe(prefix);
  });

  it('uses entire prefix when shorter than threshold', () => {
    const prefix = 'Short text';
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    expect(completionStart).toBe('Short text');
    expect(truncatedPrefix).toBe('');
  });

  it('handles empty prefix', () => {
    const { truncatedPrefix, completionStart } = extractCompletionStart('');
    expect(completionStart).toBe('');
    expect(truncatedPrefix).toBe('');
  });

  it('handles prefix exactly at threshold length', () => {
    const prefix = 'a'.repeat(10);
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    expect(completionStart).toBe(prefix);
    expect(truncatedPrefix).toBe('');
  });

  it('preserves partial words in completion start', () => {
    const prefix = 'Hello world, this is a partial wo';
    const { completionStart } = extractCompletionStart(prefix);
    // Should include the partial word "wo"
    expect(completionStart).toContain('wo');
  });

  it('splits at word boundary to avoid cutting mid-word', () => {
    const prefix = 'They seem so complex and wasteful (noise, h';
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    // Forward search finds the space after "wasteful"
    // Leading whitespace is trimmed from completionStart and moved to truncatedPrefix
    expect(truncatedPrefix).toBe('They seem so complex and wasteful ');
    expect(completionStart).toBe('(noise, h');
    expect(truncatedPrefix + completionStart).toBe(prefix);
  });

  it('splits at paragraph boundary when newlines are nearby', () => {
    const prefix = "They power so much of our world.\n\nI've heard that ele";
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    // Leading whitespace is trimmed from completionStart and moved to truncatedPrefix
    expect(truncatedPrefix).toBe("They power so much of our world.\n\nI've heard ");
    expect(completionStart).toBe('that ele');
    expect(truncatedPrefix + completionStart).toBe(prefix);
  });

  it('falls back to fixed cut when no word boundary found', () => {
    // A prefix with no spaces in the search range
    const prefix = 'x'.repeat(60);
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    // No spaces to snap to, so falls back to the ideal cut point
    expect(completionStart.length).toBe(10);
    expect(truncatedPrefix + completionStart).toBe(prefix);
  });

  it('maximizes context in current_text for medium-length prefixes', () => {
    // Simulates the real failure: model ignores completion_start when current_text is too short
    const prefix = 'I was thinking about choosing colleges for my kids';
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    // Most of the prefix should be in truncatedPrefix (= visible in current_text)
    // Leading whitespace is trimmed from completionStart and moved to truncatedPrefix
    expect(truncatedPrefix).toBe('I was thinking about choosing colleges for ');
    expect(completionStart).toBe('my kids');
    expect(truncatedPrefix + completionStart).toBe(prefix);
  });

  it('trims leading newlines from completionStart for partial tokens', () => {
    // The partial-date case: prefix ends with "\n\n0" where "0" is a partial date
    // Use a longer prefix so the cut happens near the end
    const prefix = '#journal\n\n#### Notes about anything\n\n0';
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    // The cut happens at a word boundary, then leading whitespace is trimmed
    // "\n\n0" after the cut becomes "0" with "\n\n" moved to truncatedPrefix
    expect(truncatedPrefix).toBe('#journal\n\n#### Notes about anything\n\n');
    expect(completionStart).toBe('0');
    expect(truncatedPrefix + completionStart).toBe(prefix);
  });

  it('handles pure whitespace prefix gracefully', () => {
    const prefix = '\n\n\n';
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    // All whitespace moves to truncatedPrefix, completionStart is empty
    expect(truncatedPrefix).toBe('\n\n\n');
    expect(completionStart).toBe('');
    expect(truncatedPrefix + completionStart).toBe(prefix);
  });

  it('preserves indentation spaces after trimming newlines', () => {
    // Code indentation case: newline + spaces + partial token
    const prefix = 'def foo():\n    return';
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    // Newline and spaces move to truncatedPrefix
    expect(truncatedPrefix).toBe('def foo():\n    ');
    expect(completionStart).toBe('return');
    expect(truncatedPrefix + completionStart).toBe(prefix);
  });
});

describe('stripCompletionStart', () => {
  it('strips matching completion start from output', () => {
    const output = 'The quick brown fox';
    const completionStart = 'The quick ';
    expect(stripCompletionStart(output, completionStart)).toBe('brown fox');
  });

  it('returns full output when completion start is empty', () => {
    expect(stripCompletionStart('hello world', '')).toBe('hello world');
  });

  it('returns null when output does not start with completion start', () => {
    const output = 'Different text';
    const completionStart = 'The quick';
    expect(stripCompletionStart(output, completionStart)).toBeNull();
  });

  it('handles exact match (output equals completion start)', () => {
    const text = 'exact match';
    expect(stripCompletionStart(text, text)).toBe('');
  });

  it('preserves whitespace correctly', () => {
    const output = '  indented text continues';
    const completionStart = '  indented ';
    expect(stripCompletionStart(output, completionStart)).toBe('text continues');
  });

  it('handles newlines in completion start', () => {
    const output = 'line1\nline2 continues';
    const completionStart = 'line1\nline2 ';
    expect(stripCompletionStart(output, completionStart)).toBe('continues');
  });

  it('handles whitespace-only completion start', () => {
    const output = '\n\nSome content here';
    const completionStart = '\n\n';
    expect(stripCompletionStart(output, completionStart)).toBe('Some content here');
  });

  describe('lenient whitespace matching', () => {
    it('matches when newline vs space differs', () => {
      // Model uses \n where completion_start has space
      const output = ' *\n * content';
      const completionStart = ' * * ';
      expect(stripCompletionStart(output, completionStart)).toBe('content');
    });

    it('matches when whitespace run lengths differ', () => {
      // Model uses single space where completion_start has double space
      const output = 'a b content';
      const completionStart = 'a  b ';
      expect(stripCompletionStart(output, completionStart)).toBe('content');
    });

    it('fails when non-whitespace character counts differ', () => {
      // JSDoc case: completionStart has 3 asterisks, output only has 2
      const output = ' * \n * useTimezone()';
      const completionStart = ' *\n * \n * ';
      // Non-whitespace: * * * vs * *
      // These don't match — model dropped one of the asterisks
      expect(stripCompletionStart(output, completionStart)).toBeNull();
    });

    it('matches when completion_start has trailing whitespace output lacks', () => {
      const output = ' * content';
      const completionStart = ' * ';
      expect(stripCompletionStart(output, completionStart)).toBe('content');
    });

    it('fails when non-whitespace chars differ', () => {
      const output = 'abc content';
      const completionStart = 'abd ';
      expect(stripCompletionStart(output, completionStart)).toBeNull();
    });

    it('fails when non-whitespace chars missing', () => {
      const output = 'ab content';
      const completionStart = 'abc ';
      expect(stripCompletionStart(output, completionStart)).toBeNull();
    });

    it('requires whitespace to be present in both, not dropped entirely', () => {
      // completion_start has " a b", output has "ab" — whitespace dropped
      const output = 'ab content';
      const completionStart = ' a b ';
      expect(stripCompletionStart(output, completionStart)).toBeNull();
    });

    it('handles mixed whitespace (space, tab, newline)', () => {
      const output = 'a\tb\nc content';
      const completionStart = 'a b c ';
      expect(stripCompletionStart(output, completionStart)).toBe('content');
    });

    it('handles completion_start that is all whitespace with different lengths', () => {
      const output = '\n\nSome content';
      const completionStart = '\n\n\n';
      expect(stripCompletionStart(output, completionStart)).toBe('Some content');
    });

    it('prefers strict match when both would work', () => {
      // Strict match should be used when exact match exists
      const output = 'hello world';
      const completionStart = 'hello ';
      expect(stripCompletionStart(output, completionStart)).toBe('world');
    });
  });
});

describe('buildFillMessage', () => {
  it('builds message with completion_start tag', () => {
    const prefix = 'Hello world, this is some text';
    const suffix = ' and more content.';
    const { message, completionStart } = buildFillMessage(prefix, suffix);

    expect(message).toContain('<current_text>');
    expect(message).toContain('>>>CURSOR<<<');
    expect(message).toContain('</current_text>');
    expect(message).toContain('<completion_start>');
    expect(message).toContain('</completion_start>');
    expect(message).toContain(completionStart);
  });

  it('includes suffix after cursor', () => {
    const prefix = 'The quick brown fox jumps over';
    const suffix = ' the lazy dog.';
    const { message } = buildFillMessage(prefix, suffix);

    expect(message).toContain('>>>CURSOR<<<' + suffix);
  });

  it('handles empty suffix', () => {
    const prefix = 'Some text here';
    const { message } = buildFillMessage(prefix, '');

    expect(message).toContain('>>>CURSOR<<<</current_text>');
  });

  it('handles whitespace-only suffix', () => {
    const prefix = 'Some text here';
    const { message } = buildFillMessage(prefix, '   ');

    // Whitespace-only suffix is trimmed, so treated as no suffix
    expect(message).toContain('>>>CURSOR<<<</current_text>');
  });

  it('returns completion start that matches end of prefix', () => {
    const prefix = 'The quick brown fox jumps over the lazy dog.';
    const { completionStart } = buildFillMessage(prefix, '');

    expect(prefix.endsWith(completionStart)).toBe(true);
  });

  it('truncated prefix + completion start equals original prefix', () => {
    const prefix = 'The quick brown fox jumps over the lazy dog.';
    const suffix = ' More text here.';
    const { message, completionStart } = buildFillMessage(prefix, suffix);

    // Extract truncated prefix from message
    const match = message.match(/<current_text>([\s\S]*?)>>>CURSOR<<</);
    const truncatedPrefix = match?.[1] ?? '';

    expect(truncatedPrefix + completionStart).toBe(prefix);
  });
});
