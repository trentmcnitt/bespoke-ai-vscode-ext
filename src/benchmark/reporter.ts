/**
 * Comparison report generator for benchmark runs.
 *
 * Reads scored ledger entries and generates a markdown report comparing
 * configs across runs. Primary metric: accept rate.
 *
 * Can be run standalone: npx tsx src/benchmark/reporter.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { loadLedger } from './ledger';
import { BENCHMARKS_DIR, ConfigLedgerEntry, BenchmarkLedgerEntry } from './types';

const REPORT_PATH = path.join(BENCHMARKS_DIR, 'comparison-report.md');

interface ScoredConfig {
  entry: ConfigLedgerEntry;
  run: BenchmarkLedgerEntry;
}

// ─── Statistics ──────────────────────────────────────────────────────

function binomialCoeff(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < Math.min(k, n - k); i++) {
    result = result * (n - i) / (i + 1);
  }
  return result;
}

/**
 * Two-sided sign test p-value.
 * Given `wins` successes out of `total` trials (excluding ties),
 * returns the probability of observing this or more extreme result under H0: p=0.5.
 */
function signTestPValue(wins: number, total: number): number {
  if (total === 0) return 1;
  const k = Math.min(wins, total - wins);
  let p = 0;
  for (let i = 0; i <= k; i++) {
    p += binomialCoeff(total, i);
  }
  // Two-sided: multiply by 2, cap at 1
  return Math.min(1, p * 2 / (2 ** total));
}

// ─── Report generation ───────────────────────────────────────────────

/**
 * Generate a comparison report from ledger data.
 * @param runIds Optional list of run IDs to include. If omitted, includes all scored runs.
 */
export function generateComparisonReport(runIds?: string[]): string {
  const ledger = loadLedger();

  let runs = ledger.runs;
  if (runIds && runIds.length > 0) {
    const idSet = new Set(runIds);
    runs = runs.filter(r => idSet.has(r.runId));
  }

  // Collect all configs that have been scored
  const scoredConfigs: ScoredConfig[] = [];
  for (const run of runs) {
    for (const config of run.configs) {
      if (config.avgScore !== undefined) {
        scoredConfigs.push({ entry: config, run });
      }
    }
  }

  if (scoredConfigs.length === 0) {
    return '# Benchmark Comparison Report\n\nNo scored configs found. Run `npm run benchmark` to generate results.\n';
  }

  // Sort by accept rate (primary), then avg score (secondary)
  scoredConfigs.sort((a, b) => {
    const acceptA = a.entry.acceptRate ?? -1;
    const acceptB = b.entry.acceptRate ?? -1;
    if (acceptA !== acceptB) return acceptB - acceptA;
    return (b.entry.avgScore ?? 0) - (a.entry.avgScore ?? 0);
  });

  const lines: string[] = [];
  lines.push('# Benchmark Comparison Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Scored configs: ${scoredConfigs.length}`);
  lines.push('');

  // ── Summary table ──────────────────────────────────────────────────
  lines.push('## Summary');
  lines.push('');
  lines.push('| Config | Model | Accept Rate | Avg Score | Stdev | Pass Rate | Prose Avg | Code Avg | K | J | Run |');
  lines.push('|--------|-------|-------------|-----------|-------|-----------|-----------|----------|---|---|-----|');

  for (const { entry, run } of scoredConfigs) {
    const acceptPct = entry.acceptRate !== undefined ? `${(entry.acceptRate * 100).toFixed(0)}%` : '-';
    const passRatePct = entry.passRate !== undefined ? `${(entry.passRate * 100).toFixed(0)}%` : '-';
    const stdev = entry.scoreStdev !== undefined ? entry.scoreStdev.toFixed(2) : '-';
    const proseAvg = entry.proseAvgScore?.toFixed(1) ?? '-';
    const codeAvg = entry.codeAvgScore?.toFixed(1) ?? '-';
    const K = entry.generationsPerScenario ?? '-';
    const J = entry.judgesPerGeneration ?? run.judgeCount;
    lines.push(
      `| ${entry.label} | ${entry.model} | ${acceptPct} | ${entry.avgScore?.toFixed(1) ?? '-'} | ${stdev} | ${passRatePct} | ${proseAvg} | ${codeAvg} | ${K} | ${J} | ${run.runId} |`,
    );
  }
  lines.push('');

  // ── Pairwise Comparison ────────────────────────────────────────────
  // Only for configs with scenario-level accept data
  const pairableConfigs = scoredConfigs.filter(
    sc => sc.entry.scenarioScores?.some(s => s.accept !== undefined),
  );

  if (pairableConfigs.length >= 2) {
    lines.push('## Pairwise Comparison');
    lines.push('');
    lines.push('Per-scenario win/loss/tie on accept rate with sign test p-value.');
    lines.push('');
    lines.push('| Config A | Config B | A Wins | B Wins | Ties | p-value | Significant |');
    lines.push('|----------|----------|--------|--------|------|---------|-------------|');

    for (let i = 0; i < pairableConfigs.length; i++) {
      for (let j = i + 1; j < pairableConfigs.length; j++) {
        const a = pairableConfigs[i];
        const b = pairableConfigs[j];
        const aScores = new Map((a.entry.scenarioScores ?? []).map(s => [s.id, s]));
        const bScores = new Map((b.entry.scenarioScores ?? []).map(s => [s.id, s]));

        let aWins = 0, bWins = 0, ties = 0;
        for (const [id, aScore] of aScores) {
          const bScore = bScores.get(id);
          if (!bScore) continue;
          const aAccept = aScore.accept ? 1 : 0;
          const bAccept = bScore.accept ? 1 : 0;
          if (aAccept > bAccept) aWins++;
          else if (bAccept > aAccept) bWins++;
          else ties++;
        }

        const total = aWins + bWins; // ties excluded from sign test
        const pValue = signTestPValue(Math.max(aWins, bWins), total);
        const sig = pValue < 0.05 ? 'Yes' : 'No';

        const aLabel = `${a.entry.label} (${a.run.runId})`;
        const bLabel = `${b.entry.label} (${b.run.runId})`;
        lines.push(
          `| ${aLabel} | ${bLabel} | ${aWins} | ${bWins} | ${ties} | ${pValue.toFixed(3)} | ${sig} |`,
        );
      }
    }
    lines.push('');
  }

  // ── Failure Modes ──────────────────────────────────────────────────
  const failureScenarios: { config: string; scenarioId: string; acceptRate: number; score: number }[] = [];
  for (const { entry } of scoredConfigs) {
    if (!entry.scenarioAggregations) continue;
    for (const agg of entry.scenarioAggregations) {
      if (agg.acceptRate < 0.5) {
        failureScenarios.push({
          config: entry.label,
          scenarioId: agg.scenarioId,
          acceptRate: agg.acceptRate,
          score: agg.meanScore,
        });
      }
    }
  }

  if (failureScenarios.length > 0) {
    failureScenarios.sort((a, b) => a.acceptRate - b.acceptRate);
    lines.push('## Failure Modes');
    lines.push('');
    lines.push('Scenarios with accept rate < 50%:');
    lines.push('');
    lines.push('| Config | Scenario | Accept Rate | Avg Score |');
    lines.push('|--------|----------|-------------|-----------|');
    for (const f of failureScenarios) {
      lines.push(`| ${f.config} | ${f.scenarioId} | ${(f.acceptRate * 100).toFixed(0)}% | ${f.score.toFixed(1)} |`);
    }
    lines.push('');
  }

  // ── High-Variance Scenarios ────────────────────────────────────────
  const highVariance: { config: string; scenarioId: string; stdev: number; meanScore: number }[] = [];
  for (const { entry } of scoredConfigs) {
    if (!entry.scenarioAggregations) continue;
    for (const agg of entry.scenarioAggregations) {
      if (agg.stdev > 2.0) {
        highVariance.push({
          config: entry.label,
          scenarioId: agg.scenarioId,
          stdev: agg.stdev,
          meanScore: agg.meanScore,
        });
      }
    }
  }

  if (highVariance.length > 0) {
    highVariance.sort((a, b) => b.stdev - a.stdev);
    lines.push('## High-Variance Scenarios');
    lines.push('');
    lines.push('Scenarios with score stdev > 2.0 within a config:');
    lines.push('');
    lines.push('| Config | Scenario | Stdev | Mean Score |');
    lines.push('|--------|----------|-------|------------|');
    for (const v of highVariance) {
      lines.push(`| ${v.config} | ${v.scenarioId} | ${v.stdev.toFixed(2)} | ${v.meanScore.toFixed(1)} |`);
    }
    lines.push('');
  }

  // ── v1 backward compat note ────────────────────────────────────────
  const v1Configs = scoredConfigs.filter(sc => sc.entry.acceptRate === undefined);
  if (v1Configs.length > 0) {
    lines.push('## Note');
    lines.push('');
    lines.push(`${v1Configs.length} config(s) from v1 ledger entries lack accept rate data. They appear with "-" in accept columns and are excluded from pairwise comparison.`);
    lines.push('');
  }

  return lines.join('\n');
}

/** Write the comparison report to disk. */
export function writeComparisonReport(runIds?: string[]): string {
  const report = generateComparisonReport(runIds);
  fs.mkdirSync(BENCHMARKS_DIR, { recursive: true });
  fs.writeFileSync(REPORT_PATH, report);
  return REPORT_PATH;
}

// ── Standalone entry point ───────────────────────────────────────────
if (require.main === module) {
  const reportPath = writeComparisonReport();
  console.log(`Comparison report written to: ${reportPath}`);
}
