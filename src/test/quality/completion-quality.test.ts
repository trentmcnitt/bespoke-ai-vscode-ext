/**
 * Completion quality test runner — GENERATION ONLY.
 *
 * This generates completions for each scenario and saves them to disk.
 * It does NOT judge quality — that's done by Claude in-session after
 * the tests finish, using the validator prompt and saved outputs.
 *
 * Run: npm run test:quality
 *
 * After generation completes, the afterAll hook prints instructions
 * for Claude to begin Layer 2 (semantic quality) validation.
 *
 * Backend selection:
 *   QUALITY_TEST_BACKEND=claude-code  (default) — uses Claude Code SDK, no API key needed
 *   QUALITY_TEST_BACKEND=anthropic               — uses direct Anthropic API, needs ANTHROPIC_API_KEY
 *
 * Model override:
 *   QUALITY_TEST_MODEL=claude-sonnet-4-20250514   — override model (anthropic backend)
 *   QUALITY_TEST_MODEL=sonnet                     — override model (claude-code backend)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AnthropicProvider } from '../../providers/anthropic';
import { ClaudeCodeProvider } from '../../providers/claude-code';
import { CompletionContext, CompletionProvider, Backend } from '../../types';
import { makeConfig, makeCapturingLogger, loadApiKey } from '../helpers';
import { TestScenario } from './judge';
import { proseScenarios, codeScenarios, edgeCaseScenarios } from './scenarios';
import { regressionScenarios } from './regression-scenarios';

// ─── Backend selection ───────────────────────────────────────────────

const backend = (process.env.QUALITY_TEST_BACKEND ?? 'claude-code') as Backend;
const apiKey = loadApiKey();

// Check if the selected backend can run
let canRun = false;
let skipReason = '';

if (backend === 'claude-code') {
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const queryFn = sdk.query ?? sdk.default?.query;
    canRun = typeof queryFn === 'function';
    if (!canRun) { skipReason = 'Agent SDK does not export query()'; }
  } catch {
    canRun = false;
    skipReason = 'Agent SDK not available (npm install @anthropic-ai/claude-agent-sdk)';
  }
} else if (backend === 'anthropic') {
  canRun = apiKey.length > 0;
  if (!canRun) { skipReason = 'ANTHROPIC_API_KEY not set'; }
} else {
  skipReason = `Unsupported backend: ${backend}`;
}

function makeCompletionConfig() {
  const config = makeConfig();
  config.backend = backend;

  if (backend === 'anthropic') {
    config.anthropic.apiKey = apiKey;
    config.anthropic.useCaching = false;
    if (process.env.QUALITY_TEST_MODEL) {
      config.anthropic.model = process.env.QUALITY_TEST_MODEL;
    }
  } else if (backend === 'claude-code') {
    if (process.env.QUALITY_TEST_MODEL) {
      config.claudeCode.model = process.env.QUALITY_TEST_MODEL;
    }
  }

  return config;
}

function getModelName(): string {
  const config = makeCompletionConfig();
  if (backend === 'claude-code') { return `claude-code/${config.claudeCode.model}`; }
  return config.anthropic.model;
}

// ─── Output management ──────────────────────────────────────────────

const RESULTS_DIR = path.join(__dirname, '..', '..', '..', 'test-results');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = path.join(RESULTS_DIR, `quality-${timestamp}`);

interface GenerationResult {
  scenario: TestScenario;
  completion: string | null;
  rawResponse?: string;
  durationMs: number;
  error?: string;
}

const results: GenerationResult[] = [];

function saveScenarioOutput(result: GenerationResult): void {
  const scenarioDir = path.join(RUN_DIR, result.scenario.id);
  fs.mkdirSync(scenarioDir, { recursive: true });

  // Save the input context
  fs.writeFileSync(
    path.join(scenarioDir, 'input.json'),
    JSON.stringify({
      mode: result.scenario.mode,
      languageId: result.scenario.languageId,
      fileName: result.scenario.fileName,
      prefix: result.scenario.prefix,
      suffix: result.scenario.suffix,
    }, null, 2),
  );

  // Save requirements
  fs.writeFileSync(
    path.join(scenarioDir, 'requirements.json'),
    JSON.stringify(result.scenario.requirements, null, 2),
  );

  // Save completion output
  fs.writeFileSync(
    path.join(scenarioDir, 'completion.txt'),
    result.completion ?? '(null — provider returned no completion)',
  );

  // Save raw model output (before post-processing) when available
  if (result.rawResponse !== undefined) {
    fs.writeFileSync(
      path.join(scenarioDir, 'raw-response.txt'),
      result.rawResponse,
    );
  }

  // Save metadata
  fs.writeFileSync(
    path.join(scenarioDir, 'metadata.json'),
    JSON.stringify({
      id: result.scenario.id,
      description: result.scenario.description,
      durationMs: result.durationMs,
      completionLength: result.completion?.length ?? 0,
      error: result.error ?? null,
      generatedAt: new Date().toISOString(),
      backend,
      model: getModelName(),
    }, null, 2),
  );
}

// ─── Tests ──────────────────────────────────────────────────────────

describe.skipIf(!canRun)(`Completion Quality — Generation [${backend}]`, () => {
  let provider: CompletionProvider;
  let claudeCodeInstance: ClaudeCodeProvider | null = null;
  let getTrace: (label: string) => string | undefined;

  beforeAll(async () => {
    fs.mkdirSync(RUN_DIR, { recursive: true });
    const config = makeCompletionConfig();
    const capturing = makeCapturingLogger();
    getTrace = capturing.getTrace;

    if (backend === 'claude-code') {
      const cc = new ClaudeCodeProvider(config, capturing.logger);
      const cwd = path.resolve(__dirname, '..', '..', '..');
      await cc.activate(cwd);
      claudeCodeInstance = cc;
      provider = cc;
    } else {
      provider = new AnthropicProvider(config, capturing.logger);
    }
  });

  afterAll(() => {
    claudeCodeInstance?.dispose();

    if (results.length === 0) return;

    // Write summary
    const generated = results.filter(r => r.completion !== null).length;
    const nulls = results.filter(r => r.completion === null).length;
    const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

    const summary = {
      timestamp,
      backend,
      model: getModelName(),
      totalScenarios: results.length,
      generated,
      nullResults: nulls,
      totalDurationMs: totalMs,
      scenarios: results.map(r => ({
        id: r.scenario.id,
        mode: r.scenario.mode,
        hasCompletion: r.completion !== null,
        completionLength: r.completion?.length ?? 0,
        durationMs: r.durationMs,
        error: r.error ?? null,
      })),
    };
    fs.writeFileSync(path.join(RUN_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

    // Create a 'latest' symlink
    const latestPath = path.join(RESULTS_DIR, 'latest');
    try { fs.unlinkSync(latestPath); } catch { /* */ }
    try { fs.symlinkSync(RUN_DIR, latestPath); } catch { /* */ }

    // ════════════════════════════════════════════════════════════════
    // LAYER 2 INSTRUCTIONS — Claude reads this in the session
    // ════════════════════════════════════════════════════════════════
    console.log('\n' + '='.repeat(70));
    console.log('  LAYER 1 COMPLETE — LAYER 2 VALIDATION REQUIRED');
    console.log('='.repeat(70));
    console.log(`\n  Backend:   ${backend}`);
    console.log(`  Model:     ${getModelName()}`);
    console.log(`  Generated: ${generated}/${results.length} completions (${nulls} null)`);
    console.log(`  Duration:  ${(totalMs / 1000).toFixed(1)}s total`);
    console.log(`  Output:    ${RUN_DIR}`);
    console.log('\n  Layer 1 (generation + structural checks) is just a sanity check.');
    console.log('  Layer 2 is the ACTUAL quality test.\n');
    console.log('  PROCEED WITH LAYER 2 VALIDATION:');
    console.log('  1. Read the validator prompt: src/test/quality/validator-prompt.md');
    console.log('  2. For each scenario in the output directory:');
    console.log('     - Read input.json (what the user typed)');
    console.log('     - Read completion.txt (what the model generated)');
    console.log('     - Read requirements.json (what counts as good)');
    console.log('     - Evaluate against the validator prompt criteria');
    console.log('     - Save your judgment to the scenario dir as validation.md');
    console.log('  3. Write an overall summary to the run directory as layer2-summary.md');
    console.log('  4. Report results to the user.\n');
    console.log('  Validate EVERY scenario. Do not spot-check.');
    console.log('='.repeat(70) + '\n');
  });

  // Helper to run a single scenario
  async function generateCompletion(scenario: TestScenario): Promise<GenerationResult> {
    const ctx: CompletionContext = {
      prefix: scenario.prefix,
      suffix: scenario.suffix,
      languageId: scenario.languageId,
      fileName: scenario.fileName,
      filePath: `/${scenario.fileName}`,
      mode: scenario.mode,
    };

    const start = Date.now();
    try {
      const ac = new AbortController();
      const completion = await provider.getCompletion(ctx, ac.signal);
      const result: GenerationResult = {
        scenario,
        completion,
        rawResponse: getTrace('← raw'),
        durationMs: Date.now() - start,
      };
      saveScenarioOutput(result);
      return result;
    } catch (err) {
      const result: GenerationResult = {
        scenario,
        completion: null,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
      saveScenarioOutput(result);
      return result;
    }
  }

  // Structural checks (Layer 1): just verify we got something
  describe('prose scenarios', () => {
    it.each(proseScenarios.map(s => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateCompletion(scenario);
        results.push(result);
        // Layer 1: completion was generated without throwing
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('code scenarios', () => {
    it.each(codeScenarios.map(s => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateCompletion(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('edge cases', () => {
    it.each(edgeCaseScenarios.map(s => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateCompletion(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });

  describe('regression cases', () => {
    it.each(regressionScenarios.map(s => [s.id, s] as const))(
      '%s',
      async (_id, scenario) => {
        const result = await generateCompletion(scenario);
        results.push(result);
        expect(result.error).toBeUndefined();
      },
    );
  });
});
