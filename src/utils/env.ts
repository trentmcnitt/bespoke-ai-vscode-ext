import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Read the Anthropic API key from ~/.creds/api-keys.env.
 * Handles quoted values and inline comments.
 */
export function readApiKeyFromEnvFile(): string {
  try {
    const envPath = path.join(os.homedir(), '.creds', 'api-keys.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('ANTHROPIC_API_KEY=')) {
        let value = trimmed.slice('ANTHROPIC_API_KEY='.length);
        // Strip surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Strip inline comments (e.g. "sk-ant-xxx # project-name")
        const commentIdx = value.indexOf(' #');
        if (commentIdx >= 0) { value = value.slice(0, commentIdx); }
        return value.trim();
      }
    }
  } catch {
    // File not found or unreadable — that's fine
  }
  return '';
}
