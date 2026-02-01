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
