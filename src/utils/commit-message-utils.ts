const COMMIT_PROMPT = `You are a commit message generator. Given a git diff, write a concise conventional commit message. Output ONLY the commit message, nothing else. Use the imperative mood. The first line should be a short summary (max 72 chars). If the change warrants it, add a blank line followed by a longer description.`;

/**
 * Upper bound on the diff sent for a commit message, in characters (~15K tokens).
 * A commit message never needs more than this, and the diff is the largest single
 * piece of workspace content the extension sends off-machine — it should be bounded.
 */
export const MAX_COMMIT_DIFF_CHARS = 60_000;

/**
 * Truncate a diff to `maxChars`, cutting at a line boundary and appending a marker so
 * the model knows it is looking at a partial diff. Returns the input unchanged if it fits.
 */
export function truncateDiff(diff: string, maxChars: number = MAX_COMMIT_DIFF_CHARS): string {
  if (diff.length <= maxChars) return diff;
  const cut = diff.lastIndexOf('\n', maxChars);
  const head = diff.slice(0, cut > 0 ? cut : maxChars);
  const omitted = diff.length - head.length;
  return `${head}\n\n[diff truncated: ${omitted.toLocaleString()} more characters omitted]`;
}

/**
 * Build a full commit prompt that merges system instructions + diff into one user message.
 * Used when sending to a pre-warmed session pool that has a generic system prompt.
 */
export function buildFullCommitPrompt(diff: string): string {
  return `<instructions>\n${COMMIT_PROMPT}\n</instructions>\n\n<diff>\n${diff}\n</diff>`;
}

/**
 * Parse the stdout from `claude -p` into a usable commit message.
 * Strips markdown code fences if present (Claude sometimes wraps output in fences).
 * Returns null if the output is empty/whitespace-only.
 */
export function parseCommitMessage(stdout: string): string | null {
  let text = stdout.trim();
  // Strip markdown code fences: ```\n...\n``` or ```text\n...\n```
  const fenceMatch = text.match(/^```[^\n]*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  return text.length > 0 ? text : null;
}
