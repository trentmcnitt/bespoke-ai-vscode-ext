const CLOSER_TO_OPENER: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/**
 * True when some closing bracket in `overlap` closes an opening bracket that
 * appears in `kept` (the part of the completion that would survive the trim).
 * Such a closer belongs to a scope the model opened itself, so it is not a
 * duplicate of the suffix — trimming it would leave that scope unclosed.
 *
 * Closers that find no open bracket from `kept` close scopes opened in the
 * prefix; those are the genuine duplicates the trim exists to remove. Brackets
 * inside string literals / regexes are not lexed; a miscount there can only
 * make a trim length look unsafe (so less gets trimmed), never more.
 */
function overlapClosesOwnScope(kept: string, overlap: string): boolean {
  // Each entry: the opener char and whether it came from `kept`.
  const stack: { ch: string; fromKept: boolean }[] = [];
  const scan = (text: string, fromKept: boolean): boolean => {
    for (const ch of text) {
      if (ch === '(' || ch === '[' || ch === '{') {
        stack.push({ ch, fromKept });
      } else if (ch in CLOSER_TO_OPENER) {
        const top = stack[stack.length - 1];
        if (!top || top.ch !== CLOSER_TO_OPENER[ch]) {
          continue; // closes a scope outside the completion
        }
        if (!fromKept && top.fromKept) {
          return true;
        }
        stack.pop();
      }
    }
    return false;
  };
  scan(kept, true);
  return scan(overlap, false);
}

/**
 * Trim suffix overlap from a completion. If the completion's tail duplicates
 * the beginning of the suffix, return the completion truncated before the
 * overlap. Uses whitespace-normalized comparison (min 10 chars in prose to
 * avoid false positives on common short phrases; min 1 char in code so a
 * duplicated closing delimiter such as `]`, `}` or `"` is caught).
 *
 * Code-mode bracket guard: a 1-char match is also hit when the completion
 * ends with a closer that closes a scope the completion itself opened
 * (e.g. prefix `.filter(x => `, completion `x.ok()`, suffix `)` — the model's
 * `)` closes its own `ok(`, not the suffix's). Trimming it leaves the model's
 * scope unclosed and the inserted code invalid. So in code mode a candidate
 * overlap length is rejected when any closer inside it closes an opener from
 * the kept part of the completion (see overlapClosesOwnScope), and the next
 * shorter matching length is tried. Safe because it only ever chooses an
 * equal or shorter trim than the plain longest match — it never trims more.
 * Preconditions: code mode, and the overlap contains a bracket closer that
 * matches an unclosed opener in the completion; otherwise it is a no-op.
 */
function trimSuffixOverlap(completion: string, suffix: string, mode?: 'prose' | 'code'): string {
  if (!suffix) {
    return completion;
  }

  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const normSuffix = norm(suffix);
  if (!normSuffix) {
    return completion;
  }

  // Try cutting the completion at each sentence/clause boundary and check
  // if the remainder matches the start of the suffix.
  // We scan from the end of the completion backwards, looking for a point
  // where completion[cutPoint:] normalized matches normSuffix[0:matchLen].
  const normCompletion = norm(completion);
  // Code mode: min 1 char — closing delimiters (], }, `, ", etc.) are always duplicates.
  // Prose mode: min 10 chars — avoids false positives on common short phrases.
  const minOverlap = mode === 'code' ? 1 : 10;
  const maxCheck = Math.min(normCompletion.length, normSuffix.length);

  // Find the longest suffix of normCompletion that equals a prefix of normSuffix
  // (in code mode, skipping lengths whose overlap closes the completion's own
  // brackets — see the bracket guard in the doc comment above).
  let bestNormLen = 0;
  for (let len = maxCheck; len >= minOverlap; len--) {
    if (normCompletion.slice(-len) !== normSuffix.slice(0, len)) {
      continue;
    }
    if (
      mode === 'code' &&
      overlapClosesOwnScope(normCompletion.slice(0, -len), normCompletion.slice(-len))
    ) {
      continue;
    }
    bestNormLen = len;
    break;
  }

  if (bestNormLen === 0) {
    return completion;
  }

  // Find where in the original completion the overlapping text starts.
  // The overlapping normalized text is normCompletion.slice(-bestNormLen).
  // Count non-whitespace + whitespace-boundary chars from the end of the
  // original completion to find the cut point.
  const overlapText = normCompletion.slice(-bestNormLen);
  let oi = overlapText.length - 1; // index into overlap text (from end)
  let ci = completion.length - 1; // index into original completion (from end)

  // Skip trailing whitespace in the original completion before matching.
  // The normalized overlap text has no trailing whitespace, so any trailing
  // whitespace in the original completion is not part of the overlap content.
  while (ci >= 0 && /\s/.test(completion[ci])) {
    ci--;
  }

  while (oi >= 0 && ci >= 0) {
    if (/\s/.test(overlapText[oi])) {
      // Skip whitespace in original
      while (ci >= 0 && /\s/.test(completion[ci])) {
        ci--;
      }
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
  // The 150-char limit prevents false positives on very long line fragments
  // where a prefix match is more likely to be legitimate repeated content.
  if (!lineFragment || !lineFragment.trim() || lineFragment.length > 150) {
    return completion;
  }

  if (completion.startsWith(lineFragment)) {
    return completion.slice(lineFragment.length);
  }

  return completion;
}

/**
 * Strip prompt scaffolding tags that leaked through extraction.
 *
 * These strings are never legitimate user-facing content — they are
 * instruction/marker tags used in prompt construction. If extraction
 * didn't remove them (e.g., model echoed them outside the expected
 * position), strip them here as a safety net.
 */
function stripLeakedTags(text: string): string {
  return text.replace(/<\/?COMPLETION>/g, '').replace(/\{\{FILL_HERE\}\}/g, '');
}

/**
 * Post-processing pipeline for completion text from any provider.
 *
 * 1. Trim prefix overlap — if the completion's head duplicates the current line fragment.
 * 2. Trim suffix overlap — if the completion's tail duplicates the document's suffix.
 * 3. Strip leaked tags — remove prompt scaffolding that survived extraction.
 * 4. Return null for empty results so callers get a clean "no completion" signal.
 */
export function postProcessCompletion(
  text: string,
  prefix?: string,
  suffix?: string,
  mode?: 'prose' | 'code',
): string | null {
  let result = text;

  if (prefix) {
    result = trimPrefixOverlap(result, prefix);
  }

  if (suffix) {
    result = trimSuffixOverlap(result, suffix, mode);
  }

  result = stripLeakedTags(result);

  return result.trim() ? result : null;
}
