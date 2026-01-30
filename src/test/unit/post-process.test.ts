import { postProcessCompletion } from '../../utils/post-process';
import { BuiltPrompt } from '../../types';

function makePrompt(overrides: Partial<BuiltPrompt> = {}): BuiltPrompt {
  return {
    system: '',
    userMessage: '',
    maxTokens: 100,
    temperature: 0.7,
    stopSequences: ['\n\n'],
    ...overrides,
  };
}

describe('postProcessCompletion', () => {
  it('passes through text unchanged', () => {
    const result = postProcessCompletion('Hello world.', makePrompt());
    expect(result).toBe('Hello world.');
  });

  it('passes through text with markdown fences unchanged', () => {
    const result = postProcessCompletion('```ts\nconst x = 1;\n```', makePrompt());
    expect(result).toBe('```ts\nconst x = 1;\n```');
  });

  it('passes through text with leading newlines unchanged', () => {
    const result = postProcessCompletion('\n\nSome text', makePrompt());
    expect(result).toBe('\n\nSome text');
  });

  it('passes through text with double newlines unchanged', () => {
    const result = postProcessCompletion('First paragraph.\n\nSecond paragraph.', makePrompt());
    expect(result).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('returns null when result is empty', () => {
    const result = postProcessCompletion('', makePrompt());
    expect(result).toBeNull();
  });

  it('returns null when result is whitespace-only', () => {
    const result = postProcessCompletion('   \n\n  ', makePrompt());
    expect(result).toBeNull();
  });
});

describe('trimPrefixOverlap', () => {
  it('strips bullet prefix echoed by model', () => {
    const result = postProcessCompletion('- **Chat**', makePrompt(), 'Some text\n- ');
    expect(result).toBe('**Chat**');
  });

  it('strips heading prefix echoed by model', () => {
    const result = postProcessCompletion('## Title here', makePrompt(), 'Some text\n## ');
    expect(result).toBe('Title here');
  });

  it('strips code prefix echoed by model', () => {
    const result = postProcessCompletion('  const x = 5;', makePrompt(), 'function foo() {\n  const x');
    expect(result).toBe(' = 5;');
  });

  it('does not trim when completion does not start with fragment', () => {
    const result = postProcessCompletion('world', makePrompt(), 'Some text\nHello ');
    expect(result).toBe('world');
  });

  it('does not trim when fragment is empty (prefix ends with newline)', () => {
    const result = postProcessCompletion('- item', makePrompt(), 'Some text\n');
    expect(result).toBe('- item');
  });

  it('does not trim when fragment is whitespace-only', () => {
    const result = postProcessCompletion('   code()', makePrompt(), 'Some text\n   ');
    expect(result).toBe('   code()');
  });

  it('does not trim when prefix is undefined', () => {
    const result = postProcessCompletion('- item', makePrompt());
    expect(result).toBe('- item');
  });

  it('does not trim when fragment exceeds 100 chars', () => {
    const longFragment = 'a'.repeat(101);
    const result = postProcessCompletion(longFragment + ' more', makePrompt(), longFragment);
    expect(result).toBe(longFragment + ' more');
  });

  it('handles prefix with no newline (entire prefix is the fragment)', () => {
    const result = postProcessCompletion('- item text', makePrompt(), '- ');
    expect(result).toBe('item text');
  });

  it('returns null when completion equals the line fragment exactly', () => {
    const result = postProcessCompletion('- ', makePrompt(), 'Some text\n- ');
    expect(result).toBeNull();
  });

  it('trims prefix and suffix overlap together', () => {
    const result = postProcessCompletion(
      '- **Bold** and continues into suffix text',
      makePrompt(),
      'Some text\n- ',
      ' suffix text that follows'
    );
    expect(result).toBe('**Bold** and continues into');
  });
});
