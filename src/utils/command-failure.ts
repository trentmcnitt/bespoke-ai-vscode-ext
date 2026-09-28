/**
 * User-facing text for a command (commit message / Suggest Edits) that ended without
 * text. Pure — no vscode import — so both features and their tests share it.
 */
import type { SendPromptResult } from '../providers/command-pool';

/**
 * Why a command returned no text, if it was a failure worth telling the user about.
 * `null` means stay silent: a successful reply, a cancellation or supersession
 * (`aborted`), or a bare null (the user cancelled the progress notification).
 */
export function commandFailureType(result: SendPromptResult): string | null {
  if (result.text !== null) return null;
  if (result.aborted || result.detail?.aborted) return null;
  return result.errorType ?? result.detail?.errorType ?? null;
}

/** Short, specific cause (and remedy) for a failure type — see `SlotFailure` and the API adapters. */
export function describeCommandFailure(errorType: string): string {
  switch (errorType) {
    case 'pool_recycled':
      return 'the Claude Code pool restarted (e.g. after a model or settings change) before it answered. Try again.';
    case 'pool_warmup_failed':
      return 'Claude Code failed to start. Check the Bespoke AI output log.';
    case 'slot_stream_error':
      return 'the Claude Code session failed. Try again.';
    case 'slot_stream_ended':
      return 'the Claude Code session exited before answering. Try again.';
    case 'slot_unavailable':
      return 'the Claude Code pool is unavailable. Run "Bespoke AI: Restart Pools".';
    case 'pool_circuit_open':
      return 'Claude Code is crashing repeatedly. Run "Bespoke AI: Restart Pools".';
    case 'pool_error':
      return 'the Claude Code pool did not respond. Try again, or run "Bespoke AI: Restart Pools".';
    case '429':
      return 'the API rate limit was hit (HTTP 429). Try again shortly.';
    case '529':
      return 'the API is overloaded (HTTP 529). Try again shortly.';
    case 'connection_refused':
      return 'could not connect to Ollama. Is it running?';
  }
  if (errorType.startsWith('cli_')) {
    return `Claude Code returned an error (${errorType.slice(4)}).`;
  }
  return `the request failed (${errorType}).`;
}
