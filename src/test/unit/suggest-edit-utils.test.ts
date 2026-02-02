import { describe, it, expect } from 'vitest';
import { parseEditResponse, buildEditPrompt } from '../../utils/suggest-edit-utils';

describe('parseEditResponse', () => {
  it('extracts text from <corrected> tags', () => {
    const input = 'Here is the corrected text:\n<corrected>Hello world</corrected>';
    expect(parseEditResponse(input)).toBe('Hello world');
  });

  it('returns null when no tags or fences are present', () => {
    expect(parseEditResponse('Just some plain text')).toBeNull();
  });

  it('handles markdown fence fallback', () => {
    const input = '```\nfixed content here\n```';
    expect(parseEditResponse(input)).toBe('fixed content here');
  });

  it('handles markdown fence with language tag', () => {
    const input = '```typescript\nconst x = 1;\n```';
    expect(parseEditResponse(input)).toBe('const x = 1;');
  });

  it('preserves internal whitespace and newlines', () => {
    const content = '  line one\n\n  line two\n    indented';
    const input = `<corrected>${content}</corrected>`;
    expect(parseEditResponse(input)).toBe(content);
  });

  it('prefers <corrected> tags over markdown fences', () => {
    const input = '```\nfenced\n```\n<corrected>tagged</corrected>';
    expect(parseEditResponse(input)).toBe('tagged');
  });

  it('returns null for empty string', () => {
    expect(parseEditResponse('')).toBeNull();
  });
});

describe('buildEditPrompt', () => {
  it('includes file metadata in XML structure', () => {
    const result = buildEditPrompt('hello world', 'markdown', 'readme.md');
    expect(result).toBe('<file language="markdown" name="readme.md">\nhello world\n</file>');
  });

  it('includes language and file name attributes', () => {
    const result = buildEditPrompt('const x = 1;', 'typescript', 'index.ts');
    expect(result).toContain('language="typescript"');
    expect(result).toContain('name="index.ts"');
  });

  it('preserves text content exactly', () => {
    const text = '  indented\n\n  lines\n';
    const result = buildEditPrompt(text, 'plaintext', 'test.txt');
    expect(result).toContain(text);
  });
});
