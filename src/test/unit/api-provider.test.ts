import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiCompletionProvider } from '../../providers/api/api-provider';
import { ApiAdapterResult, Preset } from '../../providers/api/types';
import { SYSTEM_PROMPT } from '../../providers/prompt-strategy';
import { UsageLedger } from '../../utils/usage-ledger';
import { Logger } from '../../utils/logger';
import { makeConfig, makeLogger, makeProseContext, makeCodeContext } from '../helpers';
import { detailFromError } from '../../utils/trace';

// The adapter factory is mocked so the provider's own logic (strategy selection,
// extraction, breaker, ledger) is exercised without touching an SDK or network.
const mocks = vi.hoisted(() => ({
  createAdapter: vi.fn(),
}));

vi.mock('../../providers/api/adapters', () => ({
  createAdapter: mocks.createAdapter,
}));

type CompleteFn = (
  system: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  options: {
    signal: AbortSignal;
    maxTokens: number;
    temperature: number;
    stopSequences?: string[];
  },
) => Promise<ApiAdapterResult>;

interface FakeAdapter {
  providerId: string;
  preset: Preset;
  complete: ReturnType<typeof vi.fn<CompleteFn>>;
  isConfigured: ReturnType<typeof vi.fn<() => boolean>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

function makeResult(overrides: Partial<ApiAdapterResult> = {}): ApiAdapterResult {
  return {
    text: '<COMPLETION> ran into the forest.</COMPLETION>',
    usage: { inputTokens: 100, outputTokens: 12, cacheReadTokens: 40 },
    model: 'fake-model',
    durationMs: 123,
    ...overrides,
  };
}

/** Every createAdapter() call produces a fresh fake, recorded in `adapters`. */
let adapters: FakeAdapter[];

function installAdapterFactory() {
  adapters = [];
  mocks.createAdapter.mockImplementation((preset: Preset) => {
    const adapter: FakeAdapter = {
      providerId: preset.provider,
      preset,
      complete: vi.fn<CompleteFn>().mockResolvedValue(makeResult()),
      isConfigured: vi.fn(() => true),
      dispose: vi.fn(),
    };
    adapters.push(adapter);
    return adapter;
  });
}

function lastAdapter(): FakeAdapter {
  return adapters[adapters.length - 1];
}

function makeLedger() {
  const record = vi.fn();
  return { ledger: { record } as unknown as UsageLedger, record };
}

function makeErrorLogger(): { logger: Logger; error: ReturnType<typeof vi.fn> } {
  const error = vi.fn();
  return { logger: { ...makeLogger(), error } as unknown as Logger, error };
}

const signal = () => new AbortController().signal;

describe('ApiCompletionProvider', () => {
  beforeEach(() => {
    mocks.createAdapter.mockReset();
    installAdapterFactory();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('adapter loading', () => {
    it('creates an adapter for the configured preset', () => {
      const provider = new ApiCompletionProvider(
        makeConfig({ backend: 'api', api: { preset: 'xai-grok', customPresets: [] } }),
        makeLogger(),
      );
      expect(mocks.createAdapter).toHaveBeenCalledTimes(1);
      expect(lastAdapter().preset.id).toBe('xai-grok');
      expect(provider.getActivePreset()?.id).toBe('xai-grok');
      expect(provider.isAvailable()).toBe(true);
    });

    it('reports unavailable when the adapter has no API key', () => {
      mocks.createAdapter.mockImplementation((preset: Preset) => ({
        providerId: preset.provider,
        complete: vi.fn(),
        isConfigured: () => false,
        dispose: vi.fn(),
      }));
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      expect(provider.isAvailable()).toBe(false);
    });

    it('unknown preset: logs an error, is unavailable, and getCompletion returns null', async () => {
      const { logger, error } = makeErrorLogger();
      const provider = new ApiCompletionProvider(
        makeConfig({ api: { preset: 'does-not-exist', customPresets: [] } }),
        logger,
      );
      expect(mocks.createAdapter).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('does-not-exist'));
      expect(provider.isAvailable()).toBe(false);
      expect(provider.getActivePreset()).toBeNull();
      await expect(provider.getCompletion(makeProseContext(), signal())).resolves.toBeNull();
    });

    it('adapter construction failure: logs an error and returns null instead of throwing', async () => {
      mocks.createAdapter.mockImplementation(() => {
        throw new Error('boom');
      });
      const { logger, error } = makeErrorLogger();
      const provider = new ApiCompletionProvider(makeConfig(), logger);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('boom'));
      expect(provider.isAvailable()).toBe(false);
      await expect(provider.getCompletion(makeProseContext(), signal())).resolves.toBeNull();
    });

    it('updateConfig with a new preset disposes the old adapter and loads the new one', () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const first = lastAdapter();

      provider.updateConfig(makeConfig({ api: { preset: 'anthropic-haiku', customPresets: [] } }));

      expect(first.dispose).toHaveBeenCalledTimes(1);
      expect(adapters).toHaveLength(2);
      expect(provider.getActivePreset()?.id).toBe('anthropic-haiku');
    });

    it('updateConfig with the same preset keeps the existing adapter', () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      provider.updateConfig(makeConfig({ customInstructions: 'changed' }));
      expect(adapters).toHaveLength(1);
      expect(adapters[0].dispose).not.toHaveBeenCalled();
    });

    it('dispose tears down the adapter and makes the provider inert', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const adapter = lastAdapter();
      provider.dispose();
      expect(adapter.dispose).toHaveBeenCalledTimes(1);
      expect(provider.isAvailable()).toBe(false);
      await expect(provider.getCompletion(makeProseContext(), signal())).resolves.toBeNull();
      expect(adapter.complete).not.toHaveBeenCalled();
    });

    it('recycleAll replaces the adapter', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const first = lastAdapter();
      await provider.recycleAll();
      expect(first.dispose).toHaveBeenCalledTimes(1);
      expect(adapters).toHaveLength(2);
    });
  });

  describe('prompt strategy selection', () => {
    it('instruction-extraction preset (xai-grok): sends only a user message and extracts tag content', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const adapter = lastAdapter();
      adapter.complete.mockResolvedValue(
        makeResult({ text: 'Sure! <COMPLETION> ran into the forest.</COMPLETION>' }),
      );

      const ctx = makeProseContext();
      const result = await provider.getCompletion(ctx, signal());

      expect(result).toBe(' ran into the forest.');
      const [system, messages, options] = adapter.complete.mock.calls[0];
      expect(system).toBe(SYSTEM_PROMPT);
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
      expect(messages[0].content).toContain(`${ctx.prefix}{{FILL_HERE}}`);
      expect(messages[0].content).toContain('language="markdown"');
      // Preset parameters flow into the request options.
      expect(options.maxTokens).toBe(200);
      expect(options.temperature).toBe(0.3);
    });

    it('instruction-extraction preset strips chatty preamble when tags are missing', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockResolvedValue(
        makeResult({ text: "Here's the completion: ran off" }),
      );
      await expect(provider.getCompletion(makeProseContext(), signal())).resolves.toBe('ran off');
    });

    it('prefill-extraction preset (anthropic-haiku): appends an assistant prefill anchored on the prefix tail', async () => {
      const provider = new ApiCompletionProvider(
        makeConfig({ api: { preset: 'anthropic-haiku', customPresets: [] } }),
        makeLogger(),
      );
      const adapter = lastAdapter();
      // With prefill the model continues after "<COMPLETION>anchor", so the raw
      // response is just the continuation followed by the closing tag.
      adapter.complete.mockResolvedValue(
        makeResult({ text: ' ran into the forest.</COMPLETION> trailing chatter' }),
      );

      const ctx = makeProseContext({ prefix: 'x'.repeat(60) + ' and then   ' });
      const result = await provider.getCompletion(ctx, signal());

      // The prefix already ends in spaces (trimmed off the anchor), so the model's
      // re-emitted leading space is dropped rather than doubled.
      expect(result).toBe('ran into the forest.');
      const messages = adapter.complete.mock.calls[0][1];
      expect(messages).toHaveLength(2);
      expect(messages[1].role).toBe('assistant');
      // Last 40 chars of prefix, trailing whitespace trimmed (Anthropic rejects it).
      expect(messages[1].content).toBe(`<COMPLETION>${ctx.prefix.slice(-40).trimEnd()}`);
    });

    it('anthropic-sonnet (Sonnet 5, no prefill support): sends only a user message and extracts tags', async () => {
      const provider = new ApiCompletionProvider(
        makeConfig({ api: { preset: 'anthropic-sonnet', customPresets: [] } }),
        makeLogger(),
      );
      const adapter = lastAdapter();
      // The adapter receives the capability flags it uses to leave out temperature.
      expect(adapter.preset.features).toEqual({
        promptCaching: true,
        prefill: false,
        sampling: false,
        disableThinking: true,
      });
      adapter.complete.mockResolvedValue(
        makeResult({ text: '<COMPLETION> ran into the forest.</COMPLETION>' }),
      );

      const ctx = makeProseContext({ prefix: 'The fox' });
      await expect(provider.getCompletion(ctx, signal())).resolves.toBe(' ran into the forest.');
      const messages = adapter.complete.mock.calls[0][1];
      expect(messages).toEqual([
        { role: 'user', content: expect.stringContaining('{{FILL_HERE}}') },
      ]);
    });

    it('anthropic-sonnet applies prefix-overlap trimming (no prefill anchor to rely on)', async () => {
      const provider = new ApiCompletionProvider(
        makeConfig({ api: { preset: 'anthropic-sonnet', customPresets: [] } }),
        makeLogger(),
      );
      lastAdapter().complete.mockResolvedValue(
        makeResult({ text: '<COMPLETION>- item two</COMPLETION>' }),
      );
      const ctx = makeProseContext({ prefix: '- item one\n- ' });
      await expect(provider.getCompletion(ctx, signal())).resolves.toBe('item two');
    });

    it('prefill preset returns null when the model closes the tag immediately with nothing usable', async () => {
      const provider = new ApiCompletionProvider(
        makeConfig({ api: { preset: 'anthropic-haiku', customPresets: [] } }),
        makeLogger(),
      );
      lastAdapter().complete.mockResolvedValue(makeResult({ text: '</COMPLETION>I think...' }));
      await expect(provider.getCompletion(makeProseContext(), signal())).resolves.toBeNull();
    });

    it('non-prefill preset trims an echoed current-line fragment', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockResolvedValue(
        makeResult({ text: '<COMPLETION>- item two</COMPLETION>' }),
      );
      const ctx = makeProseContext({ prefix: '- item one\n- ' });
      await expect(provider.getCompletion(ctx, signal())).resolves.toBe('item two');
    });

    it('prefill preset skips prefix-overlap trimming (the prefill anchor handles it)', async () => {
      const provider = new ApiCompletionProvider(
        makeConfig({ api: { preset: 'anthropic-haiku', customPresets: [] } }),
        makeLogger(),
      );
      lastAdapter().complete.mockResolvedValue(makeResult({ text: '- item two</COMPLETION>' }));
      const ctx = makeProseContext({ prefix: '- item one\n- ' });
      await expect(provider.getCompletion(ctx, signal())).resolves.toBe('- item two');
    });

    it('appends sanitized custom instructions to the system prompt', async () => {
      const provider = new ApiCompletionProvider(
        makeConfig({ customInstructions: 'Use British spelling.‮' }),
        makeLogger(),
      );
      await provider.getCompletion(makeProseContext(), signal());
      const system = lastAdapter().complete.mock.calls[0][0];
      expect(system.startsWith(SYSTEM_PROMPT)).toBe(true);
      expect(system).toContain('Use British spelling.');
      expect(system).not.toContain('‮');
    });

    it('passes the caller AbortSignal through to the adapter', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const ac = new AbortController();
      await provider.getCompletion(makeCodeContext(), ac.signal);
      expect(lastAdapter().complete.mock.calls[0][2].signal).toBe(ac.signal);
    });
  });

  describe('errors and aborts', () => {
    it('returns null (does not throw) when the adapter reports an abort', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockResolvedValue(
        makeResult({ text: null, aborted: true, usage: { inputTokens: 0, outputTokens: 0 } }),
      );
      await expect(provider.getCompletion(makeProseContext(), signal())).resolves.toBeNull();
    });

    it('propagates adapter errors to the caller', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const err = new Error('xai API key invalid or missing');
      lastAdapter().complete.mockRejectedValue(err);
      await expect(provider.getCompletion(makeProseContext(), signal())).rejects.toBe(err);
    });
  });

  describe('circuit breaker', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    async function failN(provider: ApiCompletionProvider, n: number) {
      for (let i = 0; i < n; i++) {
        await expect(provider.getCompletion(makeProseContext(), signal())).rejects.toThrow();
      }
    }

    it('opens after 5 consecutive thrown failures, blocks calls, and recovers after the 30s cooldown', async () => {
      const onOpen = vi.fn();
      const onClose = vi.fn();
      const provider = new ApiCompletionProvider(
        makeConfig(),
        makeLogger(),
        undefined,
        onOpen,
        onClose,
      );
      const adapter = lastAdapter();
      adapter.complete.mockRejectedValue(new Error('500'));

      await failN(provider, 4);
      expect(provider.isAvailable()).toBe(true);
      await failN(provider, 1);

      expect(onOpen).toHaveBeenCalledTimes(1);
      expect(provider.isAvailable()).toBe(false);
      await expect(provider.getCompletion(makeProseContext(), signal())).resolves.toBeNull();
      expect(adapter.complete).toHaveBeenCalledTimes(5); // blocked call never reached adapter

      vi.advanceTimersByTime(30_001);
      adapter.complete.mockResolvedValue(makeResult());
      expect(provider.isAvailable()).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
      await expect(provider.getCompletion(makeProseContext(), signal())).resolves.toBe(
        ' ran into the forest.',
      );
      expect(adapter.complete).toHaveBeenCalledTimes(6);
    });

    it('a call blocked by the open breaker reports circuit_open, not an empty result', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockRejectedValue(new Error('500'));
      await failN(provider, 5);
      const res = await provider.getCompletionWithDetail(makeProseContext(), signal());
      expect(res.text).toBeNull();
      expect(res.detail?.errorType).toBe('circuit_open');
    });

    it('stays open until the cooldown has fully elapsed', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockRejectedValue(new Error('500'));
      await failN(provider, 5);
      vi.advanceTimersByTime(29_000);
      expect(provider.isAvailable()).toBe(false);
    });

    it('a genuinely empty reply does not count as a failure', async () => {
      // The model closed immediately / was cut by a stop sequence: the backend is fine.
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockResolvedValue(
        makeResult({
          text: null,
          finishReason: 'end_turn',
          usage: { inputTokens: 100, outputTokens: 7 },
        }),
      );
      for (let i = 0; i < 10; i++) {
        await provider.getCompletion(makeProseContext(), signal());
      }
      expect(provider.isAvailable()).toBe(true);
    });

    it('a genuinely empty reply resets a failure streak (the backend answered)', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const adapter = lastAdapter();
      adapter.complete.mockRejectedValue(new Error('500'));
      await failN(provider, 4);
      adapter.complete.mockResolvedValueOnce(
        makeResult({ text: '', finishReason: 'stop_sequence' }),
      );
      await provider.getCompletion(makeProseContext(), signal());
      await failN(provider, 4);
      expect(provider.isAvailable()).toBe(true);
    });

    it('a reply that post-processing trims to nothing does not count', async () => {
      // Suffix echo: the model returned exactly the text after the cursor.
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const ctx = makeProseContext({ prefix: 'The cat ', suffix: 'sat on the mat.' });
      lastAdapter().complete.mockResolvedValue(
        makeResult({ text: '<COMPLETION>sat on the mat.</COMPLETION>', finishReason: 'end_turn' }),
      );
      for (let i = 0; i < 10; i++) {
        expect(await provider.getCompletion(ctx, signal())).toBeNull();
      }
      expect(provider.isAvailable()).toBe(true);
    });

    it('swallowed provider failures (429/529, connection refused) count as failures', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockResolvedValue(
        makeResult({ text: null, errorType: '429', usage: { inputTokens: 0, outputTokens: 0 } }),
      );
      for (let i = 0; i < 5; i++) {
        await provider.getCompletion(makeProseContext(), signal());
      }
      expect(provider.isAvailable()).toBe(false);
    });

    it('a malformed empty reply (no output tokens, no finish reason) counts as a failure', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockResolvedValue(
        makeResult({ text: null, usage: { inputTokens: 0, outputTokens: 0 } }),
      );
      for (let i = 0; i < 5; i++) {
        await provider.getCompletion(makeProseContext(), signal());
      }
      expect(provider.isAvailable()).toBe(false);
    });

    it('aborted responses do not count as failures', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockResolvedValue(makeResult({ text: null, aborted: true }));
      for (let i = 0; i < 10; i++) {
        await provider.getCompletion(makeProseContext(), signal());
      }
      expect(provider.isAvailable()).toBe(true);
    });

    it('a success resets the consecutive failure count', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const adapter = lastAdapter();
      adapter.complete.mockRejectedValue(new Error('500'));
      await failN(provider, 4);
      adapter.complete.mockResolvedValueOnce(makeResult());
      await provider.getCompletion(makeProseContext(), signal());
      await failN(provider, 4);
      expect(provider.isAvailable()).toBe(true);
    });

    it('loading a new preset resets an open breaker', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockRejectedValue(new Error('500'));
      await failN(provider, 5);
      expect(provider.isAvailable()).toBe(false);
      provider.updateConfig(makeConfig({ api: { preset: 'anthropic-haiku', customPresets: [] } }));
      expect(provider.isAvailable()).toBe(true);
    });
  });

  describe('usage ledger', () => {
    it('records model, tokens, cached tokens, duration and char counts for a completion', async () => {
      const { ledger, record } = makeLedger();
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger(), ledger);
      const raw = '<COMPLETION> ran into the forest.</COMPLETION>';
      lastAdapter().complete.mockResolvedValue(
        makeResult({
          text: raw,
          model: 'grok-4-1-fast-non-reasoning',
          durationMs: 321,
          usage: { inputTokens: 900, outputTokens: 15, cacheReadTokens: 512 },
        }),
      );

      const ctx = makeCodeContext();
      await provider.getCompletion(ctx, signal());

      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith({
        source: 'completion',
        model: 'grok-4-1-fast-non-reasoning',
        backend: 'api',
        durationMs: 321,
        inputTokens: 900,
        outputTokens: 15,
        cacheReadTokens: 512,
        inputChars: ctx.prefix.length + ctx.suffix.length,
        outputChars: raw.length,
      });
    });

    it('records usage even when the response is empty', async () => {
      const { ledger, record } = makeLedger();
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger(), ledger);
      lastAdapter().complete.mockResolvedValue(makeResult({ text: null }));
      await provider.getCompletion(makeProseContext(), signal());
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ outputChars: 0 }));
    });

    it('does not record when the adapter throws', async () => {
      const { ledger, record } = makeLedger();
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger(), ledger);
      lastAdapter().complete.mockRejectedValue(new Error('500'));
      await expect(provider.getCompletion(makeProseContext(), signal())).rejects.toThrow();
      expect(record).not.toHaveBeenCalled();
    });
  });

  describe('getCompletionWithPreset', () => {
    it('runs the request through the override preset and restores the active preset afterwards', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const primary = lastAdapter();

      const result = await provider.getCompletionWithPreset(
        'anthropic-haiku',
        makeCodeContext(),
        signal(),
      );

      const override = lastAdapter();
      expect(override).not.toBe(primary);
      expect(override.preset.id).toBe('anthropic-haiku');
      expect(override.complete).toHaveBeenCalledTimes(1);
      // Prefill strategy was used for the override request.
      expect(override.complete.mock.calls[0][1]).toHaveLength(2);
      expect(result).not.toBeNull();

      expect(primary.dispose).not.toHaveBeenCalled();
      expect(provider.getActivePreset()?.id).toBe('xai-grok');
      await provider.getCompletion(makeProseContext(), signal());
      expect(primary.complete).toHaveBeenCalledTimes(1);
    });

    it('reports backend_unavailable (not an empty reply) for an unknown override preset', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const res = await provider.getCompletionWithPresetDetail(
        'no-such-preset',
        makeCodeContext(),
        signal(),
      );
      expect(res.text).toBeNull();
      expect(res.detail?.errorType).toBe('backend_unavailable');
      expect(provider.getActivePreset()?.id).toBe('xai-grok');
    });

    it('restores the primary adapter even when the override request throws', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      const primary = lastAdapter();
      mocks.createAdapter.mockImplementationOnce((preset: Preset) => ({
        providerId: preset.provider,
        complete: vi.fn().mockRejectedValue(new Error('override failed')),
        isConfigured: () => true,
        dispose: vi.fn(),
      }));

      await expect(
        provider.getCompletionWithPreset('anthropic-haiku', makeCodeContext(), signal()),
      ).rejects.toThrow('override failed');

      expect(provider.getActivePreset()?.id).toBe('xai-grok');
      await provider.getCompletion(makeProseContext(), signal());
      expect(primary.complete).toHaveBeenCalledTimes(1);
    });

    it('returns null for an unknown override preset', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      await expect(
        provider.getCompletionWithPreset('nope', makeCodeContext(), signal()),
      ).resolves.toBeNull();
      expect(provider.getActivePreset()?.id).toBe('xai-grok');
    });
  });

  describe('testConnection', () => {
    it('sends a minimal request with the base system prompt and reports success', async () => {
      const provider = new ApiCompletionProvider(
        makeConfig({ customInstructions: 'ignored for health checks' }),
        makeLogger(),
      );
      const adapter = lastAdapter();
      adapter.complete.mockResolvedValue(makeResult({ text: '4', model: 'm', durationMs: 50 }));

      const res = await provider.testConnection();

      expect(res).toEqual({ ok: true, model: 'm', durationMs: 50 });
      const [system, messages, options] = adapter.complete.mock.calls[0];
      expect(system).toBe(SYSTEM_PROMPT);
      expect(messages[0].content).toContain('Two plus two equals {{FILL_HERE}}');
      expect(options).toMatchObject({ maxTokens: 20, temperature: 0 });
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('reports failure for an empty response', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockResolvedValue(makeResult({ text: null, model: 'm' }));
      await expect(provider.testConnection()).resolves.toMatchObject({
        ok: false,
        model: 'm',
        error: 'No response received',
      });
    });

    it('converts adapter errors into an error result', async () => {
      const provider = new ApiCompletionProvider(makeConfig(), makeLogger());
      lastAdapter().complete.mockRejectedValue(new Error('API key invalid'));
      await expect(provider.testConnection()).resolves.toEqual({
        ok: false,
        model: 'grok-4-1-fast-non-reasoning',
        durationMs: 0,
        error: 'API key invalid',
      });
    });

    it('reports when no adapter is loaded', async () => {
      const provider = new ApiCompletionProvider(
        makeConfig({ api: { preset: 'nope', customPresets: [] } }),
        makeLogger(),
      );
      await expect(provider.testConnection()).resolves.toEqual({
        ok: false,
        model: '',
        durationMs: 0,
        error: 'No adapter loaded',
      });
    });
  });
});

describe('ApiCompletionProvider — generation detail', () => {
  beforeEach(() => {
    mocks.createAdapter.mockReset();
    installAdapterFactory();
  });

  it('reports provider, models, usage, finish reason, and content when capture is on', async () => {
    const provider = new ApiCompletionProvider(
      makeConfig({ backend: 'api', api: { preset: 'xai-grok', customPresets: [] } }),
      makeLogger(),
    );
    lastAdapter().complete.mockResolvedValue(
      makeResult({
        usage: { inputTokens: 100, outputTokens: 12, cacheReadTokens: 40, cacheWriteTokens: 5 },
        finishReason: 'stop',
      }),
    );
    const { text, detail } = await provider.getCompletionWithDetail(
      makeProseContext({ prefix: 'The fox', suffix: '' }),
      signal(),
      { captureContent: true },
    );
    expect(text).toBe(' ran into the forest.');
    expect(detail).toMatchObject({
      providerName: 'x_ai',
      requestModel: lastAdapter().preset.modelId,
      responseModel: 'fake-model',
      serverAddress: 'api.x.ai',
      maxTokens: lastAdapter().preset.maxTokens,
      inputTokens: 100,
      outputTokens: 12,
      cacheReadTokens: 40,
      cacheWriteTokens: 5,
      durationApiMs: 123,
      finishReason: 'stop',
    });
    expect(detail?.costUsd).toBeUndefined();
    expect(detail?.content?.systemPrompt).toBe(lastAdapter().complete.mock.calls[0][0]);
    expect(detail?.content?.userMessage).toBe(lastAdapter().complete.mock.calls[0][1][0].content);
    expect(detail?.content?.rawOutput).toBe('<COMPLETION> ran into the forest.</COMPLETION>');
    expect(detail?.content?.extracted).toBe(' ran into the forest.');
  });

  it('omits content when capture is off (the default)', async () => {
    const provider = new ApiCompletionProvider(
      makeConfig({ backend: 'api', api: { preset: 'xai-grok', customPresets: [] } }),
      makeLogger(),
    );
    const { detail } = await provider.getCompletionWithDetail(makeProseContext(), signal());
    expect(detail?.content).toBeUndefined();
    expect(detail?.outputTokens).toBe(12);
  });

  it('flags aborted and swallowed rate-limit results', async () => {
    const provider = new ApiCompletionProvider(
      makeConfig({ backend: 'api', api: { preset: 'xai-grok', customPresets: [] } }),
      makeLogger(),
    );
    lastAdapter().complete.mockResolvedValueOnce(makeResult({ text: null, aborted: true }));
    expect(
      (await provider.getCompletionWithDetail(makeProseContext(), signal())).detail?.aborted,
    ).toBe(true);
    lastAdapter().complete.mockResolvedValueOnce(makeResult({ text: null, errorType: '429' }));
    expect(
      (await provider.getCompletionWithDetail(makeProseContext(), signal())).detail?.errorType,
    ).toBe('429');
  });

  it('attaches detail to thrown adapter errors', async () => {
    const provider = new ApiCompletionProvider(
      makeConfig({ backend: 'api', api: { preset: 'xai-grok', customPresets: [] } }),
      makeLogger(),
    );
    const err = new Error('boom');
    lastAdapter().complete.mockRejectedValueOnce(err);
    await expect(
      provider.getCompletionWithDetail(makeProseContext(), signal(), { captureContent: true }),
    ).rejects.toBe(err);
    expect(detailFromError(err)).toMatchObject({ providerName: 'x_ai' });
  });
});
