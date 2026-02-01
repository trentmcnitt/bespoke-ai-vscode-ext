import { buildDocumentContext } from '../../utils/context-builder';

/** Minimal mock of vscode.TextDocument for unit testing. */
function makeDocument(text: string, languageId = 'markdown', fileName = '/home/user/docs/story.md') {
  return {
    getText: () => text,
    offsetAt: (pos: { line: number; character: number }) => {
      const lines = text.split('\n');
      let offset = 0;
      for (let i = 0; i < pos.line && i < lines.length; i++) {
        offset += lines[i].length + 1; // +1 for newline
      }
      return offset + pos.character;
    },
    languageId,
    fileName,
  };
}

/** Shorthand to build a position object. */
function pos(line: number, character: number) {
  return { line, character };
}

describe('buildDocumentContext', () => {
  it('extracts prefix and suffix at a mid-document position', () => {
    const doc = makeDocument('Hello world, this is a test document.');
    // Cursor after "Hello " (offset 6)
    const ctx = buildDocumentContext(doc as any, pos(0, 6), 2000, 500);
    expect(ctx.prefix).toBe('Hello ');
    expect(ctx.suffix).toBe('world, this is a test document.');
  });

  it('truncates prefix when cursor offset exceeds prefixChars', () => {
    const text = 'A'.repeat(100);
    const doc = makeDocument(text);
    const ctx = buildDocumentContext(doc as any, pos(0, 100), 30, 500);
    expect(ctx.prefix).toBe('A'.repeat(30));
    expect(ctx.prefix.length).toBe(30);
  });

  it('truncates suffix when remaining text exceeds suffixChars', () => {
    const text = 'X' + 'B'.repeat(200);
    const doc = makeDocument(text);
    const ctx = buildDocumentContext(doc as any, pos(0, 1), 2000, 50);
    expect(ctx.suffix).toBe('B'.repeat(50));
    expect(ctx.suffix.length).toBe(50);
  });

  it('returns empty prefix when cursor is at the start', () => {
    const doc = makeDocument('Some text here.');
    const ctx = buildDocumentContext(doc as any, pos(0, 0), 2000, 500);
    expect(ctx.prefix).toBe('');
    expect(ctx.suffix).toBe('Some text here.');
  });

  it('returns empty suffix when cursor is at the end', () => {
    const doc = makeDocument('All the text.');
    const ctx = buildDocumentContext(doc as any, pos(0, 13), 2000, 500);
    expect(ctx.prefix).toBe('All the text.');
    expect(ctx.suffix).toBe('');
  });

  it('does not truncate when document is smaller than both limits', () => {
    const text = 'Short doc.';
    const doc = makeDocument(text);
    const ctx = buildDocumentContext(doc as any, pos(0, 5), 2000, 500);
    expect(ctx.prefix).toBe('Short');
    expect(ctx.suffix).toBe(' doc.');
  });

  it('returns full prefix when cursor is exactly at prefixChars from start', () => {
    const text = 'A'.repeat(50) + 'B'.repeat(50);
    const doc = makeDocument(text);
    const ctx = buildDocumentContext(doc as any, pos(0, 50), 50, 500);
    expect(ctx.prefix).toBe('A'.repeat(50));
    expect(ctx.prefix.length).toBe(50);
  });

  it('extracts filename via path.basename', () => {
    const doc = makeDocument('text', 'typescript', '/home/user/project/src/utils/helper.ts');
    const ctx = buildDocumentContext(doc as any, pos(0, 2), 2000, 500);
    expect(ctx.fileName).toBe('helper.ts');
  });

  it('returns empty prefix and suffix for an empty document', () => {
    const doc = makeDocument('');
    const ctx = buildDocumentContext(doc as any, pos(0, 0), 2000, 500);
    expect(ctx.prefix).toBe('');
    expect(ctx.suffix).toBe('');
  });

  it('handles multi-line documents with cursor on a non-zero line', () => {
    const text = 'line one\nline two\nline three';
    const doc = makeDocument(text, 'plaintext', 'notes.txt');
    // Cursor at start of "line three" → line 2, character 0
    const ctx = buildDocumentContext(doc as any, pos(2, 0), 2000, 500);
    expect(ctx.prefix).toBe('line one\nline two\n');
    expect(ctx.suffix).toBe('line three');
  });

  it('passes through languageId from the document', () => {
    const doc = makeDocument('code', 'python', 'script.py');
    const ctx = buildDocumentContext(doc as any, pos(0, 2), 2000, 500);
    expect(ctx.languageId).toBe('python');
  });

  it('snaps prefix start to line boundary when truncation cuts mid-line', () => {
    // "line one\nline two\nline three" (offsets: 0-8, 9-16, 18-27)
    // Cursor at end of "line three" (offset 28)
    // prefixChars=15 → raw start at 13 → mid "line two"
    // Snaps forward to offset 18 (start of "line three"), dropping partial line
    const text = 'line one\nline two\nline three';
    const doc = makeDocument(text);
    const ctx = buildDocumentContext(doc as any, pos(2, 10), 15, 500);
    expect(ctx.prefix).toBe('line three');
  });

  it('keeps full prefix when truncation lands on a line boundary', () => {
    // "aaa\nbbb\nccc" (offsets: 0-2, 4-6, 8-10)
    // Cursor at end (offset 11), prefixChars=7 → raw start at 4
    // Offset 4 is preceded by \n (offset 3), so it IS a line boundary → no snap
    const text = 'aaa\nbbb\nccc';
    const doc = makeDocument(text);
    const ctx = buildDocumentContext(doc as any, pos(2, 3), 7, 500);
    expect(ctx.prefix).toBe('bbb\nccc');
  });

  it('snaps suffix end to word boundary when truncation cuts mid-word', () => {
    // "Hello world testing here" — cursor at start, suffixChars=14
    // Raw cut: "Hello world te" (mid-word "testing")
    // Next char after cut is 's' (non-whitespace) → snap back to last whitespace
    // Result: "Hello world " (12 chars, ends with space)
    const text = 'Hello world testing here';
    const doc = makeDocument(text);
    const ctx = buildDocumentContext(doc as any, pos(0, 0), 100, 14);
    expect(ctx.suffix).toBe('Hello world ');
  });

  it('keeps full suffix when truncation lands on a word boundary', () => {
    // "Hello world testing here" — cursor at start, suffixChars=12
    // Raw cut: "Hello world " (ends with space)
    // Next char after cut is 't' but we ended on whitespace, so no mid-word cut
    // Actually, we need to check if next char is whitespace — it's 't', so mid-word
    // Let's use suffixChars=11 to end on 'd', next char is ' ' (whitespace) → no snap
    const text = 'Hello world testing here';
    const doc = makeDocument(text);
    const ctx = buildDocumentContext(doc as any, pos(0, 0), 100, 11);
    expect(ctx.suffix).toBe('Hello world');
  });

  it('does not snap suffix when truncation reaches end of document', () => {
    // Short document, suffixChars larger than content → no truncation
    // Should return full suffix even if it ends mid-word conceptually
    const text = 'Short';
    const doc = makeDocument(text);
    const ctx = buildDocumentContext(doc as any, pos(0, 0), 100, 100);
    expect(ctx.suffix).toBe('Short');
  });

  it('snaps suffix correctly with newlines as word boundaries', () => {
    // "line one\nline two\npartial" — suffixChars=20
    // Raw cut: "line one\nline two\np" (mid-word "partial")
    // Next char is 'a' (non-whitespace) → snap back to newline after "two"
    const text = 'line one\nline two\npartial word here';
    const doc = makeDocument(text);
    const ctx = buildDocumentContext(doc as any, pos(0, 0), 100, 20);
    expect(ctx.suffix).toBe('line one\nline two\n');
  });
});
