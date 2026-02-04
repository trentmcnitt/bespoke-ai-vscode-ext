import { describe, it, expect } from 'vitest';
import { buildFullCommitPrompt, parseCommitMessage } from '../../utils/commit-message-utils';

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
