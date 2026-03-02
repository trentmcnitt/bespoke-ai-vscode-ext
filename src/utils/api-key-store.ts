import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CREDS_FILE = path.join(os.homedir(), '.creds', 'api-keys.env');

/** Minimal interface matching vscode.SecretStorage — avoids direct vscode import. */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

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
let secretStorage: SecretStorageLike | null = null;
const secretCache = new Map<string, string>();

const SECRET_KEY_PREFIX = 'bespokeAI.apiKey.';

/** Initialize SecretStorage for secure API key resolution. Call once during activation. */
export function initSecretStorage(storage: SecretStorageLike): void {
  secretStorage = storage;
}

/**
 * Eagerly load a secret key into the in-memory cache.
 * Call this on activation for each known env var name so resolveApiKey() stays synchronous.
 */
export async function loadSecretKey(envVarName: string): Promise<void> {
  if (!secretStorage) return;
  const value = await secretStorage.get(`${SECRET_KEY_PREFIX}${envVarName}`);
  if (value) {
    secretCache.set(envVarName, value);
  }
}

/** Store an API key in SecretStorage and update the in-memory cache. */
export async function storeSecretKey(envVarName: string, value: string): Promise<void> {
  if (!secretStorage) return;
  await secretStorage.store(`${SECRET_KEY_PREFIX}${envVarName}`, value);
  secretCache.set(envVarName, value);
}

/** Remove an API key from SecretStorage and the in-memory cache. */
export async function removeSecretKey(envVarName: string): Promise<void> {
  if (!secretStorage) return;
  await secretStorage.delete(`${SECRET_KEY_PREFIX}${envVarName}`);
  secretCache.delete(envVarName);
}

/**
 * Resolve an API key by env var name.
 * Priority: SecretStorage (cached) > process.env > ~/.creds/api-keys.env
 */
export function resolveApiKey(envVarName: string): string | undefined {
  // Check SecretStorage cache first (eagerly loaded on activation)
  const fromSecret = secretCache.get(envVarName);
  if (fromSecret) return fromSecret;

  // Check process.env
  const fromEnv = process.env[envVarName];
  if (fromEnv) return fromEnv;

  // Lazy-load and cache the creds file
  if (!cachedEnv) {
    cachedEnv = parseEnvFile(CREDS_FILE);
  }

  return cachedEnv.get(envVarName);
}

/** Clear all caches (env file and secret cache). */
export function clearApiKeyCache(): void {
  cachedEnv = null;
  secretCache.clear();
}

/** Where an API key was resolved from. */
export type ApiKeySource = 'keychain' | 'env' | 'file' | null;

/**
 * Determine where an API key is being resolved from, without returning the key itself.
 * Returns 'keychain' (SecretStorage), 'env' (process.env), 'file' (~/.creds/api-keys.env),
 * or null if not found anywhere.
 */
export function resolveApiKeySource(envVarName: string): ApiKeySource {
  if (secretCache.has(envVarName)) return 'keychain';
  if (process.env[envVarName]) return 'env';
  if (!cachedEnv) cachedEnv = parseEnvFile(CREDS_FILE);
  if (cachedEnv.has(envVarName)) return 'file';
  return null;
}

/** Check if a specific key is stored in SecretStorage (from cache). */
export function hasSecretKey(envVarName: string): boolean {
  return secretCache.has(envVarName);
}

/** Exported for testing only. */
export { parseEnvFile as _parseEnvFile };
