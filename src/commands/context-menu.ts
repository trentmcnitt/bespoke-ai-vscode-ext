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

/** Common instruction appended to all prompts: read the lines first, then context as needed. */
const READ_CONTEXT_INSTRUCTION =
  'Read those lines first, then read any other parts of the document (or other documents) as needed to understand the specified lines in context.';

/** Prompt templates for each command type. */
const PROMPT_TEMPLATES = {
  explain: (filePath: string, startLine: number, endLine: number) =>
    `Explain lines ${startLine}-${endLine} of \\\`${filePath}\\\`. ${READ_CONTEXT_INSTRUCTION}`,
  fix: (filePath: string, startLine: number, endLine: number) =>
    `Fix any issues in lines ${startLine}-${endLine} of \\\`${filePath}\\\`. ${READ_CONTEXT_INSTRUCTION} Apply fixes to those lines directly. If you notice related issues outside the selection, describe them but do not edit without asking.`,
  alternatives: (filePath: string, startLine: number, endLine: number) =>
    `Give me 3 alternative ways to phrase lines ${startLine}-${endLine} of \\\`${filePath}\\\`. ${READ_CONTEXT_INSTRUCTION}`,
  condense: (filePath: string, startLine: number, endLine: number) =>
    `Make lines ${startLine}-${endLine} of \\\`${filePath}\\\` more concise while preserving the meaning. ${READ_CONTEXT_INSTRUCTION}`,
  chat: (filePath: string, startLine: number, endLine: number) =>
    `I want to discuss lines ${startLine}-${endLine} of \\\`${filePath}\\\`. ${READ_CONTEXT_INSTRUCTION}`,
} as const;

/** Builds a Claude CLI command from a prompt. */
function buildClaudeCommand(prompt: string): string {
  return `claude --dangerously-skip-permissions "${prompt}"`;
}

// --- Handlers ---

export async function explainSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const prompt = PROMPT_TEMPLATES.explain(sel.filePath, sel.startLine, sel.endLine);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function fixSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const prompt = PROMPT_TEMPLATES.fix(sel.filePath, sel.startLine, sel.endLine);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function alternativesSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const prompt = PROMPT_TEMPLATES.alternatives(sel.filePath, sel.startLine, sel.endLine);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function condenseSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const prompt = PROMPT_TEMPLATES.condense(sel.filePath, sel.startLine, sel.endLine);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function chatSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const prompt = PROMPT_TEMPLATES.chat(sel.filePath, sel.startLine, sel.endLine);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}
