#!/usr/bin/env tsx
/**
 * Rescore existing quality runs with the deterministic checks.
 *
 * Makes NO model calls. Reads each scenario folder's input.json (truncated
 * prefix/suffix as sent), completion.txt, raw-response.txt and metadata.json,
 * runs deterministic-checks.ts, and — where Layer 2 validation.md files exist —
 * combines them with the judge verdict.
 *
 * Usage:
 *   npm run test:quality:rescore                             # ./test-results
 *   npm run test:quality:rescore -- <run-dir|results-dir>... [--out table.md] [--verbose]
 *   npm run test:quality:rescore -- <dirs> --write-artifacts # also write checks.json/rendered.txt
 *
 * Scenario flags (mid_word, max_completion_chars, expect_empty_ok,
 * must_not_start_with) come from the CURRENT scenario source, looked up by id.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  CHECK_IDS,
  CheckId,
  CheckInput,
  CheckResult,
  CheckScenarioFlags,
  runDeterministicChecks,
  summarizeChecks,
} from './deterministic-checks';
import { writeCheckArtifacts } from './run-artifacts';
import {
  proseScenarios,
  codeScenarios,
  edgeCaseScenarios,
  reuseQualityScenarios,
} from './scenarios';
import { regressionScenarios } from './regression-scenarios';
import {
  proseMidDocumentScenarios,
  proseJournalScenarios,
  proseBridgingScenarios,
  codeMidFileScenarios,
  prosePromptWritingScenarios,
  proseFullWindowScenarios,
  codeFullWindowScenarios,
  customInstructionScenarios,
} from './scenarios/index';

const NULL_SENTINEL = '(null — provider returned no completion)';

const SCENARIOS: Map<string, CheckScenarioFlags> = new Map(
  [
    ...proseScenarios,
    ...codeScenarios,
    ...edgeCaseScenarios,
    ...reuseQualityScenarios,
    ...regressionScenarios,
    ...proseMidDocumentScenarios,
    ...proseJournalScenarios,
    ...proseBridgingScenarios,
    ...codeMidFileScenarios,
    ...prosePromptWritingScenarios,
    ...proseFullWindowScenarios,
    ...codeFullWindowScenarios,
    ...customInstructionScenarios,
  ].map((s) => [s.id, s]),
);

// ─── validation.md parsing ──────────────────────────────────────────

/**
 * Judge verdict from a validation.md. Historical files use several formats:
 * leading JSON, `**Result: PASS**`, `**Verdict:** PASS`, `- **Pass:** YES`.
 * Returns null when no verdict can be found (never guesses).
 */
export function parseJudgePass(text: string): boolean | null {
  const patterns: Array<[RegExp, (m: RegExpMatchArray) => boolean]> = [
    [/"pass"\s*:\s*(true|false)/, (m) => m[1] === 'true'],
    [/\*\*Pass:?\*\*:?\s*(YES|NO|PASS|FAIL|true|false)/i, (m) => /^(yes|pass|true)$/i.test(m[1])],
    [/\*\*Result:?\*?\*?:?\s*(PASS|FAIL)/i, (m) => /^pass$/i.test(m[1])],
    [/\*\*Verdict:?\*\*:?\s*(PASS|FAIL)/i, (m) => /^pass$/i.test(m[1])],
  ];
  for (const [re, f] of patterns) {
    const m = text.match(re);
    if (m) return f(m);
  }
  return null;
}

// ─── Per-run scoring ────────────────────────────────────────────────

interface ScenarioScore {
  id: string;
  checks: CheckResult[];
  judge: boolean | null | undefined; // undefined = no validation.md
  flagsFound: boolean;
}

export interface RunScore {
  run: string;
  model: string;
  n: number;
  withRaw: number;
  judged: number;
  judgePass: number;
  judgeUnparsed: number;
  detFailed: number;
  counts: ReturnType<typeof summarizeChecks>;
  combinedPass: number;
  unknownScenarioIds: number;
  scenarios: ScenarioScore[];
}

const readIf = (f: string): string | undefined =>
  fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : undefined;

function readJson(f: string): Record<string, unknown> | undefined {
  const t = readIf(f);
  if (t === undefined) return undefined;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function scoreRun(runDir: string, writeArtifacts = false): RunScore {
  const dirs = fs
    .readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(runDir, d.name, 'input.json')))
    .map((d) => d.name)
    .sort();

  const summary = readJson(path.join(runDir, 'summary.json'));
  let model = typeof summary?.model === 'string' ? summary.model : '';

  const scenarios: ScenarioScore[] = [];
  let withRaw = 0;
  for (const id of dirs) {
    const dir = path.join(runDir, id);
    const input = readJson(path.join(dir, 'input.json')) ?? {};
    const meta = readJson(path.join(dir, 'metadata.json')) ?? {};
    if (!model && typeof meta.model === 'string') model = meta.model;
    const completionText = readIf(path.join(dir, 'completion.txt'));
    const completion =
      completionText === undefined || completionText === NULL_SENTINEL ? null : completionText;
    const raw = readIf(path.join(dir, 'raw-response.txt'));
    if (raw !== undefined) withRaw++;
    const flags = SCENARIOS.get(id);
    const checkInput: CheckInput = {
      mode: input.mode === 'code' ? 'code' : 'prose',
      prefix: typeof input.prefix === 'string' ? input.prefix : '',
      suffix: typeof input.suffix === 'string' ? input.suffix : '',
      completion,
      rawResponse: raw,
      providerError: meta.error !== null && meta.error !== undefined,
      scenario: flags,
    };
    const checks = writeArtifacts
      ? writeCheckArtifacts(dir, checkInput)
      : runDeterministicChecks(checkInput);
    const validation = readIf(path.join(dir, 'validation.md'));
    scenarios.push({
      id,
      checks,
      judge: validation === undefined ? undefined : parseJudgePass(validation),
      flagsFound: flags !== undefined,
    });
  }

  const judgedList = scenarios.filter((s) => s.judge !== undefined);
  const detOk = (s: ScenarioScore) => s.checks.every((c) => c.pass);
  return {
    run: path.basename(runDir),
    model: model || '(unknown)',
    n: scenarios.length,
    withRaw,
    judged: judgedList.filter((s) => s.judge !== null).length,
    judgePass: judgedList.filter((s) => s.judge === true).length,
    judgeUnparsed: judgedList.filter((s) => s.judge === null).length,
    detFailed: scenarios.filter((s) => !detOk(s)).length,
    counts: summarizeChecks(scenarios.map((s) => s.checks)),
    combinedPass: judgedList.filter((s) => s.judge === true && detOk(s)).length,
    unknownScenarioIds: scenarios.filter((s) => !s.flagsFound).length,
    scenarios,
  };
}

// ─── Markdown ───────────────────────────────────────────────────────

const SHORT: Record<CheckId, string> = {
  'non-empty': 'non-empty',
  'boundary-whitespace': 'boundary-ws',
  'double-space': 'double-space',
  'suffix-echo': 'suffix-echo',
  'journal-date': 'journal-date',
  'over-length': 'over-length',
  'must-not-start-with': 'must-not-start',
};

const pct = (a: number, b: number): string =>
  b === 0 ? '—' : `${a}/${b} (${((100 * a) / b).toFixed(1)}%)`;

export function renderTable(scores: RunScore[]): string {
  const head = [
    'Run',
    'Backend/model',
    'n',
    'raw',
    'Judge pass',
    'Det. fail (any)',
    ...CHECK_IDS.map((id) => SHORT[id]),
    'Combined pass',
  ];
  const lines = [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const s of scores) {
    const judged = s.judged + s.judgeUnparsed;
    const judgeCell =
      judged === 0
        ? '—'
        : pct(s.judgePass, s.judged) + (s.judgeUnparsed ? ` +${s.judgeUnparsed} unparsed` : '');
    const cells = [
      s.run.replace(/^quality-/, ''),
      s.model,
      String(s.n),
      String(s.withRaw),
      judgeCell,
      String(s.detFailed),
      ...CHECK_IDS.map((id) => {
        const c = s.counts[id];
        return c.applied === 0 ? '—' : `${c.failed}/${c.applied}`;
      }),
      s.judged === 0 ? '—' : pct(s.combinedPass, s.judged),
    ];
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

// ─── CLI ────────────────────────────────────────────────────────────

function findRunDirs(target: string): string[] {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) throw new Error(`No such path: ${abs}`);
  const isRun = fs
    .readdirSync(abs, { withFileTypes: true })
    .some((d) => d.isDirectory() && fs.existsSync(path.join(abs, d.name, 'input.json')));
  if (isRun) return [abs];
  return fs
    .readdirSync(abs, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('quality-'))
    .map((d) => path.join(abs, d.name))
    .sort();
}

function main(argv: string[]): void {
  let out: string | undefined;
  let verbose = false;
  let writeArtifacts = false;
  const targets: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--verbose') verbose = true;
    else if (a === '--write-artifacts') writeArtifacts = true;
    else targets.push(a);
  }
  if (targets.length === 0) targets.push('test-results');

  const runs = targets.flatMap(findRunDirs);
  const all = runs.map((r) => scoreRun(r, writeArtifacts));
  // Runs with no raw responses at all (e.g. every call errored) can't be
  // rescored meaningfully.
  const scores = all.filter((s) => s.withRaw > 0);
  if (scores.length < all.length) {
    console.error(`Skipped ${all.length - scores.length} run(s) with no raw-response.txt`);
  }

  const table = renderTable(scores);
  console.log(table);
  if (verbose) {
    for (const s of scores) {
      console.log(`\n## ${s.run}`);
      for (const id of CHECK_IDS) {
        const failed = s.scenarios.filter((sc) => sc.checks.some((c) => c.id === id && !c.pass));
        if (failed.length === 0) continue;
        console.log(`\n${id} (${failed.length}):`);
        for (const sc of failed) {
          const c = sc.checks.find((x) => x.id === id);
          console.log(`  ${sc.id}: ${c?.detail}`);
        }
      }
    }
  }
  if (out) {
    fs.writeFileSync(out, table + '\n');
    console.log(`\nWrote ${out}`);
  }
}

if (require.main === module) {
  main(process.argv.slice(2));
}
