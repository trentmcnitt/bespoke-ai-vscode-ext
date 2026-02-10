/**
 * API Provider Integration Tests
 *
 * Tests real API calls to each provider. Uses describe.skipIf() to skip
 * when API keys aren't available. Each test records results and cost.
 *
 * Run: npm run test:api:providers
 */
import { describe, it, expect } from 'vitest';
import { ApiCompletionProvider } from '../../providers/api/api-provider';
import { resolveApiKey, clearApiKeyCache } from '../../utils/api-key-store';
import { makeConfig, makeLogger, makeProseContext, makeCodeContext, makeLedger } from '../helpers';

function hasKey(envVar: string): boolean {
  clearApiKeyCache();
  return !!resolveApiKey(envVar);
}

/**
 * Verify a Gemini API key actually works. The GOOGLE_API_KEY might be a GCP
 * key without Generative AI access, so we probe with a tiny request first.
 */
async function isGeminiAvailable(): Promise<boolean> {
  if (!hasKey('GOOGLE_API_KEY')) return false;
  try {
    const config = makeConfig({
      backend: 'api',
      api: { activePreset: 'gemini-flash', debounceMs: 400 },
    });
    const { ledger } = makeLedger();
    const provider = new ApiCompletionProvider(config, makeLogger(), ledger);
    const ctx = makeProseContext({ prefix: 'Hello ', suffix: '' });
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    return result !== null;
  } catch {
    return false;
  }
}

// Probe Gemini once at module load
const geminiAvailable = await isGeminiAvailable();

// ---------- Anthropic ----------
describe.skipIf(!hasKey('ANTHROPIC_API_KEY'))('Anthropic API', () => {
  const config = makeConfig({
    backend: 'api',
    api: { activePreset: 'anthropic-haiku-4-5', debounceMs: 400 },
  });
  const { ledger } = makeLedger();
  const provider = new ApiCompletionProvider(config, makeLogger(), ledger);

  it('completes prose', async () => {
    const ctx = makeProseContext({
      prefix:
        'The benefits of regular exercise include improved cardiovascular health, better sleep, and',
      suffix: '',
    });
    const start = Date.now();
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    const duration = Date.now() - start;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    // Should not have chatty preamble
    expect(result!.toLowerCase()).not.toMatch(/^(here|sure|got it|understood)/);
    console.log(`  Anthropic prose (${duration}ms): ${result!.slice(0, 100)}`);
  }, 15000);

  it('completes code', async () => {
    const ctx = makeCodeContext({
      prefix: 'function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return ',
      suffix: '\n}',
    });
    const start = Date.now();
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    const duration = Date.now() - start;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    console.log(`  Anthropic code (${duration}ms): ${result!.slice(0, 100)}`);
  }, 15000);

  it('bridges existing suffix', async () => {
    const ctx = makeProseContext({
      prefix: 'The project was completed ',
      suffix: ' the original deadline.',
    });
    const start = Date.now();
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    const duration = Date.now() - start;

    expect(result).not.toBeNull();
    // Should bridge (e.g., "ahead of", "before", "two weeks before")
    // Should NOT repeat "the original deadline"
    expect(result!).not.toContain('the original deadline');
    // Should NOT contain the [CURSOR] marker
    expect(result!).not.toContain('[CURSOR]');
    console.log(`  Anthropic bridge (${duration}ms): ${result!.slice(0, 100)}`);
  }, 15000);

  it('handles bullet list continuation', async () => {
    const ctx = makeProseContext({
      prefix: 'Key features:\n\n- Fast performance\n- Easy to use\n- ',
      suffix: '',
    });
    const start = Date.now();
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    const duration = Date.now() - start;

    expect(result).not.toBeNull();
    // Should NOT contain [CURSOR]
    expect(result!).not.toContain('[CURSOR]');
    console.log(`  Anthropic bullet (${duration}ms): ${result!.slice(0, 100)}`);
  }, 15000);
});

// ---------- xAI / Grok ----------
describe.skipIf(!hasKey('XAI_API_KEY'))('xAI Grok API', () => {
  const config = makeConfig({
    backend: 'api',
    api: { activePreset: 'xai-grok-4-1-fast', debounceMs: 400 },
  });
  const { ledger } = makeLedger();
  const provider = new ApiCompletionProvider(config, makeLogger(), ledger);

  it('completes prose', async () => {
    const ctx = makeProseContext({
      prefix:
        'The benefits of regular exercise include improved cardiovascular health, better sleep, and',
      suffix: '',
    });
    const start = Date.now();
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    const duration = Date.now() - start;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    expect(result!.toLowerCase()).not.toMatch(/^(here|sure|got it|understood)/);
    console.log(`  Grok prose (${duration}ms): ${result!.slice(0, 100)}`);
  }, 30000);

  it('completes code', async () => {
    const ctx = makeCodeContext({
      prefix: 'function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return ',
      suffix: '\n}',
    });
    const start = Date.now();
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    const duration = Date.now() - start;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    console.log(`  Grok code (${duration}ms): ${result!.slice(0, 100)}`);
  }, 30000);

  it('bridges existing suffix', async () => {
    const ctx = makeProseContext({
      prefix: 'The project was completed ',
      suffix: ' the original deadline.',
    });
    const start = Date.now();
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    const duration = Date.now() - start;

    expect(result).not.toBeNull();
    expect(result!).not.toContain('the original deadline');
    console.log(`  Grok bridge (${duration}ms): ${result!.slice(0, 100)}`);
  }, 30000);
});

// ---------- Gemini ----------
describe.skipIf(!geminiAvailable)('Gemini API', () => {
  const config = makeConfig({
    backend: 'api',
    api: { activePreset: 'gemini-flash', debounceMs: 400 },
  });
  const { ledger } = makeLedger();
  const provider = new ApiCompletionProvider(config, makeLogger(), ledger);

  it('completes prose', async () => {
    const ctx = makeProseContext({
      prefix:
        'The benefits of regular exercise include improved cardiovascular health, better sleep, and',
      suffix: '',
    });
    const start = Date.now();
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    const duration = Date.now() - start;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    expect(result!.toLowerCase()).not.toMatch(/^(here|sure|got it|understood)/);
    console.log(`  Gemini prose (${duration}ms): ${result!.slice(0, 100)}`);
  }, 15000);

  it('completes code', async () => {
    const ctx = makeCodeContext({
      prefix: 'function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  return ',
      suffix: '\n}',
    });
    const start = Date.now();
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    const duration = Date.now() - start;

    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    console.log(`  Gemini code (${duration}ms): ${result!.slice(0, 100)}`);
  }, 15000);
});

// ---------- Edge Cases (use first available provider) ----------
const firstAvailableCard = hasKey('ANTHROPIC_API_KEY')
  ? 'anthropic-haiku-4-5'
  : hasKey('XAI_API_KEY')
    ? 'xai-grok-4-1-fast'
    : geminiAvailable
      ? 'gemini-flash'
      : null;

describe.skipIf(!firstAvailableCard)('API edge cases', () => {
  const config = makeConfig({
    backend: 'api',
    api: { activePreset: firstAvailableCard!, debounceMs: 400 },
  });
  const { ledger } = makeLedger();
  const provider = new ApiCompletionProvider(config, makeLogger(), ledger);

  it('handles empty suffix', async () => {
    const ctx = makeProseContext({
      prefix: 'Once upon a time, there was',
      suffix: '',
    });
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
  }, 15000);

  it('handles very short prefix', async () => {
    const ctx = makeProseContext({
      prefix: 'The ',
      suffix: ' dog.',
    });
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    expect(result).not.toBeNull();
  }, 15000);

  it('handles code continuation', async () => {
    const ctx = makeCodeContext({
      prefix: 'const users = [\n  { name: "Alice", age: 30 },\n  ',
      suffix: '\n];',
    });
    const result = await provider.getCompletion(ctx, new AbortController().signal);
    expect(result).not.toBeNull();
    expect(result!.length).toBeGreaterThan(0);
    console.log(`  Edge code (${firstAvailableCard}): ${result!.slice(0, 100)}`);
  }, 15000);

  it('model card hot-swap', async () => {
    // Initial completion
    const ctx = makeProseContext({ prefix: 'Hello world and ' });
    const result1 = await provider.getCompletion(ctx, new AbortController().signal);
    expect(result1).not.toBeNull();

    // The provider should still work after updateConfig
    provider.updateConfig(config);
    const result2 = await provider.getCompletion(ctx, new AbortController().signal);
    expect(result2).not.toBeNull();
  }, 30000);
});
