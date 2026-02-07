import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionConfig, ExpandResult } from '../types';
import { Logger } from '../utils/logger';
import { UsageLedger } from '../utils/usage-ledger';
import { PoolClient } from '../pool-server/client';
import { CompletionProvider } from '../completion-provider';
import { detectMode } from '../mode-detector';
import { buildExpandPrompt, parseSuggestions } from '../utils/expand-utils';
import { getWorkspaceRoot } from '../utils/workspace';

const TIMEOUT_MS = 90_000;

let inFlight = false;

export async function expandCommand(
  poolClient: PoolClient,
  completionProvider: CompletionProvider,
  config: ExtensionConfig,
  logger: Logger,
  ledger?: UsageLedger,
): Promise<void> {
  if (inFlight) {
    vscode.window.setStatusBarMessage('Bespoke AI: Expand request already in progress', 2000);
    return;
  }
  inFlight = true;
  try {
    await doExpand(poolClient, completionProvider, config, logger, ledger);
  } finally {
    inFlight = false;
  }
}

async function doExpand(
  poolClient: PoolClient,
  completionProvider: CompletionProvider,
  config: ExtensionConfig,
  logger: Logger,
  ledger?: UsageLedger,
): Promise<void> {
  logger.info('Expand command started');

  if (!poolClient.isCommandPoolAvailable()) {
    vscode.window.showWarningMessage('Bespoke AI: Command pool not ready. Try again in a moment.');
    return;
  }

  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage('Bespoke AI: No active editor.');
    return;
  }

  const hasSelection = !editor.selection.isEmpty;
  const mode = hasSelection ? 'expand' : 'continue';

  // Show optional guidance input box
  const guidance = await vscode.window.showInputBox({
    prompt:
      mode === 'continue'
        ? 'Guidance for continuation (optional)'
        : 'Guidance for expansion (optional)',
    placeHolder:
      mode === 'continue'
        ? 'e.g., "add error handling" — press Enter to skip'
        : 'e.g., "make more detailed" — press Enter to skip',
  });

  // Escape pressed → cancel
  if (guidance === undefined) {
    return;
  }

  // Gather context
  const document = editor.document;
  const completionMode = detectMode(document.languageId, config);
  const contextChars =
    completionMode === 'code' ? config.code.contextChars : config.prose.contextChars;
  const suffixChars =
    completionMode === 'code' ? config.code.suffixChars : config.prose.suffixChars;

  const fullText = document.getText();
  const fileName = path.basename(document.fileName);
  const languageId = document.languageId;

  let beforeText: string;
  let afterText: string;
  let selectedText: string | undefined;
  let range: ExpandResult['range'];

  if (mode === 'continue') {
    const cursorOffset = document.offsetAt(editor.selection.active);
    const prefixStart = Math.max(0, cursorOffset - contextChars);
    const suffixEnd = Math.min(fullText.length, cursorOffset + suffixChars);
    beforeText = fullText.slice(prefixStart, cursorOffset);
    afterText = fullText.slice(cursorOffset, suffixEnd);
    const pos = editor.selection.active;
    range = {
      startLine: pos.line,
      startCharacter: pos.character,
      endLine: pos.line,
      endCharacter: pos.character,
    };
  } else {
    const selStart = document.offsetAt(editor.selection.start);
    const selEnd = document.offsetAt(editor.selection.end);
    const prefixStart = Math.max(0, selStart - contextChars);
    const suffixEnd = Math.min(fullText.length, selEnd + suffixChars);
    beforeText = fullText.slice(prefixStart, selStart);
    selectedText = fullText.slice(selStart, selEnd);
    afterText = fullText.slice(selEnd, suffixEnd);
    range = {
      startLine: editor.selection.start.line,
      startCharacter: editor.selection.start.character,
      endLine: editor.selection.end.line,
      endCharacter: editor.selection.end.character,
    };
  }

  const prompt = buildExpandPrompt({
    mode,
    beforeText,
    afterText,
    selectedText,
    languageId,
    fileName,
    guidance: guidance || undefined,
  });

  logger.debug(
    `Expand: ${fileName} | ${languageId} | ${mode} | ${beforeText.length}+${afterText.length} chars${selectedText ? ` | sel=${selectedText.length}` : ''}${guidance ? ` | guidance="${guidance}"` : ''}`,
  );
  logger.trace(`Expand full prompt:\n${prompt}`);

  // Send to command pool with progress
  const startTime = Date.now();
  const { text, meta } = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Bespoke AI: Generating suggestions...',
      cancellable: true,
    },
    async (_progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());

      return poolClient.sendCommand(prompt, {
        timeoutMs: TIMEOUT_MS,
        onCancel: controller.signal,
      });
    },
  );

  const durationMs = Date.now() - startTime;

  if (text === null) {
    return;
  }

  // Record in usage ledger
  const workspaceRoot = getWorkspaceRoot();
  const project = workspaceRoot ? path.basename(workspaceRoot) : '';
  ledger?.record({
    source: 'expand',
    model: meta?.model || poolClient.getCurrentModel(),
    project,
    durationMs: meta?.durationMs ?? durationMs,
    durationApiMs: meta?.durationApiMs,
    inputTokens: meta?.inputTokens,
    outputTokens: meta?.outputTokens,
    cacheReadTokens: meta?.cacheReadTokens,
    cacheCreationTokens: meta?.cacheCreationTokens,
    costUsd: meta?.costUsd,
    inputChars: prompt.length,
    outputChars: text.length,
    sessionId: meta?.sessionId,
  });

  logger.trace(`Expand raw response:\n${text}`);

  // Parse suggestions
  const suggestions = parseSuggestions(text);
  if (suggestions.length === 0) {
    vscode.window.showWarningMessage(
      'Bespoke AI: Could not parse suggestions. Check Output log for details.',
    );
    logger.error('Failed to parse expand response');
    logger.trace(`Unparseable response:\n${text}`);
    return;
  }

  logger.debug(`Expand: ${suggestions.length} suggestion(s) parsed in ${durationMs}ms`);

  // Inject into CompletionProvider and trigger inline suggest
  const expandResult: ExpandResult = { suggestions, range };
  completionProvider.setExpandResult(expandResult);
  await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
}
