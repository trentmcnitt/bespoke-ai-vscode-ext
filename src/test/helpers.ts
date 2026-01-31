import { CompletionContext, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';

export function loadApiKey(): string {
  return process.env.ANTHROPIC_API_KEY ?? '';
}

const DEFAULT_CONFIG: ExtensionConfig = {
  enabled: true,
  backend: 'claude-code',
  mode: 'auto',
  debounceMs: 300,
  anthropic: { apiKey: 'test-key', model: 'claude-haiku-4-5-20251001', models: ['claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'], useCaching: false, apiCallsEnabled: true },
  ollama: { endpoint: 'http://localhost:11434', model: 'qwen2.5:3b', models: ['qwen2.5:3b', 'qwen2.5-coder:3b', 'llama3.2:3b', 'deepseek-coder-v2:latest'], raw: true },
  prose: { maxTokens: 100, temperature: 0.7, stopSequences: ['---', '##'], contextChars: 2000, suffixChars: 500, fileTypes: ['markdown', 'plaintext'] },
  code: { maxTokens: 256, temperature: 0.2, stopSequences: [], contextChars: 4000, suffixChars: 500 },
  claudeCode: { model: 'haiku', models: ['haiku', 'sonnet', 'opus'] },
  logLevel: 'info',
  activeProfile: '',
  oracle: { enabled: false, debounceMs: 2000, briefTtlMs: 300000, model: 'sonnet', allowedTools: ['Read', 'Grep', 'Glob'] },
};

export function makeConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    anthropic: { ...DEFAULT_CONFIG.anthropic, ...overrides.anthropic },
    ollama: { ...DEFAULT_CONFIG.ollama, ...overrides.ollama },
    claudeCode: { ...DEFAULT_CONFIG.claudeCode, ...overrides.claudeCode },
    prose: { ...DEFAULT_CONFIG.prose, ...overrides.prose },
    code: { ...DEFAULT_CONFIG.code, ...overrides.code },
    oracle: { ...DEFAULT_CONFIG.oracle, ...overrides.oracle },
  };
}

/** No-op Logger for unit tests (avoids vscode dependency) */
export function makeLogger(): Logger {
  return {
    setLevel: () => {},
    info: () => {},
    debug: () => {},
    trace: () => {},
    error: () => {},
    requestStart: () => {},
    requestEnd: () => {},
    cacheHit: () => {},
    traceBlock: () => {},
    traceInline: () => {},
    show: () => {},
    dispose: () => {},
  } as unknown as Logger;
}

export function makeProseContext(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    prefix: 'The quick brown fox jumped over the lazy dog and then',
    suffix: '',
    languageId: 'markdown',
    fileName: 'story.md',
    filePath: '/test/story.md',
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
    filePath: '/test/math.ts',
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
