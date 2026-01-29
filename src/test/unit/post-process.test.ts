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
  it('passes through clean text unchanged', () => {
    const result = postProcessCompletion('Hello world.', makePrompt());
    expect(result).toBe('Hello world.');
  });

  it('strips markdown code fences', () => {
    const result = postProcessCompletion('```ts\nconst x = 1;\n```', makePrompt());
    expect(result).toBe('const x = 1;');
  });

  it('strips leading newlines', () => {
    const result = postProcessCompletion('\n\n\nSome text', makePrompt({ stopSequences: [] }));
    expect(result).toBe('Some text');
  });

  it('enforces \\n\\n stop boundary when in stopSequences', () => {
    const result = postProcessCompletion('First paragraph.\n\nSecond paragraph.', makePrompt());
    expect(result).toBe('First paragraph.');
  });

  it('does not enforce \\n\\n stop when not in stopSequences', () => {
    const result = postProcessCompletion(
      'First paragraph.\n\nSecond paragraph.',
      makePrompt({ stopSequences: ['---'] })
    );
    expect(result).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('returns null when result is empty after processing', () => {
    const result = postProcessCompletion('\n\n', makePrompt());
    expect(result).toBeNull();
  });

  it('strips fences and leading newlines in correct order', () => {
    const result = postProcessCompletion('```js\n\n\nconsole.log("hi");\n```', makePrompt({ stopSequences: [] }));
    expect(result).toBe('console.log("hi");');
  });

  it('does not enforce non-\\n\\n stop sequences like ---', () => {
    const result = postProcessCompletion(
      'Some text\n---\nMore text',
      makePrompt({ stopSequences: ['---'] })
    );
    expect(result).toBe('Some text\n---\nMore text');
  });

  it('returns null when code fence has no inner content', () => {
    const result = postProcessCompletion('```\n```', makePrompt());
    expect(result).toBeNull();
  });

  it('strips leading space when prefix ends with space and prefill does not', () => {
    const result = postProcessCompletion(
      ' the quick brown fox',
      makePrompt({ assistantPrefill: 'You can use' }),
      'You can use '
    );
    expect(result).toBe('the quick brown fox');
  });

  it('does not strip leading space when prefix does not end with space', () => {
    const result = postProcessCompletion(
      ' the quick brown fox',
      makePrompt({ assistantPrefill: 'You can use' }),
      'You can use'
    );
    expect(result).toBe(' the quick brown fox');
  });

  it('does not strip leading space when there is no prefill', () => {
    const result = postProcessCompletion(
      ' some text',
      makePrompt(),
      'Hello '
    );
    expect(result).toBe(' some text');
  });
});
