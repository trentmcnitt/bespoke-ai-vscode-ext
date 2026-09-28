import {
  buildReport,
  classifyEntry,
  groupStats,
  inferBackend,
  monthKey,
  percentile,
  renderMarkdown,
  waitStats,
  type LatencyRow,
} from '../../utils/latency-stats';

const JUN_1 = Date.UTC(2026, 5, 1, 12);
const JUL_1 = Date.UTC(2026, 6, 1, 12);

function cliCompletion(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ts: JUN_1,
    source: 'completion',
    model: 'claude-sonnet-5',
    durationMs: 1000,
    durationApiMs: 50_000,
    sessionId: 'sess-1',
    slotIndex: 0,
    inputChars: 10,
    outputChars: 5,
    ...overrides,
  };
}

function row(overrides: Partial<LatencyRow> = {}): LatencyRow {
  return { ts: JUN_1, backend: 'claude-code', model: 'm', durationMs: 1000, ...overrides };
}

describe('percentile (nearest-rank)', () => {
  const oneToTen = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

  it('matches known nearest-rank values', () => {
    expect(percentile(oneToTen, 50)).toBe(5);
    expect(percentile(oneToTen, 90)).toBe(9);
    expect(percentile(oneToTen, 95)).toBe(10);
    expect(percentile(oneToTen, 100)).toBe(10);
    expect(percentile(oneToTen, 0)).toBe(1);
  });

  it('handles a single sample and an empty array', () => {
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
    expect(percentile([], 50)).toBeNaN();
  });

  it('p95 of 100 samples is the 95th value', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 95)).toBe(95);
  });
});

describe('inferBackend', () => {
  it('treats a missing backend field as the Claude Code CLI', () => {
    expect(inferBackend({ model: 'claude-opus-4-8' })).toBe('claude-code');
  });

  it('keeps api rows as api, including OpenRouter ids with a :variant suffix', () => {
    expect(inferBackend({ backend: 'api', model: 'grok-4-fast' })).toBe('api');
    expect(inferBackend({ backend: 'api', model: 'meta-llama/llama-3:free' })).toBe('api');
  });

  it('infers Ollama from a name:tag model id', () => {
    expect(inferBackend({ backend: 'api', model: 'qwen3:8b' })).toBe('ollama');
  });
});

describe('classifyEntry', () => {
  it('accepts a CLI completion with SDK metadata', () => {
    const c = classifyEntry(cliCompletion({ waitMs: 3 }));
    expect(c).toEqual({
      row: {
        ts: JUN_1,
        backend: 'claude-code',
        model: 'claude-sonnet-5',
        durationMs: 1000,
        waitMs: 3,
      },
    });
  });

  it('never carries durationApiMs or project into the row', () => {
    const c = classifyEntry(cliCompletion({ project: 'secret-project' }));
    expect('row' in c && Object.keys(c.row)).toEqual(['ts', 'backend', 'model', 'durationMs']);
  });

  it('accepts an API completion (no sessionId needed)', () => {
    const c = classifyEntry({
      ts: JUN_1,
      source: 'completion',
      model: 'gpt-4.1-nano',
      backend: 'api',
      durationMs: 400,
    });
    expect('row' in c && c.row.backend).toBe('api');
  });

  it.each([
    ['warmup', { source: 'warmup' }, 'not-completion'],
    ['startup', { source: 'startup', model: 'opus', durationMs: 0 }, 'not-completion'],
    ['commit-message', { source: 'commit-message' }, 'not-completion'],
    ['synthetic model', { model: '<synthetic>' }, 'synthetic-model'],
    [
      'CLI wall-clock fallback',
      { sessionId: undefined, model: 'opus', durationMs: 3 },
      'no-sdk-metadata',
    ],
    ['zero duration', { durationMs: 0 }, 'invalid-duration'],
    ['missing ts', { ts: undefined }, 'unparseable'],
  ])('excludes %s', (_label, overrides, reason) => {
    expect(classifyEntry(cliCompletion(overrides))).toEqual({ excluded: reason });
  });

  it('excludes non-objects', () => {
    expect(classifyEntry(null)).toEqual({ excluded: 'unparseable' });
    expect(classifyEntry('x')).toEqual({ excluded: 'unparseable' });
  });
});

describe('monthKey', () => {
  it('buckets by UTC month', () => {
    expect(monthKey(Date.UTC(2026, 6, 31, 23, 59))).toBe('2026-07');
    expect(monthKey(Date.UTC(2026, 7, 1, 0, 0))).toBe('2026-08');
  });
});

describe('groupStats', () => {
  const rows: LatencyRow[] = [
    ...[100, 200, 300, 400].map((d) => row({ model: 'a', durationMs: d })),
    ...[1000, 3000].map((d) => row({ model: 'a', durationMs: d, ts: JUL_1 })),
    row({ model: 'b', durationMs: 50 }),
    row({ model: 'a', backend: 'api', durationMs: 7 }),
  ];

  it('groups by backend and model', () => {
    const g = groupStats(rows);
    expect(g.map((x) => [x.backend, x.model, x.n])).toEqual([
      ['api', 'a', 1],
      ['claude-code', 'a', 6],
      ['claude-code', 'b', 1],
    ]);
    const a = g[1];
    expect(a.p50).toBe(300);
    expect(a.p95).toBe(3000);
    expect(a.firstTs).toBe(JUN_1);
    expect(a.lastTs).toBe(JUL_1);
    expect(a.month).toBeUndefined();
  });

  it('splits by month when asked', () => {
    const g = groupStats(rows, true).filter((x) => x.backend === 'claude-code' && x.model === 'a');
    expect(g.map((x) => [x.month, x.n, x.p50])).toEqual([
      ['2026-06', 4, 200],
      ['2026-07', 2, 1000],
    ]);
  });
});

describe('waitStats', () => {
  it('returns null when no row has waitMs', () => {
    expect(waitStats([row(), row()])).toBeNull();
  });

  it('starts at the first row with waitMs and counts absent values as 0', () => {
    const w = waitStats([
      row({ ts: 1 }), // before the field existed — excluded
      row({ ts: 10, waitMs: 5 }),
      row({ ts: 11 }),
      row({ ts: 12 }),
      row({ ts: 13, waitMs: 40 }),
      row({ ts: 14, backend: 'api' }), // API rows never wait on a slot — excluded
    ]);
    expect(w).toMatchObject({ sinceTs: 10, n: 4, nWithWait: 2, p50: 0, p95: 40, max: 40 });
  });
});

describe('buildReport / renderMarkdown', () => {
  it('classifies lines, skipping blanks and counting corrupt ones', () => {
    const lines = [
      JSON.stringify(cliCompletion()),
      '',
      '{not json',
      JSON.stringify(cliCompletion({ source: 'warmup' })),
    ];
    const r = buildReport(lines);
    expect(r.rows).toHaveLength(1);
    expect(r.excluded.unparseable).toBe(1);
    expect(r.excluded['not-completion']).toBe(1);
  });

  it('renders tables, flags low n, and names absent backends', () => {
    const md = renderMarkdown(buildReport([JSON.stringify(cliCompletion())]));
    expect(md).toContain('| Claude Code CLI (subscription) | `claude-sonnet-5` | 1* | 1000 |');
    expect(md).toContain('No rows for: API, API — Ollama (inferred).');
    expect(md).toContain('No rows carry `waitMs`.');
    expect(md).not.toContain('project');
  });
});
