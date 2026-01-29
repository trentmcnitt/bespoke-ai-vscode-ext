import * as path from 'path';
import { ExtensionConfig } from '../types';
import { JudgmentResult } from '../test/quality/judge';

/** Root directory for all benchmark output. */
export const BENCHMARKS_DIR = path.join(__dirname, '..', '..', 'test-results', 'benchmarks');

/** A named config preset for benchmarking. */
export interface BenchmarkConfig {
  label: string;
  description: string;
  overrides: Partial<ExtensionConfig>;
}

/** Per-scenario generation result (Layer 1 output). */
export interface ScenarioGenerationResult {
  scenarioId: string;
  mode: 'prose' | 'code';
  completion: string | null;
  durationMs: number;
  error?: string;
}

/** Per-config result from a benchmark run. */
export interface ConfigRunResult {
  label: string;
  resolvedConfig: ExtensionConfig;
  scenarioResults: ScenarioGenerationResult[];
  totalDurationMs: number;
  successCount: number;
  errorCount: number;
}

/** Layer 2 score for a single scenario. */
export interface ScenarioScore {
  id: string;
  score: number;
  pass: boolean;
}

/** A single judge's validation output for one scenario. */
export interface ValidationResult {
  scenarioId: string;
  judgeId: string;
  timestamp: string;
  pass: boolean;
  score: number;
  reasoning: string;
  criteria_results: JudgmentResult['criteria_results'];
}

/** Multi-judge validation file structure. */
export interface ValidationFile {
  judges: ValidationResult[];
  aggregated: {
    avgScore: number;
    pass: boolean;
    judgeCount: number;
  };
}

/** One config entry in the ledger. */
export interface ConfigLedgerEntry {
  label: string;
  model: string;
  backend: string;
  overrides: Partial<ExtensionConfig>;
  scenarioCount: number;
  successCount: number;
  errorCount: number;
  totalDurationMs: number;
  /** Populated after Layer 2 scoring */
  avgScore?: number;
  passRate?: number;
  proseAvgScore?: number;
  codeAvgScore?: number;
  scenarioScores?: ScenarioScore[];
}

/** One benchmark run in the ledger. */
export interface BenchmarkLedgerEntry {
  runId: string;
  timestamp: string;
  judgeCount: number;
  totalScenarios: number;
  configs: ConfigLedgerEntry[];
}

/** Top-level ledger structure. */
export interface BenchmarkLedger {
  version: number;
  runs: BenchmarkLedgerEntry[];
}
