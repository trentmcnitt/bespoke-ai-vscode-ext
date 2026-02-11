import { truncatePrefix, truncateSuffix } from '../../utils/truncation';

describe('truncatePrefix', () => {
  it('returns text unchanged when shorter than limit', () => {
    expect(truncatePrefix('hello world', 100)).toBe('hello world');
  });

  it('returns text unchanged when exactly at limit', () => {
    const text = 'A'.repeat(50);
    expect(truncatePrefix(text, 50)).toBe(text);
  });

  it('truncates from the beginning when text exceeds limit', () => {
    const text = 'aaa\nbbb\nccc';
    // maxChars=7 → take last 7 chars → start at 4 → "bbb\nccc"
    // offset 4 is preceded by \n (offset 3) → IS a line boundary → no snap
    expect(truncatePrefix(text, 7)).toBe('bbb\nccc');
  });

  it('snaps forward to next newline when cut lands mid-line', () => {
    const text = 'line one\nline two\nline three';
    // maxChars=15 → start at 12 → mid "line two"
    // Snaps forward to offset 18 (start of "line three")
    expect(truncatePrefix(text, 15)).toBe('line three');
  });

  it('keeps from cut point when no newline found after it', () => {
    // Single long line with no newlines
    const text = 'A'.repeat(100);
    const result = truncatePrefix(text, 30);
    expect(result.length).toBe(30);
    expect(result).toBe('A'.repeat(30));
  });

  it('returns empty string for empty input', () => {
    expect(truncatePrefix('', 100)).toBe('');
  });

  it('returns empty string for empty input with zero limit', () => {
    expect(truncatePrefix('', 0)).toBe('');
  });

  it('snaps correctly when cut is one char into a line', () => {
    const text = 'aaa\nbbbb\ncccc';
    // maxChars=10 → start at 3 → that's the \n character
    // text[2] = 'a' (not \n), so snap forward
    // nextNewline from 3 = 3 itself... wait, text[3] = '\n'? No.
    // text = 'aaa\nbbbb\ncccc' (0:'a',1:'a',2:'a',3:'\n',4:'b',...,8:'\n',9:'c'...)
    // start = 13-10 = 3 → text[3-1]=text[2]='a' (not \n) → snap forward
    // indexOf('\n', 3) = 3 → text[3] = '\n' → start = 4
    expect(truncatePrefix(text, 10)).toBe('bbbb\ncccc');
  });
});

describe('truncateSuffix', () => {
  it('returns text unchanged when shorter than limit', () => {
    expect(truncateSuffix('hello world', 100)).toBe('hello world');
  });

  it('returns text unchanged when exactly at limit', () => {
    const text = 'A'.repeat(50);
    expect(truncateSuffix(text, 50)).toBe(text);
  });

  it('truncates at word boundary when cut lands mid-word', () => {
    const text = 'Hello world testing here';
    // maxChars=14 → "Hello world te" → next char 's' (non-whitespace) → snap back
    expect(truncateSuffix(text, 14)).toBe('Hello world ');
  });

  it('keeps full slice when cut lands on word boundary', () => {
    const text = 'Hello world testing here';
    // maxChars=11 → "Hello world" → next char ' ' (whitespace) → no snap
    expect(truncateSuffix(text, 11)).toBe('Hello world');
  });

  it('snaps to newline as word boundary', () => {
    const text = 'line one\nline two\npartial word here';
    // maxChars=20 → "line one\nline two\np" → next char 'a' → snap back to \n
    expect(truncateSuffix(text, 20)).toBe('line one\nline two\n');
  });

  it('returns empty string for empty input', () => {
    expect(truncateSuffix('', 100)).toBe('');
  });

  it('keeps truncated text when no whitespace exists to snap to', () => {
    const text = 'abcdefghijklmnop';
    // maxChars=8 → "abcdefgh" → next char 'i' (non-whitespace) → no whitespace to snap to
    expect(truncateSuffix(text, 8)).toBe('abcdefgh');
  });
});
