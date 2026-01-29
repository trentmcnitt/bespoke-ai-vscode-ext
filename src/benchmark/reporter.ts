/**
 * Comparison report generator for benchmark runs.
 *
 * Reads scored ledger entries and generates a markdown report comparing
 * configs across runs.
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
    return '# Benchmark Comparison Report\n\nNo scored configs found. Run Layer 2 validation first.\n';
  }

  // Sort by avg score descending
  scoredConfigs.sort((a, b) => (b.entry.avgScore ?? 0) - (a.entry.avgScore ?? 0));

  const lines: string[] = [];
  lines.push('# Benchmark Comparison Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Scored configs: ${scoredConfigs.length}`);
  lines.push('');

  // ── Summary table ──────────────────────────────────────────────────
  lines.push('## Summary');
  lines.push('');
  lines.push('| Config | Model | Avg Score | Pass Rate | Prose Avg | Code Avg | Judges | Run |');
  lines.push('|--------|-------|-----------|-----------|-----------|----------|--------|-----|');

  for (const { entry, run } of scoredConfigs) {
    const passRatePct = entry.passRate !== undefined ? `${(entry.passRate * 100).toFixed(0)}%` : '-';
    const proseAvg = entry.proseAvgScore?.toFixed(1) ?? '-';
    const codeAvg = entry.codeAvgScore?.toFixed(1) ?? '-';
    lines.push(
      `| ${entry.label} | ${entry.model} | ${entry.avgScore?.toFixed(1) ?? '-'} | ${passRatePct} | ${proseAvg} | ${codeAvg} | ${run.judgeCount} | ${run.runId} |`,
    );
  }
  lines.push('');

  // ── High-variance scenarios ────────────────────────────────────────
  const scenarioMap = new Map<string, number[]>();
  for (const { entry } of scoredConfigs) {
    if (!entry.scenarioScores) continue;
    for (const ss of entry.scenarioScores) {
      if (!scenarioMap.has(ss.id)) scenarioMap.set(ss.id, []);
      scenarioMap.get(ss.id)!.push(ss.score);
    }
  }

  const highVariance: { id: string; min: number; max: number; range: number }[] = [];
  for (const [id, scores] of scenarioMap) {
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;
    if (range >= 2.0) {
      highVariance.push({ id, min, max, range });
    }
  }

  if (highVariance.length > 0) {
    highVariance.sort((a, b) => b.range - a.range);
    lines.push('## High-Variance Scenarios');
    lines.push('');
    lines.push('Scenarios with score range >= 2.0 across configs:');
    lines.push('');
    lines.push('| Scenario | Min | Max | Range |');
    lines.push('|----------|-----|-----|-------|');
    for (const v of highVariance) {
      lines.push(`| ${v.id} | ${v.min.toFixed(1)} | ${v.max.toFixed(1)} | ${v.range.toFixed(1)} |`);
    }
    lines.push('');
  }

  // ── Notable differences ────────────────────────────────────────────
  const notablePairs: { a: string; b: string; diff: number }[] = [];
  for (let i = 0; i < scoredConfigs.length; i++) {
    for (let j = i + 1; j < scoredConfigs.length; j++) {
      const a = scoredConfigs[i];
      const b = scoredConfigs[j];
      if (a.entry.avgScore === undefined || b.entry.avgScore === undefined) continue;
      const diff = Math.abs(a.entry.avgScore - b.entry.avgScore);
      if (diff >= 0.5) {
        notablePairs.push({
          a: `${a.entry.label} (${a.run.runId})`,
          b: `${b.entry.label} (${b.run.runId})`,
          diff,
        });
      }
    }
  }

  if (notablePairs.length > 0) {
    // Limit to top 20 most notable
    notablePairs.sort((a, b) => b.diff - a.diff);
    const topPairs = notablePairs.slice(0, 20);

    lines.push('## Notable Differences');
    lines.push('');
    lines.push('Config pairs with avg score difference >= 0.5:');
    lines.push('');
    lines.push('| Config A | Config B | Diff |');
    lines.push('|----------|----------|------|');
    for (const p of topPairs) {
      lines.push(`| ${p.a} | ${p.b} | ${p.diff.toFixed(1)} |`);
    }
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
