#!/usr/bin/env tsx
/**
 * Rapid iteration test script for code completion quality.
 *
 * Runs a cherry-picked set of code scenarios against an API backend
 * with objective pass/fail criteria. Designed for fast iteration cycles
 * during prompt engineering (target: 30-60s per run).
 *
 * Usage:
 *   npx tsx src/test/quality/rapid-test.ts                    # default: xai-grok
 *   npx tsx src/test/quality/rapid-test.ts xai-grok-code      # specific preset
 *   npx tsx src/test/quality/rapid-test.ts openai-gpt-4.1-nano
 *
 * Pass/fail criteria (objective, no subjective judgment):
 *   - FAIL if completion contains <COMPLETION> or </COMPLETION> tags
 *   - FAIL if completion contains {{FILL_HERE}}
 *   - FAIL if completion is null or empty
 *   - FAIL if completion > 500 chars for a simple expression scenario
 *   - FAIL if completion starts with assistant preamble
 *   - Otherwise: PASS
 */

import { CompletionContext, ExtensionConfig, DEFAULT_MODEL } from '../../types';
import { truncatePrefix, truncateSuffix } from '../../utils/truncation';
import { Logger } from '../../utils/logger';
import { TestScenario } from './judge';
import { codeScenarios } from './scenarios';
import { codeMidFileScenarios, codeFullWindowScenarios } from './scenarios/index';
import { regressionScenarios } from './regression-scenarios';

// ─── Inline helpers (avoid importing helpers.ts which pulls in vitest) ─

function makeConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  const defaults: ExtensionConfig = {
    enabled: true,
    mode: 'auto',
    backend: 'claude-code',
    triggerPreset: 'relaxed',
    triggerMode: 'auto',
    debounceMs: 2000,
    prose: { contextChars: 2500, suffixChars: 2000, fileTypes: [] },
    code: { contextChars: 2500, suffixChars: 2000 },
    claudeCode: { model: DEFAULT_MODEL, models: ['haiku', 'sonnet', 'opus'] },
    api: { preset: 'anthropic-haiku', customPresets: [] },
    codeOverride: { backend: '', model: '' },
    contextMenu: { permissionMode: 'default' },
    logLevel: 'info',
  };
  return {
    ...defaults,
    ...overrides,
    claudeCode: { ...defaults.claudeCode, ...overrides.claudeCode },
    api: { ...defaults.api, ...overrides.api },
    codeOverride: { ...defaults.codeOverride, ...overrides.codeOverride },
    prose: { ...defaults.prose, ...overrides.prose },
    code: { ...defaults.code, ...overrides.code },
    contextMenu: { ...defaults.contextMenu, ...overrides.contextMenu },
  };
}

function makeLogger(): Logger {
  return {
    setLevel: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    error: () => {},
    requestStart: () => {},
    requestEnd: () => {},
    cacheHit: () => {},
    traceBlock: () => {},
    traceInline: () => {},
    show: () => {},
    dispose: () => {},
  } as unknown as Logger;
}

// ─── Cherry-picked scenario IDs ─────────────────────────────────────

const RAPID_SCENARIO_IDS = [
  'code-mid-file-ts-handler-full', // Tag leak + context awareness
  'code-mid-file-py-module-full', // Mode confusion (prose vs code)
  'code-mid-file-go-full', // Wrong method context
  'code-long-prefix-ts', // Excessive length + quality
  'code-ts-function-body', // Sanity check (should always pass)
  'code-py-list-comprehension', // Suffix echo ]
  'code-html-tag', // Tag leak pattern
];

// "Simple expression" scenarios — completion > 500 chars is suspicious
const SIMPLE_EXPRESSION_IDS = new Set([
  'code-ts-function-body',
  'code-py-list-comprehension',
  'code-html-tag',
]);

// ─── Collect all scenarios into a lookup ─────────────────────────────

const allCodeScenarios: TestScenario[] = [
  ...codeScenarios,
  ...codeMidFileScenarios,
  ...codeFullWindowScenarios,
  ...regressionScenarios.filter((s) => s.mode === 'code'),
];

const scenarioMap = new Map<string, TestScenario>();
for (const s of allCodeScenarios) {
  scenarioMap.set(s.id, s);
}

// ─── Pass/fail criteria ──────────────────────────────────────────────

interface CheckResult {
  pass: boolean;
  failures: string[];
}

const PROSE_PREAMBLE_PATTERNS = [
  /^Sure[,!.]/i,
  /^Here'?s\b/i,
  /^Here is\b/i,
  /^Absolutely[,!.]/i,
  /^Of course[,!.]/i,
  /^Got it[,!.]/i,
  /^Understood[,!.]/i,
  /^I'd be happy\b/i,
  /^Let me\b/i,
  /^I can help\b/i,
  /^I'll\b/i,
];

function checkCompletion(
  completion: string | null,
  scenarioId: string,
): CheckResult {
  const failures: string[] = [];

  if (completion === null || completion.trim() === '') {
    return { pass: false, failures: ['NULL or empty completion'] };
  }

  // Tag leak check
  if (/<\/?COMPLETION>/.test(completion)) {
    failures.push('TAG LEAK: contains <COMPLETION> or </COMPLETION>');
  }

  // Marker leak check
  if (/\{\{FILL_HERE\}\}/.test(completion)) {
    failures.push('MARKER LEAK: contains {{FILL_HERE}}');
  }

  // Document tag leak check
  if (/<\/?document>/.test(completion)) {
    failures.push('TAG LEAK: contains <document> tag');
  }

  // Code fence check
  if (/^```/.test(completion)) {
    failures.push('CODE FENCE: starts with code fence');
  }

  // Excessive length for simple expression scenarios
  if (SIMPLE_EXPRESSION_IDS.has(scenarioId) && completion.length > 500) {
    failures.push(`EXCESSIVE LENGTH: ${completion.length} chars (max 500 for simple expression)`);
  }

  // Assistant preamble check — model switched to chat mode
  const trimmed = completion.trimStart();
  for (const pattern of PROSE_PREAMBLE_PATTERNS) {
    if (pattern.test(trimmed)) {
      failures.push(`PROSE PREAMBLE: starts with "${trimmed.slice(0, 30)}..."`);
      break;
    }
  }

  return { pass: failures.length === 0, failures };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const presetId = process.argv[2] || 'xai-grok';

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  RAPID CODE QUALITY TEST — ${presetId}`);
  console.log(`${'═'.repeat(60)}\n`);

  // Resolve scenarios
  const scenarios: TestScenario[] = [];
  const missing: string[] = [];
  for (const id of RAPID_SCENARIO_IDS) {
    const s = scenarioMap.get(id);
    if (s) {
      scenarios.push(s);
    } else {
      missing.push(id);
    }
  }

  if (missing.length > 0) {
    console.error(`  Missing scenarios: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Create API provider
  const { clearApiKeyCache } = await import('../../utils/api-key-store');
  const { ApiCompletionProvider } = await import('../../providers/api/api-provider');
  clearApiKeyCache();

  const logger = makeLogger();
  const config = makeConfig({
    backend: 'api',
    api: { preset: presetId, customPresets: [] },
  });
  const provider = new ApiCompletionProvider(config, logger);

  if (!provider.isAvailable()) {
    console.error(`  Preset "${presetId}" not available (missing API key?)`);
    process.exit(1);
  }

  // Run scenarios
  let passCount = 0;
  let failCount = 0;
  const results: Array<{
    id: string;
    pass: boolean;
    failures: string[];
    completion: string | null;
    durationMs: number;
  }> = [];

  for (const scenario of scenarios) {
    const prefixChars = scenario.contextWindow?.prefixChars ?? config.code.contextChars;
    const suffixChars = scenario.contextWindow?.suffixChars ?? config.code.suffixChars;

    const ctx: CompletionContext = {
      prefix: truncatePrefix(scenario.prefix, prefixChars),
      suffix: truncateSuffix(scenario.suffix, suffixChars),
      languageId: scenario.languageId,
      fileName: scenario.fileName,
      filePath: `/${scenario.fileName}`,
      mode: scenario.mode,
    };

    const start = Date.now();
    let completion: string | null = null;
    let error: string | null = null;

    try {
      completion = await provider.getCompletion(ctx, AbortSignal.timeout(30_000));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const durationMs = Date.now() - start;

    const check = error
      ? { pass: false, failures: [`ERROR: ${error}`] }
      : checkCompletion(completion, scenario.id);

    if (check.pass) {
      passCount++;
    } else {
      failCount++;
    }

    results.push({
      id: scenario.id,
      pass: check.pass,
      failures: check.failures,
      completion,
      durationMs,
    });

    // Print result immediately
    const icon = check.pass ? '✓' : '✗';
    const status = check.pass ? 'PASS' : 'FAIL';
    console.log(`  ${icon} ${status}  ${scenario.id}  (${durationMs}ms)`);

    if (!check.pass) {
      for (const f of check.failures) {
        console.log(`           → ${f}`);
      }
    }

    // Show first 120 chars of completion for quick inspection
    if (completion) {
      const preview =
        completion.length > 120
          ? completion.slice(0, 120).replace(/\n/g, '\\n') + '...'
          : completion.replace(/\n/g, '\\n');
      console.log(`           "${preview}"`);
    }
    console.log();
  }

  // Summary
  const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
  console.log(`${'─'.repeat(60)}`);
  console.log(
    `  ${passCount}/${scenarios.length} passed  |  ${failCount} failed  |  ${(totalMs / 1000).toFixed(1)}s total`,
  );
  console.log(`${'─'.repeat(60)}\n`);

  provider.dispose();

  // Exit code for CI: 0 if all pass, 1 if any fail
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(2);
});
