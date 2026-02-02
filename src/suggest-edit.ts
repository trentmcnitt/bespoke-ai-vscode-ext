import * as path from 'path';
import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { Logger } from './utils/logger';
import { UsageLedger } from './utils/usage-ledger';
import { SYSTEM_PROMPT, buildEditPrompt, parseEditResponse } from './utils/suggest-edit-utils';

const TIMEOUT_MS = 90_000;

let inFlight = false;

// Virtual document content providers for diff preview
const contentStore = new Map<string, string>();

export const originalContentProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri) {
    return contentStore.get(`original:${uri.path}`) ?? '';
  },
};

export const correctedContentProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri) {
    return contentStore.get(`corrected:${uri.path}`) ?? '';
  },
};

export async function suggestEdit(logger: Logger, ledger?: UsageLedger): Promise<void> {
  if (inFlight) {
    return;
  }
  inFlight = true;
  try {
    await doSuggestEdit(logger, ledger);
  } finally {
    inFlight = false;
  }
}

async function doSuggestEdit(logger: Logger, ledger?: UsageLedger): Promise<void> {
  logger.info('Suggest edit started');

  // 1. Get active editor
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Bespoke AI: No active editor.');
    return;
  }

  // 2. Capture visible ranges → merge into single range (full lines)
  const visibleRanges = editor.visibleRanges;
  if (visibleRanges.length === 0) {
    return;
  }
  const startLine = visibleRanges[0].start.line;
  const endLine = visibleRanges[visibleRanges.length - 1].end.line;
  const range = new vscode.Range(
    new vscode.Position(startLine, 0),
    editor.document.lineAt(endLine).range.end,
  );

  // 3. Store version for staleness check
  const documentVersion = editor.document.version;

  // 4. Get visible text, build prompt
  const originalText = editor.document.getText(range);
  const fileName = editor.document.fileName.split('/').pop() ?? 'unknown';
  const languageId = editor.document.languageId;
  const userPrompt = buildEditPrompt(originalText, languageId, fileName);

  logger.debug(
    `Suggest edit: ${fileName} | ${languageId} | lines ${startLine}-${endLine} | ${originalText.length} chars`,
  );
  logger.trace(`Suggest edit prompt:\n${userPrompt}`);

  // 5. Spawn claude with progress
  const startTime = Date.now();
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Bespoke AI: Suggesting edits...',
      cancellable: true,
    },
    (_progress, token) => {
      return new Promise<string | null>((resolve) => {
        const child = spawn(
          'claude',
          [
            '-p',
            '--output-format',
            'text',
            '--max-turns',
            '50',
            '--no-session-persistence',
            '--tools',
            '',
            '--system-prompt',
            SYSTEM_PROMPT,
          ],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );

        let stdout = '';
        let stderr = '';
        let settled = false;

        const settle = (value: string | null): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timeout);
          resolve(value);
        };

        child.stdout.on('data', (data: Buffer) => {
          stdout += data.toString();
        });

        child.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        child.stdin.on('error', () => {});

        const timeout = setTimeout(() => {
          child.kill();
          vscode.window.showWarningMessage('Bespoke AI: Suggest edits timed out.');
          logger.error('claude process timed out');
          settle(null);
        }, TIMEOUT_MS);

        token.onCancellationRequested(() => {
          child.kill();
          settle(null);
        });

        child.on('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'ENOENT') {
            vscode.window.showWarningMessage(
              'Bespoke AI: "claude" CLI not found. Install Claude Code and ensure it is in your PATH.',
            );
          } else {
            vscode.window.showWarningMessage(`Bespoke AI: Failed to spawn claude: ${err.message}`);
          }
          logger.error('Failed to spawn claude', err);
          settle(null);
        });

        child.on('close', (code) => {
          if (code !== 0 && code !== null) {
            logger.error(`claude exited with code ${code}: ${stderr}`);
            vscode.window.showWarningMessage(
              `Bespoke AI: claude exited with code ${code}. Check Output log for details.`,
            );
            settle(null);
            return;
          }
          settle(stdout);
        });

        child.stdin.write(userPrompt);
        child.stdin.end();
      });
    },
  );

  const durationMs = Date.now() - startTime;

  if (result === null) {
    return;
  }

  // Record in ledger
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
  const project = workspaceRoot ? path.basename(workspaceRoot) : '';
  ledger?.record({
    source: 'suggest-edit',
    model: 'claude-cli',
    project,
    durationMs,
    inputChars: userPrompt.length,
    outputChars: result.length,
  });

  logger.trace(`Suggest edit raw response:\n${result}`);

  // 6. Parse response
  const corrected = parseEditResponse(result);
  if (corrected === null) {
    vscode.window.showWarningMessage(
      'Bespoke AI: Could not parse edit response. Check Output log for details.',
    );
    logger.error('Failed to parse suggest-edit response');
    logger.trace(`Unparseable response:\n${result}`);
    return;
  }

  // 7. No changes needed?
  if (corrected === originalText) {
    vscode.window.showInformationMessage('Bespoke AI: No issues found.');
    logger.info('Suggest edit: no changes needed');
    return;
  }

  // 8. Show diff preview and ask for confirmation
  const key = `${fileName}-${Date.now()}`;
  contentStore.set(`original:${key}`, originalText);
  contentStore.set(`corrected:${key}`, corrected);

  const originalUri = vscode.Uri.parse(`bespoke-edit-original:${key}`);
  const correctedUri = vscode.Uri.parse(`bespoke-edit-corrected:${key}`);

  await vscode.commands.executeCommand(
    'vscode.diff',
    originalUri,
    correctedUri,
    `Suggest Edits — ${fileName}`,
  );

  const choice = await vscode.window.showInformationMessage(
    'Bespoke AI: Apply suggested edits?',
    'Apply',
    'Discard',
  );

  // Clean up virtual document content
  contentStore.delete(`original:${key}`);
  contentStore.delete(`corrected:${key}`);

  // Close the diff tab
  await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

  if (choice !== 'Apply') {
    logger.info('Suggest edit: discarded by user');
    return;
  }

  // 9. Staleness check
  if (editor.document.version !== documentVersion) {
    vscode.window.showWarningMessage('Bespoke AI: Document changed while editing — discarding.');
    logger.info('Suggest edit: discarded (document changed)');
    return;
  }

  // 10. Apply edit
  const edit = new vscode.WorkspaceEdit();
  edit.replace(editor.document.uri, range, corrected);
  await vscode.workspace.applyEdit(edit);

  vscode.window.setStatusBarMessage('Bespoke AI: Edits applied (Ctrl+Z to undo)', 4000);
  logger.info('Suggest edit: edits applied');
}
