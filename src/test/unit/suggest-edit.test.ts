import { describe, it, expect, vi, beforeEach } from 'vitest';
import { makeLogger } from '../helpers';

vi.mock('vscode', () => {
  class Position {
    constructor(
      public line: number,
      public character: number,
    ) {}
  }
  class Range {
    constructor(
      public start: Position,
      public end: Position,
    ) {}
  }
  class WorkspaceEdit {
    replacements: { uri: unknown; range: Range; text: string }[] = [];
    replace(uri: unknown, range: Range, text: string) {
      this.replacements.push({ uri, range, text });
    }
  }
  class TabInputTextDiff {
    constructor(
      public original: { scheme: string; path: string },
      public modified: { scheme: string; path: string },
    ) {}
  }
  class TabInputText {
    constructor(public uri: { scheme: string; path: string }) {}
  }
  return {
    Position,
    Range,
    WorkspaceEdit,
    TabInputTextDiff,
    TabInputText,
    ProgressLocation: { Notification: 15 },
    Uri: {
      from: vi.fn((parts: { scheme: string; path: string }) => ({ ...parts })),
    },
    window: {
      activeTextEditor: undefined as unknown,
      showWarningMessage: vi.fn(),
      showInformationMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      setStatusBarMessage: vi.fn(),
      withProgress: vi.fn(),
      tabGroups: { all: [] as { tabs: unknown[] }[], close: vi.fn(async () => true) },
    },
    commands: { executeCommand: vi.fn() },
    workspace: {
      applyEdit: vi.fn(async () => true),
      workspaceFolders: [{ uri: { fsPath: '/home/u/my-project' } }],
    },
  };
});

import * as vscode from 'vscode';
import { suggestEdit, originalContentProvider, correctedContentProvider } from '../../suggest-edit';
import { SYSTEM_PROMPT } from '../../utils/suggest-edit-utils';
import type { BackendRouter } from '../../providers/backend-router';
import type { ApiCommandProvider } from '../../providers/api/api-command-provider';
import type { UsageLedger } from '../../utils/usage-ledger';
import type { Logger } from '../../utils/logger';

const win = vscode.window as unknown as {
  activeTextEditor: unknown;
  showWarningMessage: ReturnType<typeof vi.fn>;
  showInformationMessage: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  setStatusBarMessage: ReturnType<typeof vi.fn>;
  withProgress: ReturnType<typeof vi.fn>;
  tabGroups: { all: { tabs: { input: unknown }[] }[]; close: ReturnType<typeof vi.fn> };
};
const executeCommand = vscode.commands.executeCommand as unknown as ReturnType<typeof vi.fn>;
const applyEdit = vscode.workspace.applyEdit as unknown as ReturnType<typeof vi.fn>;

type Pos = { line: number; character: number };

/** A minimal line-addressed TextDocument. */
function makeDocument(content: string, opts: { fileName?: string; languageId?: string } = {}) {
  const lines = content.split('\n');
  const offset = (p: Pos) =>
    lines.slice(0, p.line).reduce((n, l) => n + l.length + 1, 0) + p.character;
  return {
    uri: { fsPath: '/home/u/my-project/' + (opts.fileName ?? 'notes.md') },
    fileName: '/home/u/my-project/' + (opts.fileName ?? 'notes.md'),
    languageId: opts.languageId ?? 'markdown',
    version: 1,
    getText: vi.fn((r: { start: Pos; end: Pos }) => content.slice(offset(r.start), offset(r.end))),
    lineAt: (n: number) => ({
      range: { end: new vscode.Position(n, lines[n].length) },
    }),
  };
}

function makeEditor(
  content: string,
  opts: {
    selection?: { start: Pos; end: Pos };
    visible?: { start: Pos; end: Pos }[];
    fileName?: string;
  } = {},
) {
  const document = makeDocument(content, { fileName: opts.fileName });
  const sel = opts.selection;
  const selection = sel
    ? { ...sel, isEmpty: false }
    : { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, isEmpty: true };
  return { document, selection, visibleRanges: opts.visible ?? [] };
}

function makeRouter(
  response: { text: string | null; meta?: unknown; errorType?: string; aborted?: boolean } | Error,
) {
  return {
    isCommandAvailable: vi.fn(() => true),
    getBackend: vi.fn((): 'claude-code' | 'api' => 'claude-code'),
    getCurrentModel: vi.fn(() => 'sonnet'),
    sendCommand: vi.fn(async () => {
      if (response instanceof Error) throw response;
      return response;
    }),
  };
}

/** Run withProgress's task with a fake CancellationToken; captures the cancel listener. */
let cancelListener: (() => void) | undefined;
function runProgressNormally() {
  win.withProgress.mockImplementation(async (_opts: unknown, task: any) =>
    task(
      { report: vi.fn() },
      {
        onCancellationRequested: (cb: () => void) => {
          cancelListener = cb;
        },
      },
    ),
  );
}

async function run(
  router: ReturnType<typeof makeRouter>,
  ledger?: Partial<UsageLedger>,
  logger: Logger = makeLogger(),
) {
  await suggestEdit(router as unknown as BackendRouter, logger, ledger as UsageLedger | undefined);
}

function makeErrorSpyLogger() {
  const error = vi.fn();
  return { logger: { ...makeLogger(), error } as unknown as Logger, error };
}

function appliedEdits() {
  return applyEdit.mock.calls.map((c) => (c[0] as any).replacements).flat();
}

beforeEach(() => {
  vi.clearAllMocks();
  cancelListener = undefined;
  runProgressNormally();
  executeCommand.mockResolvedValue(undefined);
  win.activeTextEditor = undefined;
  win.tabGroups.all = [{ tabs: [] }];
});

/** The user's own file, open in a tab. */
function userFileTab() {
  return {
    input: new vscode.TabInputText({ scheme: 'file', path: '/home/u/my-project/notes.md' } as any),
  };
}

/**
 * Make `vscode.diff` open a diff tab (as VS Code does) in the first group, and return
 * a getter for it.
 */
function openDiffTabOnDiff() {
  let diffTab: { input: unknown } | undefined;
  executeCommand.mockImplementation(async (cmd: string, left: any, right: any) => {
    if (cmd === 'vscode.diff') {
      diffTab = { input: new vscode.TabInputTextDiff(left, right) };
      win.tabGroups.all[0].tabs.push(diffTab);
    }
  });
  return () => diffTab;
}

describe('suggestEdit — preconditions', () => {
  it('warns and does nothing when the command pool is not ready', async () => {
    const router = makeRouter({ text: '<corrected>x</corrected>' });
    router.isCommandAvailable.mockReturnValue(false);
    win.activeTextEditor = makeEditor('text', {
      visible: [{ start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }],
    });
    await run(router);
    expect(win.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Command pool not ready'),
    );
    expect(router.sendCommand).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'no_key', presetId: 'xai-grok', displayName: 'Grok' }, 'No API key for Grok'],
    [
      { kind: 'breaker_open', presetId: 'x', displayName: 'X', retryInMs: 7_000 },
      'Paused after repeated API errors — retrying in 7 s',
    ],
    [{ kind: 'no_preset', presetId: 'gone' }, 'API preset "gone" is not available'],
  ])('on the API backend, says why commands are unavailable (%j)', async (reason, expected) => {
    const router = makeRouter({ text: '<corrected>x</corrected>' });
    router.isCommandAvailable.mockReturnValue(false);
    router.getBackend.mockReturnValue('api');
    const apiCommand = { unavailableReason: vi.fn(() => reason) };
    await suggestEdit(
      router as unknown as BackendRouter,
      makeLogger(),
      undefined,
      apiCommand as unknown as ApiCommandProvider,
    );
    expect(win.showWarningMessage).toHaveBeenCalledOnce();
    expect(win.showWarningMessage.mock.calls[0][0]).toContain(`Bespoke AI: ${expected}`);
    expect(win.showWarningMessage).not.toHaveBeenCalledWith(
      expect.stringContaining('Command pool not ready'),
    );
    expect(router.sendCommand).not.toHaveBeenCalled();
  });

  it('warns when there is no active editor', async () => {
    const router = makeRouter({ text: '' });
    await run(router);
    expect(win.showWarningMessage).toHaveBeenCalledWith('Bespoke AI: No active editor.');
    expect(router.sendCommand).not.toHaveBeenCalled();
  });

  it('does nothing when there is no selection and no visible range', async () => {
    const router = makeRouter({ text: '' });
    win.activeTextEditor = makeEditor('text');
    await run(router);
    expect(router.sendCommand).not.toHaveBeenCalled();
  });
});

describe('suggestEdit — request', () => {
  it('sends the visible lines (expanded to full lines) through BackendRouter.sendCommand', async () => {
    const content = 'line zero\nteh first line\nsecond line\nthird line';
    // Visible ranges span lines 1..2, starting mid-line — should expand to full lines.
    win.activeTextEditor = makeEditor(content, {
      fileName: 'doc.md',
      visible: [
        { start: { line: 1, character: 3 }, end: { line: 1, character: 5 } },
        { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } },
      ],
    });
    const router = makeRouter({ text: null });
    await run(router);

    expect(router.sendCommand).toHaveBeenCalledOnce();
    const [message, options] = router.sendCommand.mock.calls[0] as unknown as [string, any];
    expect(message).toContain(SYSTEM_PROMPT);
    expect(message).toContain(
      '<file_content language="markdown" name="doc.md">\nteh first line\nsecond line\n</file_content>',
    );
    expect(options.timeoutMs).toBe(90_000);
    expect(options.onCancel).toBeInstanceOf(AbortSignal);
  });

  it('sends exactly the selection (not expanded) when one exists', async () => {
    win.activeTextEditor = makeEditor('alpha beta gamma', {
      selection: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
    });
    const router = makeRouter({ text: null });
    await run(router);
    const [message] = router.sendCommand.mock.calls[0] as unknown as [string];
    expect(message).toContain('>\nbeta\n</file_content>');
  });

  it('aborts the request signal when the progress notification is cancelled', async () => {
    win.activeTextEditor = makeEditor('abc', {
      selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    });
    const router = makeRouter({ text: null });
    await run(router);
    const signal = (router.sendCommand.mock.calls[0] as unknown as [string, any])[1]
      .onCancel as AbortSignal;
    expect(signal.aborted).toBe(false);
    cancelListener!();
    expect(signal.aborted).toBe(true);
  });

  it('rejects a concurrent invocation while one is in flight, then allows a new one', async () => {
    win.activeTextEditor = makeEditor('abc', {
      selection: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    });
    let release!: (v: { text: null }) => void;
    const router = makeRouter({ text: null });
    router.sendCommand.mockImplementationOnce(
      () => new Promise<{ text: null }>((r) => (release = r)) as any,
    );

    const first = run(router);
    await vi.waitFor(() => expect(router.sendCommand).toHaveBeenCalledTimes(1));
    await run(router);
    expect(win.setStatusBarMessage).toHaveBeenCalledWith(
      'Bespoke AI: Request already in progress',
      2000,
    );
    expect(router.sendCommand).toHaveBeenCalledTimes(1);

    release({ text: null });
    await first;
    await run(router);
    expect(router.sendCommand).toHaveBeenCalledTimes(2);
  });
});

describe('suggestEdit — response handling', () => {
  const content = 'Teh quick fox.\nSecond line.';
  const visible = [{ start: { line: 0, character: 0 }, end: { line: 1, character: 0 } }];

  it('returns silently on a null response (cancelled / aborted) without recording usage', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    const ledger = { record: vi.fn() };
    await run(makeRouter({ text: null }), ledger);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(win.showWarningMessage).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalled();
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('toasts and logs a pool failure (null text with an errorType), naming the cause', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    win.showErrorMessage.mockReturnValueOnce(new Promise(() => {})); // never dismissed
    const { logger, error } = makeErrorSpyLogger();
    const ledger = { record: vi.fn() };
    await run(makeRouter({ text: null, meta: null, errorType: 'pool_recycled' }), ledger, logger);
    expect(error).toHaveBeenCalledWith('Suggest edit failed: pool_recycled');
    expect(win.showErrorMessage).toHaveBeenCalledOnce();
    const msg = win.showErrorMessage.mock.calls[0][0] as string;
    expect(msg).toMatch(/^Bespoke AI: Suggest edit failed — /);
    expect(msg).toContain('restarted');
    expect(ledger.record).not.toHaveBeenCalled();
    // The unsettled toast does not hold the in-flight guard.
    const next = makeRouter({ text: null });
    await run(next);
    expect(next.sendCommand).toHaveBeenCalledOnce();
  });

  it('stays silent on an aborted (superseded / shutdown) command', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    const { logger, error } = makeErrorSpyLogger();
    await run(makeRouter({ text: null, meta: null, aborted: true }), undefined, logger);
    expect(win.showErrorMessage).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('warns on an unparseable response and does not edit', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    await run(makeRouter({ text: 'Sure! Here are the fixes you asked for.' }));
    expect(win.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Could not parse edit response'),
    );
    expect(executeCommand).not.toHaveBeenCalledWith('vscode.diff', expect.anything());
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('reports "No issues found" when the corrected text is identical', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    await run(makeRouter({ text: `<corrected>${content}</corrected>` }));
    expect(win.showInformationMessage).toHaveBeenCalledWith('Bespoke AI: No issues found.');
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('logs and toasts backend errors (resolving, not rejecting) and releases the in-flight guard', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    // The toast never settles (the user hasn't dismissed it). The wrapper must not
    // await it, or the in-flight guard would stay held until dismissal.
    win.showErrorMessage.mockReturnValueOnce(new Promise(() => {}));
    const { logger, error } = makeErrorSpyLogger();
    const err = new Error('pool crashed');
    await expect(run(makeRouter(err), undefined, logger)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Suggest edit failed', err);
    expect(win.showErrorMessage).toHaveBeenCalledWith(
      'Bespoke AI: Suggest edit failed — pool crashed',
    );
    // A subsequent invocation is not blocked by a stuck in-flight flag.
    const router = makeRouter({ text: null });
    await run(router);
    expect(router.sendCommand).toHaveBeenCalledOnce();
    expect(win.setStatusBarMessage).not.toHaveBeenCalledWith(
      'Bespoke AI: Request already in progress',
      2000,
    );
  });

  it('records usage with SDK metadata when available, falling back to router model', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    win.showInformationMessage.mockResolvedValue('Discard');
    const ledger = { record: vi.fn() };
    const text = '<corrected>The quick fox.\nSecond line.</corrected>';
    await run(makeRouter({ text, meta: { inputTokens: 100, costUsd: 0.01 } }), ledger);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'suggest-edit',
        model: 'sonnet',
        project: 'my-project',
        inputTokens: 100,
        costUsd: 0.01,
        outputChars: text.length,
      }),
    );
  });
});

describe('suggestEdit — diff preview and apply', () => {
  const content = 'Teh quick fox.\nSecond line.\nUntouched line.';
  const visible = [{ start: { line: 0, character: 0 }, end: { line: 1, character: 5 } }];
  const corrected = 'The quick fox.\nSecond line.';

  it('applies the corrected text to the full-line visible range on Apply', async () => {
    const editor = makeEditor(content, { visible });
    win.activeTextEditor = editor;
    win.showInformationMessage.mockResolvedValue('Apply');
    await run(makeRouter({ text: `<corrected>${corrected}</corrected>` }));

    const edits = appliedEdits();
    expect(edits).toHaveLength(1);
    expect(edits[0].uri).toBe(editor.document.uri);
    expect(edits[0].text).toBe(corrected);
    // Range: line 0 col 0 → end of line 1 (full lines), not line 2.
    expect(edits[0].range.start).toMatchObject({ line: 0, character: 0 });
    expect(edits[0].range.end).toMatchObject({ line: 1, character: 'Second line.'.length });
    expect(win.setStatusBarMessage).toHaveBeenCalledWith(
      'Bespoke AI: Edits applied (Ctrl+Z to undo)',
      4000,
    );
  });

  it('accepts a fenced code block response as a fallback', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    win.showInformationMessage.mockResolvedValue('Apply');
    await run(makeRouter({ text: '```markdown\n' + corrected + '\n```' }));
    expect(appliedEdits()[0].text).toBe(corrected);
  });

  it('does not edit when the user discards (or dismisses) the prompt', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    win.showInformationMessage.mockResolvedValue(undefined);
    await run(makeRouter({ text: `<corrected>${corrected}</corrected>` }));
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('discards the edit if the document changed while the user was reviewing', async () => {
    const editor = makeEditor(content, { visible });
    win.activeTextEditor = editor;
    win.showInformationMessage.mockImplementation(async () => {
      editor.document.version = 2; // user typed during the diff
      return 'Apply';
    });
    await run(makeRouter({ text: `<corrected>${corrected}</corrected>` }));
    expect(applyEdit).not.toHaveBeenCalled();
    expect(win.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('Document changed while editing'),
    );
  });

  it('serves the diff panes from the content store, keyed verbatim even for ?#% file names', async () => {
    // Uri.parse would split '?'/'#' into query/fragment and decode '%xx'; Uri.from keeps the
    // path intact so the providers find the stored text.
    win.activeTextEditor = makeEditor(content, { visible, fileName: 'a?b#c%20d.md' });
    win.showInformationMessage.mockResolvedValue('Discard');
    const seen: { original?: string; corrected?: string; title?: string } = {};
    executeCommand.mockImplementation(async (cmd: string, left: any, right: any, title: string) => {
      if (cmd === 'vscode.diff') {
        seen.original = originalContentProvider.provideTextDocumentContent(
          left,
          {} as any,
        ) as string;
        seen.corrected = correctedContentProvider.provideTextDocumentContent(
          right,
          {} as any,
        ) as string;
        seen.title = title;
        expect(left.scheme).toBe('bespoke-edit-original');
        expect(right.scheme).toBe('bespoke-edit-corrected');
      }
    });
    await run(makeRouter({ text: `<corrected>${corrected}</corrected>` }));

    expect(vscode.Uri.from).toHaveBeenCalled();
    expect(seen.original).toBe('Teh quick fox.\nSecond line.');
    expect(seen.corrected).toBe(corrected);
    expect(seen.title).toBe('Suggest Edits — a?b#c%20d.md');
  });

  it('does not close any editor if the diff command throws, and still clears stored content', async () => {
    const editor = makeEditor(content, { visible });
    win.activeTextEditor = editor;
    const userTab = userFileTab();
    win.tabGroups.all = [{ tabs: [userTab] }];
    let leftUri: any;
    executeCommand.mockImplementation(async (cmd: string, left: any) => {
      if (cmd === 'vscode.diff') {
        leftUri = left;
        throw new Error('diff failed');
      }
    });
    const { logger, error } = makeErrorSpyLogger();
    await expect(
      run(makeRouter({ text: `<corrected>${corrected}</corrected>` }), undefined, logger),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith('Suggest edit failed', expect.any(Error));
    expect(win.showErrorMessage).toHaveBeenCalledWith(
      'Bespoke AI: Suggest edit failed — diff failed',
    );
    // The active editor is the user's own file: it must not be closed.
    expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.closeActiveEditor');
    expect(win.tabGroups.close).not.toHaveBeenCalled();
    expect(originalContentProvider.provideTextDocumentContent(leftUri, {} as any)).toBe('');
    expect(applyEdit).not.toHaveBeenCalled();
  });

  it('closes its own diff tab, not the tab the user switched to during the prompt', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    const userTab = userFileTab();
    const diffTab = openDiffTabOnDiff();
    win.showInformationMessage.mockImplementation(async () => {
      // The user moves to another file (in another group) while deciding.
      win.tabGroups.all.push({ tabs: [userTab] });
      return 'Discard';
    });
    await run(makeRouter({ text: `<corrected>${corrected}</corrected>` }));

    expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.closeActiveEditor');
    expect(win.tabGroups.close).toHaveBeenCalledOnce();
    const closed = win.tabGroups.close.mock.calls[0][0] as unknown[];
    expect(closed).toEqual([diffTab()]);
    expect(closed).not.toContain(userTab);
  });

  it('closes the diff tab on the normal path before clearing stored content', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    const diffTab = openDiffTabOnDiff();
    win.showInformationMessage.mockResolvedValue('Apply');
    let contentAtClose: string | undefined;
    win.tabGroups.close.mockImplementation(async (tabs: any[]) => {
      contentAtClose = originalContentProvider.provideTextDocumentContent(
        tabs[0].input.original,
        {} as any,
      ) as string;
      return true;
    });
    await run(makeRouter({ text: `<corrected>${corrected}</corrected>` }));

    expect(win.tabGroups.close).toHaveBeenCalledWith([diffTab()]);
    expect(contentAtClose).toBe('Teh quick fox.\nSecond line.');
    expect(appliedEdits()).toHaveLength(1);
  });

  it('closes nothing if the user already closed the diff tab', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
    openDiffTabOnDiff();
    win.showInformationMessage.mockImplementation(async () => {
      win.tabGroups.all = [{ tabs: [userFileTab()] }];
      return 'Discard';
    });
    await run(makeRouter({ text: `<corrected>${corrected}</corrected>` }));
    expect(win.tabGroups.close).not.toHaveBeenCalled();
    expect(executeCommand).not.toHaveBeenCalledWith('workbench.action.closeActiveEditor');
  });
});
