import { describe, it, expect, afterAll } from 'vitest';
import { AnthropicProvider } from '../../providers/anthropic';
import { CompletionContext } from '../../types';
import { makeConfig, makeLogger, loadApiKey } from '../helpers';
import {
  getApiRunDir,
  buildApiResult,
  saveApiResult,
  saveApiSummary,
  ApiResult,
} from './result-writer';

const apiKey = loadApiKey();
const hasApiKey = apiKey.length > 0;

function makeRealConfig() {
  const config = makeConfig();
  config.anthropic.apiKey = apiKey;
  config.anthropic.useCaching = false;
  config.prose.maxTokens = 30;
  config.code.maxTokens = 30;
  return config;
}

describe.skipIf(!hasApiKey)('Anthropic API Integration', () => {
  const runDir = getApiRunDir();
  const results: ApiResult[] = [];

  afterAll(() => {
    if (results.length > 0) {
      saveApiSummary(runDir, 'anthropic', {
        backend: 'anthropic',
        model: makeRealConfig().anthropic.model,
        totalTests: results.length,
        timestamp: new Date().toISOString(),
      });
    }
  });

  it('returns a prose completion', async () => {
    const provider = new AnthropicProvider(makeRealConfig(), makeLogger());
    expect(provider.isAvailable()).toBe(true);

    const ctx: CompletionContext = {
      prefix: 'Once upon a time, in a land far away, there lived a',
      suffix: '',
      languageId: 'markdown',
      fileName: 'story.md',
      filePath: '/test/story.md',
      mode: 'prose',
    };

    const start = Date.now();
    const ac = new AbortController();
    const result = await provider.getCompletion(ctx, ac.signal);
    const durationMs = Date.now() - start;

    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
    console.log('[Anthropic prose]:', result);

    const data = buildApiResult('prose', 'anthropic', ctx, result, durationMs);
    saveApiResult(runDir, 'anthropic', 'prose', data);
    results.push(data);
  });

  it('returns a code completion', async () => {
    const provider = new AnthropicProvider(makeRealConfig(), makeLogger());

    const ctx: CompletionContext = {
      prefix: 'function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  ',
      suffix: '\n}',
      languageId: 'typescript',
      fileName: 'math.ts',
      filePath: '/test/math.ts',
      mode: 'code',
    };

    const start = Date.now();
    const ac = new AbortController();
    const result = await provider.getCompletion(ctx, ac.signal);
    const durationMs = Date.now() - start;

    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    console.log('[Anthropic code]:', result);

    const data = buildApiResult('code', 'anthropic', ctx, result, durationMs);
    saveApiResult(runDir, 'anthropic', 'code', data);
    results.push(data);
  });

  it('returns null when signal is pre-aborted', async () => {
    const provider = new AnthropicProvider(makeRealConfig(), makeLogger());

    const ctx: CompletionContext = {
      prefix: 'Hello world',
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

  it('returns null when API key is invalid', async () => {
    const config = makeRealConfig();
    config.anthropic.apiKey = 'sk-ant-invalid-key';
    const provider = new AnthropicProvider(config, makeLogger());

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
