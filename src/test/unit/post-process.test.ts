import { postProcessCompletion } from '../../utils/post-process';

describe('postProcessCompletion', () => {
  it('passes through text unchanged', () => {
    const result = postProcessCompletion('Hello world.');
    expect(result).toBe('Hello world.');
  });

  it('passes through text with markdown fences unchanged', () => {
    const result = postProcessCompletion('```ts\nconst x = 1;\n```');
    expect(result).toBe('```ts\nconst x = 1;\n```');
  });

  it('passes through text with leading newlines unchanged', () => {
    const result = postProcessCompletion('\n\nSome text');
    expect(result).toBe('\n\nSome text');
  });

  it('passes through text with double newlines unchanged', () => {
    const result = postProcessCompletion('First paragraph.\n\nSecond paragraph.');
    expect(result).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('returns null when result is empty', () => {
    const result = postProcessCompletion('');
    expect(result).toBeNull();
  });

  it('returns null when result is whitespace-only', () => {
    const result = postProcessCompletion('   \n\n  ');
    expect(result).toBeNull();
  });
});

describe('trimPrefixOverlap', () => {
  it('strips bullet prefix echoed by model', () => {
    const result = postProcessCompletion('- **Chat**', 'Some text\n- ');
    expect(result).toBe('**Chat**');
  });

  it('strips heading prefix echoed by model', () => {
    const result = postProcessCompletion('## Title here', 'Some text\n## ');
    expect(result).toBe('Title here');
  });

  it('strips code prefix echoed by model', () => {
    const result = postProcessCompletion('  const x = 5;', 'function foo() {\n  const x');
    expect(result).toBe(' = 5;');
  });

  it('does not trim when completion does not start with fragment', () => {
    const result = postProcessCompletion('world', 'Some text\nHello ');
    expect(result).toBe('world');
  });

  it('does not trim when fragment is empty (prefix ends with newline)', () => {
    const result = postProcessCompletion('- item', 'Some text\n');
    expect(result).toBe('- item');
  });

  it('does not trim when fragment is whitespace-only', () => {
    const result = postProcessCompletion('   code()', 'Some text\n   ');
    expect(result).toBe('   code()');
  });

  it('does not trim when prefix is undefined', () => {
    const result = postProcessCompletion('- item');
    expect(result).toBe('- item');
  });

  it('does not trim when fragment exceeds 150 chars', () => {
    const longFragment = 'a'.repeat(151);
    const result = postProcessCompletion(longFragment + ' more', longFragment);
    expect(result).toBe(longFragment + ' more');
  });

  it('handles prefix with no newline (entire prefix is the fragment)', () => {
    const result = postProcessCompletion('- item text', '- ');
    expect(result).toBe('item text');
  });

  it('returns null when completion equals the line fragment exactly', () => {
    const result = postProcessCompletion('- ', 'Some text\n- ');
    expect(result).toBeNull();
  });

  it('trims prefix and suffix overlap together', () => {
    const result = postProcessCompletion(
      '- **Bold** and continues into suffix text',
      'Some text\n- ',
      ' suffix text that follows',
    );
    expect(result).toBe('**Bold** and continues into');
  });
});

describe('stripLeakedTags', () => {
  it('strips <COMPLETION> opening tag', () => {
    const result = postProcessCompletion('hello <COMPLETION>world');
    expect(result).toBe('hello world');
  });

  it('strips </COMPLETION> closing tag', () => {
    const result = postProcessCompletion('hello</COMPLETION> world');
    expect(result).toBe('hello world');
  });

  it('strips both opening and closing tags', () => {
    const result = postProcessCompletion('<COMPLETION>hello world</COMPLETION>');
    expect(result).toBe('hello world');
  });

  it('strips {{FILL_HERE}} marker', () => {
    const result = postProcessCompletion('hello {{FILL_HERE}} world');
    expect(result).toBe('hello  world');
  });

  it('strips multiple leaked tags in one string', () => {
    const result = postProcessCompletion('<COMPLETION>text</COMPLETION> more {{FILL_HERE}} end');
    expect(result).toBe('text more  end');
  });

  it('leaves clean text unchanged', () => {
    const result = postProcessCompletion('perfectly normal text');
    expect(result).toBe('perfectly normal text');
  });

  it('returns null when stripping leaves only whitespace', () => {
    const result = postProcessCompletion('<COMPLETION></COMPLETION>');
    expect(result).toBeNull();
  });

  it('returns null when stripping FILL_HERE leaves only whitespace', () => {
    const result = postProcessCompletion('  {{FILL_HERE}}  ');
    expect(result).toBeNull();
  });
});

describe('trimSuffixOverlap', () => {
  it('does not trim overlap below 10-character minimum threshold', () => {
    // "the end" is only 7 chars - should NOT be trimmed
    const result = postProcessCompletion('This is the end', undefined, 'the end of the document');
    expect(result).toBe('This is the end');
  });

  it('trims overlap at exactly 10-character threshold', () => {
    // "1234567890" is exactly 10 chars - should be trimmed
    const result = postProcessCompletion('Prefix 1234567890', undefined, '1234567890 continues');
    expect(result).toBe('Prefix');
  });

  it('trims overlap above 10-character threshold', () => {
    // "this is overlap" is 15 chars - should be trimmed
    const result = postProcessCompletion(
      'Completion this is overlap',
      undefined,
      'this is overlap text',
    );
    expect(result).toBe('Completion');
  });

  it('normalizes whitespace when comparing overlap', () => {
    // Multiple spaces in completion should match single space in suffix
    const result = postProcessCompletion(
      'Start   of   sentence  here',
      undefined,
      'of sentence here and more',
    );
    // "of sentence here" = 16 chars normalized, should trim
    expect(result).toBe('Start');
  });

  it('normalizes newlines to spaces when comparing', () => {
    const result = postProcessCompletion(
      'Beginning\nof\nthe\ntext',
      undefined,
      'of the text continues',
    );
    // "of the text" = 11 chars normalized, should trim
    expect(result).toBe('Beginning');
  });

  it('handles whitespace-only suffix gracefully', () => {
    const result = postProcessCompletion('Some completion', undefined, '   \n\n  ');
    expect(result).toBe('Some completion');
  });

  it('handles empty suffix gracefully', () => {
    const result = postProcessCompletion('Some completion', undefined, '');
    expect(result).toBe('Some completion');
  });

  it('handles completion shorter than minOverlap', () => {
    const result = postProcessCompletion('short', undefined, 'short suffix');
    // "short" is only 5 chars, below 10-char threshold
    expect(result).toBe('short');
  });

  it('finds longest matching overlap', () => {
    // Both "overlap here" (12 chars) and "here" (4 chars) match, should use longest
    const result = postProcessCompletion(
      'Text with overlap here',
      undefined,
      'overlap here in the suffix',
    );
    expect(result).toBe('Text with');
  });

  it('preserves leading whitespace after trim', () => {
    const result = postProcessCompletion(
      '  indented continuation text',
      undefined,
      'continuation text follows',
    );
    // "continuation text" = 17 chars, should trim, preserve "  indented "
    expect(result).toBe('  indented');
  });
});
