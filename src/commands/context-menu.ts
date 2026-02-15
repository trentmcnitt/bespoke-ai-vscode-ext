import * as vscode from 'vscode';
import { escapeForDoubleQuotes, PromptContext, PROMPT_TEMPLATES } from './context-menu-utils';

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
 *
 * Three states:
 * - Clean saved file: filePath set, unsaved false — Claude reads and edits the file directly
 * - Dirty saved file: filePath set, unsaved true — text embedded in prompt, file available for context
 * - Untitled buffer: filePath null, unsaved true — text embedded, no file to reference
 */
function getSelectionInfo(): {
  selectedText: string;
  filePath: string | null;
  startLine: number;
  endLine: number;
  unsaved: boolean;
} | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return null;
  }

  const selectedText = editor.document.getText(editor.selection);
  const isUntitled = editor.document.isUntitled;
  const filePath = isUntitled ? null : editor.document.uri.fsPath;
  const unsaved = isUntitled || editor.document.isDirty;
  const startLine = editor.selection.start.line + 1; // 1-indexed
  // If selection ends at column 0, the user didn't select content on that line
  const endLine =
    editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line
      ? editor.selection.end.line
      : editor.selection.end.line + 1;

  return { selectedText, filePath, startLine, endLine, unsaved };
}

/** Builds a PromptContext with the selected text escaped for shell embedding. */
function buildPromptContext(sel: {
  selectedText: string;
  filePath: string | null;
  startLine: number;
  endLine: number;
  unsaved: boolean;
}): PromptContext {
  return {
    selectedText: escapeForDoubleQuotes(sel.selectedText),
    filePath: sel.filePath ? escapeForDoubleQuotes(sel.filePath) : null,
    startLine: sel.startLine,
    endLine: sel.endLine,
    unsaved: sel.unsaved,
  };
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
  const ctx = buildPromptContext(sel);
  const prompt = PROMPT_TEMPLATES.explain(ctx);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function fixSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const ctx = buildPromptContext(sel);
  const prompt = PROMPT_TEMPLATES.fix(ctx);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function alternativesSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const ctx = buildPromptContext(sel);
  const prompt = PROMPT_TEMPLATES.alternatives(ctx);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function condenseSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const ctx = buildPromptContext(sel);
  const prompt = PROMPT_TEMPLATES.condense(ctx);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function chatSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const userQuestion = await getUserInput({
    prompt: 'What would you like to discuss?',
    placeholder: 'Type your question about the selected text...',
    required: true,
  });
  if (userQuestion === undefined) return; // Escape pressed
  const ctx = buildPromptContext(sel);
  const escaped = escapeForDoubleQuotes(userQuestion);
  const prompt = PROMPT_TEMPLATES.chat(ctx, escaped);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}

export async function doSelection(): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const instruction = await getUserInput({
    prompt: 'What do you want to do with this text?',
    placeholder: 'e.g., "convert to a bullet list", "make it more formal"',
    required: true,
  });
  if (instruction === undefined) return; // Escape pressed
  const ctx = buildPromptContext(sel);
  const escaped = escapeForDoubleQuotes(instruction);
  const prompt = PROMPT_TEMPLATES.do(ctx, escaped);
  await openClaudeTerminal(buildClaudeCommand(prompt));
}
