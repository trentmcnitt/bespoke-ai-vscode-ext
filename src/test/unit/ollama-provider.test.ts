import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaProvider } from '../../providers/ollama';
import { makeConfig, makeProseContext, makeCodeContext, makeLogger } from '../helpers';

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeOllamaResponse(text: string) {
  return new Response(JSON.stringify({ response: text, done: true }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('OllamaProvider', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('availability', () => {
    it('always reports available (checked at request time)', () => {
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      expect(provider.isAvailable()).toBe(true);
    });
  });

  describe('prose completion (raw mode)', () => {
    it('returns text from API response', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse(' something profound'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBe(' something profound');
    });

    it('sends raw=true for prose mode', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('text'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.raw).toBe(true);
    });

    it('sends formatted userMessage as prompt in raw mode', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('text'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      const ctx = makeProseContext({ prefix: 'Hello world' });
      await provider.getCompletion(ctx, new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // In raw mode, prompt is the formatted userMessage from PromptBuilder, not raw prefix
      expect(body.prompt).toBe('Hello world');
    });

    it('does not send system or suffix in raw mode', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('text'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.system).toBeUndefined();
      expect(body.suffix).toBeUndefined();
    });
  });

  describe('code FIM completion (non-raw mode)', () => {
    it('uses raw=false for code with suffix (FIM)', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('a + b;'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      await provider.getCompletion(makeCodeContext(), new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.raw).toBeUndefined();
    });

    it('sends raw prefix as prompt for FIM (not formatted userMessage)', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('a + b;'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      const ctx = makeCodeContext({ prefix: 'function add() {\n  return ' });
      await provider.getCompletion(ctx, new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      // FIM mode sends context.prefix directly, not the formatted prompt
      expect(body.prompt).toBe('function add() {\n  return ');
    });

    it('sends suffix param for native FIM', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('a + b;'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      await provider.getCompletion(makeCodeContext(), new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.suffix).toBe('\n}');
    });

    it('sends system prompt in non-raw mode', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('a + b;'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      await provider.getCompletion(makeCodeContext(), new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.system).toBeDefined();
      expect(body.system).toContain('Complete the code at the cursor position');
    });

    it('falls back to raw mode for code without suffix', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('// comment'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      const ctx = makeCodeContext({ suffix: '' });
      await provider.getCompletion(ctx, new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.raw).toBe(true);
      expect(body.suffix).toBeUndefined();
    });
  });

  describe('request parameters', () => {
    it('sends model from config', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('text'));
      const config = makeConfig();
      config.ollama.model = 'llama3:8b';
      const provider = new OllamaProvider(config, makeLogger());
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('llama3:8b');
    });

    it('sends keep_alive for model persistence', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('text'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.keep_alive).toBe('30m');
    });

    it('sends stream=false', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('text'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.stream).toBe(false);
    });

    it('sends options with num_predict, temperature, stop', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('text'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.options.num_predict).toBe(100); // prose maxTokens
      expect(body.options.temperature).toBe(0.7); // prose temp
      expect(body.options.stop).toEqual(['---', '##']); // prose stops
    });

    it('strips trailing slash from endpoint', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('text'));
      const config = makeConfig();
      config.ollama.endpoint = 'http://localhost:11434/';
      const provider = new OllamaProvider(config, makeLogger());
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const url = mockFetch.mock.calls[0][0];
      expect(url).toBe('http://localhost:11434/api/generate');
    });
  });

  describe('post-processing', () => {
    it('passes through markdown code fences from response', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('```python\nreturn x + 1\n```'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      const result = await provider.getCompletion(makeCodeContext(), new AbortController().signal);
      expect(result).toBe('```python\nreturn x + 1\n```');
    });

    it('preserves leading \\n\\n as structural spacing', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('\n\nhello world'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      // Leading \n\n is structural spacing, not a content boundary
      expect(result).toBe('\n\nhello world');
    });

    it('returns null when response is only newlines', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('\n\n'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });
  });

  describe('error handling', () => {
    it('returns null on abort', async () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      mockFetch.mockRejectedValue(err);
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });

    it('throws on non-200 response', async () => {
      mockFetch.mockResolvedValue(new Response('Not Found', { status: 404 }));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      await expect(
        provider.getCompletion(makeProseContext(), new AbortController().signal),
      ).rejects.toThrow('Ollama returned 404');
    });

    it('throws on network error', async () => {
      mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      await expect(
        provider.getCompletion(makeProseContext(), new AbortController().signal),
      ).rejects.toThrow('ECONNREFUSED');
    });

    it('returns null when response is empty string', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse(''));
      const provider = new OllamaProvider(makeConfig(), makeLogger());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });
  });

  describe('config updates', () => {
    it('uses new config after updateConfig', async () => {
      mockFetch.mockResolvedValue(makeOllamaResponse('text'));
      const provider = new OllamaProvider(makeConfig(), makeLogger());

      const newConfig = makeConfig();
      newConfig.ollama.model = 'codellama:7b';
      provider.updateConfig(newConfig);
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.model).toBe('codellama:7b');
    });
  });
});
