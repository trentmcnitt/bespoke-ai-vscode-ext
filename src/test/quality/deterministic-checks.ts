/**
 * Deterministic Layer 1 checks for completion quality runs.
 *
 * Each check targets a failure class found by reading real outputs
 * (see evals/error-analysis-2026-03-sonnet.md), not a generic metric.
 * They are pure functions over what the harness already saves — the
 * truncated prefix/suffix, the post-processed completion, and the raw
 * model response — so they can be re-run over old result folders for
 * free (see rescore.ts).
 *
 * Only checks that APPLY to a scenario are returned. "0 failed of 0
 * applied" is not a pass, so summaries count `applied` and `failed`.
 *
 * Keep this file free of vitest / helpers / provider imports so `tsx`
 * can load it from the rescore script.
 */
import type { TestScenario } from './judge';

export type CheckId =
  | 'non-empty'
  | 'boundary-whitespace'
  | 'double-space'
  | 'suffix-echo'
  | 'journal-date'
  | 'over-length'
  | 'must-not-start-with';

export const CHECK_IDS: readonly CheckId[] = [
  'non-empty',
  'boundary-whitespace',
  'double-space',
  'suffix-echo',
  'journal-date',
  'over-length',
  'must-not-start-with',
];

export interface CheckResult {
  id: CheckId;
  pass: boolean;
  detail: string;
}

/** Scenario fields the checks read. All optional so old runs can be rescored. */
export type CheckScenarioFlags = Partial<
  Pick<TestScenario, 'mid_word' | 'max_completion_chars' | 'expect_empty_ok'>
> & {
  requirements?: Pick<TestScenario['requirements'], 'must_not_start_with'>;
};

export interface CheckInput {
  mode: 'prose' | 'code';
  /** Prefix exactly as sent to the model (after truncation). */
  prefix: string;
  /** Suffix exactly as sent to the model (after truncation). */
  suffix: string;
  /** Post-processed completion (what becomes ghost text). null = no completion. */
  completion: string | null;
  /** Raw model output before extraction/post-processing. undefined = not recorded. */
  rawResponse?: string;
  /** True when the provider threw (distinguishes errors from empty output). */
  providerError?: boolean;
  scenario?: CheckScenarioFlags;
}

const clip = (s: string, n = 40): string => JSON.stringify(s.length > n ? s.slice(0, n) + '…' : s);

// ─── non-empty ──────────────────────────────────────────────────────

/**
 * Null / whitespace-only completions fail unless the scenario declares
 * `expect_empty_ok` (a gap that genuinely needs nothing). The detail
 * separates provider errors from whitespace-only model output.
 */
export function checkNonEmpty(input: CheckInput): CheckResult {
  const empty = input.completion === null || input.completion.trim() === '';
  if (!empty) return { id: 'non-empty', pass: true, detail: 'completion has content' };
  let why: string;
  if (input.providerError) why = 'provider error';
  else if (input.rawResponse !== undefined && input.rawResponse.trim() === '')
    why = 'model returned whitespace only';
  else if (input.rawResponse !== undefined && extractRawCompletion(input.rawResponse).trim() === '')
    why = 'model returned whitespace only (inside tags)';
  else if (input.rawResponse === undefined) why = 'no raw response recorded';
  else why = 'empty after post-processing';
  if (input.scenario?.expect_empty_ok) {
    return { id: 'non-empty', pass: true, detail: `empty (${why}); scenario allows empty` };
  }
  return { id: 'non-empty', pass: false, detail: `empty completion (${why})` };
}

// ─── boundary-whitespace ────────────────────────────────────────────

/**
 * Scripts written without spaces between words. Two letters from these meeting at a seam is
 * normal text (`我喜欢` + `吃饭`), so they never count as a word character here.
 */
const NO_SPACE_SCRIPT =
  '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Thai}\\p{Script=Lao}\\p{Script=Khmer}\\p{Script=Myanmar}';
/** A letter or digit from a space-delimited script. */
const WORD_CHAR = `(?![${NO_SPACE_SCRIPT}])[\\p{L}\\p{N}]`;
/** A word char at the end of text, allowing trailing combining marks (`है`, NFD `café`). */
const WORD_END_CHAR = `${WORD_CHAR}\\p{M}*`;
const PREFIX_END_JOINS = new RegExp(`(?:${WORD_END_CHAR}|[,;:.!?])$`, 'u');
const WORD_START = new RegExp(`^${WORD_CHAR}`, 'u');
const WORD_END = new RegExp(`${WORD_END_CHAR}$`, 'u');

/**
 * Prose only. Fails when the inserted text would run two words together.
 * Word characters are Unicode letters/digits (\p{L}, \p{N}), except in scripts
 * written without word spaces (Han, kana, Thai, …):
 *  - start seam: prefix ends in a word char or punctuation with no trailing
 *    whitespace, and the completion starts with a word char
 *    (`behind` + `inadequate` → `behindinadequate`);
 *  - end seam: completion ends in a word char and the suffix starts with one.
 * Returns null (not applicable) for code — `foo.` + `bar()` is correct code —
 * for empty completions, and for scenarios flagged `mid_word`.
 */
export function checkBoundaryWhitespace(input: CheckInput): CheckResult | null {
  if (input.mode !== 'prose') return null;
  if (input.scenario?.mid_word) return null;
  const c = input.completion;
  if (c === null || c.trim() === '') return null;

  const seams: string[] = [];
  if (PREFIX_END_JOINS.test(input.prefix) && WORD_START.test(c)) {
    seams.push(`start: …${clip(input.prefix.slice(-20))} + ${clip(c, 20)}`);
  }
  if (WORD_END.test(c) && WORD_START.test(input.suffix)) {
    seams.push(`end: ${clip(c.slice(-20))} + ${clip(input.suffix, 20)}…`);
  }
  if (seams.length === 0) {
    return { id: 'boundary-whitespace', pass: true, detail: 'both seams separated' };
  }
  return {
    id: 'boundary-whitespace',
    pass: false,
    detail: `missing separator at ${seams.join('; ')}`,
  };
}

// ─── double-space ───────────────────────────────────────────────────

/**
 * Prose only. The opposite seam error to boundary-whitespace: a separator
 * supplied twice. Exact and narrow on purpose — only the ASCII space:
 *  - start seam: prefix ends in ' ' and the completion starts with ' '
 *    (`it already looks ` + ` great` → `looks  great`);
 *  - end seam: completion ends in ' ' and the suffix starts with ' '.
 * Returns null (not applicable) for code — indentation and alignment are
 * legitimately multi-space — and for empty completions.
 */
export function checkDoubleSpace(input: CheckInput): CheckResult | null {
  if (input.mode !== 'prose') return null;
  const c = input.completion;
  if (c === null || c.trim() === '') return null;

  const seams: string[] = [];
  if (input.prefix.endsWith(' ') && c.startsWith(' ')) {
    seams.push(`start: …${clip(input.prefix.slice(-20))} + ${clip(c, 20)}`);
  }
  if (c.endsWith(' ') && input.suffix.startsWith(' ')) {
    seams.push(`end: ${clip(c.slice(-20))} + ${clip(input.suffix, 20)}…`);
  }
  if (seams.length === 0) {
    return { id: 'double-space', pass: true, detail: 'no doubled space at either seam' };
  }
  return { id: 'double-space', pass: false, detail: `doubled space at ${seams.join('; ')}` };
}

// ─── suffix-echo ────────────────────────────────────────────────────

/** Minimum normalized suffix length for the echo check to apply. */
export const SUFFIX_ECHO_HEAD_CHARS = 30;

const normalizeWs = (s: string): string => s.replace(/\s+/g, ' ').trim();

/**
 * The text inside <COMPLETION>…</COMPLETION> when present (tolerating a
 * missing open tag, as with prefill extraction, or a missing close tag),
 * otherwise the raw text unchanged.
 */
export function extractRawCompletion(raw: string): string {
  const open = raw.indexOf('<COMPLETION>');
  const close = raw.lastIndexOf('</COMPLETION>');
  if (open === -1 && close === -1) return raw;
  const start = open === -1 ? 0 : open + '<COMPLETION>'.length;
  const end = close === -1 || close < start ? raw.length : close;
  return raw.slice(start, end);
}

/**
 * Runs on the RAW response, because post-processing (trimSuffixOverlap)
 * can cut a regurgitated suffix down to a stray token and hide it. Fails
 * if the first 30 whitespace-normalized chars of the suffix appear in the
 * raw completion. Not applicable without a raw response or when the
 * normalized suffix is shorter than 30 chars.
 */
export function checkSuffixEcho(input: CheckInput): CheckResult | null {
  if (input.rawResponse === undefined) return null;
  const suffix = normalizeWs(input.suffix);
  if (suffix.length < SUFFIX_ECHO_HEAD_CHARS) return null;
  const head = suffix.slice(0, SUFFIX_ECHO_HEAD_CHARS);
  const raw = normalizeWs(extractRawCompletion(input.rawResponse));
  const at = raw.indexOf(head);
  if (at === -1) return { id: 'suffix-echo', pass: true, detail: 'suffix head not in raw output' };
  return {
    id: 'suffix-echo',
    pass: false,
    detail: `raw output contains suffix head ${clip(head)} at char ${at} of ${raw.length}`,
  };
}

// ─── journal-date ───────────────────────────────────────────────────

/**
 * A line that is only an MM-DD-YY date, optionally as a markdown heading and
 * optionally followed by a parenthetical (`## 02-09-26 (afternoon)`).
 */
const DATE_HEADING =
  /^[ \t]*(?:#{1,6}[ \t]+)?(\d{2})-(\d{2})-(\d{2})(?:[ \t]+\([^)\n]*\))?[ \t]*$/gm;

export function extractDateHeadings(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(DATE_HEADING)) out.push(`${m[1]}-${m[2]}-${m[3]}`);
  return out;
}

/** MM-DD-YY → sortable YYMMDD number. */
const dateKey = (d: string): number => {
  const [mm, dd, yy] = d.split('-');
  return Number(yy + mm + dd);
};

function countDuplicates(dates: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of dates) m.set(d, (m.get(d) ?? 0) + 1);
  return m;
}

function countOrderBreaks(dates: string[], dir: 'asc' | 'desc'): number {
  let breaks = 0;
  for (let i = 1; i < dates.length; i++) {
    const a = dateKey(dates[i - 1]);
    const b = dateKey(dates[i]);
    if (dir === 'asc' ? b < a : b > a) breaks++;
  }
  return breaks;
}

/**
 * Applies when the context (prefix + suffix, without the completion) has at
 * least two MM-DD-YY heading lines — i.e. the file is a dated journal/log.
 * Joins prefix + completion + suffix BEFORE extracting, so a date typed
 * across the cursor (`0` + `1-31-26`) is read as one heading. Fails if the
 * completion introduces a duplicate date, or breaks the order (ascending or
 * descending) that the context's own dates establish. Problems already
 * present in the context are not blamed on the completion.
 */
export function checkJournalDates(input: CheckInput): CheckResult | null {
  const c = input.completion;
  if (c === null || c.trim() === '') return null;
  const context = extractDateHeadings(input.prefix + '\n' + input.suffix);
  if (context.length < 2) return null;
  const joined = extractDateHeadings(input.prefix + c + input.suffix);

  const problems: string[] = [];
  const ctxCounts = countDuplicates(context);
  for (const [d, n] of countDuplicates(joined)) {
    if (n > 1 && n > (ctxCounts.get(d) ?? 0)) problems.push(`duplicate ${d} (×${n})`);
  }

  let asc = 0;
  let desc = 0;
  for (let i = 1; i < context.length; i++) {
    const a = dateKey(context[i - 1]);
    const b = dateKey(context[i]);
    if (b > a) asc++;
    else if (b < a) desc++;
  }
  const dir = asc > desc ? 'asc' : desc > asc ? 'desc' : null;
  if (dir) {
    const extra = countOrderBreaks(joined, dir) - countOrderBreaks(context, dir);
    if (extra > 0) {
      problems.push(
        `breaks ${dir === 'desc' ? 'reverse-' : ''}chronological order: ${joined.join(' → ')}`,
      );
    }
  }

  if (problems.length === 0) {
    return {
      id: 'journal-date',
      pass: true,
      detail: `dates consistent (${dir ?? 'order unknown'}): ${joined.join(' → ')}`,
    };
  }
  return { id: 'journal-date', pass: false, detail: problems.join('; ') };
}

// ─── over-length ────────────────────────────────────────────────────

export function checkOverLength(input: CheckInput): CheckResult | null {
  const max = input.scenario?.max_completion_chars;
  if (max === undefined) return null;
  const len = input.completion?.length ?? 0;
  return len > max
    ? { id: 'over-length', pass: false, detail: `${len} chars > max ${max}` }
    : { id: 'over-length', pass: true, detail: `${len} chars <= max ${max}` };
}

// ─── must-not-start-with ────────────────────────────────────────────

export function checkMustNotStartWith(input: CheckInput): CheckResult | null {
  const banned = input.scenario?.requirements?.must_not_start_with;
  if (!banned || banned.length === 0) return null;
  const c = input.completion;
  if (c === null || c === '') return null;
  const hit = banned.find((b) => c.startsWith(b) || c.trimStart().startsWith(b));
  return hit
    ? { id: 'must-not-start-with', pass: false, detail: `completion starts with ${clip(hit)}` }
    : { id: 'must-not-start-with', pass: true, detail: 'no banned start' };
}

// ─── Aggregation ────────────────────────────────────────────────────

/** Run every check; return only the ones that apply to this input. */
export function runDeterministicChecks(input: CheckInput): CheckResult[] {
  return [
    checkNonEmpty(input),
    checkBoundaryWhitespace(input),
    checkDoubleSpace(input),
    checkSuffixEcho(input),
    checkJournalDates(input),
    checkOverLength(input),
    checkMustNotStartWith(input),
  ].filter((r): r is CheckResult => r !== null);
}

export type CheckCounts = Record<CheckId, { applied: number; failed: number }>;

export function summarizeChecks(perScenario: CheckResult[][]): CheckCounts {
  const counts = Object.fromEntries(
    CHECK_IDS.map((id) => [id, { applied: 0, failed: 0 }]),
  ) as CheckCounts;
  for (const results of perScenario) {
    for (const r of results) {
      counts[r.id].applied++;
      if (!r.pass) counts[r.id].failed++;
    }
  }
  return counts;
}

/**
 * The inserted completion shown in place, as the user sees it:
 * `…prefix tail⟦completion⟧suffix head…`. Null renders as `⟦⟧`.
 */
export function renderJoin(
  prefix: string,
  completion: string | null,
  suffix: string,
  contextChars = 300,
): string {
  const tail = prefix.length > contextChars ? '…' + prefix.slice(-contextChars) : prefix;
  const head = suffix.length > contextChars ? suffix.slice(0, contextChars) + '…' : suffix;
  return `${tail}⟦${completion ?? ''}⟧${head}`;
}
