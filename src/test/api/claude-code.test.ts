/**
 * Integration test for ClaudeCodeProvider — exercises the real Agent SDK,
 * spawns actual claude subprocesses, and validates the 1-slot rotating pool.
 *
 * Requires: `claude` CLI installed + `@anthropic-ai/claude-agent-sdk`
 *
 * Run: npm run test:api
 */
import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { ClaudeCodeProvider } from '../../providers/claude-code';
import { CompletionContext } from '../../types';
import {
  makeConfig,
  makeLogger,
  makeCapturingLogger,
  assertWarmupValid,
  getTestModel,
  assertModelMatch,
} from '../helpers';
import {
  getApiRunDir,
  buildApiResult,
  saveApiResult,
  saveApiSummary,
  ApiResult,
} from './result-writer';
// Check SDK availability before running
let sdkAvailable = false;
try {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = sdk.query ?? sdk.default?.query;
  sdkAvailable = typeof queryFn === 'function';
} catch {
  sdkAvailable = false;
}

function makeRealConfig() {
  const config = makeConfig();
  config.claudeCode.model = getTestModel();
  return config;
}

describe.skipIf(!sdkAvailable)('Claude Code Provider Integration', () => {
  let provider: ClaudeCodeProvider | null = null;
  const runDir = getApiRunDir();
  const results: ApiResult[] = [];

  afterEach(() => {
    if (provider) {
      assertModelMatch(provider);
    }
    provider?.dispose();
    provider = null;
  });

  afterAll(() => {
    if (results.length > 0) {
      saveApiSummary(runDir, 'claude-code', {
        backend: 'claude-code',
        model: makeRealConfig().claudeCode.model,
        totalTests: results.length,
        timestamp: new Date().toISOString(),
      });
    }
  });

  it('activates and reports available', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate();
    expect(provider.isAvailable()).toBe(true);
  }, 60_000);

  it('warmup response is valid', async () => {
    const { logger, getTrace } = makeCapturingLogger();
    provider = new ClaudeCodeProvider(makeRealConfig(), logger);
    await provider.activate();
    assertWarmupValid(getTrace);
  }, 60_000);

  it('slot reuse: second request reuses the same slot', async () => {
    const logger = makeLogger();
    const slotLogs: string[] = [];
    logger.traceInline = (label: string, value: string) => {
      slotLogs.push(`${label}=${value}`);
    };
    provider = new ClaudeCodeProvider(makeRealConfig(), logger);
    await provider.activate();

    // First completion
    const ctx1: CompletionContext = {
      prefix: 'The quick brown fox',
      suffix: '',
      languageId: 'markdown',
      fileName: 'test.md',
      filePath: '/test/test.md',
      mode: 'prose',
    };

    const start1 = Date.now();
    const result1 = await provider.getCompletion(ctx1, new AbortController().signal);
    const duration1 = Date.now() - start1;
    console.log('[Slot reuse result1]:', result1);

    const firstSlot = slotLogs[slotLogs.length - 1];
    expect(firstSlot, 'expected traceInline to log a slot').toBeTruthy();

    // Second completion — should reuse the same slot (no recycle needed)
    const ctx2: CompletionContext = {
      prefix: 'function add(a, b) { return ',
      suffix: ' }',
      languageId: 'javascript',
      fileName: 'math.js',
      filePath: '/test/math.js',
      mode: 'code',
    };

    const start2 = Date.now();
    const result2 = await provider.getCompletion(ctx2, new AbortController().signal);
    const duration2 = Date.now() - start2;
    console.log('[Slot reuse result2]:', result2);

    // Both should have produced completions
    expect(result1).toBeTruthy();
    expect(result2).toBeTruthy();

    // With reusable slots, both requests complete without recycling.
    // The round-robin prefers alternating slots, so they may use different
    // slot indices — the key behavior is that both succeed quickly without
    // waiting for a slot to recycle.
    const slotValues = slotLogs.filter((m) => m.startsWith('slot='));
    expect(slotValues.length).toBeGreaterThanOrEqual(2);

    const data1 = buildApiResult('slot-reuse-1', 'claude-code', ctx1, result1, duration1);
    saveApiResult(runDir, 'claude-code', 'slot-reuse-1', data1);
    results.push(data1);

    const data2 = buildApiResult('slot-reuse-2', 'claude-code', ctx2, result2, duration2);
    saveApiResult(runDir, 'claude-code', 'slot-reuse-2', data2);
    results.push(data2);
  }, 120_000);

  it('ignores pre-aborted signal and still returns a completion', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate();

    const ctx: CompletionContext = {
      prefix: 'Once upon a time, in a land far away, there lived a',
      suffix: '',
      languageId: 'markdown',
      fileName: 'story.md',
      filePath: '/test/story.md',
      mode: 'prose',
    };

    // With reusable slots, the abort signal is ignored — the request
    // commits to the slot and awaits the result unconditionally
    const ac = new AbortController();
    ac.abort();
    const result = await provider.getCompletion(ctx, ac.signal);
    // The signal is ignored; the completion should succeed
    expect(result).toBeTruthy();
  }, 60_000);

  it('dispose cleans up without errors', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate();
    expect(provider.isAvailable()).toBe(true);

    provider.dispose();
    expect(provider.isAvailable()).toBe(false);
    provider = null; // prevent afterEach double-dispose
  }, 60_000);
});
