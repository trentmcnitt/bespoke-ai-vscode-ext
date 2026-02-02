/**
 * Benchmark runner — full automated pipeline.
 *
 * NOTE: Benchmark runner currently non-functional — needs rewrite for Claude Code backend.
 * The Anthropic/Ollama providers have been removed. This file retains the pipeline
 * structure for future adaptation to Claude Code or restored API providers.
 *
 * Standalone script (run via `npx tsx` or `npm run benchmark`).
 * Generates K completions per scenario, evaluates each with J judges,
 * aggregates scores, writes to ledger, and generates a comparison report.
 *
 * Usage:
 *   npm run benchmark
 *   BENCHMARK_CONFIGS="haiku-temp0.5,haiku-temp0.9" npm run benchmark
 *   BENCHMARK_K=3 BENCHMARK_J=3 npm run benchmark
 *   BENCHMARK_JUDGE_MODEL=claude-sonnet-4-20250514 npm run benchmark
 *   BENCHMARK_CONCURRENCY=10 npm run benchmark
 */
import * as fs from 'fs';
import * as path from 'path';
import { CompletionContext, CompletionProvider, ExtensionConfig } from '../types';
import { makeConfig } from '../test/helpers';
import { TestScenario } from '../test/quality/judge';
import { proseScenarios, codeScenarios, edgeCaseScenarios } from '../test/quality/scenarios';
import { regressionScenarios } from '../test/quality/regression-scenarios';
import { getConfigsToRun } from './configs';
import { appendFullRunToLedger } from './ledger';
import { evaluateBatch, EvaluationInput, JudgeConfig, DEFAULT_JUDGE_MODEL } from './judge';
import { writeComparisonReport } from './reporter';
import {
  BENCHMARKS_DIR,
  BenchmarkConfig,
  BenchmarkLedgerEntry,
  ConfigLedgerEntry,
  GenerationResult,
  JudgmentFileResult,
  ScenarioAggregation,
  ScenarioScore,
} from './types';

// ─── Constants ───────────────────────────────────────────────────────
const ALL_SCENARIOS: TestScenario[] = [
  ...proseScenarios,
  ...codeScenarios,
  ...edgeCaseScenarios,
  ...regressionScenarios,
];

// ─── Env config ──────────────────────────────────────────────────────

interface RunParams {
  K: number;
  J: number;
  judgeModel: string;
  concurrency: number;
  apiKey: string;
}

function parseRunParams(): RunParams {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!apiKey) {
    console.error('ERROR: ANTHROPIC_API_KEY not set in environment.');
    process.exit(1);
  }
  return {
    K: parseInt(process.env.BENCHMARK_K ?? '3', 10),
    J: parseInt(process.env.BENCHMARK_J ?? '3', 10),
    judgeModel: process.env.BENCHMARK_JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL,
    concurrency: parseInt(process.env.BENCHMARK_CONCURRENCY ?? '5', 10),
    apiKey,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function resolveConfig(benchConfig: BenchmarkConfig, _apiKey: string): ExtensionConfig {
  return makeConfig(benchConfig.overrides);
}

function getModelName(config: ExtensionConfig): string {
  return config.claudeCode.model;
}

function createProvider(_config: ExtensionConfig): CompletionProvider {
  // TODO: Rewrite for Claude Code backend
  throw new Error('Benchmark runner needs rewrite for Claude Code backend');
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sqDiffs = values.map((v) => (v - mean) ** 2);
  return Math.sqrt(sqDiffs.reduce((a, b) => a + b, 0) / (values.length - 1));
}

// ─── Layer 1: Generation ─────────────────────────────────────────────

async function generateCompletion(
  provider: CompletionProvider,
  scenario: TestScenario,
): Promise<{ completion: string | null; durationMs: number; error?: string }> {
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
    return { completion, durationMs: Date.now() - start };
  } catch (err) {
    return {
      completion: null,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function generateK(
  provider: CompletionProvider,
  scenario: TestScenario,
  K: number,
): Promise<GenerationResult[]> {
  const results: GenerationResult[] = [];
  for (let k = 0; k < K; k++) {
    const { completion, durationMs, error } = await generateCompletion(provider, scenario);
    results.push({ index: k, completion, durationMs, error });
  }
  return results;
}

// ─── File I/O ────────────────────────────────────────────────────────

function saveScenarioInput(scenarioDir: string, scenario: TestScenario): void {
  fs.mkdirSync(scenarioDir, { recursive: true });

  fs.writeFileSync(
    path.join(scenarioDir, 'input.json'),
    JSON.stringify(
      {
        mode: scenario.mode,
        languageId: scenario.languageId,
        fileName: scenario.fileName,
        prefix: scenario.prefix,
        suffix: scenario.suffix,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(scenarioDir, 'requirements.json'),
    JSON.stringify(scenario.requirements, null, 2),
  );
}

function saveGeneration(scenarioDir: string, gen: GenerationResult): void {
  const genDir = path.join(scenarioDir, `generation-${gen.index}`);
  fs.mkdirSync(genDir, { recursive: true });

  fs.writeFileSync(
    path.join(genDir, 'completion.txt'),
    gen.completion ?? '(null — provider returned no completion)',
  );

  fs.writeFileSync(
    path.join(genDir, 'metadata.json'),
    JSON.stringify(
      {
        index: gen.index,
        durationMs: gen.durationMs,
        completionLength: gen.completion?.length ?? 0,
        error: gen.error ?? null,
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

function saveJudgment(scenarioDir: string, genIndex: number, judgment: JudgmentFileResult): void {
  const genDir = path.join(scenarioDir, `generation-${genIndex}`);
  fs.mkdirSync(genDir, { recursive: true });

  fs.writeFileSync(
    path.join(genDir, `judgment-${judgment.index}.json`),
    JSON.stringify(judgment, null, 2),
  );
}

function saveAggregation(scenarioDir: string, agg: ScenarioAggregation): void {
  fs.writeFileSync(path.join(scenarioDir, 'aggregation.json'), JSON.stringify(agg, null, 2));
}

// ─── Aggregation ─────────────────────────────────────────────────────

function aggregateScenario(
  scenarioId: string,
  mode: 'prose' | 'code',
  judgments: JudgmentFileResult[],
): ScenarioAggregation {
  const scores = judgments.map((j) => j.score);
  const meanScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const acceptCount = judgments.filter((j) => j.accept).length;
  const passCount = judgments.filter((j) => j.pass).length;

  return {
    scenarioId,
    mode,
    meanScore,
    stdev: stddev(scores),
    acceptRate: judgments.length > 0 ? acceptCount / judgments.length : 0,
    passRate: judgments.length > 0 ? passCount / judgments.length : 0,
    generationCount: new Set(judgments.map((j) => j.index)).size || 0,
    judgmentCount: judgments.length,
  };
}

function aggregateConfig(aggregations: ScenarioAggregation[]): {
  avgScore: number;
  passRate: number;
  acceptRate: number;
  scoreStdev: number;
  proseAvgScore: number;
  codeAvgScore: number;
} {
  const allScores = aggregations.map((a) => a.meanScore);
  const avgScore =
    allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;

  const allPassRates = aggregations.map((a) => a.passRate);
  const passRate =
    allPassRates.length > 0 ? allPassRates.reduce((a, b) => a + b, 0) / allPassRates.length : 0;

  const allAcceptRates = aggregations.map((a) => a.acceptRate);
  const acceptRate =
    allAcceptRates.length > 0
      ? allAcceptRates.reduce((a, b) => a + b, 0) / allAcceptRates.length
      : 0;

  const prose = aggregations.filter((a) => a.mode === 'prose');
  const code = aggregations.filter((a) => a.mode === 'code');
  const proseAvgScore =
    prose.length > 0 ? prose.reduce((s, a) => s + a.meanScore, 0) / prose.length : 0;
  const codeAvgScore =
    code.length > 0 ? code.reduce((s, a) => s + a.meanScore, 0) / code.length : 0;

  return {
    avgScore,
    passRate,
    acceptRate,
    scoreStdev: stddev(allScores),
    proseAvgScore,
    codeAvgScore,
  };
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const params = parseRunParams();
  const configs = getConfigsToRun();

  console.log(
    `\nBenchmark run: ${configs.length} config(s), ${ALL_SCENARIOS.length} scenarios each`,
  );
  console.log(`Generations per scenario (K): ${params.K}`);
  console.log(`Judges per generation (J): ${params.J}`);
  console.log(`Judge model: ${params.judgeModel}`);
  console.log(`Concurrency: ${params.concurrency}`);
  console.log(`Configs: ${configs.map((c) => c.label).join(', ')}\n`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const runId = timestamp;
  const runDir = path.join(BENCHMARKS_DIR, `run-${timestamp}`);
  fs.mkdirSync(runDir, { recursive: true });

  const judgeConfig: JudgeConfig = {
    apiKey: params.apiKey,
    model: params.judgeModel,
    concurrency: params.concurrency,
  };

  const configEntries: ConfigLedgerEntry[] = [];

  for (const benchConfig of configs) {
    console.log(`\n── Config: ${benchConfig.label} (${benchConfig.description}) ──`);
    const config = resolveConfig(benchConfig, params.apiKey);
    const provider = createProvider(config);
    const configDir = path.join(runDir, benchConfig.label);
    fs.mkdirSync(configDir, { recursive: true });

    // Save resolved config
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));

    // ── Layer 1: Generate K completions per scenario ──
    console.log('  Layer 1: Generating completions...');
    const scenarioGenerations = new Map<string, GenerationResult[]>();
    let successCount = 0;
    let errorCount = 0;
    const genStart = Date.now();

    for (const scenario of ALL_SCENARIOS) {
      const scenarioDir = path.join(configDir, scenario.id);
      saveScenarioInput(scenarioDir, scenario);

      console.log(`    ${scenario.id} (K=${params.K})...`);
      const generations = await generateK(provider, scenario, params.K);
      scenarioGenerations.set(scenario.id, generations);

      for (const gen of generations) {
        saveGeneration(scenarioDir, gen);
        if (gen.error) errorCount++;
        else if (gen.completion !== null) successCount++;
      }
    }

    const genDuration = Date.now() - genStart;
    console.log(`  Layer 1 done: ${successCount} success, ${errorCount} errors`);

    // ── Layer 2: Evaluate with J judges ──
    console.log('  Layer 2: Evaluating with automated judges...');
    const evalInputs: EvaluationInput[] = [];

    for (const scenario of ALL_SCENARIOS) {
      const generations = scenarioGenerations.get(scenario.id) ?? [];
      for (const gen of generations) {
        for (let j = 0; j < params.J; j++) {
          evalInputs.push({
            scenario,
            completion: gen.completion,
            generationIndex: gen.index,
            judgeIndex: j,
          });
        }
      }
    }

    console.log(
      `    ${evalInputs.length} evaluations (${ALL_SCENARIOS.length} scenarios × ${params.K} generations × ${params.J} judges)...`,
    );
    const judgments = await evaluateBatch(evalInputs, judgeConfig);

    // Save judgments and aggregate (evaluateBatch returns results in input order)
    const judgmentsByScenario = new Map<string, JudgmentFileResult[]>();
    for (let i = 0; i < evalInputs.length; i++) {
      const input = evalInputs[i];
      const judgment = judgments[i];

      const scenarioDir = path.join(configDir, input.scenario.id);
      saveJudgment(scenarioDir, input.generationIndex, {
        ...judgment,
        index: input.judgeIndex,
      });

      if (!judgmentsByScenario.has(input.scenario.id)) {
        judgmentsByScenario.set(input.scenario.id, []);
      }
      judgmentsByScenario.get(input.scenario.id)!.push(judgment);
    }

    // Aggregate per scenario
    const aggregations: ScenarioAggregation[] = [];
    for (const scenario of ALL_SCENARIOS) {
      const scenJudgments = judgmentsByScenario.get(scenario.id) ?? [];
      const agg = aggregateScenario(scenario.id, scenario.mode, scenJudgments);
      aggregations.push(agg);

      const scenarioDir = path.join(configDir, scenario.id);
      saveAggregation(scenarioDir, agg);
    }

    // Aggregate config-level stats
    const configStats = aggregateConfig(aggregations);

    const scenarioScores: ScenarioScore[] = aggregations.map((a) => ({
      id: a.scenarioId,
      score: a.meanScore,
      pass: a.passRate >= 0.5,
      accept: a.acceptRate >= 0.5,
    }));

    const entry: ConfigLedgerEntry = {
      label: benchConfig.label,
      model: getModelName(config),
      backend: 'claude-code',
      overrides: benchConfig.overrides,
      scenarioCount: ALL_SCENARIOS.length,
      successCount,
      errorCount,
      totalDurationMs: genDuration,
      avgScore: configStats.avgScore,
      passRate: configStats.passRate,
      acceptRate: configStats.acceptRate,
      scoreStdev: configStats.scoreStdev,
      proseAvgScore: configStats.proseAvgScore,
      codeAvgScore: configStats.codeAvgScore,
      scenarioScores,
      generationsPerScenario: params.K,
      judgesPerGeneration: params.J,
      scenarioAggregations: aggregations,
    };

    configEntries.push(entry);
    console.log(
      `  Config done: avgScore=${configStats.avgScore.toFixed(1)}, acceptRate=${(configStats.acceptRate * 100).toFixed(0)}%, passRate=${(configStats.passRate * 100).toFixed(0)}%`,
    );
  }

  // ── Write ledger entry ──
  const ledgerEntry: BenchmarkLedgerEntry = {
    runId,
    timestamp: new Date().toISOString(),
    judgeCount: params.J,
    totalScenarios: ALL_SCENARIOS.length,
    generationCount: params.K,
    judgeModel: params.judgeModel,
    automated: true,
    configs: configEntries,
  };
  appendFullRunToLedger(ledgerEntry);

  // ── Generate report ──
  const reportPath = writeComparisonReport();
  console.log(`\nComparison report: ${reportPath}`);

  // ── Summary ──
  console.log('\n' + '='.repeat(70));
  console.log('  BENCHMARK COMPLETE');
  console.log('='.repeat(70));
  console.log(`  Run ID:       ${runId}`);
  console.log(`  Output:       ${runDir}`);
  console.log(`  Configs:      ${configs.map((c) => c.label).join(', ')}`);
  console.log(`  K (gens):     ${params.K}`);
  console.log(`  J (judges):   ${params.J}`);
  console.log(`  Judge model:  ${params.judgeModel}`);
  console.log('');
  for (const entry of configEntries) {
    console.log(
      `  ${entry.label}: score=${entry.avgScore?.toFixed(1)} accept=${((entry.acceptRate ?? 0) * 100).toFixed(0)}% pass=${((entry.passRate ?? 0) * 100).toFixed(0)}%`,
    );
  }
  console.log('='.repeat(70) + '\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
