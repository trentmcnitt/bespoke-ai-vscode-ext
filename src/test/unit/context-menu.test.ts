import { describe, it, expect } from 'vitest';
import {
  escapeForDoubleQuotes,
  PromptContext,
  PROMPT_TEMPLATES,
} from '../../commands/context-menu-utils';

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
    expect(escapeForDoubleQuotes("hello world it's fine")).toBe("hello world it's fine");
  });

  it('escapes exclamation marks (bash history expansion)', () => {
    expect(escapeForDoubleQuotes('fix this!')).toBe('fix this\\!');
    expect(escapeForDoubleQuotes('!!')).toBe('\\!\\!');
  });

  it('escapes all special characters combined', () => {
    expect(escapeForDoubleQuotes('a\\b"c$d`e!f')).toBe('a\\\\b\\"c\\$d\\`e\\!f');
  });
});

describe('PROMPT_TEMPLATES', () => {
  // Three states: clean saved, dirty saved, untitled
  const cleanCtx: PromptContext = {
    selectedText: 'some selected text',
    filePath: '/src/app.ts',
    startLine: 10,
    endLine: 20,
    unsaved: false,
  };

  const dirtyCtx: PromptContext = {
    selectedText: 'some selected text',
    filePath: '/src/app.ts',
    startLine: 10,
    endLine: 20,
    unsaved: true,
  };

  const untitledCtx: PromptContext = {
    selectedText: 'some selected text',
    filePath: null,
    startLine: 10,
    endLine: 20,
    unsaved: true,
  };

  describe('explain', () => {
    it('references file when clean', () => {
      const result = PROMPT_TEMPLATES.explain(cleanCtx);
      expect(result).toContain('Explain lines 10-20');
      expect(result).toContain(cleanCtx.filePath);
      expect(result).toContain('Read those lines first');
      expect(result).not.toContain('some selected text');
    });

    it('embeds text with file context when dirty', () => {
      const result = PROMPT_TEMPLATES.explain(dirtyCtx);
      expect(result).toContain('Explain the following text');
      expect(result).toContain('some selected text');
      expect(result).toContain(dirtyCtx.filePath!);
      expect(result).toContain('lines 10-20');
      expect(result).toContain('unsaved changes');
      expect(result).toContain('surrounding context');
    });

    it('embeds text with line numbers when untitled', () => {
      const result = PROMPT_TEMPLATES.explain(untitledCtx);
      expect(result).toContain('Explain the following text');
      expect(result).toContain('some selected text');
      expect(result).toContain('lines 10-20');
      expect(result).not.toContain('surrounding context');
    });
  });

  describe('fix', () => {
    it('references file when clean', () => {
      const result = PROMPT_TEMPLATES.fix(cleanCtx);
      expect(result).toContain('Fix any issues in lines 10-20');
      expect(result).toContain(cleanCtx.filePath);
      expect(result).toContain('Apply fixes');
    });

    it('embeds text with file context when dirty', () => {
      const result = PROMPT_TEMPLATES.fix(dirtyCtx);
      expect(result).toContain('Fix any issues in the following text');
      expect(result).toContain('some selected text');
      expect(result).toContain(dirtyCtx.filePath!);
      expect(result).toContain('unsaved changes');
      expect(result).toContain('Show the corrected version');
    });

    it('embeds text when untitled', () => {
      const result = PROMPT_TEMPLATES.fix(untitledCtx);
      expect(result).toContain('Fix any issues in the following text');
      expect(result).toContain('some selected text');
      expect(result).toContain('Show the corrected version');
    });
  });

  describe('do', () => {
    it('references file when clean', () => {
      const result = PROMPT_TEMPLATES.do(cleanCtx, 'convert to TypeScript');
      expect(result).toContain('Apply the following to lines 10-20');
      expect(result).toContain(cleanCtx.filePath!);
      expect(result).toContain('convert to TypeScript');
      expect(result).toContain('Apply changes directly');
    });

    it('embeds text with file context when dirty', () => {
      const result = PROMPT_TEMPLATES.do(dirtyCtx, 'convert to a bullet list');
      expect(result).toContain('convert to a bullet list');
      expect(result).toContain('some selected text');
      expect(result).toContain(dirtyCtx.filePath!);
      expect(result).toContain('unsaved changes');
    });

    it('embeds text when untitled', () => {
      const result = PROMPT_TEMPLATES.do(untitledCtx, 'convert to a bullet list');
      expect(result).toContain('convert to a bullet list');
      expect(result).toContain('some selected text');
      expect(result).not.toContain('surrounding context');
    });
  });
});
