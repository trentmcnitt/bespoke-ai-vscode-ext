import { describe, it, expect, afterAll } from 'vitest';
import { OllamaProvider } from '../../providers/ollama';
import { CompletionContext } from '../../types';
import { makeConfig, makeLogger } from '../helpers';
import { getApiRunDir, buildApiResult, saveApiResult, saveApiSummary, ApiResult } from './result-writer';

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
  const runDir = getApiRunDir();
  const results: ApiResult[] = [];

  afterAll(() => {
    if (results.length > 0) {
      saveApiSummary(runDir, 'ollama', {
        backend: 'ollama',
        model: makeOllamaConfig().ollama.model,
        totalTests: results.length,
        timestamp: new Date().toISOString(),
      });
    }
  });

  it('returns a prose completion in raw mode', async () => {
    const provider = new OllamaProvider(makeOllamaConfig(), makeLogger());

    const ctx: CompletionContext = {
      prefix: 'The meaning of life is',
      suffix: '',
      languageId: 'plaintext',
      fileName: 'thoughts.txt',
      filePath: '/test/thoughts.txt',
      mode: 'prose',
    };

    const start = Date.now();
    const ac = new AbortController();
    const result = await provider.getCompletion(ctx, ac.signal);
    const durationMs = Date.now() - start;

    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
    console.log('[Ollama prose]:', result);

    const data = buildApiResult('prose', 'ollama', ctx, result, durationMs);
    saveApiResult(runDir, 'ollama', 'prose', data);
    results.push(data);
  });

  it('returns a code completion in raw mode', async () => {
    const provider = new OllamaProvider(makeOllamaConfig(), makeLogger());

    const ctx: CompletionContext = {
      prefix: 'def fibonacci(n):\n    if n <= 1:\n        return n\n    ',
      suffix: '',
      languageId: 'python',
      fileName: 'math.py',
      filePath: '/test/math.py',
      mode: 'code',
    };

    const start = Date.now();
    const ac = new AbortController();
    const result = await provider.getCompletion(ctx, ac.signal);
    const durationMs = Date.now() - start;

    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    console.log('[Ollama code]:', result);

    const data = buildApiResult('code', 'ollama', ctx, result, durationMs);
    saveApiResult(runDir, 'ollama', 'code', data);
    results.push(data);
  });

  it('returns null when signal is pre-aborted', async () => {
    const provider = new OllamaProvider(makeOllamaConfig(), makeLogger());

    const ctx: CompletionContext = {
      prefix: 'Hello',
      suffix: '',
      languageId: 'markdown',
      fileName: 'test.md',
      filePath: '/test/test.md',
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
    const provider = new OllamaProvider(config, makeLogger());

    const ctx: CompletionContext = {
      prefix: 'Hello',
      suffix: '',
      languageId: 'markdown',
      fileName: 'test.md',
      filePath: '/test/test.md',
      mode: 'prose',
    };

    const ac = new AbortController();
    const result = await provider.getCompletion(ctx, ac.signal);
    expect(result).toBeNull();
  });
});
