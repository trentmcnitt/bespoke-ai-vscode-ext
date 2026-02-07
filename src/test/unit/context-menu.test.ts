import { describe, it, expect } from 'vitest';
import { escapeForDoubleQuotes, PROMPT_TEMPLATES } from '../../commands/context-menu-utils';

describe('escapeForDoubleQuotes', () => {
  it('escapes backslashes', () => {
    expect(escapeForDoubleQuotes('path\\to\\file')).toBe('path\\\\to\\\\file');
  });

  it('escapes double quotes', () => {
    expect(escapeForDoubleQuotes('say "hello"')).toBe('say \\"hello\\"');
  });

  it('escapes dollar signs', () => {
    expect(escapeForDoubleQuotes('cost is $5')).toBe('cost is \\$5');
  });

  it('escapes backticks', () => {
    expect(escapeForDoubleQuotes('run `cmd`')).toBe('run \\`cmd\\`');
  });

  it('returns empty string unchanged', () => {
    expect(escapeForDoubleQuotes('')).toBe('');
  });

  it('leaves safe characters unchanged', () => {
    expect(escapeForDoubleQuotes("hello world! it's fine")).toBe("hello world! it's fine");
  });

  it('escapes all special characters combined', () => {
    expect(escapeForDoubleQuotes('a\\b"c$d`e')).toBe('a\\\\b\\"c\\$d\\`e');
  });
});

describe('PROMPT_TEMPLATES', () => {
  const filePath = '/src/app.ts';
  const startLine = 10;
  const endLine = 20;

  describe('explain', () => {
    it('generates base prompt without commentary', () => {
      const result = PROMPT_TEMPLATES.explain(filePath, startLine, endLine);
      expect(result).toContain('Explain lines 10-20');
      expect(result).toContain(filePath);
      expect(result).not.toContain('Note:');
    });

    it('appends commentary when provided', () => {
      const result = PROMPT_TEMPLATES.explain(filePath, startLine, endLine, 'focus on errors');
      expect(result).toContain('Explain lines 10-20');
      expect(result).toContain('Note: focus on errors');
    });
  });

  describe('fix', () => {
    it('generates base prompt without commentary', () => {
      const result = PROMPT_TEMPLATES.fix(filePath, startLine, endLine);
      expect(result).toContain('Fix any issues in lines 10-20');
      expect(result).not.toContain('Note:');
    });

    it('appends commentary when provided', () => {
      const result = PROMPT_TEMPLATES.fix(filePath, startLine, endLine, 'return type is wrong');
      expect(result).toContain('Note: return type is wrong');
    });
  });

  describe('alternatives', () => {
    it('generates base prompt without commentary', () => {
      const result = PROMPT_TEMPLATES.alternatives(filePath, startLine, endLine);
      expect(result).toContain('3 alternative ways');
      expect(result).not.toContain('Note:');
    });

    it('appends commentary when provided', () => {
      const result = PROMPT_TEMPLATES.alternatives(
        filePath,
        startLine,
        endLine,
        'prefer functional',
      );
      expect(result).toContain('Note: prefer functional');
    });
  });

  describe('condense', () => {
    it('generates base prompt without commentary', () => {
      const result = PROMPT_TEMPLATES.condense(filePath, startLine, endLine);
      expect(result).toContain('more concise');
      expect(result).not.toContain('Note:');
    });

    it('appends commentary when provided', () => {
      const result = PROMPT_TEMPLATES.condense(
        filePath,
        startLine,
        endLine,
        'keep technical terms',
      );
      expect(result).toContain('Note: keep technical terms');
    });
  });

  describe('chat', () => {
    it('includes user question in prompt', () => {
      const result = PROMPT_TEMPLATES.chat(filePath, startLine, endLine, 'Why is this async?');
      expect(result).toContain('Regarding lines 10-20');
      expect(result).toContain('Why is this async?');
      expect(result).toContain('Read those lines first');
    });

    it('does not contain old generic discussion prompt', () => {
      const result = PROMPT_TEMPLATES.chat(filePath, startLine, endLine, 'my question');
      expect(result).not.toContain('I want to discuss');
    });
  });
});
