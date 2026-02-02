export const SYSTEM_PROMPT = `You are a precise file editor. Given file content, fix typos, grammar errors, and obvious bugs. Return the complete corrected text wrapped in <corrected> tags. Preserve all whitespace, indentation, and structure exactly. Do not restructure, reformat, or rephrase — only fix clear errors. If there are no issues, return the text unchanged in <corrected> tags.`;

/**
 * Build the user prompt for the suggest-edit command.
 * Wraps the text in <file_content> tags with metadata about the source.
 */
export function buildEditPrompt(text: string, languageId: string, fileName: string): string {
  return `<file_content language="${languageId}" name="${fileName}">\n${text}\n</file_content>`;
}

/**
 * Parse the stdout from `claude -p` to extract corrected text.
 * Looks for <corrected>...</corrected> tags first, then falls back
 * to stripping markdown code fences. Returns null on parse failure.
 */
export function parseEditResponse(stdout: string): string | null {
  // Try <corrected> tags first
  const tagMatch = stdout.match(/<corrected>([\s\S]*?)<\/corrected>/);
  if (tagMatch) {
    return tagMatch[1];
  }

  // Fallback: strip markdown code fences
  const trimmed = stdout.trim();
  const fenceMatch = trimmed.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    return fenceMatch[1];
  }

  return null;
}
