export const DEFAULT_SYSTEM_PROMPT = `You are a commit message generator. Given a git diff, write a concise conventional commit message. Output ONLY the commit message, nothing else. Use the imperative mood. The first line should be a short summary (max 72 chars). If the change warrants it, add a blank line followed by a longer description.`;

/**
 * Build the user prompt piped to `claude -p` via stdin.
 * The system prompt is passed separately via `--system-prompt`.
 */
export function buildCommitPrompt(diff: string): string {
  return `<diff>\n${diff}\n</diff>`;
}

/**
 * Returns the system prompt to pass via `--system-prompt`.
 */
export function getSystemPrompt(customSystemPrompt?: string): string {
  return customSystemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT;
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
