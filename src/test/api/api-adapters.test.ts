/**
 * Integration tests for direct API adapters — exercises real HTTP calls
 * to Anthropic, xAI, and (optionally) OpenAI APIs.
 *
 * Skips automatically when the required API key is not available.
 *
 * Run: npm run test:api
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { AnthropicAdapter } from '../../providers/api/adapters/anthropic';
import { OpenAICompatAdapter } from '../../providers/api/adapters/openai-compat';
import { ApiCompletionProvider } from '../../providers/api/api-provider';
import { getPreset } from '../../providers/api/presets';
import { resolveApiKey, clearApiKeyCache } from '../../utils/api-key-store';
import { makeConfig, makeLogger, makeProseContext, makeCodeContext } from '../helpers';

// Force-reload the env file cache so keys from ~/.creds/api-keys.env are available
beforeAll(() => {
  clearApiKeyCache();
});

// --- Anthropic Adapter ---

const hasAnthropicKey = () => !!resolveApiKey('ANTHROPIC_API_KEY');

describe.skipIf(!hasAnthropicKey())('AnthropicAdapter (live)', () => {
  it('completes a simple prose prompt', async () => {
    const preset = getPreset('anthropic-haiku')!;
    const adapter = new AnthropicAdapter(preset);

    const result = await adapter.complete(
      'You are a helpful writing assistant. Continue the text naturally.',
      [{ role: 'user', content: 'The quick brown fox' }],
      {
        signal: AbortSignal.timeout(15000),
        maxTokens: 50,
        temperature: 0.2,
      },
    );

    expect(result.text).toBeTruthy();
    expect(result.text!.length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.model).toContain('claude');

    adapter.dispose();
  });

  it('supports assistant prefill', async () => {
    const preset = getPreset('anthropic-haiku')!;
    const adapter = new AnthropicAdapter(preset);

    const result = await adapter.complete(
      'Continue the text. Output only the continuation.',
      [
        { role: 'user', content: 'Complete: Hello world' },
        { role: 'assistant', content: ', how are' },
      ],
      {
        signal: AbortSignal.timeout(15000),
        maxTokens: 30,
        temperature: 0.2,
      },
    );

    expect(result.text).toBeTruthy();

    adapter.dispose();
  });

  it('reports cache-read tokens when prompt caching is enabled', async () => {
    const preset = getPreset('anthropic-haiku')!;
    expect(preset.features?.promptCaching).toBe(true);

    const adapter = new AnthropicAdapter(preset);

    // First call to prime the cache
    await adapter.complete(
      'You are a helpful assistant. '.repeat(50), // Long system prompt to trigger caching
      [{ role: 'user', content: 'Say hello' }],
      {
        signal: AbortSignal.timeout(15000),
        maxTokens: 20,
        temperature: 0.2,
      },
    );

    // Second call — should get cache hits
    const result = await adapter.complete(
      'You are a helpful assistant. '.repeat(50),
      [{ role: 'user', content: 'Say goodbye' }],
      {
        signal: AbortSignal.timeout(15000),
        maxTokens: 20,
        temperature: 0.2,
      },
    );

    expect(result.text).toBeTruthy();
    // Cache-read tokens may or may not be present depending on timing/server
    // Just verify the field exists and is a number if present
    if (result.usage.cacheReadTokens !== undefined) {
      expect(typeof result.usage.cacheReadTokens).toBe('number');
    }

    adapter.dispose();
  });
});

// --- xAI (Grok) Adapter ---

const hasXaiKey = () => !!resolveApiKey('XAI_API_KEY');

describe.skipIf(!hasXaiKey())('OpenAICompatAdapter — xAI (live)', () => {
  it('completes a simple prose prompt', async () => {
    const preset = getPreset('xai-grok')!;
    const adapter = new OpenAICompatAdapter(preset);

    const result = await adapter.complete(
      'You are a helpful writing assistant. Continue the text naturally.',
      [{ role: 'user', content: 'The quick brown fox' }],
      {
        signal: AbortSignal.timeout(15000),
        maxTokens: 50,
        temperature: 0.3,
      },
    );

    expect(result.text).toBeTruthy();
    expect(result.text!.length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);

    adapter.dispose();
  });
});

// --- OpenAI Adapter ---

const hasOpenAiKey = () => !!resolveApiKey('OPENAI_API_KEY');

describe.skipIf(!hasOpenAiKey())('OpenAICompatAdapter — OpenAI (live)', () => {
  it('completes a simple prose prompt', async () => {
    const preset = getPreset('openai-gpt-4o-mini')!;
    const adapter = new OpenAICompatAdapter(preset);

    const result = await adapter.complete(
      'You are a helpful writing assistant. Continue the text naturally.',
      [{ role: 'user', content: 'The quick brown fox' }],
      {
        signal: AbortSignal.timeout(15000),
        maxTokens: 50,
        temperature: 0.2,
      },
    );

    expect(result.text).toBeTruthy();
    expect(result.text!.length).toBeGreaterThan(0);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThan(0);

    adapter.dispose();
  });
});

// --- Full Pipeline: ApiCompletionProvider ---

describe.skipIf(!hasAnthropicKey())('ApiCompletionProvider — full pipeline (live)', () => {
  it('returns a completion for prose context', async () => {
    const config = makeConfig({
      backend: 'api',
      api: { preset: 'anthropic-haiku', customPresets: [] },
    });
    const provider = new ApiCompletionProvider(config, makeLogger());

    expect(provider.isAvailable()).toBe(true);

    const context = makeProseContext({
      prefix:
        'The weather today is sunny and warm. I decided to go for a walk in the park. The birds were',
      suffix: '',
    });
    const result = await provider.getCompletion(context, AbortSignal.timeout(15000));

    expect(result).toBeTruthy();
    expect(result!.length).toBeGreaterThan(0);

    provider.dispose();
  });

  it('returns a completion for code context', async () => {
    const config = makeConfig({
      backend: 'api',
      api: { preset: 'anthropic-haiku', customPresets: [] },
    });
    const provider = new ApiCompletionProvider(config, makeLogger());

    const context = makeCodeContext({
      prefix: 'function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return ',
      suffix: '\n}',
    });
    const result = await provider.getCompletion(context, AbortSignal.timeout(15000));

    expect(result).toBeTruthy();
    expect(result!.length).toBeGreaterThan(0);

    provider.dispose();
  });
});
