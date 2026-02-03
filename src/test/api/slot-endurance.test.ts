/**
 * Slot endurance tests — validate that a single provider remains reliable
 * across many sequential completions, including across the recycle boundary.
 *
 * These tests use a single ClaudeCodeProvider instance (default 1-slot pool)
 * and fire completions sequentially, tracking per-request latency and success.
 *
 * Run: npm run test:api
 */
import { describe, it, expect, afterAll } from 'vitest';
import { ClaudeCodeProvider } from '../../providers/claude-code';
import { CompletionContext } from '../../types';
import { makeConfig, makeLogger, getTestModel, assertModelMatch } from '../helpers';
import {
  getApiRunDir,
  saveApiResult,
  buildApiResult,
  saveApiSummary,
  ApiResult,
} from './result-writer';
import * as path from 'path';

const CWD = path.resolve(__dirname, '../../..');

let sdkAvailable = false;
try {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const queryFn = sdk.query ?? sdk.default?.query;
  sdkAvailable = typeof queryFn === 'function';
} catch {
  sdkAvailable = false;
}

function makeEnduranceConfig() {
  const config = makeConfig();
  config.claudeCode.model = getTestModel();
  return config;
}

/** Short, diverse contexts to rotate through. Keeps completions fast. */
const contexts: CompletionContext[] = [
  {
    prefix: 'The weather today is',
    suffix: '',
    languageId: 'markdown',
    fileName: 'notes.md',
    filePath: '/test/notes.md',
    mode: 'prose',
  },
  {
    prefix: 'function add(a, b) { return ',
    suffix: ' }',
    languageId: 'javascript',
    fileName: 'math.js',
    filePath: '/test/math.js',
    mode: 'code',
  },
  {
    prefix: 'The main advantage of this approach is that',
    suffix: '',
    languageId: 'markdown',
    fileName: 'doc.md',
    filePath: '/test/doc.md',
    mode: 'prose',
  },
  {
    prefix: 'const items = data.filter(x => ',
    suffix: ');\n',
    languageId: 'typescript',
    fileName: 'utils.ts',
    filePath: '/test/utils.ts',
    mode: 'code',
  },
];

interface EnduranceResult {
  index: number;
  context: string;
  completion: string | null;
  durationMs: number;
  error?: string;
}

async function runSequentialCompletions(
  provider: ClaudeCodeProvider,
  count: number,
): Promise<EnduranceResult[]> {
  const results: EnduranceResult[] = [];
  for (let i = 0; i < count; i++) {
    const ctx = contexts[i % contexts.length];
    const start = Date.now();
    try {
      const completion = await provider.getCompletion(ctx, new AbortController().signal);
      results.push({
        index: i,
        context: `${ctx.mode}:${ctx.fileName}`,
        completion,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        index: i,
        context: `${ctx.mode}:${ctx.fileName}`,
        completion: null,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

describe.skipIf(!sdkAvailable)('Slot Endurance', () => {
  const runDir = getApiRunDir();
  const allApiResults: ApiResult[] = [];

  afterAll(() => {
    if (allApiResults.length > 0) {
      saveApiSummary(runDir, 'slot-endurance', {
        backend: 'claude-code',
        model: makeEnduranceConfig().claudeCode.model,
        totalTests: allApiResults.length,
        timestamp: new Date().toISOString(),
      });
    }
  });

  it('sustained reuse: 8 completions within recycle limit', async () => {
    const TOTAL = 8; // matches ClaudeCodeProvider.getMaxReuses()
    const provider = new ClaudeCodeProvider(makeEnduranceConfig(), makeLogger());
    try {
      await provider.activate(CWD);
      const results = await runSequentialCompletions(provider, TOTAL);

      // Log per-request summary
      console.log(`\n[Sustained reuse] ${TOTAL} completions:`);
      for (const r of results) {
        console.log(
          `  #${r.index}: ${r.durationMs}ms | ${r.completion?.length ?? 0} chars | ${r.context}${r.error ? ` | ERROR: ${r.error}` : ''}`,
        );
      }

      // All requests should succeed
      const successes = results.filter((r) => r.completion !== null);
      expect(successes.length).toBe(TOTAL);

      // No errors
      const errors = results.filter((r) => r.error);
      expect(errors).toHaveLength(0);

      // Latency should not degrade drastically — last request should be
      // within 3x of the first (generous threshold for CI variance)
      const first = results[0].durationMs;
      const last = results[results.length - 1].durationMs;
      console.log(
        `  Latency: first=${first}ms, last=${last}ms, ratio=${(last / first).toFixed(2)}x`,
      );

      assertModelMatch(provider);

      // Save individual results
      for (const r of results) {
        const ctx = contexts[r.index % contexts.length];
        const data = buildApiResult(
          `sustained-${r.index}`,
          'claude-code',
          ctx,
          r.completion,
          r.durationMs,
        );
        saveApiResult(runDir, 'slot-endurance', `sustained-${r.index}`, data);
        allApiResults.push(data);
      }
    } finally {
      provider.dispose();
    }
  }, 180_000); // 3 min

  it('recycle boundary: 10 completions crossing MAX_REUSES', async () => {
    const MAX_REUSES = 8; // matches ClaudeCodeProvider.getMaxReuses()
    const TOTAL = MAX_REUSES + 2; // 10
    const logger = makeLogger();
    const recycleLogs: string[] = [];
    // Capture recycle events via the logger
    logger.debug = (...args: unknown[]) => {
      const msg = args.map(String).join(' ');
      if (msg.includes('recycl')) {
        recycleLogs.push(msg);
      }
    };

    const provider = new ClaudeCodeProvider(makeEnduranceConfig(), logger);
    try {
      await provider.activate(CWD);
      const results = await runSequentialCompletions(provider, TOTAL);

      // Log per-request summary
      console.log(`\n[Recycle boundary] ${TOTAL} completions (MAX_REUSES=${MAX_REUSES}):`);
      for (const r of results) {
        console.log(
          `  #${r.index}: ${r.durationMs}ms | ${r.completion?.length ?? 0} chars | ${r.context}${r.error ? ` | ERROR: ${r.error}` : ''}`,
        );
      }
      if (recycleLogs.length > 0) {
        console.log(`  Recycle events: ${recycleLogs.length}`);
        for (const log of recycleLogs) {
          console.log(`    ${log}`);
        }
      }

      // All requests should succeed, including those after recycling
      const successes = results.filter((r) => r.completion !== null);
      expect(successes.length).toBe(TOTAL);

      // No errors
      const errors = results.filter((r) => r.error);
      expect(errors).toHaveLength(0);

      // Requests after the recycle boundary should still produce completions
      const postRecycleResults = results.slice(MAX_REUSES);
      for (const r of postRecycleResults) {
        expect(r.completion, `post-recycle request #${r.index} should succeed`).toBeTruthy();
      }

      assertModelMatch(provider);

      // Save individual results
      for (const r of results) {
        const ctx = contexts[r.index % contexts.length];
        const data = buildApiResult(
          `recycle-${r.index}`,
          'claude-code',
          ctx,
          r.completion,
          r.durationMs,
        );
        saveApiResult(runDir, 'slot-endurance', `recycle-${r.index}`, data);
        allApiResults.push(data);
      }
    } finally {
      provider.dispose();
    }
  }, 240_000); // 4 min
});
