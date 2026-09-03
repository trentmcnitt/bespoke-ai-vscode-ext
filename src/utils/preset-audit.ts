import { CustomPreset } from '../types';

/**
 * Audit persisted custom presets for properties a user should be aware of.
 *
 * Background: before 0.8.12, `bespokeAI.api.customPresets` could be set from a repository's
 * `.vscode/settings.json`, and two code paths (Add/Remove Custom Model, preset auto-select)
 * copied the effective value into the user's Global settings. A preset introduced that way
 * outlives the repository that introduced it. The scope fix stops new ones; this audit
 * surfaces any that already landed.
 *
 * This is deliberately a heuristic, not a verdict. A remote Ollama box and an attacker's
 * collector look identical here (a non-loopback `baseUrl`), so the caller must present the
 * result as information and default to keeping everything.
 */

/** API-key env vars the built-in providers use by default. Anything else is worth a look. */
export const WELL_KNOWN_KEY_VARS: ReadonlySet<string> = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'XAI_API_KEY',
  'GEMINI_API_KEY',
  'OPENROUTER_API_KEY',
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** True if the URL points at this machine. Unparseable URLs are treated as NOT loopback. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
  } catch {
    return false;
  }
}

export interface PresetAuditFinding {
  /** Index into the audited array — stable even when two presets share a name. */
  index: number;
  name: string;
  /** Human-readable reasons, one per property that drew attention. */
  reasons: string[];
}

export function auditCustomPresets(presets: readonly CustomPreset[]): PresetAuditFinding[] {
  const findings: PresetAuditFinding[] = [];
  presets.forEach((p, index) => {
    const reasons: string[] = [];
    if (p.baseUrl && !isLoopbackUrl(p.baseUrl)) {
      let host = p.baseUrl;
      try {
        host = new URL(p.baseUrl).host;
      } catch {
        /* keep the raw string */
      }
      reasons.push(`sends requests to ${host}`);
    }
    if (p.apiKeyEnvVar && !WELL_KNOWN_KEY_VARS.has(p.apiKeyEnvVar)) {
      reasons.push(`reads the environment variable ${p.apiKeyEnvVar}`);
    }
    const headerNames = Object.keys(p.extraHeaders ?? {});
    if (headerNames.length > 0) {
      reasons.push(`adds request headers: ${headerNames.join(', ')}`);
    }
    if (reasons.length > 0) {
      findings.push({ index, name: p.name || `preset #${index + 1}`, reasons });
    }
  });
  return findings;
}

/** One line per finding, for a notification body. */
export function describeFindings(findings: readonly PresetAuditFinding[]): string {
  return findings.map((f) => `• ${f.name} — ${f.reasons.join('; ')}`).join('\n');
}
