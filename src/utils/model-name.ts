/**
 * Shorten a model ID for status bar display.
 *
 * Examples:
 *   claude-haiku-4-5-20251001 → haiku-4.5
 *   claude-sonnet-4-20250514  → sonnet-4
 *   qwen2.5:3b               → qwen2.5:3b
 */
export function shortenModelName(modelId: string): string {
  let name = modelId;
  name = name.replace(/^claude-/, '');
  name = name.replace(/-\d{8}$/, '');
  name = name.replace(/^(\w+)-(\d+)-(\d+)$/, '$1-$2.$3');
  return name;
}

/**
 * Format a full Claude model ID as a human-friendly name with version.
 *
 * Examples:
 *   claude-opus-4-8-20250915  → Opus 4.8
 *   claude-sonnet-4-5-20250929 → Sonnet 4.5
 *   claude-sonnet-5           → Sonnet 5
 *
 * Returns null when the ID doesn't match the Claude naming pattern, so
 * callers can fall back to the raw ID or alias.
 */
export function displayModelName(modelId: string): string | null {
  // Minor version capped at 2 digits so it can't swallow an 8-digit date suffix
  // (e.g. claude-sonnet-4-20250514 has no minor version).
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(modelId);
  if (!match) {
    return null;
  }
  const family = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  const version = match[3] ? `${match[2]}.${match[3]}` : match[2];
  return `${family} ${version}`;
}
