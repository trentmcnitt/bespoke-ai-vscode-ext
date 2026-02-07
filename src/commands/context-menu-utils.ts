/** Escapes characters that are special inside double-quoted shell strings: \ " $ ` */
export function escapeForDoubleQuotes(input: string): string {
  return input.replace(/[\\"`$]/g, '\\$&');
}

/** Common instruction appended to all prompts: read the lines first, then context as needed. */
const READ_CONTEXT_INSTRUCTION =
  'Read those lines first, then read any other parts of the document (or other documents) as needed to understand the specified lines in context.';

/** Prompt templates for each command type. */
export const PROMPT_TEMPLATES = {
  explain: (filePath: string, startLine: number, endLine: number, commentary?: string) => {
    const base = `Explain lines ${startLine}-${endLine} of \\\`${filePath}\\\`. ${READ_CONTEXT_INSTRUCTION}`;
    return commentary ? `${base} Note: ${commentary}` : base;
  },
  fix: (filePath: string, startLine: number, endLine: number, commentary?: string) => {
    const base = `Fix any issues in lines ${startLine}-${endLine} of \\\`${filePath}\\\`. ${READ_CONTEXT_INSTRUCTION} Apply fixes to those lines directly. If you notice related issues outside the selection, describe them but do not edit without asking.`;
    return commentary ? `${base} Note: ${commentary}` : base;
  },
  alternatives: (filePath: string, startLine: number, endLine: number, commentary?: string) => {
    const base = `Give me 3 alternative ways to phrase lines ${startLine}-${endLine} of \\\`${filePath}\\\`. ${READ_CONTEXT_INSTRUCTION}`;
    return commentary ? `${base} Note: ${commentary}` : base;
  },
  condense: (filePath: string, startLine: number, endLine: number, commentary?: string) => {
    const base = `Make lines ${startLine}-${endLine} of \\\`${filePath}\\\` more concise while preserving the meaning. ${READ_CONTEXT_INSTRUCTION}`;
    return commentary ? `${base} Note: ${commentary}` : base;
  },
  chat: (filePath: string, startLine: number, endLine: number, userQuestion: string) =>
    `Regarding lines ${startLine}-${endLine} of \\\`${filePath}\\\`: ${userQuestion}. ${READ_CONTEXT_INSTRUCTION}`,
} as const;
