import { PermissionMode } from '../types';

/**
 * Removes C0/C1 control characters (keeping tab and newline) and Unicode bidi
 * overrides from text that goes into the prompt.
 *
 * The prompt is passed as an argument, not typed into a shell, so these can no
 * longer break out of anything. Stripping them keeps a crafted file name or
 * selection from putting terminal escape sequences or misleading bidi-reordered
 * text into the agent's displayed prompt.
 */
export function stripControlChars(input: string): string {
  return input.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/g, '');
}

/** Context passed to prompt templates. */
export interface PromptContext {
  /** Selected text (control characters already stripped). */
  selectedText: string;
  /** File path, or null for untitled buffers. */
  filePath: string | null;
  startLine: number;
  endLine: number;
  /** True when editor content may differ from disk (dirty or untitled). */
  unsaved: boolean;
}

/** Common instruction appended to file-based prompts: read the lines first, then context as needed. */
const READ_CONTEXT_INSTRUCTION =
  'Read those lines first, then read any other parts of the document (or other documents) as needed to understand the specified lines in context.';

/**
 * Builds context strings for inline-text prompts (dirty saved or untitled).
 * - hint: describes where the text came from (file+lines or just lines)
 * - readFile: suggests reading the file for context (only when a file exists)
 */
function inlineContext(ctx: PromptContext): { hint: string; readFile: string } {
  if (ctx.filePath) {
    return {
      hint: ` from \`${ctx.filePath}\`, lines ${ctx.startLine}-${ctx.endLine} (file has unsaved changes)`,
      readFile: ` You can read \`${ctx.filePath}\` for surrounding context.`,
    };
  }
  return {
    hint: ` (lines ${ctx.startLine}-${ctx.endLine})`,
    readFile: '',
  };
}

/** Prompt templates for each command type. */
export const PROMPT_TEMPLATES = {
  explain: (ctx: PromptContext) => {
    if (ctx.filePath && !ctx.unsaved) {
      return `Explain lines ${ctx.startLine}-${ctx.endLine} of \`${ctx.filePath}\`. ${READ_CONTEXT_INSTRUCTION}`;
    }
    const { hint, readFile } = inlineContext(ctx);
    return `Explain the following text${hint}.${readFile}\n\n${ctx.selectedText}`;
  },
  fix: (ctx: PromptContext) => {
    if (ctx.filePath && !ctx.unsaved) {
      return `Fix any issues in lines ${ctx.startLine}-${ctx.endLine} of \`${ctx.filePath}\`. ${READ_CONTEXT_INSTRUCTION} Apply fixes to those lines directly. If you notice related issues outside the selection, describe them but do not edit without asking.`;
    }
    const { hint, readFile } = inlineContext(ctx);
    return `Fix any issues in the following text${hint}. Show the corrected version.${readFile}\n\n${ctx.selectedText}`;
  },
  do: (ctx: PromptContext, instruction: string) => {
    if (ctx.filePath && !ctx.unsaved) {
      return `Apply the following to lines ${ctx.startLine}-${ctx.endLine} of \`${ctx.filePath}\`: ${instruction}. ${READ_CONTEXT_INSTRUCTION} Apply changes directly.`;
    }
    const { hint, readFile } = inlineContext(ctx);
    return `${instruction}\n\nHere is the text${hint}:${readFile}\n\n${ctx.selectedText}`;
  },
} as const;

/**
 * CLI arguments for each permission mode.
 *
 * A lookup table rather than anything derived from the setting's text: VS Code does
 * not enforce a setting's declared `enum` at read time — `getConfiguration().get()`
 * returns whatever string is in settings.json — so only these fixed argument lists
 * can ever reach the CLI.
 */
export const PERMISSION_MODE_ARGS: Record<PermissionMode, readonly string[]> = {
  default: [],
  acceptEdits: ['--permission-mode', 'acceptEdits'],
  bypassPermissions: ['--dangerously-skip-permissions'],
};

/**
 * Builds the Claude CLI argument list for a prompt.
 *
 * The prompt is a single argv entry after `--`, so nothing in it (file names,
 * selected text, the Do instruction) is ever parsed by a shell or read as a flag.
 */
export function buildClaudeArgs(prompt: string, permissionMode: PermissionMode): string[] {
  return [...(PERMISSION_MODE_ARGS[permissionMode] ?? []), '--', prompt];
}

/**
 * Builds the opencode argument list for a prompt.
 *
 * `--prompt=` opens the TUI with the prompt already submitted. opencode's positional
 * argument is a project directory, not a message, so the prompt must never go there.
 * The `=` form keeps the whole prompt one value even when it starts with `-`.
 *
 * `permissionMode` is deliberately not mapped. opencode's `OPENCODE_PERMISSION`
 * override replaces the user's own per-tool rules key by key, so pushing e.g.
 * `bash: ask` would loosen a user who configured `bash: deny`. The user's opencode
 * config governs instead.
 */
export function buildOpencodeArgs(prompt: string): string[] {
  return [`--prompt=${prompt}`];
}

/**
 * Picks the first `where`/`which opencode` result the terminal can start directly.
 *
 * On Windows only `.exe`/`.com` qualify: npm installs an `opencode.cmd` shim, and
 * running a `.cmd` goes through cmd.exe, which re-parses the arguments — the prompt
 * would be exposed to shell parsing again.
 */
export function pickDirectExecutable(
  candidates: string[],
  platform: NodeJS.Platform,
): string | null {
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    if (platform !== 'win32' || lower.endsWith('.exe') || lower.endsWith('.com')) {
      return candidate;
    }
  }
  return null;
}
