/**
 * Replay set: recorded real model outputs replayed through the CURRENT
 * extraction + post-processing pipeline and deterministic checks.
 *
 * - expected_final: what the pipeline produced (for drift cases, what it
 *   produces since the cited commit). Any change to extraction or
 *   post-processing that alters a real output shows up here as a diff.
 * - expected_checks: deterministic-check results, so known-bad raw outputs
 *   (suffix regurgitation, whitespace-only, boundary seams) stay flagged.
 * - must_avoid: invariants that still hold if expected_final is deliberately
 *   updated.
 *
 * No model calls, no network, no secrets. Rebuild the fixture with
 * `npx tsx src/test/quality/replay/build-replay-set.ts` (see evals/replay/README.md).
 */
import replaySetJson from '../fixtures/replay/replay-set.json';
import { runDeterministicChecks } from '../quality/deterministic-checks';
import {
  MustAvoid,
  ReplayCase,
  ReplaySet,
  checkInputFor,
  replayPipeline,
} from '../quality/replay/replay-pipeline';

const replaySet = replaySetJson as unknown as ReplaySet;
const SCAFFOLDING = /<\/?COMPLETION>|\{\{FILL_HERE\}\}/;
const PREAMBLE = /^(?:Here(?:'s| is)|Sure\b|Got it\b|Understood\b|Of course\b)/i;

function assertMustAvoid(c: ReplayCase, final: string | null, m: MustAvoid): void {
  const why = `${c.id} must_avoid ${m.kind}: ${m.note}`;
  switch (m.kind) {
    case 'tag-leak':
      expect(final ?? '', why).not.toMatch(SCAFFOLDING);
      break;
    case 'preamble':
      expect((final ?? '').trimStart(), why).not.toMatch(PREAMBLE);
      break;
    case 'prefix-echo':
      expect(m.value, why).toBeTruthy();
      expect((final ?? '').startsWith(m.value!), why).toBe(false);
      break;
    case 'suffix-overlap':
      expect(m.value, why).toBeTruthy();
      expect((final ?? '').trimEnd().endsWith(m.value!), why).toBe(false);
      break;
    case 'whitespace-final':
      expect(final, why).toBeNull();
      break;
    case 'check-stays-failing': {
      const checks = runDeterministicChecks(checkInputFor(c, final));
      const hit = checks.find((r) => r.id === m.value);
      expect(hit, why).toBeDefined();
      expect(hit!.pass, why).toBe(false);
      break;
    }
    default: {
      const never: never = m.kind;
      throw new Error(`unknown must_avoid kind ${String(never)}`);
    }
  }
}

describe('replay set', () => {
  const cases = replaySet.cases;

  it('covers all three extraction strategies and only synthetic scenarios', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40);
    const strategies = new Set(cases.map((c) => c.strategy));
    expect([...strategies].sort()).toEqual([
      'instruction-extraction',
      'prefill-extraction',
      'tag-extraction',
    ]);
    // regression-* scenarios come from real usage and must never be in the set.
    expect(cases.filter((c) => c.scenario.startsWith('regression'))).toEqual([]);
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
  });

  describe.each(cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const { final } = replayPipeline(c);

    it('current pipeline reproduces expected_final', () => {
      expect(final).toBe(c.expected_final);
    });

    it('deterministic checks match expected_checks', () => {
      expect(runDeterministicChecks(checkInputFor(c, final))).toEqual(c.expected_checks);
    });

    it('never leaks scaffolding or returns whitespace-only ghost text', () => {
      if (final !== null) {
        expect(final).not.toMatch(SCAFFOLDING);
        expect(final.trim()).not.toBe('');
      }
      for (const m of c.must_avoid) assertMustAvoid(c, final, m);
    });
  });
});
