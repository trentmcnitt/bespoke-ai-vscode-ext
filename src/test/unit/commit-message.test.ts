import { describe, it, expect } from 'vitest';
import { buildCommitPrompt, getSystemPrompt, parseCommitMessage, DEFAULT_SYSTEM_PROMPT } from '../../utils/commit-message-utils';

describe('buildCommitPrompt', () => {
  const sampleDiff = `diff --git a/src/foo.ts b/src/foo.ts
index 1234567..abcdefg 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -1,3 +1,4 @@
 function foo() {
+  console.log('hello');
   return 42;
 }`;

  it('includes the diff wrapped in tags', () => {
    const result = buildCommitPrompt(sampleDiff);
    expect(result).toContain('<diff>');
    expect(result).toContain('</diff>');
    expect(result).toContain(sampleDiff);
  });

  it('does not include the system prompt', () => {
    const result = buildCommitPrompt(sampleDiff);
    expect(result).not.toContain('commit message generator');
  });
});

describe('getSystemPrompt', () => {
  it('returns the default when no custom prompt given', () => {
    expect(getSystemPrompt()).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('returns the default when custom prompt is empty', () => {
    expect(getSystemPrompt('')).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('returns the default when custom prompt is whitespace', () => {
    expect(getSystemPrompt('   ')).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  it('returns the custom prompt when provided', () => {
    const custom = 'Write a haiku about this diff.';
    expect(getSystemPrompt(custom)).toBe(custom);
  });
});

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
    expect(parseCommitMessage('feat: add foo\n```\ndetails\n```')).toBe('feat: add foo\n```\ndetails\n```');
  });
});
