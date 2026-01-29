import { BuiltPrompt } from '../types';

/** Strip markdown code fences (```lang\n...\n```) from a completion. */
function stripMarkdownFences(text: string): string {
  const fenced = text.match(/^```\w*\n([\s\S]*?)```\s*$/);
  return fenced ? fenced[1].trimEnd() : text;
}

/**
 * Shared post-processing pipeline for completion text from any provider.
 *
 * 1. Strip markdown code fences the model may have wrapped around code.
 * 2. Strip leading newlines — ghost text should never start with blank lines.
 * 3. Enforce \n\n as a stop boundary (some backends ignore whitespace-only stops).
 * 4. Return null for empty results so callers get a clean "no completion" signal.
 */
export function postProcessCompletion(text: string, prompt: BuiltPrompt, prefix?: string): string | null {
  let result = stripMarkdownFences(text);

  result = result.replace(/^\n+/, '');

  // When the prefix ends with whitespace but the assistant prefill doesn't
  // (Anthropic rejects trailing whitespace in prefills), the model re-generates
  // the space. Strip it so the completion doesn't duplicate the trailing space.
  if (prefix && /\s$/.test(prefix) && prompt.assistantPrefill && !/\s$/.test(prompt.assistantPrefill)) {
    result = result.replace(/^\s+/, '');
  }

  if (prompt.stopSequences.includes('\n\n')) {
    const doubleNewline = result.indexOf('\n\n');
    if (doubleNewline >= 0) { result = result.slice(0, doubleNewline); }
  }

  return result || null;
}
