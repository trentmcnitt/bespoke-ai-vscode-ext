/**
 * User-facing text for a command (commit message / Suggest Edits) that ended without
 * text. Pure — no vscode import — so both features and their tests share it.
 */
import type { SendPromptResult } from '../providers/command-pool';
import type { ApiCommandUnavailableReason } from '../providers/api/api-command-provider';

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
    case 'timeout':
      return 'the model did not answer in time. Try again, or check the Bespoke AI output log.';
  }
  if (errorType.startsWith('cli_')) {
    return `Claude Code returned an error (${errorType.slice(4)}).`;
  }
  return `the request failed (${errorType}).`;
}

/**
 * Warning text when a command can't be sent because the backend is unavailable.
 * On the API backend the reason comes from `ApiCommandProvider.unavailableReason()`;
 * the Claude Code backend keeps the pool message (it is usually still starting).
 */
export function commandUnavailableMessage(
  backend: 'claude-code' | 'api',
  reason: ApiCommandUnavailableReason | null | undefined,
): string {
  if (backend !== 'api') return 'Command pool not ready. Try again in a moment.';
  switch (reason?.kind) {
    case 'no_preset':
      return `API preset "${reason.presetId}" is not available. Check the bespokeAI.api.preset setting.`;
    case 'adapter_failed':
      return `API preset "${reason.displayName}" could not be loaded. Check the Bespoke AI output log.`;
    case 'no_key':
      return `No API key for ${reason.displayName}. Run "Bespoke AI: Enter API Key".`;
    case 'breaker_open':
      return `Paused after repeated API errors — retrying in ${Math.max(1, Math.ceil(reason.retryInMs / 1000))} s.`;
    default:
      return 'API backend not ready. Try again in a moment.';
  }
}
