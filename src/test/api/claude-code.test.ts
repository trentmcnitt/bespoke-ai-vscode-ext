/**
 * Integration test for ClaudeCodeProvider — exercises the real Agent SDK,
 * spawns actual claude subprocesses, and validates the 2-slot rotating pool.
 *
 * Requires: `claude` CLI installed + `@anthropic-ai/claude-agent-sdk`
 *
 * Run: npm run test:api
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ClaudeCodeProvider } from '../../providers/claude-code';
import { CompletionContext } from '../../types';
import { makeConfig, makeLogger } from '../helpers';
import * as path from 'path';

const CWD = path.resolve(__dirname, '../../..');

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
  config.backend = 'claude-code';
  config.claudeCode.model = 'haiku';
  config.prose.maxTokens = 50;
  config.code.maxTokens = 50;
  return config;
}

describe.skipIf(!sdkAvailable)('Claude Code Provider Integration', () => {
  let provider: ClaudeCodeProvider | null = null;

  afterEach(() => {
    provider?.dispose();
    provider = null;
  });

  it('activates and reports available', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate(CWD);
    expect(provider.isAvailable()).toBe(true);
  }, 60_000);

  it('returns a prose completion', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate(CWD);

    const ctx: CompletionContext = {
      prefix: 'Once upon a time, in a land far away, there lived a',
      suffix: '',
      languageId: 'markdown',
      fileName: 'story.md',
      filePath: '/test/story.md',
      mode: 'prose',
    };

    const ac = new AbortController();
    const result = await provider.getCompletion(ctx, ac.signal);

    console.log('[Claude Code prose]:', result);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
    expect(result!.length).toBeGreaterThan(0);
  }, 60_000);

  it('returns a code completion', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate(CWD);

    const ctx: CompletionContext = {
      prefix: 'function fibonacci(n: number): number {\n  if (n <= 1) return n;\n  ',
      suffix: '\n}',
      languageId: 'typescript',
      fileName: 'math.ts',
      filePath: '/test/math.ts',
      mode: 'code',
    };

    const ac = new AbortController();
    const result = await provider.getCompletion(ctx, ac.signal);

    console.log('[Claude Code code]:', result);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  }, 60_000);

  it('slot rotation: second request uses the other slot', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    const logger = makeLogger();
    const debugLogs: string[] = [];
    logger.debug = (msg: string) => { debugLogs.push(msg); };
    provider = new ClaudeCodeProvider(makeRealConfig(), logger);
    await provider.activate(CWD);

    // First completion — should use slot 0
    const ctx1: CompletionContext = {
      prefix: 'The quick brown fox',
      suffix: '',
      languageId: 'markdown',
      fileName: 'test.md',
      filePath: '/test/test.md',
      mode: 'prose',
    };

    const result1 = await provider.getCompletion(ctx1, new AbortController().signal);
    console.log('[Slot rotation result1]:', result1);

    // Check log for slot 0
    const slot0Log = debugLogs.find(m => m.includes('slot=0'));
    expect(slot0Log).toBeTruthy();

    // Wait a bit for slot 0 to recycle
    await new Promise(r => setTimeout(r, 2000));

    // Second completion — should use slot 1
    const ctx2: CompletionContext = {
      prefix: 'function add(a, b) { return ',
      suffix: ' }',
      languageId: 'javascript',
      fileName: 'math.js',
      filePath: '/test/math.js',
      mode: 'code',
    };

    const result2 = await provider.getCompletion(ctx2, new AbortController().signal);
    console.log('[Slot rotation result2]:', result2);

    const slot1Log = debugLogs.find(m => m.includes('slot=1'));
    expect(slot1Log).toBeTruthy();

    // Both should have produced completions
    expect(result1).toBeTruthy();
    expect(result2).toBeTruthy();
  }, 120_000);

  it('returns null when signal is pre-aborted', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate(CWD);

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
  }, 60_000);

  it('does not return markdown fences in completion', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate(CWD);

    const ctx: CompletionContext = {
      prefix: 'function greet(name: string): string {\n  return ',
      suffix: '\n}',
      languageId: 'typescript',
      fileName: 'greet.ts',
      filePath: '/test/greet.ts',
      mode: 'code',
    };

    const result = await provider.getCompletion(ctx, new AbortController().signal);
    console.log('[No fences test]:', result);

    if (result) {
      expect(result).not.toMatch(/^```/);
      expect(result).not.toMatch(/```$/);
    }
  }, 60_000);

  it('completion does not start with newlines', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate(CWD);

    const ctx: CompletionContext = {
      prefix: 'The weather today is',
      suffix: '',
      languageId: 'markdown',
      fileName: 'notes.md',
      filePath: '/test/notes.md',
      mode: 'prose',
    };

    const result = await provider.getCompletion(ctx, new AbortController().signal);
    console.log('[No leading newlines]:', result);

    if (result) {
      expect(result).not.toMatch(/^\n/);
    }
  }, 60_000);

  it('dispose cleans up without errors', async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate(CWD);
    expect(provider.isAvailable()).toBe(true);

    provider.dispose();
    expect(provider.isAvailable()).toBe(false);
    provider = null; // prevent afterEach double-dispose
  }, 60_000);
});
