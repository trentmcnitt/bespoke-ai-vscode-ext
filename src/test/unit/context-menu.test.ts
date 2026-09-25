import { describe, it, expect } from 'vitest';
import {
  buildClaudeArgs,
  PromptContext,
  PROMPT_TEMPLATES,
  stripControlChars,
} from '../../commands/context-menu-utils';
import { PermissionMode } from '../../types';

describe('stripControlChars', () => {
  it('removes Ctrl-C and other C0 controls that could cancel a typed shell line', () => {
    expect(stripControlChars('a\x03touch /tmp/x\x04\x15b')).toBe('atouch /tmp/xb');
  });

  it('removes ESC so terminal escape sequences cannot reach the displayed prompt', () => {
    expect(stripControlChars('x\x1b[2Jy')).toBe('x[2Jy');
  });

  it('removes carriage returns, DEL, and C1 controls', () => {
    expect(stripControlChars('a\rb\x7fc\x9bd')).toBe('abcd');
  });

  it('removes Unicode bidi overrides and isolates', () => {
    expect(stripControlChars('a\u202Eb\u2066c\u2069d')).toBe('abcd');
  });

  it('keeps newlines, tabs, and shell metacharacters (they are inert in argv)', () => {
    const text = 'line1\n\tline2 "q" $HOME `id` $(id) ! ^old^new^ \\';
    expect(stripControlChars(text)).toBe(text);
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

describe('buildClaudeArgs', () => {
  it('passes the prompt as a single argument after --', () => {
    expect(buildClaudeArgs('Explain this', 'default')).toEqual(['--', 'Explain this']);
  });

  it('emits the acceptEdits flag', () => {
    expect(buildClaudeArgs('Explain this', 'acceptEdits')).toEqual([
      '--permission-mode',
      'acceptEdits',
      '--',
      'Explain this',
    ]);
  });

  it('emits the bypassPermissions flag', () => {
    expect(buildClaudeArgs('Explain this', 'bypassPermissions')).toEqual([
      '--dangerously-skip-permissions',
      '--',
      'Explain this',
    ]);
  });

  // VS Code does not enforce a setting's declared `enum` at read time, so a hand-edited
  // settings.json can put an arbitrary string in contextMenu.permissionMode. That string
  // must never reach the command line.
  describe('rejects out-of-union permission modes instead of passing them through', () => {
    const payloads = ['; touch /tmp/pwned; #', '$(id)', 'acceptEdits; rm -rf ~', '--help', ''];

    for (const payload of payloads) {
      it(`neutralises ${JSON.stringify(payload)}`, () => {
        expect(buildClaudeArgs('Explain this', payload as PermissionMode)).toEqual([
          '--',
          'Explain this',
        ]);
      });
    }
  });

  it('keeps shell metacharacters, newlines, and a leading dash inside the one prompt argument', () => {
    const prompt = '-rf "quoted" $HOME `id` $(touch /tmp/x)\nsecond line';
    const args = buildClaudeArgs(prompt, 'default');
    expect(args).toEqual(['--', prompt]);
  });

  it('keeps a crafted file path inside the prompt argument', () => {
    const ctx: PromptContext = {
      selectedText: '',
      filePath: stripControlChars('/repo/a\x03touch /tmp/canary\n.txt'),
      startLine: 1,
      endLine: 2,
      unsaved: false,
    };
    const args = buildClaudeArgs(PROMPT_TEMPLATES.explain(ctx), 'default');
    expect(args).toHaveLength(2);
    expect(args[1]).toContain('`/repo/atouch /tmp/canary\n.txt`');
    expect(args[1]).not.toContain('\x03');
  });
});
