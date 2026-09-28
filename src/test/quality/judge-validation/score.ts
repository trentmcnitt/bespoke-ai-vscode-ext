#!/usr/bin/env tsx
/**
 * Score the LLM judge against human labels (see evals/judge-validation/README.md).
 *
 * Reads evals/judge-validation/labels.csv and judge-verdicts.json and prints,
 * per split, the judge's TPR (judge pass | human pass), TNR (judge fail |
 * human fail) and raw agreement — for the judge alone and for "judge AND all
 * deterministic checks". Positive class = pass.
 *
 * Writes no files. Prints nothing but a notice when there are no labels.
 * Refuses to report the test split until at least 50 test items are labeled.
 *
 * Usage: npm run judge:score [-- --labels <csv> --verdicts <json>]
 */
import * as fs from 'fs';
import * as path from 'path';

export const MIN_TEST_LABELS = 50;

export type Split = 'dev' | 'test';

export interface Verdict {
  split: Split;
  judge_pass: boolean;
  det_pass: boolean;
}

export interface Label {
  id: string;
  /** null = unlabeled or explicitly unsure; excluded from metrics. */
  human_pass: boolean | null;
  unsure: boolean;
}

export interface Rate {
  num: number;
  den: number;
  /** null when den = 0. */
  value: number | null;
  /** 95% Wilson interval; null when den = 0. */
  ci: [number, number] | null;
}

export interface Confusion {
  tp: number; // human pass, predicted pass
  fn: number; // human pass, predicted fail
  tn: number; // human fail, predicted fail
  fp: number; // human fail, predicted pass
}

export interface SplitMetrics {
  split: Split;
  n: number;
  unsure: number;
  humanPass: number;
  humanFail: number;
  judge: { confusion: Confusion; tpr: Rate; tnr: Rate; agreement: Rate };
  combined: { confusion: Confusion; tpr: Rate; tnr: Rate; agreement: Rate };
}

// ─── CSV ────────────────────────────────────────────────────────────

/** Minimal RFC 4180 parser (quoted fields, "" escapes, CRLF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** pass/fail/p/f/1/0/y/n/yes/no/true/false → boolean; unsure/?/blank → null. */
export function parseHumanPass(v: string): { value: boolean | null; unsure: boolean } {
  const s = v.trim().toLowerCase();
  if (['pass', 'p', '1', 'y', 'yes', 'true'].includes(s)) return { value: true, unsure: false };
  if (['fail', 'f', '0', 'n', 'no', 'false'].includes(s)) return { value: false, unsure: false };
  if (['unsure', 'u', '?'].includes(s)) return { value: null, unsure: true };
  if (s === '') return { value: null, unsure: false };
  throw new Error(`unrecognized human_pass value: ${JSON.stringify(v)}`);
}

export function parseLabels(csv: string): Label[] {
  const rows = parseCsv(csv);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim());
  const iId = header.indexOf('id');
  const iPass = header.indexOf('human_pass');
  if (iId === -1 || iPass === -1) throw new Error('labels.csv needs id and human_pass columns');
  return rows.slice(1).map((r) => {
    const { value, unsure } = parseHumanPass(r[iPass] ?? '');
    return { id: r[iId].trim(), human_pass: value, unsure };
  });
}

// ─── Math ───────────────────────────────────────────────────────────

/** 95% Wilson score interval for num/den. */
export function wilson(num: number, den: number, z = 1.96): [number, number] | null {
  if (den === 0) return null;
  const p = num / den;
  const z2 = z * z;
  const center = (p + z2 / (2 * den)) / (1 + z2 / den);
  const half = (z * Math.sqrt((p * (1 - p)) / den + z2 / (4 * den * den))) / (1 + z2 / den);
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

export function rate(num: number, den: number): Rate {
  return { num, den, value: den === 0 ? null : num / den, ci: wilson(num, den) };
}

export function confusion(pairs: Array<{ human: boolean; predicted: boolean }>): Confusion {
  const c: Confusion = { tp: 0, fn: 0, tn: 0, fp: 0 };
  for (const { human, predicted } of pairs) {
    if (human && predicted) c.tp++;
    else if (human) c.fn++;
    else if (!predicted) c.tn++;
    else c.fp++;
  }
  return c;
}

function rates(c: Confusion): { tpr: Rate; tnr: Rate; agreement: Rate } {
  return {
    tpr: rate(c.tp, c.tp + c.fn),
    tnr: rate(c.tn, c.tn + c.fp),
    agreement: rate(c.tp + c.tn, c.tp + c.fn + c.tn + c.fp),
  };
}

/**
 * Metrics for one split. The split comes from judge-verdicts.json (the
 * authority), not from labels.csv. Unlabeled / unsure rows are excluded.
 */
export function computeMetrics(
  labels: Label[],
  verdicts: Record<string, Verdict>,
  split: Split,
): SplitMetrics {
  const judged: Array<{ human: boolean; v: Verdict }> = [];
  let unsure = 0;
  for (const l of labels) {
    const v = verdicts[l.id];
    if (!v) throw new Error(`label for unknown id ${l.id} (not in judge-verdicts.json)`);
    if (v.split !== split) continue;
    if (l.unsure) unsure++;
    if (l.human_pass === null) continue;
    judged.push({ human: l.human_pass, v });
  }
  const judgeC = confusion(judged.map((j) => ({ human: j.human, predicted: j.v.judge_pass })));
  const combC = confusion(
    judged.map((j) => ({ human: j.human, predicted: j.v.judge_pass && j.v.det_pass })),
  );
  return {
    split,
    n: judged.length,
    unsure,
    humanPass: judged.filter((j) => j.human).length,
    humanFail: judged.filter((j) => !j.human).length,
    judge: { confusion: judgeC, ...rates(judgeC) },
    combined: { confusion: combC, ...rates(combC) },
  };
}

// ─── Markdown ───────────────────────────────────────────────────────

export function fmtRate(r: Rate): string {
  if (r.value === null || r.ci === null) return `— (0/0)`;
  const p = (x: number) => (100 * x).toFixed(0);
  return `${p(r.value)}% (${r.num}/${r.den}; 95% CI ${p(r.ci[0])}–${p(r.ci[1])})`;
}

export function markdownTable(rows: SplitMetrics[]): string {
  const out = [
    '| Split | Grader | n | Human pass/fail | TPR (judge pass given human pass) | TNR (judge fail given human fail) | Agreement |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const m of rows) {
    for (const [name, g] of [
      ['judge', m.judge],
      ['judge AND det. checks', m.combined],
    ] as const) {
      out.push(
        `| ${m.split} | ${name} | ${m.n} | ${m.humanPass}/${m.humanFail} | ${fmtRate(g.tpr)} | ${fmtRate(g.tnr)} | ${fmtRate(g.agreement)} |`,
      );
    }
  }
  return out.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────

function main(argv: string[]): void {
  const dir = path.resolve(__dirname, '../../../../evals/judge-validation');
  let labelsPath = path.join(dir, 'labels.csv');
  let verdictsPath = path.join(dir, 'judge-verdicts.json');
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--labels') labelsPath = path.resolve(argv[++i]);
    else if (argv[i] === '--verdicts') verdictsPath = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  const labels = fs.existsSync(labelsPath) ? parseLabels(fs.readFileSync(labelsPath, 'utf8')) : [];
  const labeled = labels.filter((l) => l.human_pass !== null);
  if (labeled.length === 0) {
    console.error(
      'No human labels yet — nothing to score. Label with evals/judge-validation/label.html.',
    );
    return;
  }
  const verdicts = (
    JSON.parse(fs.readFileSync(verdictsPath, 'utf8')) as {
      verdicts: Record<string, Verdict>;
    }
  ).verdicts;

  const rows: SplitMetrics[] = [];
  const notes: string[] = [];
  for (const split of ['dev', 'test'] as const) {
    const m = computeMetrics(labels, verdicts, split);
    if (m.n === 0) {
      notes.push(`${split}: no labels.`);
      continue;
    }
    if (split === 'test' && m.n < MIN_TEST_LABELS) {
      notes.push(
        `test: ${m.n} labeled (< ${MIN_TEST_LABELS}); not reported. Finish labeling the held-out split first.`,
      );
      continue;
    }
    rows.push(m);
    if (m.unsure > 0) notes.push(`${split}: ${m.unsure} item(s) marked unsure, excluded.`);
  }
  if (rows.length > 0) console.log(markdownTable(rows));
  if (notes.length > 0) console.log('\n' + notes.map((n) => `- ${n}`).join('\n'));
  console.log(
    '\nPositive class = pass. Sample is enriched for judge fails and deterministic-check fails, ' +
      'so these rates describe the judge on this sample, not a population pass rate. ' +
      'Tune the judge prompt on dev only; quote test.',
  );
}

if (require.main === module) {
  main(process.argv.slice(2));
}
