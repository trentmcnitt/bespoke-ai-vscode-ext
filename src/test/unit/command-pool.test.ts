import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CommandPool } from '../../providers/command-pool';
import {
  makeLogger,
  makeFakeStream,
  consumeIterable,
  FakeStream,
  expectIsolatedQueryOptions,
} from '../helpers';

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

    it('isolates the slot session from the host Claude Code configuration', async () => {
      const fakeStream = createFakeStream([]);
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      expectIsolatedQueryOptions(mockQueryFn.mock.calls[0][0].options);
    });
  });

  describe('why a command got no result', () => {
    /** Sessions answer warmup, then hold every command until the test settles it. */
    function holdingQuery() {
      let calls = 0;
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        calls++;
        async function* gen() {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield { type: 'result', subtype: 'success', result: 'READY' };
          while (!(await it.next()).done) {
            await new Promise(() => {}); // never answers
          }
        }
        return gen();
      });
      return () => calls;
    }
    const settle = () => new Promise((r) => setTimeout(r, 10));

    it('a recycle ends the held command as pool_recycled and a superseded one as aborted', async () => {
      holdingQuery();
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const held = pool.sendPrompt('one');
      const superseded = pool.sendPrompt('two');
      const waiting = pool.sendPrompt('three');
      expect(await superseded).toEqual({ text: null, meta: null, aborted: true });
      await settle();
      await pool.recycleAll();
      expect(await held).toMatchObject({ text: null, errorType: 'pool_recycled' });
      expect(await waiting).toMatchObject({ text: null, errorType: 'pool_recycled' });
    });

    it('a session that ends cleanly while holding the command is slot_stream_ended, not a hang', async () => {
      let end: (() => void) | null = null;
      let calls = 0;
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        calls++;
        async function* gen() {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield { type: 'result', subtype: 'success', result: 'READY' };
          await it.next();
          await new Promise<void>((r) => (end = r)); // the CLI exits without a result
        }
        return gen();
      });
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      // No timeoutMs: nothing but the session itself can settle this command.
      const held = pool.sendPrompt('one');
      await settle();
      end!();
      const res = await Promise.race([
        held,
        new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), 200)),
      ]);
      expect(res).toEqual({ text: null, meta: null, errorType: 'slot_stream_ended' });
      await settle();
      expect(calls).toBe(2); // the slot respawned
    });

    it('an unavailable pool reports slot_unavailable', async () => {
      const pool = new CommandPool('haiku', makeLogger());
      expect(await pool.sendPrompt('x')).toEqual({
        text: null,
        meta: null,
        errorType: 'slot_unavailable',
      });
    });
  });

  describe('cancellation (onCancel)', () => {
    /**
     * Sessions answer warmup, then answer each command with `ans:<message>`. A
     * `hold` command gets no answer; the session exits when its input closes (as
     * the CLI does on stdin EOF), after first emitting `late` for the held turn
     * when `lateResult` is set (the CLI finishing the turn it already received).
     */
    function cliQuery(opts: { lateResult?: boolean } = {}) {
      const received: string[][] = [];
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const mine: string[] = [];
        received.push(mine);
        async function* gen() {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield { type: 'result', subtype: 'success', result: 'READY' };
          for (;;) {
            const next = await it.next();
            if (next.done) return;
            const content = (next.value as { message: { content: string } }).message.content;
            mine.push(content);
            if (content === 'hold') {
              await it.next(); // resolves done once the channel closes
              if (opts.lateResult) yield { type: 'result', subtype: 'success', result: 'late' };
              return;
            }
            yield { type: 'result', subtype: 'success', result: `ans:${content}` };
          }
        }
        return gen();
      });
      return received;
    }
    const settle = () => new Promise((r) => setTimeout(r, 10));

    it('an abort ends the in-flight command as aborted and the slot serves the next one', async () => {
      const sessions = cliQuery();
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const controller = new AbortController();
      const held = pool.sendPrompt('hold', { timeoutMs: 60_000, onCancel: controller.signal });
      await settle();
      controller.abort();
      expect(await held).toEqual({ text: null, meta: null, aborted: true });

      const next = await pool.sendPrompt('two', { timeoutMs: 5_000 });
      expect(next).toEqual(expect.objectContaining({ text: 'ans:two' }));
      // The cancelled session was closed and replaced.
      expect(sessions.length).toBe(2);
      expect(sessions[1]).toEqual(['two']);
    });

    it('a late result for the cancelled turn does not hand the closing session to the next command', async () => {
      const sessions = cliQuery({ lateResult: true });
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const controller = new AbortController();
      const held = pool.sendPrompt('hold', { onCancel: controller.signal });
      await settle();
      controller.abort();
      // Sent while the cancelled session is still finishing its turn.
      const next = pool.sendPrompt('two', { timeoutMs: 5_000 });
      expect(await held).toEqual({ text: null, meta: null, aborted: true });
      expect(await next).toEqual(expect.objectContaining({ text: 'ans:two' }));
      expect(sessions[0]).toEqual(['hold']);
    });

    it('a late result for a timed-out turn does not hand the closing session to the next command', async () => {
      const sessions = cliQuery({ lateResult: true });
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const held = pool.sendPrompt('hold', { timeoutMs: 20 });
      await settle();
      const next = pool.sendPrompt('two', { timeoutMs: 5_000 });
      expect(await held).toMatchObject({ text: null, errorType: 'timeout' });
      expect(await next).toEqual(expect.objectContaining({ text: 'ans:two' }));
      expect(sessions[0]).toEqual(['hold']);
    });

    it('a signal aborted before sending sends nothing and leaves the warm slot in place', async () => {
      const sessions = cliQuery();
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const controller = new AbortController();
      controller.abort();
      expect(await pool.sendPrompt('never', { onCancel: controller.signal })).toEqual({
        text: null,
        meta: null,
        aborted: true,
      });
      expect(await pool.sendPrompt('two')).toEqual(expect.objectContaining({ text: 'ans:two' }));
      expect(sessions).toEqual([['two']]);
    });

    it('an abort while waiting for the slot ends the wait without sending', async () => {
      const sessions = cliQuery();
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const holder = new AbortController();
      const held = pool.sendPrompt('hold', { onCancel: holder.signal });
      await settle();
      const waiter = new AbortController();
      const waiting = pool.sendPrompt('queued', { onCancel: waiter.signal });
      await settle();
      waiter.abort();
      const res = await Promise.race([
        waiting,
        new Promise<'still waiting'>((r) => setTimeout(() => r('still waiting'), 200)),
      ]);
      expect(res).toEqual({ text: null, meta: null, aborted: true });

      holder.abort();
      await held;
      expect(await pool.sendPrompt('two')).toEqual(expect.objectContaining({ text: 'ans:two' }));
      expect(sessions.flat()).not.toContain('queued');
    });

    it('an abort after the answer, or a second abort, changes nothing', async () => {
      const sessions = cliQuery();
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const controller = new AbortController();
      const res = await pool.sendPrompt('one', { onCancel: controller.signal });
      expect(res.text).toBe('ans:one');
      controller.abort();
      controller.abort();
      await settle();
      expect(await pool.sendPrompt('two')).toEqual(expect.objectContaining({ text: 'ans:two' }));
      // Same session: the late abort did not close it.
      expect(sessions).toEqual([['one', 'two']]);
    });

    it('repeated cancels do not trip the rapid-recycle circuit breaker', async () => {
      cliQuery();
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      for (let i = 0; i < 6; i++) {
        const controller = new AbortController();
        const held = pool.sendPrompt('hold', { onCancel: controller.signal });
        await settle();
        controller.abort();
        expect(await held).toMatchObject({ aborted: true });
        await settle();
      }
      expect(pool.isAvailable()).toBe(true);
      expect(await pool.sendPrompt('two')).toEqual(expect.objectContaining({ text: 'ans:two' }));
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

    it('returns null with errorType timeout when the CLI never answers', async () => {
      // Warmup answers; the request's session then stays alive without a result.
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        async function* gen() {
          const it = prompt[Symbol.asyncIterator]();
          await it.next();
          yield { type: 'result', subtype: 'success', result: 'READY' };
          await it.next();
          await new Promise<void>(() => {}); // hangs
        }
        return gen();
      });

      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const result = await pool.sendPrompt('Test message', { timeoutMs: 50 });
      expect(result.text).toBeNull();
      // Reported as a timeout (it rides to the router and to follower windows),
      // not as a cancel, a pool failure, or an empty model reply.
      expect(result.errorType).toBe('timeout');
      expect(result.aborted).toBeUndefined();
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

  describe('per-turn metadata', () => {
    it("reports each command's own cost and API time, not the session totals", async () => {
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        const totals = [
          { text: 'READY', cost: 0.001, apiMs: 500 },
          { text: 'first', cost: 0.011, apiMs: 2500 },
          { text: 'second', cost: 0.016, apiMs: 3700 },
        ];
        async function* gen() {
          const it = prompt[Symbol.asyncIterator]();
          for (const t of totals) {
            if ((await it.next()).done) return;
            yield {
              type: 'result',
              subtype: 'success',
              result: t.text,
              total_cost_usd: t.cost,
              duration_api_ms: t.apiMs,
              usage: { input_tokens: 1, output_tokens: 1 },
            };
          }
          await it.next();
        }
        return gen();
      });
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      const first = await pool.sendPrompt('a');
      expect(first.meta?.costUsd).toBeCloseTo(0.01, 10);
      expect(first.meta?.turnCostUsd).toBeCloseTo(0.01, 10);
      expect(first.meta?.durationApiMs).toBe(2000);
      const second = await pool.sendPrompt('b');
      expect(second.meta?.costUsd).toBeCloseTo(0.005, 10);
      expect(second.meta?.durationApiMs).toBe(1200);
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

  describe('rapid-recycle circuit breaker', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('once every slot is dead the pool is unavailable and commands fail with pool_circuit_open', async () => {
      const fakeStream = createFakeStream([]);
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });
      const pool = new CommandPool('haiku', makeLogger());
      activePool = pool;
      await pool.activate();

      // Four rapid recycles already counted; the session ending is the fifth.
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now);
      const slot = (
        pool as unknown as { slots: { rapidRecycleCount: number; lastRecycleTime: number }[] }
      ).slots[0];
      slot.rapidRecycleCount = 4;
      slot.lastRecycleTime = now;
      fakeStream.terminate();
      for (let i = 0; i < 10 && pool.isAvailable(); i++) {
        await new Promise((r) => setTimeout(r, 5));
      }

      expect(pool.isAvailable()).toBe(false);
      expect(await pool.sendPrompt('x')).toEqual({
        text: null,
        meta: null,
        errorType: 'pool_circuit_open',
      });
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

    it('a command sent after dispose is aborted (shutting down), not slot_unavailable', async () => {
      const fakeStream = createFakeStream([]);
      mockQueryFn.mockImplementation(({ prompt }: { prompt: AsyncIterable<unknown> }) => {
        consumeIterable(prompt, fakeStream);
        return fakeStream.stream;
      });

      const pool = new CommandPool('haiku', makeLogger());
      await pool.activate();
      pool.dispose();

      expect(await pool.sendPrompt('x')).toEqual({ text: null, meta: null, aborted: true });
    });
  });
});
