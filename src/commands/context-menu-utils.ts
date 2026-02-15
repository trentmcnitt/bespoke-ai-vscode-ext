/** Escapes characters that are special inside double-quoted shell strings: \ " $ ` */
export function escapeForDoubleQuotes(input: string): string {
  return input.replace(/[\\"`$]/g, '\\$&');
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
  alternatives: (ctx: PromptContext) => {
    if (ctx.filePath && !ctx.unsaved) {
      return `Give me 3 alternative ways to phrase lines ${ctx.startLine}-${ctx.endLine} of \\\`${ctx.filePath}\\\`. ${READ_CONTEXT_INSTRUCTION}`;
    }
    const { hint, readFile } = inlineContext(ctx);
    return `Give me 3 alternative ways to phrase the following text${hint}.${readFile}\n\n${ctx.selectedText}`;
  },
  condense: (ctx: PromptContext) => {
    if (ctx.filePath && !ctx.unsaved) {
      return `Make lines ${ctx.startLine}-${ctx.endLine} of \\\`${ctx.filePath}\\\` more concise while preserving the meaning. ${READ_CONTEXT_INSTRUCTION}`;
    }
    const { hint, readFile } = inlineContext(ctx);
    return `Make the following text${hint} more concise while preserving the meaning.${readFile}\n\n${ctx.selectedText}`;
  },
  chat: (ctx: PromptContext, userQuestion: string) => {
    if (ctx.filePath && !ctx.unsaved) {
      return `Regarding lines ${ctx.startLine}-${ctx.endLine} of \\\`${ctx.filePath}\\\`: ${userQuestion}. ${READ_CONTEXT_INSTRUCTION}`;
    }
    const { hint, readFile } = inlineContext(ctx);
    return `Regarding the following text${hint}: ${userQuestion}.${readFile}\n\n${ctx.selectedText}`;
  },
  do: (ctx: PromptContext, instruction: string) => {
    if (ctx.filePath && !ctx.unsaved) {
      return `Apply the following to lines ${ctx.startLine}-${ctx.endLine} of \\\`${ctx.filePath}\\\`: ${instruction}. ${READ_CONTEXT_INSTRUCTION} Apply changes directly.`;
    }
    const { hint, readFile } = inlineContext(ctx);
    return `${instruction}\n\nHere is the text${hint}:${readFile}\n\n${ctx.selectedText}`;
  },
} as const;
