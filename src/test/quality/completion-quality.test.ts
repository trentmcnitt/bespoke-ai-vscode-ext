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
 * Requires a valid ANTHROPIC_API_KEY in ~/.creds/api-keys.env.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { AnthropicProvider } from '../../providers/anthropic';
import { CompletionContext } from '../../types';
import { makeConfig, loadApiKey } from '../helpers';
import { TestScenario } from './judge';
import { proseScenarios, codeScenarios, edgeCaseScenarios } from './scenarios';

// ─── Setup ──────────────────────────────────────────────────────────

const apiKey = loadApiKey();
const hasApiKey = apiKey.length > 0;

function makeCompletionConfig() {
  const config = makeConfig();
  config.anthropic.apiKey = apiKey;
  config.anthropic.useCaching = false;
  return config;
}

// ─── Output management ──────────────────────────────────────────────

const RESULTS_DIR = path.join(__dirname, '..', '..', '..', 'test-results');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const RUN_DIR = path.join(RESULTS_DIR, `quality-${timestamp}`);

interface GenerationResult {
  scenario: TestScenario;
  completion: string | null;
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
    }, null, 2),
  );
}

// ─── Tests ──────────────────────────────────────────────────────────

describe.skipIf(!hasApiKey)('Completion Quality — Generation', () => {
  let provider: AnthropicProvider;

  beforeAll(() => {
    provider = new AnthropicProvider(makeCompletionConfig());
    fs.mkdirSync(RUN_DIR, { recursive: true });
  });

  afterAll(() => {
    if (results.length === 0) return;

    // Write summary
    const generated = results.filter(r => r.completion !== null).length;
    const nulls = results.filter(r => r.completion === null).length;
    const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);

    const summary = {
      timestamp,
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
    console.log(`\n  Generated: ${generated}/${results.length} completions (${nulls} null)`);
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
      mode: scenario.mode,
    };

    const start = Date.now();
    try {
      const ac = new AbortController();
      const completion = await provider.getCompletion(ctx, ac.signal);
      const result: GenerationResult = {
        scenario,
        completion,
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
});
