import { describe, it, expect } from 'vitest';
import {
  buildFullCommitPrompt,
  parseCommitMessage,
  truncateDiff,
  MAX_COMMIT_DIFF_CHARS,
} from '../../utils/commit-message-utils';

describe('parseCommitMessage', () => {
  it('returns trimmed stdout', () => {
    expect(parseCommitMessage('  fix: add logging\n\n')).toBe('fix: add logging');
  });

  it('preserves multi-line messages with internal whitespace', () => {
    const msg = 'feat: add foo\n\nAdds foo to the bar module.';
    expect(parseCommitMessage(msg)).toBe(msg);
  });

  it('returns null for empty string', () => {
    expect(parseCommitMessage('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseCommitMessage('   \n\n  ')).toBeNull();
  });

  it('strips markdown code fences', () => {
    expect(parseCommitMessage('```\nfeat: add foo\n```')).toBe('feat: add foo');
  });

  it('strips markdown code fences with language tag', () => {
    expect(parseCommitMessage('```text\nfix: bar\n```')).toBe('fix: bar');
  });

  it('preserves text that is not fully wrapped in fences', () => {
    expect(parseCommitMessage('feat: add foo\n```\ndetails\n```')).toBe(
      'feat: add foo\n```\ndetails\n```',
    );
  });
});

describe('buildFullCommitPrompt', () => {
  const sampleDiff = `diff --git a/src/foo.ts b/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
+console.log('hello');`;

  it('wraps diff in tags with instructions', () => {
    const result = buildFullCommitPrompt(sampleDiff);
    expect(result).toContain('<instructions>');
    expect(result).toContain('</instructions>');
    expect(result).toContain('<diff>');
    expect(result).toContain('</diff>');
    expect(result).toContain(sampleDiff);
  });

  it('includes commit message generation instructions', () => {
    const result = buildFullCommitPrompt(sampleDiff);
    expect(result).toContain('commit message generator');
    expect(result).toContain('conventional commit');
    expect(result).toContain('imperative mood');
  });
});

describe('truncateDiff', () => {
  it('returns short diffs unchanged', () => {
    const d = 'diff --git a/x b/x\n+hello\n';
    expect(truncateDiff(d)).toBe(d);
    expect(truncateDiff(d, 10_000)).toBe(d);
  });

  it('returns a diff exactly at the limit unchanged', () => {
    const d = 'a'.repeat(100);
    expect(truncateDiff(d, 100)).toBe(d);
  });

  it('cuts at a line boundary and appends an omission marker', () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `line ${String(i).padStart(3, '0')} ${'#'.repeat(20)}`,
    );
    const d = lines.join('\n');
    const out = truncateDiff(d, 300);
    const [body, marker] = out.split('\n\n[diff truncated: ');
    expect(marker).toMatch(/^[\d,]+ more characters omitted\]$/);
    expect(body.length).toBeLessThanOrEqual(300);
    expect(body.endsWith('#')).toBe(true); // ended on a complete line, not mid-line
    expect(d.startsWith(body)).toBe(true);
  });

  it('falls back to a hard cut when there is no newline before the limit', () => {
    const d = 'x'.repeat(1000);
    const out = truncateDiff(d, 200);
    expect(out.startsWith('x'.repeat(200))).toBe(true);
    expect(out).toContain('800 more characters omitted');
  });

  it('default limit is the exported constant', () => {
    const d = 'y\n'.repeat(MAX_COMMIT_DIFF_CHARS);
    expect(truncateDiff(d).length).toBeLessThan(MAX_COMMIT_DIFF_CHARS + 100);
  });
});
