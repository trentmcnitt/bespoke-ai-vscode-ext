import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnthropicProvider } from '../../providers/anthropic';
import { makeConfig, makeProseContext, makeCodeContext } from '../helpers';

// Shared mock state — hoisted vi.fn() so vi.mock factory can reference it
const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  // Simulate SDK error classes
  class APIError extends Error { constructor(m: string) { super(m); this.name = 'APIError'; } }
  class APIUserAbortError extends APIError { constructor() { super('Request aborted'); this.name = 'APIUserAbortError'; } }
  class RateLimitError extends APIError { constructor() { super('Rate limited'); this.name = 'RateLimitError'; } }
  class AuthenticationError extends APIError { constructor() { super('Auth failed'); this.name = 'AuthenticationError'; } }

  // Must be a real class so `new Anthropic(...)` works
  class MockAnthropic {
    messages = { create: mockCreate };
    constructor(_opts?: Record<string, unknown>) { /* noop */ }
    static APIError = APIError;
    static APIUserAbortError = APIUserAbortError;
    static RateLimitError = RateLimitError;
    static AuthenticationError = AuthenticationError;
  }

  return { default: MockAnthropic };
});

function makeApiResponse(text: string) {
  return { content: [{ type: 'text', text }] };
}

describe('AnthropicProvider', () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  describe('initialization', () => {
    it('is available when API key is set', () => {
      const provider = new AnthropicProvider(makeConfig());
      expect(provider.isAvailable()).toBe(true);
    });

    it('is not available when API key is empty', () => {
      const provider = new AnthropicProvider(makeConfig({ anthropic: { apiKey: '', model: 'test', useCaching: false } }));
      expect(provider.isAvailable()).toBe(false);
    });

    it('returns null when not available', async () => {
      const provider = new AnthropicProvider(makeConfig({ anthropic: { apiKey: '', model: 'test', useCaching: false } }));
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });
  });

  describe('prose completion', () => {
    it('returns text from API response', async () => {
      mockCreate.mockResolvedValue(makeApiResponse(' ran into the woods.'));
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBe(' ran into the woods.');
    });

    it('sends assistant prefill for prose mode', async () => {
      mockCreate.mockResolvedValue(makeApiResponse(' continued writing.'));
      const provider = new AnthropicProvider(makeConfig());
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const [params] = mockCreate.mock.calls[0];
      const messages = params.messages;
      expect(messages).toHaveLength(2);
      expect(messages[1].role).toBe('assistant');
      // Prefill should be last 4 words of prefix
      expect(messages[1].content).toBe('lazy dog and then');
    });

    it('filters whitespace-only stop sequences', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('some text'));
      const provider = new AnthropicProvider(makeConfig());
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const [params] = mockCreate.mock.calls[0];
      // \n\n should be filtered out, --- and ## should remain
      expect(params.stop_sequences).toEqual(['---', '##']);
    });

    it('truncates result at \\n\\n when it was a configured stop sequence', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('first paragraph\n\nsecond paragraph'));
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBe('first paragraph');
    });

    it('does not truncate at \\n\\n when not in stop sequences', async () => {
      const config = makeConfig();
      config.prose.stopSequences = ['---'];
      mockCreate.mockResolvedValue(makeApiResponse('first\n\nsecond'));
      const provider = new AnthropicProvider(config);
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBe('first\n\nsecond');
    });
  });

  describe('code completion', () => {
    it('returns code from API response', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('a + b;'));
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeCodeContext(), new AbortController().signal);
      expect(result).toBe('a + b;');
    });

    it('does not send assistant prefill for code mode', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('a + b;'));
      const provider = new AnthropicProvider(makeConfig());
      await provider.getCompletion(makeCodeContext(), new AbortController().signal);

      const [params] = mockCreate.mock.calls[0];
      expect(params.messages).toHaveLength(1);
      expect(params.messages[0].role).toBe('user');
    });

    it('strips markdown code fences from response', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('```typescript\nreturn a + b;\n```'));
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeCodeContext(), new AbortController().signal);
      expect(result).toBe('return a + b;');
    });

    it('strips markdown fences with no language tag', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('```\nreturn a + b;\n```'));
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeCodeContext(), new AbortController().signal);
      expect(result).toBe('return a + b;');
    });
  });

  describe('post-processing', () => {
    it('strips leading newlines from completions', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('\n\nactual text here'));
      const provider = new AnthropicProvider(makeConfig());
      const config = makeConfig();
      config.prose.stopSequences = ['---']; // no \n\n stop sequence
      provider.updateConfig(config);
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBe('actual text here');
    });

    it('returns null when completion is only newlines', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('\n\n\n'));
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });

    it('handles leading newlines before \\n\\n truncation', async () => {
      // Previously this would truncate at position 0 and return ''
      mockCreate.mockResolvedValue(makeApiResponse('\n\nfirst paragraph\n\nsecond'));
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBe('first paragraph');
    });

    it('returns null for empty string after all post-processing', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('```\n\n```'));
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });
  });

  describe('prompt caching', () => {
    it('adds cache_control to system when caching enabled', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('text'));
      const config = makeConfig({ anthropic: { apiKey: 'test-key', model: 'test', useCaching: true } });
      const provider = new AnthropicProvider(config);
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const [params] = mockCreate.mock.calls[0];
      expect(params.system[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('does not add cache_control when caching disabled', async () => {
      mockCreate.mockResolvedValue(makeApiResponse('text'));
      const provider = new AnthropicProvider(makeConfig());
      await provider.getCompletion(makeProseContext(), new AbortController().signal);

      const [params] = mockCreate.mock.calls[0];
      expect(params.system[0].cache_control).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('returns null on abort', async () => {
      const { default: Anthropic } = await import('@anthropic-ai/sdk') as unknown as { default: { APIUserAbortError: new () => Error } };
      mockCreate.mockRejectedValue(new Anthropic.APIUserAbortError());
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });

    it('returns null on generic AbortError', async () => {
      const err = new Error('Aborted');
      err.name = 'AbortError';
      mockCreate.mockRejectedValue(err);
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });

    it('returns null on API error and logs it', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      mockCreate.mockRejectedValue(new Error('API broke'));
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
      expect(spy).toHaveBeenCalledWith('[AI Prose] Anthropic API error:', expect.any(Error));
      spy.mockRestore();
    });

    it('returns null when response has no text block', async () => {
      mockCreate.mockResolvedValue({ content: [] });
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      expect(result).toBeNull();
    });

    it('returns null when response text is empty', async () => {
      mockCreate.mockResolvedValue(makeApiResponse(''));
      const provider = new AnthropicProvider(makeConfig());
      const result = await provider.getCompletion(makeProseContext(), new AbortController().signal);
      // getCompletion post-processes via callApi which returns block.text (''),
      // then the \n\n check runs on '', and '' is returned.
      // But the outer getCompletion gets '' from callApi — which is falsy, so
      // `if (!result) { return null; }` kicks in.
      expect(result).toBeNull();
    });
  });

  describe('config updates', () => {
    it('reinitializes client on updateConfig', async () => {
      const provider = new AnthropicProvider(makeConfig({ anthropic: { apiKey: '', model: 'test', useCaching: false } }));
      expect(provider.isAvailable()).toBe(false);

      provider.updateConfig(makeConfig({ anthropic: { apiKey: 'new-key', model: 'test', useCaching: false } }));
      expect(provider.isAvailable()).toBe(true);
    });
  });
});
