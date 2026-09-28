#!/usr/bin/env tsx
/**
 * Build the judge-validation sample: ~100 completions from existing quality
 * runs for a human to label pass/fail blind, so the LLM judge's TPR/TNR can
 * be measured against those labels (see evals/judge-validation/README.md).
 *
 * Makes NO model calls. Reads judged scenario folders (those with a
 * parseable validation.md) under test-results/quality-*, skipping every
 * regression-* scenario (captured from real usage; private).
 *
 * Writes (under evals/judge-validation/):
 *   sample.json          — what the human sees. No verdicts, no run names.
 *   judge-verdicts.json  — judge verdict + deterministic checks per id.
 *   labels.csv           — id,split,human_pass,notes template.
 *   label.html           — labeling page with sample.json inlined.
 *
 * Usage:
 *   npm run judge:sample                          # ../bespoke-ai-vscode-ext/test-results
 *   npm run judge:sample -- --results <dir> [--n 100] [--dev 40] [--seed 20260927] [--force]
 *
 * Refuses to replace sample.json / labels.csv once labels.csv has any label,
 * unless --force (which still never overwrites a labeled labels.csv).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CheckResult, runDeterministicChecks, CheckScenarioFlags } from '../deterministic-checks';
import { parseJudgePass } from '../rescore';
import { parseCsv } from './score';
import type { TestScenario } from '../judge';
import {
  proseScenarios,
  codeScenarios,
  edgeCaseScenarios,
  reuseQualityScenarios,
} from '../scenarios';
import {
  proseMidDocumentScenarios,
  proseJournalScenarios,
  proseBridgingScenarios,
  codeMidFileScenarios,
  prosePromptWritingScenarios,
  proseFullWindowScenarios,
  codeFullWindowScenarios,
  customInstructionScenarios,
} from '../scenarios/index';

const REPO = path.resolve(__dirname, '../../../..');
const OUT_DIR = path.join(REPO, 'evals/judge-validation');
const TEMPLATE = path.join(__dirname, 'label.template.html');
const NULL_SENTINEL = '(null — provider returned no completion)';

/** Context shown to the human around the completion. */
const PREFIX_CHARS = 600;
const SUFFIX_CHARS = 300;
/** Nulls are trivial to label and say little about the judge. */
const MAX_NULLS = 6;
/** Spread across scenarios: at most this many items per scenario id. */
const MAX_PER_SCENARIO = 2;

// ─── Scenario source (category + current flags) ─────────────────────

const CATEGORY_ARRAYS: Array<[string, TestScenario[]]> = [
  ['standard-prose', proseScenarios],
  ['standard-code', codeScenarios],
  ['edge-case', edgeCaseScenarios],
  ['reuse', reuseQualityScenarios],
  ['prose-mid-document', proseMidDocumentScenarios],
  ['prose-journal', proseJournalScenarios],
  ['prose-bridging', proseBridgingScenarios],
  ['code-mid-file', codeMidFileScenarios],
  ['prose-prompt-writing', prosePromptWritingScenarios],
  ['prose-full-window', proseFullWindowScenarios],
  ['code-full-window', codeFullWindowScenarios],
  ['custom-instructions', customInstructionScenarios],
];

const SOURCE = new Map<string, { category: string; flags: CheckScenarioFlags }>();
for (const [category, arr] of CATEGORY_ARRAYS) {
  for (const s of arr) SOURCE.set(s.id, { category, flags: s });
}

/** Category for ids no longer in source (older runs): from the id prefix. */
export function categoryFromId(id: string, mode: 'prose' | 'code'): string {
  const rules: Array<[RegExp, string]> = [
    [/^ci-/, 'custom-instructions'],
    [/^prose-journal|^jnl-/, 'prose-journal'],
    [/^prose-mid-|^prose-middoc/, 'prose-mid-document'],
    [/^prose-bridg/, 'prose-bridging'],
    [/^prose-prompt/, 'prose-prompt-writing'],
    [/^prose-full-/, 'prose-full-window'],
    [/^code-full-/, 'code-full-window'],
    [/^code-mid-/, 'code-mid-file'],
    [/^edge-/, 'edge-case'],
    [/^reuse-/, 'reuse'],
  ];
  for (const [re, cat] of rules) if (re.test(id)) return cat;
  return mode === 'code' ? 'standard-code' : 'standard-prose';
}

// ─── Seeded RNG ─────────────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ─── Candidates ─────────────────────────────────────────────────────

type Bucket = 'judge-fail' | 'judge-pass-det-fail' | 'judge-pass-det-pass';

interface Instance {
  run: string;
  judge_pass: boolean;
  judge_score: number | null;
  model: string;
}

interface Candidate {
  id: string;
  scenarioId: string;
  description: string;
  category: string;
  mode: 'prose' | 'code';
  languageId: string;
  fileName: string;
  model: string;
  prefix: string;
  suffix: string;
  completion: string | null;
  qualityNotes: string;
  customInstructions?: string;
  primary: Instance;
  instances: Instance[];
  checks: CheckResult[];
  bucket: Bucket;
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

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function parseScore(text: string): number | null {
  const m =
    text.match(/"score"\s*:\s*(\d+(?:\.\d+)?)/) ??
    text.match(/\*\*Score:?\*\*:?\s*(\d+(?:\.\d+)?)/i);
  return m ? Number(m[1]) : null;
}

const itemId = (scenarioId: string, completion: string | null): string =>
  'jv-' +
  crypto
    .createHash('sha256')
    .update(scenarioId + '\u0000' + (completion ?? '\u0000null'))
    .digest('hex')
    .slice(0, 8);

/**
 * Every judged, non-regression scenario across all runs, deduplicated on
 * (scenario id, completion). The primary instance is the most recent run;
 * all instances are kept so verdict disagreements stay visible.
 */
export function collectCandidates(resultsDir: string): Candidate[] {
  const runs = fs
    .readdirSync(resultsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('quality-'))
    .map((d) => d.name)
    .sort(); // timestamp-named → chronological

  const byKey = new Map<string, Candidate>();
  for (const run of runs) {
    const runDir = path.join(resultsDir, run);
    const summary = readJson(path.join(runDir, 'summary.json'));
    for (const d of fs.readdirSync(runDir, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith('regression-')) continue;
      const dir = path.join(runDir, d.name);
      const validation = readIf(path.join(dir, 'validation.md'));
      const input = readJson(path.join(dir, 'input.json'));
      if (validation === undefined || input === undefined) continue;
      const judge = parseJudgePass(validation);
      if (judge === null) continue;

      const meta = readJson(path.join(dir, 'metadata.json')) ?? {};
      const req = readJson(path.join(dir, 'requirements.json')) ?? {};
      const completionText = readIf(path.join(dir, 'completion.txt'));
      const completion =
        completionText === undefined || completionText === NULL_SENTINEL ? null : completionText;
      const mode: 'prose' | 'code' = input.mode === 'code' ? 'code' : 'prose';
      const prefix = str(input.prefix);
      const suffix = str(input.suffix);
      const src = SOURCE.get(d.name);
      const checks = runDeterministicChecks({
        mode,
        prefix,
        suffix,
        completion,
        rawResponse: readIf(path.join(dir, 'raw-response.txt')),
        providerError: meta.error !== null && meta.error !== undefined,
        scenario: src?.flags,
      });
      const model = str(summary?.model) || str(meta.model) || '(unknown)';
      const instance: Instance = {
        run,
        judge_pass: judge,
        judge_score: parseScore(validation),
        model,
      };
      const key = itemId(d.name, completion);
      // Most recent run wins: the whole candidate (context, checks, model)
      // comes from it; earlier verdicts are kept as instances.
      const earlier = byKey.get(key)?.instances ?? [];
      byKey.set(key, {
        id: key,
        scenarioId: d.name,
        description: str(meta.description),
        category: src?.category ?? categoryFromId(d.name, mode),
        mode,
        languageId: str(input.languageId),
        fileName: str(input.fileName),
        model,
        prefix,
        suffix,
        completion,
        qualityNotes: str(req.quality_notes),
        customInstructions: str(input.customInstructions) || undefined,
        primary: instance,
        instances: [...earlier, instance],
        checks,
        bucket: 'judge-pass-det-pass', // set below
      });
    }
  }
  const out = [...byKey.values()];
  for (const c of out) c.bucket = bucketOf(c.primary.judge_pass, c.checks);
  return out;
}

export function bucketOf(judgePass: boolean, checks: CheckResult[]): Bucket {
  if (!judgePass) return 'judge-fail';
  return checks.every((c) => c.pass) ? 'judge-pass-det-pass' : 'judge-pass-det-fail';
}

// ─── Stratified selection ───────────────────────────────────────────

/**
 * Pick `quota` candidates from one bucket: round-robin over model×mode
 * strata (so no model dominates), and within a stratum prefer the
 * candidate whose category and scenario are least represented so far.
 */
function pickFromBucket(
  pool: Candidate[],
  quota: number,
  rand: () => number,
  state: { perCategory: Map<string, number>; perScenario: Map<string, number>; nulls: number },
): Candidate[] {
  const strata = new Map<string, Candidate[]>();
  for (const c of shuffle(pool, rand)) {
    const k = `${c.model}|${c.mode}`;
    if (!strata.has(k)) strata.set(k, []);
    strata.get(k)!.push(c);
  }
  const keys = shuffle([...strata.keys()], rand);
  const picked: Candidate[] = [];
  let progress = true;
  while (picked.length < quota && progress) {
    progress = false;
    for (const k of keys) {
      if (picked.length >= quota) break;
      const group = strata.get(k)!;
      const eligible = group.filter(
        (c) =>
          (state.perScenario.get(c.scenarioId) ?? 0) < MAX_PER_SCENARIO &&
          (c.completion !== null || state.nulls < MAX_NULLS),
      );
      if (eligible.length === 0) continue;
      eligible.sort(
        (a, b) =>
          (state.perCategory.get(a.category) ?? 0) - (state.perCategory.get(b.category) ?? 0) ||
          (state.perScenario.get(a.scenarioId) ?? 0) - (state.perScenario.get(b.scenarioId) ?? 0),
      );
      const c = eligible[0];
      group.splice(group.indexOf(c), 1);
      picked.push(c);
      state.perCategory.set(c.category, (state.perCategory.get(c.category) ?? 0) + 1);
      state.perScenario.set(c.scenarioId, (state.perScenario.get(c.scenarioId) ?? 0) + 1);
      if (c.completion === null) state.nulls++;
      progress = true;
    }
  }
  return picked;
}

/**
 * Bucket quotas aim for roughly balanced TRUE pass/fail: judge-fails and
 * judge-passes that a deterministic check flags are mostly real failures,
 * so they are oversampled relative to their share of the runs.
 */
export function selectSample(all: Candidate[], n: number, seed: number): Candidate[] {
  const rand = mulberry32(seed);
  const quotas: Array<[Bucket, number]> = [
    ['judge-fail', Math.round(n * 0.3)],
    ['judge-pass-det-fail', Math.round(n * 0.25)],
    ['judge-pass-det-pass', 0], // remainder
  ];
  const state = { perCategory: new Map(), perScenario: new Map(), nulls: 0 };
  const picked: Candidate[] = [];
  for (const [bucket, q] of quotas) {
    const quota = bucket === 'judge-pass-det-pass' ? n - picked.length : q;
    const pool = all.filter((c) => c.bucket === bucket && !picked.includes(c));
    picked.push(...pickFromBucket(pool, quota, rand, state));
  }
  if (picked.length < n) {
    // A bucket ran short: fill from whatever is left.
    const rest = all.filter((c) => !picked.includes(c));
    picked.push(...pickFromBucket(rest, n - picked.length, rand, state));
  }
  return picked;
}

/**
 * Split stratified by bucket × mode: order items by stratum, then assign
 * dev by systematic sampling so each stratum gets ~devN/n of its items and
 * the total is exactly devN.
 */
export function assignSplits(
  items: Array<{ id: string; stratum: string }>,
  devN: number,
  seed: number,
): Map<string, 'dev' | 'test'> {
  const rand = mulberry32(seed ^ 0x5eed);
  const order = shuffle(items, rand).sort((a, b) => a.stratum.localeCompare(b.stratum));
  const frac = devN / items.length;
  const offset = rand();
  const out = new Map<string, 'dev' | 'test'>();
  order.forEach((it, i) => {
    const dev = Math.floor((i + 1) * frac + offset) > Math.floor(i * frac + offset);
    out.set(it.id, dev ? 'dev' : 'test');
  });
  return out;
}

// ─── Rendering for the human ────────────────────────────────────────

/** Tail of the prefix, snapped forward to a line start when one is close. */
export function prefixTail(prefix: string, chars = PREFIX_CHARS): string {
  if (prefix.length <= chars) return prefix;
  let tail = prefix.slice(-chars);
  const nl = tail.indexOf('\n');
  if (nl !== -1 && nl < chars / 3) tail = tail.slice(nl + 1);
  return '…' + tail;
}

/** Head of the suffix, snapped back to a line end when one is close. */
export function suffixHead(suffix: string, chars = SUFFIX_CHARS): string {
  if (suffix.length <= chars) return suffix;
  let head = suffix.slice(0, chars);
  const nl = head.lastIndexOf('\n');
  if (nl !== -1 && nl > (chars * 2) / 3) head = head.slice(0, nl);
  return head + '…';
}

// ─── Labels guard ───────────────────────────────────────────────────

/** True when labels.csv exists and any row has a human_pass value (incl. unsure). */
export function hasAnyLabel(csv: string | undefined): boolean {
  if (!csv) return false;
  const rows = parseCsv(csv);
  const i = rows[0]?.indexOf('human_pass') ?? -1;
  return i !== -1 && rows.slice(1).some((r) => (r[i] ?? '').trim() !== '');
}

// ─── Main ───────────────────────────────────────────────────────────

function main(argv: string[]): void {
  let resultsDir = path.resolve(REPO, '../bespoke-ai-vscode-ext/test-results');
  let n = 100;
  let devN = 40;
  let seed = 20260927;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--results') resultsDir = path.resolve(argv[++i]);
    else if (a === '--n') n = Number(argv[++i]);
    else if (a === '--dev') devN = Number(argv[++i]);
    else if (a === '--seed') seed = Number(argv[++i]);
    else if (a === '--force') force = true;
    else throw new Error(`unknown argument: ${a}`);
  }

  const labelsPath = path.join(OUT_DIR, 'labels.csv');
  const labeled = hasAnyLabel(readIf(labelsPath));
  if (labeled && !force) {
    console.error(
      'labels.csv already has labels; refusing to rebuild the sample (ids could change under them).\n' +
        'Re-run with --force to rebuild sample.json / judge-verdicts.json / label.html; labels.csv is kept.',
    );
    process.exit(1);
  }

  const all = collectCandidates(resultsDir);
  const picked = selectSample(all, n, seed);
  const splits = assignSplits(
    picked.map((c) => ({ id: c.id, stratum: `${c.bucket}|${c.mode}|${c.model}` })),
    Math.min(devN, picked.length),
    seed,
  );
  // Blind order: seeded shuffle, independent of bucket.
  const ordered = shuffle(picked, mulberry32(seed ^ 0xb11d));

  const sample = ordered.map((c) => ({
    id: c.id,
    split: splits.get(c.id)!,
    scenario_id: c.scenarioId,
    category: c.category,
    mode: c.mode,
    language: c.languageId,
    file_name: c.fileName,
    model: c.model,
    description: c.description,
    intent: c.qualityNotes,
    ...(c.customInstructions ? { custom_instructions: c.customInstructions } : {}),
    prefix_tail: prefixTail(c.prefix),
    completion: c.completion,
    suffix_head: suffixHead(c.suffix),
    rendered: `${prefixTail(c.prefix)}⟦${c.completion ?? ''}⟧${suffixHead(c.suffix)}`,
  }));

  const verdicts = Object.fromEntries(
    ordered.map((c) => [
      c.id,
      {
        split: splits.get(c.id)!,
        scenario_id: c.scenarioId,
        model: c.model,
        bucket: c.bucket,
        judge_pass: c.primary.judge_pass,
        judge_score: c.primary.judge_score,
        primary_run: c.primary.run,
        instances: c.instances,
        judge_disagreement: new Set(c.instances.map((i) => i.judge_pass)).size > 1,
        det_pass: c.checks.every((k) => k.pass),
        checks: c.checks,
      },
    ]),
  );

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const meta = {
    generated_by: 'src/test/quality/judge-validation/build-sample.ts',
    seed,
    n: sample.length,
    dev: sample.filter((s) => s.split === 'dev').length,
    test: sample.filter((s) => s.split === 'test').length,
    candidates: all.length,
    source: 'test-results/quality-* (judged folders only; regression-* excluded)',
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'sample.json'),
    JSON.stringify({ meta, items: sample }, null, 2) + '\n',
  );
  fs.writeFileSync(
    path.join(OUT_DIR, 'judge-verdicts.json'),
    JSON.stringify({ meta, verdicts }, null, 2) + '\n',
  );
  if (!labeled) {
    fs.writeFileSync(
      labelsPath,
      'id,split,human_pass,notes\n' + sample.map((s) => `${s.id},${s.split},,`).join('\n') + '\n',
    );
  }
  // Inline-safe JSON: no `</script>`, no raw U+2028/U+2029.
  const LS = String.fromCharCode(0x2028);
  const PS = String.fromCharCode(0x2029);
  const json = JSON.stringify(sample)
    .replace(/</g, '\\u003c')
    .split(LS)
    .join('\\u2028')
    .split(PS)
    .join('\\u2029');
  const html = fs.readFileSync(TEMPLATE, 'utf8').replace('/*__SAMPLE__*/ []', () => json);
  fs.writeFileSync(path.join(OUT_DIR, 'label.html'), html);

  printComposition(ordered, splits, all.length);
}

function printComposition(
  items: Candidate[],
  splits: Map<string, 'dev' | 'test'>,
  candidates: number,
): void {
  const tally = (key: (c: Candidate) => string) => {
    const m = new Map<string, { dev: number; test: number }>();
    for (const c of items) {
      const k = key(c);
      if (!m.has(k)) m.set(k, { dev: 0, test: 0 });
      m.get(k)![splits.get(c.id)!]++;
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  };
  console.log(`candidates (judged, non-regression, deduped): ${candidates}`);
  console.log(`sample: ${items.length}\n`);
  for (const [title, key] of [
    ['bucket', (c: Candidate) => c.bucket],
    ['mode', (c: Candidate) => c.mode],
    ['model', (c: Candidate) => c.model],
    ['category', (c: Candidate) => c.category],
  ] as Array<[string, (c: Candidate) => string]>) {
    console.log(`| ${title} | dev | test | total |\n| --- | --- | --- | --- |`);
    for (const [k, v] of tally(key))
      console.log(`| ${k} | ${v.dev} | ${v.test} | ${v.dev + v.test} |`);
    console.log('');
  }
  const nulls = items.filter((c) => c.completion === null).length;
  const disagree = items.filter((c) => new Set(c.instances.map((i) => i.judge_pass)).size > 1);
  console.log(
    `null completions: ${nulls}; judge disagreed across runs on ${disagree.length} item(s)`,
  );
}

if (require.main === module) {
  main(process.argv.slice(2));
}
