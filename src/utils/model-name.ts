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
