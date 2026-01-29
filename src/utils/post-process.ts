import { BuiltPrompt } from '../types';

/** Strip markdown code fences (```lang\n...\n```) from a completion. */
function stripMarkdownFences(text: string): string {
  const fenced = text.match(/^```\w*\n([\s\S]*?)```\s*$/);
  return fenced ? fenced[1].trimEnd() : text;
}

/**
 * Trim suffix overlap from a completion. If the completion's tail duplicates
 * the beginning of the suffix, return the completion truncated before the
 * overlap. Uses whitespace-normalized comparison (min 10 chars to avoid
 * false positives on common short phrases).
 */
function trimSuffixOverlap(completion: string, suffix: string): string {
  if (!suffix) { return completion; }

  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const normSuffix = norm(suffix);
  if (!normSuffix) { return completion; }

  // Try cutting the completion at each sentence/clause boundary and check
  // if the remainder matches the start of the suffix.
  // We scan from the end of the completion backwards, looking for a point
  // where completion[cutPoint:] normalized matches normSuffix[0:matchLen].
  const normCompletion = norm(completion);
  const minOverlap = 10;
  const maxCheck = Math.min(normCompletion.length, normSuffix.length);

  // Find the longest suffix of normCompletion that equals a prefix of normSuffix
  let bestNormLen = 0;
  for (let len = minOverlap; len <= maxCheck; len++) {
    if (normCompletion.slice(-len) === normSuffix.slice(0, len)) {
      bestNormLen = len;
    }
  }

  if (bestNormLen === 0) { return completion; }

  // Find where in the original completion the overlapping text starts.
  // The overlapping normalized text is normCompletion.slice(-bestNormLen).
  // Count non-whitespace + whitespace-boundary chars from the end of the
  // original completion to find the cut point.
  const overlapText = normCompletion.slice(-bestNormLen);
  let oi = overlapText.length - 1; // index into overlap text (from end)
  let ci = completion.length - 1;  // index into original completion (from end)

  while (oi >= 0 && ci >= 0) {
    if (/\s/.test(overlapText[oi])) {
      // Skip whitespace in original
      while (ci >= 0 && /\s/.test(completion[ci])) { ci--; }
      oi--;
    } else {
      // Must match non-whitespace char
      if (completion[ci] === overlapText[oi]) {
        ci--;
        oi--;
      } else {
        break; // mismatch — shouldn't happen but be safe
      }
    }
  }

  // ci+1 is where the overlap starts in the original string
  const cutPoint = ci + 1;
  return completion.slice(0, cutPoint).trimEnd();
}

/**
 * Shared post-processing pipeline for completion text from any provider.
 *
 * 1. Strip markdown code fences the model may have wrapped around code.
 * 2. Strip leading newlines — ghost text should never start with blank lines.
 * 3. Enforce \n\n as a stop boundary (some backends ignore whitespace-only stops).
 * 4. Trim suffix overlap — if the completion's tail duplicates the document's suffix.
 * 5. Return null for empty results so callers get a clean "no completion" signal.
 */
export function postProcessCompletion(text: string, prompt: BuiltPrompt, prefix?: string, suffix?: string): string | null {
  let result = stripMarkdownFences(text);

  result = result.replace(/^\n+/, '');

  // When the prefix ends with whitespace but the assistant prefill doesn't
  // (Anthropic rejects trailing whitespace in prefills), the model re-generates
  // the space. Strip it so the completion doesn't duplicate the trailing space.
  if (prefix && /\s$/.test(prefix) && prompt.assistantPrefill && !/\s$/.test(prompt.assistantPrefill)) {
    result = result.replace(/^\s+/, '');
  }

  // Strip leading character if it duplicates the last character of the prefix.
  // This handles cases where the model echoes a boundary character (e.g., an
  // opening quote mark) that is already present at the end of the prefix.
  if (prefix && result.length > 0 && prefix.length > 0 && result[0] === prefix[prefix.length - 1]) {
    // Only strip punctuation/quote characters to avoid false positives on letters
    if (/["""''`([\-—]/.test(result[0])) {
      result = result.slice(1);
    }
  }

  if (prompt.stopSequences.includes('\n\n')) {
    const doubleNewline = result.indexOf('\n\n');
    if (doubleNewline >= 0) { result = result.slice(0, doubleNewline); }
  }

  // Trim suffix overlap: if the completion ends with text that duplicates
  // the beginning of the document's suffix, truncate to avoid duplication.
  if (suffix) {
    result = trimSuffixOverlap(result, suffix);
  }

  return result || null;
}
