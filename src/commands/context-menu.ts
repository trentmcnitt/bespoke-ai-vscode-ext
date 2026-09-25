import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ExtensionConfig } from '../types';
import { resolveClaudeExecutable } from '../utils/claude-executable';
import {
  buildClaudeArgs,
  buildOpencodeArgs,
  pickDirectExecutable,
  PromptContext,
  PROMPT_TEMPLATES,
  stripControlChars,
} from './context-menu-utils';

/**
 * Picks the program and leading arguments that start Claude Code.
 *
 * The terminal runs the executable directly (no shell), so the path must be a real
 * binary: the native install or a native `claude` on PATH, else the bundled cli.js
 * run with `node`. On macOS/Linux a bare `claude` is a last resort if the SDK is
 * missing. Never on Windows, where it would resolve to the `claude.cmd` npm shim and
 * cmd.exe would re-parse the arguments.
 */
function claudeLaunch(): { shellPath: string; leadingArgs: string[] } | null {
  try {
    const exe = resolveClaudeExecutable();
    return exe.native
      ? { shellPath: exe.path, leadingArgs: [] }
      : { shellPath: 'node', leadingArgs: [exe.path] };
  } catch {
    return process.platform === 'win32' ? null : { shellPath: 'claude', leadingArgs: [] };
  }
}

/**
 * Locates an opencode executable the terminal can start directly: PATH first, then
 * the install script's default location (`~/.opencode/bin`).
 */
function findOpencode(): string | null {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  let candidates: string[] = [];
  try {
    candidates = execFileSync(lookup, ['opencode'], { encoding: 'utf8', timeout: 5_000 })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    // Not on PATH — fall through to the install-script location.
  }
  const binName = process.platform === 'win32' ? 'opencode.exe' : 'opencode';
  candidates.push(path.join(os.homedir(), '.opencode', 'bin', binName));
  return pickDirectExecutable(
    candidates.filter((c) => fs.existsSync(c)),
    process.platform,
  );
}

type AgentLaunch = { name: string; shellPath: string; shellArgs: string[] };

/**
 * Resolves what to run for the configured agent, or shows why it can't run.
 *
 * opencode loads `opencode.json`, `.opencode/` plugins, MCP servers, and provider
 * settings from the working directory with no trust prompt of its own (verified:
 * a repo's plugin code and MCP command run at startup). The terminal starts in the
 * workspace, so opencode is refused unless VS Code trusts the workspace. Claude
 * Code shows its own folder-trust dialog, so it needs no gate here.
 */
function resolveAgentLaunch(
  settings: ExtensionConfig['contextMenu'],
  prompt: string,
): AgentLaunch | null {
  if (settings.agent === 'opencode') {
    if (!vscode.workspace.isTrusted) {
      vscode.window
        .showWarningMessage(
          "Bespoke AI: opencode runs the project's own opencode config, plugins, and MCP servers without asking. Trust this workspace to use Explain, Fix, and Do with opencode.",
          'Manage Workspace Trust',
        )
        .then((choice) => {
          if (choice) vscode.commands.executeCommand('workbench.trust.manage');
        });
      return null;
    }
    const exe = findOpencode();
    if (!exe) {
      vscode.window.showErrorMessage(
        process.platform === 'win32'
          ? 'Bespoke AI: opencode.exe not found on PATH. The npm opencode.cmd shim is not used; install opencode with a native installer (e.g. scoop, choco, or the install script).'
          : 'Bespoke AI: opencode not found on PATH or in ~/.opencode/bin. Install opencode to use Explain, Fix, and Do with it.',
      );
      return null;
    }
    return { name: 'opencode', shellPath: exe, shellArgs: buildOpencodeArgs(prompt) };
  }

  const launch = claudeLaunch();
  if (!launch) {
    vscode.window.showErrorMessage(
      'Bespoke AI: Claude Code executable not found. Install Claude Code (native installer) to use Explain, Fix, and Do.',
    );
    return null;
  }
  return {
    name: 'Claude',
    shellPath: launch.shellPath,
    shellArgs: [...launch.leadingArgs, ...buildClaudeArgs(prompt, settings.permissionMode)],
  };
}

/**
 * Opens a terminal in ViewColumn.Two running the configured agent with the prompt.
 *
 * The prompt travels as an argv entry via `shellPath`/`shellArgs`. It is never typed
 * into a shell with `sendText()`, where a control character in a file name or
 * selection (e.g. Ctrl-C) could cancel the quoted string and run the remainder as a
 * command. The terminal closes when the agent session exits.
 */
async function openAgentTerminal(
  settings: ExtensionConfig['contextMenu'],
  prompt: string,
): Promise<vscode.Terminal | undefined> {
  const launch = resolveAgentLaunch(settings, prompt);
  if (!launch) return undefined;

  const terminal = vscode.window.createTerminal({
    ...launch,
    location: { viewColumn: vscode.ViewColumn.Two },
  });

  terminal.show(false);

  // Move to last tab position (alongside other agent terminals)
  await vscode.commands.executeCommand('moveActiveEditor', {
    to: 'last',
    by: 'tab',
  });

  return terminal;
}

/**
 * Gets selection info from the active editor.
 * Returns null if no editor or selection is empty.
 *
 * Three states:
 * - Clean saved file: filePath set, unsaved false — the agent reads and edits the file directly
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

/** Builds a PromptContext with control characters stripped from the text and path. */
function buildPromptContext(sel: {
  selectedText: string;
  filePath: string | null;
  startLine: number;
  endLine: number;
  unsaved: boolean;
}): PromptContext {
  return {
    selectedText: stripControlChars(sel.selectedText),
    filePath: sel.filePath ? stripControlChars(sel.filePath) : null,
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

// --- Handlers ---

export async function explainSelection(settings: ExtensionConfig['contextMenu']): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const ctx = buildPromptContext(sel);
  const prompt = PROMPT_TEMPLATES.explain(ctx);
  await openAgentTerminal(settings, prompt);
}

export async function fixSelection(settings: ExtensionConfig['contextMenu']): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const ctx = buildPromptContext(sel);
  const prompt = PROMPT_TEMPLATES.fix(ctx);
  await openAgentTerminal(settings, prompt);
}

export async function doSelection(settings: ExtensionConfig['contextMenu']): Promise<void> {
  const sel = getSelectionInfo();
  if (!sel) return;
  const instruction = await getUserInput({
    prompt: 'What do you want to do with this text?',
    placeholder: 'e.g., "convert to a bullet list", "make it more formal"',
    required: true,
  });
  if (instruction === undefined) return; // Escape pressed
  const ctx = buildPromptContext(sel);
  const prompt = PROMPT_TEMPLATES.do(ctx, stripControlChars(instruction));
  await openAgentTerminal(settings, prompt);
}
