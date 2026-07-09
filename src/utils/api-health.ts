// Pure helpers for classifying and describing API connectivity failures surfaced
// by the background health check (see runApiHealthCheck in extension.ts).
//
// The health check makes one cheap test request when the API backend becomes
// active. Its job is to catch the "silent failure" case the reporter of issue
// #14 hit: a configured-but-unusable backend (out of credits, bad key) that
// otherwise only reveals itself as missing ghost text.

/**
 * Category of an API connection failure.
 * - `billing`   — the account is out of credit/quota (won't fix itself).
 * - `auth`      — the API key was rejected (won't fix itself).
 * - `transient` — network blip, rate limit, timeout, 5xx (real traffic + the
 *                 circuit breaker will handle it; not worth flipping status).
 */
export type ApiConnectionErrorKind = 'billing' | 'auth' | 'transient';

// Credit/quota exhaustion. Anthropic: "Your credit balance is too low to access
// the Anthropic API." OpenAI: "You exceeded your current quota" (insufficient_quota).
// xAI/OpenRouter: variations mentioning credits.
const BILLING_PATTERN =
  /credit balance|out of credit|insufficient[_ -]?(?:quota|credit|credits|fund|funds|balance)|\bquota\b|billing|payment required|\b402\b|exceeded your current/i;

// Key rejected / not authorized. Anthropic: "invalid x-api-key". OpenAI:
// "Incorrect API key provided". Generic 401/403.
const AUTH_PATTERN =
  /invalid[ _-]?(?:x-)?api[ _-]?key|incorrect api key|authentication|unauthenticated|unauthorized|permission denied|\b401\b|\b403\b/i;

/** Classify a raw provider error string into an actionable category. */
export function classifyApiConnectionError(error: string): ApiConnectionErrorKind {
  const text = error ?? '';
  // Billing first: a "credit balance too low" message can also mention "access",
  // and billing failures are the higher-signal, more common case for this feature.
  if (BILLING_PATTERN.test(text)) return 'billing';
  if (AUTH_PATTERN.test(text)) return 'auth';
  return 'transient';
}

/** Trim a raw provider error to a short, notification-friendly snippet. */
function snippet(error: string, max = 200): string {
  const clean = (error ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Build a user-facing message + detail for a failed API health check.
 * `message` is short (used for the notification and status diagnostic);
 * `detail` explains the fix and includes the raw provider text.
 */
export function describeApiConnectionError(
  presetName: string,
  kind: ApiConnectionErrorKind,
  rawError: string,
): { message: string; detail: string } {
  const raw = snippet(rawError);
  switch (kind) {
    case 'billing':
      return {
        message: `${presetName}: API account is out of credit`,
        detail: `The API account behind ${presetName} has no remaining credit or quota, so completions will fail. Add credit/quota with your provider, or switch to a different model or backend.${
          raw ? ` (Provider said: ${raw})` : ''
        }`,
      };
    case 'auth':
      return {
        message: `${presetName}: API key was rejected`,
        detail: `${presetName} rejected the API key (invalid or unauthorized). Enter a valid key, or switch to a different model or backend.${
          raw ? ` (Provider said: ${raw})` : ''
        }`,
      };
    default:
      return {
        message: `${presetName}: connection test failed`,
        detail: `Could not reach ${presetName}.${raw ? ` (Provider said: ${raw})` : ''}`,
      };
  }
}
