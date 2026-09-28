/**
 * latency-report.ts — p50/p90/p95 completion latency from the usage ledger, per backend
 * and model, printed as markdown. Read-only. Logic lives in `src/utils/latency-stats.ts`.
 *
 * Usage:
 *   npm run latency-report                          # ~/.bespokeai/usage-ledger*.jsonl
 *   npm run latency-report -- path/a.jsonl b.jsonl  # explicit files
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildReport, renderMarkdown } from '../utils/latency-stats';

function defaultLedgerPaths(): string[] {
  const dir = path.join(os.homedir(), '.bespokeai');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^usage-ledger.*\.jsonl$/.test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

const paths = process.argv.length > 2 ? process.argv.slice(2) : defaultLedgerPaths();
if (paths.length === 0) {
  console.error('No ledger files found (expected ~/.bespokeai/usage-ledger*.jsonl).');
  process.exit(1);
}

const lines = paths.flatMap((p) => fs.readFileSync(p, 'utf-8').split('\n'));
console.log(`Ledger files: ${paths.length}\n`);
process.stdout.write(renderMarkdown(buildReport(lines)));
