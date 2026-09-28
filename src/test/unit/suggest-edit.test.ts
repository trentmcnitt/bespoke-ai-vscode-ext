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
  return {
    Position,
    Range,
    WorkspaceEdit,
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
import type { UsageLedger } from '../../utils/usage-ledger';
import type { Logger } from '../../utils/logger';

const win = vscode.window as unknown as {
  activeTextEditor: unknown;
  showWarningMessage: ReturnType<typeof vi.fn>;
  showInformationMessage: ReturnType<typeof vi.fn>;
  showErrorMessage: ReturnType<typeof vi.fn>;
  setStatusBarMessage: ReturnType<typeof vi.fn>;
  withProgress: ReturnType<typeof vi.fn>;
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

function makeRouter(response: { text: string | null; meta?: unknown } | Error) {
  return {
    isCommandAvailable: vi.fn(() => true),
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
});

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

  it('closes the diff and clears stored content afterwards, even if the diff command throws', async () => {
    win.activeTextEditor = makeEditor(content, { visible });
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
    expect(executeCommand).toHaveBeenCalledWith('workbench.action.closeActiveEditor');
    expect(originalContentProvider.provideTextDocumentContent(leftUri, {} as any)).toBe('');
    expect(applyEdit).not.toHaveBeenCalled();
  });
});
