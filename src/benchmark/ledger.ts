import * as fs from 'fs';
import * as path from 'path';
import { BENCHMARKS_DIR, BenchmarkLedger, BenchmarkLedgerEntry, ScenarioScore } from './types';

const LEDGER_PATH = path.join(BENCHMARKS_DIR, 'ledger.json');
const LEDGER_VERSION = 2;

/** Load the ledger from disk, creating an empty one if it doesn't exist. */
export function loadLedger(): BenchmarkLedger {
  let data: string;
  try {
    data = fs.readFileSync(LEDGER_PATH, 'utf-8');
  } catch (err: unknown) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: LEDGER_VERSION, runs: [] };
    }
    throw err;
  }
  // Parse separately so malformed JSON throws instead of silently resetting
  return JSON.parse(data) as BenchmarkLedger;
}

/** Save the ledger to disk. */
function saveLedger(ledger: BenchmarkLedger): void {
  fs.mkdirSync(BENCHMARKS_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

/**
 * Append a complete run entry with scores already populated (automated pipeline).
 * Writes the full entry in one shot — no two-step append-then-update needed.
 */
export function appendFullRunToLedger(entry: BenchmarkLedgerEntry): void {
  const ledger = loadLedger();
  ledger.version = LEDGER_VERSION;
  ledger.runs.push(entry);
  saveLedger(ledger);
}

/**
 * Update a config entry in the ledger with Layer 2 scores.
 * Each scenario score is the average across judges when multi-judge.
 */
export function updateLedgerScores(
  runId: string,
  label: string,
  scores: {
    avgScore: number;
    passRate: number;
    proseAvgScore: number;
    codeAvgScore: number;
    scenarioScores: ScenarioScore[];
    acceptRate?: number;
    scoreStdev?: number;
  },
): void {
  const ledger = loadLedger();
  const run = ledger.runs.find(r => r.runId === runId);
  if (!run) throw new Error(`Run not found: ${runId}`);

  const config = run.configs.find(c => c.label === label);
  if (!config) throw new Error(`Config not found: ${label} in run ${runId}`);

  config.avgScore = scores.avgScore;
  config.passRate = scores.passRate;
  config.proseAvgScore = scores.proseAvgScore;
  config.codeAvgScore = scores.codeAvgScore;
  config.scenarioScores = scores.scenarioScores;
  if (scores.acceptRate !== undefined) config.acceptRate = scores.acceptRate;
  if (scores.scoreStdev !== undefined) config.scoreStdev = scores.scoreStdev;

  ledger.version = LEDGER_VERSION;
  saveLedger(ledger);
}

/** Return the most recent N runs from the ledger. */
export function getRecentRuns(limit: number = 10): BenchmarkLedgerEntry[] {
  const ledger = loadLedger();
  return ledger.runs.slice(-limit);
}
