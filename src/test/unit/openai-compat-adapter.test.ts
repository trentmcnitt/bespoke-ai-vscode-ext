import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatAdapter } from '../../providers/api/adapters/openai-compat';
import { Preset } from '../../providers/api/types';

// Mock the SDK and key resolution. resolveApiKey must be mocked: unmocked it reads
// process.env and ~/.creds/api-keys.env, which makes results machine-dependent.
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  ctor: vi.fn(),
  resolveApiKey: vi.fn(),
}));

vi.mock('openai', () => ({
  default: class FakeOpenAI {
    chat = { completions: { create: mocks.create } };
    constructor(opts: unknown) {
      mocks.ctor(opts);
    }
  },
}));

vi.mock('../../utils/api-key-store', () => ({
  resolveApiKey: mocks.resolveApiKey,
}));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'openai-test',
    displayName: 'Test GPT',
    provider: 'openai',
    modelId: 'gpt-4.1-nano',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
    ...overrides,
  };
}

const xaiPreset = () =>
  makePreset({
    id: 'xai-test',
    provider: 'xai',
    modelId: 'grok-4-1-fast-non-reasoning',
    baseUrl: 'https://api.x.ai/v1',
    apiKeyEnvVar: 'XAI_API_KEY',
  });

const openrouterPreset = (overrides: Partial<Preset> = {}) =>
  makePreset({
    id: 'or-test',
    provider: 'openrouter',
    modelId: 'openai/gpt-4.1-nano',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKeyEnvVar: 'OPENROUTER_API_KEY',
    ...overrides,
  });

function makeResponse(overrides: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content: '<COMPLETION>hi</COMPLETION>' } }],
    usage: {
      prompt_tokens: 1000,
      completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 768 },
    },
    model: 'gpt-4.1-nano-2025-04-14',
    ...overrides,
  };
}

const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
  { role: 'user', content: '<document>...</document>' },
];

function opts(extra: Record<string, unknown> = {}) {
  return {
    signal: new AbortController().signal,
    maxTokens: 200,
    temperature: 0.2,
    ...extra,
  };
}

function ctorOpts(call = 0) {
  return mocks.ctor.mock.calls[call][0] as {
    apiKey: string;
    baseURL?: string;
    defaultHeaders?: Record<string, string>;
  };
}

describe('OpenAICompatAdapter', () => {
  beforeEach(() => {
    mocks.create.mockReset();
    mocks.ctor.mockReset();
    mocks.resolveApiKey.mockReset();
    mocks.resolveApiKey.mockReturnValue('sk-test');
    mocks.create.mockResolvedValue(makeResponse());
  });

  it('exposes the preset provider as providerId', () => {
    expect(new OpenAICompatAdapter(xaiPreset()).providerId).toBe('xai');
  });

  describe('isConfigured', () => {
    it('reflects whether the preset key resolves', () => {
      expect(new OpenAICompatAdapter(makePreset()).isConfigured()).toBe(true);
      expect(mocks.resolveApiKey).toHaveBeenCalledWith('OPENAI_API_KEY');
      mocks.resolveApiKey.mockReturnValue(undefined);
      expect(new OpenAICompatAdapter(makePreset()).isConfigured()).toBe(false);
    });

    it('is false when the preset names no key variable', () => {
      expect(new OpenAICompatAdapter(makePreset({ apiKeyEnvVar: undefined })).isConfigured()).toBe(
        false,
      );
    });
  });

  describe('request shape', () => {
    it('prepends the system prompt as a system message and maps options to OpenAI params', async () => {
      const signal = new AbortController().signal;
      await new OpenAICompatAdapter(makePreset()).complete('SYS', messages, {
        signal,
        maxTokens: 123,
        temperature: 0.7,
        stopSequences: ['</COMPLETION>'],
      });

      const [params, requestOpts] = mocks.create.mock.calls[0];
      expect(params).toEqual({
        model: 'gpt-4.1-nano',
        messages: [
          { role: 'system', content: 'SYS' },
          { role: 'user', content: '<document>...</document>' },
        ],
        max_tokens: 123,
        temperature: 0.7,
        stop: ['</COMPLETION>'],
      });
      expect(requestOpts).toEqual({ signal });
    });

    it('forwards an assistant prefill message in order', async () => {
      await new OpenAICompatAdapter(openrouterPreset()).complete(
        'SYS',
        [...messages, { role: 'assistant', content: '<COMPLETION>The fox' }],
        opts(),
      );
      const sent = mocks.create.mock.calls[0][0].messages;
      expect(sent.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant']);
      expect(sent[2].content).toBe('<COMPLETION>The fox');
    });

    it('merges extraBody into the request params', async () => {
      await new OpenAICompatAdapter(
        openrouterPreset({ extraBody: { reasoning: { enabled: false }, transforms: [] } }),
      ).complete('SYS', messages, opts());
      const params = mocks.create.mock.calls[0][0];
      expect(params.reasoning).toEqual({ enabled: false });
      expect(params.transforms).toEqual([]);
    });
  });

  describe('client headers', () => {
    it('plain OpenAI: no defaultHeaders key at all', async () => {
      await new OpenAICompatAdapter(makePreset()).complete('SYS', messages, opts());
      expect(ctorOpts()).toEqual({ apiKey: 'sk-test', baseURL: undefined });
      expect('defaultHeaders' in ctorOpts()).toBe(false);
    });

    it('xAI: sends a UUID x-grok-conv-id and the configured baseURL', async () => {
      await new OpenAICompatAdapter(xaiPreset()).complete('SYS', messages, opts());
      expect(ctorOpts().baseURL).toBe('https://api.x.ai/v1');
      expect(ctorOpts().defaultHeaders?.['x-grok-conv-id']).toMatch(UUID_RE);
    });

    it('xAI: conv id is stable for the adapter lifetime (survives dispose) but differs per adapter', async () => {
      const a = new OpenAICompatAdapter(xaiPreset());
      await a.complete('SYS', messages, opts());
      a.dispose();
      await a.complete('SYS', messages, opts());
      const b = new OpenAICompatAdapter(xaiPreset());
      await b.complete('SYS', messages, opts());

      const id0 = ctorOpts(0).defaultHeaders?.['x-grok-conv-id'];
      const id1 = ctorOpts(1).defaultHeaders?.['x-grok-conv-id'];
      const id2 = ctorOpts(2).defaultHeaders?.['x-grok-conv-id'];
      expect(id1).toBe(id0);
      expect(id2).not.toBe(id0);
    });

    it('OpenRouter: sends attribution headers and no xAI header', async () => {
      await new OpenAICompatAdapter(openrouterPreset()).complete('SYS', messages, opts());
      expect(ctorOpts().defaultHeaders).toEqual({
        'HTTP-Referer': 'https://github.com/trentmcnitt/bespoke-ai-vscode-ext',
        'X-OpenRouter-Title': 'Bespoke AI',
      });
    });

    it('extraHeaders are merged and can override provider defaults', async () => {
      await new OpenAICompatAdapter(
        openrouterPreset({ extraHeaders: { 'X-OpenRouter-Title': 'Custom', 'X-Extra': '1' } }),
      ).complete('SYS', messages, opts());
      expect(ctorOpts().defaultHeaders).toEqual({
        'HTTP-Referer': 'https://github.com/trentmcnitt/bespoke-ai-vscode-ext',
        'X-OpenRouter-Title': 'Custom',
        'X-Extra': '1',
      });
    });

    it('extraHeaders alone produce defaultHeaders for a plain provider', async () => {
      await new OpenAICompatAdapter(
        makePreset({ provider: 'google', extraHeaders: { 'X-Goog': 'y' } }),
      ).complete('SYS', messages, opts());
      expect(ctorOpts().defaultHeaders).toEqual({ 'X-Goog': 'y' });
    });

    it('reuses the client across requests until disposed', async () => {
      const adapter = new OpenAICompatAdapter(makePreset());
      await adapter.complete('SYS', messages, opts());
      await adapter.complete('SYS', messages, opts());
      expect(mocks.ctor).toHaveBeenCalledTimes(1);
      adapter.dispose();
      await adapter.complete('SYS', messages, opts());
      expect(mocks.ctor).toHaveBeenCalledTimes(2);
    });

    it('throws before constructing a client when the key is missing', async () => {
      mocks.resolveApiKey.mockReturnValue(undefined);
      await expect(
        new OpenAICompatAdapter(xaiPreset()).complete('SYS', messages, opts()),
      ).rejects.toThrow(/API key not found for XAI_API_KEY/);
      expect(mocks.ctor).not.toHaveBeenCalled();
    });
  });

  describe('response parsing', () => {
    it('subtracts cached tokens from prompt_tokens so inputTokens means non-cached input', async () => {
      const result = await new OpenAICompatAdapter(makePreset()).complete('SYS', messages, opts());
      expect(result.text).toBe('<COMPLETION>hi</COMPLETION>');
      expect(result.usage).toEqual({ inputTokens: 232, outputTokens: 7, cacheReadTokens: 768 });
      expect(result.model).toBe('gpt-4.1-nano-2025-04-14');
    });

    it('reports cacheReadTokens as undefined when nothing was cached', async () => {
      mocks.create.mockResolvedValue(
        makeResponse({
          usage: {
            prompt_tokens: 500,
            completion_tokens: 3,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        }),
      );
      const result = await new OpenAICompatAdapter(makePreset()).complete('SYS', messages, opts());
      expect(result.usage).toEqual({
        inputTokens: 500,
        outputTokens: 3,
        cacheReadTokens: undefined,
      });
    });

    it('handles responses with no usage, choices, or model', async () => {
      mocks.create.mockResolvedValue({});
      const result = await new OpenAICompatAdapter(makePreset()).complete('SYS', messages, opts());
      expect(result.text).toBeNull();
      expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: undefined });
      expect(result.model).toBe('gpt-4.1-nano');
    });
  });

  describe('error handling', () => {
    it('returns an aborted result on AbortError', async () => {
      const abort = new Error('This operation was aborted');
      abort.name = 'AbortError';
      mocks.create.mockRejectedValue(abort);
      const result = await new OpenAICompatAdapter(makePreset()).complete('SYS', messages, opts());
      expect(result).toMatchObject({ text: null, aborted: true });
    });

    it('returns a silent null (not aborted) on HTTP 429', async () => {
      mocks.create.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 429 }));
      const result = await new OpenAICompatAdapter(makePreset()).complete('SYS', messages, opts());
      expect(result.text).toBeNull();
      expect(result.aborted).toBeUndefined();
    });

    it('rewrites 401 into an error naming the provider and key variable', async () => {
      mocks.create.mockRejectedValue(Object.assign(new Error('unauthorized'), { status: 401 }));
      await expect(
        new OpenAICompatAdapter(xaiPreset()).complete('SYS', messages, opts()),
      ).rejects.toThrow(/xai API key invalid or missing\. Check XAI_API_KEY/);
    });

    it('rethrows other errors unchanged (including 529, unlike the Anthropic adapter)', async () => {
      const err = Object.assign(new Error('overloaded'), { status: 529 });
      mocks.create.mockRejectedValue(err);
      await expect(
        new OpenAICompatAdapter(makePreset()).complete('SYS', messages, opts()),
      ).rejects.toBe(err);
    });
  });
});
