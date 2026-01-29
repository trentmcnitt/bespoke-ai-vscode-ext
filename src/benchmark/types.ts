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

/** One of K completions for a single scenario. */
export interface GenerationResult {
  index: number;
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
  accept?: boolean;
}

/** One judge's output for a single generation. */
export interface JudgmentFileResult {
  index: number;
  judgeModel: string;
  score: number;
  accept: boolean;
  pass: boolean;
  reasoning: string;
  criteria_results: JudgmentResult['criteria_results'];
}

/** A single judge's validation output for one scenario. */
export interface ValidationResult {
  scenarioId: string;
  judgeId: string;
  timestamp: string;
  pass: boolean;
  score: number;
  accept?: boolean;
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

/** Per-scenario aggregated stats across K generations × J judges. */
export interface ScenarioAggregation {
  scenarioId: string;
  mode: 'prose' | 'code';
  meanScore: number;
  stdev: number;
  acceptRate: number;
  passRate: number;
  generationCount: number;
  judgmentCount: number;
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
  acceptRate?: number;
  scoreStdev?: number;
  proseAvgScore?: number;
  codeAvgScore?: number;
  scenarioScores?: ScenarioScore[];
  generationsPerScenario?: number;
  judgesPerGeneration?: number;
  scenarioAggregations?: ScenarioAggregation[];
}

/** One benchmark run in the ledger. */
export interface BenchmarkLedgerEntry {
  runId: string;
  timestamp: string;
  judgeCount: number;
  totalScenarios: number;
  generationCount?: number;
  judgeModel?: string;
  automated?: boolean;
  configs: ConfigLedgerEntry[];
}

/** Top-level ledger structure. */
export interface BenchmarkLedger {
  version: number;
  runs: BenchmarkLedgerEntry[];
}
