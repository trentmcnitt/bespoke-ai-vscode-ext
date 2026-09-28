/**
 * Pure latency statistics over usage-ledger rows (`~/.bespokeai/usage-ledger*.jsonl`).
 * Used by `src/scripts/latency-report.ts`. No `vscode` or filesystem dependency.
 *
 * What the numbers mean (see `evals/latency-2026-09.md` for the full definition):
 *   - CLI backend: `durationMs` is the Claude Agent SDK's `duration_ms` for that turn,
 *     measured inside the CLI process. It excludes pool slot wait (`waitMs`, reported
 *     separately), debounce, the pool IPC hop, post-processing, and render.
 *   - API backend: `durationMs` is the adapter's wall clock around the HTTP call.
 *   - `durationApiMs` is NOT used. On the CLI backend, ledger rows written before the
 *     per-turn fix hold the SDK's cumulative per-session value; newer rows hold an
 *     approximate per-turn delta.
 *
 * The ledger's `project` field is never read.
 */

export type LatencyBackend = 'claude-code' | 'api' | 'ollama';

export interface LatencyRow {
  ts: number;
  backend: LatencyBackend;
  model: string;
  durationMs: number;
  /** Pool slot wait (CLI only). Undefined when the ledger row has no `waitMs`. */
  waitMs?: number;
}

export type ExclusionReason =
  | 'unparseable'
  | 'not-completion'
  | 'synthetic-model'
  | 'no-sdk-metadata'
  | 'invalid-duration';

export type Classification = { row: LatencyRow } | { excluded: ExclusionReason };

/**
 * Infer the backend for a ledger entry.
 *
 * Only the API providers write `backend: 'api'`; the CLI path has never written the field,
 * so an absent `backend` means Claude Code CLI. The ledger does not record the API provider,
 * so Ollama is inferred from its `name:tag` model-id form (a `:` with no `/`, which excludes
 * OpenRouter ids such as `vendor/model:free`).
 */
export function inferBackend(entry: { backend?: unknown; model?: unknown }): LatencyBackend {
  if (entry.backend === 'api') {
    const model = typeof entry.model === 'string' ? entry.model : '';
    return model.includes(':') && !model.includes('/') ? 'ollama' : 'api';
  }
  return 'claude-code';
}

/** Decide whether a parsed ledger entry is a usable completion latency sample. */
export function classifyEntry(entry: unknown): Classification {
  if (!entry || typeof entry !== 'object') return { excluded: 'unparseable' };
  const e = entry as Record<string, unknown>;
  if (typeof e.ts !== 'number' || typeof e.source !== 'string') {
    return { excluded: 'unparseable' };
  }
  // Excludes warmup, startup, commit-message, suggest-edit, command.
  if (e.source !== 'completion') return { excluded: 'not-completion' };
  const model = typeof e.model === 'string' ? e.model : '';
  // The SDK labels locally-generated messages (errors, interrupts) as `<synthetic>`.
  if (model === '<synthetic>') return { excluded: 'synthetic-model' };
  const backend = inferBackend(e);
  // CLI rows without SDK metadata fell back to extension wall clock around a null/aborted
  // result (single-digit ms); they are not comparable to SDK-reported turn durations.
  if (backend === 'claude-code' && typeof e.sessionId !== 'string') {
    return { excluded: 'no-sdk-metadata' };
  }
  if (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs) || e.durationMs <= 0) {
    return { excluded: 'invalid-duration' };
  }
  const row: LatencyRow = { ts: e.ts, backend, model, durationMs: e.durationMs };
  if (typeof e.waitMs === 'number') row.waitMs = e.waitMs;
  return { row };
}

/** Parse one JSONL line. Returns null for blank or corrupt lines. */
export function parseLedgerLine(line: string): unknown | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Nearest-rank percentile: the smallest value such that at least p% of samples are <= it.
 * `sorted` must be ascending. Returns NaN for an empty array.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

export interface GroupStats {
  backend: LatencyBackend;
  model: string;
  /** `YYYY-MM` (UTC) when grouped by month, otherwise undefined. */
  month?: string;
  n: number;
  p50: number;
  p90: number;
  p95: number;
  firstTs: number;
  lastTs: number;
}

/** `YYYY-MM` in UTC. */
export function monthKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 7);
}

function summarize(values: number[]): { n: number; p50: number; p90: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
  };
}

/** Group rows by backend + model (and optionally UTC month); percentiles over `durationMs`. */
export function groupStats(rows: readonly LatencyRow[], byMonth = false): GroupStats[] {
  const groups = new Map<string, LatencyRow[]>();
  for (const r of rows) {
    const key = [r.backend, r.model, byMonth ? monthKey(r.ts) : ''].join('\u0000');
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const out: GroupStats[] = [];
  for (const list of groups.values()) {
    const first = list[0];
    out.push({
      backend: first.backend,
      model: first.model,
      month: byMonth ? monthKey(first.ts) : undefined,
      ...summarize(list.map((r) => r.durationMs)),
      firstTs: Math.min(...list.map((r) => r.ts)),
      lastTs: Math.max(...list.map((r) => r.ts)),
    });
  }
  return out.sort(
    (a, b) =>
      a.backend.localeCompare(b.backend) ||
      (a.month ?? '').localeCompare(b.month ?? '') ||
      b.n - a.n ||
      a.model.localeCompare(b.model),
  );
}

export interface WaitStats {
  /** First timestamp at which any row carried `waitMs` (the feature's first observation). */
  sinceTs: number;
  /** CLI completion rows at or after `sinceTs`. */
  n: number;
  /** Rows with `waitMs` present (it is only written when > 0). */
  nWithWait: number;
  /** Percentiles over all rows since `sinceTs`, treating an absent `waitMs` as 0. */
  p50: number;
  p90: number;
  p95: number;
  max: number;
}

/**
 * Pool slot wait for CLI rows. `waitMs` is only written when > 0, and rows from builds that
 * predate the field look identical to zero-wait rows, so stats start at the first row that
 * carries `waitMs`. Returns null when no row has it.
 */
export function waitStats(rows: readonly LatencyRow[]): WaitStats | null {
  const cli = rows.filter((r) => r.backend === 'claude-code');
  const withWait = cli.filter((r) => r.waitMs !== undefined);
  if (withWait.length === 0) return null;
  const sinceTs = Math.min(...withWait.map((r) => r.ts));
  const since = cli.filter((r) => r.ts >= sinceTs).map((r) => r.waitMs ?? 0);
  const s = summarize(since);
  return {
    sinceTs,
    n: s.n,
    nWithWait: withWait.length,
    p50: s.p50,
    p90: s.p90,
    p95: s.p95,
    max: Math.max(...since),
  };
}

export interface LatencyReport {
  rows: LatencyRow[];
  excluded: Record<ExclusionReason, number>;
}

/** Classify every line from one or more ledger files. */
export function buildReport(lines: Iterable<string>): LatencyReport {
  const excluded: Record<ExclusionReason, number> = {
    unparseable: 0,
    'not-completion': 0,
    'synthetic-model': 0,
    'no-sdk-metadata': 0,
    'invalid-duration': 0,
  };
  const rows: LatencyRow[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    const c = classifyEntry(parseLedgerLine(line));
    if ('row' in c) rows.push(c.row);
    else excluded[c.excluded]++;
  }
  rows.sort((a, b) => a.ts - b.ts);
  return { rows, excluded };
}

const BACKEND_LABEL: Record<LatencyBackend, string> = {
  'claude-code': 'Claude Code CLI (subscription)',
  api: 'API',
  ollama: 'API — Ollama (inferred)',
};

function day(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Groups smaller than this get flagged: their tail percentiles are single samples. */
export const LOW_N = 20;

function statsTable(groups: GroupStats[], withMonth: boolean): string {
  const head = withMonth
    ? '| Month (UTC) | Backend | Model | n | p50 ms | p90 ms | p95 ms |\n|---|---|---|--:|--:|--:|--:|'
    : '| Backend | Model | n | p50 ms | p90 ms | p95 ms | Dates (UTC) |\n|---|---|--:|--:|--:|--:|---|';
  const lines: string[] = groups.map((g) => {
    const n = g.n < LOW_N ? `${g.n}*` : String(g.n);
    const cells = [BACKEND_LABEL[g.backend], `\`${g.model}\``, n, g.p50, g.p90, g.p95];
    if (withMonth) cells.unshift(g.month ?? '');
    else cells.push(`${day(g.firstTs)} → ${day(g.lastTs)}`);
    return `| ${cells.join(' | ')} |`;
  });
  if (groups.some((g) => g.n < LOW_N)) {
    lines.push('', `\\* n < ${LOW_N}: p90/p95 rest on one or two samples and are not meaningful.`);
  }
  return [head, ...lines].join('\n');
}

/** Render the report as markdown. */
export function renderMarkdown(report: LatencyReport): string {
  const { rows, excluded } = report;
  if (rows.length === 0) return 'No completion rows found.\n';
  const out: string[] = [];
  out.push(
    `Completion requests: n=${rows.length}, ${day(rows[0].ts)} → ${day(rows[rows.length - 1].ts)} (UTC).`,
  );
  out.push(
    'Metric: backend request→response `durationMs` (CLI: SDK-reported turn time; API: adapter wall clock). ' +
      'Excludes debounce, slot wait, and render. Percentiles are nearest-rank.',
  );
  out.push('');
  out.push('### By backend and model');
  out.push('');
  out.push(statsTable(groupStats(rows), false));
  const present = new Set(rows.map((r) => r.backend));
  const absent = (['claude-code', 'api', 'ollama'] as const).filter((b) => !present.has(b));
  if (absent.length > 0) {
    out.push('');
    out.push(`No rows for: ${absent.map((b) => BACKEND_LABEL[b]).join(', ')}.`);
  }
  out.push('');
  out.push('### By month (UTC)');
  out.push('');
  out.push(statsTable(groupStats(rows, true), true));
  out.push('');
  out.push('### Pool slot wait (CLI, `waitMs`)');
  out.push('');
  const w = waitStats(rows);
  if (!w) {
    out.push('No rows carry `waitMs`.');
  } else {
    out.push(
      `Since first observation ${day(w.sinceTs)}: n=${w.n}, rows with non-zero wait=${w.nWithWait}, ` +
        `p50=${w.p50} ms, p90=${w.p90} ms, p95=${w.p95} ms, max=${w.max} ms (absent waitMs counted as 0).`,
    );
  }
  out.push('');
  out.push('### Excluded rows');
  out.push('');
  out.push(
    Object.entries(excluded)
      .map(([k, v]) => `${k}=${v}`)
      .join(', '),
  );
  return out.join('\n') + '\n';
}
