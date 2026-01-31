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
 * Strip the current line fragment from the start of a completion when the
 * model echoes it. This happens with backends that lack assistant prefill
 * (e.g., Claude Code), producing doubled text like "- - item".
 *
 * The current line fragment is the text after the last newline in the prefix.
 * If the completion starts with that exact fragment, it's always a duplicate —
 * no legitimate continuation would repeat the entire line fragment.
 */
function trimPrefixOverlap(completion: string, prefix: string): string {
  const lastNewline = prefix.lastIndexOf('\n');
  const lineFragment = lastNewline >= 0 ? prefix.slice(lastNewline + 1) : prefix;

  // Skip if fragment is empty, whitespace-only, or too long.
  // The 150-char limit accommodates anchor echoes up to 120 chars
  // (extractAnchor maxLength default in claude-code.ts) with margin.
  if (!lineFragment || !lineFragment.trim() || lineFragment.length > 150) {
    return completion;
  }

  if (completion.startsWith(lineFragment)) {
    return completion.slice(lineFragment.length);
  }

  return completion;
}

/**
 * Post-processing pipeline for completion text from any provider.
 *
 * 1. Trim prefix overlap — if the completion's head duplicates the current line fragment.
 * 2. Trim suffix overlap — if the completion's tail duplicates the document's suffix.
 * 3. Return null for empty results so callers get a clean "no completion" signal.
 */
export function postProcessCompletion(text: string, prefix?: string, suffix?: string): string | null {
  let result = text;

  if (prefix) {
    result = trimPrefixOverlap(result, prefix);
  }

  if (suffix) {
    result = trimSuffixOverlap(result, suffix);
  }

  return result.trim() ? result : null;
}
