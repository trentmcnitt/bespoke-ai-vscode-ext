import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CREDS_FILE = path.join(os.homedir(), '.creds', 'api-keys.env');

/** Parse a .env file into key-value pairs. Handles comments, blank lines, and quoted values. */
function parseEnvFile(filePath: string): Map<string, string> {
  const result = new Map<string, string>();
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return result;
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      result.set(key, value);
    }
  }

  return result;
}

let cachedEnv: Map<string, string> | null = null;

/** Resolve an API key by env var name. Priority: process.env > ~/.creds/api-keys.env */
export function resolveApiKey(envVarName: string): string | undefined {
  // Check process.env first
  const fromEnv = process.env[envVarName];
  if (fromEnv) return fromEnv;

  // Lazy-load and cache the creds file
  if (!cachedEnv) {
    cachedEnv = parseEnvFile(CREDS_FILE);
  }

  return cachedEnv.get(envVarName);
}

/** Clear the cached env file (useful for testing). */
export function clearApiKeyCache(): void {
  cachedEnv = null;
}

/** Exported for testing only. */
export { parseEnvFile as _parseEnvFile };
