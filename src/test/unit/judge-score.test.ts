import { describe, expect, it } from 'vitest';
import {
  computeMetrics,
  confusion,
  fmtRate,
  Label,
  parseCsv,
  parseHumanPass,
  parseLabels,
  rate,
  Verdict,
  wilson,
} from '../quality/judge-validation/score';

const lab = (id: string, human: boolean | null, unsure = false): Label => ({
  id,
  human_pass: human,
  unsure,
});
const ver = (split: 'dev' | 'test', judge: boolean, det = true): Verdict => ({
  split,
  judge_pass: judge,
  det_pass: det,
});

describe('judge-validation scoring', () => {
  it('confusion counts with pass as the positive class', () => {
    expect(
      confusion([
        { human: true, predicted: true },
        { human: true, predicted: false },
        { human: false, predicted: false },
        { human: false, predicted: true },
        { human: false, predicted: true },
      ]),
    ).toEqual({ tp: 1, fn: 1, tn: 1, fp: 2 });
  });

  it('TPR, TNR and agreement for judge and judge AND det checks', () => {
    const verdicts: Record<string, Verdict> = {
      a: ver('test', true), // human pass, judge pass
      b: ver('test', true), // human pass, judge pass
      c: ver('test', false), // human pass, judge fail
      d: ver('test', true, false), // human fail, judge pass, det fail
      e: ver('test', false), // human fail, judge fail
      f: ver('dev', true), // other split
    };
    const labels = [
      lab('a', true),
      lab('b', true),
      lab('c', true),
      lab('d', false),
      lab('e', false),
      lab('f', false),
    ];
    const m = computeMetrics(labels, verdicts, 'test');
    expect(m.n).toBe(5);
    expect([m.humanPass, m.humanFail]).toEqual([3, 2]);
    expect(m.judge.tpr.value).toBeCloseTo(2 / 3);
    expect(m.judge.tnr.value).toBeCloseTo(1 / 2);
    expect(m.judge.agreement.value).toBeCloseTo(3 / 5);
    // Det check turns d's judge pass into a fail → TNR 2/2, TPR unchanged.
    expect(m.combined.tpr.value).toBeCloseTo(2 / 3);
    expect(m.combined.tnr.value).toBe(1);
    expect(m.combined.agreement.value).toBeCloseTo(4 / 5);
  });

  it('excludes unlabeled and unsure rows, counting unsure', () => {
    const verdicts = { a: ver('dev', true), b: ver('dev', false), c: ver('dev', true) };
    const m = computeMetrics(
      [lab('a', true), lab('b', null), lab('c', null, true)],
      verdicts,
      'dev',
    );
    expect(m.n).toBe(1);
    expect(m.unsure).toBe(1);
    expect(m.judge.tnr.value).toBeNull();
    expect(fmtRate(m.judge.tnr)).toBe('— (0/0)');
  });

  it('takes the split from verdicts, not labels, and rejects unknown ids', () => {
    expect(() => computeMetrics([lab('zz', true)], {}, 'dev')).toThrow(/unknown id/);
  });

  it('Wilson interval matches a known value and stays in [0, 1]', () => {
    const [lo, hi] = wilson(8, 10)!;
    expect(lo).toBeCloseTo(0.4902, 3);
    expect(hi).toBeCloseTo(0.9433, 3);
    const [lo0, hi0] = wilson(0, 5)!;
    expect(lo0).toBe(0);
    expect(hi0).toBeGreaterThan(0);
    expect(wilson(5, 5)![1]).toBe(1);
    expect(wilson(0, 0)).toBeNull();
    expect(rate(3, 4).value).toBe(0.75);
  });

  it('parses human_pass spellings', () => {
    for (const s of ['pass', 'P', '1', 'yes', 'true']) expect(parseHumanPass(s).value).toBe(true);
    for (const s of ['fail', 'f', '0', 'no']) expect(parseHumanPass(s).value).toBe(false);
    expect(parseHumanPass('unsure')).toEqual({ value: null, unsure: true });
    expect(parseHumanPass(' ')).toEqual({ value: null, unsure: false });
    expect(() => parseHumanPass('maybe')).toThrow();
  });

  it('parses CSV with quoted notes containing commas, quotes and newlines', () => {
    const csv =
      'id,split,human_pass,notes\r\njv-1,dev,pass,"missing space, ""behindinadequate""\nsecond line"\njv-2,test,,\n';
    expect(parseCsv(csv)).toEqual([
      ['id', 'split', 'human_pass', 'notes'],
      ['jv-1', 'dev', 'pass', 'missing space, "behindinadequate"\nsecond line'],
      ['jv-2', 'test', '', ''],
    ]);
    expect(parseLabels(csv)).toEqual([lab('jv-1', true), lab('jv-2', null)]);
  });
});
