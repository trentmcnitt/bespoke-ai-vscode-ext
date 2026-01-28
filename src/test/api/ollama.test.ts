import { describe, it, expect } from 'vitest';
import { OllamaProvider } from '../../providers/ollama';
import { CompletionContext } from '../../types';
import { makeConfig } from '../helpers';

async function isOllamaReady(endpoint: string, model: string): Promise<boolean> {
  try {
    const response = await fetch(`${endpoint}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!response.ok) { return false; }
    const data = await response.json() as { models?: { name: string }[] };
    // Check if the required model is actually available
    return data.models?.some(m => m.name.startsWith(model)) ?? false;
  } catch {
    return false;
  }
}

function makeOllamaConfig() {
  const config = makeConfig();
  config.ollama.raw = true;
  config.prose.maxTokens = 30;
  config.code.maxTokens = 30;
  return config;
}

// Check once at describe time — skip if Ollama isn't running or model isn't pulled
const ollamaAvailable = await isOllamaReady('http://localhost:11434', 'qwen2.5:3b');

describe.skipIf(!ollamaAvailable)('Ollama API Integration', () => {
  it('returns a prose completion in raw mode', async () => {
    const provider = new OllamaProvider(makeOllamaConfig());

    const ctx: CompletionContext = {
      prefix: 'The meaning of life is',
      suffix: '',
      languageId: 'plaintext',
      fileName: 'thoughts.txt',
      mode: 'prose',
    };

    const ac = new AbortController();
    const result = await provider.getCompletion(ctx, ac.signal);

    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
    console.log('[Ollama prose]:', result);
  });

  it('returns a code completion in raw mode', async () => {
    const provider = new OllamaProvider(makeOllamaConfig());

    const ctx: CompletionContext = {
      prefix: 'def fibonacci(n):\n    if n <= 1:\n        return n\n    ',
      suffix: '',
      languageId: 'python',
      fileName: 'math.py',
      mode: 'code',
    };

    const ac = new AbortController();
    const result = await provider.getCompletion(ctx, ac.signal);

    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    console.log('[Ollama code]:', result);
  });

  it('returns null when signal is pre-aborted', async () => {
    const provider = new OllamaProvider(makeOllamaConfig());

    const ctx: CompletionContext = {
      prefix: 'Hello',
      suffix: '',
      languageId: 'markdown',
      fileName: 'test.md',
      mode: 'prose',
    };

    const ac = new AbortController();
    ac.abort();
    const result = await provider.getCompletion(ctx, ac.signal);
    expect(result).toBeNull();
  });

  it('handles invalid endpoint gracefully', async () => {
    const config = makeOllamaConfig();
    config.ollama.endpoint = 'http://localhost:19999';
    const provider = new OllamaProvider(config);

    const ctx: CompletionContext = {
      prefix: 'Hello',
      suffix: '',
      languageId: 'markdown',
      fileName: 'test.md',
      mode: 'prose',
    };

    const ac = new AbortController();
    const result = await provider.getCompletion(ctx, ac.signal);
    expect(result).toBeNull();
  });
});
