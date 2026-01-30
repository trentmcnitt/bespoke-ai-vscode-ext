import { describe, it, expect } from 'vitest';
import { extractAnchor } from '../../providers/claude-code';

describe('extractAnchor', () => {
  it('returns empty anchor for empty prefix', () => {
    const result = extractAnchor('');
    expect(result.anchor).toBe('');
    expect(result.prefixBeforeAnchor).toBe('');
  });

  it('returns empty anchor when current line is empty (prefix ends with newline)', () => {
    const result = extractAnchor('Some text\n');
    expect(result.anchor).toBe('');
    expect(result.prefixBeforeAnchor).toBe('Some text\n');
  });

  it('returns empty anchor when current line is whitespace-only', () => {
    const result = extractAnchor('Some text\n   ');
    expect(result.anchor).toBe('');
    expect(result.prefixBeforeAnchor).toBe('Some text\n   ');
  });

  it('uses full current line as anchor when short', () => {
    const result = extractAnchor('First line\n- bullet item');
    expect(result.anchor).toBe('- bullet item');
    expect(result.prefixBeforeAnchor).toBe('First line\n');
  });

  it('uses entire prefix as anchor when no newline and under limit', () => {
    const result = extractAnchor('Hello world');
    expect(result.anchor).toBe('Hello world');
    expect(result.prefixBeforeAnchor).toBe('');
  });

  it('splits at sentence break for long lines', () => {
    // Build a line longer than 120 chars with a sentence break
    const beforeSentence = 'A'.repeat(40) + '. ';
    const afterSentence = 'B'.repeat(80);
    const longLine = beforeSentence + afterSentence;
    expect(longLine.length).toBeGreaterThan(120);

    const result = extractAnchor('Previous line\n' + longLine);
    expect(result.anchor).toBe(afterSentence);
  });

  it('uses latest sentence break when multiple exist', () => {
    // Build a line with two sentence breaks, both within the last 120 chars
    // "AAAA. BBBB. CCCC" — should split at the LAST ". " for the shortest anchor
    const longLine = 'X'.repeat(30) + '. ' + 'Y'.repeat(40) + '. ' + 'Z'.repeat(50);
    expect(longLine.length).toBeGreaterThan(120);

    const result = extractAnchor(longLine);
    expect(result.anchor).toBe('Z'.repeat(50));
  });

  it('splits at word boundary when no sentence break', () => {
    // Build a line longer than 120 chars with no sentence breaks
    const words = [];
    let len = 0;
    let i = 0;
    while (len < 130) {
      const word = `word${i++}`;
      words.push(word);
      len += word.length + 1;
    }
    const longLine = words.join(' ');
    expect(longLine.length).toBeGreaterThan(120);

    const result = extractAnchor(longLine);
    // Should not start with a partial word fragment followed by space
    // (word boundary trimming removes the leading partial)
    expect(result.anchor.length).toBeLessThanOrEqual(120);
    // The anchor + prefixBeforeAnchor should reconstruct the original
    expect(result.prefixBeforeAnchor + result.anchor).toBe(longLine);
    // Should start at a word boundary — first char should not be a space
    expect(result.anchor[0]).not.toBe(' ');
  });

  it('uses full slice as fallback when no spaces or sentence breaks', () => {
    const longLine = 'a'.repeat(150);
    const result = extractAnchor(longLine);
    expect(result.anchor).toBe('a'.repeat(120));
    expect(result.prefixBeforeAnchor).toBe('a'.repeat(30));
  });

  it('respects custom maxLength', () => {
    const result = extractAnchor('Hello world, this is a test line', 10);
    // Current line is "Hello world, this is a test line" (31 chars > 10)
    // Last 10 chars: "a test line" — wait, 10 chars = " test line"
    // Should find word boundary
    expect(result.anchor.length).toBeLessThanOrEqual(10);
    expect(result.prefixBeforeAnchor + result.anchor).toBe('Hello world, this is a test line');
  });

  it('handles prefix that is exactly the anchor (short single-line doc)', () => {
    const result = extractAnchor('Short text');
    expect(result.anchor).toBe('Short text');
    expect(result.prefixBeforeAnchor).toBe('');
  });

  it('handles multiline prefix with short current line', () => {
    const prefix = 'Line one\nLine two\nLine three\n## Heading';
    const result = extractAnchor(prefix);
    expect(result.anchor).toBe('## Heading');
    expect(result.prefixBeforeAnchor).toBe('Line one\nLine two\nLine three\n');
  });
});
