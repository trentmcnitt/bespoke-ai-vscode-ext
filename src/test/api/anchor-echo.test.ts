/**
 * Anchor Echo Adherence — measures how reliably the Claude Code backend
 * echoes the anchor text at the start of its raw response.
 *
 * This is a measurement instrument, not a pass/fail gate. The Claude Code
 * provider uses extractAnchor + a [CONTINUATION POINT] instruction to tell
 * the model to echo the current line, then trimPrefixOverlap strips it.
 * This test gauges how well the model follows that instruction.
 *
 * (The Anthropic provider uses assistant prefill, which mechanically
 * guarantees the anchor — no adherence measurement needed.)
 *
 * Requires: `claude` CLI installed + `@anthropic-ai/claude-agent-sdk`
 *
 * Run:
 *   npx vitest run --config vitest.api.config.ts src/test/api/anchor-echo.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ClaudeCodeProvider, extractAnchor } from '../../providers/claude-code';
import { CompletionContext, CompletionMode } from '../../types';
import { makeConfig } from '../helpers';
import { Logger } from '../../utils/logger';
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

// ── Adherence measurement ───────────────────────────────────────────────

interface AdherenceResult {
  degree: 'full' | 'partial' | 'none';
  percentage: number;
  matchedText: string;
}

/**
 * Measure how closely the raw response echoes the expected anchor text.
 *
 * The Claude Code provider instructs the model to begin its response with
 * the anchor (current line text). trimPrefixOverlap then strips the echo.
 * This function checks whether the raw response (before post-processing)
 * starts with the anchor.
 */
function measureAnchorAdherence(anchor: string, raw: string): AdherenceResult {
  if (!anchor) {
    return { degree: 'full', percentage: 100, matchedText: '' };
  }

  // Exact startsWith
  if (raw.startsWith(anchor)) {
    return { degree: 'full', percentage: 100, matchedText: anchor };
  }

  // Whitespace-normalized startsWith
  const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
  const normAnchor = normalize(anchor);
  const normRaw = normalize(raw);

  if (normRaw.startsWith(normAnchor)) {
    return { degree: 'full', percentage: 100, matchedText: anchor };
  }

  // Partial: longest leading substring of normalized anchor in normalized raw
  let matchLen = 0;
  for (let i = 1; i <= normAnchor.length; i++) {
    if (normRaw.startsWith(normAnchor.slice(0, i))) {
      matchLen = i;
    } else {
      break;
    }
  }

  if (matchLen > 0) {
    const percentage = Math.round((matchLen / normAnchor.length) * 100);
    return {
      degree: 'partial',
      percentage,
      matchedText: normAnchor.slice(0, matchLen),
    };
  }

  return { degree: 'none', percentage: 0, matchedText: '' };
}

// ── Scenarios ───────────────────────────────────────────────────────────

interface AnchorScenario {
  name: string;
  prefix: string;
  suffix: string;
  mode: CompletionMode;
  languageId: string;
  fileName: string;
}

const scenarios: AnchorScenario[] = [
  {
    name: 'prose-mid-sentence',
    prefix: 'Once upon a time, in a land far away, there lived a',
    suffix: '',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'story.md',
  },
  {
    name: 'bullet-prefix',
    prefix: '# Shopping List\n\n- Eggs\n- Milk\n- ',
    suffix: '',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'list.md',
  },
  {
    name: 'code-line',
    prefix: 'function greet(name: string) {\n  const result = ',
    suffix: '\n  return result;\n}',
    mode: 'code',
    languageId: 'typescript',
    fileName: 'greet.ts',
  },
  {
    name: 'heading-start',
    prefix: '# Introduction\n\nThis document covers the basics.\n\n## Getting Started',
    suffix: '',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'guide.md',
  },
  {
    name: 'long-line-truncated',
    prefix: 'The implementation of the distributed consensus algorithm requires careful consideration of network partitions, message ordering guarantees, and the fundamental trade-offs described by the CAP theorem, which states that',
    suffix: '',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'essay.md',
  },
  {
    name: 'short-single-word',
    prefix: 'Hello',
    suffix: '',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'greeting.md',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────

function makeRealConfig() {
  const config = makeConfig();
  config.backend = 'claude-code';
  config.claudeCode.model = 'haiku';
  config.prose.maxTokens = 60;
  config.code.maxTokens = 60;
  return config;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ── Test ────────────────────────────────────────────────────────────────

describe.skipIf(!sdkAvailable)('Anchor Echo Adherence', () => {
  let provider: ClaudeCodeProvider;

  // Capture raw responses and anchors from trace logs
  const traceLogs: string[] = [];

  beforeAll(async () => {
    const logger: Logger = {
      setLevel: () => {},
      info: () => {},
      debug: () => {},
      trace: (...args: unknown[]) => { traceLogs.push(String(args[0])); },
      error: (...args: unknown[]) => { console.error(String(args[0])); },
      show: () => {},
      dispose: () => {},
    } as unknown as Logger;

    provider = new ClaudeCodeProvider(makeRealConfig(), logger);
    await provider.activate(CWD);
  }, 60_000);

  afterAll(() => {
    provider?.dispose();
  });

  it('measures anchor echo adherence across scenarios', async () => {
    interface ScenarioResult {
      name: string;
      anchor: string;
      adherence: AdherenceResult;
      rawSnippet: string;
      postProcessed: string | null;
    }

    const results: ScenarioResult[] = [];

    for (const scenario of scenarios) {
      const context: CompletionContext = {
        prefix: scenario.prefix,
        suffix: scenario.suffix,
        languageId: scenario.languageId,
        fileName: scenario.fileName,
        filePath: `/test/${scenario.fileName}`,
        mode: scenario.mode,
      };

      // Compute the anchor the provider will use
      const { anchor } = extractAnchor(context.prefix);

      traceLogs.length = 0;
      const ac = new AbortController();
      const result = await provider.getCompletion(context, ac.signal);

      // Health check: completion must be non-null
      expect(result, `${scenario.name}: completion should be non-null`).not.toBeNull();

      // Extract raw response from trace logs (logged before post-processing)
      const rawLine = traceLogs.find(l => l.startsWith('Claude Code raw response:'));
      const raw = rawLine ? rawLine.replace('Claude Code raw response: ', '') : '';

      const adherence = measureAnchorAdherence(anchor, raw);

      results.push({
        name: scenario.name,
        anchor,
        adherence,
        rawSnippet: truncate(raw, 80),
        postProcessed: result,
      });

      // Per-scenario log
      console.log(`\n[${scenario.name}]`);
      console.log(`  Anchor:  "${truncate(anchor, 60)}"`);
      console.log(`  Echo:    ${adherence.degree} (${adherence.percentage}%)`);
      console.log(`  Raw:     "${truncate(raw, 80)}"`);
      console.log(`  Result:  "${truncate(result ?? '(null)', 80)}"`);

      // 3s recycling delay between scenarios
      if (scenarios.indexOf(scenario) < scenarios.length - 1) {
        await new Promise(r => setTimeout(r, 3_000));
      }
    }

    // ── Summary table ─────────────────────────────────────────────────
    const fullCount = results.filter(r => r.adherence.degree === 'full').length;
    const partialCount = results.filter(r => r.adherence.degree === 'partial').length;
    const noneCount = results.filter(r => r.adherence.degree === 'none').length;
    const avgPct = Math.round(
      results.reduce((sum, r) => sum + r.adherence.percentage, 0) / results.length,
    );

    console.log('\n' + '='.repeat(90));
    console.log('ANCHOR ECHO ADHERENCE SUMMARY');
    console.log('='.repeat(90));
    console.log(
      'Scenario'.padEnd(25) +
      'Anchor'.padEnd(35) +
      'Degree'.padEnd(10) +
      'Match %',
    );
    console.log('-'.repeat(90));

    for (const r of results) {
      console.log(
        r.name.padEnd(25) +
        `"${truncate(r.anchor, 30)}"`.padEnd(35) +
        r.adherence.degree.padEnd(10) +
        `${r.adherence.percentage}%`,
      );
    }

    console.log('-'.repeat(90));
    console.log(
      `Full: ${fullCount}/${results.length}  ` +
      `Partial: ${partialCount}/${results.length}  ` +
      `None: ${noneCount}/${results.length}  ` +
      `Avg: ${avgPct}%`,
    );
    console.log('='.repeat(90));
  }, 300_000);
});
