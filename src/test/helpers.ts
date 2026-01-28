import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CompletionContext, ExtensionConfig } from '../types';

export function makeConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    enabled: true,
    backend: 'anthropic',
    mode: 'auto',
    debounceMs: 300,
    anthropic: { apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', useCaching: false },
    ollama: { endpoint: 'http://localhost:11434', model: 'qwen2.5:3b', raw: true },
    prose: { maxTokens: 100, temperature: 0.7, stopSequences: ['\n\n', '---', '##'], contextChars: 2000, fileTypes: ['markdown', 'plaintext'] },
    code: { maxTokens: 256, temperature: 0.2, stopSequences: ['\n\n'], contextChars: 4000 },
    ...overrides,
  };
}

export function loadApiKey(): string {
  try {
    const envPath = path.join(os.homedir(), '.creds', 'api-keys.env');
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('ANTHROPIC_API_KEY=')) {
        let value = trimmed.slice('ANTHROPIC_API_KEY='.length);
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
  } catch { /* */ }
  return '';
}

export function makeProseContext(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    prefix: 'The quick brown fox jumped over the lazy dog and then',
    suffix: '',
    languageId: 'markdown',
    fileName: 'story.md',
    mode: 'prose',
    ...overrides,
  };
}

export function makeCodeContext(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    prefix: 'function add(a: number, b: number) {\n  return ',
    suffix: '\n}',
    languageId: 'typescript',
    fileName: 'math.ts',
    mode: 'code',
    ...overrides,
  };
}

interface MockToken {
  isCancellationRequested: boolean;
  onCancellationRequested: (listener: () => void) => { dispose: () => void };
}

export function createMockToken(): MockToken & { cancel: () => void } {
  let listener: (() => void) | null = null;
  return {
    isCancellationRequested: false,
    onCancellationRequested: (cb: () => void) => {
      listener = cb;
      return { dispose: () => { listener = null; } };
    },
    cancel() {
      this.isCancellationRequested = true;
      listener?.();
    },
  };
}
