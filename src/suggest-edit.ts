import * as path from 'path';
import * as vscode from 'vscode';
import { Logger } from './utils/logger';
import { UsageLedger } from './utils/usage-ledger';
import { PoolClient } from './pool-server/client';
import { buildFullEditPrompt, parseEditResponse } from './utils/suggest-edit-utils';
import { getWorkspaceRoot } from './utils/workspace';

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

export async function suggestEdit(
  poolClient: PoolClient,
  logger: Logger,
  ledger?: UsageLedger,
): Promise<void> {
  if (inFlight) {
    vscode.window.setStatusBarMessage('Bespoke AI: Request already in progress', 2000);
    return;
  }
  inFlight = true;
  try {
    await doSuggestEdit(poolClient, logger, ledger);
  } finally {
    inFlight = false;
  }
}

async function doSuggestEdit(
  poolClient: PoolClient,
  logger: Logger,
  ledger?: UsageLedger,
): Promise<void> {
  logger.info('Suggest edit started');

  // Check pool availability
  if (!poolClient.isCommandPoolAvailable()) {
    vscode.window.showWarningMessage('Bespoke AI: Command pool not ready. Try again in a moment.');
    return;
  }

  // 1. Get active editor
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Bespoke AI: No active editor.');
    return;
  }

  // 2. Determine target range: selection if present, otherwise visible ranges
  let range: vscode.Range;
  const hasSelection = !editor.selection.isEmpty;

  if (hasSelection) {
    // Use the selection as-is (not expanded to full lines)
    range = editor.selection;
  } else {
    // Fall back to visible ranges → merge into single range (full lines)
    const visibleRanges = editor.visibleRanges;
    if (visibleRanges.length === 0) {
      return;
    }
    const startLine = visibleRanges[0].start.line;
    const endLine = visibleRanges[visibleRanges.length - 1].end.line;
    range = new vscode.Range(
      new vscode.Position(startLine, 0),
      editor.document.lineAt(endLine).range.end,
    );
  }

  // 3. Store version for staleness check
  const documentVersion = editor.document.version;

  // 4. Get visible text, build full prompt
  const originalText = editor.document.getText(range);
  const fileName = path.basename(editor.document.fileName);
  const languageId = editor.document.languageId;
  const fullMessage = buildFullEditPrompt(originalText, languageId, fileName);

  const modeLabel = hasSelection ? 'selection' : 'visible';
  const startLine = range.start.line;
  const endLine = range.end.line;
  logger.debug(
    `Suggest edit: ${fileName} | ${languageId} | ${modeLabel} | lines ${startLine}-${endLine} | ${originalText.length} chars`,
  );
  logger.trace(`Suggest edit full prompt:\n${fullMessage}`);

  // 5. Send to command pool with progress
  const startTime = Date.now();
  const { text, meta } = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Bespoke AI: Suggesting edits...',
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      return poolClient.sendCommand(fullMessage, {
        timeoutMs: TIMEOUT_MS,
        onCancel: controller.signal,
      });
    },
  );

  const durationMs = Date.now() - startTime;

  if (text === null) {
    return;
  }

  // Record in ledger with SDK metadata when available
  const workspaceRoot = getWorkspaceRoot();
  const project = workspaceRoot ? path.basename(workspaceRoot) : '';
  ledger?.record({
    source: 'suggest-edit',
    model: meta?.model || poolClient.getCurrentModel(),
    project,
    durationMs: meta?.durationMs ?? durationMs,
    durationApiMs: meta?.durationApiMs,
    inputTokens: meta?.inputTokens,
    outputTokens: meta?.outputTokens,
    cacheReadTokens: meta?.cacheReadTokens,
    cacheCreationTokens: meta?.cacheCreationTokens,
    costUsd: meta?.costUsd,
    inputChars: fullMessage.length,
    outputChars: text.length,
    sessionId: meta?.sessionId,
  });

  logger.trace(`Suggest edit raw response:\n${text}`);

  // 6. Parse response
  const corrected = parseEditResponse(text);
  if (corrected === null) {
    vscode.window.showWarningMessage(
      'Bespoke AI: Could not parse edit response. Check Output log for details.',
    );
    logger.error('Failed to parse suggest-edit response');
    logger.trace(`Unparseable response:\n${text}`);
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

  let choice: string | undefined;
  try {
    await vscode.commands.executeCommand(
      'vscode.diff',
      originalUri,
      correctedUri,
      `Suggest Edits — ${fileName}`,
    );

    choice = await vscode.window.showInformationMessage(
      'Bespoke AI: Apply suggested edits?',
      'Apply',
      'Discard',
    );
  } finally {
    // Close the diff tab before cleaning up virtual document content,
    // so VS Code doesn't re-request content from empty providers.
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    contentStore.delete(`original:${key}`);
    contentStore.delete(`corrected:${key}`);
  }

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
