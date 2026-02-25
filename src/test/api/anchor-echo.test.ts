/**
 * Fill marker adherence — verifies the Claude Code backend fills the
 * {{FILL_HERE}} marker without echoing surrounding text from the prefix or suffix.
 *
 * Requires: `claude` CLI installed + `@anthropic-ai/claude-agent-sdk`
 *
 * Run:
 *   npx vitest run --config vitest.api.config.ts src/test/api/anchor-echo.test.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ClaudeCodeProvider } from '../../providers/claude-code';
import { CompletionContext, CompletionMode } from '../../types';
import { makeConfig, makeLogger, getTestModel, assertModelMatch } from '../helpers';
import {
  getApiRunDir,
  buildApiResult,
  saveApiResult,
  saveApiSummary,
  ApiResult,
} from './result-writer';
import * as fs from 'fs';
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

// ── Adherence checks ────────────────────────────────────────────────────

/**
 * Check if the completion echoes text from the prefix or suffix.
 * Returns details about any echo detected.
 */
function checkForEcho(
  completion: string,
  prefix: string,
  suffix: string,
): {
  echoesPrefix: boolean;
  echoesSuffix: boolean;
  details: string;
} {
  const result = { echoesPrefix: false, echoesSuffix: false, details: '' };

  // Check if completion starts with a significant chunk of the prefix tail
  // (the last line or last 40+ chars)
  const lastNewline = prefix.lastIndexOf('\n');
  const prefixTail = lastNewline >= 0 ? prefix.slice(lastNewline + 1) : prefix;
  if (prefixTail.length >= 5 && completion.startsWith(prefixTail)) {
    result.echoesPrefix = true;
    result.details += `Echoes prefix tail: "${prefixTail.slice(0, 40)}". `;
  }

  // Check if completion ends with a significant chunk of the suffix head
  if (suffix.trim()) {
    const suffixHead = suffix.trim().slice(0, 60);
    if (suffixHead.length >= 10 && completion.trimEnd().endsWith(suffixHead)) {
      result.echoesSuffix = true;
      result.details += `Echoes suffix head: "${suffixHead.slice(0, 40)}". `;
    }
  }

  return result;
}

// ── Scenarios ───────────────────────────────────────────────────────────

interface FillScenario {
  name: string;
  prefix: string;
  suffix: string;
  mode: CompletionMode;
  languageId: string;
  fileName: string;
}

const scenarios: FillScenario[] = [
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
    name: 'code-fill-in-middle',
    prefix: 'function greet(name: string) {\n  const result = ',
    suffix: '\n  return result;\n}',
    mode: 'code',
    languageId: 'typescript',
    fileName: 'greet.ts',
  },
  {
    name: 'heading-continuation',
    prefix: '# Introduction\n\nThis document covers the basics.\n\n## Getting Started',
    suffix: '',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'guide.md',
  },
  {
    name: 'long-sentence-continuation',
    prefix:
      'The implementation of the distributed consensus algorithm requires careful consideration of network partitions, message ordering guarantees, and the fundamental trade-offs described by the CAP theorem, which states that',
    suffix: '',
    mode: 'prose',
    languageId: 'markdown',
    fileName: 'essay.md',
  },
];

// ── Helpers ─────────────────────────────────────────────────────────────

function makeRealConfig() {
  const config = makeConfig();
  config.claudeCode.model = getTestModel();
  return config;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ── Test ────────────────────────────────────────────────────────────────

describe.skipIf(!sdkAvailable)('fill marker adherence', () => {
  let provider: ClaudeCodeProvider;
  const runDir = getApiRunDir();
  const results: ApiResult[] = [];

  beforeAll(async () => {
    provider = new ClaudeCodeProvider(makeRealConfig(), makeLogger());
    await provider.activate(CWD);
  }, 60_000);

  afterAll(() => {
    if (provider) {
      assertModelMatch(provider);
    }
    provider?.dispose();

    if (results.length > 0) {
      saveApiSummary(runDir, 'anchor-echo', {
        backend: 'claude-code',
        model: makeRealConfig().claudeCode.model,
        totalTests: results.length,
        timestamp: new Date().toISOString(),
      });
    }
  });

  it('fills placeholder without echoing surrounding text', async () => {
    interface ScenarioResult {
      name: string;
      completion: string | null;
      echoesPrefix: boolean;
      echoesSuffix: boolean;
      details: string;
    }

    const scenarioResults: ScenarioResult[] = [];

    for (const scenario of scenarios) {
      const context: CompletionContext = {
        prefix: scenario.prefix,
        suffix: scenario.suffix,
        languageId: scenario.languageId,
        fileName: scenario.fileName,
        filePath: `/test/${scenario.fileName}`,
        mode: scenario.mode,
      };

      const start = Date.now();
      const ac = new AbortController();
      const completion = await provider.getCompletion(context, ac.signal);
      const durationMs = Date.now() - start;

      // Health check: completion must be non-null
      expect(completion, `${scenario.name}: completion should be non-null`).not.toBeNull();

      const echo = checkForEcho(completion!, context.prefix, context.suffix);

      scenarioResults.push({
        name: scenario.name,
        completion,
        echoesPrefix: echo.echoesPrefix,
        echoesSuffix: echo.echoesSuffix,
        details: echo.details || 'Clean fill — no echo detected.',
      });

      // Save individual result
      const data = buildApiResult(scenario.name, 'claude-code', context, completion, durationMs);
      saveApiResult(runDir, 'anchor-echo', scenario.name, data);
      results.push(data);

      // Per-scenario log
      console.log(`\n[${scenario.name}]`);
      console.log(`  Prefix echo: ${echo.echoesPrefix ? 'YES' : 'no'}`);
      console.log(`  Suffix echo: ${echo.echoesSuffix ? 'YES' : 'no'}`);
      console.log(`  Completion:  "${truncate(completion ?? '(null)', 80)}"`);
      if (echo.details) {
        console.log(`  Details:     ${echo.details}`);
      }

      // 3s recycling delay between scenarios
      if (scenarios.indexOf(scenario) < scenarios.length - 1) {
        await new Promise((r) => setTimeout(r, 3_000));
      }
    }

    // ── Summary ──────────────────────────────────────────────────────
    const cleanCount = scenarioResults.filter((r) => !r.echoesPrefix && !r.echoesSuffix).length;
    const prefixEchoCount = scenarioResults.filter((r) => r.echoesPrefix).length;
    const suffixEchoCount = scenarioResults.filter((r) => r.echoesSuffix).length;

    console.log('\n' + '='.repeat(90));
    console.log('FILL MARKER ADHERENCE SUMMARY');
    console.log('='.repeat(90));
    console.log(
      'Scenario'.padEnd(30) + 'Prefix Echo'.padEnd(15) + 'Suffix Echo'.padEnd(15) + 'Status',
    );
    console.log('-'.repeat(90));

    for (const r of scenarioResults) {
      const status = !r.echoesPrefix && !r.echoesSuffix ? 'CLEAN' : 'ECHO';
      console.log(
        r.name.padEnd(30) +
          (r.echoesPrefix ? 'YES' : 'no').padEnd(15) +
          (r.echoesSuffix ? 'YES' : 'no').padEnd(15) +
          status,
      );
    }

    console.log('-'.repeat(90));
    console.log(
      `Clean: ${cleanCount}/${scenarioResults.length}  ` +
        `Prefix echo: ${prefixEchoCount}/${scenarioResults.length}  ` +
        `Suffix echo: ${suffixEchoCount}/${scenarioResults.length}`,
    );
    console.log('='.repeat(90));

    // Write the echo adherence table as a separate summary file
    const echoSummary = {
      totalScenarios: scenarioResults.length,
      clean: cleanCount,
      prefixEcho: prefixEchoCount,
      suffixEcho: suffixEchoCount,
      scenarios: scenarioResults.map((r) => ({
        name: r.name,
        echoesPrefix: r.echoesPrefix,
        echoesSuffix: r.echoesSuffix,
        status: !r.echoesPrefix && !r.echoesSuffix ? 'CLEAN' : 'ECHO',
        details: r.details,
        completionPreview: truncate(r.completion ?? '(null)', 120),
      })),
    };
    const echoDir = path.join(runDir, 'anchor-echo');
    fs.mkdirSync(echoDir, { recursive: true });
    fs.writeFileSync(
      path.join(echoDir, 'echo-adherence.json'),
      JSON.stringify(echoSummary, null, 2),
    );
  }, 300_000);
});
