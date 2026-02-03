import * as vscode from 'vscode';

/**
 * Opens a terminal in ViewColumn.Two and sends a Claude CLI command.
 */
async function openClaudeTerminal(command: string): Promise<vscode.Terminal> {
  const terminal = vscode.window.createTerminal({
    location: { viewColumn: vscode.ViewColumn.Two },
  });

  terminal.show(false);

  // Move to last tab position (alongside other Claude terminals)
  await vscode.commands.executeCommand('moveActiveEditor', {
    to: 'last',
    by: 'tab',
  });

  // Brief delay to ensure terminal is ready
  await new Promise((resolve) => setTimeout(resolve, 100));

  terminal.sendText(command);
  return terminal;
}

/**
 * Gets selection info from the active editor.
 * Returns null if no editor or selection is empty.
 */
function getSelectionInfo(): { filePath: string; startLine: number; endLine: number } | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return null;
  }

  const filePath = editor.document.uri.fsPath;
  const startLine = editor.selection.start.line + 1; // 1-indexed
  // If selection ends at column 0, the user didn't select content on that line
  const endLine =
    editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line
      ? editor.selection.end.line
      : editor.selection.end.line + 1;

  return { filePath, startLine, endLine };
}

// --- Command builders ---
// All use escaped backticks (\`) for markdown formatting in the prompt.
// The \\\` in template literals produces \` in output, which shells interpret as literal backticks.

function buildExplainCommand(filePath: string, startLine: number, endLine: number): string {
  return `claude --dangerously-skip-permissions "Explain lines ${startLine}-${endLine} of \\\`${filePath}\\\`. Read those lines first, then read any other parts of the document (or other documents) as needed to understand the specified lines in context."`;
}

function buildFixCommand(filePath: string, startLine: number, endLine: number): string {
  const prompt = `Fix any issues in lines ${startLine}-${endLine} of \\\`${filePath}\\\`. Read those lines first, then read any other parts of the document (or other documents) as needed to understand the specified lines in context. Apply fixes to those lines directly. If you notice related issues outside the selection, describe them but do not edit without asking.`;
  return `claude --dangerously-skip-permissions "${prompt}"`;
}

function buildAlternativesCommand(filePath: string, startLine: number, endLine: number): string {
  return `claude --dangerously-skip-permissions "Give me 3 alternative ways to phrase lines ${startLine}-${endLine} of \\\`${filePath}\\\`. Read those lines first, then read any other parts of the document (or other documents) as needed to understand the specified lines in context."`;
}

function buildCondenseCommand(filePath: string, startLine: number, endLine: number): string {
  return `claude --dangerously-skip-permissions "Make lines ${startLine}-${endLine} of \\\`${filePath}\\\` more concise while preserving the meaning. Read those lines first, then read any other parts of the document (or other documents) as needed to understand the specified lines in context."`;
}

function buildChatCommand(filePath: string, startLine: number, endLine: number): string {
  return `claude --dangerously-skip-permissions "I want to discuss lines ${startLine}-${endLine} of \\\`${filePath}\\\`. Read those lines first, then read any other parts of the document (or other documents) as needed to understand the specified lines in context."`;
}

// --- Handlers ---

export async function explainSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  await openClaudeTerminal(buildExplainCommand(sel.filePath, sel.startLine, sel.endLine));
}

export async function fixSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  await openClaudeTerminal(buildFixCommand(sel.filePath, sel.startLine, sel.endLine));
}

export async function alternativesSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  await openClaudeTerminal(buildAlternativesCommand(sel.filePath, sel.startLine, sel.endLine));
}

export async function condenseSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  await openClaudeTerminal(buildCondenseCommand(sel.filePath, sel.startLine, sel.endLine));
}

export async function chatSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  await openClaudeTerminal(buildChatCommand(sel.filePath, sel.startLine, sel.endLine));
}
