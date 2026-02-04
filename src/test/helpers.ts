import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { expect } from 'vitest';
import { CompletionContext, DEFAULT_MODEL, ExtensionConfig } from '../types';
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
  debounceMs: 8000,
  prose: {
    contextChars: 2500,
    suffixChars: 2000,
    fileTypes: [],
  },
  code: {
    contextChars: 2500,
    suffixChars: 2000,
  },
  claudeCode: { model: DEFAULT_MODEL, models: ['haiku', 'sonnet', 'opus'] },
  logLevel: 'info',
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

/** Minimal mock TextDocument for unit tests. */
export interface MockDocument {
  getText: (range?: unknown) => string;
  lineAt: (line: number) => { text: string; range: { end: { line: number; character: number } } };
  positionAt: (offset: number) => { line: number; character: number };
  offsetAt: (position: { line: number; character: number }) => number;
  lineCount: number;
  languageId: string;
  fileName: string;
}

/**
 * Creates a mock TextDocument for unit tests.
 * Supports getText, lineAt, positionAt, offsetAt, and common properties.
 */
export function makeDocument(
  content: string,
  options?: { languageId?: string; fileName?: string },
): MockDocument {
  const lines = content.split('\n');
  const languageId = options?.languageId ?? 'plaintext';
  const fileName = options?.fileName ?? 'test.txt';

  return {
    getText: (range?: unknown) => {
      if (!range) return content;
      // Cast to expected range type
      const r = range as {
        start: { line: number; character: number };
        end: { line: number; character: number };
      };
      const startOffset =
        lines.slice(0, r.start.line).reduce((acc, l) => acc + l.length + 1, 0) + r.start.character;
      const endOffset =
        lines.slice(0, r.end.line).reduce((acc, l) => acc + l.length + 1, 0) + r.end.character;
      return content.slice(startOffset, endOffset);
    },
    lineAt: (line: number) => ({
      text: lines[line] ?? '',
      range: { end: { line, character: (lines[line] ?? '').length } },
    }),
    positionAt: (offset: number) => {
      let remaining = offset;
      for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i].length) {
          return { line: i, character: remaining };
        }
        remaining -= lines[i].length + 1; // +1 for newline
      }
      return { line: lines.length - 1, character: lines[lines.length - 1].length };
    },
    offsetAt: (position: { line: number; character: number }) => {
      let offset = 0;
      for (let i = 0; i < position.line && i < lines.length; i++) {
        offset += lines[i].length + 1;
      }
      return offset + position.character;
    },
    lineCount: lines.length,
    languageId,
    fileName,
  };
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
 * Checks slot 0 trace — skips if not captured.
 */
export function assertWarmupValid(getTrace: (label: string) => string | undefined): void {
  const { completionStart } = buildFillMessage(WARMUP_PREFIX, WARMUP_SUFFIX);

  const slotIndex = 0;
  const raw = getTrace(`warmup ← recv (slot ${slotIndex})`);
  if (raw === undefined) {
    return;
  }
  const extracted = extractOutput(raw);
  const stripped = stripCompletionStart(extracted, completionStart);
  expect(stripped, `warmup slot ${slotIndex}: stripCompletionStart returned null`).not.toBeNull();
  expect(
    stripped!.trim().toLowerCase(),
    `warmup slot ${slotIndex}: expected "${WARMUP_EXPECTED}"`,
  ).toBe(WARMUP_EXPECTED);
}

/** Type for fake stream returned by makeFakeStream */
export interface FakeStream {
  stream: AsyncIterable<unknown>;
  signalPush: () => void;
  terminate: () => void;
}

/**
 * Creates a fake async iterable stream that yields a warmup result,
 * then N real results. Each result after the warmup blocks
 * until signalPush() is called. After all messages are consumed, blocks
 * indefinitely (like the real SDK stream) until terminate() is called.
 */
export function makeFakeStream(
  resultTexts: string | string[],
  warmupResponse: string,
  activeStreams?: FakeStream[],
): FakeStream {
  const texts = Array.isArray(resultTexts) ? resultTexts : [resultTexts];
  const messages = [
    { type: 'result', subtype: 'success', result: warmupResponse },
    ...texts.map((t) => ({ type: 'result', subtype: 'success', result: t })),
  ];

  let index = 0;
  const waitQueue: (() => void)[] = [];
  // Start at -1 to absorb the warmup signalPush from consumeIterable
  let pushCount = -1;
  let terminated = false;

  function resolveNextWaiter() {
    const waiter = waitQueue.shift();
    if (waiter) {
      waiter();
    }
  }

  const fakeStream: FakeStream = {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<unknown>> {
            if (terminated) {
              return { value: undefined, done: true };
            }

            if (index >= messages.length) {
              await new Promise<void>((r) => {
                waitQueue.push(r);
              });
              return { value: undefined, done: true };
            }

            if (index >= 1) {
              if (pushCount <= 0) {
                await new Promise<void>((r) => {
                  waitQueue.push(r);
                });
                if (terminated) {
                  return { value: undefined, done: true };
                }
              }
              pushCount--;
            }

            const value = messages[index++];
            return { value, done: false };
          },
          async return(): Promise<IteratorResult<unknown>> {
            terminated = true;
            return { value: undefined, done: true };
          },
        };
      },
    },
    /** Signal that a message was pushed (unblocks the stream for the next result) */
    signalPush() {
      pushCount++;
      resolveNextWaiter();
    },
    /** Terminate the stream (unblocks any waiting next() calls) */
    terminate() {
      terminated = true;
      while (waitQueue.length > 0) {
        resolveNextWaiter();
      }
    },
  };

  activeStreams?.push(fakeStream);
  return fakeStream;
}

/** Return the model to use in integration/quality tests.
 *  Precedence: TEST_MODEL > QUALITY_TEST_MODEL (backward compat) > DEFAULT_MODEL. */
export function getTestModel(): string {
  return (
    process.env.TEST_MODEL || process.env.QUALITY_TEST_MODEL || DEFAULT_CONFIG.claudeCode.model
  );
}

/** Assert that the provider's lastUsedModel matches the expected test model.
 *  Skips silently when no completion was made (activation-only tests). */
export function assertModelMatch(
  provider: { lastUsedModel: string | null },
  expectedModel?: string,
): void {
  const expected = expectedModel ?? getTestModel();
  const actual = provider.lastUsedModel;
  if (!actual) return; // no completion was made
  expect(actual.toLowerCase()).toContain(expected.toLowerCase());
}

/** Helper: consume async iterable in background, signaling the fake stream on each message */
export function consumeIterable(iterable: AsyncIterable<unknown>, fakeStream: FakeStream): void {
  (async () => {
    for await (const _msg of iterable) {
      fakeStream.signalPush();
    }
  })().catch(() => {
    /* channel closed */
  });
}
