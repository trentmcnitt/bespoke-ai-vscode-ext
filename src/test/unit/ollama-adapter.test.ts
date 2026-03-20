import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaAdapter } from '../../providers/api/adapters/ollama';
import { Preset } from '../../providers/api/types';

function makePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    id: 'ollama-test',
    displayName: 'Test Ollama',
    provider: 'ollama',
    modelId: 'qwen3.5:9b',
    baseUrl: 'http://localhost:11434',
    maxTokens: 200,
    temperature: 0.2,
    promptStrategy: 'instruction-extraction',
    ...overrides,
  };
}

function makeOllamaResponse(overrides: Record<string, unknown> = {}) {
  return {
    model: 'qwen3.5:9b',
    message: { role: 'assistant', content: 'Hello world' },
    done: true,
    done_reason: 'stop',
    prompt_eval_count: 42,
    eval_count: 10,
    ...overrides,
  };
}

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

const defaultOptions = {
  signal: AbortSignal.timeout(5000),
  maxTokens: 200,
  temperature: 0.2,
};

describe('OllamaAdapter', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('isConfigured', () => {
    it('always returns true', () => {
      const adapter = new OllamaAdapter(makePreset());
      expect(adapter.isConfigured()).toBe(true);
      adapter.dispose();
    });
  });

  describe('URL construction', () => {
    it('uses baseUrl + /api/chat', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset({ baseUrl: 'http://localhost:11434' }));
      await adapter.complete('system', [{ role: 'user', content: 'hi' }], defaultOptions);

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/chat', expect.anything());
    });

    it('strips /v1 suffix for backward compat', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset({ baseUrl: 'http://localhost:11434/v1' }));
      await adapter.complete('system', [{ role: 'user', content: 'hi' }], defaultOptions);

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/chat', expect.anything());
    });

    it('strips trailing slash', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset({ baseUrl: 'http://localhost:11434/' }));
      await adapter.complete('system', [{ role: 'user', content: 'hi' }], defaultOptions);

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/chat', expect.anything());
    });

    it('defaults to localhost:11434 when no baseUrl', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset({ baseUrl: undefined }));
      await adapter.complete('system', [{ role: 'user', content: 'hi' }], defaultOptions);

      expect(fetchMock).toHaveBeenCalledWith('http://localhost:11434/api/chat', expect.anything());
    });

    it('supports custom host', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset({ baseUrl: 'http://gpu-server:11434' }));
      await adapter.complete('system', [{ role: 'user', content: 'hi' }], defaultOptions);

      expect(fetchMock).toHaveBeenCalledWith('http://gpu-server:11434/api/chat', expect.anything());
    });
  });

  describe('request body', () => {
    it('sends think:false and stream:false', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset());
      await adapter.complete('system prompt', [{ role: 'user', content: 'hi' }], defaultOptions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.think).toBe(false);
      expect(body.stream).toBe(false);
    });

    it('maps maxTokens to options.num_predict', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset());
      await adapter.complete('sys', [{ role: 'user', content: 'hi' }], {
        ...defaultOptions,
        maxTokens: 150,
        temperature: 0.5,
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.options.num_predict).toBe(150);
      expect(body.options.temperature).toBe(0.5);
    });

    it('maps stop sequences to options.stop', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset());
      await adapter.complete('sys', [{ role: 'user', content: 'hi' }], {
        ...defaultOptions,
        stopSequences: ['</s>', '\n\n'],
      });

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.options.stop).toEqual(['</s>', '\n\n']);
    });

    it('omits stop when no stop sequences', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset());
      await adapter.complete('sys', [{ role: 'user', content: 'hi' }], defaultOptions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.options.stop).toBeUndefined();
    });

    it('sends system prompt as first message', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset());
      await adapter.complete(
        'You are helpful.',
        [
          { role: 'user', content: 'question' },
          { role: 'assistant', content: 'answer' },
        ],
        defaultOptions,
      );

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.messages).toEqual([
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ]);
    });

    it('merges extraBody into request', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(
        makePreset({ extraBody: { keep_alive: '5m', num_ctx: 8192 } }),
      );
      await adapter.complete('sys', [{ role: 'user', content: 'hi' }], defaultOptions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.keep_alive).toBe('5m');
      expect(body.num_ctx).toBe(8192);
    });

    it('extraBody can override think', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset({ extraBody: { think: true } }));
      await adapter.complete('sys', [{ role: 'user', content: 'hi' }], defaultOptions);

      const body = JSON.parse(fetchMock.mock.calls[0][1].body);
      expect(body.think).toBe(true);
    });

    it('passes extraHeaders to fetch', async () => {
      const fetchMock = mockFetchOk(makeOllamaResponse());
      globalThis.fetch = fetchMock;

      const adapter = new OllamaAdapter(makePreset({ extraHeaders: { 'X-Custom': 'value' } }));
      await adapter.complete('sys', [{ role: 'user', content: 'hi' }], defaultOptions);

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['X-Custom']).toBe('value');
    });
  });

  describe('response mapping', () => {
    it('extracts text from message.content', async () => {
      globalThis.fetch = mockFetchOk(
        makeOllamaResponse({ message: { role: 'assistant', content: 'completion text' } }),
      );

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.text).toBe('completion text');
    });

    it('maps token counts from Ollama fields', async () => {
      globalThis.fetch = mockFetchOk(makeOllamaResponse({ prompt_eval_count: 55, eval_count: 23 }));

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.usage.inputTokens).toBe(55);
      expect(result.usage.outputTokens).toBe(23);
    });

    it('uses response model when available', async () => {
      globalThis.fetch = mockFetchOk(makeOllamaResponse({ model: 'qwen3.5:9b-fp16' }));

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.model).toBe('qwen3.5:9b-fp16');
    });

    it('falls back to preset model when response model missing', async () => {
      globalThis.fetch = mockFetchOk(makeOllamaResponse({ model: undefined }));

      const adapter = new OllamaAdapter(makePreset({ modelId: 'my-model' }));
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.model).toBe('my-model');
    });

    it('returns null when content is empty', async () => {
      globalThis.fetch = mockFetchOk(
        makeOllamaResponse({ message: { role: 'assistant', content: '' } }),
      );

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.text).toBeNull();
    });

    it('returns null when message is missing', async () => {
      globalThis.fetch = mockFetchOk(makeOllamaResponse({ message: undefined }));

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.text).toBeNull();
    });

    it('records positive durationMs', async () => {
      globalThis.fetch = mockFetchOk(makeOllamaResponse());

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('defaults token counts to 0 when missing', async () => {
      globalThis.fetch = mockFetchOk(
        makeOllamaResponse({ prompt_eval_count: undefined, eval_count: undefined }),
      );

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
    });
  });

  describe('error handling', () => {
    it('returns aborted on AbortError', async () => {
      const err = new DOMException('The operation was aborted', 'AbortError');
      globalThis.fetch = vi.fn().mockRejectedValue(err);

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.text).toBeNull();
      expect(result.aborted).toBe(true);
    });

    it('returns silent null on connection refused', async () => {
      const err = new TypeError('fetch failed');
      globalThis.fetch = vi.fn().mockRejectedValue(err);

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.text).toBeNull();
      expect(result.aborted).toBeUndefined();
    });

    it('returns silent null on ECONNREFUSED', async () => {
      const err = new Error('connect ECONNREFUSED 127.0.0.1:11434');
      globalThis.fetch = vi.fn().mockRejectedValue(err);

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.text).toBeNull();
      expect(result.aborted).toBeUndefined();
    });

    it('returns silent null on HTTP 429', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        statusText: 'Too Many Requests',
      });

      const adapter = new OllamaAdapter(makePreset());
      const result = await adapter.complete(
        'sys',
        [{ role: 'user', content: 'hi' }],
        defaultOptions,
      );

      expect(result.text).toBeNull();
      expect(result.aborted).toBeUndefined();
    });

    it('throws on HTTP 500', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });

      const adapter = new OllamaAdapter(makePreset());
      await expect(
        adapter.complete('sys', [{ role: 'user', content: 'hi' }], defaultOptions),
      ).rejects.toThrow('Ollama API error: 500 Internal Server Error');
    });

    it('throws on unknown errors', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('something unexpected'));

      const adapter = new OllamaAdapter(makePreset());
      await expect(
        adapter.complete('sys', [{ role: 'user', content: 'hi' }], defaultOptions),
      ).rejects.toThrow('something unexpected');
    });
  });

  describe('providerId', () => {
    it('is ollama', () => {
      const adapter = new OllamaAdapter(makePreset());
      expect(adapter.providerId).toBe('ollama');
    });
  });
});
