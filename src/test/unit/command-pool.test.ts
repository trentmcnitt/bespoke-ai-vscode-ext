import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandPool } from '../../providers/command-pool';
import { makeLogger, makeFakeStream, consumeIterable, FakeStream } from '../helpers';

// Mock the SDK dynamic import
const mockQueryFn = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => {
  return {
    query: (...args: unknown[]) => mockQueryFn(...args),
  };
});

/** Build a warmup response that passes validation. */
function makeWarmupResponse(): string {
  return 'READY';
}

/** Track all active fake streams so afterEach can release them */
const activeFakeStreams: FakeStream[] = [];

/** Create a fake stream with the default warmup response, tracked for cleanup */
function createFakeStream(resultTexts: string | string[], warmupResponse?: string): FakeStream {
  return makeFakeStream(resultTexts, warmupResponse ?? makeWarmupResponse(), activeFakeStreams);
}

describe('CommandPool', () => {
  let activePool: CommandPool | null = null;

  beforeEach(() => {
    mockQueryFn.mockReset();
  });

  afterEach(() => {
    activePool?.dispose();
    activePool = null;
    for (const s of activeFakeStreams) {
      s.terminate();
    }
    activeFakeStreams.length = 0;
  });

  describe('activation', () => {
    it('loads SDK and reports available after activation', async () => {
      const fakeStream = createFakeStream([]);

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      expect(pool.isAvailable()).toBe(true);
    });

    it('reports unavailable before activation', () => {
      const pool = new CommandPool('haiku', makeLogger());
      expect(pool.isAvailable()).toBe(false);
    });
  });

  describe('sendPrompt', () => {
    it('returns result text from pool', async () => {
      const fakeStream = createFakeStream(['This is the response']);

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const { text } = await pool.sendPrompt('Test message');
      expect(text).toBe('This is the response');
    });

    it('returns null when pool not available', async () => {
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      // Not activated

      const { text } = await pool.sendPrompt('Test message');
      expect(text).toBeNull();
    });

    it('returns null on timeout', async () => {
      // Warmup stream, a hanging stream for the request, and a recycled stream
      const streams = [createFakeStream([]), createFakeStream([]), createFakeStream([])];
      let callCount = 0;

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const stream = streams[callCount];
        callCount++;
        // Only consume streams for warmup and recycle, not the hanging request
        if (callCount === 1 || callCount === 3) {
          consumeIterable(prompt, stream);
        }
        return stream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      // The request will hang because we don't signal stream[1]
      // Timeout should trigger and return null
      const { text } = await pool.sendPrompt('Test message', { timeoutMs: 50 });
      expect(text).toBeNull();
    });

    it('returns null on cancellation', async () => {
      const fakeStream = createFakeStream(['response']);

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const controller = new AbortController();
      // Abort before calling sendPrompt
      controller.abort();

      const { text } = await pool.sendPrompt('Test message', { onCancel: controller.signal });
      expect(text).toBeNull();
    });

    it('sequential requests reuse the warm slot', async () => {
      const fakeStream = createFakeStream(['response1', 'response2']);

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const { text: text1 } = await pool.sendPrompt('First message');
      expect(text1).toBe('response1');

      const { text: text2 } = await pool.sendPrompt('Second message');
      expect(text2).toBe('response2');

      // Only one stream was created (SDK called once)
      expect(mockQueryFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateModel', () => {
    it('triggers recycleAll when model changes', async () => {
      const stream1 = createFakeStream(['response1']);
      const stream2 = createFakeStream(['response2']);
      let callCount = 0;

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const stream = callCount === 0 ? stream1 : stream2;
        callCount++;
        consumeIterable(prompt, stream);
        return stream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      expect(callCount).toBe(1);

      // Change model
      pool.updateModel('sonnet');

      // Wait for recycle
      await new Promise((r) => setTimeout(r, 50));

      // A new stream should have been created
      expect(callCount).toBe(2);
    });

    it('does not recycle when model unchanged', async () => {
      const fakeStream = createFakeStream([]);

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const initialCallCount = mockQueryFn.mock.calls.length;

      pool.updateModel('haiku'); // same model

      await new Promise((r) => setTimeout(r, 50));

      expect(mockQueryFn.mock.calls.length).toBe(initialCallCount);
    });
  });

  describe('warmup validation', () => {
    it('accepts READY response', async () => {
      const fakeStream = createFakeStream([], 'READY');

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      expect(pool.isAvailable()).toBe(true);
    });

    it('accepts ready response case-insensitively with surrounding text', async () => {
      const fakeStream = createFakeStream([], 'I am ready to help.');

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      expect(pool.isAvailable()).toBe(true);
    });
  });

  describe('dispose', () => {
    it('marks pool unavailable', async () => {
      const fakeStream = createFakeStream([]);

      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      expect(pool.isAvailable()).toBe(true);
      pool.dispose();
      activePool = null;
      expect(pool.isAvailable()).toBe(false);
    });
  });
});
