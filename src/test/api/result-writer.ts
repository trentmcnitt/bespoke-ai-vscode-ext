/**
 * Shared helper for persisting API integration test results to disk.
 *
 * All test files in a single `npm run test:api` invocation share one
 * timestamped directory under `test-results/api-{timestamp}/`.
 * A `latest-api` symlink always points to the most recent run.
 */
import * as fs from 'fs';
import * as path from 'path';

const RESULTS_DIR = path.resolve(__dirname, '../../../test-results');

/** Singleton run directory — created on first call, reused thereafter. */
let cachedRunDir: string | null = null;

/** Input context captured for a result file. */
export interface ApiResultInput {
  prefix: string;
  suffix: string;
  languageId: string;
  fileName: string;
  mode: string;
}

/** Shape written to each per-test JSON file. */
export interface ApiResult {
  test: string;
  backend: string;
  input: ApiResultInput;
  completion: string | null;
  durationMs: number;
  timestamp: string;
}

/**
 * Get (or create) the shared run directory for this test invocation.
 * First call creates `test-results/api-{timestamp}/` and sets the
 * `latest-api` symlink. Subsequent calls return the same path.
 */
export function getApiRunDir(): string {
  if (cachedRunDir) return cachedRunDir;

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = path.join(RESULTS_DIR, `api-${ts}`);
  fs.mkdirSync(runDir, { recursive: true });

  const latestPath = path.join(RESULTS_DIR, 'latest-api');
  try {
    fs.unlinkSync(latestPath);
  } catch {
    /* may not exist */
  }
  try {
    fs.symlinkSync(path.basename(runDir), latestPath);
  } catch {
    /* best effort */
  }

  cachedRunDir = runDir;
  return runDir;
}

/**
 * Build an ApiResult from common test values.
 * Extracts the input subset from CompletionContext (excludes filePath).
 */
export function buildApiResult(
  test: string,
  backend: string,
  ctx: { prefix: string; suffix: string; languageId: string; fileName: string; mode: string },
  completion: string | null,
  durationMs: number,
): ApiResult {
  return {
    test,
    backend,
    input: {
      prefix: ctx.prefix,
      suffix: ctx.suffix,
      languageId: ctx.languageId,
      fileName: ctx.fileName,
      mode: ctx.mode,
    },
    completion,
    durationMs,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Write a single test result JSON file.
 *
 * Creates the subdirectory if needed and writes
 * `{runDir}/{subdir}/{testName}.json`.
 */
export function saveApiResult(
  runDir: string,
  subdir: string,
  testName: string,
  data: ApiResult,
): void {
  const dir = path.join(runDir, subdir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${testName}.json`), JSON.stringify(data, null, 2));
}

/**
 * Write a summary JSON file for a specific backend/suite.
 * Writes `{runDir}/{name}-summary.json`.
 */
export function saveApiSummary(
  runDir: string,
  name: string,
  summary: Record<string, unknown>,
): void {
  fs.writeFileSync(path.join(runDir, `${name}-summary.json`), JSON.stringify(summary, null, 2));
}
