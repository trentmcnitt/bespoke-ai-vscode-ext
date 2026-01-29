/**
 * Benchmark runner — Layer 1 generation engine.
 *
 * Standalone script (run via `npx tsx` or `npm run benchmark`).
 * Generates completions for all quality scenarios across multiple config
 * variations, saves results to disk, and appends to the ledger.
 *
 * Usage:
 *   npm run benchmark
 *   BENCHMARK_CONFIGS="haiku-temp0.5,haiku-temp0.9" npm run benchmark
 *   BENCHMARK_JUDGES=3 npm run benchmark
 *
 * After Layer 1 completes, follow the printed instructions for Layer 2.
 */
import * as fs from 'fs';
import * as path from 'path';
import { AnthropicProvider } from '../providers/anthropic';
import { OllamaProvider } from '../providers/ollama';
import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { makeConfig, makeLogger } from '../test/helpers';
import { TestScenario } from '../test/quality/judge';
import { proseScenarios, codeScenarios, edgeCaseScenarios } from '../test/quality/scenarios';
import { getConfigsToRun } from './configs';
import { appendToLedger } from './ledger';
import {
  BENCHMARKS_DIR,
  BenchmarkConfig,
  BenchmarkLedgerEntry,
  ConfigRunResult,
  ScenarioGenerationResult,
} from './types';

// ─── Constants ───────────────────────────────────────────────────────
const ALL_SCENARIOS: TestScenario[] = [...proseScenarios, ...codeScenarios, ...edgeCaseScenarios];

// ─── Helpers ─────────────────────────────────────────────────────────

function resolveConfig(benchConfig: BenchmarkConfig, apiKey: string): ExtensionConfig {
  const config = makeConfig(benchConfig.overrides);
  // Always inject the real API key (overrides may have set it to '' for model-comparison presets)
  config.anthropic.apiKey = apiKey;
  return config;
}

function getModelName(config: ExtensionConfig): string {
  return config.backend === 'ollama' ? config.ollama.model : config.anthropic.model;
}

function createProvider(config: ExtensionConfig): CompletionProvider {
  const logger = makeLogger();
  if (config.backend === 'ollama') {
    return new OllamaProvider(config, logger);
  }
  return new AnthropicProvider(config, logger);
}

async function runScenario(
  provider: CompletionProvider,
  scenario: TestScenario,
): Promise<ScenarioGenerationResult> {
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
    return {
      scenarioId: scenario.id,
      mode: scenario.mode,
      completion,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      scenarioId: scenario.id,
      mode: scenario.mode,
      completion: null,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function saveScenarioOutput(
  scenarioDir: string,
  scenario: TestScenario,
  result: ScenarioGenerationResult,
): void {
  fs.mkdirSync(scenarioDir, { recursive: true });

  fs.writeFileSync(
    path.join(scenarioDir, 'input.json'),
    JSON.stringify({
      mode: scenario.mode,
      languageId: scenario.languageId,
      fileName: scenario.fileName,
      prefix: scenario.prefix,
      suffix: scenario.suffix,
    }, null, 2),
  );

  fs.writeFileSync(
    path.join(scenarioDir, 'requirements.json'),
    JSON.stringify(scenario.requirements, null, 2),
  );

  fs.writeFileSync(
    path.join(scenarioDir, 'completion.txt'),
    result.completion ?? '(null — provider returned no completion)',
  );

  fs.writeFileSync(
    path.join(scenarioDir, 'metadata.json'),
    JSON.stringify({
      scenarioId: result.scenarioId,
      mode: result.mode,
      durationMs: result.durationMs,
      completionLength: result.completion?.length ?? 0,
      error: result.error ?? null,
      generatedAt: new Date().toISOString(),
    }, null, 2),
  );
}

async function runConfig(
  benchConfig: BenchmarkConfig,
  apiKey: string,
  runDir: string,
): Promise<ConfigRunResult> {
  const config = resolveConfig(benchConfig, apiKey);
  const provider = createProvider(config);
  const configDir = path.join(runDir, benchConfig.label);
  fs.mkdirSync(configDir, { recursive: true });

  // Save resolved config (redact API key)
  const sanitizedConfig = { ...config, anthropic: { ...config.anthropic, apiKey: '(redacted)' } };
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(sanitizedConfig, null, 2));

  const results: ScenarioGenerationResult[] = [];
  const totalStart = Date.now();

  for (const scenario of ALL_SCENARIOS) {
    const scenarioDir = path.join(configDir, scenario.id);
    console.log(`  [${benchConfig.label}] ${scenario.id}...`);
    const result = await runScenario(provider, scenario);
    saveScenarioOutput(scenarioDir, scenario, result);
    results.push(result);
  }

  return {
    label: benchConfig.label,
    resolvedConfig: config,
    scenarioResults: results,
    totalDurationMs: Date.now() - totalStart,
    successCount: results.filter(r => !r.error && r.completion !== null).length,
    errorCount: results.filter(r => r.error).length,
  };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY not set in environment.');
    process.exit(1);
  }

  const judgeCount = parseInt(process.env.BENCHMARK_JUDGES ?? '1', 10);
  const configs = getConfigsToRun();

  console.log(`\nBenchmark run: ${configs.length} config(s), ${ALL_SCENARIOS.length} scenarios each`);
  console.log(`Judge count: ${judgeCount}`);
  console.log(`Configs: ${configs.map(c => c.label).join(', ')}\n`);

  // Create run directory
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = timestamp;
  const runDir = path.join(BENCHMARKS_DIR, `run-${timestamp}`);
  fs.mkdirSync(runDir, { recursive: true });

  // Run all configs
  const configResults: ConfigRunResult[] = [];
  for (const benchConfig of configs) {
    console.log(`\n── Config: ${benchConfig.label} (${benchConfig.description}) ──`);
    const result = await runConfig(benchConfig, apiKey, runDir);
    configResults.push(result);
    console.log(`  Done: ${result.successCount} success, ${result.errorCount} errors, ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  }

  // Write run summary
  const runSummary = {
    runId,
    timestamp: new Date().toISOString(),
    judgeCount,
    totalScenarios: ALL_SCENARIOS.length,
    configs: configResults.map(r => ({
      label: r.label,
      model: getModelName(r.resolvedConfig),
      backend: r.resolvedConfig.backend,
      successCount: r.successCount,
      errorCount: r.errorCount,
      totalDurationMs: r.totalDurationMs,
    })),
  };
  fs.writeFileSync(path.join(runDir, 'run-summary.json'), JSON.stringify(runSummary, null, 2));

  // Append to ledger
  const ledgerEntry: BenchmarkLedgerEntry = {
    runId,
    timestamp: new Date().toISOString(),
    judgeCount,
    totalScenarios: ALL_SCENARIOS.length,
    configs: configResults.map(r => ({
      label: r.label,
      model: getModelName(r.resolvedConfig),
      backend: r.resolvedConfig.backend,
      overrides: configs.find(c => c.label === r.label)?.overrides ?? {},
      scenarioCount: r.scenarioResults.length,
      successCount: r.successCount,
      errorCount: r.errorCount,
      totalDurationMs: r.totalDurationMs,
    })),
  };
  appendToLedger(ledgerEntry);

  // ── Layer 2 instructions ──────────────────────────────────────────
  const totalGenerated = configResults.reduce((s, r) => s + r.successCount, 0);
  const totalErrors = configResults.reduce((s, r) => s + r.errorCount, 0);

  console.log('\n' + '='.repeat(70));
  console.log('  LAYER 1 COMPLETE — LAYER 2 VALIDATION REQUIRED');
  console.log('='.repeat(70));
  console.log(`\n  Run ID:     ${runId}`);
  console.log(`  Output:     ${runDir}`);
  console.log(`  Generated:  ${totalGenerated} completions (${totalErrors} errors)`);
  console.log(`  Configs:    ${configs.map(c => c.label).join(', ')}`);
  console.log(`  Judges:     ${judgeCount} per scenario`);
  console.log('\n  PROCEED WITH LAYER 2 VALIDATION:');
  console.log('  1. Read the validator prompt: src/test/quality/validator-prompt.md');
  console.log(`  2. For each config directory in: ${runDir}/`);
  console.log('     For each scenario subdirectory:');
  console.log('       - Read input.json, completion.txt, requirements.json');
  console.log('       - Evaluate against the validator prompt criteria');
  if (judgeCount > 1) {
    console.log(`       - Spin up ${judgeCount} sub-agents to independently score each scenario`);
    console.log('       - Each judge writes a ValidationResult with a unique judgeId');
  }
  console.log('       - Write validation.json to the scenario directory');
  console.log('  3. Update the ledger with scores:');
  console.log('     Use updateLedgerScores(runId, configLabel, scores)');
  console.log('  4. Generate comparison report:');
  console.log('     npx tsx src/benchmark/reporter.ts');
  console.log('='.repeat(70) + '\n');
}

main().catch(err => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
