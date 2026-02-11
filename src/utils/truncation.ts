/**
 * Pure truncation functions for prefix and suffix text.
 *
 * These are extracted from buildDocumentContext() so they can be reused
 * in the quality test runner without depending on the vscode module.
 */

/**
 * Truncate prefix text to at most `maxChars` characters from the end,
 * snapping forward to the next newline boundary if the cut lands mid-line.
 *
 * If the text fits within maxChars, it is returned unchanged.
 */
export function truncatePrefix(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  let start = text.length - maxChars;
  // Snap to line boundary: if we cut mid-line, move forward to the next
  // newline so the model always sees complete lines. Skip if already at
  // a line boundary (offset 0 or preceded by \n).
  if (start > 0 && text[start - 1] !== '\n') {
    const nextNewline = text.indexOf('\n', start);
    if (nextNewline !== -1 && nextNewline < text.length) {
      start = nextNewline + 1;
    }
  }
  return text.slice(start);
}

/**
 * Truncate suffix text to at most `maxChars` characters from the start,
 * snapping back to the last whitespace if the cut lands mid-word.
 *
 * If the text fits within maxChars, it is returned unchanged.
 */
export function truncateSuffix(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  let suffix = text.slice(0, maxChars);

  // Snap to word boundary: if we cut mid-word at the end, trim back to the
  // last whitespace so the model doesn't try to complete a truncated word.
  const nextChar = text[maxChars];
  if (nextChar && !/\s/.test(nextChar)) {
    // Find the last whitespace in the suffix and trim there
    const lastWhitespace = suffix.search(/\s[^\s]*$/);
    if (lastWhitespace !== -1) {
      suffix = suffix.slice(0, lastWhitespace + 1);
    }
  }

  return suffix;
}
