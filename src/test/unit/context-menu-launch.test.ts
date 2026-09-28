import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const terminal = { show: vi.fn(), sendText: vi.fn() };

vi.mock('vscode', () => ({
  ViewColumn: { Two: 2 },
  window: {
    activeTextEditor: undefined as unknown,
    createTerminal: vi.fn(() => terminal),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showErrorMessage: vi.fn(),
    showInputBox: vi.fn(),
  },
  commands: { executeCommand: vi.fn(() => Promise.resolve()) },
  workspace: { isTrusted: true },
}));

vi.mock('child_process', () => ({ execFileSync: vi.fn() }));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const existsSync = vi.fn(() => true);
  return { ...actual, existsSync, default: { ...actual, existsSync } };
});

vi.mock('../../utils/claude-executable', () => ({ resolveClaudeExecutable: vi.fn() }));

import * as vscode from 'vscode';
import * as fs from 'fs';
import { execFileSync } from 'child_process';
import { resolveClaudeExecutable } from '../../utils/claude-executable';
import { explainSelection, fixSelection, doSelection } from '../../commands/context-menu';
import type { ExtensionConfig } from '../../types';

type Settings = ExtensionConfig['contextMenu'];

const win = vscode.window as unknown as {
  activeTextEditor: unknown;
  createTerminal: ReturnType<typeof vi.fn>;
  showWarningMessage: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  showInputBox: ReturnType<typeof vi.fn>;
};
const ws = vscode.workspace as unknown as { isTrusted: boolean };
const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
const execFileSyncMock = execFileSync as unknown as ReturnType<typeof vi.fn>;
const existsSyncMock = fs.existsSync as unknown as ReturnType<typeof vi.fn>;
const resolveClaudeMock = resolveClaudeExecutable as unknown as ReturnType<typeof vi.fn>;

const CLAUDE = { agent: 'claude-code', permissionMode: 'default' } as Settings;
const OPENCODE = { agent: 'opencode', permissionMode: 'default' } as Settings;

/** Characters that would be dangerous if the prompt ever reached a shell command line. */
const HOSTILE = `x"; rm -rf ~; echo $(id) \`whoami\` | tee /tmp/p & $HOME > /dev/null`;

function makeEditor(opts: {
  text?: string;
  fsPath?: string;
  isUntitled?: boolean;
  isDirty?: boolean;
  start?: { line: number; character: number };
  end?: { line: number; character: number };
  isEmpty?: boolean;
}) {
  const start = opts.start ?? { line: 4, character: 0 };
  const end = opts.end ?? { line: 6, character: 3 };
  return {
    selection: { start, end, isEmpty: opts.isEmpty ?? false },
    document: {
      getText: vi.fn(() => opts.text ?? 'selected'),
      isUntitled: opts.isUntitled ?? false,
      isDirty: opts.isDirty ?? false,
      uri: { fsPath: opts.fsPath ?? '/repo/src/app.ts' },
    },
  };
}

function terminalOptions(): {
  name: string;
  shellPath: string;
  shellArgs: string[];
  location: any;
} {
  expect(win.createTerminal).toHaveBeenCalledOnce();
  return win.createTerminal.mock.calls[0][0];
}

const originalPlatform = process.platform;
function setPlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default to a Unix host; Windows cases opt in with setPlatform('win32').
  setPlatform('linux');
  ws.isTrusted = true;
  win.activeTextEditor = makeEditor({});
  resolveClaudeMock.mockReturnValue({ path: '/home/u/.local/bin/claude', native: true });
  execFileSyncMock.mockReturnValue('/usr/local/bin/opencode\n');
  existsSyncMock.mockReturnValue(true);
  win.showWarningMessage.mockReturnValue(Promise.resolve(undefined));
});

afterEach(() => {
  setPlatform(originalPlatform);
});

describe('context menu — Claude Code launch', () => {
  it('launches the native binary directly with the prompt as a single argv entry after --', async () => {
    await explainSelection(CLAUDE);
    const opts = terminalOptions();
    expect(opts.name).toBe('Claude');
    expect(opts.shellPath).toBe('/home/u/.local/bin/claude');
    expect(opts.shellArgs).toEqual([
      '--',
      expect.stringMatching(/^Explain lines 5-7 of `\/repo\/src\/app\.ts`\./),
    ]);
    expect(opts.location).toEqual({ viewColumn: vscode.ViewColumn.Two });
    expect(terminal.show).toHaveBeenCalledWith(false);
    expect(executeCommand).toHaveBeenCalledWith('moveActiveEditor', { to: 'last', by: 'tab' });
  });

  it('never types into the terminal with sendText', async () => {
    await explainSelection(CLAUDE);
    await fixSelection(CLAUDE);
    win.showInputBox.mockResolvedValue('do it');
    await doSelection(CLAUDE);
    expect(win.createTerminal).toHaveBeenCalledTimes(3);
    expect(terminal.sendText).not.toHaveBeenCalled();
  });

  it('runs the bundled cli.js via node when no native binary exists', async () => {
    resolveClaudeMock.mockReturnValue({ path: '/ext/node_modules/sdk/cli.js', native: false });
    await explainSelection(CLAUDE);
    const opts = terminalOptions();
    expect(opts.shellPath).toBe('node');
    expect(opts.shellArgs[0]).toBe('/ext/node_modules/sdk/cli.js');
    expect(opts.shellArgs[1]).toBe('--');
  });

  it('falls back to bare `claude` on macOS/Linux when resolution throws', async () => {
    setPlatform('linux');
    resolveClaudeMock.mockImplementation(() => {
      throw new Error('sdk missing');
    });
    await explainSelection(CLAUDE);
    expect(terminalOptions().shellPath).toBe('claude');
  });

  it('refuses on Windows when resolution throws (no claude.cmd shim through cmd.exe)', async () => {
    setPlatform('win32');
    resolveClaudeMock.mockImplementation(() => {
      throw new Error('sdk missing');
    });
    await explainSelection(CLAUDE);
    expect(win.createTerminal).not.toHaveBeenCalled();
    expect(win.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('Claude Code executable not found'),
    );
  });

  it.each([
    ['default', []],
    ['acceptEdits', ['--permission-mode', 'acceptEdits']],
    ['bypassPermissions', ['--dangerously-skip-permissions']],
  ] as const)('maps permissionMode %s to fixed args %j', async (mode, args) => {
    await fixSelection({ agent: 'claude-code', permissionMode: mode });
    const { shellArgs } = terminalOptions();
    expect(shellArgs.slice(0, -2)).toEqual(args);
    expect(shellArgs.at(-2)).toBe('--');
  });

  it('an out-of-union permissionMode string contributes no arguments', async () => {
    // Hand-edited settings.json can hold any string; only lookup-table entries reach argv.
    await fixSelection({
      agent: 'claude-code',
      permissionMode: '--dangerously-skip-permissions; rm -rf ~' as any,
    });
    const { shellArgs } = terminalOptions();
    expect(shellArgs).toHaveLength(2);
    expect(shellArgs[0]).toBe('--');
    expect(shellArgs.join(' ')).not.toContain('rm -rf');
    expect(shellArgs).not.toContain('--dangerously-skip-permissions');
  });
});

describe('context menu — hostile content stays inside one argv entry', () => {
  it('Do: instruction with shell metacharacters is one argument after --, control chars stripped', async () => {
    win.activeTextEditor = makeEditor({ fsPath: `/repo/${HOSTILE}.ts` });
    win.showInputBox.mockResolvedValue(`${HOSTILE}\x03\x1b[2J\u202E`);
    await doSelection(CLAUDE);
    const { shellArgs } = terminalOptions();
    expect(shellArgs).toHaveLength(2);
    expect(shellArgs[0]).toBe('--');
    const prompt = shellArgs[1];
    expect(prompt).toContain(HOSTILE);
    expect(prompt).toContain(`/repo/${HOSTILE}.ts`);
    expect(prompt).not.toMatch(/[\x03\x1b\u202E]/);
  });

  it('dirty buffer: selected text is embedded in the prompt with control chars stripped', async () => {
    win.activeTextEditor = makeEditor({
      isDirty: true,
      text: `evil\x03 $(touch /tmp/pwned)\u2066`,
    });
    await fixSelection(CLAUDE);
    const { shellArgs } = terminalOptions();
    expect(shellArgs).toHaveLength(2);
    expect(shellArgs[1]).toContain('evil $(touch /tmp/pwned)');
    expect(shellArgs[1]).toContain('(file has unsaved changes)');
    expect(shellArgs[1]).not.toMatch(/[\x03\u2066]/);
  });

  it('a selection starting with "-" cannot be read as a flag (opencode uses --prompt=)', async () => {
    win.activeTextEditor = makeEditor({ isUntitled: true, text: '--dangerously-skip-permissions' });
    await explainSelection(OPENCODE);
    const { shellArgs } = terminalOptions();
    expect(shellArgs).toHaveLength(1);
    expect(shellArgs[0].startsWith('--prompt=')).toBe(true);
  });
});

describe('context menu — opencode', () => {
  it('is refused in an untrusted workspace: no lookup, no terminal, trust prompt offered', async () => {
    ws.isTrusted = false;
    win.showWarningMessage.mockReturnValue(Promise.resolve('Manage Workspace Trust'));
    await explainSelection(OPENCODE);

    expect(win.createTerminal).not.toHaveBeenCalled();
    expect(execFileSyncMock).not.toHaveBeenCalled();
    expect(win.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Trust this workspace'),
      'Manage Workspace Trust',
    );
    await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledWith('workbench.trust.manage'));
  });

  it('untrusted refusal does not open trust settings when the warning is dismissed', async () => {
    ws.isTrusted = false;
    await fixSelection(OPENCODE);
    await Promise.resolve();
    expect(executeCommand).not.toHaveBeenCalledWith('workbench.trust.manage');
    expect(win.createTerminal).not.toHaveBeenCalled();
  });

  it('untrusted gate applies to Do as well', async () => {
    ws.isTrusted = false;
    win.showInputBox.mockResolvedValue('refactor');
    await doSelection(OPENCODE);
    expect(win.createTerminal).not.toHaveBeenCalled();
  });

  it('Claude Code is not gated by workspace trust (it has its own trust dialog)', async () => {
    ws.isTrusted = false;
    await explainSelection(CLAUDE);
    expect(terminalOptions().name).toBe('Claude');
  });

  it('launches the PATH opencode with --prompt= and ignores permissionMode', async () => {
    await fixSelection({ agent: 'opencode', permissionMode: 'bypassPermissions' });
    const opts = terminalOptions();
    expect(execFileSyncMock).toHaveBeenCalledWith('which', ['opencode'], expect.anything());
    expect(opts.name).toBe('opencode');
    expect(opts.shellPath).toBe('/usr/local/bin/opencode');
    expect(opts.shellArgs).toEqual([
      expect.stringMatching(/^--prompt=Fix any issues in lines 5-7/),
    ]);
    expect(opts.shellArgs.join(' ')).not.toContain('dangerously');
  });

  it('falls back to ~/.opencode/bin when not on PATH', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    await explainSelection(OPENCODE);
    expect(terminalOptions().shellPath).toMatch(/\.opencode[/\\]bin[/\\]opencode$/);
  });

  it('shows an error and opens no terminal when opencode is not installed', async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error('not found');
    });
    existsSyncMock.mockReturnValue(false);
    await explainSelection(OPENCODE);
    expect(win.createTerminal).not.toHaveBeenCalled();
    expect(win.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('opencode not found'),
    );
  });

  it('on Windows skips the npm opencode.cmd shim (cmd.exe would re-parse argv)', async () => {
    setPlatform('win32');
    execFileSyncMock.mockReturnValue('C:\\npm\\opencode.cmd\r\nC:\\tools\\opencode.exe\r\n');
    await explainSelection(OPENCODE);
    expect(execFileSyncMock).toHaveBeenCalledWith('where', ['opencode'], expect.anything());
    expect(terminalOptions().shellPath).toBe('C:\\tools\\opencode.exe');
  });

  it('on Windows refuses when only a .cmd shim exists', async () => {
    setPlatform('win32');
    execFileSyncMock.mockReturnValue('C:\\npm\\opencode.cmd\r\n');
    existsSyncMock.mockImplementation((p: string) => p === 'C:\\npm\\opencode.cmd');
    await explainSelection(OPENCODE);
    expect(win.createTerminal).not.toHaveBeenCalled();
    expect(win.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('opencode.exe'));
  });
});

describe('context menu — selection handling', () => {
  it('does nothing without an editor or with an empty selection', async () => {
    win.activeTextEditor = undefined;
    await explainSelection(CLAUDE);
    win.activeTextEditor = makeEditor({ isEmpty: true });
    await fixSelection(CLAUDE);
    await doSelection(CLAUDE);
    expect(win.createTerminal).not.toHaveBeenCalled();
    expect(win.showInputBox).not.toHaveBeenCalled();
  });

  it('a selection ending at column 0 of a later line excludes that line', async () => {
    win.activeTextEditor = makeEditor({
      start: { line: 2, character: 0 },
      end: { line: 5, character: 0 },
    });
    await explainSelection(CLAUDE);
    expect(terminalOptions().shellArgs.at(-1)).toMatch(/^Explain lines 3-5 of/);
  });

  it('untitled buffer: no file path, text embedded', async () => {
    win.activeTextEditor = makeEditor({ isUntitled: true, text: 'draft text' });
    await explainSelection(CLAUDE);
    const prompt = terminalOptions().shellArgs.at(-1)!;
    expect(prompt).not.toContain('/repo/src/app.ts');
    expect(prompt).toContain('(lines 5-7)');
    expect(prompt).toContain('draft text');
  });

  it('Do: Escape cancels without launching; required-input validator rejects blank text', async () => {
    win.showInputBox.mockResolvedValue(undefined);
    await doSelection(CLAUDE);
    expect(win.createTerminal).not.toHaveBeenCalled();
    const { validateInput } = win.showInputBox.mock.calls[0][0];
    expect(validateInput('   ')).toBe('Please enter a message');
    expect(validateInput('make formal')).toBeNull();
  });
});
