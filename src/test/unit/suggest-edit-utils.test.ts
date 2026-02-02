import { describe, it, expect } from 'vitest';
import {
  parseEditResponse,
  buildEditPrompt,
  buildFullEditPrompt,
  SYSTEM_PROMPT,
} from '../../utils/suggest-edit-utils';

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
    expect(result).toBe(
      '<file_content language="markdown" name="readme.md">\nhello world\n</file_content>',
    );
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

describe('buildFullEditPrompt', () => {
  it('includes instructions tag with system prompt', () => {
    const result = buildFullEditPrompt('hello world', 'markdown', 'readme.md');
    expect(result).toContain('<instructions>');
    expect(result).toContain('</instructions>');
    expect(result).toContain(SYSTEM_PROMPT);
  });

  it('includes file metadata from buildEditPrompt', () => {
    const result = buildFullEditPrompt('hello world', 'typescript', 'index.ts');
    expect(result).toContain('<file_content');
    expect(result).toContain('language="typescript"');
    expect(result).toContain('name="index.ts"');
  });

  it('includes the text content', () => {
    const text = 'const x = 1;';
    const result = buildFullEditPrompt(text, 'typescript', 'index.ts');
    expect(result).toContain(text);
  });

  it('preserves whitespace in content', () => {
    const text = '  indented\n\n  lines\n';
    const result = buildFullEditPrompt(text, 'plaintext', 'test.txt');
    expect(result).toContain(text);
  });
});
