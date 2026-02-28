/**
 * Backend-agnostic integration tests — same scenarios run against any backend.
 *
 * The backend is selected via environment variables:
 *   TEST_BACKEND=claude-code (default) | api
 *   TEST_API_PRESET=anthropic-haiku (default) | anthropic-sonnet | xai-grok | ...
 *
 * Run: npm run test:api
 * Run with API: TEST_BACKEND=api npm run test:api
 * Run with xAI: TEST_BACKEND=api TEST_API_PRESET=xai-grok npm run test:api
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CompletionProvider } from '../../types';
import {
  createTestProvider,
  getTestBackendConfig,
  makeProseContext,
  makeCodeContext,
  TestProviderInfo,
  TestUsageEntry,
} from '../helpers';
import {
  getApiRunDir,
  buildApiResult,
  saveApiResult,
  saveApiSummary,
  ApiResult,
  ApiResultUsage,
} from './result-writer';

const { backend, preset } = getTestBackendConfig();
const describeLabel =
  backend === 'claude-code' ? `Shared Scenarios [claude-code]` : `Shared Scenarios [api/${preset}]`;

// Top-level await: check backend availability before test registration.
// createTestProvider() returns null when the backend isn't available.
const info: TestProviderInfo | null = await createTestProvider();
const isAvailable = info !== null;

const subdirName = backend === 'claude-code' ? 'shared-claude-code' : `shared-api`;

/** Convert TestUsageEntry to ApiResultUsage for saving. */
function toResultUsage(entry: TestUsageEntry | null): ApiResultUsage | undefined {
  if (!entry) return undefined;
  return {
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    costUsd: entry.costUsd,
  };
}

/** Format usage for console output. */
function formatUsage(usage: TestUsageEntry | null): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.inputTokens !== undefined && usage.outputTokens !== undefined) {
    parts.push(`${usage.inputTokens}+${usage.outputTokens} tokens`);
  }
  if (usage.costUsd !== undefined) {
    parts.push(`$${usage.costUsd.toFixed(6)}`);
  }
  if (usage.model) {
    parts.push(usage.model);
  }
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
}

describe.skipIf(!isAvailable)(describeLabel, () => {
  let provider: CompletionProvider;
  let runDir: string;
  const results: ApiResult[] = [];
  let totalCost = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  beforeAll(async () => {
    provider = info!.provider;
    runDir = getApiRunDir();
    await info!.activate();
  }, 120_000);

  afterAll(() => {
    if (results.length > 0) {
      saveApiSummary(runDir, subdirName, {
        backend: info!.label,
        totalTests: results.length,
        totalCostUsd: totalCost,
        totalInputTokens,
        totalOutputTokens,
        timestamp: new Date().toISOString(),
      });
      console.log(
        `\n[${info!.label}] ${results.length} tests — ` +
          `${totalInputTokens}+${totalOutputTokens} tokens, $${totalCost.toFixed(6)} total`,
      );
    }
    info!.dispose();
  });

  it('returns a prose completion', async () => {
    const ctx = makeProseContext({
      prefix: 'Once upon a time, in a land far away, there lived a',
      fileName: 'story.md',
      filePath: '/test/story.md',
    });

    const start = Date.now();
    const result = await provider.getCompletion(ctx, AbortSignal.timeout(30_000));
    const durationMs = Date.now() - start;
    const usage = info!.getLastUsage();

    console.log(`[${info!.label} prose]:`, result, formatUsage(usage));
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);

    totalCost += usage?.costUsd ?? 0;
    totalInputTokens += usage?.inputTokens ?? 0;
    totalOutputTokens += usage?.outputTokens ?? 0;

    const data = buildApiResult(
      'prose',
      info!.backend,
      ctx,
      result,
      durationMs,
      toResultUsage(usage),
    );
    saveApiResult(runDir, subdirName, 'prose', data);
    results.push(data);
  }, 60_000);

  it('returns a code completion', async () => {
    const ctx = makeCodeContext({
      prefix: 'function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  ',
    });

    const start = Date.now();
    const result = await provider.getCompletion(ctx, AbortSignal.timeout(30_000));
    const durationMs = Date.now() - start;
    const usage = info!.getLastUsage();

    console.log(`[${info!.label} code]:`, result, formatUsage(usage));
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');

    totalCost += usage?.costUsd ?? 0;
    totalInputTokens += usage?.inputTokens ?? 0;
    totalOutputTokens += usage?.outputTokens ?? 0;

    const data = buildApiResult(
      'code',
      info!.backend,
      ctx,
      result,
      durationMs,
      toResultUsage(usage),
    );
    saveApiResult(runDir, subdirName, 'code', data);
    results.push(data);
  }, 60_000);

  it('does not return markdown fences in completion', async () => {
    const ctx = makeCodeContext({
      prefix: 'function greet(name: string): string {\n  return ',
      suffix: '\n}',
      fileName: 'greet.ts',
      filePath: '/test/greet.ts',
    });

    const start = Date.now();
    const result = await provider.getCompletion(ctx, AbortSignal.timeout(30_000));
    const durationMs = Date.now() - start;
    const usage = info!.getLastUsage();

    console.log(`[${info!.label} no-fences]:`, result, formatUsage(usage));
    if (result) {
      expect(result).not.toMatch(/^```/);
      expect(result).not.toMatch(/```$/);
    }

    totalCost += usage?.costUsd ?? 0;
    totalInputTokens += usage?.inputTokens ?? 0;
    totalOutputTokens += usage?.outputTokens ?? 0;

    const data = buildApiResult(
      'no-fences',
      info!.backend,
      ctx,
      result,
      durationMs,
      toResultUsage(usage),
    );
    saveApiResult(runDir, subdirName, 'no-fences', data);
    results.push(data);
  }, 60_000);

  it('completion does not start with newlines', async () => {
    const ctx = makeProseContext({
      prefix: 'The weather today is',
      fileName: 'notes.md',
      filePath: '/test/notes.md',
    });

    const start = Date.now();
    const result = await provider.getCompletion(ctx, AbortSignal.timeout(30_000));
    const durationMs = Date.now() - start;
    const usage = info!.getLastUsage();

    console.log(`[${info!.label} no-leading-newlines]:`, result, formatUsage(usage));
    if (result) {
      expect(result).not.toMatch(/^\n/);
    }

    totalCost += usage?.costUsd ?? 0;
    totalInputTokens += usage?.inputTokens ?? 0;
    totalOutputTokens += usage?.outputTokens ?? 0;

    const data = buildApiResult(
      'no-leading-newlines',
      info!.backend,
      ctx,
      result,
      durationMs,
      toResultUsage(usage),
    );
    saveApiResult(runDir, subdirName, 'no-leading-newlines', data);
    results.push(data);
  }, 60_000);
});
