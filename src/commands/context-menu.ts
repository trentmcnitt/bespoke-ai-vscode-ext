import * as vscode from 'vscode';
import { escapeForDoubleQuotes, PROMPT_TEMPLATES } from './context-menu-utils';

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

/**
 * Shows an input box and returns the user's input.
 * Returns undefined if the user pressed Escape (cancel).
 * When required is true, empty input is rejected with a validation message.
 */
async function getUserInput(options: {
  prompt: string;
  placeholder: string;
  required: boolean;
}): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: options.prompt,
    placeHolder: options.placeholder,
    validateInput: options.required
      ? (value) => (value.trim() ? null : 'Please enter a message')
      : undefined,
  });
}

/** Builds a Claude CLI command from a prompt. */
function buildClaudeCommand(prompt: string): string {
  return `claude --dangerously-skip-permissions "${prompt}"`;
}

// --- Handlers ---

export async function explainSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const commentary = await getUserInput({
    prompt: 'Add context for Explain (optional)',
    placeholder: 'e.g., "focus on the error handling" — press Enter to skip',
    required: false,
  });
  if (commentary === undefined) return; // Escape pressed
  const escaped = commentary ? escapeForDoubleQuotes(commentary) : undefined;
  const prompt = PROMPT_TEMPLATES.explain(sel.filePath, sel.startLine, sel.endLine, escaped);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function fixSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const commentary = await getUserInput({
    prompt: 'Add context for Fix (optional)',
    placeholder: 'e.g., "the return type is wrong" — press Enter to skip',
    required: false,
  });
  if (commentary === undefined) return;
  const escaped = commentary ? escapeForDoubleQuotes(commentary) : undefined;
  const prompt = PROMPT_TEMPLATES.fix(sel.filePath, sel.startLine, sel.endLine, escaped);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function alternativesSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const commentary = await getUserInput({
    prompt: 'Add context for Alternatives (optional)',
    placeholder: 'e.g., "prefer functional style" — press Enter to skip',
    required: false,
  });
  if (commentary === undefined) return;
  const escaped = commentary ? escapeForDoubleQuotes(commentary) : undefined;
  const prompt = PROMPT_TEMPLATES.alternatives(sel.filePath, sel.startLine, sel.endLine, escaped);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function condenseSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const commentary = await getUserInput({
    prompt: 'Add context for Condense (optional)',
    placeholder: 'e.g., "keep the technical terms" — press Enter to skip',
    required: false,
  });
  if (commentary === undefined) return;
  const escaped = commentary ? escapeForDoubleQuotes(commentary) : undefined;
  const prompt = PROMPT_TEMPLATES.condense(sel.filePath, sel.startLine, sel.endLine, escaped);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function chatSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const userQuestion = await getUserInput({
    prompt: 'What would you like to discuss?',
    placeholder: 'Type your question about the selected lines...',
    required: true,
  });
  if (userQuestion === undefined) return; // Escape pressed
  const escaped = escapeForDoubleQuotes(userQuestion);
  const prompt = PROMPT_TEMPLATES.chat(sel.filePath, sel.startLine, sel.endLine, escaped);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}
