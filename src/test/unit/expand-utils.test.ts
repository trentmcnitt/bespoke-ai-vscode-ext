import { describe, it, expect } from 'vitest';
import { parseSuggestions, buildExpandPrompt, ExpandPromptOptions } from '../../utils/expand-utils';

describe('parseSuggestions', () => {
  it('parses 3 suggestions', () => {
    const response = `<suggestion id="1">first</suggestion>
<suggestion id="2">second</suggestion>
<suggestion id="3">third</suggestion>`;
    const result = parseSuggestions(response);
    expect(result).toEqual(['first', 'second', 'third']);
  });

  it('parses 1 suggestion', () => {
    const response = '<suggestion id="1">only one</suggestion>';
    expect(parseSuggestions(response)).toEqual(['only one']);
  });

  it('returns empty array when no suggestions found', () => {
    expect(parseSuggestions('no tags here')).toEqual([]);
    expect(parseSuggestions('')).toEqual([]);
  });

  it('ignores preamble text before suggestion tags', () => {
    const response = `Here are some suggestions:

<suggestion id="1">the actual content</suggestion>`;
    expect(parseSuggestions(response)).toEqual(['the actual content']);
  });

  it('handles multiline content', () => {
    const response = `<suggestion id="1">
line one
line two
line three
</suggestion>`;
    // Leading and trailing newlines from tag formatting are trimmed
    expect(parseSuggestions(response)).toEqual(['line one\nline two\nline three']);
  });

  it('preserves internal whitespace', () => {
    const response = '<suggestion id="1">  indented  content  </suggestion>';
    expect(parseSuggestions(response)).toEqual(['  indented  content  ']);
  });

  it('handles XML-like content inside suggestions', () => {
    const response = '<suggestion id="1">const x = arr.filter(x => x > 0);</suggestion>';
    expect(parseSuggestions(response)).toEqual(['const x = arr.filter(x => x > 0);']);
  });

  it('trims only a single leading and trailing newline', () => {
    const response = `<suggestion id="1">
content

with blank line
</suggestion>`;
    expect(parseSuggestions(response)).toEqual(['content\n\nwith blank line']);
  });

  it('handles suggestions with varying ids', () => {
    const response = `<suggestion id="1">a</suggestion>
<suggestion id="2">b</suggestion>`;
    expect(parseSuggestions(response)).toEqual(['a', 'b']);
  });
});

describe('buildExpandPrompt', () => {
  const baseOptions: ExpandPromptOptions = {
    mode: 'continue',
    beforeText: 'before text',
    afterText: 'after text',
    languageId: 'markdown',
    fileName: 'test.md',
  };

  it('builds continue mode prompt with correct tags', () => {
    const prompt = buildExpandPrompt(baseOptions);
    expect(prompt).toContain('<instructions>');
    expect(prompt).toContain('</instructions>');
    expect(prompt).toContain('<file language="markdown" name="test.md">');
    expect(prompt).toContain('<before_cursor>');
    expect(prompt).toContain('before text');
    expect(prompt).toContain('<after_cursor>');
    expect(prompt).toContain('after text');
    expect(prompt).toContain('continue from the cursor');
    expect(prompt).not.toContain('<selected>');
    expect(prompt).not.toContain('<before_selection>');
  });

  it('builds expand mode prompt with selection tags', () => {
    const prompt = buildExpandPrompt({
      ...baseOptions,
      mode: 'expand',
      selectedText: 'selected content',
    });
    expect(prompt).toContain('<before_selection>');
    expect(prompt).toContain('<selected>');
    expect(prompt).toContain('selected content');
    expect(prompt).toContain('<after_selection>');
    expect(prompt).toContain('replace the selected text');
    expect(prompt).not.toContain('<before_cursor>');
    expect(prompt).not.toContain('<after_cursor>');
  });

  it('includes guidance when provided', () => {
    const prompt = buildExpandPrompt({
      ...baseOptions,
      guidance: 'add error handling',
    });
    expect(prompt).toContain('<guidance>add error handling</guidance>');
  });

  it('omits guidance tag when not provided', () => {
    const prompt = buildExpandPrompt(baseOptions);
    expect(prompt).not.toContain('<guidance>');
  });

  it('includes file metadata', () => {
    const prompt = buildExpandPrompt({
      ...baseOptions,
      languageId: 'typescript',
      fileName: 'app.ts',
    });
    expect(prompt).toContain('<file language="typescript" name="app.ts">');
  });
});
