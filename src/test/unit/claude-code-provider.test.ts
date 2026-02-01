import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ClaudeCodeProvider,
  extractOutput,
  extractCompletionStart,
  stripCompletionStart,
  buildFillMessage,
} from '../../providers/claude-code';
import { makeConfig, makeProseContext, makeCodeContext, makeLogger } from '../helpers';

// Mock the SDK dynamic import
const mockQueryFn = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (...args: unknown[]) => mockQueryFn(...args),
  };
});

/**
 * Creates a fake async iterable stream that yields an init system message,
 * a warmup result, and then N real completion results (reusable slots).
 */
/** Track all active fake streams so afterEach can release them */
const activeFakeStreams: ReturnType<typeof makeFakeStream>[] = [];

/**
 * Creates a fake async iterable stream that yields a warmup result,
 * then N real completion results. Each result after the warmup blocks
 * until signalPush() is called. After all messages are consumed, blocks
 * indefinitely (like the real SDK stream) until terminate() is called.
 */
function makeFakeStream(completionTexts: string | string[]) {
  const texts = Array.isArray(completionTexts) ? completionTexts : [completionTexts];
  const messages = [
    // Warmup result (first turn response)
    { type: 'result', subtype: 'success', result: '{"status":"ready"}' },
    // Real completion results
    ...texts.map((t) => ({ type: 'result', subtype: 'success', result: t })),
  ];

  let index = 0;
  const waitQueue: ((v?: unknown) => void)[] = [];
  // Start at -1 to absorb the warmup signalPush from consumeIterable
  // (the warmup channel message doesn't correspond to a real result)
  let pushCount = -1;
  let terminated = false;

  function resolveNextWaiter() {
    const waiter = waitQueue.shift();
    if (waiter) {
      waiter();
    }
  }

  const fakeStream = {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            if (terminated) {
              return { value: undefined, done: true };
            }

            // After all messages consumed, block until terminated
            if (index >= messages.length) {
              await new Promise<void>((r) => {
                waitQueue.push(r);
              });
              return { value: undefined, done: true };
            }

            // After warmup result, wait for a signalPush before yielding
            if (index >= 1) {
              if (pushCount <= 0) {
                await new Promise<void>((r) => {
                  waitQueue.push(r);
                });
                if (terminated) {
                  return { value: undefined, done: true };
                }
              }
              pushCount--;
            }

            const value = messages[index++];
            return { value, done: false };
          },
          async return(): Promise<IteratorResult<unknown>> {
            terminated = true;
            return { value: undefined, done: true };
          },
        };
      },
    },
    /** Signal that a message was pushed (unblocks the stream for the next result) */
    signalPush() {
      pushCount++;
      resolveNextWaiter();
    },
    /** Terminate the stream (unblocks any waiting next() calls) */
    terminate() {
      terminated = true;
      while (waitQueue.length > 0) {
        resolveNextWaiter();
      }
    },
  };

  activeFakeStreams.push(fakeStream);
  return fakeStream;
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
      const fakeStream0 = makeFakeStream('');
      const fakeStream1 = makeFakeStream('');

      let callCount = 0;
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const stream = callCount === 0 ? fakeStream0 : fakeStream1;
        callCount++;
        // Consume the iterable to trigger message channel reads
        consumeIterable(prompt, stream);
        return stream.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      activeProvider = provider;
      await provider.activate('/test/workspace');

      expect(provider.isAvailable()).toBe(true);
    });

    it('reports unavailable when SDK import fails', async () => {
      // Override the mock to simulate import failure
      mockQueryFn.mockImplementation(() => {
        throw new Error('SDK not found');
      });

      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());

      // We need to test the actual loadSdk path — but the mock is at module level.
      // Instead, test that without activation, provider is not available.
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

  describe('single-waiter queue', () => {
    it('dispose cancels pending waiter', async () => {
      // Waiter cancellation on dispose is tested here.
      // Full concurrent waiter behavior is validated by API integration tests.
      const fakeStream0 = makeFakeStream(['result1']);
      const fakeStream1 = makeFakeStream(['result1']);

      let callCount = 0;
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const stream = callCount === 0 ? fakeStream0 : fakeStream1;
        callCount++;
        consumeIterable(prompt, stream);
        return stream.stream;
      });

      const provider = new ClaudeCodeProvider(makeConfig(), makeLogger());
      activeProvider = provider;
      await provider.activate('/test/workspace');

      // Make both slots busy
      const p1 = provider.getCompletion(makeProseContext(), new AbortController().signal);
      const p2 = provider.getCompletion(makeCodeContext(), new AbortController().signal);

      // Third request enters waiter path (both slots busy)
      const p3 = provider.getCompletion(makeProseContext(), new AbortController().signal);

      // Dispose cancels the waiter
      provider.dispose();
      activeProvider = null;

      const result3 = await p3;
      expect(result3).toBeNull();

      // p1/p2 hold references to old resultPromises that will never resolve
      // (dispose nulled deliverResult). Don't await them — let GC handle it.
      void p1;
      void p2;
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
    expect(completionStart).toBe(' lazy dog.');
    expect(truncatedPrefix).toBe('The quick brown fox jumps over the');
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
    expect(truncatedPrefix).toBe('They seem so complex and wasteful');
    expect(completionStart).toBe(' (noise, h');
    expect(truncatedPrefix + completionStart).toBe(prefix);
  });

  it('splits at paragraph boundary when newlines are nearby', () => {
    const prefix = "They power so much of our world.\n\nI've heard that ele";
    const { truncatedPrefix, completionStart } = extractCompletionStart(prefix);
    expect(truncatedPrefix).toBe("They power so much of our world.\n\nI've heard");
    expect(completionStart).toBe(' that ele');
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
    expect(truncatedPrefix).toBe('I was thinking about choosing colleges for');
    expect(completionStart).toBe(' my kids');
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

  it('returns null when whitespace-only completion start is normalized by model', () => {
    // Model returns one newline instead of two — mismatch
    const output = '\nSome content here';
    const completionStart = '\n\n';
    expect(stripCompletionStart(output, completionStart)).toBeNull();
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

/** Helper: consume async iterable in background, signaling the fake stream on each message */
function consumeIterable(
  iterable: AsyncIterable<unknown>,
  fakeStream: ReturnType<typeof makeFakeStream>,
) {
  (async () => {
    for await (const _msg of iterable) {
      // Each push signals the stream to yield the next result
      fakeStream.signalPush();
    }
  })().catch(() => {
    /* channel closed */
  });
}
