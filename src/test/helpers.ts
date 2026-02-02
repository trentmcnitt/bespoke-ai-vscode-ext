import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { expect } from 'vitest';
import { CompletionContext, ExtensionConfig } from '../types';
import { Logger } from '../utils/logger';
import { UsageLedger } from '../utils/usage-ledger';
import {
  extractOutput,
  stripCompletionStart,
  buildFillMessage,
  WARMUP_PREFIX,
  WARMUP_SUFFIX,
  WARMUP_EXPECTED,
} from '../providers/claude-code';

export function loadApiKey(): string {
  return process.env.ANTHROPIC_API_KEY ?? '';
}

const DEFAULT_CONFIG: ExtensionConfig = {
  enabled: true,
  mode: 'auto',
  triggerMode: 'auto',
  debounceMs: 1000,
  prose: {
    maxTokens: 100,
    temperature: 0.7,
    stopSequences: ['---', '##'],
    contextChars: 2000,
    suffixChars: 2500,
    fileTypes: ['markdown', 'plaintext'],
  },
  code: {
    maxTokens: 256,
    temperature: 0.2,
    stopSequences: [],
    contextChars: 4000,
    suffixChars: 2500,
  },
  claudeCode: { model: 'haiku', models: ['haiku', 'sonnet', 'opus'] },
  logLevel: 'info',
  activeProfile: '',
  snoozeDurationMinutes: 10,
};

export function makeConfig(overrides: Partial<ExtensionConfig> = {}): ExtensionConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    claudeCode: { ...DEFAULT_CONFIG.claudeCode, ...overrides.claudeCode },
    prose: { ...DEFAULT_CONFIG.prose, ...overrides.prose },
    code: { ...DEFAULT_CONFIG.code, ...overrides.code },
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

/** Logger that captures traceBlock calls for inspecting raw provider output */
export function makeCapturingLogger(): {
  logger: Logger;
  getTrace: (label: string) => string | undefined;
} {
  const traces = new Map<string, string>();
  const logger = {
    ...makeLogger(),
    traceBlock: (label: string, content: string) => {
      traces.set(label, content);
    },
  } as unknown as Logger;
  return { logger, getTrace: (label) => traces.get(label) };
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
      return {
        dispose: () => {
          listener = null;
        },
      };
    },
    cancel() {
      this.isCancellationRequested = true;
      listener?.();
    },
  };
}

/** Create a UsageLedger backed by a temp directory. Returns the ledger and its file path. */
export function makeLedger(dir?: string): { ledger: UsageLedger; filePath: string } {
  const tmpDir = dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'bespoke-ledger-'));
  const filePath = path.join(tmpDir, 'usage-ledger.jsonl');
  const ledger = new UsageLedger(filePath, makeLogger());
  return { ledger, filePath };
}

/**
 * Assert that warmup responses captured by a capturing logger are valid.
 * Checks slot 0 and slot 1 traces — skips any that weren't captured.
 */
export function assertWarmupValid(getTrace: (label: string) => string | undefined): void {
  const { completionStart } = buildFillMessage(WARMUP_PREFIX, WARMUP_SUFFIX);

  for (const slotIndex of [0, 1]) {
    const raw = getTrace(`warmup ← recv (slot ${slotIndex})`);
    if (raw === undefined) {
      continue;
    }
    const extracted = extractOutput(raw);
    const stripped = stripCompletionStart(extracted, completionStart);
    expect(stripped, `warmup slot ${slotIndex}: stripCompletionStart returned null`).not.toBeNull();
    expect(
      stripped!.trim().toLowerCase(),
      `warmup slot ${slotIndex}: expected "${WARMUP_EXPECTED}"`,
    ).toBe(WARMUP_EXPECTED);
  }
}
