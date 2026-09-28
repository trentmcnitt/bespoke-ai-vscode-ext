#!/usr/bin/env tsx
/**
 * Build the replay set: recorded real model outputs that the unit test
 * (src/test/unit/replay.test.ts) replays through the CURRENT extraction +
 * post-processing pipeline and deterministic checks. See evals/replay/README.md.
 *
 * Usage:
 *   npx tsx src/test/quality/replay/build-replay-set.ts [results-root] [--out file]
 *
 * results-root defaults to ~/working_dir/bespoke-ai-vscode-ext/test-results
 * (the gitignored quality-run folders in the main checkout).
 *
 * Makes no model calls. Deterministic: the same results root produces the same
 * fixture. Only synthetic scenarios are used — every `regression-*` scenario
 * comes from real usage and is excluded.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getPreset } from '../../../providers/api/presets';
import type { PromptStrategyId } from '../../../providers/prompt-strategy';
import { postProcessCompletion } from '../../../utils/post-process';
import { CheckResult, CheckScenarioFlags, runDeterministicChecks } from '../deterministic-checks';
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
import {
  MustAvoid,
  ReplayCase,
  ReplayInput,
  ReplaySet,
  checkInputFor,
  replayPipeline,
} from './replay-pipeline';

const NULL_SENTINEL = '(null — provider returned no completion)';
const DEFAULT_ROOT = path.join(os.homedir(), 'working_dir/bespoke-ai-vscode-ext/test-results');
const DEFAULT_OUT = path.resolve(__dirname, '../../fixtures/replay/replay-set.json');

/**
 * Runs whose recorded completions the current pipeline reproduces exactly
 * (verified when this set was built). Earlier runs are handled as follows:
 *  - Feb 2026 runs used a different prompt protocol (`<output>` tags); none of
 *    their raw responses are meaningful input to today's extraction. Skipped.
 *  - DRIFT_RUNS (below) predate f0edfc3 / ad1839e; cases where today's output
 *    differs are included only as annotated drift cases.
 */
const CURRENT_ERA_FROM = 'quality-2026-03-02T01-43';
const DRIFT_RUNS = /^quality-2026-03-01T2[0-2]-/;

/** Total cases to aim for (interesting cases first, then ordinary fill). */
const TARGET_TOTAL = 52;
/** Max cases per interesting tag (a case can carry several tags). */
const PER_TAG_CAP = 4;
/** Max drift cases per drift kind (on top of MUST_INCLUDE). */
const PER_DRIFT_CAP = 1;

/**
 * Always included. The first three are discussed in
 * evals/error-analysis-2026-03-sonnet.md; the rest are drift cases chosen
 * by hand because each shows a distinct pre-fix failure.
 */
const MUST_INCLUDE = [
  // `user.isActive()` + suffix `)`: the old trim removed the completion's own `)`, leaving
  // `.filter(` unclosed (the judge was right); kept by the code-mode bracket guard.
  'quality-2026-03-26T21-32-33-claude-code-sonnet/code-java-mid-file',
  // Suffix regurgitation that post-processing trims down to a stray ` —`.
  'quality-2026-03-26T21-32-33-claude-code-sonnet/prose-long-prefix-narrative',
  // Under-generation: whitespace-only inside tags → null.
  'quality-2026-03-26T21-32-33-claude-code-sonnet/prose-bridge-medium-transition',
  // Drift: `x % 2 == 0]` with suffix `]` (code delimiter overlap).
  'quality-2026-03-01T22-26-45-api-anthropic-haiku/code-py-list-comprehension',
  // Drift: prefill raw `{{FILL_HERE}}</COMPLETION>` + "Wait, let me reconsider…".
  'quality-2026-03-01T22-26-45-api-anthropic-haiku/code-js-arrow-function',
  // Drift: Gemini output cut off after an unclosed `<COMPLETION>`.
  'quality-2026-03-01T22-27-02-api-google-gemini-flash/code-go-goroutine',
  // Drift: completion is the suffix's first heading plus a trailing newline.
  'quality-2026-03-01T22-27-06-api-xai-grok/prose-journal-jnl-full-window',
];

const SCENARIO_FLAGS: Map<string, CheckScenarioFlags> = new Map(
  [
    ...proseScenarios,
    ...codeScenarios,
    ...edgeCaseScenarios,
    ...reuseQualityScenarios,
    ...proseMidDocumentScenarios,
    ...proseJournalScenarios,
    ...proseBridgingScenarios,
    ...codeMidFileScenarios,
    ...prosePromptWritingScenarios,
    ...proseFullWindowScenarios,
    ...codeFullWindowScenarios,
    ...customInstructionScenarios,
  ].map((s) => {
    const flags: CheckScenarioFlags = {};
    if (s.mid_word !== undefined) flags.mid_word = s.mid_word;
    if (s.max_completion_chars !== undefined) flags.max_completion_chars = s.max_completion_chars;
    if (s.expect_empty_ok !== undefined) flags.expect_empty_ok = s.expect_empty_ok;
    if (s.requirements.must_not_start_with?.length) {
      flags.requirements = { must_not_start_with: s.requirements.must_not_start_with };
    }
    return [s.id, flags];
  }),
);

interface Row {
  run: string;
  scenario: string;
  key: string;
  model: string;
  backend: 'claude-code' | 'api';
  preset: string | null;
  strategy: PromptStrategyId;
  prefill: boolean;
  mode: 'prose' | 'code';
  languageId: string;
  prefix: string;
  suffix: string;
  raw: string;
  extracted: string | null;
  recorded: string | null;
  current: string | null;
  checks: CheckResult[];
  tags: string[];
  drift?: string;
}

const TAG_RE = /<\/?COMPLETION>|\{\{FILL_HERE\}\}/;
const TAG_RE_G = /<\/?COMPLETION>|\{\{FILL_HERE\}\}/g;
const PREAMBLE_RE = /^(?:Here(?:'s| is)|Sure\b|Got it\b|Understood\b|Of course\b)/i;

function readIf(p: string): string | undefined {
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined;
}

function loadRows(root: string): Row[] {
  const rows: Row[] = [];
  const runs = fs
    .readdirSync(root)
    .filter((d) => d.startsWith('quality-') && (d >= CURRENT_ERA_FROM || DRIFT_RUNS.test(d)))
    .sort();
  for (const run of runs) {
    const runDir = path.join(root, run);
    for (const scenario of fs.readdirSync(runDir).sort()) {
      if (scenario.startsWith('regression')) continue; // real usage — private
      const dir = path.join(runDir, scenario);
      if (!fs.statSync(dir).isDirectory()) continue;
      const raw = readIf(path.join(dir, 'raw-response.txt'));
      const metaText = readIf(path.join(dir, 'metadata.json'));
      const inputText = readIf(path.join(dir, 'input.json'));
      const completionText = readIf(path.join(dir, 'completion.txt'));
      if (raw === undefined || !metaText || !inputText || completionText === undefined) continue;
      if (!SCENARIO_FLAGS.has(scenario)) continue; // scenario no longer defined
      const meta = JSON.parse(metaText);
      if (meta.error) continue;
      const input = JSON.parse(inputText);

      let strategy: PromptStrategyId = 'tag-extraction';
      let prefill = false;
      let preset: string | null = null;
      if (meta.backend !== 'claude-code') {
        preset = meta.preset ?? run.match(/-api-(.+)$/)?.[1] ?? null;
        const p = preset ? getPreset(preset) : undefined;
        if (!p) throw new Error(`${run}/${scenario}: unknown preset ${preset}`);
        strategy = p.promptStrategy;
        prefill = p.features?.prefill === true;
      }
      const replayInput: ReplayInput = {
        backend: meta.backend === 'claude-code' ? 'claude-code' : 'api',
        strategy,
        prefill,
        mode: input.mode,
        prefix: input.prefix,
        suffix: input.suffix,
        raw,
      };
      const { extracted, final } = replayPipeline(replayInput);
      const recorded = completionText === NULL_SENTINEL ? null : completionText;
      const row: Row = {
        run,
        scenario,
        key: `${run}/${scenario}`,
        model: meta.model,
        backend: replayInput.backend,
        preset,
        strategy,
        prefill,
        mode: input.mode,
        languageId: input.languageId,
        prefix: input.prefix,
        suffix: input.suffix,
        raw,
        extracted,
        recorded,
        current: final,
        checks: [],
        tags: [],
      };
      if (recorded !== final) {
        if (run >= CURRENT_ERA_FROM) {
          // Should not happen: these runs reproduced exactly when the set was built.
          console.warn(`UNEXPECTED DRIFT (not included): ${row.key}`);
          continue;
        }
        const drift = classifyDrift(row);
        if (!drift) {
          console.warn(`UNEXPLAINED DRIFT (not included): ${row.key}`);
          continue;
        }
        row.drift = drift;
      } else if (run < CURRENT_ERA_FROM) {
        continue; // matching old-run cases add nothing the current-era runs lack
      }
      row.checks = runDeterministicChecks({
        ...checkInputFor(asCase(row), final),
      });
      row.tags = tagRow(row);
      rows.push(row);
    }
  }
  return rows;
}

/** Name the commit that explains a recorded→current difference, or null. */
function classifyDrift(r: Row): string | null {
  const rec = r.recorded ?? '';
  const cur = r.current ?? '';
  if (
    r.prefill &&
    cur &&
    rec.endsWith(cur) &&
    /^\s+$/.test(rec.slice(0, rec.length - cur.length))
  ) {
    return (
      'prefill-trailing-ws: prefill extraction now drops the part of the output that ' +
      're-emits whitespace trimmed off the prefill anchor (it is already before the cursor); ' +
      'the recorded output doubled it.'
    );
  }
  if (
    r.mode === 'code' &&
    cur.startsWith(rec) &&
    cur.length > rec.length &&
    /^[\s)\]}]+$/.test(cur.slice(rec.length).replace(/[;,]/g, ''))
  ) {
    return (
      'code-bracket-guard: the code-mode suffix-overlap trim no longer removes a closer of a ' +
      'scope the completion opened itself; the recorded output lost its own closing ' +
      `bracket (${JSON.stringify(cur.slice(rec.length))}).`
    );
  }
  if (r.prefill && cur && /^\s*\{\{FILL_HERE\}\}\s*<\/COMPLETION>/.test(r.raw)) {
    return (
      'prefill-scaffold-retry: the thinking-leak retry now also applies when the first ' +
      '<COMPLETION> block is only prompt scaffolding ({{FILL_HERE}}); that block used to ' +
      "count as substantive, post-processing stripped the marker, and the retry's text was lost."
    );
  }
  if (r.prefill && rec.includes('</COMPLETION>')) {
    return (
      'prefill-thinking-leak: f0edfc3 (2026-03-01) made prefill extraction stop at the FIRST ' +
      '</COMPLETION> and retry a second <COMPLETION> pair after an immediate close; the ' +
      'recorded output kept the model\'s "Wait, let me reconsider…" text.'
    );
  }
  if (TAG_RE.test(rec) && !TAG_RE.test(cur)) {
    return (
      'leaked-tag: ad1839e (2026-03-01) added stripLeakedTags() to post-processing; the ' +
      'recorded output contained an unclosed <COMPLETION> / {{FILL_HERE}} scaffold.'
    );
  }
  if (rec.startsWith(cur) && rec.length > cur.length) {
    const cut = rec.slice(cur.length).replace(/\s+/g, ' ').trim();
    const head = r.suffix.replace(/\s+/g, ' ').trim();
    if (cut && head.startsWith(cut)) {
      if (r.mode === 'code') {
        return (
          'code-delimiter-overlap: f0edfc3 (2026-03-01) lowered the code-mode suffix-overlap ' +
          'minimum to 1 char; the recorded output duplicated closing delimiters already in the ' +
          `suffix (${JSON.stringify(cut)}).`
        );
      }
      if (/\s$/.test(r.extracted ?? '')) {
        return (
          'suffix-overlap-trailing-ws: f0edfc3 (2026-03-01) made trimSuffixOverlap skip ' +
          "trailing whitespace before matching; the completion's trailing newline used to " +
          'defeat the trim, so text already in the suffix was shown again.'
        );
      }
    }
  }
  return null;
}

function asCase(r: Row): ReplayCase {
  return {
    id: '',
    source_run: r.run,
    scenario: r.scenario,
    model: r.model,
    backend: r.backend,
    preset: r.preset,
    strategy: r.strategy,
    prefill: r.prefill,
    mode: r.mode,
    languageId: r.languageId,
    prefix: r.prefix,
    suffix: r.suffix,
    prefix_omitted_chars: 0,
    suffix_omitted_chars: 0,
    raw: r.raw,
    expected_final: r.current,
    tags: [],
    scenario_flags: SCENARIO_FLAGS.get(r.scenario) ?? {},
    expected_checks: [],
    must_avoid: [],
  };
}

function tagRow(r: Row): string[] {
  const tags: string[] = [];
  const raw = r.raw;
  if (r.drift) tags.push(`drift:${r.drift.split(':')[0]}`);
  if (r.backend === 'claude-code' && raw === '(null)') tags.push('raw-null');
  else if (raw.trim() === '') tags.push('raw-whitespace');
  const hasOpen = raw.includes('<COMPLETION>');
  const hasClose = raw.includes('</COMPLETION>');
  if (!r.prefill && !hasOpen && !hasClose && raw.trim()) tags.push('raw-no-tags');
  if (r.prefill && !hasClose && raw.trim()) tags.push('prefill-no-close');
  if (
    r.prefill &&
    hasClose &&
    !raw.slice(0, raw.indexOf('</COMPLETION>')).replace(TAG_RE_G, '').trim()
  ) {
    // Immediate close (or only scaffolding before it); extraction then
    // retries a second <COMPLETION> pair.
    tags.push(r.extracted ? 'prefill-retry-used' : 'prefill-immediate-close');
  }
  if (hasClose && raw.slice(raw.lastIndexOf('</COMPLETION>') + 13).trim()) {
    tags.push('raw-text-after-close');
  }
  if (!r.prefill && hasOpen && raw.slice(0, raw.indexOf('<COMPLETION>')).trim()) {
    tags.push('raw-text-before-open');
  }
  if (r.strategy === 'instruction-extraction' && !hasOpen && /^```/.test(raw)) {
    tags.push('fence-stripped');
  }
  if (r.strategy === 'instruction-extraction' && !(hasOpen && hasClose) && PREAMBLE_RE.test(raw)) {
    tags.push('preamble-stripped');
  }
  const ext = r.extracted;
  if (raw.trim() && ext === null) tags.push('extract-null');
  if (ext !== null && ext.trim() === '' && raw.trim()) tags.push('extract-whitespace');
  if (ext) {
    const base = postProcessCompletion(ext, undefined, undefined, r.mode);
    const pfx = r.prefill ? undefined : r.prefix;
    if (pfx && postProcessCompletion(ext, pfx, undefined, r.mode) !== base) {
      tags.push('prefix-trim');
    }
    if (postProcessCompletion(ext, undefined, r.suffix, r.mode) !== base) tags.push('suffix-trim');
    if (TAG_RE.test(ext)) tags.push('tag-strip');
  }
  if (r.current === null) tags.push('final-null');
  for (const c of r.checks) if (!c.pass) tags.push(`check-fail:${c.id}`);
  if (tags.length === 0) tags.push('ordinary');
  return tags;
}

// ─── Selection ──────────────────────────────────────────────────────

function select(rows: Row[]): Row[] {
  const chosen = new Map<string, Row>();
  const take = (r: Row) => chosen.set(r.key, r);
  const byKey = new Map(rows.map((r) => [r.key, r]));
  for (const k of MUST_INCLUDE) {
    const r = byKey.get(k);
    if (!r) throw new Error(`must-include case missing: ${k}`);
    take(r);
  }

  // Drift cases: up to PER_DRIFT_CAP per kind, spread across models.
  const driftKinds = [...new Set(rows.filter((r) => r.drift).map((r) => r.tags[0]))].sort();
  for (const kind of driftKinds) {
    pickSpread(
      rows.filter((r) => r.tags[0] === kind),
      PER_DRIFT_CAP,
    ).forEach(take);
  }

  // Interesting tags: up to PER_TAG_CAP per tag, counting cases already
  // chosen, deduped on (scenario, strategy) and spread across strategies.
  const current = rows.filter((r) => !r.drift);
  const tags = [...new Set(current.flatMap((r) => r.tags))].filter((t) => t !== 'ordinary').sort();
  for (const tag of tags) {
    const have = [...chosen.values()].filter((r) => r.tags.includes(tag)).length;
    if (have >= PER_TAG_CAP) continue;
    const pool = current.filter((r) => r.tags.includes(tag) && !chosen.has(r.key));
    pickSpread(pool, PER_TAG_CAP - have, chosen).forEach(take);
  }

  // Ordinary fill: round-robin across strategy × mode, then model.
  const ordinary = current.filter((r) => r.tags.includes('ordinary') && !chosen.has(r.key));
  const need = Math.max(0, TARGET_TOTAL - chosen.size);
  pickSpread(ordinary, need, chosen, (r) => `${r.strategy}|${r.mode}|${r.model}`).forEach(take);

  return [...chosen.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Pick n rows, round-robin over groups (default: strategy), skipping a
 * (scenario, strategy) pair already chosen. Deterministic: groups and group
 * members are visited in sorted order.
 */
function pickSpread(
  pool: Row[],
  n: number,
  already: Map<string, Row> = new Map(),
  groupOf: (r: Row) => string = (r) => r.strategy,
): Row[] {
  const seen = new Set([...already.values()].map((r) => `${r.scenario}|${r.strategy}`));
  const groups = new Map<string, Row[]>();
  for (const r of [...pool].sort((a, b) => a.key.localeCompare(b.key))) {
    const g = groupOf(r);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(r);
  }
  const order = [...groups.keys()].sort();
  const out: Row[] = [];
  let progress = true;
  while (out.length < n && progress) {
    progress = false;
    for (const g of order) {
      if (out.length >= n) break;
      const list = groups.get(g)!;
      while (list.length) {
        const r = list.shift()!;
        const k = `${r.scenario}|${r.strategy}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(r);
        progress = true;
        break;
      }
    }
  }
  return out;
}

// ─── Context trimming ───────────────────────────────────────────────

/** Tail of prefix, at least `n` chars, starting at a line start. */
function prefixTail(prefix: string, n: number): string {
  if (n >= prefix.length) return prefix;
  const tail = prefix.slice(-n);
  const nl = tail.indexOf('\n');
  // No newline inside the tail: the last line is longer than n — keep more.
  if (nl === -1) return prefixTail(prefix, n * 2);
  return tail.slice(nl + 1);
}

/** Head of suffix, at least `n` chars, ending at a line end. */
function suffixHead(suffix: string, n: number): string {
  if (n >= suffix.length) return suffix;
  const nl = suffix.indexOf('\n', n);
  return nl === -1 ? suffix : suffix.slice(0, nl + 1);
}

const sameChecks = (a: CheckResult[], b: CheckResult[]) =>
  a.length === b.length && a.every((x, i) => x.id === b[i].id && x.pass === b[i].pass);

/**
 * Smallest line-aligned prefix tail / suffix head for which the pipeline
 * output and every check's (id, pass) equal the full-context result.
 * Doubles the window until they match; full context is the ceiling.
 */
function trimContext(r: Row): { prefix: string; suffix: string } {
  const full = asCase(r);
  let pn = 300;
  let sn = Math.max(300, (r.extracted ?? '').length + 100);
  for (;;) {
    const prefix = prefixTail(r.prefix, pn);
    const suffix = suffixHead(r.suffix, sn);
    const c = { ...full, prefix, suffix };
    const { final } = replayPipeline({ ...c });
    const checks = runDeterministicChecks(checkInputFor(c, final));
    if (final === r.current && sameChecks(checks, r.checks)) return { prefix, suffix };
    if (prefix === r.prefix && suffix === r.suffix) {
      throw new Error(`${r.key}: full context does not reproduce itself`);
    }
    pn *= 2;
    sn *= 2;
  }
}

// ─── must_avoid ─────────────────────────────────────────────────────

function mustAvoid(r: Row, prefix: string): MustAvoid[] {
  const out: MustAvoid[] = [];
  const ext = r.extracted;
  // Every case is checked for leaked scaffolding by the test; annotate only
  // the ones where scaffolding sits somewhere extraction does not expect.
  const oddTags =
    r.raw.includes('{{FILL_HERE}}') ||
    r.tags.some((t) =>
      [
        'tag-strip',
        'raw-text-after-close',
        'raw-text-before-open',
        'prefill-retry-used',
        'prefill-immediate-close',
        'drift:leaked-tag',
        'drift:prefill-thinking-leak',
      ].includes(t),
    );
  if (oddTags) {
    out.push({
      kind: 'tag-leak',
      note: 'raw output contains prompt scaffolding; it must never reach the ghost text',
    });
  }
  if (r.tags.includes('preamble-stripped')) {
    out.push({ kind: 'preamble', note: 'chatty preamble in raw output must be stripped' });
  }
  if (!r.prefill && ext && r.tags.includes('prefix-trim')) {
    const frag = prefix.slice(prefix.lastIndexOf('\n') + 1);
    out.push({
      kind: 'prefix-echo',
      value: frag,
      note: 'model echoed the current line fragment; the echo must be trimmed',
    });
  }
  if (ext && r.tags.includes('suffix-trim')) {
    const pfx = r.prefill ? undefined : r.prefix;
    const before = postProcessCompletion(ext, pfx, undefined, r.mode) ?? '';
    const after = r.current ?? '';
    if (before.startsWith(after)) {
      const cut = before.slice(after.length).trim();
      if (cut) {
        out.push({
          kind: 'suffix-overlap',
          value: cut,
          note: 'completion tail duplicated the start of the suffix; the duplicate must be trimmed',
        });
      }
    }
  }
  if ((r.raw.trim() === '' || (ext !== null && ext.trim() === '')) && r.raw !== '(null)') {
    out.push({
      kind: 'whitespace-final',
      note: 'whitespace-only model output must surface as null, not blank ghost text',
    });
  }
  for (const c of r.checks) {
    if (!c.pass && c.id === 'suffix-echo') {
      out.push({
        kind: 'check-stays-failing',
        value: c.id,
        note:
          'raw output regurgitates the suffix; post-processing hides most of it, so the ' +
          'raw-based suffix-echo check must keep flagging it',
      });
    }
  }
  return out;
}

// ─── Main ───────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const out = outIdx !== -1 ? path.resolve(args[outIdx + 1]) : DEFAULT_OUT;
  const positional = args.filter((a, i) => a !== '--out' && args[i - 1] !== '--out');
  const root = path.resolve(positional[0] ?? DEFAULT_ROOT);

  const rows = loadRows(root);
  const chosen = select(rows);

  const cases: ReplayCase[] = chosen.map((r) => {
    const { prefix, suffix } = trimContext(r);
    const c: ReplayCase = {
      ...asCase(r),
      id: `${r.run.replace(/^quality-/, '')}/${r.scenario}`,
      prefix,
      suffix,
      prefix_omitted_chars: r.prefix.length - prefix.length,
      suffix_omitted_chars: r.suffix.length - suffix.length,
      tags: r.tags,
      must_avoid: mustAvoid(r, prefix),
    };
    if (r.drift) {
      c.recorded_final = r.recorded;
      c.drift = r.drift;
    }
    c.expected_checks = runDeterministicChecks(checkInputFor(c, c.expected_final));
    return c;
  });

  const set: ReplaySet = {
    description:
      'Recorded model outputs from synthetic quality scenarios, replayed through the current ' +
      'extraction + post-processing pipeline by src/test/unit/replay.test.ts. See evals/replay/README.md.',
    generated_by: 'src/test/quality/replay/build-replay-set.ts',
    cases,
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(set, null, 2) + '\n');

  // Composition report.
  const count = (f: (c: ReplayCase) => string) => {
    const m: Record<string, number> = {};
    for (const c of cases) m[f(c)] = (m[f(c)] ?? 0) + 1;
    return m;
  };
  const tagCounts: Record<string, number> = {};
  for (const c of cases) for (const t of c.tags) tagCounts[t] = (tagCounts[t] ?? 0) + 1;
  console.log(`candidates: ${rows.length} (drift: ${rows.filter((r) => r.drift).length})`);
  console.log(`wrote ${cases.length} cases → ${path.relative(process.cwd(), out)}`);
  console.log(
    'by strategy:',
    count((c) => c.strategy),
  );
  console.log(
    'by model:',
    count((c) => c.model),
  );
  console.log(
    'by mode:',
    count((c) => c.mode),
  );
  console.log('by tag:', tagCounts);
  console.log(`fixture bytes: ${fs.statSync(out).size}`);
}

main();
