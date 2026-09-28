import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicAdapter } from '../../providers/api/adapters/anthropic';
import { Preset } from '../../providers/api/types';

// Mock the SDK and key resolution. resolveApiKey must be mocked: unmocked it reads
// process.env and ~/.creds/api-keys.env, which makes results machine-dependent.
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  ctor: vi.fn(),
  resolveApiKey: vi.fn(),
}));

vi.mock('@anthropic-ai/sdk', () => ({
  default: class FakeAnthropic {
    messages = { create: mocks.create };
    constructor(opts: unknown) {
      mocks.ctor(opts);
    }
  },
}));

vi.mock('../../utils/api-key-store', () => ({
  resolveApiKey: mocks.resolveApiKey,
}));

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'anthropic-test',
    displayName: 'Test Haiku',
    provider: 'anthropic',
    modelId: 'claude-haiku-4-5-20251001',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'prefill-extraction',
    features: { promptCaching: true, prefill: true },
    ...overrides,
  };
}

function makeResponse(overrides: Record<string, unknown> = {}) {
  return {
    content: [{ type: 'text', text: ' continued.</COMPLETION>' }],
    usage: { input_tokens: 50, output_tokens: 8, cache_read_input_tokens: 900 },
    model: 'claude-haiku-4-5-20251001',
    ...overrides,
  };
}

const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: '<document>...</document>' },
  { role: 'assistant', content: '<COMPLETION>The fox' },
];

function opts(extra: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    maxTokens: 200,
    temperature: 0.2,
    ...extra,
  };
}

describe('AnthropicAdapter', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.ctor.mockReset();
    mocks.resolveApiKey.mockReset();
    mocks.resolveApiKey.mockReturnValue('sk-ant-test');
    mocks.create.mockResolvedValue(makeResponse());
  });

  describe('isConfigured', () => {
    it('is true when the key resolves', () => {
      expect(new AnthropicAdapter(makePreset()).isConfigured()).toBe(true);
      expect(mocks.resolveApiKey).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
    });

    it('is false when the key does not resolve', () => {
      mocks.resolveApiKey.mockReturnValue(undefined);
      expect(new AnthropicAdapter(makePreset()).isConfigured()).toBe(false);
    });

    it('is false when the preset names no key variable', () => {
      expect(new AnthropicAdapter(makePreset({ apiKeyEnvVar: undefined })).isConfigured()).toBe(
        false,
      );
    });
  });

  describe('request shape', () => {
    it('sends model, limits, stop sequences, and the prefill message as the last assistant turn', async () => {
      const adapter = new AnthropicAdapter(makePreset());
      const signal = new AbortController().signal;
      await adapter.complete('SYS', messages, {
        signal,
        maxTokens: 150,
        temperature: 0.4,
        stopSequences: ['\n\n'],
      });

      expect(mocks.create).toHaveBeenCalledTimes(1);
      const [params, requestOpts] = mocks.create.mock.calls[0];
      expect(params).toMatchObject({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        temperature: 0.4,
        stop_sequences: ['\n\n'],
      });
      expect(params.messages).toEqual([
        { role: 'user', content: '<document>...</document>' },
        { role: 'assistant', content: '<COMPLETION>The fox' },
      ]);
      expect(requestOpts).toEqual({ signal });
    });

    it('Sonnet 5 preset: no temperature key, and only the user message is sent', async () => {
      const sonnet = makePreset({
        modelId: 'claude-sonnet-5',
        promptStrategy: 'tag-extraction',
        features: { promptCaching: true, prefill: false, sampling: false, disableThinking: true },
      });
      await new AnthropicAdapter(sonnet).complete(
        'SYS',
        [{ role: 'user', content: '<document>...</document>' }],
        opts({ temperature: 0.2 }),
      );
      const params = mocks.create.mock.calls[0][0];
      expect(Object.keys(params)).not.toContain('temperature');
      expect(params.thinking).toEqual({ type: 'disabled' });
      expect(params.model).toBe('claude-sonnet-5');
      expect(params.messages).toEqual([{ role: 'user', content: '<document>...</document>' }]);
      expect(params.system).toEqual([
        { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('Haiku 4.5 preset (sampling not disabled) still sends temperature', async () => {
      await new AnthropicAdapter(makePreset()).complete(
        'SYS',
        messages,
        opts({ temperature: 0.2 }),
      );
      expect(mocks.create.mock.calls[0][0].temperature).toBe(0.2);
      expect(Object.keys(mocks.create.mock.calls[0][0])).not.toContain('thinking');
    });

    it('wraps the system prompt in a cache_control block when prompt caching is enabled', async () => {
      await new AnthropicAdapter(makePreset()).complete('SYS', messages, opts());
      expect(mocks.create.mock.calls[0][0].system).toEqual([
        { type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } },
      ]);
    });

    it('sends the system prompt as a plain string when prompt caching is disabled', async () => {
      await new AnthropicAdapter(makePreset({ features: { prefill: true } })).complete(
        'SYS',
        messages,
        opts(),
      );
      expect(mocks.create.mock.calls[0][0].system).toBe('SYS');
    });

    it('merges extraBody into the request params', async () => {
      await new AnthropicAdapter(
        makePreset({ extraBody: { top_k: 5, metadata: { user_id: 'u1' } } }),
      ).complete('SYS', messages, opts());
      const params = mocks.create.mock.calls[0][0];
      expect(params.top_k).toBe(5);
      expect(params.metadata).toEqual({ user_id: 'u1' });
      expect(params.model).toBe('claude-haiku-4-5-20251001');
    });
  });

  describe('client construction', () => {
    it('constructs the SDK client with the resolved key and no extras by default', async () => {
      await new AnthropicAdapter(makePreset()).complete('SYS', messages, opts());
      expect(mocks.ctor).toHaveBeenCalledWith({ apiKey: 'sk-ant-test' });
    });

    it('passes baseUrl and extraHeaders to the SDK client', async () => {
      await new AnthropicAdapter(
        makePreset({
          baseUrl: 'https://proxy.example/anthropic',
          extraHeaders: { 'anthropic-beta': 'foo-2025' },
        }),
      ).complete('SYS', messages, opts());
      expect(mocks.ctor).toHaveBeenCalledWith({
        apiKey: 'sk-ant-test',
        baseURL: 'https://proxy.example/anthropic',
        defaultHeaders: { 'anthropic-beta': 'foo-2025' },
      });
    });

    it('reuses the client across requests until disposed', async () => {
      const adapter = new AnthropicAdapter(makePreset());
      await adapter.complete('SYS', messages, opts());
      await adapter.complete('SYS', messages, opts());
      expect(mocks.ctor).toHaveBeenCalledTimes(1);

      adapter.dispose();
      await adapter.complete('SYS', messages, opts());
      expect(mocks.ctor).toHaveBeenCalledTimes(2);
    });

    it('rebuilds the client when the resolved key changes (a replaced bad key takes effect)', async () => {
      const adapter = new AnthropicAdapter(makePreset());
      mocks.resolveApiKey.mockReturnValue('sk-ant-bad');
      await adapter.complete('SYS', messages, opts());
      mocks.resolveApiKey.mockReturnValue('sk-ant-good');
      await adapter.complete('SYS', messages, opts());
      await adapter.complete('SYS', messages, opts());
      expect(mocks.ctor).toHaveBeenCalledTimes(2);
      expect((mocks.ctor.mock.calls[0][0] as { apiKey: string }).apiKey).toBe('sk-ant-bad');
      expect((mocks.ctor.mock.calls[1][0] as { apiKey: string }).apiKey).toBe('sk-ant-good');
      expect(mocks.create).toHaveBeenCalledTimes(3);
    });

    it('a key removed after a client was built throws "not found" instead of using the old client', async () => {
      const adapter = new AnthropicAdapter(makePreset());
      await adapter.complete('SYS', messages, opts());
      mocks.resolveApiKey.mockReturnValue(undefined);
      await expect(adapter.complete('SYS', messages, opts())).rejects.toThrow(
        /API key not found for ANTHROPIC_API_KEY/,
      );
      expect(mocks.create).toHaveBeenCalledTimes(1);
    });

    it('throws a descriptive error before building a client when the key is missing', async () => {
      mocks.resolveApiKey.mockReturnValue(undefined);
      await expect(
        new AnthropicAdapter(makePreset()).complete('SYS', messages, opts()),
      ).rejects.toThrow(/API key not found for ANTHROPIC_API_KEY/);
      expect(mocks.ctor).not.toHaveBeenCalled();
      expect(mocks.create).not.toHaveBeenCalled();
    });
  });

  describe('response parsing', () => {
    it('joins text blocks, ignores non-text blocks, and reports usage including cache reads', async () => {
      mocks.create.mockResolvedValue(
        makeResponse({
          content: [
            { type: 'thinking', text: 'hmm' },
            { type: 'text', text: 'Hello' },
            { type: 'text', text: ' world' },
          ],
          model: 'claude-haiku-4-5-20251001-served',
        }),
      );
      const result = await new AnthropicAdapter(makePreset()).complete('SYS', messages, opts());

      expect(result.text).toBe('Hello world');
      // Anthropic's input_tokens already excludes cached tokens — passed through as-is.
      expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 8, cacheReadTokens: 900 });
      expect(result.model).toBe('claude-haiku-4-5-20251001-served');
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(result.aborted).toBeUndefined();
    });

    it('returns null text when there are no text blocks', async () => {
      mocks.create.mockResolvedValue(makeResponse({ content: [] }));
      const result = await new AnthropicAdapter(makePreset()).complete('SYS', messages, opts());
      expect(result.text).toBeNull();
    });

    it('defaults usage to zero and model to the preset when the response omits them', async () => {
      mocks.create.mockResolvedValue({ content: [{ type: 'text', text: 'x' }] });
      const result = await new AnthropicAdapter(makePreset()).complete('SYS', messages, opts());
      expect(result.usage).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: undefined,
      });
      expect(result.model).toBe('claude-haiku-4-5-20251001');
    });
  });

  describe('error handling', () => {
    it('returns an aborted result (does not throw) on AbortError', async () => {
      const abort = new Error('The operation was aborted');
      abort.name = 'AbortError';
      mocks.create.mockRejectedValue(abort);
      const result = await new AnthropicAdapter(makePreset()).complete('SYS', messages, opts());
      expect(result).toMatchObject({ text: null, aborted: true });
    });

    it('treats the SDK "Request was aborted." error as an abort when our signal was aborted', async () => {
      // The SDK throws APIUserAbortError (no AbortError name) only after checking
      // signal.aborted, so the signal is what identifies it.
      const ac = new AbortController();
      ac.abort();
      mocks.create.mockRejectedValue(new Error('Request was aborted.'));
      const result = await new AnthropicAdapter(makePreset()).complete(
        'SYS',
        messages,
        opts({ signal: ac.signal }),
      );
      expect(result.aborted).toBe(true);
    });

    it('does not treat a server error mentioning "aborted" as an abort', async () => {
      const err = Object.assign(new Error('400 Upstream request was aborted by provider'), {
        status: 400,
      });
      mocks.create.mockRejectedValue(err);
      await expect(
        new AnthropicAdapter(makePreset()).complete('SYS', messages, opts()),
      ).rejects.toBe(err);
    });

    it.each([429, 529])('returns a silent null (not aborted) on HTTP %i', async (status) => {
      mocks.create.mockRejectedValue(Object.assign(new Error('overloaded'), { status }));
      const result = await new AnthropicAdapter(makePreset()).complete('SYS', messages, opts());
      expect(result.text).toBeNull();
      expect(result.aborted).toBeUndefined();
      // The status survives as errorType so the null is attributable (trace / quality runner).
      expect(result.errorType).toBe(String(status));
    });

    it('rewrites 401 into an error naming the key variable', async () => {
      mocks.create.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
      await expect(
        new AnthropicAdapter(makePreset({ apiKeyEnvVar: 'MY_ANTHROPIC_KEY' })).complete(
          'SYS',
          messages,
          opts(),
        ),
      ).rejects.toThrow(/Anthropic API key invalid or missing\. Check MY_ANTHROPIC_KEY/);
    });

    it('rethrows other errors unchanged', async () => {
      const err = Object.assign(new Error('server error'), { status: 500 });
      mocks.create.mockRejectedValue(err);
      await expect(
        new AnthropicAdapter(makePreset()).complete('SYS', messages, opts()),
      ).rejects.toBe(err);
    });
  });
});
