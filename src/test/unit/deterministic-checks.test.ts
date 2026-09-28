import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  CheckInput,
  checkBoundaryWhitespace,
  checkJournalDates,
  checkMustNotStartWith,
  checkNonEmpty,
  checkOverLength,
  checkSuffixEcho,
  extractDateHeadings,
  extractRawCompletion,
  renderJoin,
  runDeterministicChecks,
  summarizeChecks,
} from '../quality/deterministic-checks';
import { collectProvenance, fileHash12, writeCheckArtifacts } from '../quality/run-artifacts';
import { parseJudgePass } from '../quality/rescore';

function prose(overrides: Partial<CheckInput>): CheckInput {
  return { mode: 'prose', prefix: '', suffix: '', completion: '', ...overrides };
}

describe('checkBoundaryWhitespace', () => {
  it('fails when the completion runs into the last word of the prefix', () => {
    const r = checkBoundaryWhitespace(
      prose({
        prefix: "Flaky tests are almost never timing issues. They're usually bugs hiding behind",
        completion: 'inadequate assertions or error handling that swallows evidence.',
      }),
    );
    expect(r?.pass).toBe(false);
    expect(r?.detail).toContain('start');
  });

  it('fails after sentence punctuation with no space', () => {
    const r = checkBoundaryWhitespace(
      prose({
        prefix: "Kenji estimates 30-40% of metric series haven't been queried in 90+ days.",
        completion: 'The obvious question is whether those metrics are obsolete.',
        suffix: " He'll write a script to identify them.",
      }),
    );
    expect(r?.pass).toBe(false);
  });

  it('fails at the end seam when the completion runs into the suffix', () => {
    const r = checkBoundaryWhitespace(
      prose({
        prefix: 'was one of those changes that ',
        completion: 'looked',
        suffix: 'seemed simple on paper but turned into a three-month project.',
      }),
    );
    expect(r?.pass).toBe(false);
    expect(r?.detail).toContain('end');
  });

  it('passes when the completion starts with a space', () => {
    const r = checkBoundaryWhitespace(
      prose({
        prefix: 'They are usually bugs hiding behind',
        completion: ' inadequate assertions.',
        suffix: '\n\n## Next',
      }),
    );
    expect(r?.pass).toBe(true);
  });

  it('passes when the prefix already ends in whitespace or a newline', () => {
    expect(
      checkBoundaryWhitespace(
        prose({ prefix: 'Options discussed:\n', completion: 'Prune metrics' }),
      )?.pass,
    ).toBe(true);
    expect(
      checkBoundaryWhitespace(prose({ prefix: 'it already looks ', completion: 'great' }))?.pass,
    ).toBe(true);
  });

  it('passes when the prefix ends in a list marker or opening markup', () => {
    expect(
      checkBoundaryWhitespace(prose({ prefix: 'Goals:\n- ', completion: 'Ship it' }))?.pass,
    ).toBe(true);
    expect(checkBoundaryWhitespace(prose({ prefix: 'see (', completion: 'below)' }))?.pass).toBe(
      true,
    );
  });

  it('passes when the completion starts with punctuation', () => {
    const r = checkBoundaryWhitespace(
      prose({ prefix: 'if you think carefully', completion: ' — about what you remove.' }),
    );
    expect(r?.pass).toBe(true);
  });

  it('does not apply to mid_word scenarios', () => {
    expect(
      checkBoundaryWhitespace(
        prose({
          prefix: 'The team discussed the implementa',
          completion: 'tion plan.',
          scenario: { mid_word: true },
        }),
      ),
    ).toBeNull();
  });

  it('does not apply to code (member access is not a missing space)', () => {
    expect(
      checkBoundaryWhitespace({
        mode: 'code',
        prefix: 'users.filter(user => user.',
        completion: 'isActive(',
        suffix: '))',
      }),
    ).toBeNull();
  });

  it('does not apply to empty completions', () => {
    expect(checkBoundaryWhitespace(prose({ prefix: 'word', completion: null }))).toBeNull();
  });
});

describe('checkSuffixEcho', () => {
  const suffix =
    ' so pale on such a fine morning.\n\nMargaret Ellerby had run the Thornfield post office for as long as anyone could remember.';

  it('fails when the raw output regurgitates the suffix head (inside tags)', () => {
    const r = checkSuffixEcho(
      prose({
        suffix,
        completion: ' —',
        rawResponse:
          '<COMPLETION> — so pale on such a fine morning.\n\nMargaret  Ellerby had run the Thornfield post office for years.</COMPLETION>',
      }),
    );
    expect(r?.pass).toBe(false);
  });

  it('matches across whitespace differences', () => {
    const r = checkSuffixEcho(
      prose({
        suffix,
        completion: 'x',
        rawResponse: 'so pale   on such\n a fine morning. Margaret',
      }),
    );
    expect(r?.pass).toBe(false);
  });

  it('passes when the raw output does not contain the suffix head', () => {
    const r = checkSuffixEcho(
      prose({
        suffix,
        completion: ' looked',
        rawResponse: '<COMPLETION> looked</COMPLETION>',
      }),
    );
    expect(r?.pass).toBe(true);
  });

  it('ignores echoes outside the COMPLETION tags', () => {
    const r = checkSuffixEcho(
      prose({
        suffix,
        completion: ' looked',
        rawResponse: 'so pale on such a fine morning <COMPLETION> looked</COMPLETION>',
      }),
    );
    expect(r?.pass).toBe(true);
  });

  it('is not applicable without a raw response or with a short suffix', () => {
    expect(checkSuffixEcho(prose({ suffix, completion: 'x' }))).toBeNull();
    expect(
      checkSuffixEcho({
        mode: 'code',
        prefix: '',
        suffix: '\n  }\n}\n',
        completion: 'x',
        rawResponse: '}',
      }),
    ).toBeNull();
  });
});

describe('extractRawCompletion', () => {
  it('handles full tags, missing open tag (prefill), and no tags', () => {
    expect(extractRawCompletion('<COMPLETION>abc</COMPLETION>')).toBe('abc');
    expect(extractRawCompletion('abc</COMPLETION>')).toBe('abc');
    expect(extractRawCompletion('<COMPLETION>abc')).toBe('abc');
    expect(extractRawCompletion('<output>abc</output>')).toBe('<output>abc</output>');
  });
});

describe('checkJournalDates', () => {
  const header = '#journal\n\n#### *Notes about anything*\n\n';

  it('fails when a new date breaks reverse-chronological order', () => {
    const r = checkJournalDates(
      prose({
        prefix: header + '02-07-26\n\nPiano practice. Need more practice.\n\n---\n\n',
        completion: '02-08-26\n\n',
        suffix: '**Reading — DDIA**\n\nChapter 5.\n\n02-06-26\n\nQuiet day.\n\n02-05-26\n\nGym.',
      }),
    );
    expect(r?.pass).toBe(false);
    expect(r?.detail).toContain('reverse-chronological');
  });

  it('fails on a duplicated date heading (with an annotation)', () => {
    const r = checkJournalDates(
      prose({
        prefix: '# Dev log\n\n## 02-09-26\n\n### SQLite\n\nAdded PRAGMA optimize.\n\n',
        completion: '---\n\n## 02-09-26 (afternoon)\n\n### Nix flake update broke everything\n\n',
        suffix: 'Ran nix flake update.\n\n## 02-08-26\n\n### Caddy\n\nEvaluating Caddy.',
      }),
    );
    expect(r?.pass).toBe(false);
    expect(r?.detail).toContain('duplicate 02-09-26');
  });

  it('passes a correctly ordered new entry at the top of a reverse-chronological file', () => {
    const r = checkJournalDates(
      prose({
        prefix: header,
        completion: '02-09-26\n\nStarted on the garage shelves.\n\n',
        suffix: '02-08-26\n\nQuiet day.\n\n02-07-26\n\nPiano.',
      }),
    );
    expect(r?.pass).toBe(true);
  });

  it('reads a date typed across the cursor as one heading', () => {
    const ok = checkJournalDates(
      prose({
        prefix: header + '0',
        completion: '1-31-26',
        suffix: '\n\n01-30-26\n\nSet EDITOR.\n\n01-29-26\n\nOpenTask rebrand.',
      }),
    );
    expect(ok?.pass).toBe(true);
    const dup = checkJournalDates(
      prose({
        prefix: header + '0',
        completion: '1-30-26',
        suffix: '\n\n01-30-26\n\nSet EDITOR.\n\n01-29-26\n\nOpenTask rebrand.',
      }),
    );
    expect(dup?.pass).toBe(false);
  });

  it('passes prose that adds no dates', () => {
    const r = checkJournalDates(
      prose({
        prefix: header + '02-07-26\n\nIt already looks',
        completion: ' so much better.',
        suffix: '\n\n02-06-26\n\nQuiet day.',
      }),
    );
    expect(r?.pass).toBe(true);
  });

  it('does not blame the completion for disorder already in the context', () => {
    const r = checkJournalDates(
      prose({
        prefix: '02-05-26\n\nA.\n\n02-07-26\n\nB.\n\n',
        completion: 'More notes.',
        suffix: '\n\n02-06-26\n\nC.\n\n02-04-26\n\nD.',
      }),
    );
    expect(r?.pass).toBe(true);
  });

  it('does not apply when the context has fewer than two date headings', () => {
    expect(
      checkJournalDates(prose({ prefix: '# Notes\n\n', completion: '02-08-26\n\nHi', suffix: '' })),
    ).toBeNull();
  });

  it('ignores dates inside sentences', () => {
    expect(extractDateHeadings('Met on 02-07-26 at noon.\n## 02-08-26\n')).toEqual(['02-08-26']);
  });
});

describe('checkOverLength', () => {
  it('fails above the declared cap and passes at or below it', () => {
    const scenario = { max_completion_chars: 120 };
    expect(checkOverLength(prose({ completion: 'x'.repeat(639), scenario }))?.pass).toBe(false);
    expect(checkOverLength(prose({ completion: ' about what you remove,', scenario }))?.pass).toBe(
      true,
    );
  });

  it('does not apply without a cap', () => {
    expect(checkOverLength(prose({ completion: 'x'.repeat(5000) }))).toBeNull();
  });
});

describe('checkNonEmpty', () => {
  it('fails on null and whitespace-only output, naming the cause', () => {
    const ws = checkNonEmpty(
      prose({ completion: null, rawResponse: '<COMPLETION>\n\n</COMPLETION>' }),
    );
    expect(ws.pass).toBe(false);
    expect(ws.detail).toContain('whitespace');
    const err = checkNonEmpty(prose({ completion: null, providerError: true }));
    expect(err.pass).toBe(false);
    expect(err.detail).toContain('provider error');
  });

  it('passes empty output when the scenario allows it', () => {
    expect(
      checkNonEmpty(
        prose({ completion: null, rawResponse: '\n', scenario: { expect_empty_ok: true } }),
      ).pass,
    ).toBe(true);
  });

  it('passes non-empty output', () => {
    expect(checkNonEmpty(prose({ completion: ' looked' })).pass).toBe(true);
  });
});

describe('checkMustNotStartWith', () => {
  const scenario = { requirements: { must_not_start_with: ['- '] } };

  it('fails when the completion re-emits the list marker', () => {
    expect(
      checkMustNotStartWith(
        prose({ completion: '- **Open source** - Transparency and control', scenario }),
      )?.pass,
    ).toBe(false);
  });

  it('passes when "- " only appears inside the item', () => {
    expect(
      checkMustNotStartWith(
        prose({ completion: '**Recurring tasks** - Robust support for schedules', scenario }),
      )?.pass,
    ).toBe(true);
  });

  it('does not apply without the requirement', () => {
    expect(checkMustNotStartWith(prose({ completion: '- x' }))).toBeNull();
  });
});

describe('runDeterministicChecks / summarizeChecks', () => {
  it('returns only applicable checks and counts applied vs failed', () => {
    const a = runDeterministicChecks(prose({ prefix: 'hiding behind', completion: 'bugs' }));
    const b = runDeterministicChecks({
      mode: 'code',
      prefix: 'x.',
      suffix: '',
      completion: 'y',
    });
    expect(a.map((c) => c.id)).toEqual(['non-empty', 'boundary-whitespace']);
    expect(b.map((c) => c.id)).toEqual(['non-empty']);
    const counts = summarizeChecks([a, b]);
    expect(counts['non-empty']).toEqual({ applied: 2, failed: 0 });
    expect(counts['boundary-whitespace']).toEqual({ applied: 1, failed: 1 });
    expect(counts['suffix-echo']).toEqual({ applied: 0, failed: 0 });
  });
});

describe('renderJoin', () => {
  it('shows the completion in place with bounded context', () => {
    expect(renderJoin('changes that', 'looked', ' seemed simple')).toBe(
      'changes that⟦looked⟧ seemed simple',
    );
    expect(renderJoin('abcdef', null, 'uvwxyz', 3)).toBe('…def⟦⟧uvw…');
  });
});

describe('run artifacts', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'det-checks-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('writes checks.json and rendered.txt', () => {
    const checks = writeCheckArtifacts(
      dir,
      prose({ prefix: 'hiding behind', completion: 'bugs', suffix: '.' }),
    );
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'checks.json'), 'utf8'));
    expect(saved.pass).toBe(false);
    expect(saved.checks).toEqual(checks);
    expect(fs.readFileSync(path.join(dir, 'rendered.txt'), 'utf8')).toBe('hiding behind⟦bugs⟧.');
  });

  it('hashes the rubric and records provenance', () => {
    const rubric = path.join(dir, 'rubric.md');
    fs.writeFileSync(rubric, 'rubric');
    expect(fileHash12(rubric)).toMatch(/^[0-9a-f]{12}$/);
    expect(fileHash12(path.join(dir, 'missing.md'))).toBeNull();
    const p = collectProvenance({
      repoRoot: dir, // not a git repo → nulls, no throw
      backend: 'api',
      model: 'api/xai-grok',
      preset: 'xai-grok',
      rubricPath: rubric,
      now: new Date('2026-03-26T21:32:33Z'),
    });
    expect(p).toMatchObject({
      date: '2026-03-26T21:32:33.000Z',
      backend: 'api',
      model: 'api/xai-grok',
      preset: 'xai-grok',
      rubricSha256: fileHash12(rubric),
    });
  });
});

describe('parseJudgePass', () => {
  it('reads every historical validation.md format', () => {
    expect(parseJudgePass('{"pass": false, "score": 3}')).toBe(false);
    expect(parseJudgePass('# Validation: x\n\n**Result: PASS**\n**Score: 9**')).toBe(true);
    expect(parseJudgePass('**Verdict:** FAIL (score 3/10)')).toBe(false);
    expect(parseJudgePass('## Validation: x\n- **Pass:** YES\n- **Score:** 7')).toBe(true);
    expect(parseJudgePass('no verdict here')).toBeNull();
  });
});
