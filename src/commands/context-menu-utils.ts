/**
 * Escapes characters that are special inside double-quoted shell strings: \ " $ ` !
 *
 * Note: This uses bash/zsh escaping rules. On Windows with PowerShell or cmd.exe,
 * these escapes may not be correct. Context menu commands work best when the VS Code
 * terminal is configured to use a bash-compatible shell (Git Bash, WSL, or similar).
 *
 * Note: newlines are not escaped — they become literal newlines inside a
 * double-quoted bash/zsh string (continuation mode, not command separators).
 * This is injection-safe, but multi-line selections may produce unexpected
 * terminal behavior since vscode.Terminal.sendText() sends each \n as a
 * simulated keypress.
 */
export function escapeForDoubleQuotes(input: string): string {
  return input.replace(/[\\"`$!]/g, '\\$&');
}

/** Context passed to prompt templates. */
export interface PromptContext {
  /** Selected text (already escaped for shell embedding). */
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
      hint: ` from \\\`${ctx.filePath}\\\`, lines ${ctx.startLine}-${ctx.endLine} (file has unsaved changes)`,
      readFile: ` You can read \\\`${ctx.filePath}\\\` for surrounding context.`,
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
      return `Explain lines ${ctx.startLine}-${ctx.endLine} of \\\`${ctx.filePath}\\\`. ${READ_CONTEXT_INSTRUCTION}`;
    }
    const { hint, readFile } = inlineContext(ctx);
    return `Explain the following text${hint}.${readFile}\n\n${ctx.selectedText}`;
  },
  fix: (ctx: PromptContext) => {
    if (ctx.filePath && !ctx.unsaved) {
      return `Fix any issues in lines ${ctx.startLine}-${ctx.endLine} of \\\`${ctx.filePath}\\\`. ${READ_CONTEXT_INSTRUCTION} Apply fixes to those lines directly. If you notice related issues outside the selection, describe them but do not edit without asking.`;
    }
    const { hint, readFile } = inlineContext(ctx);
    return `Fix any issues in the following text${hint}. Show the corrected version.${readFile}\n\n${ctx.selectedText}`;
  },
  do: (ctx: PromptContext, instruction: string) => {
    if (ctx.filePath && !ctx.unsaved) {
      return `Apply the following to lines ${ctx.startLine}-${ctx.endLine} of \\\`${ctx.filePath}\\\`: ${instruction}. ${READ_CONTEXT_INSTRUCTION} Apply changes directly.`;
    }
    const { hint, readFile } = inlineContext(ctx);
    return `${instruction}\n\nHere is the text${hint}:${readFile}\n\n${ctx.selectedText}`;
  },
} as const;
